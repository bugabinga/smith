//! P19: CLI smoke prototype for SM-010.

use clap::{Parser, Subcommand, ValueEnum};
use serde_json::json;

const EXPECTED_SUBCOMMANDS: &[&str] = &[
    "new",
    "attach",
    "continue",
    "resume",
    "session",
    "plugins",
    "install",
    "uninstall",
    "eval",
    "rpc",
    "help",
    "replay",
];

#[derive(Parser, Debug)]
#[command(name = "smith", about = "AI coding agent", disable_help_subcommand = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Override default model
    #[arg(long, global = true)]
    model: Option<String>,

    /// Override default provider
    #[arg(long, global = true)]
    provider: Option<String>,

    /// Specify session directly
    #[arg(long, global = true)]
    session: Option<String>,

    /// Custom config path
    #[arg(long, global = true)]
    config: Option<String>,

    /// Disable user config
    #[arg(long, global = true)]
    no_config: bool,
}

#[derive(Subcommand, Debug, PartialEq)]
enum Commands {
    /// Create new interactive session with a name
    New { name: String },

    /// Attach to existing session
    Attach { session: Option<String> },

    /// Continue last session in current directory
    Continue,

    /// Fuzzy select session to resume
    Resume,

    /// Session management commands
    Session {
        /// list or dump
        #[arg(value_enum)]
        action: SessionAction,

        /// Filter to current working directory
        #[arg(long)]
        cwd: bool,

        /// Session id or name (defaults to latest, used by dump)
        id: Option<String>,

        /// Only dump last N entries
        #[arg(long)]
        last: Option<usize>,

        /// Write output to file instead of stdout
        #[arg(long)]
        output: Option<String>,
    },

    /// List plugins
    Plugins,

    /// Install a plugin
    Install { plugin: String },

    /// Uninstall a plugin
    Uninstall { plugin: String },

