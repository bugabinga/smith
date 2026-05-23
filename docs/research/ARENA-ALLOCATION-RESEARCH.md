# Arena Allocation Research

**Date:** 2026-05-23  
**Status:** Research notes; not requirements.

## Scope

Observed arena allocation patterns relevant to a Rust TUI/agent runtime:

- phase-local allocation,
- cyclic/self-referential data,
- handle/index arenas,
- bump allocation crates,
- virtual-memory linear arenas.

## Sources

| Source | Kind | Notes |
|--------|------|-------|
| Manish Goregaokar, “Arenas in Rust” | article | Rust lifetime model, `bumpalo`, `typed-arena`, self-referential arenas, destructor/drop-check caveats |
| LogRocket, “Guide to using arenas in Rust” | article | General arena model, common Rust crates, games/compilers/web-request examples |
| Russell Winder, “Arenas in Rust” | article | Handle arenas as deterministic, bounds-checked replacement for pointer graphs |
| `github.com/fitzgen/bumpalo` | repo | Mature bump allocator, MIT/Apache-2.0, current clone `84654ace6be4444da3ff102a0a0af3b38c4df4fb` |
| `github.com/emoon/arena-allocator` | repo | Virtual-memory linear allocator, MIT/Apache-2.0, current clone `266fd1f90c430523b08b7b76bb4ea43fd93c5896` |
| crates.io API | metadata | Version/download comparison for arena-related crates |

Local research cache:

- `~/.pi/research/pages/manishearth.github.io.blog.2021-03-15.arenas-in-rust.html`
- `~/.pi/research/pages/blog.logrocket.com.guide-using-arenas-rust.html`
- `~/.pi/research/pages/russellw.github.io.arenas.html`
- `~/.pi/research/repos/github.com.fitzgen.bumpalo/`
- `~/.pi/research/repos/github.com.emoon.arena-allocator/`

## Core model

Arena allocation groups many allocations under one lifetime/phase. Fast path:

1. reserve/chunk memory,
2. keep next-free pointer,
3. allocate by pointer bump + alignment,
4. free/reset whole group.

Observed benefits:

- fewer global allocator calls,
- lower allocator/syscall pressure,
- cheap mass deallocation,
- stable post-warmup memory profile when capacity is reused,
- bounded phase-local scratch capacity,
- better locality for phase-local objects,
- simpler cyclic structures if all participants die together.

Observed costs:

- no normal individual deallocation,
- reset invalidates everything,
- destructors may not run,
- wrong lifetime boundary creates leaks or use-after-reset bugs,
- direct references are poor persistence boundaries.

## Rust patterns

### 1. Bump arena (`bumpalo`)

Observed properties:

- heterogeneous allocation via `Bump::alloc`,
- `reset(&mut self)` frees all arena allocations en masse,
- `Bump::with_capacity`/`try_with_capacity` support pre-sizing,
- optional `collections` feature provides arena-backed `Vec`, `String`, etc.,
- optional `boxed` feature runs `Drop` for wrapped values,
- no `Drop` for plain `Bump::alloc` values,
- `Bump` is `!Sync`,
- stable Rust supported; crate is `no_std` by default.

Good fit candidates:

- per-render scratch strings/vectors,
- temporary markdown/syntax/diff formatting buffers,
- one-turn provider request assembly,
- transient plugin/layout intermediate trees.

Bad fit candidates:

- persisted session entries,
- values owning files/sockets/mmap unless explicitly dropped,
- cross-thread shared state,
- long-lived cyclic state with meaningful destructors.

### 2. Typed reference arena (`typed-arena`-style)

Observed properties:

- one type per arena,
- references can form cycles through interior mutability,
- destructors normally run when arena drops,
- cycles + custom destructors become borrow-check/drop-check hazards.

Candidate use is narrow. Direct arena references fight persistence, replay, and CBOR. Smith-like trees should prefer stable IDs/indices over `&'arena T` links.

### 3. Handle/index arena (`id_arena`, `generational-arena`, `slotmap`-style)

Observed properties:

- objects live in a vector/map,
- links are handles/indices/keys, not references,
- cycles are easy,
- bugs remain deterministic bounds/key errors, not arbitrary memory corruption,
- generational handles detect stale keys after deletion.

Good fit candidates:

- ephemeral graph structures,
- layout/widget tree construction,
- session DAG in memory if handles are separate from persisted IDs,
- plugin registry graphs.

Bad fit candidates:

- persistent storage unless handle ↔ stable ID mapping is explicit,
- generational arenas when deletion is not required.

For append-only immutable branches, plain `Vec<Entry>` + stable `EntryId` + parent index/map may beat a full arena crate.

### 4. Virtual-memory linear arena (`arena-allocator`)

Observed properties:

