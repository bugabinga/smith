# Prototype Plan

Purpose: prove or invalidate high-risk `../docs/SPEC.md` claims before production
Rust exists.

Rules from `AGENTS.md` apply:

- one prototype = one claim/risk,
- minimal runnable proof,
- every prototype has a verifying command,
- evidence drives SPEC changes,
- prototypes are disposable.

## Execution Order

1. `p01-pup-gate`
2. `p02-lua-interface-descriptor`
3. `p03-subagent-ecosystem-simulation`
4. `p04-plugin-install-uninstall`
5. `p05-provider-fetch-normalize`
6. `p06-session-codec-recovery`
7. `p07-streamfn-agent-loop`
8. `p08-tui-testbackend`

Run in order unless a later prototype is needed to answer an active SPEC dispute.

## P01 — `p01-pup-gate`

### SPEC claims

- `cargo-pup` can be a required architecture gate on pinned nightly.
- Stable product build and pinned-nightly architecture gate can coexist.
- `pup.ron` can enforce crate-boundary and module-hygiene rules.

### Risk

`cargo-pup` may be too unstable, too slow, or unable to express the required
Smith architecture rules.

### Minimal artifact

Tiny Rust workspace:

```text
p01-pup-gate/
  Cargo.toml
  pup.ron
  smith/
  smith-core/
  smith-ai/
  xtask/
```

Include one passing case and one intentionally failing case gated by file rename
or feature flag.

### Verify

```bash
cd prototypes/p01-pup-gate
cargo +stable check --workspace
cargo +nightly-2026-01-22 pup
```

### Pass evidence

- stable check passes,
- pup passes on valid crate graph,
- pup fails with useful diagnostic when forbidden import is enabled.

### SPEC impact

If pup cannot express needed rules, change SPEC to keep `xtask arch` as the hard
architecture gate and redefine pup scope.

## P02 — `p02-lua-interface-descriptor`

### SPEC claims

- Smith can support community-defined plugin interfaces without core authors
  predicting all future features.
- Plain Lua descriptors plus runtime validation might approximate signature
  matching.

### Risk

Plain Lua may be too weak or too verbose for reliable interface conformance.

### Minimal artifact

Lua-only or small Rust+mlua proof:

```text
p02-lua-interface-descriptor/
  Cargo.toml
  interfaces/subagent.lua
  impl/good.lua
  impl/missing_fn.lua
  impl/bad_shape.lua
  src/main.rs
```

Descriptor defines required exports/events. Validator loads descriptor and
implementations, then reports conformance errors.

### Verify

```bash
cd prototypes/p02-lua-interface-descriptor
cargo run
```

### Pass evidence

- good implementation passes,
- missing function fails with exact path/name,
- bad shape fails with expected/actual diagnostic,
- extra implementation fields are hidden/ignored when viewed through interface.

### SPEC impact

If viable, SPEC can make Lua interface descriptors the mandatory plugin shape.
If not, run P02b for Teal/typed Lua.

## P03 — `p03-subagent-ecosystem-simulation`

### SPEC claims

- Interface packages can prevent plugin ecosystem fragmentation.
- Consumers can target an interface while users choose implementation.
- Adapters can normalize incompatible implementations.

### Risk

The idea may work in prose but fail under realistic plugin composition.

### Minimal artifact

```text
p03-subagent-ecosystem-simulation/
  Cargo.toml
  plugins/community-subagent-interface/
  plugins/alice-subagents/
  plugins/bob-agents/
  plugins/bob-to-subagent-adapter/
  plugins/fancy-subagent-ui/
  src/main.rs
```

Simulate plugin manager resolving `community/subagent` to selected impl.

### Verify

```bash
cd prototypes/p03-subagent-ecosystem-simulation
cargo run -- alice
cargo run -- bob-adapted
cargo run -- bob-direct-fails
```

### Pass evidence

- UI plugin works with Alice implementation,
- UI plugin works with Bob only through adapter,
- direct incompatible Bob usage fails with clear interface error,
- user config swaps implementation without UI plugin change.

### SPEC impact

Clarify interface selection, adapter role, conformance test requirements, and
user override syntax.

## P04 — `p04-plugin-install-uninstall`

### SPEC claims

- v1 plugin install supports local path and git URL only.
- Plugin names are `<org>/<name>`.
- `smith/*` namespace is reserved.
- Manifests are mandatory Lua data files.
- `smith_api` is optional and defaults to generation `1`.
- Uninstall keeps data unless `--purge-data`.

### Risk

Install semantics may require too much code execution, ambiguous path layout, or
awkward namespace/data mapping.

### Minimal artifact

```text
p04-plugin-install-uninstall/
  Cargo.toml
  fixtures/good-plugin/smith-plugin.lua
  fixtures/bad-name/smith-plugin.lua
  fixtures/reserved-smith/smith-plugin.lua
  src/main.rs
```

