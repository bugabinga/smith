# Research Sources

External project checkouts are not stored in this repository. Sparse clones live
under `~/.pi/research/repos/`. This file records what to clone and why.

## Tier 1 — Excellent Rust Code Samples

Agents may consult Tier 1 sources for Rust style, API shape, tests, and project
organization. Add only projects worth emulating.

| Project | URL | Revision | Sparse paths | Why |
|---------|-----|----------|--------------|-----|
| _TBD_ | | | | |

## Tier 2 — Candidates for Inclusion or Learning

Agents may use Tier 2 sources to evaluate libraries, extract ideas, or write
research. Agents must not copy their style into Smith production code by default.

| Project | URL | Revision | Sparse paths | Question |
|---------|-----|----------|--------------|----------|
| `bumpalo` | https://github.com/fitzgen/bumpalo | `84654ace6be4444da3ff102a0a0af3b38c4df4fb` | full shallow clone | Evaluate mature bump allocation for phase-local scratch memory |
| `arena-allocator` | https://github.com/emoon/arena-allocator | `266fd1f90c430523b08b7b76bb4ea43fd93c5896` | full shallow clone | Evaluate virtual-memory linear allocation risks/tradeoffs |
| _TBD_ | | | | |

## Checkout Convention

Use paths under `~/.pi/research/repos/`:

```text
~/.pi/research/repos/{host}.{owner}.{repo}/
```

For sparse checkout, record exact paths and revision in this file. Do not commit
the checkout.
