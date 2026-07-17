# Prototype Plan

Purpose: prove or invalidate high-risk `../docs/SPEC.md` claims before production
Rust exists.

Rules from `CLAUDE.md` apply:

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

## Results

All prototypes implemented and run 2026-07-14, rustc 1.94.1,
x86_64-unknown-linux-gnu, mlua 0.10.5 vendored LuaJIT. Commands per prototype
section; each exits 0. Result blocks follow the reporting template, trimmed to
decision-relevant content; full diagnostics are in each prototype's output and
the corresponding commit message.

### P02 result

```json
{
  "status": "complete",
  "proved": [
    "plain Lua descriptor + runtime validation supports community interfaces",
    "missing function fails with exact path (impl/missing_fn.lua.cancel)",
    "bad shape fails with expected/actual (status: expected function, got string)",
    "extra impl fields hidden through interface view",
    "runtime arg validation rejects bad types naming fn/param"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "§9.6 can adopt candidate 1 (plain Lua descriptors); note mlua reports Lua integers as 'integer' not 'number' in diagnostics", "evidence": "p02 cargo run, all PASS", "severity": "P2" }
  ],
  "commands": ["cd prototypes/p02-lua-interface-descriptor && cargo run"],
  "nextSteps": ["make §9.6 candidate 1 canonical; P02b (Teal) not needed"]
}
```

### P03 result