- reserves large virtual address ranges,
- commits/decommits pages on demand,
- `rewind` invalidates previous allocations,
- debug mode uses memory protection to catch use-after-rewind,
- API exposes unsafe allocation and safe methods that can invalidate prior returned references,
- implementation uses OS-specific unsafe code and `unwrap` in drop/protection paths,
- crate is young (`0.1.0`) with very low crates.io usage relative to `bumpalo`.

Fit for Smith: poor. Too sharp, too low-level, too much unsafe surface for current needs.

## Crate metadata snapshot

Fetched 2026-05-23 from crates.io API.

| Crate | Latest | Total downloads | Recent downloads | Repository |
|-------|--------|-----------------|------------------|------------|
| `bumpalo` | 3.20.3 | 397,043,585 | 93,582,712 | `github.com/fitzgen/bumpalo` |
| `slotmap` | 1.1.1 | 71,614,488 | 17,195,183 | `github.com/orlp/slotmap` |
| `id-arena` | 2.3.0 | 63,434,687 | 37,055,795 | `github.com/fitzgen/id-arena` |
| `typed-arena` | 2.0.2 | 61,546,744 | 11,142,653 | `github.com/SimonSapin/rust-typed-arena` |
| `elsa` | 1.11.2 | 14,198,162 | 2,347,949 | `github.com/manishearth/elsa` |
| `generational-arena` | 0.2.9 | 8,561,359 | 1,117,475 | `github.com/fitzgen/generational-arena` |
| `arena-allocator` | 0.1.0 | 1,485 | 57 | `github.com/emoon/arena-allocator` |

## Smith-specific candidates

Candidates, not mandates:

1. Default to normal Rust ownership until profiling finds allocation pressure,
   allocator-call pressure, or unstable memory profile.
2. For scratch phase allocation, evaluate `bumpalo` first.
3. Judge arenas on allocator calls, elapsed time, RSS/peak-live stability, reset
   cadence, and complexity — not only allocation-count reduction.
4. For cyclic in-memory graphs, evaluate handles/indices before direct references.
5. For persisted/session structures, keep stable IDs as primary identity; do not persist arena handles.
6. Avoid custom arenas and virtual-memory arenas unless a measured workload demands them.
7. Avoid arena-stored values with important `Drop` behavior unless teardown is explicit.

Plugin heap limits are related but distinct: `mlua::Lua` has VM memory accounting
and `set_memory_limit`. That should be tested as Lua heap quota enforcement, not
as a Rust arena allocation strategy.

Plugin reload/unload is a strong arena/domain use case. A plugin instance can own
a whole memory/resource domain: Lua state, registry handles, descriptors, render
caches, subscriptions, async cancellation token, and host-side scratch arena.
Reload becomes whole-domain replacement instead of per-resource cleanup. The hard
part is preventing escapes: callbacks, async tasks, event subscriptions, and host
registry entries must not outlive their domain.

Likely no-go cases:

- storing session history in a bump arena,
- returning arena references across async/task/thread boundaries,
- using direct `&'arena` links in serializable data,
- relying on reset while external refs may still exist,
- adding project-local unsafe arena code under current invariants.

## Edge cases found

- `Drop` + cyclic arena references can fail borrow checking or become logically invalid during destruction.
- `bumpalo` plain allocations intentionally skip destructors.
- `bumpalo::boxed::Box<T>` runs `Drop`, but boxed values should not participate in cycles.
- `Bump::reset` needs `&mut self`; this is good because active borrows block reset.
- `Bump` is not `Sync`; use per-thread arenas or a pool if ever needed.
- Stable Rust `std` allocator parameterization is still incomplete; `bumpalo::collections` or `allocator-api2` fills the gap.
- Handle arenas solve cycles but not semantic validity; stale/mismatched handles still need domain checks.
- Virtual-memory arenas can turn lifetime mistakes into use-after-rewind bugs; debug protection catches some, release may not.

## Benchmark questions

Measure before adopting:

- render-loop allocations per 16ms tick,
- markdown/syntax-highlight/diff allocation hot spots,
- session load/replay allocation volume,
- provider request construction copies,
- Lua bridge allocations and conversion costs,
- arena reset cadence and max live bytes per phase.

Minimal benchmark shape:

- compare baseline `Vec`/`String` vs `bumpalo` scratch buffers,
- record allocations with a counting allocator,
- include TUI TestBackend render snapshots,
- include one large session replay,
- include one pathological markdown/diff render.

## Working conclusion

Arena allocation is useful only at phase boundaries. Smith has obvious phase boundaries in render ticks, provider-request assembly, and temporary parsing/rendering. Smith's persistent/session model should remain ID/Vec based, not arena-reference based.

Best first experiment if needed: `bumpalo` for scratch allocation.  
Best graph shape: handles/indices + stable IDs.  
Avoid: virtual-memory linear arenas and custom unsafe arenas.
