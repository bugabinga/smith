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
15. **`smith replay <session-id>`** — replay session from trace log
16. **`smith replay <session-id> --speed 2`** — replay at 2x speed
17. **`smith replay <session-id> --compare`** — compare old vs new tool outputs
18. **Global flags:** `--model`, `--provider`, `--session`, `--config`, `--no-config`
19. **Interactive slash commands are Lua plugins** — `/undo`, `/redo`, and `/history` are registered by built-in Lua plugins, not clap subcommands

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

        /// Sandbox directory for compare mode (must match original CWD structure)
        #[arg(long)]
        sandbox: Option<PathBuf>,

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
        Some(Commands::Replay { session, speed, compare, sandbox, turns, from_turn, format, continue_on_diff }) => {
            run_replay(&session, speed, compare, sandbox, turns, from_turn, &format, continue_on_diff, &cli).await
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

`run_replay` — replays a session from its trace log using `ReplayEngine` (SM-006 §13.7):
1. Resolve session id via `SessionStore`
2. Load trace file from `{data_dir}/sessions/{id}.trace`
3. Convert speed flag: `speed == 0.0` → `ReplaySpeed::Max`, `speed == 1.0` → `ReplaySpeed::RealTime`, else `ReplaySpeed::Factor(speed)`
4. Create `ReplayEngine::from_file` with resolved speed and mode
5. Run replay loop:
   - Each entry → `ReplayStep` → formatted output to stdout
   - Speed control: max (no delays), real-time, or factor (N× speed)
   - Progress indicator: `[42/187] Turn 3 — ToolResult(bash)`
6. In compare mode (`--compare`):
   - Intercept `ToolEnd` entries → re-execute tool in sandbox directory
   - Compare result hash vs original → emit `ReplayDiff` if different
   - Continue or stop on diff based on `--continue-on-diff` flag
7. Output formats:
   - Default: human-readable step-by-step log
   - `--format json`: JSONL stream of `ReplayStep` objects
   - `--format summary`: only final `ReplaySummary`
8. On completion, print `ReplaySummary` (total entries, diffs, regressions)

Compare mode example:
```bash
# Replay session, re-execute tools against current codebase, show diffs
smith replay abc123 --compare --sandbox /tmp/smith-test-env --format json

# Quick replay at 5x speed, no comparison
smith replay abc123 --speed 5.0 --format summary

# Replay only turns 10-20
smith replay abc123 --speed 0 --from-turn 10 --turns 10
```

### 4.1 Interactive Slash Commands

Slash commands run inside an interactive or attached session. They are registered
through `smith.command.register()` by built-in Lua plugins in smith-harness.
They are not clap subcommands and must not be added to the `Commands` enum.

Built-in command plugin registrations:

```lua
smith.command.register("undo", {
  description = "Undo the last operation, N operations, or selected paths",
  usage = "/undo [N|path...]",
})

smith.command.register("redo", {
  description = "Redo the last undone operation",
  usage = "/redo",
})

smith.command.register("history", {
  description = "Open the time-travel operation timeline",
  usage = "/history",
})
```

Command behavior:
- `/undo` → `smith.vcs.undo()`
- `/undo 3` → plugin resolves the third previous operation via `smith.vcs.op_log()` and calls `smith.vcs.op_restore(op_id)`
- `/undo path/to/file.rs` → `smith.vcs.restore_paths({ "path/to/file.rs" })`
- `/redo` → `smith.vcs.redo()`
- `/history` → plugin toggles the time-travel panel using `smith.tui.*`

The CLI crate only boots the harness/TUI and loads plugins. Command parsing for
these slash commands belongs to the Lua plugin so user plugins can override or
extend the behavior with the same public API.

### 5. Config Schema Examples

Model aliasing, grouping, and bucket configuration (defined in `~/.smith/config.lua`):

```lua
-- ~/.smith/config.lua

-- Model aliases: short name -> fully qualified model ID
model_aliases = {
  larry = "anthropic/claude-sonnet-4",
}

-- Model groups: group name -> list of models with failover strategy
model_groups = {
  agentic = {
    models = {
      "anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4-7",
      "google/glm-5-1",
    },
    strategy = "failover",  -- "failover" | "round_robin" | "latency"
  }
}

-- Provider buckets: bucket name -> provider accounts with rotation strategy
provider_buckets = {
  codex = {
    provider = "openai",
    accounts = {
      { api_key = "sk-1..." },
      { api_key = "sk-2..." },
    },
    strategy = "balance_fair",  -- "balance_fair" | "round_robin"
  },
  kimi = {
    provider = "moonshot",
    accounts = {
      { api_key = "sk-a...", base_url = "https://api.moonshot.cn" },
      { api_key = "sk-b...", base_url = "https://api.moonshot.cn" },
      { api_key = "sk-c...", base_url = "https://api.moonshot.cn" },
    },
    strategy = "balance_fair",
  }
}
```

**Interaction rules:**
- Alias can reference: direct model ID, another alias, a group, or a bucket.
- Group can reference: direct model IDs, aliases, or other groups (but not buckets).
- Bucket can reference: aliases or groups (resolved to find the provider).
- Bucket members must all be for the same provider.

**CLI overrides:**
- `--model larry` resolves through ModelResolver
- `--model agentic` expands to group with failover
- `--provider codex` selects bucket with rotation

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
- `smith replay abc123` replays session from trace
- `smith replay abc123 --speed 0` replays at max speed (0 is special-cased to Max)
- `smith replay abc123 --speed 2.0` replays at 2× speed
- `smith replay abc123 --compare --sandbox /tmp/test` replays with tool comparison
- `smith replay abc123 --format json` outputs JSONL replay steps
- `smith replay abc123 --from-turn 5 --turns 3` replays turns 5-7 only
- Interactive: built-in Lua command plugin registers `/undo`, `/redo`, `/history`
- Interactive: `/undo`, `/undo N`, and `/undo path` dispatch through `smith.vcs.*`
- Interactive: slash commands are not clap subcommands

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
