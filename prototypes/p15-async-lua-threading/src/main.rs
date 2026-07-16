//! p15-async-lua-threading
//!
//! Proves or disproves docs/SPEC.md §12 + §5.5 + §6.4 + §9.16 + §9.18:
//! can `!Send` mlua states (no `send` feature) integrate with a tokio
//! multi-thread agent loop without stalling the engine — and what exact
//! threading rule must §12 state?
//!
//! Architecture under test (the rule §12 is missing):
//! - ONE dedicated OS thread — the "plugin thread" §9.18 references but §12
//!   never defines — owns ALL Lua states (two here, proving multi-plugin).
//!   States are created on that thread and never leave it.
//! - Hook dispatch is a channel actor: the engine sends a plain-data
//!   `HookRequest` over an mpsc channel and awaits a oneshot reply. Only
//!   plain Rust data (`Send` by construction, statically asserted below)
//!   crosses the boundary; Lua values never do.
//! - Mock tools run in parallel via `tokio::task::spawn_blocking` (the §12
//!   tool pool); their before/after hooks serialize on the plugin thread.
//! - Abort = the engine drops the oneshot receiver and moves on. The Lua
//!   hook itself is NOT interrupted — see abort-mid-hook for the honest
//!   account of why (LuaJIT cannot be safely preempted).
//!
//! !Send containment is proven BY CONSTRUCTION: this file compiles with no
//! `Send` bounds trickery, no `unsafe`, and no `mlua` `send` feature.
//! Attempting to move a state out was tried and rustc refused — evidence
//! (verbatim from `cargo check --features compile_fail_demo`, mlua 0.10.5):
//!
//! ```text
//! error: future cannot be sent between threads safely
//!     |         tokio::spawn(async move {
//!     |             lua.load("return 1").exec().unwrap();
//!     |         });
//!     | |______^ future created by async block is not `Send`
//!     = help: within `{async block}`, the trait `Send` is not implemented for
//!             `Rc<mlua::types::sync::inner::ReentrantMutex<mlua::state::raw::RawLua>>`
//! note: captured value is not `Send`
//!     |             lua.load("return 1").exec().unwrap();
//!     |             ^^^ has type `Lua` which is not `Send`
//! note: required by a bound in `tokio::spawn`
//!     |     pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
//!     |         F: Future + Send + 'static,
//!     |                     ^^^^ required by this bound in `spawn`
//! ```
//!
//! Scenarios (each exits 0 with PASS lines + measured numbers):
//! - hook-roundtrip: median/p99 round-trip latency of a trivial Lua hook
//!   over N=10k dispatches, alternating between two plugin states.
//! - parallel-tools-hooks: 3 tools in parallel, each with before/after
//!   hooks — hooks serialize on the plugin thread, no deadlock, tools still
//!   overlap (total ≈ one tool's duration, not three).
//! - slow-hook-stall: a Lua hook busy-loops 200ms. Measures what stalls:
//!   the dispatching turn (yes, by design), another plugin's queued hook
//!   (yes — head-of-line blocking, the cost §12's budget rule must name),
//!   and a simulated UI heartbeat on the tokio runtime (no — must keep
//!   ticking with <16ms gaps).
//! - abort-mid-hook: engine aborts (drops the pending reply) 50ms into a
//!   300ms hook and continues immediately; the plugin thread notices the
//!   abandoned reply, survives, and serves the next dispatch. The Lua hook
//!   runs to completion — it CANNOT be interrupted mid-execution: mlua's
//!   `Lua::set_interrupt` is Luau-only, and LuaJIT debug hooks
//!   (`Lua::set_hook`) do not fire inside JIT-compiled traces (enabling
//!   them forces interpreter mode and still can't safely unwind across the
//!   Rust/C boundary at arbitrary points). The only safe "cancellation" is
//!   abandoning the reply and letting the hook finish; a hard kill would
//!   require tearing down the whole plugin-thread + domain (§9.16 reload
//!   semantics), not interrupting the hook.
//!
//! Verify: `cargo run -- hook-roundtrip|parallel-tools-hooks|slow-hook-stall|abort-mid-hook|all`
//! (exit 0 each), and `cargo check --features compile_fail_demo` fails with
//! E0277 (the containment proof).

