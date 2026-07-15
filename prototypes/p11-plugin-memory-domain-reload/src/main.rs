//! p11-plugin-memory-domain-reload
//!
//! Validates docs/SPEC.md §9.16 (Plugin Hot-Reload) as a full contract:
//!
//! - a `PluginDomain` owns the plugin's Lua state, descriptors, hook/tool
//!   registrations (host-side maps keyed by domain generation), bus
//!   subscriptions (§9.18, token dropped with the domain), render/layout
//!   cache, host scratch (bumpalo arena), and a cancellation token for
//!   plugin tasks;
//! - reload = construct D' -> atomic swap -> drop D; rollback keeps D on
//!   failure with D' partial registrations discarded (§9.17 entry-load
//!   error);
//! - no stale callback may run after the swap: every dispatch path (hook,
//!   tool, bus delivery) is generation-gated;
//! - repeated reloads plateau in memory (RSS via /proc/self/statm + Lua
//!   used_memory);
//! - escaped resources (stale registry entry, raw callback clone, leaked
//!   subscription token, async task outliving the domain) are detected and
//!   rejected/cancelled with a clear error.
//!
//! Verify:
//!   cargo run -- reload-loop
//!   cargo run -- reload-with-heap-limit
//!   cargo run -- escaped-callback-fails
//!   cargo run -- all

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use bumpalo::Bump;
use mlua::{Function, Lua};

const GROW_SRC: &str = include_str!("../plugins/grow.lua");
const MANY_SRC: &str = include_str!("../plugins/register_many.lua");
/// Broken entry code used to prove rollback (§9.16/§9.17): registers one
/// hook (a partial registration), then fails during entry load.
const BROKEN_SRC: &str = "smith.register_hook('broken/partial', function() end)\n\
                          error('intentional entry-load failure')";

// ---------------------------------------------------------------------------
// measurement helpers
// ---------------------------------------------------------------------------

fn page_size_bytes() -> u64 {
    static PS: OnceLock<u64> = OnceLock::new();
    *PS.get_or_init(|| {
        std::process::Command::new("getconf")
            .arg("PAGESIZE")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(4096)
    })
}

/// Resident set size in KiB, from /proc/self/statm field 2 (resident pages).
fn rss_kb() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").expect("read /proc/self/statm");
    let pages: u64 = statm
        .split_whitespace()
        .nth(1)
        .expect("statm resident field")
        .parse()
        .expect("statm parse");
    pages * page_size_bytes() / 1024
}

fn threads_now() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").expect("read /proc/self/status");
    status
        .lines()
        .find_map(|l| l.strip_prefix("Threads:"))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

fn panic_msg(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".into())
}

fn check(label: &str, ok: bool, detail: String) -> Result<(), String> {
    if ok {
        println!("PASS {label} — {detail}");
        Ok(())
    } else {
        println!("FAIL {label} — {detail}");
        Err(format!("{label}: {detail}"))
    }
}

// ---------------------------------------------------------------------------
// host error model (§9.17: clear, attributable errors; stale never runs)
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum HostError {
    /// A callback addressed through a generation that no longer belongs to a
    /// live domain. The callback is rejected *before* its Lua is touched.
    StaleDomain {
        kind: &'static str,
        name: String,
        gen: u64,
        active: Vec<u64>,
    },
    Missing {
        kind: &'static str,
        name: String,
    },
    Lua(mlua::Error),
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HostError::StaleDomain { kind, name, gen, active } => write!(
                f,
                "stale {kind} '{name}' from dead domain generation {gen} rejected \
                 (active generations: {active:?}); callback did not run"
            ),
            HostError::Missing { kind, name } => {
                write!(f, "no {kind} named '{name}' in any live domain")
            }
            HostError::Lua(e) => write!(f, "lua error: {e}"),
        }
    }
}

// ---------------------------------------------------------------------------
// bus (§9.18): subscriptions are domain-owned via tokens; delivery is
// generation-gated and errors are isolated (§9.17)
// ---------------------------------------------------------------------------

/// Dropped with its owning domain; flips the shared liveness flag so the bus
/// lazily reaps the subscription.
struct SubToken {
    alive: Arc<AtomicBool>,
}

impl Drop for SubToken {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
    }
}

struct Subscriber {
    gen: u64,
    alive: Arc<AtomicBool>,
    func: Function,
}

#[derive(Default)]
struct Bus {
    topics: HashMap<String, Vec<Subscriber>>,
    isolated_errors: Vec<String>,
}

impl Bus {
    fn subscribe(&mut self, gen: u64, topic: String, func: Function) -> SubToken {
        let alive = Arc::new(AtomicBool::new(true));
        self.topics
            .entry(topic)
            .or_default()
            .push(Subscriber { gen, alive: alive.clone(), func });
        SubToken { alive }
    }

