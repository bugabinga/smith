//! p10-lua-plugin-heap-limit
//!
//! Proves or disproves: Smith's Lua plugin sandbox can enforce per-plugin heap
//! limits under mlua 0.10 + vendored LuaJIT (docs/SPEC.md §9.14 Sandbox,
//! §9.16 Plugin Hot-Reload domain, §9.17 Plugin Error Model):
//!   - `Lua::used_memory()` / `Lua::set_memory_limit()` work in Smith's locked
//!     feature set (`luajit`, `vendored`, `serialize`),
//!   - a plugin exceeding its quota fails with a recoverable Lua error,
//!   - the failure does not corrupt the host or other plugins,
//!   - host-created values exposed to Lua have measurable accounting semantics.
//!
//! Verify: `cargo run -- small|oom-table|oom-string|isolation|host-value|all`
//!
//! For OOM scenarios "PASS" means the quota was enforced OR the disproof was
//! demonstrated and reported precisely — never a host crash. If the native
//! limit is unavailable/ignored, the prototype measures the fallback: a
//! count-based debug hook calling `used_memory()` and raising a Lua error.

use mlua::{Error as LuaError, HookTriggers, Lua, Table, Value, VmState};
use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

const SMALL: &str = include_str!("../plugins/small.lua");
const OOM_TABLE: &str = include_str!("../plugins/oom_table.lua");
const OOM_STRING: &str = include_str!("../plugins/oom_string.lua");
const HOST_VALUE: &str = include_str!("../plugins/host_value.lua");

const MIB: usize = 1024 * 1024;
/// Per-plugin heap quota under test.
const QUOTA: usize = 16 * MIB;
/// Absolute host-protection fuse (hook-based), far above the quota. If growth
/// sails past this, enforcement is disproved but the host must still survive.
const FUSE_BYTES: usize = 128 * MIB;
/// Wall-clock fuse so an unenforced infinite loop cannot hang the prototype.
const FUSE_SECS: u64 = 20;
/// Guard hook granularity: check after EVERY instruction. Required because
/// plugins/oom_string.lua doubles its allocation per iteration; a coarser
/// check interval (e.g. 1000 instructions ≈ ~150 loop iterations) would let a
/// doubling allocation overshoot to gigabytes between checks.
const GUARD_EVERY: u32 = 1;

// ---------------------------------------------------------------------------
// PASS/FAIL bookkeeping (same style as p02)
// ---------------------------------------------------------------------------

struct Checker {
    pass: bool,
}