```json
{
  "status": "complete",
  "proved": [
    "5-plugin ecosystem composes through one interface package; consumer source has no impl name",
    "user config swaps alice <-> bob-adapted with zero consumer changes",
    "pure-Lua adapter normalizes incompatible impl; passes same conformance check",
    "direct incompatible binding fails naming plugin, interface+generation, exact missing fns, actual exports, adapter hint"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "§9.6 lacks adapter registration semantics (invented `adapts` + make-factory)", "evidence": "p03 bob-adapted scenario", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "no config syntax exists for interface->implementation binding (invented `interfaces = { [\"community/subagent\"] = \"org/name\" }`)", "evidence": "p03 configs/*.lua", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "§9.2 `interfaces`/`implements` manifest field shapes undefined", "evidence": "p03 manifests", "severity": "P2" },
    { "file": "../docs/SPEC.md", "issue": "conformance-check timing (load vs bind) and undeclared-implements policy unstated", "evidence": "p03 bob-direct-fails", "severity": "P2" },
    { "file": "../docs/SPEC.md", "issue": "singleton vs per-consumer instance semantics open", "evidence": "alice module state vs adapter factory", "severity": "P3" }
  ],
  "commands": ["cargo run -- alice", "cargo run -- bob-adapted", "cargo run -- bob-direct-fails"],
  "nextSteps": ["amend §9.2/§9.6/§9.7 with manifest fields, adapter convention, binding config + precedence"]
}
```

### P04 result

```json
{
  "status": "complete",
  "proved": [
    "local-path + git-URL install into data_dir/smith/plugins/<org>/<name>/ (git via local bare repo, shell-out)",
    "name charset + smith/* reservation enforced before any write",
    "restricted empty-env manifest eval: os/require blocked, function values rejected as non-data",
    "smith_api defaults 1; smith_api=2 refused with required/supported generations",
    "install never executes entry code (armed side effect did not fire)",
    "duplicate refused without --force; --force = remove-then-copy, data kept",
    "uninstall keeps data / --purge-data removes it / project plugins never touched"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "§9.2 never states the manifest FILENAME (prototype: smith-plugin.lua)", "evidence": "p04 all commands", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "§9.5 git boundary open: gix vs shell-out; shell-out worked with zero extra crates but adds runtime git-binary dependency", "evidence": "p04 install-git", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "--force semantics, duplicate definition, .git stripping, data-dir lifecycle, exact restricted-env contents, staged validation before copy all unspecified", "evidence": "p04 output notes", "severity": "P2" }
  ],
  "commands": ["cargo run -- install-local|install-git|reject-bad-name|reject-smith-namespace|uninstall-keeps-data|uninstall-purge-data"],
  "nextSteps": ["canonicalize manifest filename; define --force/duplicate/git-layout; decide git boundary"]
}
```

### P05 result

```json
{
  "status": "complete",
  "proved": [
    "pi-primary field-level recursive merge; catwalk fills gaps at field/model/provider granularity",
    "generate writes nothing; suggestion + reviewable source-attributed patch on stdout",
    "two unresolvable conflict classes detected, excluded, reported: ambiguous-primary-source, type-mismatch-vs-curated-registry"
  ],
  "disproved": [
    "byte-for-byte unknown-field preservation with default serde_json (keys re-sort); preservation is semantic (Value-equal) only"
  ],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "§7.3 source-vs-curated-registry merge granularity undefined; subtree merge would clobber curated cost objects", "evidence": "p05 diff", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "§7.3 has no conflict taxonomy/policy at all", "evidence": "p05 conflict-fails", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "fetch-providers PR-agent contract (outputs, non-zero exit on unresolved conflicts) unspecified; replace_models carrier undefined; no canonical provider/model schema", "evidence": "p05 output notes", "severity": "P2" }
  ],
  "commands": ["cargo run -- generate", "cargo run -- diff", "cargo run -- conflict-fails"],
  "nextSteps": ["amend §7.3: merge granularity, conflict classes, semantic preservation, CLI contract"]
}
```

### P06 result

```json
{
  "status": "complete",
  "proved": [
    "truncated tail (mid-body, mid-prefix) stops parsing; prior entries survive",
    "corrupt entry BODY skips precisely with warning while framing intact",
    "unknown future variants distinguishable from corruption via two-stage decode (ciborium::Value then typed); preserved raw through v1 rewrite -> v2 read"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "§6.6 'corrupt entry: skip + warn if possible' holds only while the length prefix is intact; corrupted length prefix desynchronizes framing and loses everything after (indistinguishable from truncation)", "evidence": "p06 corrupt-length scenario", "severity": "P1" }
  ],
  "commands": ["cd prototypes/p06-session-codec-recovery && cargo run"],
  "nextSteps": ["state the framing boundary in §6.6"]
}
```

### P07 result

```json
{
  "status": "complete",
  "proved": [
    "agent loop drives text/tool/done through StreamFn only; deterministic AgentEvent sequences",
    "tool results fed back to provider next turn",
    "BeforeToolCall allow/block/replace-args verified; blocked call never executes tool"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "§6.4 blocked-call event semantics unspecified; prototype chose ToolExecutionStart + End(is_error) + error tool result to provider", "evidence": "p07 hook-block", "severity": "P2" }
  ],
  "commands": ["cargo run -- basic|tool|hook-block|hook-replace"],
  "nextSteps": ["state blocked-call event contract in §6.4"]
}
```

### P08 result

```json
{
  "status": "complete",
  "proved": [
    "TestBackend renders deterministic cell-by-cell (symbol + fg/bg/modifier); snapshot matches checked-in string; fully headless",
    "Lua theme tables validated by Rust schema drive widget styles; invalid theme rejected with exact path",
    "theme swap changes styles, leaves text byte-identical"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "§8.8 has no theme schema (keys, nesting, color format, missing-key policy)", "evidence": "p08 load_theme invented all of it", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "§17 snapshot contract undefined; text-only snapshots CANNOT catch theme regressions — style-aware cell comparison required", "evidence": "p08 theme swap: same text, different styles", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "invalid-user-theme runtime fallback policy (refuse vs fall back to built-in) unstated", "evidence": "p08 hard-error by construction", "severity": "P2" }
  ],
  "commands": ["cd prototypes/p08-tui-testbackend && cargo run"],
  "nextSteps": ["define §8.8 theme schema + §17 style-aware snapshot contract"]
}
```

### P09 result

```json
{
  "status": "complete",
  "proved": [
    "discovery O(session count): 535 sessions from 54.8KiB of 41.64MiB corpus (0.13%), 3.1ms",
    "load/replay within research bands up to 29.78MiB pathological session; 4.6MiB message intact",
    "virtual scroll O(visible rows): 41 allocs/frame constant across 143x entry spread; giant message capped by lazy viewport wrap",
    "request-build ~250k tokens: transient peak 2.43MiB, zero live growth over 50 builds",
    "bumpalo scratch: render -100% allocator calls, x0.19 elapsed (KEEP); request -99% calls, x1.00 elapsed, +22% peak (marginal KEEP)"
  ],
  "disproved": [
    "arenas as a latency win for request-build: serde_json serialization dominates; win is allocator-call pressure only"
  ],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "SPEC must require lazy metadata-only session discovery; full-loading corpus would be ~0.7-1.2GiB resident", "evidence": "p09 discover", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "adopt scratch-only-bumpalo policy: phase-local render/request scratch only, measured hot paths, stable IDs + owned strings for persisted data, no unsafe arenas, keep/drop gates include allocator-call pressure and peak stability", "evidence": "p09 arena-scratch verdicts", "severity": "P2" },
    { "file": "../docs/SPEC.md", "issue": "virtual-scroll cache bounds: per-frame materialized rows <= viewport (lazy wrap), else one 4.6MiB message allocates unboundedly", "evidence": "p09 render-giant-message-window", "severity": "P2" }
  ],
  "commands": ["cargo run --release -- discover|load-replay|render-window|request-build|arena-scratch|all"],
  "nextSteps": ["add memory policy to SPEC; re-run keep/drop on real render code before production commitment"],
  "deviation": "PLAN fixtures/*.jsonl not committed; synthetic sessions generated at runtime (deterministic seed) matching PLAN shapes within 2.5%"
}
```

### P10 result

```json
{
  "status": "complete",
  "proved": [
    "Lua::set_memory_limit() WORKS and enforces under mlua 0.10.5 + vendored LuaJIT (GC64 accepts mlua's tracking allocator) — PLAN's warning does not hold for the locked feature set",
    "oom-table/oom-string rejected at exactly the 16MiB quota (overshoot 0) with recoverable MemoryError; state reusable after gc_collect; host survives",
    "isolation: plugin B in its own state unaffected by A's OOM",
    "host-created Lua strings charged to the quota (8MiB string -> delta 8388672)",
    "quota domain: per-plugin heap quota = one Lua state per plugin"
  ],
  "disproved": [
    "shared-state per-plugin quotas: only a whole-state limit exists, no attribution (B charged at A's retained 15.3MiB)",
    "Lua quota covering host-side Rust allocations: 8MiB userdata payload registered 632 bytes",
    "hook-based fallback under active JIT: count hooks never fire JIT-on (0 fires / 3e6 iterations); interpreter-only, ~3.4x slowdown"
  ],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "add plugin heap-quota field; quota domain = per-plugin Lua state (aligns §9.16); shared runtime can never get per-plugin quotas", "evidence": "p10 oom-table + isolation", "severity": "P2" },
    { "file": "../docs/SPEC.md", "issue": "scope quota wording to the Lua heap; host-side plugin memory bounded by domain teardown, not the Lua limit", "evidence": "p10 host-value accounting", "severity": "P2" },
    { "file": "../docs/SPEC.md", "issue": "any future instruction watchdog cannot use LuaJIT count hooks (never fire under JIT)", "evidence": "p10 hook bench", "severity": "P3" }
  ],
  "commands": ["cargo run -- small|oom-table|oom-string|isolation|all"],
  "nextSteps": ["add heap-quota to SPEC §9 with per-plugin-state domain; CI-verify enforcement per release target (non-GC64 -> MemoryControlNotAvailable)"]
}
```

### P11 result

```json
{
  "status": "complete",
  "proved": [
    "§9.16 full contract implementable as written: PluginDomain owns Lua + descriptors + generation-keyed registries + bus tokens + render cache + bump scratch + cancellation token; reload = construct -> swap -> drop, single Drop impl, no cleanup graph",
    "100 reload cycles plateau: growth <=77KB over 80 cycles; Lua used_memory constant; threads joined every drop; reload avg 3.8-4.0ms incl. 450 registrations",
    "rollback: broken entry keeps old domain serving; partial D' registrations discarded",
    "31MB Lua heap 100% reclaimed by domain drop; fresh domain restarts at 45KB",
    "every escape path (stale registry entry, leaked bus token, escaped thread) detected and rejected via generation gating; 0 stale callbacks ran; !Send containment stops Lua values crossing threads at compile time"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "raw mlua::Function cloned out of the registry PANICS after domain drop (abort-grade under no-panic invariant); §9.16 must mandate generation-keyed-registry-only callback access + generation gate on every dispatch path", "evidence": "p11 escaped-callback-fails: 'call panicked: Lua instance is destroyed'", "severity": "P2" },
    { "file": "../docs/SPEC.md", "issue": "plateau-after-warmup is the enforceable observable, not instantaneous RSS decrease (small heaps retained by allocator, large teardowns return to OS)", "evidence": "p11 reload-loop vs reload-with-heap-limit RSS traces", "severity": "P3" }
  ],
  "commands": ["cargo run -- reload-loop|reload-with-heap-limit|escaped-callback-fails|all"],
  "nextSteps": ["fold registry/generation-gate discipline into §9.16; re-verify !Send containment if mlua 'send' feature is ever enabled"]
}
```

## Campaign 2 — new contracts from the readiness passes

The 2026-07-15/16 readiness passes added contracts to `../docs/SPEC.md`
(§5.1/§5.8, §6.1, §6.5, §6.7, §6.9) that lack prototype evidence. P12–P14
validate their risky cores.

## P12 — `p12-session-tree-fold`

### SPEC claims

- §6.5: branches are emergent paths; append at a non-leaf entry creates a
  fork point implicitly; leaf switches persist as append-only metadata
  entries; effective leaf on load = last leaf-switch target or last append.
- §6.9: compaction is an assembly-time fold — a summary entry covering a span
  collapses that span; trim masks collapse content into stubs; storage never
  changes.
- §6.5×§6.9: switching the leaf to a pre-compaction entry yields a path
  without the summary (full history visible, re-compactable); branches
  created after the compaction point inherit the mask.
- Recency window and secret registrations survive folding verbatim.

### Risk

Path folding may be ill-defined at edges: a summary entry whose covered span
crosses a fork point, nested summaries (summary covering a summary), or a
leaf-switch entry inside a covered span.

### Minimal artifact

```text
p12-session-tree-fold/
  Cargo.toml        (serde, ciborium — §6.6 length-prefixed format)
  src/main.rs