use mlua::{Function, Lua, Table, Value as LuaValue};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

// ---- wire types: plain data only, Send by construction ------------------

/// A hook argument. Plain data — no Lua value ever crosses a thread.
#[derive(Debug, Clone)]
enum Arg {
    S(String),
    I(i64),
}

/// A hook reply: the Lua return table flattened to string key/value pairs.
/// (Production would use typed §6.4 results; strings keep the prototype
/// honest that only plain data crosses back.)
#[derive(Debug, Clone)]
struct HookReply(Vec<(String, String)>);

impl HookReply {
    fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

/// One hook dispatch: plugin index + hook name + args, replied to via
/// oneshot. Dropping the receiver (abort) abandons the reply; the plugin
/// thread detects that and carries on.
struct HookRequest {
    plugin: usize,
    hook: String,
    args: Vec<(&'static str, Arg)>,
    reply: oneshot::Sender<Result<HookReply, String>>,
}

/// Static proof that everything crossing the engine↔plugin-thread boundary
/// is `Send`. The Lua states themselves appear in no crossing type.
#[allow(dead_code)]
fn static_send_proof() {
    fn assert_send<T: Send>() {}
    assert_send::<HookRequest>();
    assert_send::<HookReply>();
    assert_send::<Arg>();
}

// ---- the compile-fail evidence (see module docs) -------------------------

/// !Send containment: with this feature enabled, compilation FAILS
/// ("future cannot be sent between threads safely": `Lua` holds an
/// `Rc<ReentrantMutex<RawLua>>` which is not `Send`) because `tokio::spawn`
/// requires `Future: Send` and the future captures `Lua`. The same error
/// occurs for `std::thread::spawn`. This is the mechanism that makes
/// containment by-construction rather than by-discipline.
#[cfg(feature = "compile_fail_demo")]
mod compile_fail_demo {
    pub fn spawn_lua_on_runtime(lua: mlua::Lua) {
        tokio::spawn(async move {
            lua.load("return 1").exec().unwrap();
        });
    }
}

// ---- the two plugin states (multi-plugin proof) ---------------------------

/// Plugin script template. Each plugin gets its own isolated `Lua` state.
/// `@NAME@` is the plugin name. The re-entrancy guard (`active`) would
/// `error()` if the host ever dispatched into a state concurrently or
/// re-entrantly; `max_active` is reported by `hooks.stats`.
const PLUGIN_TEMPLATE: &str = r#"
local counts = { before = 0, after = 0 }
local active = 0
local max_active = 0

local function enter()
  active = active + 1
  if active > 1 then error("@NAME@: hook re-entered — actor serialization violated") end
  if active > max_active then max_active = active end
end
local function leave() active = active - 1 end

hooks = {}

function hooks.before_tool_call(payload)
  enter()
  counts.before = counts.before + 1
  local r = { action = "allow", plugin = "@NAME@", tool = payload.name, seq = counts.before }
  leave()
  return r
end

function hooks.after_tool_call(payload)
  enter()
  counts.after = counts.after + 1
  local r = { action = "keep", plugin = "@NAME@", tool = payload.name, seq = counts.after }
  leave()
  return r
end

-- Deliberately slow hook: busy-loops for payload.ms wall-clock milliseconds.
-- smith.now_ms is a host function (os.* is removed per SPEC §5.5).
function hooks.busy(payload)
  enter()
  local deadline = smith.now_ms() + payload.ms
  local spins = 0
  while smith.now_ms() < deadline do spins = spins + 1 end
  leave()
  return { action = "allow", plugin = "@NAME@", spins = spins }
end

function hooks.stats()
  return { before = counts.before, after = counts.after, max_active = max_active }
end
"#;

const PLUGIN_NAMES: [&str; 2] = ["alpha", "beta"];

// ---- the plugin thread: one OS thread owns ALL Lua states -----------------

/// Handle held by the (tokio) engine side. Sending is async-friendly;
/// receiving happens on the dedicated plugin thread via `blocking_recv`.
struct PluginHost {
    tx: mpsc::UnboundedSender<HookRequest>,
    abandoned: Arc<AtomicUsize>,
    handle: std::thread::JoinHandle<()>,
}

impl PluginHost {
    fn spawn() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let abandoned = Arc::new(AtomicUsize::new(0));
        let abandoned2 = abandoned.clone();
        let handle = std::thread::Builder::new()
            .name("plugin".into())
            .spawn(move || plugin_thread_main(rx, abandoned2))
            .expect("spawn plugin thread");
        Self {
            tx,
            abandoned,
            handle,
        }
    }

