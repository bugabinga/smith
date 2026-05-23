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

1. `p02-lua-interface-descriptor`
2. `p03-subagent-ecosystem-simulation`
3. `p04-plugin-install-uninstall`
4. `p05-provider-fetch-normalize`
5. `p06-session-codec-recovery`
6. `p07-streamfn-agent-loop`
7. `p08-tui-testbackend`
8. `p09-memory-arena-allocation`
9. `p10-lua-plugin-heap-limit`
10. `p11-plugin-memory-domain-reload`

Run in order unless a later prototype is needed to answer an active SPEC dispute.

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

## P09 — `p09-memory-arena-allocation`

### SPEC claims

No current SPEC claim requires arenas. This prototype tests whether memory
pressure justifies a future SPEC policy.

Candidate claims:

- Smith can load/replay large sessions without arena allocation.
- Smith can discover many sessions without fully loading them.
- Virtual scroll bounds per-frame allocations by visible rows, not total entries.
- Phase-local scratch allocation may reduce render/request allocation pressure.
- Phase-local scratch allocation may reduce allocator-call/syscall pressure.
- Phase-local scratch allocation may produce a flatter post-warmup memory profile.
- `bumpalo` can support scratch buffers without unsafe project code if measured
  wins justify it.
- Persisted/session data must use stable IDs, not `&'arena` references.

### Empirical sizing target

Use `../docs/research/SMITH-MEMORY-ALLOCATION-PROFILE.md` as the workload
baseline. Pi sessions treated as Smith-shaped sessions showed:

- 535 sessions, 395 MiB JSONL total,
- p50 session 88 KiB / 36 entries,
- p95 session 3.1 MiB / 822 entries,
- p99 session 9.2 MiB / 1,930 entries,
- max session 29.2 MiB / 5,157 entries,
- max single message line 4.6 MiB,
- compaction around 247k–282k tokens,
- dominant bytes: tool results + assistant/thinking text.

### Risk

Arena allocation may optimize the wrong layer. Persisted text dominates memory,
while arenas mainly help repeated short-lived scratch allocation. Allocation
count reduction alone is insufficient; the real win may be fewer global allocator
calls, less allocator/syscall pressure, and more stable peak/RSS behavior. Arena
use may still add lifetime complexity, skipped destructors, async/thread
friction, and unnecessary dependency surface.

### Minimal artifact

```text
p09-memory-arena-allocation/
  Cargo.toml
  fixtures/session-small.jsonl
  fixtures/session-p95.jsonl
  fixtures/session-p99.jsonl
  fixtures/session-pathological.jsonl
  src/main.rs
```

Fixtures are synthetic and content-free but match measured shapes:

- small: 36 entries, 88 KiB,
- p95: 822 entries, 3.1 MiB,
- p99: 1,930 entries, 9.2 MiB,
- pathological: 5,157 entries, 29 MiB, one 4.6 MiB message.

Implement five workloads:

1. `discover`: scan 535 session headers/metadata without full load,
2. `load-replay`: decode full sessions into Smith-like `SessionEntry` values,
3. `render-window`: render visible rows from small/p95/p99/pathological sessions,
4. `request-build`: assemble provider request near 250k token context,
5. `arena-scratch`: compare baseline `Vec`/`String` vs `bumpalo` for render and
   request scratch only.

Use a counting global allocator. Measure allocations, allocated bytes, allocator
calls, peak live bytes where feasible, post-warmup live-memory plateau, elapsed
time, and Linux RSS via `/proc/self/statm` when available. Treat allocator calls
as syscall-pressure proxy; optional local strace/malloc tracing may be noted but
must not be required. Do not prototype `arena-allocator`; prior research flags it
too sharp for Smith.

### Verify

```bash
cd prototypes/p09-memory-arena-allocation
cargo run -- discover
cargo run -- load-replay
cargo run -- render-window
cargo run -- request-build
cargo run -- arena-scratch
cargo run -- all
```

### Pass evidence

- discovery allocation is O(session count + metadata), not O(total corpus bytes),
- full-load memory estimates stay within target bands from research,
- render-window allocation is O(visible rows) for p95/p99/pathological sessions,
- request-build reports peak allocation near compaction-size contexts,
- post-warmup render/request memory profile is reported across repeated phases,
- `bumpalo` keep/drop decision considers allocated bytes, allocation count,
  allocator calls, elapsed time, RSS/peak-live stability, and complexity,
- no arena reference crosses async/thread/persistent boundaries,
- output prints keep/drop recommendation for `bumpalo` per workload.

### SPEC impact

If baseline is sufficient, record “no arena allocation in v1” and keep normal
ownership.

If arenas win on allocator calls, elapsed time, or memory stability, add a SPEC
policy:

- arenas only for phase-local scratch memory,
- `bumpalo` allowed only in measured hot paths,
- keep/drop gates include allocator-call pressure and stable memory profile, not
  only allocation reduction,