    /// Deliver to live subscribers of active generations only. A subscriber
    /// whose token died is silently reaped (normal domain teardown). A
    /// subscriber whose token is alive but whose generation is dead is an
    /// ESCAPE: it is rejected with a clear error and removed, without ever
    /// touching its (dead) Lua.
    fn emit(&mut self, topic: &str, payload: i64, active_gens: &[u64]) -> usize {
        let Some(subs) = self.topics.get_mut(topic) else { return 0 };
        let old = std::mem::take(subs);
        let mut kept = Vec::with_capacity(old.len());
        let mut delivered = 0usize;
        let mut errs = Vec::new();
        for s in old {
            if !s.alive.load(Ordering::SeqCst) {
                continue; // token dropped with its domain (§9.18)
            }
            if !active_gens.contains(&s.gen) {
                errs.push(format!(
                    "bus '{topic}': escaped subscription from dead domain generation {} \
                     rejected & removed (token leaked past domain teardown); handler did not run",
                    s.gen
                ));
                continue;
            }
            match catch_unwind(AssertUnwindSafe(|| s.func.call::<i64>(payload))) {
                Ok(Ok(_)) => {
                    delivered += 1;
                    kept.push(s);
                }
                Ok(Err(e)) => errs.push(format!(
                    "bus '{topic}': subscriber (gen {}) error isolated & removed: {}",
                    s.gen,
                    first_line(&e.to_string())
                )),
                Err(p) => errs.push(format!(
                    "bus '{topic}': subscriber (gen {}) panicked & removed: {}",
                    s.gen,
                    first_line(&panic_msg(p.as_ref()))
                )),
            }
        }
        self.topics.insert(topic.to_string(), kept);
        self.isolated_errors.extend(errs);
        delivered
    }

    fn purge_dead(&mut self) {
        for subs in self.topics.values_mut() {
            subs.retain(|s| s.alive.load(Ordering::SeqCst));
        }
    }

    fn live_total(&self) -> usize {
        self.topics
            .values()
            .flatten()
            .filter(|s| s.alive.load(Ordering::SeqCst))
            .count()
    }

    fn take_isolated_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.isolated_errors)
    }
}

// ---------------------------------------------------------------------------
// host: registries keyed by domain generation (§9.16)
// ---------------------------------------------------------------------------

struct Host {
    next_gen: u64,
    /// plugin name -> active domain generation (the swap flips this)
    active: HashMap<String, u64>,
    /// generation -> hook name -> callback
    hooks: HashMap<u64, HashMap<String, Function>>,
    /// generation -> tool name -> callback
    tools: HashMap<u64, HashMap<String, Function>>,
    bus: Bus,
}

impl Host {
    fn new() -> Self {
        Host {
            next_gen: 0,
            active: HashMap::new(),
            hooks: HashMap::new(),
            tools: HashMap::new(),
            bus: Bus::default(),
        }
    }

    fn alloc_gen(&mut self) -> u64 {
        self.next_gen += 1;
        self.next_gen
    }

    fn active_gens(&self) -> Vec<u64> {
        let mut v: Vec<u64> = self.active.values().copied().collect();
        v.sort_unstable();
        v
    }

    fn is_active(&self, gen: u64) -> bool {
        self.active.values().any(|g| *g == gen)
    }

    fn commit(&mut self, gen: u64, hooks: Vec<(String, Function)>, tools: Vec<(String, Function)>) {
        self.hooks.entry(gen).or_default().extend(hooks);
        self.tools.entry(gen).or_default().extend(tools);
    }

    /// Deterministic teardown: registrations are keyed by generation, so one
    /// map removal drops every callback the domain ever registered.
    fn remove_generation(&mut self, gen: u64) -> (usize, usize) {
        (
            self.hooks.remove(&gen).map_or(0, |m| m.len()),
            self.tools.remove(&gen).map_or(0, |m| m.len()),
        )
    }

    fn hook_total(&self) -> usize {
        self.hooks.values().map(|m| m.len()).sum()
    }

    fn tool_total(&self) -> usize {
        self.tools.values().map(|m| m.len()).sum()
    }

    /// Name-based dispatch: resolves in ACTIVE generations only. If the name
    /// exists solely under a dead generation, that is a detected stale
    /// callback and it is rejected without touching Lua.
    fn invoke(&self, kind: &'static str, name: &str, arg: i64) -> Result<i64, HostError> {
        let map = if kind == "hook" { &self.hooks } else { &self.tools };
        for gen in self.active.values() {
            if let Some(f) = map.get(gen).and_then(|m| m.get(name)) {
                return f.call::<i64>(arg).map_err(HostError::Lua);
            }
        }
        for (gen, m) in map {
            if !self.is_active(*gen) && m.contains_key(name) {
                return Err(HostError::StaleDomain {
                    kind,
                    name: name.to_string(),
                    gen: *gen,
                    active: self.active_gens(),
                });
            }
        }
        Err(HostError::Missing { kind, name: name.to_string() })
    }