Use temp dirs for fake `data_dir` and project dir. Git URL can be simulated with
a local bare repo first; note whether gix is used or shelling out is required.

### Verify

```bash
cd prototypes/p04-plugin-install-uninstall
cargo run -- install-local
cargo run -- install-git
cargo run -- reject-bad-name
cargo run -- reject-smith-namespace
cargo run -- uninstall-keeps-data
cargo run -- uninstall-purge-data
```

### Pass evidence

Each command exits 0 and prints checked filesystem assertions.

### SPEC impact

Clarify manifest filename, install layout, duplicate handling, `--force`, git
implementation boundary, and data purge rules.

## P05 — `p05-provider-fetch-normalize`

### SPEC claims

- `providers.json` is runtime authority.
- `fetch-providers` is only bootstrap/maintenance suggestion generator.
- pi.dev is primary, catwalk fills gaps.
- Unknown fields are preserved.
- Correctness requires review.

### Risk

Merge rules may be under-specified; generated data may silently corrupt provider
metadata.

### Minimal artifact

```text
p05-provider-fetch-normalize/
  Cargo.toml
  fixtures/pi.json
  fixtures/catwalk.json
  fixtures/current-providers.json
  src/main.rs
```

No network. Use fake source shapes with overlapping models, missing costs,
unknown fields, and conflicting metadata.

### Verify

```bash
cd prototypes/p05-provider-fetch-normalize
cargo run -- generate
cargo run -- diff
cargo run -- conflict-fails
```

### Pass evidence

- pi.dev wins conflicts,
- catwalk fills missing fields,
- unknown fields preserved,
- conflict report is explicit,
- generated patch is reviewable.

### SPEC impact

Clarify provider schema, conflict policy, and PR-agent workflow inputs/outputs.

## P06 — `p06-session-codec-recovery`

### SPEC claims

- Length-prefixed CBOR sequence supports crash recovery.
- Truncated tail stops parsing.
- Corrupt entries are skipped or reported without losing prior entries.
- Unknown future entries can be preserved where possible.

### Risk

CBOR recovery behavior may be less precise than SPEC promises.

### Minimal artifact

```text
p06-session-codec-recovery/
  Cargo.toml
  src/main.rs
```

Encode sample entries, truncate bytes, inject corrupt frame, and include unknown
variant representation if possible.

### Verify

```bash
cd prototypes/p06-session-codec-recovery
cargo run
```

### Pass evidence

Program asserts counts and diagnostics for normal/truncated/corrupt/unknown
cases.

### SPEC impact

Tighten exact recovery guarantees if corruption cannot be safely skipped.

## P07 — `p07-streamfn-agent-loop`

### SPEC claims

- `smith-core` can drive agent behavior through `StreamFn` without depending on
  `smith-ai`.
- Text, tool call, tool result, and done events can produce deterministic
  `AgentEvent` sequence.
- Tool execution hooks can block/replace/retry.

### Risk

The proposed event/hook shape may be too complex or insufficiently typed.

### Minimal artifact

```text
p07-streamfn-agent-loop/
  Cargo.toml
  src/main.rs
```

Mock StreamFn emits deterministic text/tool/done events. Mock tool returns a
result. Hook variants exercise allow/block/replace.

### Verify

```bash
cd prototypes/p07-streamfn-agent-loop
cargo run -- basic
cargo run -- tool
cargo run -- hook-block
cargo run -- hook-replace
```

### Pass evidence

Each scenario prints/compares expected event sequence.

### SPEC impact

Clarify event ordering, hook return semantics, and session-entry conversion.

## P08 — `p08-tui-testbackend`

### SPEC claims

- ratatui `TestBackend` supports deterministic widget snapshots.
- Theme tables can drive Rust widget rendering.
- TUI primitives can be tested without terminal I/O.

### Risk

Snapshot output may be unstable or theming may require more structure.

### Minimal artifact

```text
p08-tui-testbackend/
  Cargo.toml
  src/main.rs
```

Render one status bar and one message/tool-result widget using a theme table.
Print stable buffer text for assertion.

### Verify

```bash
cd prototypes/p08-tui-testbackend
cargo run
```

### Pass evidence

Output equals checked expected snapshot string.

### SPEC impact

Clarify theme schema, widget test strategy, and snapshot normalization.

## Reporting Template

Each completed prototype updates this plan with a result block:

```json
{
  "status": "complete|blocked|failed",
  "proved": [],
  "disproved": [],
  "specIssues": [
    {
      "file": "../docs/SPEC.md",
      "issue": "...",
      "evidence": "prototype path + command + result",
      "severity": "P0|P1|P2|P3"
    }
  ],
  "prototypeArtifacts": [],
  "commands": [],
  "nextSteps": []
}
```