    /// Fire a hook and get the reply receiver without awaiting — used by
    /// abort-mid-hook to `select!` the reply against an abort signal.
    fn dispatch_raw(
        &self,
        plugin: usize,
        hook: &str,
        args: Vec<(&'static str, Arg)>,
    ) -> oneshot::Receiver<Result<HookReply, String>> {
        let (rtx, rrx) = oneshot::channel();
        self.tx
            .send(HookRequest {
                plugin,
                hook: hook.into(),
                args,
                reply: rtx,
            })
            .expect("plugin thread alive");
        rrx
    }

    /// Normal engine-side dispatch: send request, await reply.
    async fn dispatch(
        &self,
        plugin: usize,
        hook: &str,
        args: Vec<(&'static str, Arg)>,
    ) -> Result<HookReply, String> {
        self.dispatch_raw(plugin, hook, args)
            .await
            .map_err(|_| "plugin thread dropped the reply".to_string())?
    }

    /// Close the inbox and join the thread. Returns (abandoned-reply count,
    /// join wait). Join waits for any in-flight hook to finish — that is
    /// the shutdown rule §12 must state.
    fn shutdown(self) -> (usize, Duration) {
        drop(self.tx);
        let t = Instant::now();
        self.handle.join().expect("plugin thread panicked");
        (self.abandoned.load(Ordering::SeqCst), t.elapsed())
    }
}

/// The plugin thread body. The Lua states are created HERE and never move:
/// `Lua` is `!Send` (no `send` feature), so any attempt to move one out is
/// a compile error (see `compile_fail_demo`). Requests execute strictly
/// serially in arrival order — the actor IS the serialization guarantee
/// §9.18 needs ("on the plugin thread within the current tick").
fn plugin_thread_main(
    mut rx: mpsc::UnboundedReceiver<HookRequest>,
    abandoned: Arc<AtomicUsize>,
) {
    let epoch = Instant::now();
    let plugins: Vec<Lua> = PLUGIN_NAMES
        .iter()
        .map(|name| make_plugin_state(epoch, name))
        .collect();
    while let Some(req) = rx.blocking_recv() {
        let result = call_hook(&plugins[req.plugin], &req.hook, &req.args);
        if req.reply.send(result).is_err() {
            // Engine aborted while we ran: the hook already completed (it
            // cannot be interrupted); only its reply is discarded.
            abandoned.fetch_add(1, Ordering::SeqCst);
            println!(
                "[plugin-thread] engine abandoned reply for hook '{}' (abort); \
                 the hook itself had already run to completion",
                req.hook
            );
        }
    }
    // Inbox closed: states drop here, on the thread that owns them.
}

fn make_plugin_state(epoch: Instant, name: &str) -> Lua {
    let lua = Lua::new();
    let smith = lua.create_table().expect("table");
    let now_ms = lua
        .create_function(move |_, ()| Ok(epoch.elapsed().as_secs_f64() * 1000.0))
        .expect("fn");
    smith.set("now_ms", now_ms).expect("set");
    lua.globals().set("smith", smith).expect("set");
    lua.load(PLUGIN_TEMPLATE.replace("@NAME@", name))
        .set_name(name)
        .exec()
        .expect("plugin script loads");
    lua
}

fn call_hook(lua: &Lua, hook: &str, args: &[(&'static str, Arg)]) -> Result<HookReply, String> {
    let payload = lua.create_table().map_err(|e| e.to_string())?;
    for (k, v) in args {
        match v {
            Arg::S(s) => payload.set(*k, s.as_str()),
            Arg::I(i) => payload.set(*k, *i),
        }
        .map_err(|e| e.to_string())?;
    }
    let hooks: Table = lua
        .globals()
        .get("hooks")
        .map_err(|e| format!("no hooks table: {e}"))?;
    let f: Function = hooks
        .get(hook)
        .map_err(|e| format!("no hook '{hook}': {e}"))?;
    let ret: Table = f.call(payload).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for pair in ret.pairs::<String, LuaValue>() {
        let (k, v) = pair.map_err(|e| e.to_string())?;
        out.push((k, lua_value_to_string(&v)));
    }
    Ok(HookReply(out))
}

fn lua_value_to_string(v: &LuaValue) -> String {
    match v {
        LuaValue::String(s) => s.to_string_lossy().to_string(),
        LuaValue::Integer(i) => i.to_string(),
        LuaValue::Number(n) => n.to_string(),
        LuaValue::Boolean(b) => b.to_string(),
        other => format!("<{}>", other.type_name()),
    }
}

// ---- scenario helpers -----------------------------------------------------

fn check(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        println!("PASS: {msg}");
        Ok(())
    } else {
        Err(format!("FAIL: {msg}"))
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn us(d: Duration) -> f64 {
    d.as_secs_f64() * 1_000_000.0
}

// ---- scenario: hook-roundtrip --------------------------------------------

/// Median/p99 round-trip latency of a trivial Lua hook, N=10k dispatches
/// alternating between the two plugin states.
async fn hook_roundtrip() -> Result<(), String> {
    let host = PluginHost::spawn();

    // Warmup: state init + LuaJIT warm.
    for i in 0..100usize {
        host.dispatch(i % 2, "before_tool_call", vec![("name", Arg::S("echo".into()))])
            .await?;
    }

    const N: usize = 10_000;
    let mut lat = Vec::with_capacity(N);
    for i in 0..N {
        let t = Instant::now();
        let r = host
            .dispatch(
                i % 2,
                "before_tool_call",
                vec![("name", Arg::S("echo".into())), ("call", Arg::I(i as i64))],
            )
            .await?;
        lat.push(t.elapsed());
        if r.get("action") != Some("allow") {
            return Err(format!("dispatch {i}: unexpected reply {:?}", r.0));
        }
    }
    lat.sort();
    let (min, med, p99, max) = (lat[0], lat[N / 2], lat[N * 99 / 100], lat[N - 1]);
    println!(
        "hook-roundtrip N={N}: min {:.1}us  median {:.1}us  p99 {:.1}us  max {:.1}us",
        us(min),
        us(med),
        us(p99),
        us(max)
    );

    // Both states saw their share (100 warmup + 10k timed, alternating).
    for p in 0..2 {
        let s = host.dispatch(p, "stats", vec![]).await?;
        check(
            s.get("before") == Some("5050"),
            &format!(
                "plugin {} handled 5050 before_tool_call dispatches (got {:?})",
                PLUGIN_NAMES[p],
                s.get("before")
            ),
        )?;
    }
    check(
        med < Duration::from_millis(1),
        &format!("median round-trip {:.1}us < 1ms (sub-ms target)", us(med)),
    )?;
    check(
        p99 < Duration::from_millis(5),
        &format!("p99 round-trip {:.1}us < 5ms", us(p99)),
    )?;
    let (abandoned, join) = host.shutdown();
    check(
        abandoned == 0,
        &format!("no abandoned replies; plugin thread joined in {:.2}ms", ms(join)),
    )?;
    Ok(())
}

// ---- scenario: parallel-tools-hooks ---------------------------------------

/// 3 mock tools run in parallel on the tool pool (spawn_blocking), each with
/// before/after hooks. Hooks serialize on the plugin thread (re-entrancy
/// guard in Lua would error otherwise); tools still overlap: total wall time
/// ≈ one tool's 100ms, not 300ms. No deadlock.
async fn parallel_tools_hooks() -> Result<(), String> {
    let host = Arc::new(PluginHost::spawn());
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    for i in 0..3usize {
        let h = host.clone();
        tasks.push(tokio::spawn(async move {
            let name = format!("tool{i}");
            let before = h
                .dispatch(i % 2, "before_tool_call", vec![("name", Arg::S(name.clone()))])
                .await?;
            if before.get("action") != Some("allow") {
                return Err(format!("{name}: before hook denied: {:?}", before.0));
            }
            // Mock tool: 100ms of blocking work on the §12 tool pool.
            let tt = Instant::now();
            tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
                .await
                .map_err(|e| e.to_string())?;
            let tool_elapsed = tt.elapsed();
            let after = h
                .dispatch(i % 2, "after_tool_call", vec![("name", Arg::S(name.clone()))])
                .await?;
            if after.get("action") != Some("keep") {
                return Err(format!("{name}: after hook wrong: {:?}", after.0));
            }
            Ok::<Duration, String>(tool_elapsed)
        }));
    }
    for (i, t) in tasks.into_iter().enumerate() {
        let tool_elapsed = t.await.map_err(|e| e.to_string())??;
        println!("tool{i}: ran {:.1}ms with before/after hooks", ms(tool_elapsed));
    }
    let total = t0.elapsed();
    println!("parallel-tools-hooks: 3 tools x 100ms + 6 hooks, total wall {:.1}ms", ms(total));

    check(
        total >= Duration::from_millis(100),
        "total >= 100ms (tools really ran)",
    )?;
    check(
        total < Duration::from_millis(250),
        &format!("total {:.1}ms < 250ms — tools overlapped (serial would be >=300ms)", ms(total)),
    )?;
    // Hook serialization: the Lua-side re-entrancy guard never tripped, and
    // per-state max concurrent hook executions is exactly 1.
    let mut counts = [0usize; 2];
    for p in 0..2 {
        let s = host.dispatch(p, "stats", vec![]).await?;
        check(
            s.get("max_active") == Some("1"),
            &format!(
                "plugin {}: max concurrent hook executions observed = 1 (actor serializes)",
                PLUGIN_NAMES[p]
            ),
        )?;
        counts[p] = s.get("before").and_then(|v| v.parse().ok()).unwrap_or(0);
    }
    check(
        counts[0] + counts[1] == 3,
        &format!("all 3 before hooks dispatched exactly once (alpha {} + beta {})", counts[0], counts[1]),
    )?;
    let host = Arc::try_unwrap(host).map_err(|_| "host still shared".to_string())?;
    let (abandoned, _) = host.shutdown();
    check(abandoned == 0, "no deadlock, no abandoned replies")?;
    Ok(())
}

// ---- scenario: slow-hook-stall --------------------------------------------

/// A Lua hook busy-loops 200ms. What stalls?
/// - the dispatching turn: YES (it awaits the reply — by design),
/// - another plugin's queued hook: YES (head-of-line blocking on the single
///   plugin thread — the cost §12's budget rule must name),
/// - the tokio runtime / simulated UI heartbeat: NO (<16ms tick gaps hold).
async fn slow_hook_stall() -> Result<(), String> {
    let host = Arc::new(PluginHost::spawn());
    // Warm both states so timing below is not init noise.
    for p in 0..2 {
        host.dispatch(p, "before_tool_call", vec![("name", Arg::S("warm".into()))])
            .await?;
    }

    // Simulated UI heartbeat on the tokio runtime: tick every 5ms, record
    // the max gap between consecutive ticks.
    let stop = Arc::new(AtomicBool::new(false));
    let hb_stop = stop.clone();
    let heartbeat = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await; // first tick is immediate
        let mut last = Instant::now();
        let mut max_gap = Duration::ZERO;
        let mut ticks = 0u32;
        while !hb_stop.load(Ordering::Relaxed) {
            interval.tick().await;
            let now = Instant::now();
            max_gap = max_gap.max(now - last);
            last = now;
            ticks += 1;
        }
        (ticks, max_gap)
    });

    tokio::time::sleep(Duration::from_millis(50)).await; // heartbeat baseline

    // The dispatching turn: awaits a hook that busy-loops 200ms in Lua.
    let turn = {
        let h = host.clone();
        tokio::spawn(async move {
            let t = Instant::now();
            let r = h.dispatch(1, "busy", vec![("ms", Arg::I(200))]).await;
            (t.elapsed(), r)
        })
    };
    // 20ms in, another plugin's trivial hook gets dispatched: it must queue
    // behind the busy hook (head-of-line blocking).
    tokio::time::sleep(Duration::from_millis(20)).await;
    let tq = Instant::now();
    let probe = host
        .dispatch(0, "before_tool_call", vec![("name", Arg::S("probe".into()))])
        .await?;
    let probe_lat = tq.elapsed();
    if probe.get("action") != Some("allow") {
        return Err(format!("probe hook wrong reply: {:?}", probe.0));
    }
    let (busy_elapsed, busy_reply) = turn.await.map_err(|e| e.to_string())?;
    let busy_reply = busy_reply?;

    tokio::time::sleep(Duration::from_millis(50)).await; // trailing baseline
    stop.store(true, Ordering::Relaxed);
    let (ticks, max_gap) = heartbeat.await.map_err(|e| e.to_string())?;

    println!(
        "slow-hook-stall: busy hook ran {:.1}ms ({} Lua spins); dispatching turn waited the full time",
        ms(busy_elapsed),
        busy_reply.get("spins").unwrap_or("?")
    );
    println!(
        "slow-hook-stall: other plugin's hook queued behind it: {:.1}ms latency (head-of-line blocking)",
        ms(probe_lat)
    );
    println!(
        "slow-hook-stall: UI heartbeat ticked {ticks} times, max inter-tick gap {:.2}ms",
        ms(max_gap)
    );

    check(
        busy_elapsed >= Duration::from_millis(200) && busy_elapsed < Duration::from_millis(400),
        &format!("dispatching turn stalled {:.1}ms — a slow hook blocks ONLY its awaiting turn", ms(busy_elapsed)),
    )?;
    check(
        probe_lat >= Duration::from_millis(120),
        &format!(
            "cross-plugin head-of-line blocking measured: {:.1}ms wait for a trivial hook (expected ~180ms)",
            ms(probe_lat)
        ),
    )?;
    check(
        max_gap < Duration::from_millis(16),
        &format!(
            "UI heartbeat never stalled: max gap {:.2}ms < 16ms while the hook busy-looped 200ms",
            ms(max_gap)
        ),
    )?;
    println!(
        "NOTE: §12 budget rule this evidences — a hook blocks its dispatching turn and ALL queued \
         plugin dispatches (every plugin shares the one plugin thread), but never the engine \
         runtime, UI, or tool pool. Hooks cannot be preempted on LuaJIT, so the budget must be \
         a soft deadline (warn/report), not an enforced timeout."
    );
    let host = Arc::try_unwrap(host).map_err(|_| "host still shared".to_string())?;
    host.shutdown();
    Ok(())
}

// ---- scenario: abort-mid-hook ---------------------------------------------

/// Engine aborts 50ms into a 300ms hook: it drops the pending reply and
/// continues immediately. The plugin thread finds the receiver gone, logs,
/// and serves the next dispatch — it survives. The Lua hook itself runs to
/// completion: it CANNOT be interrupted (mlua's interrupt API is Luau-only;
/// LuaJIT debug hooks don't fire in JIT traces and can't safely unwind at
/// arbitrary points). Hard cancellation = domain teardown (§9.16), not hook
/// interruption.
async fn abort_mid_hook() -> Result<(), String> {
    let host = PluginHost::spawn();
    host.dispatch(1, "before_tool_call", vec![("name", Arg::S("warm".into()))])
        .await?;

    let t0 = Instant::now();
    let mut pending = host.dispatch_raw(1, "busy", vec![("ms", Arg::I(300))]);
    let aborted_at;
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(50)) => {
            aborted_at = t0.elapsed(); // §9.16-style cancellation observed
        }
        r = &mut pending => {
            return Err(format!("hook returned before abort fired: {r:?}"));
        }
    }
    drop(pending); // the abort: abandon the reply, do NOT wait for the hook
    println!(
        "abort-mid-hook: abort observed at {:.1}ms into a 300ms hook; engine continued without waiting",
        ms(aborted_at)
    );
    check(
        aborted_at < Duration::from_millis(150),
        &format!("engine unblocked at abort (+{:.1}ms), not at hook completion (~300ms)", ms(aborted_at)),
    )?;

    // Engine continues shutdown work: next dispatch proves the plugin thread
    // survived the abandoned reply — and its latency proves the aborted hook
    // ran to completion first (it queued behind the remaining ~250ms).
    let tq = Instant::now();
    let r = host
        .dispatch(1, "before_tool_call", vec![("name", Arg::S("post-abort".into()))])
        .await?;
    let post_lat = tq.elapsed();
    println!(
        "abort-mid-hook: post-abort dispatch answered after {:.1}ms (queued behind the finishing hook)",
        ms(post_lat)
    );
    check(
        r.get("action") == Some("allow"),
        "plugin thread survived the abandoned reply and served the next hook",
    )?;
    check(
        post_lat >= Duration::from_millis(150) && post_lat < Duration::from_millis(450),
        &format!(
            "aborted Lua hook ran to completion anyway ({:.1}ms queue wait) — hooks are NOT interruptible",
            ms(post_lat)
        ),
    )?;
    let (abandoned, join) = host.shutdown();
    check(
        abandoned == 1,
        "plugin thread detected exactly one abandoned reply (the abort)",
    )?;
    check(
        join < Duration::from_millis(50),
        &format!("shutdown join fast ({:.2}ms) once the thread is idle; a join mid-hook would wait for the hook", ms(join)),
    )?;
    println!(
        "NOTE: the Lua hook could not be interrupted — only its reply was abandoned. \
         mlua interrupts are Luau-only; LuaJIT line hooks don't fire in compiled traces. \
         §12 must say abort abandons the DISPATCH, and hard-kill is §9.16 domain teardown."
    );
    Ok(())
}

// ---- main ------------------------------------------------------------------

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let result = run(&scenario).await;
    match result {
        Ok(()) => println!("PASS: p15 scenario '{scenario}' complete"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

async fn run(scenario: &str) -> Result<(), String> {
    match scenario {
        "hook-roundtrip" => hook_roundtrip().await,
        "parallel-tools-hooks" => parallel_tools_hooks().await,
        "slow-hook-stall" => slow_hook_stall().await,
        "abort-mid-hook" => abort_mid_hook().await,
        "all" => {
            for s in [
                "hook-roundtrip",
                "parallel-tools-hooks",
                "slow-hook-stall",
                "abort-mid-hook",
            ] {
                println!("=== {s} ===");
                Box::pin(run(s)).await?;
            }
            Ok(())
        }
        other => Err(format!(
            "unknown scenario '{other}'; use hook-roundtrip|parallel-tools-hooks|slow-hook-stall|abort-mid-hook|all"
        )),
    }
}
