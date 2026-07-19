# Walking Skeleton — First Vertical Slice

> Non-normative execution plan. `docs/SPEC.md` is canonical; where this file and
> the spec disagree, the spec wins. This plan sequences the *first* code, not
> the whole product — `TASK-BREAKDOWN.md` holds the full crate build order.
>
> **This build sequence is the first milestone (wave).** `planner` opens the
> milestone from it and `surveyor` fills it in order; later waves come from
> `TASK-BREAKDOWN`. Only `planner` creates milestones (AGENTIC-DEVELOPMENT →
> *Coordination*).

## Why this exists

`TASK-BREAKDOWN` is bottom-up: `smith/` → core/ai/tui → harness → cli. Built
literally, nothing runs end-to-end until the last wave, so the first integration
problem surfaces last — the most expensive place to find it. The walking
skeleton inverts that: build the **thinnest possible slice through every layer**
first, prove the seams connect, then widen. Each layer ships the minimum that
lets the next one exist — no more.

The slice is one agent turn, end to end, rendered and persisted:

```
input → agent loop → StreamFn → (scripted) ProviderEvents → one tool call
      → assistant Message → EngineEvents → TUI render → session CBOR → reload
```

## The seams it proves (the entire point)

The skeleton exists to exercise the four load-bearing boundaries once, together,
before any of them is built out:

1. **StreamFn seam** (§5.4) — the agent loop consumes a `StreamFn`, never a
   concrete provider. Proven in isolation by p07; proven *wired* here.
2. **EngineEvent seam** (§6.3) — the engine emits a UI-agnostic event stream;
   the TUI is one consumer of it, not coupled to the loop.
3. **Session codec** (§6.6) — a turn round-trips through CBOR and reloads
   identically. Proven in isolation by p06.
4. **TUI render loop** (§8) — EngineEvents render through `TestBackend` with no
   TTY and no network. Proven in isolation by p08.

If these four connect, the architecture holds. Everything else is widening.

## In scope (the minimum per layer)

| Crate | Ships only | Leans on |
|-------|-----------|----------|
| workspace (SM-003) | jj repo, Cargo workspace, crate skeletons, `xtask check` | — |
| `smith/` (SM-005) | `Message`/`Id` (§5.1), `ProviderEvent`/`ProviderRequest` (§5.2), `AgentTool` (§5.3), `StreamFn` alias (§5.4), a minimal `Config` (§5.6) — and nothing else | — |
| `smith-ai/` (SM-007) | one **scripted** `StreamFn` that replays a fixture `ProviderEvent` sequence (deterministic, hermetic) | p05, p29 |
| `smith-core/` (SM-006) | one-turn agent loop (§6.1), `EngineEvent` emit (§6.3), one read-only tool via `ToolRegistry` (§6.10), session append + CBOR persist/reload (§6.5/§6.6) | p07, p06, p31 |
| `smith-tui/` (SM-008) | message list + input area + status bar (subset of §8.6), driven by EngineEvents through `TestBackend` | p08, p22 |
| `smith-harness/` (SM-009) | wire scripted StreamFn → loop → EngineEvent → TUI; register the one tool | p23 |
| `smith-cli/` (SM-010) | `smith new` (run one turn, render, persist) and `smith attach` (reload + re-render the persisted session) | — |

## Explicitly deferred (widening, not skeleton)

Lua runtime and plugins (§5.5/§9); real providers, auth, OAuth (§7); compaction
and cost (§6.9); session branching (§6.5 tree); the secret proxy (§6.7); the RPC
frontend (§10.4); the remaining §8.6 widgets and layout; every CLI subcommand
beyond `new`/`attach`. None of these block proving the seams.

## Acceptance

**One hermetic end-to-end test is the definition of done** (fast tier, §17.1;
hermeticity rules, §17.10):

> Given a scripted `StreamFn` whose fixture emits text then one tool call, when
> `smith new` runs one turn, then the tool executes once, the assistant
> `Message` is assembled from the `ProviderEvent` stream, the expected
> `EngineEvent` sequence is observed, `TestBackend` renders the exchange, the
> session is written as CBOR, and `smith attach` reloads it to a byte-identical
> in-memory state.

One additional **gated** smoke test (`network-tests` feature, off by default per
§17.10) swaps the scripted StreamFn for a real Anthropic call, proving the same
loop drives a live provider. It never runs in the default lane.

## Build sequence

Vertical, not the horizontal waves of `TASK-BREAKDOWN`:

```
1. workspace skeleton + xtask green
2. smith/ minimal types (only what steps 3–7 consume)
3. scripted StreamFn (fixture in, ProviderEvents out)
4. agent loop: one turn over the StreamFn, EngineEvents out, one tool
5. session: append + CBOR persist/reload
6. TUI: render EngineEvents via TestBackend
7. harness wires 3–6; cli exposes `new` + `attach`
8. the acceptance test goes green → skeleton done
```

Each step is mergeable on its own and leaves the tree building.

## Exit criteria

- The acceptance test passes in the fast tier; the gated real-provider smoke
  passes when explicitly run.
- `cargo run -p xtask -- check` (fmt + clippy + arch + pup + test + doc) is
  green on the slice.
- No deferred subsystem was pulled in to make it work.

## First widening steps after green

Add a real provider normalizer behind the StreamFn (§7.2, p29); introduce the
Lua runtime and the first built-in plugin (§5.5/§9); grow the widget set (§8.6);
add `continue`/`resume` and the session tree (§6.5). Each rides the seams the
skeleton already proved.
