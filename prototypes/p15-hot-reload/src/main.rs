//! Prototype P15: Hot Reload per SM-009 Plugin System.
//!
//! Tests:
//! 1. Load Lua plugin v1 — registers tool_call_transform hook → "[v1] result"
//! 2. Simulated agent loop calls hooks, gets correct v1 behavior
//! 3. Hot reload: load v2 Lua plugin — registers new hook → "[v2] result"
//! 4. Validate v2: check hook signature correctness
//! 5. Atomic hook swap: old hooks replaced, session preserved
//! 6. Agent loop continues with v2 behavior
//! 7. Rollback: load v3 (bad Lua syntax) → validation fails → old hooks restored
//! 8. Rollback: load v4 (missing hook) → validation fails → old hooks restored
//! 9. Trace recording: PluginLoaded, PluginEvent, PluginError events captured
//! 10. Multiple reloads: 10 consecutive hot-swaps, session state preserved

#![allow(missing_docs, unused_variables, dead_code)]

use std::collections::HashMap;
use mlua::Lua;
use serde::{Deserialize, Serialize};

// === Types ===

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PluginTraceEvent {
    pub timestamp_ns: u64,
    pub kind: String,       // "PluginLoaded", "PluginEvent", "PluginError"
    pub plugin: String,
    pub detail: String,
    pub success: bool,
}

/// Represents a plugin's registered hook (stored as Lua closure reference).
struct HookEntry {
    name: String,
    lua_fn_name: String,
    version: String,
}

/// Plugin state — holds Lua instance + registered hooks.
struct PluginInstance {
    lua: Lua,
    hooks: HashMap<String, HookEntry>,
    version: String,
}

/// Session state that persists across reloads.
#[derive(Clone, Debug)]
struct SessionState {
    message_count: u32,
    turns_completed: u32,
    last_model: String,
    workspace: String,
}

/// The harness — manages plugin lifecycle + session.
struct PluginHarness {
    current: Option<PluginInstance>,
    session: SessionState,
    trace: Vec<PluginTraceEvent>,
    ts_counter: u64,
}

impl PluginHarness {
    fn new(workspace: &str) -> Self {
        Self {
            current: None,
            session: SessionState {
                message_count: 0,
                turns_completed: 0,
                last_model: "MiniMax-M2.7".into(),
                workspace: workspace.into(),
            },
            trace: Vec::new(),
            ts_counter: 1000,
        }
    }

    fn now_ns(&mut self) -> u64 {
        self.ts_counter += 1;
        self.ts_counter
    }

    fn trace_event(&mut self, kind: &str, plugin: &str, detail: &str, success: bool) {
        self.trace.push(PluginTraceEvent {
            timestamp_ns: self.ts_counter,
            kind: kind.into(),
            plugin: plugin.into(),
            detail: detail.into(),
            success,
        });
    }

    /// Load a Lua plugin. Returns Ok(()) on success, Err on failure.
    fn load_plugin(&mut self, name: &str, lua_code: &str) -> Result<(), String> {
        let lua = Lua::new();

        // Phase 1: Load — execute Lua code
        if let Err(e) = lua.load(lua_code).exec() {
            let ts = self.now_ns();
            self.trace_event("PluginError", name, &format!("syntax error: {}", e), false);
            return Err(format!("Lua exec error: {}", e));
        }

        // Phase 2: Validate — check that expected hooks exist
        let required_hooks = ["tool_call_transform", "context_transform"];
        let mut hooks = HashMap::new();
        for hook in &required_hooks {
            let check: mlua::Result<bool> = lua.load(&format!(
                "return type({}) == 'function'", hook
            )).eval();
            match check {
                Ok(true) => {
                    hooks.insert(hook.to_string(), HookEntry {
                        name: hook.to_string(),
                        lua_fn_name: hook.to_string(),
                        version: name.to_string(),
                    });
                },
                Ok(false) => {
                    let ts = self.now_ns();
                    self.trace_event("PluginError", name, &format!("missing hook: {}", hook), false);
                    return Err(format!("Missing hook: {}", hook));
                },
                Err(e) => {
                    let ts = self.now_ns();
                    self.trace_event("PluginError", name, &format!("validation error: {}", e), false);
                    return Err(format!("Hook check error: {}", e));
                },
            }
        }

        // Phase 3: Register — store hooks (atomically replace old)
        let ts = self.now_ns();
        self.trace_event("PluginLoaded", name, &format!("hooks={}", hooks.len()), true);

        let instance = PluginInstance {
            lua,
            hooks,
            version: name.to_string(),
        };
        self.current = Some(instance);

        // Phase 4: Activate — fire event
        let ts = self.now_ns();
        self.trace_event("PluginEvent", name, "activated", true);

        Ok(())
    }

