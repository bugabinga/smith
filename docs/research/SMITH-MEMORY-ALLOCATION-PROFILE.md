# Smith Memory Allocation Profile Estimate

**Date:** 2026-05-23  
**Status:** Estimate from `docs/SPEC.md` + local Pi JSONL session metadata. No session content quoted.

## Method

Inputs:

- Smith SPEC: session model, CBOR append log, agent events, virtual scrolling, TUI widgets, provider request assembly.
- Pi sessions under `/home/me/.local/state/pi/sessions` treated as if they were Smith sessions.
- Analysis read JSONL structure and string lengths only; no content was copied into this document.

Pi corpus:

- sessions: 535,
- date span observed in filenames: 37 active days,
- total JSONL bytes: 414,521,993 B ≈ 395.3 MiB,
- bad JSONL lines: 0.

## Session size distribution

| Metric | p50 | p75 | p90 | p95 | p99 | max | mean |
|--------|----:|----:|----:|----:|----:|----:|-----:|
| file bytes | 88 KiB | 683 KiB | 1.5 MiB | 3.1 MiB | 9.2 MiB | 29.2 MiB | 757 KiB |
| entries/lines | 36 | 211 | 559 | 822 | 1,930 | 5,157 | 195 |
| string chars | 76k | 582k | 1.4M | 2.8M | 8.0M | 27.2M | 649k |
| duration | 3.0 min | 63 min | 4.5 h | 15.6 h | 40.9 h | 98.1 h | 2.4 h |

Large-session counts:

- ≥1 MB: 101 sessions,
- ≥5 MB: 18 sessions,
- ≥10 MB: 5 sessions.

Busiest observed day: 87 new sessions.

## Entry mix

Global entry counts:

| Entry type | Count |
|------------|------:|
| `message` | 101,003 |
| `model_change` | 808 |
| `thinking_level_change` | 578 |
| `custom` | 555 |
| `session` | 535 |
| `custom_message` | 342 |
| `session_info` | 317 |
| `compaction` | 131 |

Message roles:

| Role | Count | Total chars | Mean chars/message |
|------|------:|------------:|-------------------:|
| `toolResult` | 49,149 | 142,292,078 | 2,895 |
| `assistant` | 47,079 | 83,687,447 | 1,778 |
| `user` | 4,624 | 1,401,645 | 303 |
| `bashExecution` | 157 | 0 | 0 |

Content block counts:

| Block | Count |
|-------|------:|
| `text` | 63,967 |
| `toolCall` | 49,337 |
| `thinking` | 28,977 |
| `image` | 44 |

Per-message payloads:

| Metric | p50 | p75 | p90 | p95 | p99 | max | mean |
|--------|----:|----:|----:|----:|----:|----:|-----:|
| JSONL bytes/message | 1.1 KiB | 2.9 KiB | 5.8 KiB | 10.2 KiB | 46.6 KiB | 4.6 MiB | 4.0 KiB |
| chars/message | 503 | 2,230 | 4,848 | 8,666 | 30,905 | 540,641 | 2,251 |
| blocks/message | 1 | 2 | 2 | 2 | 4 | 140 | 1.4 |

## Compaction observations

- Sessions with compaction: 63 / 535.
- Compactions/session: p50 0, p90 1, p99 5, max 11.
- `tokensBefore`: p50 247k, p75 266k, p90 272k, p95 277k, max 282k.

Implication: allocation stress clusters around long sessions near context-window limits, not normal short sessions.

## Estimated Smith persistent storage

Smith stores length-prefixed CBOR, not JSONL. Rough storage estimate:

- JSON key overhead disappears/reduces strongly in CBOR,
- text/tool output bytes remain dominant,
- expected CBOR session size ≈ 60–85% of Pi JSONL size for text-heavy entries,
- corpus would likely be ≈ 237–336 MiB as CBOR instead of 395 MiB JSONL.

Worst observed Pi session as Smith CBOR:

- file: ≈ 18–25 MiB,
- in-memory loaded session: ≈ 30–45 MiB depending on `String` capacity, `Vec` overhead, indexes, and cached render state.

Typical Smith loaded session:

- p50: < 1 MiB resident,
- p75: 1–2 MiB resident,
- p95: 4–8 MiB resident,
- p99: 12–20 MiB resident.

Loading every session fully would be wasteful: estimated resident memory ≈ 0.7–1.2 GiB. Smith should index metadata lazily and load only active/replayed sessions.

## Allocation hot spots by subsystem

### Session load/replay