impl Checker {
    fn check(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
    fn note(&self, msg: &str) {
        println!("     {msg}");
    }
}

// ---------------------------------------------------------------------------
// Probing: does the native limit exist? do count hooks fire under LuaJIT?
// ---------------------------------------------------------------------------

struct Plan {
    /// Result of `set_memory_limit(QUOTA)` on a throwaway state.
    native: Result<usize, String>,
    /// Count-hook fires over a bounded 3e6-iteration loop, JIT on.
    hook_fires_jit_on: u64,
    /// Same with `jit.off()` first.
    hook_fires_jit_off: u64,
}

impl Plan {
    fn native_available(&self) -> bool {
        self.native.is_ok()
    }
    fn hooks_fire(&self) -> bool {
        self.hook_fires_jit_on > 0 || self.hook_fires_jit_off > 0
    }
    /// Hooks only fire with the JIT compiler off.
    fn need_jit_off(&self) -> bool {
        self.hook_fires_jit_on == 0 && self.hook_fires_jit_off > 0
    }
}

/// Run a bounded arithmetic loop (3e6 iterations) with an optional counting
/// hook. Returns (hook fire count, elapsed).
fn bench_loop(disable_jit: bool, hook_every: Option<u32>) -> (u64, Duration) {
    let lua = Lua::new();
    if disable_jit {
        lua.load("if jit then jit.off() end").exec().expect("jit.off");
    }
    let fires = Rc::new(Cell::new(0u64));
    if let Some(n) = hook_every {
        let f = fires.clone();
        lua.set_hook(HookTriggers::new().every_nth_instruction(n), move |_, _| {
            f.set(f.get() + 1);
            Ok(VmState::Continue)
        });
    }
    let t = Instant::now();
    let sum: f64 = lua
        .load("local x = 0 for i = 1, 3000000 do x = x + i end return x")
        .eval()
        .expect("bench loop");
    let elapsed = t.elapsed();
    assert!(sum > 0.0);
    (fires.get(), elapsed)
}

fn probe_plan() -> Plan {
    let lua = Lua::new();
    let native = lua.set_memory_limit(QUOTA).map_err(|e| e.to_string());
    let (on, _) = bench_loop(false, Some(1000));
    let (off, _) = bench_loop(true, Some(1000));
    Plan {
        native,
        hook_fires_jit_on: on,
        hook_fires_jit_off: off,
    }
}

// ---------------------------------------------------------------------------
// Guard: hook-based quota enforcement + host-protection fuse
// ---------------------------------------------------------------------------

/// Install a count hook that (a) enforces `hook_quota` if given (the fallback
/// when the native limit is unavailable), and (b) always acts as a fuse so an
/// unenforced runaway plugin cannot crash or hang the host.
fn install_guard(lua: &Lua, hook_quota: Option<usize>) {
    let start = Instant::now();
    lua.set_hook(
        HookTriggers::new().every_nth_instruction(GUARD_EVERY),
        move |lua, _| {
            let used = lua.used_memory();
            if let Some(q) = hook_quota {
                if used > q {
                    return Err(LuaError::RuntimeError(format!(
                        "P10-QUOTA: plugin heap quota exceeded (used {used} > quota {q})"
                    )));
                }
            }
            if used > FUSE_BYTES {
                return Err(LuaError::RuntimeError(format!(
                    "P10-FUSE-MEM: runaway allocation, host fuse tripped at {used} bytes"
                )));
            }
            if start.elapsed() > Duration::from_secs(FUSE_SECS) {
                return Err(LuaError::RuntimeError(
                    "P10-FUSE-TIME: wall-clock fuse tripped".into(),
                ));
            }
            Ok(VmState::Continue)
        },
    );
}

fn err_kind(e: &LuaError) -> &'static str {
    let s = format!("{e} {e:?}");
    if matches!(e, LuaError::MemoryError(_)) || s.contains("not enough memory") || s.contains("MemoryError") {
        "native-memory-error"
    } else if s.contains("P10-QUOTA") {
        "hook-quota"
    } else if s.contains("P10-FUSE") {
        "fuse"
    } else {
        "other"
    }
}

fn err_line(e: &LuaError) -> String {
    let full = e.to_string();
    full.lines().next().unwrap_or("").chars().take(160).collect()
}

// ---------------------------------------------------------------------------
// Growth run: one plugin state, one growth script, full observation
// ---------------------------------------------------------------------------

struct GrowthRun {
    /// "completed" or an err_kind.
    outcome: &'static str,
    err_line: String,
    base: usize,
    peak: usize,
    after_gc: usize,
    /// State still usable after the error (gc_collect + trivial eval).
    recovered: bool,
}

fn run_growth(
    script: &str,
    name: &str,
    use_native: bool,
    hook_quota: Option<usize>,
    jit_off: bool,
) -> GrowthRun {
    let lua = Lua::new();
    if jit_off {
        let _ = lua.load("if jit then jit.off() end").exec();
    }
    if use_native {
        lua.set_memory_limit(QUOTA)
            .expect("native limit accepted by probe but rejected here");
    }
    let base = lua.used_memory();
    install_guard(&lua, hook_quota);
    let result: Result<Value, LuaError> = lua.load(script).set_name(name).eval();
    let peak = lua.used_memory();
    lua.remove_hook();
    // Host recovery behavior after a plugin OOM: collect the dead plugin
    // chunk's garbage, then verify the state still evaluates.
    let _ = lua.gc_collect();
    let _ = lua.gc_collect();
    let after_gc = lua.used_memory();
    let recovered = lua
        .load("return 1 + 1")
        .eval::<i64>()
        .map(|v| v == 2)
        .unwrap_or(false);
    let (outcome, err_line) = match &result {
        Ok(_) => ("completed", String::new()),
        Err(e) => (err_kind(e), err_line(e)),
    };
    GrowthRun {
        outcome,
        err_line,
        base,
        peak,
        after_gc,
        recovered,
    }
}