```

### Verify

```bash
cd prototypes/p12-session-tree-fold
cargo run -- tree
cargo run -- leaf-persist
cargo run -- fold
cargo run -- branch-past-compaction
cargo run -- all
```

### Pass evidence

- append/switch/read-path behave per §6.5 including implicit fork points,
- write file, truncate/corrupt tail, reload: effective leaf matches the
  §6.5 rule under §6.6 recovery,
- folded path collapses covered spans + trim stubs; raw entries untouched,
- pre-compaction leaf switch sees full history; post-compaction branch
  inherits the mask,
- edge findings reported: span×fork crossings, nested summaries, leaf-switch
  entries inside covered spans.

### SPEC impact

Tighten §6.9 with whatever edge rules the fold needs (e.g. spans may not
cross fork points; summaries may nest or may not).

## P13 — `p13-secret-proxy-mechanics`

### SPEC claims

- §6.7: plaintext exists only in secret-registration entries; ingestion
  masks all other content; ingestion scan runs AFTER plugin
  input/tool_result hooks (a hook-registered value is masked in the very
  content that surfaced it); rehydration only at tool execution; resume
  rebuilds the table by backward scan; unknown placeholder ids pass through.

### Risk

The hook-then-scan ordering may be racy or ambiguous when a hook both
transforms content and registers a secret found in the pre-transform text.
Exact-substring masking may corrupt content when one secret is a substring
of another or of a placeholder.

### Minimal artifact

```text
p13-secret-proxy-mechanics/
  Cargo.toml        (mlua luajit vendored, serde, ciborium)
  plugins/detector.lua   (input/tool_result hook registering found values)
  src/main.rs
```

### Verify

```bash
cd prototypes/p13-secret-proxy-mechanics
cargo run -- ingest
cargo run -- hook-order
cargo run -- rehydrate
cargo run -- resume
cargo run -- all
```

### Pass evidence

- registered values masked at ingestion; registration entry holds plaintext;
  every other entry stores placeholders,
- Lua detector hook registers a value from content; the same content lands
  masked,
- tool execution receives rehydrated args; provider-request view stays
  masked; unknown ids untouched,
- reload from file rebuilds table; masking works immediately,
- findings on overlapping-secret and secret-inside-placeholder edge cases.

### SPEC impact

Define masking order for overlapping secrets (e.g. longest-match-first) and
any hook/transform ordering rule §6.7 needs beyond "scan after hooks".

## P14 — `p14-steering-queue`

### SPEC claims

- §6.1: steers deliver at the next safe boundary (stream end / current tool
  completion); pending tool calls resolve as synthetic error results
  (`skipped: user steered`); queued steers drain FIFO before the next
  provider call; follow-ups dequeue instead of `agent_end`; entries recorded
  on delivery only; abort leaves the remainder queued.

### Risk

Boundary delivery may interleave badly with parallel tool execution
(§5.3 ToolExecutionMode) — "currently executing tool finishes" is ambiguous
when three run concurrently. Synthetic results for skipped calls may need
exact ordering relative to real results.

### Minimal artifact

```text
p14-steering-queue/
  Cargo.toml        (serde_json only; extends the p07 loop pattern)
  src/main.rs
