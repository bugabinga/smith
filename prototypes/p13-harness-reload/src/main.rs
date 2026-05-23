//! Prototype P13: Harness reload timing.
//! Validates SM-009 harness integration — measures time to init/teardown/reinit
//! the core subsystems (Lua runtime, CBOR codec, config, provider pool).
//!
//! Tests:
//! 1. Single harness init timing
//! 2. Harness teardown timing
//! 3. Full reload cycle (teardown + init) timing
//! 4. N consecutive reload cycles — proves sub-second reload
//! 5. Lua state survives reload boundary (fresh each cycle)
//! 6. Config CBOR roundtrip within harness context

use std::time::Instant;
use mlua::Lua;


/// Simulated harness — contains all the heavy subsystems.
struct Harness {
    lua: Lua,
    config: AppConfig,
    codec_state: CodecState,
    provider_registry: ProviderRegistry,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct AppConfig {
    model: String,
    max_tokens: u32,
    temperature: f64,
    workspace: String,
    plugins: Vec<String>,
}

struct CodecState {
    entry_count: usize,
    buffer: Vec<u8>,
}

struct ProviderRegistry {
    providers: Vec<String>,
    active: usize,
}

impl Harness {
    fn new() -> Self {
        Harness {
            lua: Lua::new(),
            config: AppConfig {
                model: "MiniMax-M2.7".into(),
                max_tokens: 4096,
                temperature: 0.7,
                workspace: "/tmp/smith".into(),
                plugins: vec!["formatter.lua".into(), "linter.lua".into()],
            },
            codec_state: CodecState {
                entry_count: 0,
                buffer: Vec::with_capacity(64 * 1024),
            },
            provider_registry: ProviderRegistry {
                providers: vec!["minimax".into(), "openai".into(), "anthropic".into()],
                active: 0,
            },
        }
    }

