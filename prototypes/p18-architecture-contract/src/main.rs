//! P18: Architecture-contract prototype for SM-004.

use std::collections::BTreeSet;

type CrateName = &'static str;
type SpecName = &'static str;

type Edge = (CrateName, CrateName, &'static str);

type TypeOwner = (SpecName, SpecName, CrateName, &'static str);

type FeatureOwner = (&'static str, &'static str);

type AsyncBoundary = (CrateName, &'static str, &'static str);

const ARCH_CRATES: &[CrateName] = &[
    "smith",
    "smith-core",
    "smith-ai",
    "smith-tui",
    "smith-harness",
    "smith-cli",
];

const DEPENDENCY_GRAPH: &[Edge] = &[
    ("smith-core", "smith", "Shared types are canonical primitives"),
    ("smith-ai", "smith", "Providers use shared types"),
    ("smith-ai", "smith-core", "Providers consume core sessions/events"),
    ("smith-tui", "smith", "TUI consumes shared data/state types"),
    ("smith-tui", "smith-core", "UI renders events and tools"),
    ("smith-harness", "smith", "Orchestrator owns shared runtime surface"),
    ("smith-harness", "smith-core", "Core session/control stays internal"),
    ("smith-harness", "smith-ai", "Provider orchestration"),
    ("smith-harness", "smith-tui", "Display updates and events"),
    ("smith-cli", "smith-harness", "CLI delegates orchestration"),
];

const FORBIDDEN_DEPENDENCIES: &[(&str, &str, &str)] = &[
    ("smith-cli", "smith-core", "CLI must enter via harness"),
    ("smith-cli", "smith-ai", "Provider logic is not CLI concern"),
    ("smith-cli", "smith-tui", "Rendering is harness-owned in this architecture"),
    ("smith-core", "smith-ai", "Core stays provider-agnostic"),
    ("smith-tui", "smith-ai", "Render layer is not provider layer"),
    ("smith", "smith-core", "Shared layer must not depend upward"),
];

const CANONICAL_TYPE_OWNERSHIP: &[TypeOwner] = &[
    ("SM-005", "Config", "smith", "shared config + error surface"),
    ("SM-005", "LuaRuntime", "smith", "lua runtime bootstrap state"),
    ("SM-005", "SmithError", "smith", "recoverable error model"),
    ("SM-005", "AgentTool", "smith", "tool trait"),
    ("SM-005", "ToolDefinition", "smith", "tool definition schema"),
    ("SM-005", "ProviderRequest", "smith", "request envelope"),
    ("SM-005", "ProviderEvent", "smith", "stream event union"),
    ("SM-005", "ProviderUsage", "smith", "usage counters"),
    ("SM-005", "StopReason", "smith", "loop stop reason"),
    ("SM-006", "Session", "smith-core", "session graph"),
    ("SM-006", "SessionEntry", "smith-core", "record model"),
    ("SM-006", "SessionStore", "smith-core", "session persistence"),
    ("SM-006", "AgentEvent", "smith-core", "agent event model"),
    ("SM-006", "EngineEvent", "smith-core", "engine event model"),
    ("SM-006", "AgentLoopConfig", "smith-core", "loop config model"),
    ("SM-006", "TraceEntry", "smith-core", "trace event model"),
    ("SM-006", "TraceRecorder", "smith-core", "trace lifecycle"),
    ("SM-006", "TraceCodec", "smith-core", "codec model"),
    ("SM-006", "TraceFileHeader", "smith-core", "codec header"),
    ("SM-006", "ReplayEngine", "smith-core", "replay orchestration"),
    ("SM-006", "ReplaySpeed", "smith-core", "speed policy"),
    ("SM-006", "ReplayMode", "smith-core", "replay mode"),
    ("SM-006", "ReplayDiff", "smith-core", "replay comparison"),
    ("SM-007", "Provider", "smith-ai", "provider abstraction"),
    ("SM-007", "ProviderRegistry", "smith-ai", "provider resolution"),
    ("SM-007", "MuxProvider", "smith-ai", "failover + rotation"),
    ("SM-007", "AuthState", "smith-ai", "provider auth contract"),
    ("SM-008", "TuiApp", "smith-tui", "UI app container"),
    ("SM-008", "Theme", "smith-tui", "theme model"),
    ("SM-008", "TuiEvent", "smith-tui", "normalized event type"),
    ("SM-009", "PluginManager", "smith-harness", "plugin lifecycle"),
    ("SM-009", "Plugin", "smith-harness", "plugin metadata"),
    ("SM-009", "Sdk", "smith-harness", "SDK namespace"),
    ("SM-009", "ExtensionContext", "smith-harness", "plugin lifecycle context"),
    ("SM-010", "Cli", "smith-cli", "entry command shape"),
    ("SM-010", "Commands", "smith-cli", "top-level commands"),
];

const PLUGIN_ONLY_USER_FEATURES: &[FeatureOwner] = &[
    ("read", "plugin"),
    ("write", "plugin"),
    ("edit", "plugin"),
    ("bash", "plugin"),
    ("find", "plugin"),
    ("grep", "plugin"),
    ("ls", "plugin"),
    ("/undo", "plugin"),
    ("/redo", "plugin"),
    ("/history", "plugin"),
    ("time-travel", "plugin"),
    ("themes", "plugin"),
    ("keybindings", "plugin"),
    ("default prompts", "plugin"),
    ("ui layout", "plugin"),
];

const ASYNC_BOUNDARIES: &[AsyncBoundary] = &[
    ("smith-core", "tokio rt+sync", "Agent loop + deterministic replay"),
    ("smith-ai", "tokio", "Provider HTTP + stream orchestration"),
    ("smith", "sync", "data-only shared model"),
    ("smith-cli", "sync", "argument parse + bootstrap"),
    ("smith-tui", "sync", "single-threaded render/event loop"),
    ("smith-harness", "sync", "coordination + event dispatch"),
];

fn main() {
    println!("=== P18: Architecture contract ===\n");

    check_crate_graph();
    println!("T1: crate graph validated");

    check_core_ownership();
    println!("T2: core ownership and canonical spec map validated");

    check_plugin_boundary();
    println!("T3: plugin-only feature model validated");

    check_async_boundaries();
    println!("T4: async boundary model validated\n");

    println!("=== ALL P18 TESTS PASSED ===");
}

fn check_crate_graph() {
    assert_eq!(ARCH_CRATES.len(), 6);
    for edge in DEPENDENCY_GRAPH {
        assert!(ARCH_CRATES.contains(&edge.0));
        assert!(ARCH_CRATES.contains(&edge.1));
        assert!(!edge.0.is_empty());
        assert!(!edge.1.is_empty());
        assert!(!edge.2.is_empty());
    }

    for (a, b, reason) in FORBIDDEN_DEPENDENCIES {
        assert!(!has_dependency(a, b), "forbidden dependency {a} -> {b}: {reason}");
    }

    assert!(has_dependency("smith-core", "smith"));
    assert!(has_dependency("smith-ai", "smith"));
    assert!(has_dependency("smith-harness", "smith-core"));
    assert!(has_dependency("smith-harness", "smith-ai"));
    assert!(has_dependency("smith-harness", "smith-tui"));
    assert!(has_dependency("smith-cli", "smith-harness"));

    let expected_edges = BTreeSet::from([
        "smith-core->smith",
        "smith-ai->smith",
        "smith-ai->smith-core",
        "smith-tui->smith",
        "smith-tui->smith-core",
        "smith-harness->smith",
        "smith-harness->smith-core",
        "smith-harness->smith-ai",
        "smith-harness->smith-tui",
        "smith-cli->smith-harness",
    ]);
    for edge in DEPENDENCY_GRAPH {
        let key = format!("{}->{}", edge.0, edge.1);
        assert!(expected_edges.contains(key.as_str()), "unexpected edge {key}");
    }
}

fn has_dependency(from: &str, to: &str) -> bool {
    DEPENDENCY_GRAPH.iter().any(|e| e.0 == from && e.1 == to)
}

fn check_core_ownership() {
    assert!(!CANONICAL_TYPE_OWNERSHIP.is_empty());

    let mut specs = BTreeSet::new();
    let mut by_crate = BTreeSet::new();
    let mut symbols = BTreeSet::new();

    for item in CANONICAL_TYPE_OWNERSHIP {
        let (spec, symbol, owner, note) = *item;
        specs.insert(spec);
        by_crate.insert(owner);
        symbols.insert(symbol);

        assert!(!spec.is_empty());
        assert!(!symbol.is_empty());
        assert!(!owner.is_empty());
        assert!(!note.is_empty());

        match symbol {
            "Config" | "LuaRuntime" | "SmithError" | "AgentTool" | "ToolDefinition" | "ProviderRequest" | "ProviderEvent" | "ProviderUsage" | "StopReason"
                => assert_eq!(owner, "smith"),
            "Session" | "SessionEntry" | "SessionStore" | "AgentEvent" | "EngineEvent" | "AgentLoopConfig" | "TraceEntry" | "TraceRecorder" | "TraceCodec" | "TraceFileHeader" | "ReplayEngine" | "ReplaySpeed" | "ReplayMode" | "ReplayDiff"
                => assert_eq!(owner, "smith-core"),
            "Provider" | "ProviderRegistry" | "MuxProvider" | "AuthState"
                => assert_eq!(owner, "smith-ai"),
            "TuiApp" | "Theme" | "TuiEvent"
                => assert_eq!(owner, "smith-tui"),
            "PluginManager" | "Plugin" | "Sdk" | "ExtensionContext"
                => assert_eq!(owner, "smith-harness"),
            "Cli" | "Commands"
                => assert_eq!(owner, "smith-cli"),
            _ => {}
        }
    }

    assert!(specs.contains("SM-005") || specs.contains("SM-005"));
    assert!(specs.contains("SM-006"));
    assert!(specs.contains("SM-007"));
    assert!(specs.contains("SM-008"));
    assert!(specs.contains("SM-009"));
    assert!(specs.contains("SM-010"));

    let unique_symbols = symbols.len();
    assert!(unique_symbols > 20, "insufficient canonical surface for contract: {unique_symbols}");
    assert!(by_crate.contains("smith") && by_crate.contains("smith-core") && by_crate.contains("smith-ai") && by_crate.contains("smith-tui") && by_crate.contains("smith-harness") && by_crate.contains("smith-cli"));
}

fn check_plugin_boundary() {
    for (feature, owner) in PLUGIN_ONLY_USER_FEATURES {
        assert!(!feature.is_empty());
        assert_eq!(*owner, "plugin", "feature '{feature}' must remain plugin-only");
    }
}

fn check_async_boundaries() {
    let sync_only = BTreeSet::from(["smith", "smith-cli", "smith-tui", "smith-harness"]);
    let async_enabled: BTreeSet<_> = ASYNC_BOUNDARIES.iter()
        .filter(|(_, mode, _)| *mode != "sync")
        .map(|(name, _, _)| *name)
        .collect();

    for crate_name in ARCH_CRATES {
        if sync_only.contains(crate_name) {
            assert!(ASYNC_BOUNDARIES.iter().any(|(name, mode, _)| name == crate_name && *mode == "sync"));
        }
    }

    for crate_name in async_enabled {
        assert!(matches!(crate_name, "smith-core" | "smith-ai"));
    }

    for &(crate_name, mode, _) in ASYNC_BOUNDARIES {
        assert_eq!(mode != "sync", crate_name == "smith-core" || crate_name == "smith-ai");
    }
}