    fn invoke_hook(&self, name: &str, arg: i64) -> Result<i64, HostError> {
        self.invoke("hook", name, arg)
    }

    fn invoke_tool(&self, name: &str, arg: i64) -> Result<i64, HostError> {
        self.invoke("tool", name, arg)
    }

    /// Generation-addressed dispatch (what an escaped task would attempt).
    /// The generation gate runs before any Lua value is touched.
    fn invoke_hook_from_gen(&self, gen: u64, name: &str, arg: i64) -> Result<i64, HostError> {
        if !self.is_active(gen) {
            return Err(HostError::StaleDomain {
                kind: "hook",
                name: name.to_string(),
                gen,
                active: self.active_gens(),
            });
        }
        match self.hooks.get(&gen).and_then(|m| m.get(name)) {
            Some(f) => f.call::<i64>(arg).map_err(HostError::Lua),
            None => Err(HostError::Missing { kind: "hook", name: name.to_string() }),
        }
    }

    fn emit(&mut self, topic: &str, payload: i64) -> usize {
        let gens = self.active_gens();
        self.bus.emit(topic, payload, &gens)
    }

    /// Sweep for anything registered under a non-active generation — i.e.
    /// resources that escaped domain teardown. Empty in correct operation.
    fn audit_stale(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (gen, m) in &self.hooks {
            if !self.is_active(*gen) {
                for n in m.keys() {
                    out.push(format!("hook '{n}' (gen {gen})"));
                }
            }
        }
        for (gen, m) in &self.tools {
            if !self.is_active(*gen) {
                for n in m.keys() {
                    out.push(format!("tool '{n}' (gen {gen})"));
                }
            }
        }
        for (topic, subs) in &self.bus.topics {
            for s in subs {
                if s.alive.load(Ordering::SeqCst) && !self.is_active(s.gen) {
                    out.push(format!("bus subscription '{topic}' (gen {})", s.gen));
                }
            }
        }
        out.sort();
        out
    }

    /// Remove everything the audit would flag. Returns removed entry count.
    fn purge_stale(&mut self) -> usize {
        let active = self.active_gens();
        let mut n = 0;
        let hook_gens: Vec<u64> =
            self.hooks.keys().copied().filter(|g| !active.contains(g)).collect();
        for g in hook_gens {
            n += self.hooks.remove(&g).map_or(0, |m| m.len());
        }
        let tool_gens: Vec<u64> =
            self.tools.keys().copied().filter(|g| !active.contains(g)).collect();
        for g in tool_gens {
            n += self.tools.remove(&g).map_or(0, |m| m.len());
        }
        for subs in self.bus.topics.values_mut() {
            let before = subs.len();
            subs.retain(|s| active.contains(&s.gen) && s.alive.load(Ordering::SeqCst));
            n += before - subs.len();
        }
        n
    }
}

// ---------------------------------------------------------------------------
// PluginDomain (§9.16): owns ALL reloadable plugin state
// ---------------------------------------------------------------------------

struct PluginDomain {
    name: &'static str,
    generation: u64,
    /// the plugin's whole Lua VM — dropped with the domain
    lua: Lua,
    /// plugin metadata/descriptors collected at load
    hook_names: Vec<String>,
    tool_names: Vec<String>,
    /// TUI render/layout cache — domain-owned, dropped whole on reload
    render_cache: HashMap<String, Vec<u8>>,
    /// host-side scratch arena — reclaimed by dropping the domain, never by
    /// per-allocation cleanup
    scratch: Bump,
    /// cancellation token for plugin async tasks
    cancel: Arc<AtomicBool>,
    task: Option<JoinHandle<u64>>,
    /// bus subscription tokens — dropped with the domain (§9.18)
    sub_tokens: Vec<SubToken>,
}

impl Drop for PluginDomain {
    fn drop(&mut self) {
        // Cancellation token: the domain's async task is told to stop and is
        // joined, so no plugin task outlives the domain.
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(t) = self.task.take() {
            let _ = t.join();
        }
        // Implicit, orderless teardown of everything else the domain owns:
        // sub_tokens drop -> bus subscriptions die; lua drops -> plugin heap
        // reclaimed; render_cache + scratch drop -> host-side memory freed.
        // No per-resource cleanup graph (§9.16: whole-domain replacement).
    }
}