Expected allocations:

- one `Vec<SessionEntry>` growth per loaded session,
- one `String` allocation per content block / id / metadata text,
- parent/child indexes (`HashMap<EntryId, usize>`, child lists),
- preservation buffers for unknown future entries.

Dominant bytes: tool results and assistant/thinking text, not entry structs.

Candidate optimization:

- pre-size entries from frame count where possible,
- intern repeated provider/model/tool names only if measured,
- lazy decode large content blocks for history browsing if necessary,
- keep session discovery metadata separate from full session load.

Arena fit: poor for persisted entries. Sessions need stable IDs, replay, unknown-entry preservation, and long lifetimes.

### Provider request construction

Expected allocations:

- select context entries,
- clone/transform message text and tool schemas into provider request shape,
- secret proxy scan/replace may allocate rewritten strings,
- JSON tool args/definitions allocate maps/strings.

Dominant bytes: selected context window, often 100k–300k tokens near compaction.

Arena fit: possible for temporary request assembly only if provider API can borrow from scratch lifetime. Async stream boundary likely forces owned request data. Measure before adding arenas.

### TUI render / virtual scroll

Expected allocations:

- visible-window message formatting,
- markdown parse/render intermediates,
- syntax highlight spans,
- diff view lines/spans,
- wrapped text buffers,
- tool result collapsed/expanded summaries.

Dominant cadence: 16ms render tick. Reallocating formatted strings/spans every tick is riskier than session storage size.

Arena fit: best candidate, but only for per-frame scratch buffers and only if widgets do not retain references after frame.

### Agent event streaming

Expected allocations:

- many small text/thinking deltas,
- growing assistant message buffer,
- tool-call argument accumulation,
- event fanout to session/TUI/hooks.

Optimization candidates:

- accumulate deltas in one `String` with capacity growth,
- avoid creating one session entry per tiny delta,
- TUI incremental append instead of full rerender parse where possible.

Arena fit: weak. Streaming state crosses awaits and event consumers.

### Lua/plugin bridge

Expected allocations:

- Rust ↔ Lua value conversion,
- plugin hook return values,
- render descriptor tables,
- tool schemas/config tables.

Arena fit: unlikely. mlua owns Lua values; use lifecycle/cache discipline instead.

## Practical profile

Expected Smith steady state:

- idle TUI + current normal session: tens of MiB RSS mostly from terminal/UI/libs/Lua, not session entries,
- active long session: +10–50 MiB for session + render/request buffers,
- provider request at compaction threshold: temporary spike proportional to selected context, likely +20–100 MiB depending provider serialization,
- pathological large tool output/render: single-line or single-message allocation can reach MiB scale.

Memory policy candidates:

1. Lazy-load full sessions; discovery reads only metadata.
2. Never store session history in arenas.
3. Benchmark render/request scratch before adding `bumpalo`.
4. Put hard output-size and render-size tests in prototypes.
5. Virtual scroll must bound per-frame work by visible rows, not total entries.
6. Compaction/request construction needs peak-memory measurement, not only CPU timing.

## Arena / allocator decision estimate

Arenas likely help only where allocation lifetime is phase-bounded. They do not
solve dominant persisted text bytes.

Arena value is broader than allocation-count reduction:

- fewer global allocator calls → lower allocator/syscall pressure,
- stable peak/live memory after repeated phases,
- predictable reset cadence,
- bounded scratch capacity growth,
- easier bulk discard of temporary render/request objects.

Recommended prototype gates:

- baseline must measure allocation count, allocated bytes, peak live bytes,
  post-warmup live-memory plateau, elapsed time, and allocator-call pressure;
- use `/proc/self/statm` RSS sampling on Linux for stable-memory checks;
- `bumpalo` variant only for render/request scratch;
- keep/drop decision can pass by allocation reduction OR lower allocator-call
  pressure OR materially flatter post-warmup memory profile, without lifetime/API
  complexity.

Plugin heap limiting is a separate allocator/control use case. `mlua::Lua`
exposes `used_memory()` and `set_memory_limit(limit_bytes)`, which should be
prototyped against Smith's locked `mlua + LuaJIT` feature set. This is not
`bumpalo`; it is Lua VM heap quota enforcement.

Plugin reload is the broader arena/domain use case. A per-plugin domain can own
Lua state plus host-side plugin allocations/caches/subscriptions. Dropping the
domain on reload gives predictable reclamation and avoids bespoke cleanup graphs,
provided no callback/task/registry handle can escape its domain.