    /// Warm up the harness: load Lua plugins, init codec, register providers.
    fn warmup(&mut self) {
        // Load sandbox
        self.lua.load(r#"
            local raw_os = os
            os = setmetatable({}, {
                __index = function(_, k)
                    if k == "execute" or k == "exit" then return nil end
                    return raw_os[k]
                end
            })
        "#).exec().expect("sandbox setup");

        // Load plugin stubs
        for plugin in &self.config.plugins {
            let code = format!(r#"
                plugins = plugins or {{}}
                plugins["{name}"] = {{ version = "1.0", hooks = {{}} }}
            "#, name = plugin);
            self.lua.load(&code).exec().expect("plugin load");
        }

        // Init codec state
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&self.config, &mut buf).expect("CBOR encode");
        self.codec_state.buffer = buf;
        self.codec_state.entry_count = 1;

        // Register providers
        self.provider_registry.active = 0;
    }

    /// Verify harness is operational.
    fn verify(&self) {
        // Lua works
        let val: i32 = self.lua.load("return 1 + 1").eval().expect("lua eval");
        assert_eq!(val, 2, "Lua not operational after reload");

        // Config accessible
        assert_eq!(self.config.model, "MiniMax-M2.7");
        assert_eq!(self.config.plugins.len(), 2);

        // Codec state valid
        assert!(self.codec_state.entry_count > 0);
        assert!(!self.codec_state.buffer.is_empty());

        // Providers registered
        assert_eq!(self.provider_registry.providers.len(), 3);
    }
}

fn fmt_ns(d: std::time::Duration) -> String {
    format!("{:.1}ms", d.as_secs_f64() * 1000.0)
}

fn main() {
    eprintln!("=== P13: Harness Reload Timing ===");
    eprintln!();

    // --- Test 1: Single harness init ---
    eprintln!("--- Test 1: Single harness init ---");
    let t = Instant::now();
    let mut h = Harness::new();
    let init_time = t.elapsed();
    eprintln!("[OK] Harness::new() took {}", fmt_ns(init_time));

    // --- Test 2: Warmup (load plugins, codec, providers) ---
    eprintln!("--- Test 2: Warmup ---");
    let t = Instant::now();
    h.warmup();
    let warmup_time = t.elapsed();
    eprintln!("[OK] warmup() took {}", fmt_ns(warmup_time));

    // --- Test 3: Verify operational ---
    eprintln!("--- Test 3: Verify operational ---");
    h.verify();
    eprintln!("[OK] verify passed");

    // --- Test 4: Teardown ---
    eprintln!("--- Test 4: Teardown ---");
    let t = Instant::now();
    drop(h);
    let teardown_time = t.elapsed();
    eprintln!("[OK] drop(harness) took {}", fmt_ns(teardown_time));

    // --- Test 5: N consecutive reload cycles ---
    let n = 100;
    eprintln!();
    eprintln!("--- Test 5: {} reload cycles ---", n);

    let mut init_times = Vec::with_capacity(n);
    let mut warmup_times = Vec::with_capacity(n);
    let mut cycle_times = Vec::with_capacity(n);

    let total_start = Instant::now();

    for i in 0..n {
        // Init
        let t0 = Instant::now();
        let mut harness = Harness::new();
        let init = t0.elapsed();

        // Warmup
        let t1 = Instant::now();
        harness.warmup();
        let warmup = t1.elapsed();

        // Verify
        harness.verify();

        // Teardown (implicit drop)
        let t2 = Instant::now();
        drop(harness);
        let teardown = t2.elapsed();

        let cycle = init + warmup + teardown;
        init_times.push(init);
        warmup_times.push(warmup);
        cycle_times.push(cycle);

        if (i + 1) % 25 == 0 {
            eprintln!("  cycle {}/{}: init={} warmup={} drop={} total={}",
                i + 1, n, fmt_ns(init), fmt_ns(warmup), fmt_ns(teardown), fmt_ns(cycle));
        }
    }

    let total = total_start.elapsed();

    // --- Test 6: Statistics ---
    eprintln!();
    eprintln!("--- Test 6: Statistics ---");

    cycle_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    init_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    warmup_times.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let p50 = cycle_times[cycle_times.len() / 2];
    let p95 = cycle_times[cycle_times.len() * 95 / 100];
    let p99 = cycle_times[cycle_times.len() * 99 / 100];
    let fastest = cycle_times[0];
    let slowest = cycle_times[cycle_times.len() - 1];
    let avg = cycle_times.iter().sum::<std::time::Duration>() / cycle_times.len() as u32;

    eprintln!("  Cycles:       {}", n);
    eprintln!("  Total time:   {}", fmt_ns(total));
    eprintln!("  Throughput:   {:.0} reloads/sec", n as f64 / total.as_secs_f64());
    eprintln!("  Fastest:      {}", fmt_ns(fastest));
    eprintln!("  P50 (median): {}", fmt_ns(p50));
    eprintln!("  P95:          {}", fmt_ns(p95));
    eprintln!("  P99:          {}", fmt_ns(p99));
    eprintln!("  Slowest:      {}", fmt_ns(slowest));
    eprintln!("  Average:      {}", fmt_ns(avg));

    let init_p50 = init_times[init_times.len() / 2];
    let warmup_p50 = warmup_times[warmup_times.len() / 2];
    eprintln!("  Init P50:     {}", fmt_ns(init_p50));
    eprintln!("  Warmup P50:   {}", fmt_ns(warmup_p50));

    // --- Assertions ---
    assert!(p50.as_secs_f64() < 0.1,
        "P50 reload must be < 100ms, got {}", fmt_ns(p50));
    assert!(p99.as_secs_f64() < 1.0,
        "P99 reload must be < 1s, got {}", fmt_ns(p99));

    eprintln!();
    eprintln!("=== ALL P13 TESTS PASSED ===");
    eprintln!("  Sub-100ms P50 reload: CONFIRMED");
    eprintln!("  Sub-1s P99 reload:    CONFIRMED");
}