```

### Verify

```bash
cd prototypes/p14-steering-queue
cargo run -- steer-mid-stream
cargo run -- steer-mid-tools
cargo run -- steer-parallel-tools
cargo run -- followup
cargo run -- abort-keeps-queue
cargo run -- all
```

### Pass evidence

- deterministic AgentEvent sequences for each scenario (p07 style),
- steer during tool batch: running tool completes, remaining calls resolve
  skipped-with-error, steer message precedes next provider request,
- parallel mode: boundary semantics reported (all in-flight finish vs first
  finish),
- follow-up consumed instead of agent_end; FIFO order held,
- abort ends run, queue contents intact and reported,
- session-entry recording happens at delivery time only.

### SPEC impact

Pin the parallel-execution boundary rule in §6.1 and the ordering of
synthetic skipped results relative to completed results.

## Campaign 2 Results

Run 2026-07-16, rustc 1.94.1, x86_64-unknown-linux-gnu. All three complete;
findings folded into SPEC (§6.1, §6.5, §6.7, §6.9).

### P12 result

```json
{
  "status": "complete",
  "proved": [
    "tree ops per §6.5 incl. implicit fork points; leaf-switch persistence under §6.6 recovery",
    "fold: span collapse at path position, trim stubs, byte-identical storage through every fold/switch/compaction",
    "branch-past-compaction: pre-compaction switch sees full history, re-compacts as SIBLING summary; post-compaction branches inherit the mask",
    "edges: cross-fork spans detectable + safely ignored; nested summaries inevitable, outermost-wins; leaf-switch inside covered span folds away (leaf replay reads raw storage)"
  ],
  "disproved": [
    "§6.5 literal leaf-load rule ('last switch target, else last append') — stale leaf whenever appends follow a switch; correct rule is replay-in-file-order (last surviving entry decides)"
  ],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "leaf-load rule false as written", "evidence": "leaf-persist: literal=Some(2) vs replay=Some(6)", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "§6.9 'registrations survive verbatim' x §6.7 'provider carries placeholders only' contradiction — structural survival + masked provider rendering required", "evidence": "fold: hoist-secret#2 with plaintext intact", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "span well-formedness, nested-summary outermost-wins, trim-ladder scoping of 'survives verbatim', orphan/dangling recovery rules, metadata foldability all needed", "evidence": "fold + branch-past-compaction + leaf-persist diagnostics", "severity": "P2" }
  ],
  "commands": ["cargo run -- tree|leaf-persist|fold|branch-past-compaction|all"],
  "nextSteps": ["all folded into §6.5/§6.9 (2026-07-16)"]
}
```

### P13 result

```json
{
  "status": "complete",
  "proved": [
    "plaintext bytes exist exactly once in the file (registration entry) — byte-scan verified",
    "hook-then-scan ordering: Lua detector registering during a hook masks the surfacing content",
    "rehydration is a view at tool execution only (Rust + Lua); provider view masked; unknown ids pass through",
    "resume rebuilds table with original ids; allocator resumes past max id",
    "longest-match-first single-pass masking correct; naive order provably leaks overlap residue"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "masking order must be longest-match-first single-pass never rescanning placeholders", "evidence": "ingest overlap scenario residue leak", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "placeholder-grammar registered values alias placeholders; single-pass rehydration load-bearing; reject such registrations", "evidence": "ingest placeholder-shaped scenario", "severity": "P2" },
    { "file": "../docs/SPEC.md", "issue": "scan is post-transform only (re-encoding hook launders secrets) — stated limit; allocator resume, idempotent re-registration, maximal-digit-run parsing", "evidence": "hook-order + resume + rehydrate scenarios", "severity": "P2" }
  ],
  "commands": ["cargo run -- ingest|hook-order|rehydrate|resume|all"],
  "nextSteps": ["all folded into §6.7 (2026-07-16)"]
}
```

### P14 result

```json
{
  "status": "complete",
  "proved": [
    "boundary delivery (stream end / in-flight completion), synthetic skipped results for every unexecuted call, FIFO steer drain, follow-up-instead-of-agent_end, delivery-time-only entry recording, abort keeps queues intact",
    "parallel mode: wait-for-all-in-flight workable — no new call starts after a steer queues, started calls complete, never-started skip",
    "transcript rule: reals first (completion order), synthetics in original call order, steers follow"
  ],
  "disproved": [],
  "specIssues": [
    { "file": "../docs/SPEC.md", "issue": "'currently executing tool finishes' ill-defined with N in flight — pin wait-for-all-in-flight", "evidence": "steer-parallel-tools", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "synthetics-after-reals ordering must be stated (reals may be completion-ordered)", "evidence": "steer-mid-tools + steer-parallel-tools transcripts", "severity": "P1" },
    { "file": "../docs/SPEC.md", "issue": "mid-stream steer skips ALL calls; skipped calls emit §6.4-style events; abort leaves dangling tool-call tail — resume must repair", "evidence": "steer-mid-stream + abort-keeps-queue", "severity": "P2" }
  ],
  "commands": ["cargo run -- steer-mid-stream|steer-mid-tools|steer-parallel-tools|followup|abort-keeps-queue|all"],
  "nextSteps": ["all folded into §6.1 (2026-07-16); re-verify wait-for-all under real tokio timing when the loop lands"]
}
```

## Campaign 3 — highest-risk unvalidated claims

Planned 2026-07-16. Ranking rationale (spec-impact × uncertainty):

1. **P15 async×Lua threading** — architecture-fatal if wrong. Every loop
   prototype so far was synchronous; mlua without the `send` feature makes
   Lua `!Send`, yet hooks are called from the tokio agent loop, tools run on
   a pool, and §9.18 says "on the plugin thread" — a thread §12 never
   defines. This prototype forces the missing §12 decisions.
2. **P16 config cascade + host reload** — §9.19 is a full contract with zero
   prototype evidence; §5.6 cascade layering with plugin contributions is
   likewise unvalidated.
3. **P17 bytecode cache** — genuine disproof risk: §5.5 promises bytecode
   caching, but dump/load availability and version fragility under vendored
   LuaJIT via mlua are unverified.
4. **P18 model resolver** — pure logic, cheap, and cross-cutting: resolution
   is referenced by config, compaction, the /model picker, and failover.
5. **P19 models.dev schema pin** — bootstrap-critical: the "translated from
   the models.dev schema at a recorded upstream version" claim (§7.3) has
   never been executed; p05 used synthetic pre-models.dev fixtures.
6. **P20 trace/replay over the new contracts** — replay was validated only
   against the pre-consolidation design; steering synthetics, abort tails,
   leaf switches, folds, and secret placeholders all postdate it.
7. **P21 compaction round** — p12 proved the fold; the round that CREATES
   summaries (trigger math, span selection, summarization request assembly,
   re-entrancy guard) is unvalidated.
8. **P22 input queue machine** — freshly designed UX (§8.11) with fiddly
   edit/reposition semantics; deterministic TestBackend validation.
9. **P23 bus delivery semantics** — §9.18's precise delivery rules
   (registration order, no re-entry, error isolation) beyond the token
   teardown p11 covered.

Deliberately not prototyped: the RPC method catalog (deferred by decision,
§10.2), release cross-builds (infrastructure, not spec), CI wiring (§17.10 is
process), and §1.1 UX prose (validated by use, not prototype).

## P15 — `p15-async-lua-threading`

### SPEC claims

- §12: engine loop, UI thread, tool pool, provider tasks compose without the
  engine blocking on UI; every long operation observes abort; UI keypress
  acknowledged within 16ms.
- §5.5/§9: one `mlua::Lua` per plugin, `!Send` (no `send` feature), yet
  hooks (§6.4) are invoked from the async agent loop and bus delivery (§9.18)
  happens "on the plugin thread".
- §9.16: cancellation tokens stop plugin tasks across the async boundary.

### Risk

The Lua-thread integration may be unimplementable as implied: `!Send` states
cannot hop tokio workers, so hook dispatch needs a confinement strategy
(dedicated plugin thread + channel actor, or `LocalSet`), and a busy Lua hook
may stall the engine. §12 does not name the plugin thread §9.18 assumes.

### Minimal artifact

```text
p15-async-lua-threading/
  Cargo.toml        (tokio, mlua luajit vendored)
  src/main.rs
```

Tokio agent loop (p07/p14 pattern, now async) + one dedicated plugin thread
owning two Lua states; hook dispatch via channels; parallel mock tools on a
pool; a deliberately slow Lua hook; abort mid-hook.

### Verify

```bash
cd prototypes/p15-async-lua-threading
cargo run -- hook-roundtrip
cargo run -- parallel-tools-hooks
cargo run -- slow-hook-stall
cargo run -- abort-mid-hook
cargo run -- all
```

### Pass evidence

- `!Send` containment compiles by construction; hook round-trip latency
  measured (target: sub-ms median),
- parallel tools' before/after hooks serialize on the plugin thread without
  deadlock,
- a slow hook's effect on engine/UI responsiveness measured and reported
  (does 16ms hold? what budget does §12 need?),
- abort interrupts a hook-waiting engine cleanly,
- report the exact threading rule §12 must state.

### SPEC impact

§12 gains the plugin-thread definition, the hook dispatch mechanism, and a
hook execution budget — or the one-Lua-thread design is refuted with
evidence.

## P16 — `p16-config-cascade-reload`

### SPEC claims

- §5.6: five-layer cascade, later overrides earlier; Rust schemas validate;
  unknown keys warn or fail by context.
- §9.19: reload re-evaluates layers 1–4, validates fully (including model
  re-resolution), swaps atomically, rolls back on failure with exact key
  path; `config_changed` carries changed key paths; CLI flags persist;
  plugin reload triggers cascade re-evaluation.

### Risk

Layer merge semantics (tables vs scalars across Lua layers), changed-keypath
diffing, and rollback atomicity may be underspecified in exactly the ways
p05 found for provider merging.

### Minimal artifact

```text
p16-config-cascade-reload/
  Cargo.toml        (mlua, serde)
  layers/builtin.lua
  layers/plugin-a.lua
  layers/user.lua
  src/main.rs
```

### Verify

```bash
cd prototypes/p16-config-cascade-reload
cargo run -- cascade
cargo run -- reload-ok
cargo run -- reload-invalid-keeps-active
cargo run -- plugin-reload-reevaluates
cargo run -- all
```

### Pass evidence

- cascade produces documented precedence incl. nested-table merge behavior
  (report the merge rule §5.6 must state: leaf-merge like §7.3, or
  layer-replace),
- reload swap is all-or-nothing; invalid candidate reports exact key path,
- changed-keypath diff is minimal and correct; CLI layer persists,
- plugin-contribution change propagates via reload.

### SPEC impact

Pin the §5.6 cross-layer merge granularity and any §9.19 diff/rollback edge
rules.

## P17 — `p17-bytecode-cache`

### SPEC claims

§5.5: Smith compiles `.lua` to bytecode on first load; cache key includes
source hash; Smith never loads bytecode it did not compile.

### Risk

Disproof risk: mlua under vendored LuaJIT may not expose reliable
dump/load; LuaJIT bytecode is version-fragile; "never loads foreign
bytecode" needs an enforcement mechanism (provenance, not trust).

### Minimal artifact

```text
p17-bytecode-cache/
  Cargo.toml        (mlua luajit vendored, sha2)
  src/main.rs
