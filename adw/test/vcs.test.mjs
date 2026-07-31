import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { digestBytes, digestJson } from "../core.mjs";
import { defineRole } from "../roles.mjs";
import { runProcess } from "../providers.mjs";
import { applyVerifiedPatch, createDefaultVcs, verifyPatch } from "../vcs.mjs";

const exec = promisify(execFile);

async function gitPath() {
  const { stdout } = await exec("sh", ["-c", "command -v git"]);
  return realpath(stdout.trim());
}

async function git(file, args) {
  return exec(file, args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}

function role() {
  return defineRole({
    name: "builder",
    charter: ".claude/agents/builder.md",
    mode: "single",
    primary: "claude",
    fallback: "codex",
    providers: ["claude", "codex"],
    providerConfig: {
      claude: { model: "claude-model", effort: "high", timeoutSeconds: 300 },
      codex: { model: "codex-model", effort: "high", timeoutSeconds: 300 },
    },
    capabilities: ["pulls:write"],
    snapshot: { fields: ["issue"], maxBytes: 262144 },
    payload: { outcomes: ["negative", "noop", "positive", "unable"], requiredKeys: ["verdict"] },
    operations: ["create_pr", "terminal"],
    fallbackAuthority: { protected: false, incomplete: false, fork: false, binary: false, oversized: false },
    patch: { maxBytes: 4096, maxFiles: 2, allowedPrefixes: ["file.txt"], deniedPaths: ["adw/**", "docs/SPEC.md"] },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-vcs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const temporaryDirectory = join(root, "verification");
  await mkdir(repository);
  await mkdir(temporaryDirectory);
  const executable = await gitPath();
  await git(executable, ["-C", repository, "init", "-q"]);
  await git(executable, ["-C", repository, "config", "user.name", "Smith Test"]);
  await git(executable, ["-C", repository, "config", "user.email", "smith@example.invalid"]);
  await writeFile(join(repository, "file.txt"), "before\n");
  await git(executable, ["-C", repository, "add", "file.txt"]);
  await git(executable, ["-C", repository, "commit", "-qm", "base"]);
  const baseSha = (await git(executable, ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(repository, "file.txt"), "after\n");
  const patchBytes = Buffer.from((await git(executable, ["-C", repository, "diff", "--binary", "--", "file.txt"])).stdout);
  await git(executable, ["-C", repository, "checkout", "--", "file.txt"]);
  const manifest = {
    baseSha,
    digest: digestBytes(patchBytes),
    size: patchBytes.length,
    files: [{ path: "file.txt", kind: "regular", oldMode: "100644", newMode: "100644" }],
  };
  return { executable, repository, temporaryDirectory, baseSha, patchBytes, manifest };
}

test("patch verification attests exact resulting tree without target execution", async t => {
  const value = await fixture(t);
  const calls = [];
  const result = await verifyPatch({
    ...value,
    rolePolicy: role(),
    controlSha: "a".repeat(40),
    decisionDigest: "b".repeat(64),
    preconditionDigest: "c".repeat(64),
    run: async request => { calls.push(request); return runProcess(request); },
  });
  assert.equal(result.kind, "patch");
  assert.match(result.resultTree, /^[0-9a-f]{40}$/);
  assert.ok(calls.every(call => call.file === value.executable && call.args.includes("core.hooksPath=/dev/null")));
  assert.equal(calls.some(call => call.args.includes("worktree") || call.args.includes("status")), false);
  assert.ok(calls.some(call => call.args.includes("read-tree")));
  assert.ok(calls.filter(call => call.args.includes("apply")).every(call => call.args.includes("--cached")));
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
  assert.equal(await readFile(join(value.repository, "file.txt"), "utf8"), "before\n");
});

test("patch policy treats file prefixes as path boundaries", async t => {
  const value = await fixture(t);
  await assert.rejects(
    () => verifyPatch({
      ...value,
      manifest: { ...value.manifest, files: [{ ...value.manifest.files[0], path: "file.txt.evil" }] },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
    }),
    error => error?.code === "verification",
  );
});

test("patch verification rejects digest mismatch before git", async t => {
  const value = await fixture(t);
  let calls = 0;
  await assert.rejects(
    () => verifyPatch({
      ...value,
      manifest: { ...value.manifest, digest: "d".repeat(64) },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
      run: async request => { calls++; return runProcess(request); },
    }),
    error => error?.code === "verification",
  );
  assert.equal(calls, 0);
});

test("patch verification rejects NUL-bearing binary input before git", async t => {
  const value = await fixture(t);
  let calls = 0;
  const bytes = Buffer.from([0, 1, 2]);
  await assert.rejects(
    () => verifyPatch({
      ...value, patchBytes: bytes,
      manifest: { ...value.manifest, digest: digestBytes(bytes), size: bytes.length },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
      run: async request => { calls++; return runProcess(request); },
    }),
    error => error?.code === "verification" && error.message === "binary",
  );
  assert.equal(calls, 0);
});

test("default VCS reads exact control-SHA blobs and round-trips exact bounded bundles", async t => {
  const value = await fixture(t);
  await mkdir(join(value.repository, "adw"));
  await writeFile(join(value.repository, "adw", "main.mjs"), "committed\n");
  await writeFile(join(value.repository, "charter.md"), "charter\n");
  await git(value.executable, ["-C", value.repository, "add", "."]);
  await git(value.executable, ["-C", value.repository, "commit", "-qm", "control"]);
  const sha = (await git(value.executable, ["-C", value.repository, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(value.repository, "adw", "main.mjs"), "mutable\n");
  const vcs = createDefaultVcs(value.executable);
  const control = await vcs.readControl({ repository: value.repository, controlSha: sha, requiredPaths: ["charter.md"], hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false } });
  assert.equal(control.paths.find(item => item.path === "adw/main.mjs").bytes.toString(), "committed\n");
  assert.ok(control.paths.every(item => /^[0-9a-f]{40}$/.test(item.tree) && /^[0-9a-f]{40}$/.test(item.blob)));

  const bundle = await vcs.createBundle({ repository: value.repository, snapshot: { repository: { id: "1", owner: "o", name: "r", defaultBranch: "main" } }, allowedShas: [sha], hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false } });
  assert.ok(bundle.bytes.subarray(0, 15).toString().includes("git bundle"));
  assert.deepEqual(bundle.shas, [sha]);
  const materialized = join(value.temporaryDirectory, "materialized");
  const result = await vcs.materializeBundle({ bundle: bundle.bytes, directory: materialized, manifest: { target: { bundle: { digest: digestBytes(bundle.bytes), size: bundle.bytes.length }, refs: bundle.refs, shas: bundle.shas, paths: bundle.paths } }, allowedRefs: bundle.refs, allowedShas: bundle.shas, allowedPaths: bundle.paths, hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false } });
  assert.deepEqual(result, { refs: bundle.refs, shas: bundle.shas, paths: bundle.paths });
  assert.equal(await readFile(join(materialized, "adw", "main.mjs"), "utf8"), "committed\n");
});

test("default VCS rejects multi-SHA bundle aggregation before choosing HEAD", async t => {
  const value = await fixture(t);
  const vcs = createDefaultVcs(value.executable);
  await assert.rejects(
    () => vcs.createBundle({
      repository: value.repository,
      snapshot: { repository: { id: "1", owner: "o", name: "r", defaultBranch: "main" } },
      allowedShas: ["0".repeat(40), "f".repeat(40)],
      hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false },
    }),
    error => error?.code === "verification" && error.message === "manifest",
  );
});

test("default VCS creates and materializes the canonical empty bundle", async t => {
  const value = await fixture(t);
  const vcs = createDefaultVcs(value.executable);
  const bundle = await vcs.createBundle({ repository: value.repository, snapshot: { repository: { id: "1", owner: "o", name: "r", defaultBranch: "main" } }, allowedShas: [], hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false } });
  assert.equal(bundle.bytes.toString(), "# v2 git bundle\n\n");
  assert.deepEqual(bundle.refs, []);
  assert.deepEqual(bundle.paths, []);
  const directory = join(value.temporaryDirectory, "empty");
  const result = await vcs.materializeBundle({ bundle: bundle.bytes, directory, manifest: { target: { bundle: { digest: digestBytes(bundle.bytes), size: bundle.bytes.length }, refs: [], shas: [], paths: [] } }, allowedRefs: [], allowedShas: [], allowedPaths: [], hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false } });
  assert.deepEqual(result, { refs: [], shas: [], paths: [] });
});

