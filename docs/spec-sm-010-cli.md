# SM-010: smith-cli/ — Binary Entry Point

Create the `smith-cli/` binary crate with CLI interface and subcommands.

## Context

User-facing binary. Depends on smith-harness/ (SM-009).
Entry point for all smith usage.

## Key Design Decisions (from CLI discussion)

1. **Default mode** — `smith` (no subcommand) starts interactive TUI with new session (auto name)
2. **`smith new <name>`** — interactive TUI with named session
3. **`smith attach [id-or-name]`** — attach to existing session (fuzzy select if no arg)
4. **`smith continue`** — continue last session in cwd
5. **`smith resume`** — fuzzy select session in cwd, then interactive
6. **`smith session list`** — list sessions
   **`smith session dump [id]`** — dump session as JSONL
7. **`smith plugins`** — list plugins
8. **`smith install <plugin>`** — install plugin
9. **`smith uninstall <plugin>`** — uninstall plugin
10. **`smith eval <prompt>`** — print response (no TUI)
11. **`smith eval <prompt> --json`** — output as JSON
12. **`smith eval --session <id>`** — attach to session for eval
13. **`smith rpc`** — JSON-RPC via stdio
14. **`smith help [topic]`** — documentation browser
15. **Global flags:** `--model`, `--provider`, `--session`, `--config`, `--no-config`

## Deliverables

### 1. `smith-cli/Cargo.toml`

```toml
[package]
name = "smith-cli"
version = "0.1.0"
edition = "2024"

[[bin]]
name = "smith"
path = "src/main.rs"

[dependencies]
smith-harness = { path = "../smith-harness" }
smith = { path = "../smith" }
clap = { workspace = true, features = ["derive"] }
tokio = { workspace = true, features = ["full"] }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
```

### 2. CLI Definition (clap)

```rust
#[derive(Parser)]
#[command(name = "smith", about = "AI coding agent")]
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
    config: Option<PathBuf>,

    /// Disable user config
    #[arg(long, global = true)]
    no_config: bool,
}

#[derive(Subcommand)]
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
        #[command(subcommand)]
        action: SessionCommands,
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
}
```

```rust
#[derive(Subcommand)]
enum SessionCommands {
    /// List all sessions
    List {
        /// Filter to current working directory
        #[arg(long)]
        cwd: bool,
    },

    /// Dump session entries as JSONL
    Dump {
        /// Session id or name (defaults to latest)
        id: Option<String>,

        /// Only dump last N entries
        #[arg(long)]
        last: Option<usize>,

        /// Write output to file instead of stdout
        #[arg(long)]
        output: Option<PathBuf>,
    },
}
```

### 3. Main Entry Point

```rust
#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None => run_interactive(None, &cli).await,
        Some(Commands::New { name }) => run_interactive(Some(&name), &cli).await,
        Some(Commands::Attach { session }) => run_attach(session, &cli).await,
        Some(Commands::Continue) => run_continue(&cli).await,
        Some(Commands::Resume) => run_resume(&cli).await,
        Some(Commands::Session { action }) => run_session(action, &cli).await,
        Some(Commands::Plugins) => list_plugins(&cli).await,
        Some(Commands::Install { plugin }) => install_plugin(&plugin, &cli).await,
        Some(Commands::Uninstall { plugin }) => uninstall_plugin(&plugin, &cli).await,
        Some(Commands::Eval { prompt, json }) => run_eval(&prompt, json, &cli).await,
        Some(Commands::Rpc) => run_rpc(&cli).await,
        Some(Commands::Help { topic, search, list, examples, example, guide }) => {
            run_help(topic, search, list, examples, example, guide)
        }
    }
}
```

### 4. Subcommand Implementations

Each subcommand:
- Resolves global flags (--model, --provider, etc.)
- Creates Harness instance
- Runs appropriate mode

`run_interactive` — starts TUI app
`run_eval` — no TUI, prints to stdout
`run_rpc` — JSON-RPC loop on stdin/stdout
`run_session` — list sessions or dump session entries as JSONL
`run_help` — reads embedded docs, fuzzy search with SelectList

`run_session` resolves the session id (latest if not provided), reads entries via `SessionStore`, and formats `Dump` as JSONL.

## Tests

- CLI parsing: all subcommands parse correctly
- CLI parsing: global flags work with any subcommand
- Default mode starts interactive session
- `smith eval "hello"` outputs text
- `smith eval --json "hello"` outputs valid JSON
- `smith help tools` outputs tool documentation
- `smith help --search "provider"` finds provider docs
- `smith session list` lists all sessions
- `smith session list --cwd` filters to current directory
- `smith session dump` dumps latest session as JSONL
- `smith session dump <id>` dumps specific session
- `smith session dump --last 5` limits to last 5 entries
- `smith session dump --output out.jsonl` writes to file
- `smith --no-config` skips config loading

## Steps

- [ ] Create `smith-cli/Cargo.toml`
- [ ] Create `smith-cli/src/main.rs` with clap CLI definition
- [ ] Implement subcommand dispatch
- [ ] Implement `run_interactive` (TUI mode)
- [ ] Implement `run_eval` (print mode)
- [ ] Implement `run_rpc` (JSON-RPC stdio)
- [ ] Implement `run_attach`, `run_continue`, `run_resume`
- [ ] Implement `run_session` (list / dump)
- [ ] Implement `list_plugins`
- [ ] Implement `install_plugin`, `uninstall_plugin`
- [ ] Implement `run_help` (embedded doc browser)
- [ ] Wire up global flags
- [ ] Write tests
- [ ] Verify: `cargo check -p smith-cli`
- [ ] Test: `cargo test -p smith-cli`
- [ ] Commit: `jj describe -m "feat(SM-010): smith-cli — binary with subcommands"`