```

### Verify

```bash
cd prototypes/p17-bytecode-cache
cargo run -- roundtrip
cargo run -- stale-invalidation
cargo run -- foreign-rejected
cargo run -- all
```

### Pass evidence

- dump/load works (or precisely which API is missing → disproof),
- cache hit skips compilation; source edit invalidates via hash,
- tampered/foreign bytecode file is rejected before reaching Lua,
- report LuaJIT-version fragility and the cache-invalidation rule §5.5
  needs (e.g. cache key = source hash + smith version + LuaJIT version).

### SPEC impact

Either §5.5 gains the full cache-key and provenance rule, or bytecode
caching is dropped/deferred with evidence.

## P18 — `p18-model-resolver`

### SPEC claims

§5.7: pure resolution requested name → alias → group → bucket/account →
metadata; cycles detected at config load with full path; DAGs allowed;
failover strategies ordered/round-robin; §6.9 `compaction_model` and §1.1
`/model` resolve through the same graph.

### Risk

Cycle/DAG edge semantics and alias-in-group-in-bucket compositions may be
ambiguous; error reporting shape unpinned.

### Minimal artifact

```text
p18-model-resolver/
  Cargo.toml        (serde only)
  src/main.rs
```

### Verify

```bash
cd prototypes/p18-model-resolver
cargo run -- resolve
cargo run -- cycles
cargo run -- failover-order
cargo run -- all
```

### Pass evidence

- documented resolution for alias→alias, alias→group, group containing
  buckets and raw models; DAG sharing works,
- cycle diagnostic carries the full path; detected at load, not resolve,
- resolution is pure (no I/O by construction),
- failover ordering handed to a mock Mux matches strategy config.

### SPEC impact

Pin any resolution edge rules §5.7 lacks (duplicate names across kinds,
shadowing, empty groups).

## P19 — `p19-models-dev-schema-pin`

### SPEC claims

§7.3: providers.schema.json is translated from the models.dev schema at a
recorded upstream version; validation at three boundaries; leaf-field merge,
models.dev primary, catwalk fills gaps; unknown fields preserved
semantically; ModelMetadata mapping table.

### Risk

The translation has never been executed against the real api.json shape;
real-world data may not fit the documented mapping (nulls, missing limits,
provider-level quirks).

### Minimal artifact

```text
p19-models-dev-schema-pin/
  Cargo.toml        (serde_json, jsonschema)
  fixtures/models-dev-api.snapshot.json   (committed, versioned snapshot)
  fixtures/catwalk.json
  src/main.rs
```

No network; the snapshot fixture records its upstream retrieval date.

### Verify

```bash
cd prototypes/p19-models-dev-schema-pin
cargo run -- validate-snapshot
cargo run -- merge
cargo run -- map-metadata
cargo run -- all
```

### Pass evidence

- generated providers.schema.json accepts the full real snapshot,
- leaf-merge with catwalk gap-fill works on real shapes; unknown fields
  survive; conflicts reported per §7.3 taxonomy,
- every snapshot model maps into ModelMetadata via the §7.3 table; unmapped
  fields enumerated,
- report any real-data shape the §7.3 mapping cannot express.

### SPEC impact

Correct the §7.3 mapping/schema rules against reality; record the pinned
upstream version procedure.

## P20 — `p20-trace-replay-contracts`

### SPEC claims

§6.11 trace/replay against the campaign-2 contracts: traces capture steering
synthetics, abort dangling tails, leaf switches, fold spans, and masked
secrets; block-level zstd with min-size threshold; max-speed reconstruction
reproduces session state; compare mode re-executes tools with §6.7
rehydration.

### Risk

Replay determinism was validated only pre-consolidation; the new entry kinds
and ordering rules may break reconstruction or compare-mode equivalence.

### Minimal artifact

```text
p20-trace-replay-contracts/
  Cargo.toml        (serde, ciborium, zstd)
  src/main.rs