/// Construct a domain: fresh Lua, sandbox-ish `smith` API, run entry code,
/// then commit registrations keyed by this domain's generation. On entry
/// failure, NOTHING has reached the host: the partial registrations die with
/// the local pending buffers and the Lua (§9.17 entry-load error).
fn load_domain(
    host: &mut Host,
    name: &'static str,
    src: &str,
    gen: u64,
) -> Result<PluginDomain, (mlua::Error, usize)> {
    let lua = Lua::new();
    type Pending = Rc<RefCell<Vec<(String, Function)>>>;
    let p_hooks: Pending = Rc::new(RefCell::new(Vec::new()));
    let p_tools: Pending = Rc::new(RefCell::new(Vec::new()));
    let p_subs: Pending = Rc::new(RefCell::new(Vec::new()));
    let setup = (|| -> mlua::Result<()> {
        let smith = lua.create_table()?;
        let ph = p_hooks.clone();
        smith.set(
            "register_hook",
            lua.create_function(move |_, (n, f): (String, Function)| {
                ph.borrow_mut().push((n, f));
                Ok(())
            })?,
        )?;
        let pt = p_tools.clone();
        smith.set(
            "register_tool",
            lua.create_function(move |_, (n, f): (String, Function)| {
                pt.borrow_mut().push((n, f));
                Ok(())
            })?,
        )?;
        let ps = p_subs.clone();
        smith.set(
            "bus_on",
            lua.create_function(move |_, (t, f): (String, Function)| {
                ps.borrow_mut().push((t, f));
                Ok(())
            })?,
        )?;
        lua.globals().set("smith", smith)?;
        lua.load(src).set_name(name).exec()
    })();
    if let Err(e) = setup {
        let partial =
            p_hooks.borrow().len() + p_tools.borrow().len() + p_subs.borrow().len();
        return Err((e, partial)); // D' dropped by caller; host untouched
    }
    let hooks: Vec<(String, Function)> = p_hooks.borrow_mut().drain(..).collect();
    let tools: Vec<(String, Function)> = p_tools.borrow_mut().drain(..).collect();
    let subs: Vec<(String, Function)> = p_subs.borrow_mut().drain(..).collect();
    let hook_names = hooks.iter().map(|(n, _)| n.clone()).collect();
    let tool_names = tools.iter().map(|(n, _)| n.clone()).collect();
    host.commit(gen, hooks, tools);
    let sub_tokens = subs
        .into_iter()
        .map(|(t, f)| host.bus.subscribe(gen, t, f))
        .collect();
    // Async-task escape hatch modeled with std::thread + a domain-owned
    // cancellation flag. NOTE: without mlua's `send` feature, Lua values are
    // !Send — a thread cannot capture a Lua callback AT COMPILE TIME, so a
    // task can only carry plain data (e.g. a generation tag).
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let task = thread::spawn(move || {
        let mut ticks = 0u64;
        while !c.load(Ordering::Relaxed) {
            ticks += 1;
            thread::sleep(Duration::from_millis(2));
        }
        ticks
    });
    Ok(PluginDomain {
        name,
        generation: gen,
        lua,
        hook_names,
        tool_names,
        render_cache: HashMap::new(),
        scratch: Bump::new(),
        cancel,
        task: Some(task),
        sub_tokens,
    })
}

fn load_plugin(host: &mut Host, name: &'static str, src: &str) -> Result<PluginDomain, String> {
    let gen = host.alloc_gen();
    match load_domain(host, name, src, gen) {
        Ok(d) => {
            host.active.insert(name.to_string(), gen);
            Ok(d)
        }
        Err((e, partial)) => Err(format!(
            "load of '{name}' failed ({partial} partial registrations discarded): {}",
            first_line(&e.to_string())
        )),
    }
}

/// §9.16 sequence: construct D' -> swap -> drop D. All-or-nothing: on load
/// failure D is returned untouched (rollback) and D' partials are discarded.
fn reload(
    host: &mut Host,
    old: PluginDomain,
    src: &str,
) -> Result<PluginDomain, (PluginDomain, String)> {
    let name = old.name;
    let old_gen = old.generation;
    let new_gen = host.alloc_gen();
    match load_domain(host, name, src, new_gen) {
        Ok(new_dom) => {
            host.active.insert(name.to_string(), new_gen); // atomic swap: rebind name -> D'
            host.remove_generation(old_gen); // gen-keyed registrations gone deterministically
            drop(old); // cancels+joins task, drops sub tokens, Lua, caches, scratch
            host.bus.purge_dead(); // reap token-dead subscriptions eagerly
            Ok(new_dom)
        }
        Err((e, partial)) => {
            let msg = format!(
                "reload of '{name}' failed; old domain gen {old_gen} kept active; \
                 {partial} partial registrations from D' discarded; error: {}",
                first_line(&e.to_string())
            );
            Err((old, msg))
        }
    }
}

/// Unload = same teardown as the drop-D half of reload.
fn unload(host: &mut Host, dom: PluginDomain) {
    host.active.remove(dom.name);
    host.remove_generation(dom.generation);
    drop(dom);
    host.bus.purge_dead();
}

// ---------------------------------------------------------------------------
// "use" phase: exercise hooks/tools/bus + fill domain-owned cache & scratch
// ---------------------------------------------------------------------------

const CYCLES: usize = 100;
const WARMUP: usize = 20;
const GROW_CALLS: i64 = 200;

