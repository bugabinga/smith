# ADW Credential-Isolated Adapters and Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded GitHub, VCS, and provider adapters plus a read-only dry-run without granting the inert Phase 1 core production authority.

**Architecture:** Three leaf modules own all external effects: `providers.mjs` owns shell-free process/provider execution, `github.mjs` owns `gh` and GitHub event/API details, and `vcs.mjs` owns `git` worktrees and structural patch attestation. `main.mjs` composes injected adapters; production writes remain disabled and legacy workflows remain authoritative.

**Tech Stack:** Node.js ESM/standard library, `node:test`, `gh`, `git`, exact-pinned Claude/Codex npm CLI packages.

**Roadmap:** `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`

**Phase:** Phase 2: Credential-Isolated Adapters and Dry-Run

---

## File map

- `adw/providers.mjs`: bounded `spawn` runner, temporary CLI install/auth homes, Claude/Codex invocation, envelope stamping, cleanup.
- `adw/github.mjs`: GitHub event normalization, bounded `gh api` reads, typed failures, pagination, capability declaration, dry-run mutation recorder.
- `adw/vcs.mjs`: hardened `git` runner, clean detached worktrees, structural patch apply, resulting-tree attestation, cleanup.
- `adw/main.mjs`: compose fixture/live read-only adapters and expose `dry-run`; no production mutation command.
- `adw/test/providers.test.mjs`: process, install, credential, timeout, output, schema, and cleanup tests.
- `adw/test/github.test.mjs`: event, argv/stdin, pagination, identity, typed failure, and dry-run tests.
- `adw/test/vcs.test.mjs`: real temporary-repository patch verification and cleanup tests.
- `adw/test/dry-run.test.mjs`: fixture and injected live-read CLI scenarios.
- `.github/workflows/adw-selftest.yml`: unchanged command already discovers new `*.test.mjs` files.

### Task 1: Shell-free bounded process boundary

**Files:**

- Create: `adw/providers.mjs`
- Create: `adw/test/providers.test.mjs`

- [ ] **Step 1: Write failing process-runner tests**

Test `runProcess(request, spawnImpl)` with an injected fake child and one real `process.execPath -e` control. Exact request:

```js
{
  file: "/absolute/program",
  args: ["--flag"],
  cwd: "/absolute/work",
  env: { PATH: "/trusted/bin", HOME: "/tmp/home", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  input: "bounded stdin",
  timeoutMs: 300000,
  maxOutputBytes: 262144,
}
```

Assert `shell: false`, `windowsHide: true`, piped stdin/stdout/stderr, exact argv/env, output capture, nonzero exit classification, spawn error, timeout/abort, stdout/stderr overflow, and no inherited `GH_TOKEN`, provider credential, SSH agent, or arbitrary process env.

- [ ] **Step 2: Run and verify RED**

Run: `node --test adw/test/providers.test.mjs`

Expected: FAIL because `adw/providers.mjs` does not exist.

- [ ] **Step 3: Implement `runProcess`**

Use `spawn(file, args, { cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })`. Reject non-absolute `file`/`cwd`, non-string argv/env/input, timeout outside 1–300,000 ms, and output limits outside 1–1,048,576 bytes. On timeout/overflow, send SIGTERM then SIGKILL to the detached process group (`process.kill(-pid, ...)`) or child on Windows; clear timers/listeners and await close in `finally`. Throw `AdwError("provider", reason)` with only `spawn|timeout|exit|output`; retain numeric exit/signal in `details`, never stderr text.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test adw/test/providers.test.mjs`

Expected: PASS.

```bash
git add adw/providers.mjs adw/test/providers.test.mjs
git commit -S -m "Add the bounded provider process boundary"
```

### Task 2: Exact-pinned provider installation and assessment

**Files:**

- Modify: `adw/providers.mjs`
- Modify: `adw/test/providers.test.mjs`

- [ ] **Step 1: Write failing provider tests**

Assert exported immutable pins:

```js
{
  claude: { package: "@anthropic-ai/claude-code", version: "2.1.220", executable: "claude" },
  codex: { package: "@openai/codex", version: "0.145.0", executable: "codex" },
}
```

Test `installProvider({ provider, prefix, npmPath, repository, runProcess })` requires absolute real paths, rejects `prefix` inside/symlinked into `repository`, uses the prefix parent as isolated cwd, and emits exactly `<absolute-npm> install --prefix <prefix> --no-save --package-lock=false <package>@<version>`, then verifies the temporary executable reports the exact version. No package metadata may be created under the repository.

Test `invokeProvider` with injected runner/filesystem:

- Claude argv includes `-p`, `--output-format json`, `--json-schema`, configured model, and no `--bare`; env includes only base allowlist plus `CLAUDE_CODE_OAUTH_TOKEN`.
- Codex receives caller credential `CODEX_AUTH_JSON` only as MJS input; MJS creates absolute outside-repository `<home>/.codex/auth.json` mode 0600, sets `HOME` and `CODEX_HOME=<home>/.codex`, invokes `exec` with model/effort, `--output-schema`, `--output-last-message`, and prompt, then removes the complete home in `finally` on success/failure/abort.
- Neither receives `GH_TOKEN`, `GITHUB_TOKEN`, opposite-provider secret, inherited HOME, or SSH agent.
- Malformed/oversized/missing payload, wrong schema outcome, version failure, auth/429 exit, timeout, and cleanup failure return sanitized provider failure.
- Success stamps schema version, role/provider/model, control SHA, snapshot/idempotency/payload digests, CLI version, run identity, and timestamps; provider output cannot set envelope fields.

- [ ] **Step 2: Run and verify RED**

Run: `node --test --test-name-pattern='install|Claude|Codex|envelope' adw/test/providers.test.mjs`

Expected: FAIL because provider APIs are missing.

- [ ] **Step 3: Implement install/auth/invocation**

Use temporary prefixes/homes supplied by caller, validate their `realpath` parent is outside the repository realpath, then use `mkdir`/`writeFile`/`chmod`/`rm` from `node:fs/promises` and the Task 1 runner. Parse only the schema-constrained final payload, cap prompt/schema/payload at 256 KiB, validate outcome/payload against the supplied frozen role policy, and call `validateAssessmentArtifact` before returning. Installation runs with no provider/forge secret. Provider invocation receives exactly one provider credential; missing/extra credential keys fail before spawn.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test adw/test/providers.test.mjs`