    /// Evaluate a prompt (non-interactive)
    Eval {
        prompt: String,

        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// JSON-RPC via stdio
    Rpc,

    /// Browse documentation
    Help {
        topic: Option<String>,

        /// Fuzzy search documentation
        #[arg(long)]
        search: Option<String>,

        /// List all topics
        #[arg(long)]
        list: bool,

        /// List examples
        #[arg(long)]
        examples: bool,

        /// Show specific example
        #[arg(long)]
        example: Option<String>,

        /// Show specific guide
        #[arg(long)]
        guide: Option<String>,
    },

    /// Replay a session from trace log
    Replay {
        /// Session id or name
        session: String,

        /// Replay speed multiplier (1.0 = real-time, 0 = max speed)
        #[arg(long, default_value = "1.0")]
        speed: f64,

        /// Compare mode: re-execute tools and diff outputs
        #[arg(long)]
        compare: bool,

        /// Sandbox directory for compare mode
        #[arg(long)]
        sandbox: Option<String>,

        /// Stop after N turns (0 = full replay)
        #[arg(long)]
        turns: Option<usize>,

        /// Start from turn N (0 = from beginning)
        #[arg(long, default_value = "0")]
        from_turn: usize,

        /// Output format: text, json, summary
        #[arg(long, default_value = "text")]
        format: String,

        /// Continue on diff failures in compare mode
        #[arg(long, default_value = "true")]
        continue_on_diff: bool,
    },
}

#[derive(ValueEnum, Clone, Debug, PartialEq)]
enum SessionAction {
    List,
    Dump,
}

#[derive(Debug, PartialEq)]
enum ReplaySpeed {
    Max,
    Multiplier(f64),
}

fn main() {
    println!("=== P19: CLI smoke tests ===\n");

    let mut passed = 0usize;
    let mut failures_expected = 0usize;

    assert_case("default", &"smith", |cli| {
        assert!(cli.command.is_none());
        assert!(cli.model.is_none());
    });
    passed += 1;

    assert_case("new", &"smith new workspace", |cli| {
        match cli.command {
            Some(Commands::New { name }) => assert_eq!(name, "workspace"),
            other => panic!("expected New, got {other:?}"),
        }
    });
    passed += 1;

    assert_case("attach", &"smith attach", |cli| {
        match cli.command {
            Some(Commands::Attach { session }) => assert!(session.is_none()),
            other => panic!("expected Attach, got {other:?}"),
        }
    });
    passed += 1;

    assert_case("continue", &"smith continue", |cli| {
        assert!(matches!(cli.command, Some(Commands::Continue)));
    });
    passed += 1;

    assert_case("resume", &"smith resume", |cli| {
        assert!(matches!(cli.command, Some(Commands::Resume)));
    });
    passed += 1;

    assert_case("session_list", &"smith session list", |cli| {
        match cli.command {
            Some(Commands::Session { action, cwd, .. }) => {
                assert!(matches!(action, SessionAction::List));
                assert!(!cwd);
            }
            _ => panic!("expected session list"),
        }
    });
    passed += 1;

    assert_case("session_dump", &"smith session dump", |cli| {
        match cli.command {
            Some(Commands::Session {
                action,
                id,
                last,
                output,
                ..
            }) => {
                assert!(matches!(action, SessionAction::Dump));
                assert!(id.is_none());
                assert!(last.is_none());
                assert!(output.is_none());
            }
            _ => panic!("expected session dump"),
        }
    });
    passed += 1;

    assert_case("plugins", &"smith plugins", |cli| {
        assert!(matches!(cli.command, Some(Commands::Plugins)));
    });
    passed += 1;

    assert_case("install", &"smith install plugin://fmt", |cli| {
        match cli.command {
            Some(Commands::Install { plugin }) => assert_eq!(plugin, "plugin://fmt"),
            _ => panic!("expected install"),
        }
    });
    passed += 1;

    assert_case("uninstall", &"smith uninstall plugin://fmt", |cli| {
        match cli.command {
            Some(Commands::Uninstall { plugin }) => assert_eq!(plugin, "plugin://fmt"),
            _ => panic!("expected uninstall"),
        }
    });
    passed += 1;

    assert_case("eval", &"smith eval say-hello", |cli| {
        match cli.command {
            Some(Commands::Eval { prompt, json }) => {
                assert_eq!(prompt, "say-hello");
                assert!(!json);
            }
            _ => panic!("expected eval"),
        }
    });
    passed += 1;

    assert_case("eval_json", &"smith eval --json say-hello", |cli| {
        match cli.command {
            Some(Commands::Eval { prompt, json }) => {
                assert_eq!(prompt, "say-hello");
                assert!(json);
                let output = json!({"command":"eval","prompt":prompt,"json":json}).to_string();
                assert!(output.contains("\"json\":true"));
            }
            _ => panic!("expected eval json"),
        }
    });
    passed += 1;

    assert_case("rpc", &"smith rpc", |cli| {
        assert!(matches!(cli.command, Some(Commands::Rpc)));
    });
    passed += 1;

    assert_case("help", &"smith help topics", |cli| {
        match cli.command {
            Some(Commands::Help {
                topic,
                search,
                list,
                examples,
                example,
                guide,
            }) => {
                assert_eq!(topic.as_deref(), Some("topics"));
                assert!(search.is_none() && !list && !examples && example.is_none() && guide.is_none());
            }
            _ => panic!("expected help"),
        }
    });
    passed += 1;

    assert_case("replay_default_speed", &"smith replay abc123", |cli| {
        match cli.command {
            Some(Commands::Replay { speed, .. }) => {
                assert_eq!(speed, 1.0);
                assert_eq!(normalize_speed(speed), ReplaySpeed::Multiplier(1.0));
            }
            _ => panic!("expected replay"),
        }
    });
    passed += 1;

    assert_case("replay_max_speed", &"smith replay abc123 --speed 0", |cli| {
        match cli.command {
            Some(Commands::Replay { speed, .. }) => {
                assert_eq!(normalize_speed(speed), ReplaySpeed::Max);
            }
            _ => panic!("expected replay"),
        }
    });
    passed += 1;

    assert_case("global_after_subcommand", &"smith new demo --model qwen --provider p --session s1 --config cfg.toml --no-config", |cli| {
        assert_eq!(cli.model.as_deref(), Some("qwen"));
        assert_eq!(cli.provider.as_deref(), Some("p"));
        assert_eq!(cli.session.as_deref(), Some("s1"));
        assert_eq!(cli.config.as_deref(), Some("cfg.toml"));
        assert!(cli.no_config);
    });
    passed += 1;

    assert_case("global_before_subcommand", &"smith --model llama --provider local new demo", |cli| {
        assert_eq!(cli.model.as_deref(), Some("llama"));
        assert_eq!(cli.provider.as_deref(), Some("local"));
        match cli.command {
            Some(Commands::New { name }) => assert_eq!(name, "demo"),
            _ => panic!("expected global before subcommand"),
        }
    });
    passed += 1;

    assert_err("slash_command_is_not_subcommand", &"smith /undo");
    failures_expected += 1;

    for cmd in EXPECTED_SUBCOMMANDS {
        assert!(!cmd.is_empty());
    }

    println!("Parsed and validated {passed} success paths");
    println!("Observed {failures_expected} expected failure paths\n");
    println!("=== ALL P19 TESTS PASSED ===");
}

fn parse_cli(input: &str) -> Result<Cli, String> {
    Cli::try_parse_from(input.split_whitespace()).map_err(|err| err.to_string())
}

fn assert_case(label: &str, input: &str, check: impl FnOnce(Cli)) {
    println!("T case {label}");
    match parse_cli(input) {
        Ok(cli) => check(cli),
        Err(err) => panic!("[{label}] parse failed: {err}"),
    }
}

fn assert_err(label: &str, input: &str) {
    println!("T case {label}");
    assert!(parse_cli(input).is_err(), "expected parse error for {label}");
}

fn normalize_speed(raw: f64) -> ReplaySpeed {
    if raw <= 0.0 {
        ReplaySpeed::Max
    } else {
        ReplaySpeed::Multiplier(raw)
    }
}