    /// Hot reload: load new plugin, validate, swap atomically. On failure, keep old.
    fn hot_reload(&mut self, name: &str, lua_code: &str) -> Result<(), String> {
        // Save old plugin for rollback
        let old = self.current.take();
        let old_version = old.as_ref().map(|o| o.version.clone()).unwrap_or_default();

        match self.load_plugin(name, lua_code) {
            Ok(()) => {
                let ts = self.now_ns();
                self.trace_event("PluginEvent", name, &format!("replaced {}", old_version), true);
                Ok(())
            },
            Err(e) => {
                // Rollback: restore old plugin
                self.current = old;
                let ts = self.now_ns();
                self.trace_event("PluginEvent", name, &format!("rollback to {}", old_version), false);
                Err(e)
            },
        }
    }

    /// Call tool_call_transform hook. Returns the transformed result.
    fn call_tool_hook(&mut self, tool_name: &str, args: &str) -> Result<String, String> {
        match &self.current {
            Some(inst) => {
                let lua = &inst.lua;
                let result: String = lua.load(&format!(
                    "return tool_call_transform('{}', '{}')",
                    tool_name, args
                )).eval().map_err(|e| format!("hook error: {}", e))?;
                Ok(result)
            },
            None => Err("no plugin loaded".into()),
        }
    }

    /// Call context_transform hook.
    fn call_context_hook(&mut self, context: &str) -> Result<String, String> {
        match &self.current {
            Some(inst) => {
                let result: String = inst.lua.load(&format!(
                    "return context_transform('{}')", context
                )).eval().map_err(|e| format!("hook error: {}", e))?;
                Ok(result)
            },
            None => Err("no plugin loaded".into()),
        }
    }

    /// Simulate an agent turn.
    fn simulate_turn(&mut self, user_msg: &str) {
        self.session.message_count += 1;
        self.session.last_model = "MiniMax-M2.7".into();

        // Call hooks
        let tool_result = self.call_tool_hook("bash", user_msg).unwrap_or_else(|e| format!("[hook error: {}]", e));
        let context_result = self.call_context_hook("default").unwrap_or_else(|e| format!("[hook error: {}]", e));

        self.session.turns_completed += 1;
    }

    /// Get current plugin version.
    fn current_version(&self) -> &str {
        self.current.as_ref().map(|c| c.version.as_str()).unwrap_or("none")
    }
}

// === Lua plugin code generators ===

fn plugin_v1() -> &'static str {
    r#"
        function tool_call_transform(tool_name, args)
            return "[v1] " .. args
        end

        function context_transform(ctx)
            return "[v1] ctx=" .. ctx
        end
    "#
}

fn plugin_v2() -> &'static str {
    r#"
        function tool_call_transform(tool_name, args)
            return "[v2] " .. args .. " (enhanced)"
        end

        function context_transform(ctx)
            return "[v2] ctx=" .. ctx .. " (enhanced)"
        end
    "#
}

fn plugin_v3_bad_syntax() -> &'static str {
    r#"
        function tool_call_transform(tool_name, args)
            return "[v3] " .. args
        -- MISSING CLOSING: syntax error
    "#
}

