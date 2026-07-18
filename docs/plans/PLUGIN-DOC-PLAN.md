# Smith Plugin SDK Documentation Plan

> Non-normative execution plan. `docs/SPEC.md` is canonical; where this file and
> the spec disagree, the spec wins. The normative pieces already live in SPEC —
> doc resolution order + `SMITH_DOCS_PATH` (§16), dotted `topic.function`
> addressing (§10.2), the system-prompt self-learn bootstrap (§6.8). This file
> is the execution plan for file inventories and tooling only.

## Goal

Smith must be able to extend itself when prompted by humans.
Documentation serves both humans and LLMs equally.
One source of truth. No drift.

## Architecture

```
Source of Truth: SDK Lua annotations (---@ + @usage + prose)
         │
         ├─→ Embed in binary (include_str!)
         │       │
         │       ├─→ smith help <topic>     (primary interface)
         │       ├─→ smith help --search X   (fuzzy search)
         │       ├─→ smith help --list       (all topics)
         │       └─→ system prompt bootstrap (teaches smith to self-learn)
         │
         ├─→ Generate man pages (CI, shipped in release)
         │
         ├─→ Generate compressed docs bundle (CI, shipped in install dir)
         │       └─→ fallback: readable files on disk
         │
         └─→ Doc tests (CI, extracts @usage + guide code blocks → run in Lua)
```

## One Source of Truth: SDK Annotations

Every SDK function has `---@` annotations in the Lua source files.

```
smith-harness/src/lua/sdk/
├── smith_tool.lua
├── smith_provider.lua
├── smith_command.lua
├── smith_shortcut.lua
├── smith_tui.lua
├── smith_fs.lua
├── smith_env.lua
├── smith_credentials.lua
└── smith_events.lua
```

Guides live alongside the SDK code too:

```
smith-harness/src/lua/sdk/
└── guides/
    ├── getting-started.lua     -- guide as Lua comments + tested code blocks
    ├── tools.lua
    ├── events.lua
    ├── providers.lua
    ├── tui.lua
    └── sandbox.lua
```

Guides are Lua files where:
- Comments (`--`) contain prose
- Fenced blocks (`---[[` ... `--]]`) contain tested examples
- The doc test runner extracts and executes the fenced blocks

This keeps everything in one place — the `sdk/` directory is the entire documentation source.

## `smith help` — The Primary Interface

`smith help` is not just a man page reader. It's a full documentation browser.

### Subcommands

```
smith help                        # topic list + fuzzy search prompt
smith help <topic>                # show topic (tool, provider, event, etc.)
smith help <topic>.<function>     # show specific function
smith help --search <query>       # fuzzy search across all docs
smith help --list                 # list all topics
smith help --examples             # list all examples
smith help --example <name>       # show full example source
smith help --guide <name>         # show full guide
```

### Topic Resolution

Topics map 1:1 to SDK files:

```
smith help tools          → smith_tool.lua annotations
smith help provider       → smith_provider.lua annotations
smith help events         → smith_events.lua annotations
smith help tui            → smith_tui.lua annotations
smith help tools.register → specific function within topic
```

### Fuzzy Search

```
smith help --search "block tool call"
→ Found: smith.on("tool_call") — subscribe to tool call events (can block)
→ Found: smith.on("tool_result") — subscribe to tool result events (can modify)
```

Fuzzy search across:
- Function names
- Descriptions
- Parameter names
- Example code
- Guide prose

### Navigation

Interactive mode (when run in TUI):

```
smith help
┌──────────────────────────────────────────┐
│ Smith SDK Help                            │
│ Type to search, Enter to view, Esc to quit│
├──────────────────────────────────────────┤
│ > tool                                    │
│                                           │
│ Topics:                                   │
│   smith.tool.register    Register custom tool│
│   smith.on("tool_call")  Intercept tool calls│
│   smith.on("tool_result") Modify tool results│
│                                           │
│ Guides:                                   │
│   tools.md               Custom tools guide │
│                                           │
│ Examples:                                 │
│   02-custom-tool.lua     Basic tool example │
│   04-permission-gate.lua Block dangerous cmd│
└──────────────────────────────────────────┘
```

Uses the same `SelectList` widget from smith-tui. Reuses the fuzzy matcher.

## Doc Location

Docs are resolved in this order:

1. **Embedded in binary** (always available) — primary source for `smith help`
2. **Install directory** (`<prefix>/share/smith/docs/`) — compressed fallback
3. **`SMITH_DOCS_PATH` env var** — override for development

