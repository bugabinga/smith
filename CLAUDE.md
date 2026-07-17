# smith

Rust coding agent TUI. Phase: spec/planning. No production code until specs
are final; disposable spec-validation prototypes live under `prototypes/`
(SPEC §18).

## Architecture

```
smith/ (types, StreamFn, AgentTool, Lua, config)
  → smith-ai/ | smith-core/ | smith-tui/ (parallel)
  → smith-harness/ (wiring, plugins, SDK)
  → smith-cli/ (binary)
```

## Locked Decisions

| Decision | Rationale |
|----------|-----------|
| Latest stable Rust, ed. 2024 | Rolling MSRV follows stable compiler |
| mlua + LuaJIT | Performance, coroutines |
| CBOR sessions | Compact, binary-safe |
| Secret proxy (no keychain) | Cross-platform |
| XDG dirs | Linux standards |
| jj VCS | Modern DVCS |
| StreamFn abstraction | Decouples agent from providers |
| Lua plugins with sandbox | Safe extensibility |
| Rust widgets, Lua layout | Performance + flexibility |
| Cargo-only build system | Single entry point, no make/just/scripts |

## Source of Truth

CLAUDE.md is a navigation index. Do not mirror individual source-of-truth file
lists here; use the canonical directories and docs tree instead.

- Spec: `docs/SPEC.md` — canonical project specification.
- Research: `docs/research/` — ecosystem research and tool analysis
  (evidence, non-normative).
- Plans: `docs/plans/` — task breakdowns and documentation plans.
- Invariants: `docs/PROJECT-INVARIANTS.md` — build system, directory
  structure, coding standards, and canonical docs inventory.
- Prototypes: `prototypes/` — spec-validation prototypes and their plan.

Former `docs/design/` subsystem docs and the P1–P20 prototype report are fully
absorbed into `docs/SPEC.md` and deleted (see git history).

## Rules

1. Spec before code. No production `.rs` until `docs/SPEC.md` covers the
   work; prototype `.rs` under `prototypes/` is sanctioned by SPEC §18.
2. CLAUDE.md is the navigation index. `docs/SPEC.md` is the canonical project spec.
3. Every spec section answers: interfaces, data, errors, tests — as named
   shapes and behavior, not code. Exact only at boundaries others program
   against (files, wire formats, CLI, config, Lua SDK); code blocks are
   illustrative unless the section says otherwise.
4. Open questions: stop and ask. No guessing.
5. Invoke spec work: `/smith <topic>`. Commands are defined once,
   harness-agnostically, in `.claude/skills/<name>/SKILL.md`
   (smith, pioneer, handmade, sabotnik); `.pi/prompts/` holds thin pi
   adapters that defer to them.
6. Cargo is the sole build system. See `docs/PROJECT-INVARIANTS.md` §1.
7. Agents must not modify `docs/SPEC.md` or `docs/PROJECT-INVARIANTS.md` without approval.

## Writing commits and PRs

Commits and PRs argue the **why**, not the **what**. The diff already lists
what changed — never retype it. A message earns its place by recording the
motivation, the reasoning, and what was deliberately *not* done and why.

- **No AI attribution, ever.** No `Co-Authored-By`, no "Generated with", no
  session links, no tool bylines. These commits are the author's.
- **Subject:** one imperative line naming the decision or its effect, not the
  mechanic — "Drop the Lua bytecode cache", not "remove BytecodeCache struct".
  No ALL-CAPS verdicts, no emoji. (Prefix policy: PROJECT-INVARIANTS §7.)
- **Body:** one to three short paragraphs. The motivation, the alternative
  dropped and the single cost that killed it, and the one number or fact that
  settled it. If it wants more than that, the overflow belongs elsewhere.
- **One grep-able anchor.** Exactly one sentence naming the concrete surface
  touched — `SPEC §N`, a file, a config key, a `prototypes/pNN` dir — as a
  range or count, never a per-item roster. This is what keeps `git bisect` and
  `blame` meaningful. "Don't enumerate" is not "don't be specific."
- **Where detail lives instead:** per-file change lists → the diff; benchmark
  tables and raw measurements → the prototype dir and its `PLAN.md` result
  block; the decision plus its driving number → the commit body, in prose.
- **One commit, one decision.** If the anchor won't fit one sentence, split.
- **Banned:** superlatives, "successfully / robustly / cleanly", caps-lock
  findings, emoji, and every attribution trailer.

PRs follow `.github/pull_request_template.md`: motivation-first, one line per
section, the surface as an anchor range — the diff is the roster.