fn exercise(host: &mut Host, grow: &mut PluginDomain, cycle: i64) -> Result<(), String> {
    for i in 0..GROW_CALLS {
        host.invoke_hook("grow/on_tick", i).map_err(|e| e.to_string())?;
    }
    host.invoke_tool("grow/stats", 0).map_err(|e| e.to_string())?;
    for i in (1..=200usize).step_by(20) {
        host.invoke_hook(&format!("many/hook_{i}"), 0).map_err(|e| e.to_string())?;
        host.invoke_tool(&format!("many/tool_{i}"), 0).map_err(|e| e.to_string())?;
    }
    let d = host.emit("grow/topic", cycle) + host.emit("many/topic_7", cycle);
    if d != 2 {
        return Err(format!("cycle {cycle}: expected 2 bus deliveries, got {d}"));
    }
    let errs = host.bus.take_isolated_errors();
    if !errs.is_empty() {
        return Err(format!("cycle {cycle}: unexpected bus errors: {errs:?}"));
    }
    // render/layout cache lives in the domain and is dropped whole on reload
    for w in 0..64 {
        grow.render_cache.insert(format!("widget:{w}:{cycle}"), vec![0xAB; 4096]);
    }
    // host-side scratch: bump arena, reclaimed only by dropping the domain
    for _ in 0..128 {
        grow.scratch.alloc_slice_fill_copy(512, 0xCD_u8);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// scenario: reload-loop
// ---------------------------------------------------------------------------

fn scenario_reload_loop() -> Result<(), String> {
    println!("=== scenario: reload-loop ({CYCLES} load/use/reload cycles) ===");
    let mut host = Host::new();
    let mut grow = load_plugin(&mut host, "grow", GROW_SRC)?;
    let mut many = load_plugin(&mut host, "many", MANY_SRC)?;
    println!(
        "  descriptors: grow{{hooks:{},tools:{},subs:{}}} many{{hooks:{},tools:{},subs:{}}}",
        grow.hook_names.len(),
        grow.tool_names.len(),
        grow.sub_tokens.len(),
        many.hook_names.len(),
        many.tool_names.len(),
        many.sub_tokens.len()
    );
    check(
        "registries keyed by domain generation",
        host.hook_total() == 201 && host.tool_total() == 201 && host.bus.live_total() == 51,
        format!(
            "hooks={} tools={} bus_subs={}",
            host.hook_total(),
            host.tool_total(),
            host.bus.live_total()
        ),
    )?;
    let threads_base = threads_now();
    let rss_initial = rss_kb();
    let mut rss = Vec::with_capacity(CYCLES);
    let mut lua_used = Vec::with_capacity(CYCLES);
    let mut lat = Vec::with_capacity(CYCLES);
    for cycle in 1..=CYCLES {
        exercise(&mut host, &mut grow, cycle as i64)?;
        let used_pre = grow.lua.used_memory();
        let scratch_pre = grow.scratch.allocated_bytes();
        let cache_pre = grow.render_cache.len();
        let (og, om) = (grow.generation, many.generation);
        let t0 = Instant::now();
        grow = reload(&mut host, grow, GROW_SRC).map_err(|(_, e)| e)?;
        many = reload(&mut host, many, MANY_SRC).map_err(|(_, e)| e)?;
        lat.push(t0.elapsed());
        // old generations fully gone from host registries
        if host.hooks.contains_key(&og)
            || host.hooks.contains_key(&om)
            || host.tools.contains_key(&og)
            || host.tools.contains_key(&om)
        {
            return Err(format!("cycle {cycle}: old generation registrations survived the swap"));
        }
        if host.hook_total() != 201 || host.tool_total() != 201 || host.bus.live_total() != 51 {
            return Err(format!(
                "cycle {cycle}: registry counts wrong after reload: hooks={} tools={} subs={}",
                host.hook_total(),
                host.tool_total(),
                host.bus.live_total()
            ));
        }
        let audit = host.audit_stale();
        if !audit.is_empty() {
            return Err(format!("cycle {cycle}: audit found escaped registrations: {audit:?}"));
        }
        // probing the old generation must be rejected, not executed
        match host.invoke_hook_from_gen(og, "grow/on_tick", 0) {
            Err(HostError::StaleDomain { .. }) => {}
            other => {
                return Err(format!("cycle {cycle}: stale-gen dispatch not rejected: {other:?}"))
            }
        }
        // the name is rebound to D' with fresh plugin state
        let fresh = host.invoke_hook("grow/on_tick", -1).map_err(|e| e.to_string())?;
        if fresh != 1 {
            return Err(format!("cycle {cycle}: rebound hook not fresh (chunks={fresh})"));
        }
        // new domain starts with empty cache and a reset arena
        if !grow.render_cache.is_empty() || grow.scratch.allocated_bytes() != 0 {
            return Err(format!("cycle {cycle}: new domain inherited cache/scratch"));
        }
        rss.push(rss_kb());
        lua_used.push(used_pre as u64);
        if cycle % 10 == 0 {
            println!(
                "  cycle {cycle:3}: rss={} KB lua_used(pre-drop)={} KB cache_entries={} scratch={} KB threads={}",
                rss.last().unwrap(),
                used_pre / 1024,
                cache_pre,
                scratch_pre / 1024,
                threads_now()
            );
        }
        if cycle == 50 {
            // §9.16 rollback: failed reload keeps the old domain fully active
            match reload(&mut host, grow, BROKEN_SRC) {
                Ok(_) => return Err("broken reload unexpectedly succeeded".into()),
                Err((kept, msg)) => {
                    grow = kept;
                    let ok = host.active["grow"] == grow.generation
                        && host.hook_total() == 201
                        && host.tool_total() == 201;
                    check("rollback keeps old domain on failed reload", ok, msg)?;
                    // old domain still serves after rollback
                    host.invoke_hook("grow/on_tick", -2).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let mean = |s: &[u64]| s.iter().sum::<u64>() as f64 / s.len() as f64;
    let base = mean(&rss[WARMUP..40]);
    let late = mean(&rss[80..]);
    let growth = late - base;
    check(
        "RSS plateaus after warmup (no monotonic growth)",
        growth < 3072.0,
        format!(
            "rss KB: initial={rss_initial} mean(c21-40)={base:.0} mean(c81-100)={late:.0} \
             growth={growth:.0} (tolerance 3072)"
        ),
    )?;
    let lbase = mean(&lua_used[WARMUP..40]);
    let llate = mean(&lua_used[80..]);
    check(
        "Lua used_memory per cycle plateaus (heap reclaimed each drop)",
        llate < lbase * 1.5 + 1_048_576.0,
        format!(
            "pre-drop used_memory KB: mean(c21-40)={:.0} mean(c81-100)={:.0}",
            lbase / 1024.0,
            llate / 1024.0
        ),
    )?;
    let threads_end = threads_now();
    check(
        "domain task threads cancelled + joined on every drop",
        threads_end == threads_base,
        format!("threads: baseline={threads_base} end={threads_end} (2 domains alive each)"),
    )?;
    let avg_ms =
        lat.iter().map(|d| d.as_secs_f64()).sum::<f64>() / lat.len() as f64 * 1000.0;
    let max_ms = lat.iter().map(|d| d.as_secs_f64()).fold(0.0, f64::max) * 1000.0;
    println!(
        "  reload latency (construct D' + swap + drop D, both plugins): avg={avg_ms:.2} ms max={max_ms:.2} ms over {CYCLES} cycles"
    );
    unload(&mut host, grow);
    unload(&mut host, many);
    check(
        "unload empties all registries",
        host.hook_total() == 0 && host.tool_total() == 0 && host.bus.live_total() == 0,
        format!(
            "hooks={} tools={} bus_subs={}",
            host.hook_total(),
            host.tool_total(),
            host.bus.live_total()
        ),
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// scenario: reload-with-heap-limit
// ---------------------------------------------------------------------------

fn scenario_heap_limit() -> Result<(), String> {
    println!("=== scenario: reload-with-heap-limit ===");
    // Part 1: is mlua's hard VM heap limit enforceable under LuaJIT?
    {
        let probe = Lua::new();
        match probe.set_memory_limit(8 * 1024 * 1024) {
            Ok(prev) => {
                let r = probe
                    .load("local t = {} for i = 1, 20000 do t[i] = string.rep('x', 4096) .. i end")
                    .exec();
                match r {
                    Err(e) => println!(
                        "  set_memory_limit(8 MiB) -> Ok(prev={prev}); ~80 MiB over-allocation \
                         rejected: {}",
                        first_line(&e.to_string())
                    ),
                    Ok(()) => println!(
                        "  set_memory_limit(8 MiB) -> Ok(prev={prev}) BUT ~80 MiB allocation \
                         SUCCEEDED: limit not enforced under LuaJIT"
                    ),
                }
            }
            Err(e) => println!(
                "  set_memory_limit(8 MiB) -> Err: \"{}\" (hard VM heap limit NOT available \
                 under LuaJIT)",
                first_line(&e.to_string())
            ),
        }
    }
    // Part 2: complementary enforcement per SPEC — host-side soft quota via
    // used_memory polling, enforced by whole-domain teardown, which also
    // reclaims the heap.
    const SOFT_QUOTA: usize = 32 * 1024 * 1024;
    let mut host = Host::new();
    let grow = load_plugin(&mut host, "grow", GROW_SRC)?;
    let rss_start = rss_kb();
    let used_start = grow.lua.used_memory();
    let mut calls: i64 = 0;
    let used_breach = loop {
        host.invoke_hook("grow/on_tick", calls).map_err(|e| e.to_string())?;
        calls += 1;
        let used = grow.lua.used_memory();
        if used > SOFT_QUOTA {
            break used;
        }
        if calls > 60_000 {
            return Err("soft quota never breached after 60000 calls".into());
        }
    };
    let rss_peak = rss_kb();
    println!(
        "  soft quota breach: used_memory {used_start} -> {used_breach} B after {calls} calls; \
         rss {rss_start} -> {rss_peak} KB"
    );
    println!(
        "  error: plugin 'grow' exceeded Lua heap quota ({used_breach} B > {SOFT_QUOTA} B); \
         tearing down domain generation {}",
        grow.generation
    );
    unload(&mut host, grow);
    let rss_after = rss_kb();
    let growth = rss_peak.saturating_sub(rss_start);
    let reclaimed = rss_peak.saturating_sub(rss_after);
    check(
        "Lua heap reclaimed by whole-domain teardown (>=50% of growth)",
        reclaimed * 2 >= growth,
        format!(
            "rss KB: start={rss_start} peak={rss_peak} after-teardown={rss_after} \
             (growth={growth}, reclaimed={reclaimed})"
        ),
    )?;
    check(
        "host registries empty after quota teardown",
        host.hook_total() == 0 && host.tool_total() == 0 && host.bus.live_total() == 0,
        format!(
            "hooks={} tools={} bus_subs={}",
            host.hook_total(),
            host.tool_total(),
            host.bus.live_total()
        ),
    )?;
    let grow2 = load_plugin(&mut host, "grow", GROW_SRC)?;
    check(
        "fresh domain after quota teardown starts small",
        grow2.lua.used_memory() < 2 * 1024 * 1024,
        format!("used_memory={} B", grow2.lua.used_memory()),
    )?;
    let v = host.invoke_hook("grow/on_tick", 0).map_err(|e| e.to_string())?;
    check("reloaded plugin serves fresh state", v == 1, format!("first call returned {v}"))?;
    unload(&mut host, grow2);
    Ok(())
}

// ---------------------------------------------------------------------------
// scenario: escaped-callback-fails
// ---------------------------------------------------------------------------

fn scenario_escape() -> Result<(), String> {
    println!("=== scenario: escaped-callback-fails ===");
    println!(
        "  note: without mlua's 'send' feature, Lua values are !Send — a std::thread cannot \
         capture a Lua callback (compile error); escaped tasks can only carry plain data \
         (generation tags), which the generation gate rejects below."
    );
    let mut host = Host::new();
    let mut grow = load_plugin(&mut host, "grow", GROW_SRC)?;
    let gen1 = grow.generation;

    // Grow ~8 MiB in the old domain so heap pinning (if any) is measurable.
    for i in 0..2000 {
        host.invoke_hook("grow/on_tick", i).map_err(|e| e.to_string())?;
    }
    let rss_grown = rss_kb();

    // ESCAPE (a): host code clones the raw callback out of the gen-keyed registry.
    let escaped_fn: Function = host.hooks[&gen1]["grow/on_tick"].clone();
    // ESCAPE (b): a registry entry teardown will miss (re-inserted post-swap).
    let escaped_entry: Function = escaped_fn.clone();
    // ESCAPE (c): a leaked subscription token — never dropped with the domain.
    let leaked = grow.sub_tokens.pop().expect("grow has one subscription");
    std::mem::forget(leaked);
    // ESCAPE (d): an async task outliving the domain, firing gen-tagged callbacks.
    let (tx, rx) = mpsc::channel::<(u64, String)>();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let escapee: JoinHandle<u32> = thread::spawn(move || {
        let mut sent = 0u32;
        while !stop_t.load(Ordering::SeqCst) {
            if tx.send((gen1, "grow/on_tick".to_string())).is_err() {
                break;
            }
            sent += 1;
            thread::sleep(Duration::from_millis(5));
        }
        sent
    });
    thread::sleep(Duration::from_millis(20)); // queue a few pre-swap requests

    // SWAP per §9.16: construct D' -> swap -> drop D.
    grow = reload(&mut host, grow, GROW_SRC).map_err(|(_, e)| e)?;
    let gen2 = grow.generation;
    check("swap complete", gen2 != gen1, format!("generation {gen1} -> {gen2}"))?;
    // plant escape (b): stale entry back under the dead generation
    host.hooks.entry(gen1).or_default().insert("grow/on_tick".into(), escaped_entry);
    let rss_holding = rss_kb();

    // (b) the audit sweep detects everything tied to a dead generation
    let audit = host.audit_stale();
    let audit_ok = audit.len() == 2
        && audit.iter().any(|a| a.contains("hook 'grow/on_tick'") && a.contains(&format!("gen {gen1}")))
        && audit.iter().any(|a| a.contains("bus subscription 'grow/topic'") && a.contains(&format!("gen {gen1}")));
    check("escaped registry entry + leaked subscription detected by audit", audit_ok, format!("{audit:?}"))?;

    // stale registry entry is rejected with a clear error, before touching Lua
    match host.invoke_hook_from_gen(gen1, "grow/on_tick", 0) {
        Err(e @ HostError::StaleDomain { .. }) => {
            check("stale registry entry rejected with clear error", true, e.to_string())?;
        }
        other => return Err(format!("stale entry not rejected: {other:?}")),
    }
    // name-based dispatch rebinds to D' (fresh state), never the stale entry
    let v = host.invoke_hook("grow/on_tick", 0).map_err(|e| e.to_string())?;
    check("name-based dispatch rebound to new domain", v == 1, format!("fresh chunks={v}"))?;

    // (c) escaped bus subscription: rejected & removed on delivery; new
    // domain's subscriber still receives (error isolation, §9.17/§9.18)
    let delivered = host.emit("grow/topic", 42);
    let errs = host.bus.take_isolated_errors();
    check(
        "escaped bus subscription rejected & removed on delivery",
        delivered == 1
            && errs.len() == 1
            && errs[0].contains(&format!("dead domain generation {gen1}")),
        format!("delivered={delivered} errors={errs:?}"),
    )?;
    let delivered2 = host.emit("grow/topic", 43);
    let errs2 = host.bus.take_isolated_errors();
    check(
        "after purge, next delivery is clean",
        delivered2 == 1 && errs2.is_empty(),
        format!("delivered={delivered2} errors={errs2:?}"),
    )?;

    // (d) escaped async task: every gen-tagged callback request is rejected
    thread::sleep(Duration::from_millis(60));
    stop.store(true, Ordering::SeqCst);
    let sent = escapee.join().expect("join escapee");
    let mut rejected = 0u32;
    let mut executed = 0u32;
    let mut sample = String::new();
    while let Ok((g, name)) = rx.try_recv() {
        match host.invoke_hook_from_gen(g, &name, 0) {
            Ok(_) => executed += 1,
            Err(e @ HostError::StaleDomain { .. }) => {
                rejected += 1;
                if sample.is_empty() {
                    sample = e.to_string();
                }
            }
            Err(e) => return Err(format!("unexpected error from escaped task dispatch: {e}")),
        }
    }
    check(
        "escaped task's callback requests all rejected (none executed)",
        executed == 0 && rejected >= 1,
        format!("sent={sent} rejected={rejected} executed={executed}; sample error: {sample}"),
    )?;

    // (a) raw escaped mlua::Function after the domain's Lua was dropped:
    // observe mlua's actual behavior precisely (error vs panic vs runs).
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {})); // silence expected panic output
    let raw = catch_unwind(AssertUnwindSafe(|| escaped_fn.call::<i64>(0)));
    std::panic::set_hook(prev_hook);
    let raw_report = match &raw {
        Ok(Ok(v)) => format!(
            "CALL SUCCEEDED (returned {v}) — a raw clone keeps the dead domain's Lua alive; \
             host must never clone callbacks out of the gen-keyed registry"
        ),
        Ok(Err(e)) => format!("call failed with mlua error: {}", first_line(&e.to_string())),
        Err(p) => format!("call panicked: {}", first_line(&panic_msg(p.as_ref()))),
    };
    println!("  raw escaped mlua::Function after domain drop: {raw_report}");
    let raw_ran = matches!(&raw, Ok(Ok(_)));
    check(
        "raw escaped Function cannot run after domain drop",
        !raw_ran,
        format!(
            "raw_ran={raw_ran}; mlua behavior: {}",
            if matches!(&raw, Err(_)) { "PANIC (not a catchable mlua::Error)" } else { "mlua::Error" }
        ),
    )?;

    // cleanup + pinning measurement
    drop(escaped_fn);
    let purged = host.purge_stale();
    check("purge_stale removes escaped entries", purged >= 1, format!("purged={purged} entries"))?;
    check("audit clean after purge", host.audit_stale().is_empty(), "0 stale entries".into())?;
    let rss_clean = rss_kb();
    println!(
        "  rss KB: grown(old domain ~8MiB live)={rss_grown} holding-escapes-after-swap={rss_holding} \
         after-purge={rss_clean} (pinned-by-escapes={})",
        rss_holding.saturating_sub(rss_clean)
    );
    unload(&mut host, grow);
    Ok(())
}

// ---------------------------------------------------------------------------

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let started = Instant::now();
    let result = match cmd.as_str() {
        "reload-loop" => scenario_reload_loop(),
        "reload-with-heap-limit" => scenario_heap_limit(),
        "escaped-callback-fails" => scenario_escape(),
        "all" => scenario_reload_loop()
            .and_then(|_| scenario_heap_limit())
            .and_then(|_| scenario_escape()),
        other => Err(format!(
            "unknown scenario '{other}'; use reload-loop | reload-with-heap-limit | \
             escaped-callback-fails | all"
        )),
    };
    match result {
        Ok(()) => println!(
            "\np11 RESULT: all expectations hold ({:.1}s)",
            started.elapsed().as_secs_f64()
        ),
        Err(e) => {
            eprintln!("\np11 RESULT: FAIL: {e}");
            std::process::exit(1);
        }
    }
}