Expected: PASS with no network access because all commands/filesystem are injected.

```bash
git add adw/providers.mjs adw/test/providers.test.mjs
git commit -S -m "Isolate exact-pinned provider assessments"
```

### Task 3: Read-only GitHub adapter and dry-run recorder

**Files:**

- Create: `adw/github.mjs`
- Create: `adw/test/github.test.mjs`
- Create: `adw/test/fixtures/events/*.json`

- [ ] **Step 1: Write failing event and API tests**

Test `normalizeEvent(name, payload)` for issue, issue-comment, pull-request, review, review-comment, check/workflow, push, schedule, Dependabot/code-scanning alert, and dispatch fixtures. Output is exact `{ kind, action, entityId, repository, actor, revisionHints }`; absent IDs/repository/action and unsupported events throw `AdwError("contract", ...)`.

Test `createGitHub({ repository, token, appIdentity, ghPath, runProcess })`:

- repository is exact `owner/name`, `ghPath` absolute, host fixed to `github.com`, and App login/ID explicit; `/user` and caller-selected hosts/paths are impossible;
- closed methods `repository()`, `issue(number)`, `pull(number)`, `comments(kind, number)`, and `runs()` construct only `/repos/<owner>/<repo>/...` GET endpoints; no generic credentialed `get(path)` exists;
- methods invoke absolute `gh` with `api --method GET`, `--paginate --slurp` only where fixed by that method, and env limited to `GH_TOKEN`, `GH_HOST=github.com`, `NO_COLOR`, `PATH`, `HOME`, `LANG`, `TMPDIR`;
- pagination flattens pages deterministically and enforces 100 pages/10,000 records/1 MiB;
- 404, auth, rate limit, server, malformed JSON, and overflow become distinct sanitized `AdwError("forge", reason)` values;
- `capabilities()` is frozen and advertises Phase 2 read capabilities only;
- `record(operation)` validates the closed operation, stores canonical deduplicated intents, and never invokes `gh`.

- [ ] **Step 2: Run and verify RED**

Run: `node --test adw/test/github.test.mjs`

Expected: FAIL because `adw/github.mjs` does not exist.

- [ ] **Step 3: Implement the adapter**

