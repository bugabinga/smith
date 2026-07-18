# p34-ci-pipeline

One prototype, three SPEC claims that only a real CI toolchain can settle:

- **§14 cross-build** (was P30, tooling-gated): does the heavy native tree
  (vendored LuaJIT via `mlua`, `gix`) cross-compile to the required musl and
  Windows triples through `cargo-zigbuild`? `cross/` is a minimal bin pulling
  those deps; the `cross-build` job attempts the §14 matrix and reports the
  first per-target link/build error.
- **§11 arch-gate** (was P32, tooling-gated): can `cargo-pup` on the pinned
  nightly express and enforce a forbidden inter-crate edge? `archgate/` is a
  tiny 3-crate workspace with a `pup.ron` forbidding `wcore -> wai`. The job
  proves the gate PASSES the legal graph and FAILS once the edge is injected.
  The same job runs the stable-metadata fallback (`§3.5 xtask arch`) so §11 has
  an enforcement path even if `cargo-pup` proves unusable.
- **§13.1 cold-build sub-budget + §17.10 hermeticity**: the `prototypes` job
  builds and tests every existing prototype crate on a clean runner and records
  per-crate wall-clock — the first real cold-build numbers the §13.1 budget is
  meant to be seeded from, and a check that the mocked-everything test policy
  actually runs green with no TTY / no network.

The workflow lives at `.github/workflows/ci-prototype.yml`. It is temporary
evidence, not the production pipeline: it targets the prototype crates because
no production crate exists yet (spec/planning phase). Result block: `../PLAN.md`.