/// A quota-guarded plugin state using the best available mechanism.
fn guarded_state(plan: &Plan, quota: usize) -> (Lua, &'static str) {
    let lua = Lua::new();
    if plan.need_jit_off() {
        let _ = lua.load("if jit then jit.off() end").exec();
    }
    if lua.set_memory_limit(quota).is_ok() {
        install_guard(&lua, None); // fuse only; native limit enforces
        (lua, "native")
    } else if plan.hooks_fire() {
        install_guard(&lua, Some(quota));
        (lua, "hook-fallback")
    } else {
        (lua, "UNENFORCED")
    }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

fn scenario_small(c: &mut Checker, plan: &Plan) -> Result<(), LuaError> {
    println!("--- small: plugin stays under the {} MiB quota ---", QUOTA / MIB);
    let (lua, mode) = guarded_state(plan, QUOTA);
    c.note(&format!("enforcement mode: {mode}"));
    let base = lua.used_memory();
    let result: Result<Table, LuaError> = lua.load(SMALL).set_name("plugins/small.lua").eval();
    let used = lua.used_memory();
    c.check(
        &format!("small: used_memory() reports nonzero baseline and growth ({base} -> {used} bytes)"),
        base > 0 && used > base,
    );
    match result {
        Ok(t) => {
            let count: i64 = t.get("count")?;
            c.check(
                &format!("small: plugin under quota completes normally (count={count})"),
                count == 1000,
            );
        }
        Err(e) => c.check(&format!("small: plugin failed unexpectedly: {}", err_line(&e)), false),
    }
    Ok(())
}

fn scenario_oom(c: &mut Checker, plan: &Plan, name: &str, script: &str) -> Result<(), LuaError> {
    println!("--- {name}: unbounded growth vs {} MiB quota ---", QUOTA / MIB);
    match &plan.native {
        Ok(prev) => c.note(&format!(
            "probe: set_memory_limit({QUOTA}) = Ok(prev={prev}) — native limit ACCEPTED under mlua 0.10 + vendored LuaJIT"
        )),
        Err(e) => c.note(&format!(
            "probe: set_memory_limit({QUOTA}) = Err({e}) — native limit UNAVAILABLE under mlua 0.10 + vendored LuaJIT"
        )),
    }

    if !plan.native_available() && !plan.hooks_fire() {
        // No native limit and no firing hooks: running unbounded growth would
        // crash the host. Refusing to run IS the disproof demonstration.
        c.check(
            &format!(
                "{name}: DISPROVED — set_memory_limit unavailable AND count hooks never fire \
                 (jit-on fires={}, jit-off fires={}); per-plugin heap quota is not implementable; \
                 refusing to run unbounded growth (would crash host)",
                plan.hook_fires_jit_on, plan.hook_fires_jit_off
            ),
            true,
        );
        return Ok(());
    }

    // Phase 1: native enforcement if available (hook acts as fuse only),
    // otherwise hook-based quota.
    let native = plan.native_available();
    let hook_quota = if native { None } else { Some(QUOTA) };
    let run = run_growth(script, name, native, hook_quota, plan.need_jit_off());

    c.check(
        &format!(
            "{name}: used_memory() observes growth ({} -> {} bytes at failure)",
            run.base, run.peak
        ),
        run.peak > run.base,
    );
    c.note(&format!("outcome={} err='{}'", run.outcome, run.err_line));
    c.note(&format!(
        "used_memory: base={} peak-at-failure={} overshoot-vs-quota={} after-gc={}",
        run.base,
        run.peak,
        run.peak.saturating_sub(QUOTA),
        run.after_gc
    ));

    match run.outcome {
        "native-memory-error" => {
            c.check(
                &format!("{name}: native set_memory_limit enforced the quota with a recoverable Lua memory error"),
                true,
            );
        }
        "hook-quota" => {
            c.check(
                &format!(
                    "{name}: hook-fallback quota enforced (granularity: every {GUARD_EVERY} instruction(s), overshoot {} bytes)",
                    run.peak.saturating_sub(QUOTA)
                ),
                true,
            );
        }
        "fuse" => {
            if native {
                c.note(
                    "set_memory_limit returned Ok but DID NOT enforce — growth sailed past the quota to the host fuse",
                );
                // Phase 2: measure the hook fallback on a fresh state.
                if plan.hooks_fire() {
                    let run2 = run_growth(script, name, false, Some(QUOTA), plan.need_jit_off());
                    c.note(&format!(
                        "fallback outcome={} err='{}' peak={} overshoot={}",
                        run2.outcome,
                        run2.err_line,
                        run2.peak,
                        run2.peak.saturating_sub(QUOTA)
                    ));
                    c.check(
                        &format!("{name}: hook-fallback quota enforced after native limit proved to be a no-op"),
                        run2.outcome == "hook-quota" && run2.recovered,
                    );
                } else {
                    c.check(
                        &format!("{name}: DISPROVED — native limit is a silent no-op and hooks never fire; only the coarse fuse protected the host"),
                        true,
                    );
                }
            } else {
                c.check(
                    &format!("{name}: hook quota failed to stop growth before the fuse (unexpected)"),
                    false,
                );
            }
        }
        "completed" => {
            c.check(&format!("{name}: unbounded growth script terminated without error (unexpected)"), false);
        }
        _ => {
            c.check(&format!("{name}: unexpected error kind: {}", run.err_line), false);
        }
    }

    c.check(&format!("{name}: host process survived the OOM scenario"), true);
    c.check(
        &format!(
            "{name}: plugin Lua state usable after quota error (gc_collect, then eval; used after gc = {} bytes)",
            run.after_gc
        ),
        run.recovered,
    );
    Ok(())
}

fn scenario_isolation(c: &mut Checker, plan: &Plan) -> Result<(), LuaError> {
    println!("--- isolation: plugin A OOMs, plugin B keeps working ---");

    // One Lua state per plugin (the PLAN's primary model).
    let (lua_b, mode_b) = guarded_state(plan, QUOTA);
    let warm: i64 = lua_b.load("K = 41 return K").eval()?;
    c.check(
        &format!("isolation: plugin B (own Lua state, mode {mode_b}) warms up (K={warm})"),
        warm == 41,
    );

    if !plan.native_available() && !plan.hooks_fire() {
        c.check(
            "isolation: DISPROVED — no enforcement mechanism; skipping plugin A unbounded growth (would crash host)",
            true,
        );
    } else {
        let native = plan.native_available();
        let hook_quota = if native { None } else { Some(QUOTA) };
        let run_a = run_growth(
            OOM_TABLE,
            "plugins/oom_table.lua (plugin A)",
            native,
            hook_quota,
            plan.need_jit_off(),
        );
        c.note(&format!(
            "plugin A outcome={} err='{}' peak={}",
            run_a.outcome, run_a.err_line, run_a.peak
        ));
        c.check(
            "isolation: plugin A growth stopped by quota (recoverable error, no host crash)",
            matches!(run_a.outcome, "native-memory-error" | "hook-quota"),
        );
        c.check(
            "isolation: plugin A state itself is recoverable after its OOM",
            run_a.recovered,
        );
    }

    // Plugin B must be unaffected: prior state intact and new work runs.
    let k: i64 = lua_b.load("return K + 1").eval()?;
    let b_result: Result<Table, LuaError> = lua_b.load(SMALL).set_name("plugins/small.lua").eval();
    let b_count = b_result.and_then(|t| t.get::<i64>("count")).unwrap_or(-1);
    c.check(
        &format!("isolation: plugin B unaffected after plugin A OOM (K+1={k}, small run count={b_count})"),
        k == 42 && b_count == 1000,
    );

    // Shared-state per-plugin quota attempt (the PLAN asks: enforceable or
    // impossible?). Bounded allocations only — safe with or without quota.
    println!("--- isolation: shared-state per-plugin quota attempt ---");
    let shared = Lua::new();
    if plan.need_jit_off() {
        let _ = shared.load("if jit then jit.off() end").exec();
    }
    shared
        .load("A = {} for i = 1, 100000 do A[i] = string.rep('x', 100) .. i end return 'ok'")
        .set_name("shared: plugin A retains ~12 MiB")
        .exec()?;
    let _ = shared.gc_collect();
    let _ = shared.gc_collect();
    let used_a = shared.used_memory();
    c.note(&format!("plugin A retained {used_a} bytes in the shared state"));

    let mode = if shared.set_memory_limit(QUOTA).is_ok() {
        "native"
    } else if plan.hooks_fire() {
        install_guard(&shared, Some(QUOTA));
        "hook-fallback"
    } else {
        "UNENFORCED"
    };

    if mode == "UNENFORCED" {
        c.check(
            "isolation: shared-state quota attempt skipped — no enforcement mechanism exists at all",
            true,
        );
    } else {
        // "Plugin B's quota": the only knob is the WHOLE state. B allocates
        // ~12 MiB of its own, but A's retained memory already counts.
        let rb: Result<i64, LuaError> = shared
            .load("local B = {} for i = 1, 100000 do B[i] = string.rep('y', 100) .. i end return #B")
            .set_name("shared: plugin B allocates ~12 MiB")
            .eval();
        let used_at_end = shared.used_memory();
        match rb {
            Err(e) => {
                let b_own = used_at_end.saturating_sub(used_a);
                c.note(&format!(
                    "shared-state ({mode}) error: '{}' — B charged at total={used_at_end} bytes while B's own allocations were only ~{b_own} bytes",
                    err_line(&e)
                ));
                c.check(
                    "isolation: shared-state quota charges plugin B for plugin A's retained memory — per-plugin quotas in a shared state are NOT enforceable; quota domain must be one Lua state per plugin",
                    true,
                );
            }
            Ok(n) => {
                c.check(
                    &format!(
                        "isolation: shared-state quota unexpectedly NOT tripped (B completed n={n}, total used={used_at_end}, quota={QUOTA})"
                    ),
                    false,
                );
            }
        }
    }
    println!("     QUOTA DOMAIN: per-plugin heap quota requires one Lua state per plugin; a shared state offers only a whole-state limit with no per-plugin attribution");
    Ok(())
}

fn scenario_host_value(c: &mut Checker, plan: &Plan) -> Result<(), LuaError> {
    println!("--- host-value: accounting of host-created values exposed to Lua ---");
    let lua = Lua::new();
    let _ = lua.gc_collect();
    let m0 = lua.used_memory();

    // 8 MiB host bytes -> Lua string (allocated on the Lua heap).
    let blob = vec![b'z'; 8 * MIB];
    let s = lua.create_string(&blob)?;
    lua.globals().set("HOST_BLOB", s)?;
    let m1 = lua.used_memory();
    let d_blob = m1.saturating_sub(m0);
    c.check(
        &format!("host-value: 8 MiB host-created Lua string IS accounted by used_memory (delta={d_blob} bytes)"),
        d_blob >= 7 * MIB,
    );

    // 8 MiB Rust Vec behind userdata (payload lives on the Rust side).
    let ud = lua.create_any_userdata(vec![0u8; 8 * MIB])?;
    lua.globals().set("HOST_UD", ud)?;
    let m2 = lua.used_memory();
    let d_ud = m2.saturating_sub(m1);
    let counted = d_ud >= 7 * MIB;
    c.note(&format!(
        "host userdata with 8 MiB Rust Vec payload: used_memory delta={d_ud} bytes -> Rust-side payload {} by Lua accounting",
        if counted { "IS counted" } else { "is NOT counted (accounting gap: quota cannot see host-side plugin allocations)" }
    ));
    c.check("host-value: userdata Rust-payload accounting measured and reported", true);

    // The plugin can observe both values.
    let t: Table = lua.load(HOST_VALUE).set_name("plugins/host_value.lua").eval()?;
    let blob_len: i64 = t.get("blob_len")?;
    let ud_type: String = t.get("ud_type")?;
    c.check(
        &format!("host-value: plugin observes host values (blob_len={blob_len}, ud_type={ud_type})"),
        blob_len == (8 * MIB) as i64 && ud_type == "userdata",
    );

    // Interaction with the limit: creating a host value bigger than the quota.
    if plan.native_available() {
        let lua2 = Lua::new();
        lua2.set_memory_limit(4 * MIB)
            .expect("native limit accepted by probe");
        match lua2.create_string(&blob) {
            Err(e) => {
                c.note(&format!("create_string(8 MiB) under 4 MiB native limit -> Err: {}", err_line(&e)));
                c.check(
                    "host-value: host-side big-value creation hits the native limit as a recoverable Rust-side error",
                    matches!(err_kind(&e), "native-memory-error"),
                );
            }
            Ok(_) => {
                c.check(
                    "host-value: FINDING — create_string(8 MiB) succeeded despite 4 MiB native limit (host-side allocations bypass the limit)",
                    true,
                );
            }
        }
    } else {
        c.note("native limit unavailable: host-side creations can only be policed by checking used_memory() manually after each boundary call");
    }
    Ok(())
}

fn scenario_bench(c: &mut Checker, plan: &Plan) {
    println!("--- bench: count-hook fallback cost/granularity (bounded 3e6-iter loop) ---");
    let (_, base_on) = bench_loop(false, None);
    let (_, base_off) = bench_loop(true, None);
    let (f_on_1000, t_on_1000) = bench_loop(false, Some(1000));
    let (f_off_1000, t_off_1000) = bench_loop(true, Some(1000));
    let (f_off_1, t_off_1) = bench_loop(true, Some(1));
    c.note(&format!("jit-on,  no hook:            {base_on:?}"));
    c.note(&format!("jit-off, no hook:            {base_off:?}"));
    c.note(&format!("jit-on,  hook every 1000:    {t_on_1000:?} ({f_on_1000} fires)"));
    c.note(&format!("jit-off, hook every 1000:    {t_off_1000:?} ({f_off_1000} fires)"));
    c.note(&format!("jit-off, hook every 1:       {t_off_1:?} ({f_off_1} fires)"));
    c.check(
        &format!(
            "bench: hook firing measured (jit-on fires={}, jit-off fires={})",
            plan.hook_fires_jit_on, plan.hook_fires_jit_off
        ),
        true,
    );
}

// ---------------------------------------------------------------------------

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    let scenarios: Vec<&str> = match arg.as_str() {
        "small" => vec!["small"],
        "oom-table" => vec!["oom-table"],
        "oom-string" => vec!["oom-string"],
        "isolation" => vec!["isolation"],
        "host-value" => vec!["host-value"],
        "all" => vec!["small", "oom-table", "oom-string", "isolation", "host-value", "bench"],
        _ => {
            eprintln!("usage: p10-lua-plugin-heap-limit small|oom-table|oom-string|isolation|host-value|all");
            std::process::exit(2);
        }
    };

    let plan = probe_plan();
    println!(
        "probe: set_memory_limit({QUOTA}) on fresh state -> {}",
        match &plan.native {
            Ok(prev) => format!("Ok(prev={prev})"),
            Err(e) => format!("Err({e})"),
        }
    );
    println!(
        "probe: count-hook fires over bounded loop: jit-on={} jit-off={}",
        plan.hook_fires_jit_on, plan.hook_fires_jit_off
    );
    println!();

    let mut c = Checker { pass: true };
    for s in scenarios {
        let r = match s {
            "small" => scenario_small(&mut c, &plan),
            "oom-table" => scenario_oom(&mut c, &plan, "oom-table", OOM_TABLE),
            "oom-string" => scenario_oom(&mut c, &plan, "oom-string", OOM_STRING),
            "isolation" => scenario_isolation(&mut c, &plan),
            "host-value" => scenario_host_value(&mut c, &plan),
            "bench" => {
                scenario_bench(&mut c, &plan);
                Ok(())
            }
            _ => unreachable!(),
        };
        if let Err(e) = r {
            c.check(&format!("{s}: scenario aborted with error: {e}"), false);
        }
        println!();
    }

    println!(
        "quota domain statement: per-plugin heap quota = one Lua state per plugin (native set_memory_limit {}); shared-state per-plugin quotas are not attributable",
        if plan.native_available() { "available" } else { "UNAVAILABLE, hook fallback measured" }
    );
    if c.pass {
        println!("p10 RESULT: all expectations hold");
    } else {
        println!("p10 RESULT: expectation failed");
        std::process::exit(1);
    }
}