fn plugin_v4_missing_hook() -> &'static str {
    r#"
        function tool_call_transform(tool_name, args)
            return "[v4] " .. args
        end
        -- context_transform is MISSING
    "#
}

fn plugin_v5() -> &'static str {
    r#"
        function tool_call_transform(tool_name, args)
            return "[v5] processed: " .. args
        end

        function context_transform(ctx)
            return "[v5] context: " .. ctx
        end
    "#
}

// === Tests ===

fn main() {
    eprintln!("=== P15: Hot Reload ===");
    eprintln!();

    // --- Test 1: Load v1 plugin ---
    eprintln!("--- Test 1: Load v1 plugin ---");
    let mut harness = PluginHarness::new("/tmp/smith");
    harness.load_plugin("v1", plugin_v1()).expect("v1 load");
    assert_eq!(harness.current_version(), "v1");
    eprintln!("[OK] v1 loaded, version={}", harness.current_version());

    // --- Test 2: Agent loop with v1 ---
    eprintln!("--- Test 2: Agent loop with v1 ---");
    let r1 = harness.call_tool_hook("bash", "ls -la").expect("v1 hook");
    assert!(r1.starts_with("[v1]"), "v1 hook should prepend [v1], got: {}", r1);
    eprintln!("[OK] v1 tool_hook: {}", r1);

    let c1 = harness.call_context_hook("default").expect("v1 ctx");
    assert!(c1.contains("[v1]"), "v1 context should contain [v1]");
    eprintln!("[OK] v1 context_hook: {}", c1);

    harness.simulate_turn("hello");
    assert_eq!(harness.session.turns_completed, 1);
    eprintln!("[OK] turn 1 complete, session.turns={}", harness.session.turns_completed);

    // --- Test 3: Hot reload to v2 ---
    eprintln!("--- Test 3: Hot reload to v2 ---");
    harness.hot_reload("v2", plugin_v2()).expect("v2 reload");
    assert_eq!(harness.current_version(), "v2");
    eprintln!("[OK] v2 loaded, version={}", harness.current_version());

    // --- Test 4: Validate v2 hook signatures ---
    eprintln!("--- Test 4: Validate v2 hooks ---");
    let r2 = harness.call_tool_hook("bash", "cargo test").expect("v2 hook");
    assert!(r2.starts_with("[v2]"), "v2 hook should prepend [v2], got: {}", r2);
    assert!(r2.contains("(enhanced)"), "v2 should contain (enhanced)");
    eprintln!("[OK] v2 tool_hook: {}", r2);

    let c2 = harness.call_context_hook("user").expect("v2 ctx");
    assert!(c2.contains("[v2]") && c2.contains("(enhanced)"));
    eprintln!("[OK] v2 context_hook: {}", c2);

    // --- Test 5: Session preserved across reload ---
    eprintln!("--- Test 5: Session preserved ---");
    harness.simulate_turn("world");
    assert_eq!(harness.session.turns_completed, 2);
    assert_eq!(harness.session.message_count, 2);
    assert_eq!(harness.session.workspace, "/tmp/smith");
    eprintln!("[OK] session preserved: turns={}, msgs={}, workspace={}",
        harness.session.turns_completed, harness.session.message_count, harness.session.workspace);

    // --- Test 6: Agent loop continues with v2 ---
    eprintln!("--- Test 6: Agent loop continues with v2 ---");
    let r2b = harness.call_tool_hook("grep", "TODO").expect("v2 hook again");
    assert!(r2b.starts_with("[v2]"), "Should still be v2");
    eprintln!("[OK] Still v2 after turn: {}", r2b);

    // --- Test 7: Rollback on bad syntax (v3) ---
    eprintln!("--- Test 7: Rollback on bad syntax ---");
    let result = harness.hot_reload("v3", plugin_v3_bad_syntax());
    assert!(result.is_err(), "v3 should fail to load");
    assert_eq!(harness.current_version(), "v2", "Should rollback to v2");
    eprintln!("[OK] v3 rejected, rolled back to {}", harness.current_version());

    // Verify v2 hooks still work after rollback
    let r_after = harness.call_tool_hook("bash", "test").expect("v2 after rollback");
    assert!(r_after.starts_with("[v2]"), "v2 should work after rollback");
    eprintln!("[OK] v2 hooks work after rollback: {}", r_after);

    // --- Test 8: Rollback on missing hook (v4) ---
    eprintln!("--- Test 8: Rollback on missing hook ---");
    let result = harness.hot_reload("v4", plugin_v4_missing_hook());
    assert!(result.is_err(), "v4 should fail (missing context_transform)");
    assert_eq!(harness.current_version(), "v2", "Should still be v2");
    eprintln!("[OK] v4 rejected (missing hook), rolled back to {}", harness.current_version());

    // --- Test 9: Trace events recorded ---
    eprintln!("--- Test 9: Trace events ---");
    let trace = &harness.trace;
    eprintln!("[OK] {} trace events recorded", trace.len());

    let loaded_count = trace.iter().filter(|e| e.kind == "PluginLoaded" && e.success).count();
    let error_count = trace.iter().filter(|e| e.kind == "PluginError").count();
    let event_count = trace.iter().filter(|e| e.kind == "PluginEvent").count();

    eprintln!("  PluginLoaded: {}", loaded_count);
    eprintln!("  PluginError: {}", error_count);
    eprintln!("  PluginEvent: {}", event_count);

    // v1 + v2 loaded = 2 PluginLoaded
    assert!(loaded_count >= 2, "Should have >=2 PluginLoaded events, got {}", loaded_count);
    // v3 syntax error + v4 missing hook = 2 PluginError
    assert!(error_count >= 2, "Should have >=2 PluginError events, got {}", error_count);

    // Check error details
    for e in trace.iter().filter(|e| e.kind == "PluginError") {
        eprintln!("  error: plugin={} detail={}", e.plugin, e.detail);
        assert!(!e.success);
    }

    // Check rollback events
    let rollback_events: Vec<_> = trace.iter()
        .filter(|e| e.kind == "PluginEvent" && e.detail.contains("rollback"))
        .collect();
    assert_eq!(rollback_events.len(), 2, "Should have 2 rollback events (v3 + v4)");
    eprintln!("[OK] 2 rollback events confirmed");

    // --- Test 10: Multiple consecutive reloads ---
    eprintln!("--- Test 10: 10 consecutive reloads ---");
    let initial_turns = harness.session.turns_completed;
    let trace_before = trace.len();

    for i in 0..10 {
        let code = if i % 2 == 0 { plugin_v2() } else { plugin_v5() };
        let name = if i % 2 == 0 { "v2" } else { "v5" };
        harness.hot_reload(name, code).expect(&format!("reload {}", i));
        harness.simulate_turn(&format!("msg-{}", i));
    }

    assert_eq!(harness.session.turns_completed, initial_turns + 10);
    eprintln!("[OK] 10 reloads completed, turns: {} → {}",
        initial_turns, harness.session.turns_completed);

    // Last loaded should be v5 (odd index 9)
    assert_eq!(harness.current_version(), "v5");
    let r5 = harness.call_tool_hook("bash", "final").expect("v5 hook");
    assert!(r5.starts_with("[v5]"), "Should be v5, got: {}", r5);
    eprintln!("[OK] Final version: {} ({})", harness.current_version(), r5);

    // Trace should have grown
    let trace_after = harness.trace.len();
    assert!(trace_after > trace_before, "Trace should grow with reloads");
    eprintln!("[OK] Trace grew: {} → {} events", trace_before, trace_after);

    eprintln!();
    eprintln!("=== ALL P15 TESTS PASSED ===");
    eprintln!("  Hot reload: v1→v2→rollback(v3)→rollback(v4)→10 cycles");
    eprintln!("  Session preserved across all reloads");
    eprintln!("  Trace: {} events recorded", harness.trace.len());
}