test("default VCS captures provider worktree bytes and rejects metadata disagreement", async t => {
  const value = await fixture(t);
  await writeFile(join(value.repository, "file.txt"), "provider\n");
  const patchBytes = Buffer.from((await git(value.executable, ["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-C", value.repository, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--full-index", "--no-renames", value.baseSha, "--", "file.txt"])).stdout);
  const manifest = { baseSha: value.baseSha, digest: digestBytes(patchBytes), size: patchBytes.length, files: [{ path: "file.txt", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const vcs = createDefaultVcs(value.executable);
  const captured = await vcs.capturePatch({ repository: value.repository, baseSha: value.baseSha, manifest, rolePolicy: role(), hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false } });
  assert.deepEqual(captured.manifest, manifest);
  assert.deepEqual(captured.patchBytes, patchBytes);
  await assert.rejects(
    () => vcs.capturePatch({ repository: value.repository, baseSha: value.baseSha, manifest: { ...manifest, digest: "f".repeat(64) }, rolePolicy: role(), hardening: { hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false } }),
    error => error?.code === "verification",
  );
});

async function applyFixture(t, { reviser = false, signing = { mode: "unsigned" } } = {}) {
  const value = await fixture(t);
  const remote = join(dirname(value.repository), "remote.git");
  await git(value.executable, ["init", "--bare", "-q", remote]);
  await git(value.executable, ["-C", value.repository, "push", "-q", remote, `${value.baseSha}:refs/heads/main`]);
  if (reviser) await git(value.executable, ["-C", value.repository, "push", "-q", remote, `${value.baseSha}:refs/heads/feature`]);
  const expectedRemote = "https://github.com/octo/example.git";
  const snapshot = {
    schemaVersion: 1,
    controlSha: "a".repeat(40),
    event: { kind: reviser ? "pull_request" : "issue", action: "opened", entityId: reviser ? "7" : "1" },
    repository: { id: "42", owner: "octo", name: "example", defaultBranch: "main" },
    revisions: reviser
      ? [{ resource: "pull:7", kind: "pull", token: value.baseSha }, { resource: "ref:feature", kind: "git_ref", token: value.baseSha }]
      : [{ resource: "patch-base:main", kind: "git_ref", token: value.baseSha }],
    routing: { role: reviser ? "reviser" : "builder", mode: "single", primary: "claude" },
    state: reviser
      ? { headBranch: "feature", headSha: value.baseSha, resources: { "pull:7": { headBranch: "feature", headSha: value.baseSha, headRepository: "octo/example" } } }
      : { entityId: "1" },
  };
  const operation = reviser
    ? { type: "update_pr", prId: "7", body: "revision" }
    : { type: "create_pr", head: "feature", base: "main", title: "change", body: "body", marker: "marker" };
  const decision = {
    schemaVersion: 1, controlSha: snapshot.controlSha, snapshotDigest: digestJson(snapshot), assessmentDigests: [],
    kind: "patch", operations: [operation], patch: value.manifest,
  };
  const proof = await verifyPatch({
    ...value, controlSha: snapshot.controlSha, decisionDigest: digestJson(decision), preconditionDigest: digestJson(snapshot.revisions), rolePolicy: role(),
  });
  const calls = [];
  const translatedRun = async request => {
    calls.push(request);
    const args = request.args.map(item => item === expectedRemote ? remote : item);
    const deny = args.indexOf("protocol.file.allow=never");
    if (deny >= 0) args[deny] = "protocol.file.allow=always";
    return runProcess({ ...request, args });
  };
  const request = {
    executable: value.executable, repository: value.repository, temporaryDirectory: value.temporaryDirectory,
    expectedRemote, snapshot, decision, verification: proof, patchBytes: value.patchBytes,
    operationIndex: 0, credential: async binding => ({ value: "short-lived-secret", expiresAt: new Date(Date.now() + 600_000).toISOString(), operationDigest: binding.operationDigest }),
    signing, run: translatedRun,
  };
  return { ...value, remote, expectedRemote, snapshot, operation, decision, proof, calls, request, translatedRun };
}

test("verified patch creates one hardened non-force branch push and an operation subreceipt", async t => {
  const value = await applyFixture(t);
  const hook = join(value.repository, ".git", "hooks", "pre-push");
  const tripwire = join(dirname(value.repository), "executed");
  const targetProgram = join(dirname(value.repository), "target-program");
  await writeFile(hook, `#!/bin/sh\nprintf hook > ${JSON.stringify(tripwire)}\nexit 91\n`, { mode: 0o700 });
  await writeFile(targetProgram, `#!/bin/sh\nprintf program > ${JSON.stringify(tripwire)}\nexit 92\n`, { mode: 0o700 });
  for (const [key, item] of [
    ["credential.helper", targetProgram], ["core.fsmonitor", targetProgram], ["core.sshCommand", targetProgram],
    ["filter.evil.clean", targetProgram], ["filter.evil.smudge", targetProgram], ["commit.gpgSign", "true"],
    ["gpg.format", "ssh"], ["gpg.ssh.program", targetProgram], [`url.ext::evil.insteadOf`, value.remote],
  ]) await git(value.executable, ["-C", value.repository, "config", key, item]);
  await writeFile(join(value.repository, ".gitattributes"), "file.txt filter=evil\n");

  const poisoned = ["GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EXEC_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const saved = Object.fromEntries(poisoned.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    GIT_SSH_COMMAND: targetProgram, GIT_ASKPASS: targetProgram, SSH_ASKPASS: targetProgram,
    GIT_EXEC_PATH: dirname(targetProgram), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gpg.ssh.program", GIT_CONFIG_VALUE_0: targetProgram,
  });
  let receipt;
  try { receipt = await applyVerifiedPatch(value.request); }
  finally {
    for (const key of poisoned) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
  }
  const remoteHead = (await git(value.executable, ["--git-dir", value.remote, "rev-parse", "refs/heads/feature"])).stdout.trim();
  assert.equal(receipt.projection, "vcs_head");
  assert.equal(receipt.headSha, remoteHead);
  assert.equal(receipt.operationDigest, digestJson(value.operation));
  assert.equal(receipt.preparedRevision, receipt.afterRevision);
  const commit = (await git(value.executable, ["--git-dir", value.remote, "cat-file", "commit", remoteHead])).stdout;
  assert.match(commit, new RegExp(`^tree ${value.proof.resultTree}$`, "m"));
  assert.deepEqual([...commit.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(match => match[1]), [value.baseSha]);
  assert.match(commit, /^author smith\[bot\] <smith\[bot\]@users\.noreply\.github\.com> [0-9]+ [+-][0-9]{4}$/m);
  assert.match(commit, /^committer smith\[bot\] <smith\[bot\]@users\.noreply\.github\.com> [0-9]+ [+-][0-9]{4}$/m);
  assert.equal(commit.slice(commit.indexOf("\n\n") + 2), `ADW verified patch\n\nDecision: ${digestJson(value.decision)}\nOperation: ${digestJson(value.operation)}\n`);
  assert.doesNotMatch(commit, /^gpgsig /m);
  const pushes = value.calls.filter(call => call.args.includes("push"));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].args.includes("--force") || pushes[0].args.includes("-f"), false);
  assert.ok(pushes[0].args.includes("--atomic"));
  assert.ok(pushes[0].args.includes(`--force-with-lease=refs/heads/main:${value.baseSha}`));
  assert.equal(pushes[0].args.some(arg => arg.startsWith("+") || arg === "--force" || arg === "-f"), false);
  assert.ok(pushes[0].args.includes(`${value.baseSha}:refs/heads/main`));
  assert.ok(pushes[0].args.includes(value.expectedRemote));
  assert.ok(value.calls.every(call => call.args.includes("core.hooksPath=/dev/null") && call.args.includes("credential.helper=") && call.args.includes("protocol.file.allow=never") && call.args.includes("core.fsmonitor=false")));
  assert.ok(value.calls.every(call => !call.args.join("\0").includes("short-lived-secret")));
  const encodedCredential = Buffer.from("x-access-token:short-lived-secret").toString("base64");
  for (const call of value.calls) {
    const outsideEnvironment = JSON.stringify({ file: call.file, args: call.args, cwd: call.cwd, input: call.input });
    assert.equal(outsideEnvironment.includes("short-lived-secret") || outsideEnvironment.includes(encodedCredential), false);
    assert.equal(Object.values(call.env).includes(targetProgram), false);
    for (const [key, item] of Object.entries(call.env)) if (item === `Authorization: Basic ${encodedCredential}`) assert.match(key, /^GIT_CONFIG_VALUE_[0-9]+$/);
  }
  const remoteCalls = value.calls.filter(call => call.args.some(arg => ["ls-remote", "fetch", "push"].includes(arg)));
  assert.ok(remoteCalls.every(call => Object.keys(call.env).some(key => key.startsWith("GIT_CONFIG_KEY_")) && Object.values(call.env).some(item => item === `http.${value.expectedRemote}.extraHeader`)));
  assert.ok(remoteCalls.every(call => Object.values(call.env).includes(`Authorization: Basic ${encodedCredential}`)));
  assert.ok(value.calls.filter(call => !remoteCalls.includes(call)).every(call => !Object.values(call.env).includes(`Authorization: Basic ${encodedCredential}`)));
  assert.equal(await access(tripwire).then(() => true, () => false), false);
  assert.equal((await git(value.executable, ["-C", value.repository, "config", "--get", "http.https://github.com/.extraheader"]).then(result => result.stdout.trim(), () => "")), "");
  const persistentConfig = await readFile(join(value.repository, ".git", "config"), "utf8");
  assert.equal(persistentConfig.includes("short-lived-secret") || persistentConfig.includes(encodedCredential) || persistentConfig.includes(value.expectedRemote), false);
  const remoteConfig = await readFile(join(value.remote, "config"), "utf8");
  assert.equal(remoteConfig.includes("short-lived-secret") || remoteConfig.includes(encodedCredential) || remoteConfig.includes(value.expectedRemote), false);
  assert.equal(JSON.stringify(receipt).includes("short-lived-secret"), false);
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
  assert.equal(await readFile(join(value.repository, "file.txt"), "utf8"), "before\n");
});

test("explicit create_branch consumes its decision-bound base and attested tree", async t => {
  const value = await applyFixture(t);
  const operation = { type: "create_branch", name: "topic/explicit", baseSha: value.baseSha, treeSha: value.proof.resultTree };
  const decision = { ...value.decision, operations: [operation] };
  const proof = await verifyPatch({
    ...value, controlSha: value.snapshot.controlSha, decisionDigest: digestJson(decision), preconditionDigest: digestJson(value.snapshot.revisions), rolePolicy: role(),
  });
  const receipt = await applyVerifiedPatch({ ...value.request, decision, verification: proof });
  assert.equal(receipt.operationDigest, digestJson(operation));
  assert.equal((await git(value.executable, ["--git-dir", value.remote, "rev-parse", "refs/heads/topic/explicit"])).stdout.trim(), receipt.headSha);
});

test("verified patch retry accepts exact tree and parent after base advances regardless commit identity", async t => {
  const value = await applyFixture(t);
  const first = await applyVerifiedPatch(value.request);
  const alternate = (await runProcess({
    file: value.executable, args: ["-C", value.repository, "commit-tree", value.proof.resultTree, "-p", value.baseSha], cwd: value.repository,
    env: { PATH: dirname(value.executable), HOME: value.repository, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Other", GIT_AUTHOR_EMAIL: "other@example.invalid", GIT_COMMITTER_NAME: "Other", GIT_COMMITTER_EMAIL: "other@example.invalid", GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" },
    input: "different durable metadata\n", timeoutMs: 30_000, maxOutputBytes: 4096,
  })).stdout.trim();
  assert.notEqual(alternate, first.headSha);
  await git(value.executable, ["-C", value.repository, "push", "-q", "--force", value.remote, `${alternate}:refs/heads/feature`]);
  await git(value.executable, ["-C", value.repository, "commit", "--allow-empty", "-qm", "base advanced"]);
  const advanced = (await git(value.executable, ["-C", value.repository, "rev-parse", "HEAD"])).stdout.trim();
  await git(value.executable, ["-C", value.repository, "push", "-q", value.remote, `${advanced}:refs/heads/main`]);
  const pushes = value.calls.filter(call => call.args.includes("push")).length;
  const retry = await applyVerifiedPatch(value.request);
  assert.equal(retry.headSha, alternate);
  assert.equal(retry.afterRevision, first.afterRevision);
  assert.equal(retry.afterRevision, digestJson({ parent: value.baseSha, tree: value.proof.resultTree, signing: "unsigned" }));
  assert.equal(value.calls.filter(call => call.args.includes("push")).length, pushes);
  assert.equal(value.calls.slice(-3).some(call => call.args.includes("refs/heads/main")), false);
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
});

test("verified reviser patch advances only its decision-bound existing head with an ordinary FF push", async t => {
  const value = await applyFixture(t, { reviser: true });
  const receipt = await applyVerifiedPatch(value.request);
  assert.equal((await git(value.executable, ["--git-dir", value.remote, "rev-parse", "refs/heads/feature"])).stdout.trim(), receipt.headSha);
  assert.equal((await git(value.executable, ["--git-dir", value.remote, "rev-parse", "refs/heads/main"])).stdout.trim(), value.baseSha);
  const push = value.calls.find(call => call.args.includes("push"));
  assert.equal(push.args.includes("--atomic"), false);
  assert.deepEqual(push.args.filter(arg => arg.startsWith(`${receipt.headSha}:`)), [`${receipt.headSha}:refs/heads/feature`]);
});

test("reviser rejects forks and unbound head branch/SHA before credentials or Git", async t => {
  const value = await applyFixture(t, { reviser: true });
  const attempt = async (snapshot, message) => {
    const decision = { ...value.decision, snapshotDigest: digestJson(snapshot) };
    const proof = { ...value.proof, decisionDigest: digestJson(decision), preconditionDigest: digestJson(snapshot.revisions) };
    let credentials = 0;
    let calls = 0;
    await assert.rejects(() => applyVerifiedPatch({
      ...value.request, snapshot, decision, verification: proof,
      credential: async () => { credentials++; }, run: async () => { calls++; },
    }), error => error?.code === "verification" && error.message === message);
    assert.equal(credentials, 0);
    assert.equal(calls, 0);
  };
  const pull = value.snapshot.state.resources["pull:7"];
  await attempt({ ...value.snapshot, state: { ...value.snapshot.state, resources: { "pull:7": { ...pull, headRepository: "fork/example" } } } }, "fork");
  await attempt({ ...value.snapshot, revisions: value.snapshot.revisions.filter(revision => revision.resource !== "ref:feature") }, "operation");
  await attempt({ ...value.snapshot, revisions: value.snapshot.revisions.filter(revision => revision.resource !== "pull:7") }, "operation");
});

test("verified patch rejects stale base, stale head, and non-fast-forward races", async t => {
  const staleBase = await applyFixture(t);
  // Use a real empty commit to move the remote base without changing the attested patch.
  await git(staleBase.executable, ["-C", staleBase.repository, "commit", "--allow-empty", "-qm", "remote moved"]);
  const moved = (await git(staleBase.executable, ["-C", staleBase.repository, "rev-parse", "HEAD"])).stdout.trim();
  await git(staleBase.executable, ["-C", staleBase.repository, "push", "-q", staleBase.remote, `${moved}:refs/heads/main`]);
  await assert.rejects(() => applyVerifiedPatch(staleBase.request), error => error?.code === "stale" && error.message === "base changed");

  const createRace = await applyFixture(t);
  let createInjected = false;
  createRace.request.run = async request => {
    if (!createInjected && request.args.includes("push")) {
      createInjected = true;
      await git(createRace.executable, ["-C", createRace.repository, "commit", "--allow-empty", "-qm", "base racer"]);
      const racer = (await git(createRace.executable, ["-C", createRace.repository, "rev-parse", "HEAD"])).stdout.trim();
      await git(createRace.executable, ["-C", createRace.repository, "push", "-q", createRace.remote, `${racer}:refs/heads/main`]);
    }
    return createRace.translatedRun(request);
  };
  await assert.rejects(() => applyVerifiedPatch(createRace.request), error => error?.code === "stale" && error.message === "non-fast-forward");
  const atomic = createRace.calls.find(call => call.args.includes("push"));
  assert.ok(atomic.args.includes("--atomic"));
  assert.equal(await git(createRace.executable, ["--git-dir", createRace.remote, "rev-parse", "--verify", "refs/heads/feature"]).then(() => true, () => false), false);

  const deletedBase = await applyFixture(t);
  let deleteInjected = false;
  deletedBase.request.run = async request => {
    if (!deleteInjected && request.args.includes("push")) {
      deleteInjected = true;
      await git(deletedBase.executable, ["--git-dir", deletedBase.remote, "update-ref", "-d", "refs/heads/main"]);
    }
    return deletedBase.translatedRun(request);
  };
  await assert.rejects(() => applyVerifiedPatch(deletedBase.request), error => error?.code === "stale" && error.message === "non-fast-forward");
  assert.equal(await git(deletedBase.executable, ["--git-dir", deletedBase.remote, "rev-parse", "--verify", "refs/heads/feature"]).then(() => true, () => false), false);
  assert.equal(await git(deletedBase.executable, ["--git-dir", deletedBase.remote, "rev-parse", "--verify", "refs/heads/main"]).then(() => true, () => false), false);

  const staleHead = await applyFixture(t, { reviser: true });
  await git(staleHead.executable, ["-C", staleHead.repository, "commit", "--allow-empty", "-qm", "head moved"]);
  await writeFile(join(staleHead.repository, "file.txt"), "after\n");
  await git(staleHead.executable, ["-C", staleHead.repository, "add", "file.txt"]);
  await git(staleHead.executable, ["-C", staleHead.repository, "commit", "-qm", "right tree, wrong parent"]);
  const changed = (await git(staleHead.executable, ["-C", staleHead.repository, "rev-parse", "HEAD"])).stdout.trim();
  await git(staleHead.executable, ["-C", staleHead.repository, "push", "-q", "--force", staleHead.remote, `${changed}:refs/heads/feature`]);
  await assert.rejects(() => applyVerifiedPatch(staleHead.request), error => error?.code === "stale" && error.message === "head changed");

  const raced = await applyFixture(t, { reviser: true });
  let injected = false;
  raced.request.run = async request => {
    if (!injected && request.args.includes("push")) {
      injected = true;
      await git(raced.executable, ["-C", raced.repository, "commit", "--allow-empty", "-qm", "racer"]);
      const racer = (await git(raced.executable, ["-C", raced.repository, "rev-parse", "HEAD"])).stdout.trim();
      await git(raced.executable, ["-C", raced.repository, "push", "-q", "--force", raced.remote, `${racer}:refs/heads/feature`]);
    }
    return raced.translatedRun(request);
  };
  await assert.rejects(() => applyVerifiedPatch(raced.request), error => error?.code === "stale" && error.message === "non-fast-forward");
  assert.equal(raced.calls.filter(call => call.args.includes("push")).length, 1);
  assert.deepEqual(await readdir(raced.temporaryDirectory), []);
});

test("verified patch signing executes only the explicit path and is cryptographically verified", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = join(root, "key");
  const actualSigner = await realpath((await exec("sh", ["-c", "command -v ssh-keygen"])).stdout.trim());
  const signer = join(root, "explicit-signer");
  const signerLog = join(root, "signer.log");
  const tripwire = join(root, "target-program");
  const tripwireLog = join(root, "target.log");
  await writeFile(signer, `#!/bin/sh\nprintf signer\\n >> ${JSON.stringify(signerLog)}\nexec ${JSON.stringify(actualSigner)} "$@"\n`, { mode: 0o700 });
  await writeFile(tripwire, `#!/bin/sh\nprintf target > ${JSON.stringify(tripwireLog)}\nexit 93\n`, { mode: 0o700 });
  await exec(actualSigner, ["-q", "-t", "ed25519", "-N", "", "-C", "smith-test", "-f", key]);
  const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
  const value = await applyFixture(t, { signing: { mode: "signed", format: "ssh", signerPath: signer, keyPath: key, principal: "smith-test", publicKey } });
  await git(value.executable, ["-C", value.repository, "config", "gpg.format", "ssh"]);
  await git(value.executable, ["-C", value.repository, "config", "gpg.ssh.program", tripwire]);
  await git(value.executable, ["-C", value.repository, "config", "commit.gpgSign", "true"]);
  const receipt = await applyVerifiedPatch(value.request);
  const commit = (await git(value.executable, ["--git-dir", value.remote, "cat-file", "commit", receipt.headSha])).stdout;
  assert.match(commit, /^gpgsig /m);
  assert.ok((await readFile(signerLog, "utf8")).trim().split("\n").length >= 1);
  assert.equal(await access(tripwireLog).then(() => true, () => false), false);
  assert.ok(value.calls.some(call => Object.values(call.env).includes(signer)));
  await assert.rejects(() => applyVerifiedPatch({ ...value.request, signing: { mode: "signed", format: "ssh", signerPath: "ssh-keygen", keyPath: key, principal: "smith-test", publicKey } }), error => error?.code === "verification");
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
});

test("patch cleanup failure is terminal and overrides an otherwise successful push", async t => {
  const value = await applyFixture(t);
  let denied = false;
  value.request.run = async request => {
    const result = await value.translatedRun(request);
    if (!denied && request.args.includes("ls-remote") && value.calls.some(call => call.args.includes("push"))) {
      denied = true;
      await chmod(value.temporaryDirectory, 0o000);
    }
    return result;
  };
  try {
    await assert.rejects(() => applyVerifiedPatch(value.request), error => error?.code === "terminal" && error.message === "cleanup");
  } finally {
    await chmod(value.temporaryDirectory, 0o700);
  }
  assert.equal(denied, true);
});

test("patch application rejects unbound bytes and remote before credentials or git", async t => {
  const value = await applyFixture(t);
  let credentials = 0;
  let calls = 0;
  await assert.rejects(() => applyVerifiedPatch({
    ...value.request, expectedRemote: "https://github.com/octo/other.git", credential: async () => { credentials++; },
    run: async request => { calls++; return value.translatedRun(request); },
  }), error => error?.code === "verification" && error.message === "remote");
  assert.equal(credentials, 0);
  assert.equal(calls, 0);
  await assert.rejects(() => applyVerifiedPatch({ ...value.request, patchBytes: Buffer.from("changed") }), error => error?.code === "verification");
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
});

test("patch verification cleans worktree after malformed diff", async t => {
  const value = await fixture(t);
  await assert.rejects(
    () => verifyPatch({
      ...value,
      patchBytes: Buffer.from("not a diff\n"),
      manifest: { ...value.manifest, digest: digestBytes(Buffer.from("not a diff\n")), size: 11 },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
    }),
    error => error?.code === "verification",
  );
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
});