- persisted/session data uses stable IDs and owned bytes/strings,
- no custom unsafe arena implementation.

If session discovery/load/render exceeds targets, SPEC must clarify lazy loading,
virtual-scroll cache boundaries, max retained render state, and provider-request
peak-memory behavior.

## P10 — `p10-lua-plugin-heap-limit`

### SPEC claims

Smith's Lua plugin sandbox can enforce per-plugin heap limits.

Candidate claims:

- `mlua + LuaJIT` supports `Lua::used_memory()` and `Lua::set_memory_limit()` in
  Smith's locked feature set.
- A plugin exceeding its configured heap limit fails with a recoverable Lua
  memory error.
- Heap limit failure does not corrupt the host runtime or other plugins.
- Host-created values exposed to Lua have clear accounting semantics.

### Risk

Lua heap accounting may not include all host-side allocations, may behave
differently under LuaJIT, or may make plugin isolation require one Lua state per
quota domain. Shared Lua state + per-plugin quota may be impossible.

### Minimal artifact

```text
p10-lua-plugin-heap-limit/
  Cargo.toml
  plugins/small.lua
  plugins/oom_table.lua
  plugins/oom_string.lua
  plugins/host_value.lua
  src/main.rs
```

Use Smith's planned `mlua = { features = ["luajit", "vendored", "serialize"] }`
shape.

Implement four scenarios:

1. `small`: plugin stays below limit,
2. `oom-table`: table growth hits limit,
3. `oom-string`: string/buffer growth hits limit,
4. `isolation`: one plugin OOMs, another plugin still runs.

Test one-state-per-plugin first. If shared-state quotas are attempted, report
whether they are enforceable or impossible.

### Verify

```bash
cd prototypes/p10-lua-plugin-heap-limit
cargo run -- small
cargo run -- oom-table
cargo run -- oom-string
cargo run -- isolation
cargo run -- all
```

### Pass evidence

- `used_memory()` reports nonzero growth,
- `set_memory_limit()` rejects table/string growth with recoverable error,
- host process survives OOM scenario,
- isolated plugin state still works after another plugin OOMs,
- output states whether per-plugin quota requires one Lua state per plugin.

### SPEC impact

If viable, SPEC should add plugin heap quota fields and define quota domain:
per-plugin Lua state or shared runtime.

If not viable, SPEC should avoid promising plugin heap limits and instead define
coarser process/session limits.

## P11 — `p11-plugin-memory-domain-reload`

### SPEC claims

Smith can make plugin reload/unload memory management simple by assigning each
plugin instance a memory domain and dropping the whole domain on reload.

Candidate claims:

- A plugin runtime can own all reloadable plugin state behind one domain object:
  Lua state, registry handles, hook/tool descriptors, render caches, interface
  adapters, and host-side plugin scratch memory.
- Reload is `drop(old_domain) -> construct(new_domain)` with no per-resource
  cleanup graph.
- Arena-backed or domain-owned host allocations produce stable memory behavior
  across repeated reloads.
- Plugin heap quota and plugin memory-domain teardown are complementary: Lua heap
  limit bounds VM allocations; domain teardown bounds/reclaims host-side plugin
  allocations.

### Risk

Some plugin resources may escape the domain through async tasks, event bus
subscriptions, registry keys, UI caches, or shared host registries. If escape is
possible, reload can leak memory or leave stale callbacks even with an arena.

### Minimal artifact

```text
p11-plugin-memory-domain-reload/
  Cargo.toml
  plugins/grow.lua
  plugins/register_many.lua
  src/main.rs
```

Model a `PluginDomain` that owns:

- one `mlua::Lua`,
- plugin metadata/descriptors,
- hook/tool registries,
- render/layout cache,
- host scratch/domain arena or bump allocator,
- cancellation token for async tasks,
- subscription tokens dropped with the domain.

Run repeated load/use/reload cycles. Include one intentionally escaped resource
scenario that must fail validation.

### Verify

```bash
cd prototypes/p11-plugin-memory-domain-reload
cargo run -- reload-loop
cargo run -- reload-with-heap-limit
cargo run -- escaped-callback-fails
cargo run -- all
```

### Pass evidence

- repeated reloads plateau in RSS/live bytes after warmup,
- old hooks/tools/render caches disappear after reload,
- Lua heap is reclaimed by dropping the domain,
- domain arena/scratch is reclaimed or reset on reload,
- escaped callback/task/subscription is rejected or cancelled with clear error,
- no stale plugin callback can run after reload.

### SPEC impact

If viable, SPEC should define `PluginDomain`/reload ownership:

- one reloadable domain per plugin instance,
- all plugin-owned host memory/resources live inside that domain,
- reload is whole-domain replacement,
- no plugin callback/resource may outlive its domain,
- optional per-domain arena for host-side plugin state,
- Lua heap limit remains separate quota enforcement.

If not viable, SPEC must define explicit cleanup registries and leak/stale-callback
failure modes for plugin reload.

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