The embedded docs are compiled from annotations via `include_str!` at build time.
No files needed on disk for `smith help` to work.

Install directory contains the generated bundle for:
- Direct file reading by LLMs via `read` tool
- Offline access
- Man pages

## System Prompt Bootstrap

```
Smith is a coding agent that can extend itself via Lua plugins.

To learn the plugin SDK, use these commands:
- smith help <topic>     — API reference (tools, events, provider, tui, etc.)
- smith help --search X  — fuzzy search across all docs
- smith help --example N — read a tested example plugin
- smith help --guide N   — read a guide

Key topics: tools, events, provider, command, shortcut, tui, fs, sandbox

When asked to create or modify a plugin, read the relevant help first.
```

This teaches smith to self-learn. When asked "write a plugin that blocks dangerous
commands", smith runs `smith help --search "block tool"` → reads `smith help events`
→ reads `smith help --example 04-permission-gate` → generates correct code.

## Examples

Tested examples live in the SDK source:

```
smith-harness/src/lua/sdk/examples/
├── 01-hello-world.lua
├── 02-custom-tool.lua
├── 03-event-subscription.lua
├── 04-permission-gate.lua
├── 05-custom-provider.lua
├── 06-custom-command.lua
├── 07-custom-layout.lua
├── 08-file-tree-panel.lua
├── 09-auto-compact.lua
├── 10-git-checkpoint.lua
├── 11-session-state.lua
└── 12-streaming-updates.lua
```

Each example has a header comment with description (indexed by `smith help --examples`).

## Testing Strategy

### Doc Tests (automated)

```
xtask/
  src/
    doc_test.rs
```

Extracts and runs:
1. `@usage` blocks from SDK annotation files
2. Fenced code blocks from guide files (`---[[` ... `--]]`)
3. Full example files

All run in sandboxed Lua VM. Any failure = CI failure.

### Completeness Verification (automated)

```
xtask/
  src/
    verify_docs.rs
```

CI checks:
1. Every Rust SDK function has a Lua binding with annotations
2. Every annotated function has `@usage`
3. Every event appears in at least one example
4. No documented function that doesn't exist in code
5. No public SDK function without documentation

### Guide Correctness (automated)

Guides are Lua files with prose in comments and code in fenced blocks.
The doc test runner treats them identically to SDK files — extracts code, runs it.

This means:
- Guide code is always tested
- If an API changes and breaks a guide, CI catches it
- No separate "guide test" vs "SDK test" — same runner

## CI Pipeline

```
cargo run -p xtask -- test          # unit + integration tests
cargo run -p xtask -- doc-test      # run all code blocks
cargo run -p xtask -- verify-docs   # completeness checks
cargo run -p xtask -- doc-gen       # regenerate man pages + bundle (fail if changed)
cargo run -p xtask -- lint          # clippy + luacheck
```

## File Structure

```
smith-harness/
├── src/
│   └── lua/
│       └── sdk/
│           ├── smith_tool.lua           -- annotations + @usage
│           ├── smith_provider.lua
│           ├── smith_command.lua
│           ├── smith_shortcut.lua
│           ├── smith_tui.lua
│           ├── smith_fs.lua
│           ├── smith_env.lua
│           ├── smith_credentials.lua
│           ├── smith_events.lua
│           ├── guides/
│           │   ├── getting-started.lua  -- prose in comments, tested code
│           │   ├── tools.lua
│           │   ├── events.lua
│           │   ├── providers.lua
│           │   ├── tui.lua
│           │   └── sandbox.lua
│           └── examples/
│               ├── 01-hello-world.lua
│               ├── 02-custom-tool.lua
│               ├── ...
│               └── 12-streaming-updates.lua

xtask/
└── src/
    ├── doc_test.rs          -- run code blocks in Lua VM
    ├── verify_docs.rs       -- completeness checks
    └── doc_gen.rs           -- generate man pages + docs bundle
```

## TODO

- [ ] Create SDK annotation files in `smith-harness/src/lua/sdk/`
- [ ] Create guide files (Lua files with prose comments + tested code)
- [ ] Create tested examples (01-12)
- [ ] Implement `smith help` command with fuzzy search + interactive browse
- [ ] Implement `xtask doc-test` (extract + run code blocks)
- [ ] Implement `xtask verify-docs` (completeness checker)
- [ ] Implement `xtask doc-gen` (generate man pages + docs bundle)
- [ ] Write system prompt bootstrap
- [ ] Set up CI pipeline