```

Record a scripted session (p14-style loop incl. steer, abort, leaf switch,
compaction, secrets) into a trace; reconstruct; compare.

### Verify

```bash
cd prototypes/p20-trace-replay-contracts
cargo run -- record
cargo run -- reconstruct
cargo run -- compare
cargo run -- compression
cargo run -- all
```

### Pass evidence

- reconstruction equals live final state (leaf, folded path, queue snapshot),
- compare mode rehydrates from registration entries; traces stay masked,
- block-level compression beats per-entry on small traces; threshold
  reported,
- any new-contract event that cannot round-trip through the trace is a
  finding.

### SPEC impact

Tighten §6.11 trace entry coverage and the compression threshold rule.

## P21 — `p21-compaction-round`

### SPEC claims

§6.9: trigger when estimated folded-path tokens exceed threshold (fraction of
context window minus output reserve); trim ladder order; oldest-span
summarization via mock LLM; iteration limit; recency window (token-budget
fraction) never touched; summarization usage tracked as cost.

### Risk

Threshold/reserve/recency arithmetic may interact badly (e.g. recency window
larger than threshold → livelock); summarization request assembly from a
folded path is unvalidated; a compaction round must not re-enter itself.

### Minimal artifact

```text
p21-compaction-round/
  Cargo.toml        (serde only; reuses p12's fold model)
  src/main.rs
```

### Verify

```bash
cd prototypes/p21-compaction-round
cargo run -- trigger-math
cargo run -- round
cargo run -- iteration-limit
cargo run -- livelock-guard
cargo run -- all
```

### Pass evidence

- trigger fires exactly at the documented boundary; reserve respected,
- round: trim masks first, then one summary span appended; folded tokens
  drop below threshold or iteration limit reported,
- recency-window-vs-threshold conflict detected and reported (the rule §6.9
  needs),
- no re-entry: compaction during compaction is impossible by construction.

### SPEC impact

Pin the threshold/recency arithmetic rule and the no-re-entry guarantee in
§6.9.

## P22 — `p22-input-queue-machine`

### SPEC claims

§8.11: combined visual queue (follow-ups above steers, oldest→newest per
kind), promote/demote, up-arrow cycle, edit temporarily removes + best-effort
reposition, empty re-send deletes, cancel keys pop newest-first before
aborting.

### Risk

The edit/reposition and cancel-pop semantics are fiddly state-machine
territory; "best effort" needs a precise fallback rule.

### Minimal artifact

```text
p22-input-queue-machine/
  Cargo.toml        (ratatui TestBackend)
  src/main.rs
```

Deterministic key-event scripts drive the queue widget; styled-cell
snapshots per step (§17.7 contract).

### Verify

```bash
cd prototypes/p22-input-queue-machine
cargo run -- ordering
cargo run -- promote-demote
cargo run -- edit-reposition
cargo run -- cancel-pop
cargo run -- all
```

### Pass evidence

- visual order matches §8.11 in every state,
- edit removal + re-send restores position; fallback rule when the previous
  position no longer exists is reported (the "best effort" definition),
- empty re-send deletes; cancel pops newest-first then aborts,
- snapshots stable across runs.

### SPEC impact

Replace "best effort" with the proven fallback rule in §8.11.

## P23 — `p23-bus-delivery`

### SPEC claims

§9.18: synchronous delivery in registration order on the plugin thread;
emit-during-delivery enqueues (no re-entry); subscriber errors isolated;
payloads are plain data; no replay across load order.

### Risk

Re-entrancy queueing and teardown-during-dispatch may interact with §9.16
domain teardown in unspecified ways.

### Minimal artifact

```text
p23-bus-delivery/
  Cargo.toml        (mlua luajit vendored)
  plugins/emitter.lua
  plugins/listener.lua
  src/main.rs
```

### Verify

```bash
cd prototypes/p23-bus-delivery
cargo run -- order
cargo run -- reentrancy
cargo run -- error-isolation
cargo run -- teardown-mid-dispatch
cargo run -- all
```

### Pass evidence

- registration-order delivery; emit-during-delivery runs after current
  dispatch,
- one failing subscriber never blocks the rest,
- a domain torn down mid-dispatch delivers to no stale subscriber and leaks
  nothing (the §9.16×§9.18 interaction rule),
- non-data payloads rejected at the boundary.

### SPEC impact

Pin the teardown-mid-dispatch rule; confirm or refine the §9.18 delivery
text.

## Campaign 3 Results

Run 2026-07-16, rustc 1.94.1, x86_64-unknown-linux-gnu. All nine complete;
findings folded into SPEC (§4, §5.5, §5.6, §5.7, §6.9, §6.11, §7.3, §7.5,
§8.11, §9.16, §9.18, §9.19, §12). Full diagnostics in each prototype's
output and commit message. Digest per prototype (Markdown contract):

### P15 result — async×Lua threading

Status: complete. Proved: one dedicated plugin thread (channel actor, mpsc +
oneshot) integrates !Send Lua with tokio — hook round-trip median 81µs/p99
142µs; parallel tools overlap while hooks serialize; hostile 200ms hook
leaves UI heartbeat <16ms; abort unblocks engine mid-hook; compile-fail
containment evidence. **Disproved**: "every long operation observes abort" —
in-flight LuaJIT hooks cannot be preempted; abort abandons the dispatch,
hard-kill is domain teardown. Spec issues: P0 plugin-thread definition,
P0 channel-actor dispatch rule, P1 soft hook budget (head-of-line),
P1 abort carve-out.

### P16 result — config cascade + reload

Status: complete (28 PASS). Proved: five-layer cascade with leaf-merge;
§9.19 atomic swap/rollback (eval, validation, resolution failures), minimal
effective-config diff, CLI persistence, plugin-reload re-evaluation.
Spec issues: P1 leaf-merge rule (layer-replace wipes builtin bindings),
P2 diff over post-CLI effective config, P2 whole-graph cycle validation,
P2 strict/warn contexts, P3 diff edge rules + all-errors reporting.

### P17 result — bytecode cache

Status: complete. **Double disproof**: net saving ~285µs/module (compile
1102µs vs cache path 818µs; bytecode larger than source), while 7/34
corrupted images segfault and 4/34 silently misexecute (no verifier);
mlua's default "bt" load mode accepts binary chunks, violating §5.5 by
default. Mechanics (dump/load, sha256+version header provenance) proven
in case of revival. Spec issues: P1 drop the cache, P1 mandatory text-only
loads, P1 full key rule if revived.

### P18 result — model resolver

Status: complete (33 PASS). Proved: pure multi-hop resolution, load-time
cycle detection with full paths, DAG diamonds, compaction_model through the
graph, exact §7.5 failover per error kind with nested bucket rotation.
Key finding: purity + round-robin only reconcile by exporting rotation
state — resolve(config, name, &cursors) pure; Mux owns cursors (P1). Six
load-time rejection rules proven (P2/P3); DAG-duplicate dedupe decision
open for §7.5.

### P19 result — models.dev schema pin

Status: complete. Real snapshot (2026-07-16, sha256-recorded, 166
providers/5666 models) validates the translated schema; leaf-merge +
preservation hold on real shapes; 92.2% map cleanly. **Disproved**:
boundary-1 required-validation on fragments; ambiguous-primary-source
(undetectable post-parse); naive field list (cost absent on 398 models,
limit 0 on image models, tri-state flags, tiered pricing, no in-band
version). Spec issues: P1 missing-cost rule, P1 zero-limit skip rule,
P1 pin procedure (date+sha256), P2 fragment validation + taxonomy rework.

### P20 result — trace/replay contracts

Status: complete. Proved: max-speed reconstruction deep-equals live state
(leaf, fold, transcript, abort queues); dangling tail round-trips; compare
rehydrates from session registrations while traces stay byte-verified
masked; drifted tool caught. **Disproved**: §6.11's entry list rebuilds
ZERO session entries (needs SessionAppend kind, P1); "never exceeds
uncompressed size" verbatim (achievable: raw+9B/block); per-entry-inflation
wording. Pinned: block zstd 4KiB/64B-floor/raw-fallback; snapshots must
carry leaf+queues+abort flag; citation p11→p20.

### P21 result — compaction round

Status: complete (38 PASS). Proved: exact trigger boundary (±1 token),
ladder with per-step savings, one summary per pass, storage strict-prefix,
recency window untouched, iteration limit with monotone progress, nested
summary creation, masked summarizer input, cost tracked, re-entry
impossible by construction. Findings: P1 LIVELOCK REAL — pin strict
recency+reserve < threshold at config load + RecencyDominates/no-progress
guards; P2 iteration-limit reporting; P2 summarizer exempt from trigger
(else self-referential); P2 threshold expression parses two ways.

### P22 result — input queue machine

Status: complete (deterministic styled-cell snapshots, byte-identical
across runs). Proved: §8.11 visual order, distinct kinds, cycling, edit
removal, empty-resend delete, cancel-pop-then-abort. Three ambiguities
forced into rules: P1 RULE A (promote lands newest of new kind), P1 RULE B
(precise reposition: remember (kind, index), clamp; kind-changed → RULE A)
replacing "best effort", P1 RULE C (cancel-pop by enqueue time across
kinds — provably diverges from visual-bottom), P2 cancel-while-editing.

### P23 result — bus delivery

Status: complete (implemented inline; builder agent hit a session limit —
its Lua fixtures reused). Proved: registration-order synchronous delivery
across domains, inner emits join one GLOBAL FIFO after the current dispatch
(max depth 1), error isolation with emitter returning normally, plain-data
enforcement (fn/thread/fn-key/cycle/topic-charset rejected), off().
Rules pinned: teardown-mid-dispatch condemns immediately (same-dispatch
deliveries skip with diagnostic), drop deferred to the drain epilogue;
self-teardown from a handler is safe; string-keys-only payload rule.

## Campaign 4 — settle the two deferred boundaries

Planned 2026-07-16. Two decisions the spec deliberately left open now get
evidence instead of a coin flip.

## P24 — `p24-rpc-surface-projection`

### SPEC claims

- §10.2: `smith rpc` is JSON-RPC over stdio; the full method catalog is
  deferred but "expected to mirror the Lua SDK surface (§9.10) with
  mode-specific additions and omissions, rather than define an independent
  API"; `config/reload` (§9.19) is the one named method.

### Risk

The mirror claim may not hold: SDK functions that take Lua callbacks
(`tool.register`'s `execute`, `on`-event handlers, command handlers) cannot
serialize across a stdio boundary as data. If the catalog is not a clean
mirror, §10.2's deferral note is misleading and must state the real shape.

### Minimal artifact

```text
p24-rpc-surface-projection/
  Cargo.toml        (serde, serde_json)
  src/main.rs
```

A minimal BIDIRECTIONAL JSON-RPC stdio harness (line-delimited or
Content-Length framing — pick and document): a mock engine serving methods
and emitting notifications, driven by a scripted client.

### Verify

```bash
cd prototypes/p24-rpc-surface-projection
cargo run -- data-method
cargo run -- command-method
cargo run -- event-notification
cargo run -- register-tool-callback
cargo run -- classify
cargo run -- all
```

### Pass evidence

- a data method (e.g. `session/list`, `vcs/status`) round-trips
  request→response with §9.10-shaped payloads,
- a command method (`command/run`) executes and returns,
- a core event (§9.8) is delivered to the client as a server→client
  notification (the event bridge → RPC mapping),
- a client-registered tool works: `tool/register` names the tool, and its
  execution is a server→client REQUEST to the client's handler whose reply
  feeds the agent loop — proving callback-shaped SDK functions need
  bidirectional RPC, not a data mirror,
- `classify` prints the full §9.10 namespace list tagged
  MIRRORED / ADDED (driver-only, e.g. session lifecycle, prompt submit) /
  CALLBACK (needs server→client) / OMITTED (Lua-runtime-only), which becomes
  the §10.2 catalog rule.

### SPEC impact

Replace §10.2's "mirror the Lua SDK" deferral with the proven projection
rule: data/command namespaces mirror as methods; callback-taking functions
require bidirectional RPC; events are notifications; driver methods
(lifecycle, prompt submission) are RPC-only additions; Lua-runtime
internals are omitted.

## P25 — `p25-git-boundary`

### SPEC claims

- §9.5: git-URL plugin installs go through Smith's internal git boundary;
  `gix` or system-git shell-out is release engineering's choice, hidden
  behind the boundary. `gix` is already a §2.3 dependency for VCS queries
  (`blame`, `blob-diff`, `revision`).

### Risk

The decision was deferred without measuring the one number that decides it:
the INCREMENTAL cost of enabling gix's clone/fetch features on top of the
already-present feature set, versus a runtime dependency on the `git` binary.
gix clone may also drag in a network/TLS stack that dwarfs the query path.

### Minimal artifact

```text
p25-git-boundary/
  Cargo.toml        (gix with blame/blob-diff/revision — the §2.3 baseline —
                     plus a feature flag adding clone/fetch)
  src/main.rs
```

Clone a LOCAL bare repo (created in a temp dir, like p04) at a named ref
via gix, and via `git` shell-out, stripping `.git` to match §9.5 install
semantics. Real https-through-proxy clone is attempted and its result
reported, but viability rests on the local case.

### Verify

```bash
cd prototypes/p25-git-boundary
cargo run -- gix-clone-local
cargo run -- shellout-clone-local
cargo run -- gix-clone-https      # best-effort through the proxy
cargo run -- deps-report
cargo run -- all
```

### Pass evidence

- gix clones the local bare repo at a ref and strips `.git`; result matches
  the shell-out clone byte-for-byte on tracked files,
- `deps-report` prints: incremental crate count and compile-time delta of
  the clone/fetch feature set OVER the §2.3 baseline (`cargo tree` diff),
  and the release binary size delta,
- shell-out baseline works with zero added crates but needs `git` on PATH at
  runtime (documented as the cost),
- a clear recommendation with the numbers: gix (no runtime git dep, +N
  crates / +M KB) vs shell-out (runtime git dep, 0 crates).

### SPEC impact

Turn §9.5's "release engineering's choice" into a decided default with the
measured tradeoff recorded; note whether the §9.13 jj boundary (jj-lib vs jj
binary) deserves the same treatment as a follow-up.

## Campaign 4 Results

### P24 result — RPC surface projection

Status: complete (11 PASS). Proved via a bidirectional JSON-RPC 2.0 stdio
harness: data methods (`session/list`, `vcs/status`) round-trip; `command/run`
executes; a core event arrives as an id-less server→client notification; a
client-registered tool executes via a server→client `tool/execute` request
whose reply feeds the loop. **Disproved**: §10.2's "mirror the Lua SDK" — the
projection is mirror-minus-callbacks-plus-driver-methods, and origin
(mirrored/added) is orthogonal to shape (data/callback/notification).
Classification of all §9.10 primitives: 19 mirrored, 3 callback (`tool`,
`command`, `bus`), 2 omitted (`tui`, `shortcut`); driver namespace
(`session/*`, `prompt/submit`, `command/run`) is RPC-only. Folded into §10.4.
Spec issues: P1 replace the mirror deferral with the projection rule; P2 name
the two axes; P2 blocking events are requests not notifications.

### P25 result — git boundary

Status: complete. Proved: gix clones a local bare repo at a named ref
byte-for-byte identical to `git clone`, and https clone works through the
proxy. Measured incremental cost over the §2.3 gix baseline: local clone +5
first-party gix crates; https worst-case +79 crates / +13.5 MB / +59s, but the
TLS/async stack is largely already required by §2.3 `reqwest`+`tokio`.
**Disproved**: the §2.3 gix line as written (`default-features = false`, no
hash backend) fails to compile — needs `sha1` (P1). Decision: gix for installs,
no runtime `git` dependency; shell-out rejected (forces `git` on PATH). Folded
into §2.3 and §9.5. Spec issues: P1 sha1 build fix; P2 §9.5 gix default; P3
§9.13 jj boundary needs its own measurement (p26).

## P26 — `p26-jj-boundary`

### SPEC claim

§9.13: the jj integration (`jj-lib` crate vs jj-binary shell-out) is open. gix's
p25 verdict does not transfer — `jj-lib` is not already a §2.3 dependency.

### Result

Status: complete. Proved: jj-lib 0.43 builds on stable 1.94.1 (with a kstring
pin); a representative op set (init, snapshot, op-log, diff, op-restore) works
both in-process and via `jj` shell-out. Latency is decisive — in-process
op-log 0.003 ms vs a real `jj` invocation ~12.5 ms — on a subsystem run per
mutating tool. Footprint +186 crates / +8.2 MB / +~95s over an empty baseline,
much overlapping §2.3 (gix, regex, futures, serde). **Disproved**: that gix's
+5-crate verdict transfers (it is +186 here); and that jj-lib's tree respects
stable-latest as-is (transitive `kstring 2.0.3` wants rustc 1.96 → lockfile
must pin 2.0.2). Decision: embed jj-lib. Folded into §2.3 and §9.13. Spec
issues: P1 kstring pin; P2 §9.13 embed default, jj-lib API-stability caveat,
gix 0.83→0.85 alignment.

## Campaign 5 — TUI layout resolution

## P27 — `p27-per-frame-layout`

### SPEC claims

- §8.7: "Rust provides primitives; Lua defines layout."
- §8.5: the render loop ticks at 16ms; §13: TUI frame draw < 2ms.
- §12/p15: Lua runs on one dedicated plugin thread; calls into it are ~81µs
  round-trips that serialize.

### Risk

If layout resolution calls INTO Lua every frame, it puts plugin-thread
round-trips on the render hot path — fighting both the 2ms budget and the §12
thread model. The intended-but-unstated design must be validated: Lua builds
the layout tree ONCE (or on change) into owned Rust data, and Rust resolves it
to ratatui `Rect`s every frame with ZERO Lua in the loop.

### Minimal artifact

```text
p27-per-frame-layout/
  Cargo.toml        (mlua luajit vendored, ratatui — prototype-exempt deps)
  src/main.rs
```

A Lua plugin defines a layout via the §8.7 primitives; the harness converts it
once into an owned Rust `LayoutTree`; a resolver maps `(tree, terminal size) →
Rect per widget slot`, called every frame.

### Verify

```bash
cd prototypes/p27-per-frame-layout
cargo run -- build-once
cargo run -- resolve-frame
cargo run -- properties
cargo run -- invalidation
cargo run -- all
```

### Pass evidence

- the Lua-defined layout becomes owned Rust data; resolution runs with the Lua
  state uninvoked (a call counter proves zero Lua calls per frame), and works
  even after the tree is detached from Lua,
- per-frame resolution time measured at 80x24, 200x50, 400x100 for a realistic
  default tree (border panels + column of status/messages/input/hints +
  overlay) — reported, and far under 2ms,
- layout properties hold: children within parent bounds, siblings do not
  overlap, `expanded` fills the remainder, `split_ratio` honored, resolution
  deterministic for equal `(tree, size)` — the §17 property-test target,
- the tree is rebuilt only on explicit mutation (`set_center_layout` /
  `set_*_panel`); between mutations no Lua re-entry occurs.

### SPEC impact

State the §8 layout-resolution contract: Lua builds the layout tree on change
into owned Rust data; Rust resolves `Rect`s every frame as a pure,
deterministic function of `(tree, size)` with no Lua in the render loop; name
the layout property invariants as a §17 property-test target.

### Result

Status: complete. Proved: the two-phase zero-Lua-in-loop pipeline holds — a
Lua-call counter stayed flat across 10k resolves at 80×24/200×50/400×100; the
owned `LayoutTree` is `Send + 'static` (compile-asserted) and resolves
identically after `drop(lua)` on another thread; release per-frame resolution
median ~0.4µs / p99 &lt;0.8µs vs the 2ms budget; property invariants hold over
192 (tree,size) pairs. **Disproved nothing** (the "must re-enter Lua / can't
hit 2ms" counter-hypothesis is refuted). Surfaced a real gap: §8.7 had no
overlay-over-base composition operator, nor rules for tabs/scrollable/Size::Pct
— the prototype's resolutions are now the §8.7 composition rules. Folded into
§8.7 and §17.6. Spec issues: P1 resolution contract, P2 property target, P2
composition rules.

## Campaign 6 — Multi-frontend readiness

## P28 — `p28-rpc-frontend-sufficiency`

### SPEC claims

- §8 frontend boundary / §10.4: `smith rpc` is the multi-frontend boundary; an
  RPC client is a frontend peer of the TUI, consuming an adapter over the
  `EngineEvent` stream (§6.3) — non-blocking → notifications, blocking →
  requests, frontend-private omitted.
- Implicit sufficiency claim: a full alternative UI (web/native/mobile) can be
  built on the RPC surface alone.

### Risk

p24 proved the projection *mechanics*, not *sufficiency*. An `EngineEvent`
variant may carry state a real frontend must render that is unreachable over
the §10.4 surface — a completeness gap that would only surface when someone
actually builds a web UI.

### Minimal artifact

```text
p28-rpc-frontend-sufficiency/
  Cargo.toml        (serde, serde_json)
  src/main.rs
```

A mock engine emits the full `EngineEvent` stream over the RPC adapter during a
scripted complete session; a headless mock frontend client (no smith-tui code,
no Lua) consumes only the RPC surface and reconstructs everything a UI renders.

### Verify

```bash
cd prototypes/p28-rpc-frontend-sufficiency
cargo run -- classify
cargo run -- reconstruct
cargo run -- blocking-roundtrip
cargo run -- all
```

### Pass evidence

- `classify`: every `EngineEvent` variant (§6.2 AgentEvent + §6.3 harness
  events: session lifecycle, steering/follow-up, UI-state, provider/model
  change, error, shutdown) tagged `notification` / `request` /
  `frontend-private-omitted` / `MISSING`; the MISSING set is the finding,
- `reconstruct`: a scripted session (turns, streaming text/thinking deltas,
  tool calls incl. a blocking `tool_call`, steering queue, compaction/fold,
  leaf switch/tree, secret placeholders, model change, error) drives the mock
  client, whose reconstructed UI state (transcript, tool views, steering queue,
  leaf/tree, cost/context, active model) deep-equals the engine's ground truth,
  built from the RPC stream ALONE,
- `blocking-roundtrip`: a blocking `tool_call` reaches the client as a request
  and the client's reply flows back into the engine,
- verdict: the RPC surface is sufficient for a full frontend, or the exact
  MISSING variants/state are listed.

### SPEC impact

Upgrade the §10.4 completeness claim from p28-gated to proven, or add the
missing driver methods / event projections the spike finds.

### Result

Status: complete. Proved: a headless client reconstructs a full session's
`UiState` (transcript with reassembled deltas, tool views, steering queue,
tree/leaf, model, cost, fold, secret labels) deep-equal to ground truth from
the RPC stream alone; 34 EngineEvent variants classify as 25 notification / 4
request / 5 frontend-private; blocking `tool_call` round-trips; secret
plaintext never crosses the wire. **Disproved**: the sufficiency claim for
mid-session ATTACH — the live tail has no replay, so a late client cannot
rebuild the ephemeral steering queue + run status (never a session entry;
`session/dump` covers persisted state only). Folded into §10.4: added
`session/snapshot`, two notification payload guarantees (`session_compact`
span, `session_tree` node), poll-only cost/context for v1. Spec issues: P2
session/snapshot, P2 payload guarantees, P3 cost/context push.

## Reporting Template

Each completed prototype updates this plan with a result block in the
Markdown shape required by `prototypes/CLAUDE.md` (canonical:
`.claude/skills/pioneer/SKILL.md`). Result blocks recorded before
2026-07-16 use the earlier JSON shape and stand as historical records.