Keep every `gh`, `GH_TOKEN`, GitHub event key, closed endpoint, pagination flag, and App identity field in this file. Use injected `runProcess`; never concatenate shell commands. `readSnapshot(event)` dispatches only to the closed methods above and reads repository metadata plus the event entity; Phase 3 adds role-specific expansion. Mutator methods do not exist in Phase 2—only `record` and `intents`.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test adw/test/github.test.mjs`

Expected: PASS.

```bash
git add adw/github.mjs adw/test/github.test.mjs adw/test/fixtures/events
git commit -S -m "Bound GitHub reads behind one adapter"
```

### Task 4: Structural VCS patch attestation

**Files:**

- Create: `adw/vcs.mjs`
- Create: `adw/test/vcs.test.mjs`

- [ ] **Step 1: Write failing VCS tests**

Create a temporary real Git repository with one committed file using `mkdtemp`; never clone. Test `verifyPatch({ repository, baseSha, patchBytes, manifest, rolePolicy, temporaryDirectory, runProcess })`:

- all git calls use absolute executable, `-c core.hooksPath=/dev/null`, disabled system/global config, no credential helper, and `shell:false`;
- repository, temporary parent, worktree, and patch-file parents are canonicalized with `realpath`; temporary/worktree/patch paths must be outside and not symlinked into the repository/control tree;
- detached clean worktree is created under that external temporary parent, patch bytes are written beside—not inside—the worktree, `git apply --check --index` then `git apply --index` run, and `git write-tree` supplies `resultTree`;
- exact patch digest/size/manifest/base are checked before git; after apply, `git diff --cached --raw -z` paths/modes plus binary detection are parsed and must exactly equal the manifest before attestation;
- malformed diff, wrong base, traversal, binary/symlink/submodule/protected path, mode/file/size overflow, dirty result, and git failure produce `AdwError("verification", reason)`;
- no target file, hook, build, test, or executable runs;
- worktree and patch are removed in `finally`, including failure paths.

- [ ] **Step 2: Run and verify RED**

Run: `node --test adw/test/vcs.test.mjs`

Expected: FAIL because `adw/vcs.mjs` does not exist.

- [ ] **Step 3: Implement `verifyPatch`**

Use `validatePatchManifest` and `digestBytes`; use only `git worktree add --detach`, `git apply`, `git diff --cached --raw -z`, `git write-tree`, `git status --porcelain`, and `git worktree remove --force`. Return a Phase 1 `validateVerification` record. The adapter accepts no token/env secret and enforces the realpath containment rules from Step 1 before writing.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test adw/test/vcs.test.mjs`

Expected: PASS on the local temporary repository.

```bash
git add adw/vcs.mjs adw/test/vcs.test.mjs
git commit -S -m "Attest patches without executing target code"
```

### Task 5: Fixture/live read-only dry-run composition

**Files:**

- Modify: `adw/main.mjs`
- Create: `adw/test/dry-run.test.mjs`
- Modify: `docs/super/plans/2026-07-28-adw-mjs-control-plane-phase-2-adapters-dry-run.md`

- [ ] **Step 1: Write failing dry-run tests**

Add exact command input:

```js
{
  "schemaVersion": 1,
  "controlSha": "<40 hex>",
  "eventName": "pull_request",
  "event": {},
  "repository": "bugabinga/smith",
  "repositoryPath": "/absolute/checkout",
  "live": false,
  "operations": []
}
```

Test `run({ argv: ["dry-run", "--output", absoluteDirectory], stdin, stdout, stderr, readFixture, adapters })` and existing `--fixture <basename>` handling. It normalizes the event, asks injected VCS for the trusted checkout HEAD and requires exact `controlSha`, optionally asks injected GitHub for bounded reads when `live:true`, validates/records operations without writes, and emits exact `{ schemaVersion: 1, controlSha, event, snapshot, intents }`. It writes those exact canonical bytes to `<output>/dry-run.json` and their SHA-256 hex plus newline to `<output>/dry-run.sha256`; stdout repeats the JSON. Unknown keys, fixture escape, output/repository containment, live mode without authenticated read adapter, control-SHA drift, forge failure, and any attempted mutator fail closed. Provider invocation is absent.

Test checked-in event fixtures through the real normalizer and checked-in reviewer/reconcile fixtures through current validators so fixture drift fails CI.

- [ ] **Step 2: Run and verify RED**

Run: `node --test adw/test/dry-run.test.mjs`

Expected: FAIL because `dry-run` is unsupported.

- [ ] **Step 3: Implement dry-run composition**

Extend the existing `run(io)` object with `adapters: { githubFactory, vcs }` and `writeArtifact`; do not change its calling convention. Default executable adapters are imported only for `dry-run`. Offline fixture mode uses injected VCS/head and requires no env/secrets or subprocess; live mode uses absolute `gh`/`git` paths and may use existing local GitHub auth or `GH_TOKEN` for closed GET methods only. Output directory must be absolute, external to the repository realpath, and created by the injected writer. No `apply` or mutating GitHub/VCS method is exposed in Phase 2.

- [ ] **Step 4: Run the phase verification**

Run:

```bash
node --test adw/test/*.test.mjs
bash .github/adw/gate-labels.test.sh
bash .github/adw/reconcile-builder-routes.test.sh
bash .github/adw/workflow-contract.test.sh
git diff --check
git grep -n 'GH_TOKEN\|GITHUB_TOKEN\|gh api' -- adw ':!adw/github.mjs' ':!adw/test'
git grep -n 'git ' -- adw ':!adw/vcs.mjs' ':!adw/test'
```

Expected: all tests pass; both boundary greps print nothing; no package manifest/lockfile exists; no production workflow invokes the new control plane except self-test.

- [ ] **Step 5: Record result and commit**

Mark completed checkboxes and append exact Node/legacy test counts, commit range, and dry-run evidence. State explicitly that writes, production role parity, wrappers, and authority remain deferred.

```bash
git add adw/main.mjs adw/test/dry-run.test.mjs docs/super/plans/2026-07-28-adw-mjs-control-plane-phase-2-adapters-dry-run.md
git commit -S -m "Expose the read-only ADW dry-run"
```
