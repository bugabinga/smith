# Smith

A coding-agent TUI written in Rust, extended in Lua.

> **Status: specification.** Smith is being specified before it is built. The
> workspace crates are stubs; the product described below does not run yet.
> [`docs/SPEC.md`](docs/SPEC.md) is the canonical description of what it will
> be, and it is considerably further along than the code.

## Why Smith

[pi](https://github.com/earendil-works/pi) is Smith's starting point and its
philosophical ancestor. It is well designed, and it hits a sweet spot: handle
the annoying LLM details, stay minimal, stay extensible. Smith exists because
two of its costs are structural rather than incidental — they follow from
implementation choices that cannot be patched out from the outside.

**The runtime.** Node and npm carry a dependency-security surface that has to
be re-audited continuously, and a performance floor a terminal UI keeps
bumping into. Smith is a single Rust binary. The targets it is specified
against are a stripped release under 20MB and `--help` under 100ms
(§13) — targets, not measurements, until there is something to measure.

**Sharing extensions.** This is the deeper one. pi's extension mechanism has
good hooks and a broadly stable API, but its audience is a single developer or
a small team. Extensions are hard to share across a community, because a
principled interface and an IPC channel are missing. The symptom is visible in
the ecosystem: dozens of separate subagent extensions, some of them
dependencies of other extensions that needed subagent functionality, with no
common contract to depend on. For a consumer of community extensions that is a
mess, and the rational response is to give up and maintain your own — which is
the outcome an extension system is supposed to prevent.

Smith's answer is to make the plugin API the *only* extension API. Everything
user-visible — tools, slash commands, themes, keybindings, prompts, layouts,
feature UI — is a Lua plugin, and the built-in tools are written against the
same interface third-party plugins get (§9). An interface its own author must
use is one that stays honest. Plugins declare identity and dependencies in a
manifest, run sandboxed, and talk over a typed, versioned SDK rather than
reaching into internals.

Two more things fall out of the design rather than being features bolted on:

- **Provider independence.** The agent loop depends on `StreamFn` — a request
  in, a stream of provider events out — and on nothing else (§5.4). Providers
  are adapted to that shape, so the loop has no idea which one it is talking
  to.
- **Sessions you can replay.** Conversation state is a tree, stored as CBOR,
  and a recorded trace can be re-executed deterministically without touching a
  live provider (§6.5, §6.6, §6.11).

**Who it is for.** People who live in a terminal, want their coding agent to
start instantly and stay out of the way, and expect to reshape it — and to be
able to use what someone else built without adopting their dependency tree.

**What Smith is not.** Not a pi fork and not pi-compatible: no shared data, no
shared formats, no code lineage. Not a GUI, not an IDE plugin, and not an
onboarding wizard — the first run has no setup flow, and a missing credential
is reported as an error that names the env var to set.

## The shape of it

Interactive TUI, a non-interactive eval mode, and a JSON-RPC stdio mode, over
one agent loop (§1). Conversation history is a tree you can navigate, separate
from a VCS-backed timeline of what your files looked like — moving through the
conversation does not move your working copy, and vice versa. Mid-run
corrections queue as steers rather than forcing a cancel.

## Layout

```
smith/          shared types, StreamFn, AgentTool, config, Lua runtime
smith-ai/       providers, auth, model registry, provider streams
smith-core/     agent loop, sessions, tools
smith-tui/      terminal UI
smith-harness/  wiring, plugin management, the Lua SDK
smith-cli/      the binary
xtask/          custom build tasks
```

`docs/` holds project management rather than code: the specification, the
invariants every contributor and agent follows, research notes, and execution
plans. `prototypes/` holds disposable programs written to prove or disprove a
specific spec claim (§18).

## Building

Cargo is the only build system for the Rust workspace — there is no Makefile,
justfile, or script to learn, and anything cargo does not do natively lives in
`xtask`:

```sh
cargo check
cargo test
cargo run -p xtask -- check      # the full gate: fmt, clippy, tests, architecture
```

Smith tracks latest stable Rust on edition 2024. A pinned nightly is used for
exactly one thing — the `cargo-pup` architecture gate — and never for product
code.

## Reading further

- [`docs/SPEC.md`](docs/SPEC.md) — what to build. Canonical.
- [`docs/PROJECT-INVARIANTS.md`](docs/PROJECT-INVARIANTS.md) — the rules that
  do not bend without explicit approval.
- [`docs/plans/AGENTIC-DEVELOPMENT.md`](docs/plans/AGENTIC-DEVELOPMENT.md) —
  how Smith is developed, which is itself specified: the work is carried out
  by agents against the spec, through the workflows in `.github/`.
- [`CLAUDE.md`](CLAUDE.md) — the navigation index.

Section marks above (§N) refer to `docs/SPEC.md`.
