import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { canonicalBytes, digestBytes, digestJson } from "../core.mjs";
import { execute, readBounded, run } from "../main.mjs";

const controlSha = "a".repeat(40);
const headSha = "b".repeat(40);
const snapshot = {
  schemaVersion: 1,
  controlSha,
  event: { kind: "pull_request", action: "synchronize", entityId: "42" },
  repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
  revisions: [{ resource: "pull:42", kind: "pull", token: headSha }],
  routing: { role: "reviewer", mode: "single", primary: "claude" },
  state: { entityId: "42", headSha, labels: [] },
};
const payload = { verdict: "approve", risk: "none", findings: [] };
const assessment = {
  schemaVersion: 1,
  controlSha,
  role: "reviewer",
  provider: "claude",
  model: "claude-opus-4-8",
  idempotencyKey: "pr:42:head:review",
  snapshotDigest: digestJson(snapshot),
  cliVersion: "1.0.0",
  run: { id: "run", job: "claude", attempt: 1 },
  outcome: "positive",
  payload,
  payloadDigest: digestJson(payload),
  patch: null,
  startedAt: "2026-07-28T10:00:00.000Z",
  completedAt: "2026-07-28T10:00:01.000Z",
};

async function invoke(argv, input, fixtures = {}, env = {}) {
  let out = "";
  let err = "";
  const code = await run({
    argv,
    env,
    stdin: input,
    stdout: { write: value => { out += value; } },
    stderr: { write: value => { err += value; } },
    readFixture: async name => {
      if (!Object.hasOwn(fixtures, name)) throw new Error("fixture not found");
      return fixtures[name];
    },
  });
  return { code, out, err };
}

test("validate emits canonical JSON", async () => {
  const result = await invoke(["validate", "snapshot"], JSON.stringify(snapshot));
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.deepEqual(JSON.parse(result.out), snapshot);
  assert.ok(result.out.endsWith("\n"));
});

test("reduce derives canonical policy from the stamped role", async () => {
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [assessment] }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out).kind, "state");
  assert.ok(JSON.parse(result.out).operations.some(value => value.type === "publish_check"));
  const unknown = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [assessment], surprise: true }));
  assert.equal(unknown.code, 6);
});

test("reduce binds patch sidecar bytes before emitting patch decision", async () => {
  const bytes = Buffer.from("x");
  const patch = { baseSha: headSha, digest: digestBytes(bytes), size: 1, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const envelope = data => ({ trust: "untrusted", source: "fixture", bytes: canonicalBytes(data).length, digest: digestJson(data), data });
  const buildSnapshot = { ...snapshot, event: { kind: "issue", action: "labeled", entityId: "1" }, revisions: [{ resource: "base", kind: "git_ref", token: headSha }], routing: { role: "builder", mode: "single", primary: "claude" }, state: { entityId: "1", labels: [], input: {}, headBranch: "claude/issue-1", baseBranch: "main", title: envelope("Build"), body: envelope("Closes #1") } };
  const buildPayload = { verdict: "patch", summary: "Build", patch };
  const buildAssessment = { ...assessment, role: "builder", model: "claude-opus-4-8", snapshotDigest: digestJson(buildSnapshot), payload: buildPayload, payloadDigest: digestJson(buildPayload), patch };
  const request = { snapshot: buildSnapshot, assessments: [{ assessment: buildAssessment, patchBase64: bytes.toString("base64") }] };
  const result = await invoke(["reduce"], JSON.stringify(request));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out).kind, "patch");
  assert.equal((await invoke(["reduce"], JSON.stringify({ snapshot: buildSnapshot, assessments: [buildAssessment] }))).code, 6);
});

test("reconcile accepts normalized state", async () => {
  const scheduled = {
    ...snapshot,
    event: { kind: "schedule", action: "reconcile", entityId: "repository" },
    state: { currentRevisions: {} },
  };
  const result = await invoke(["reconcile"], JSON.stringify({
    snapshot: scheduled,
    routes: [],
    pulls: [],
    labelSync: { wantedDigest: "f".repeat(64), liveDigest: "f".repeat(64) },
    comments: [], trust: { ownerIds: ["U_owner"], appId: "A_smith" },
    reviews: [], pioneers: [], holds: [],
  }));
  assert.deepEqual(JSON.parse(result.out), []);
});

test("stdin fixture commands ignore operational and unknown environment", async () => {
  const result = await invoke(["validate", "snapshot"], JSON.stringify(snapshot), {}, { ADW_CONTROL_SHA: "f".repeat(40), GH_TOKEN: "ignored" });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out), snapshot);
});

test("partial operational reduce environment never falls through to legacy stdin", async () => {
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [assessment] }), {}, { ADW_CONTROL_SHA: controlSha });
  assert.equal(result.code, 6);
  assert.equal(result.out, "");
  assert.match(JSON.parse(result.err).message, /ADW_SOURCE_ARTIFACT/);
});

test("fixture reads are basename-only", async () => {
  const good = await invoke(["validate", "snapshot", "--fixture", "snapshot.json"], "", { "snapshot.json": JSON.stringify(snapshot) });
  assert.equal(good.code, 0);
  const bad = await invoke(["validate", "snapshot", "--fixture", "../snapshot.json"], "", {});
  assert.equal(bad.code, 2);
});

test("errors use stable exit classes and sanitized JSON", async () => {
  const invalidSnapshot = await invoke(["validate", "snapshot"], "{}");
  assert.equal(invalidSnapshot.code, 2);
  assert.equal(JSON.parse(invalidSnapshot.err).error, "contract");
  const invalidAssessment = await invoke(["validate", "assessment"], "{}");
  assert.equal(invalidAssessment.code, 6);
  const unsupported = await invoke(["explode"], "{}");
  assert.equal(unsupported.code, 2);
  const unknownRecord = await invoke(["validate", "banana"], "{}");
  assert.equal(unknownRecord.code, 2);
  const malformedArtifact = await invoke(["reduce"], "{");
  assert.equal(malformedArtifact.code, 6);
});

test("provider failure and pending fallback use provider exit status", async () => {
  const unavailable = { ...assessment, outcome: "unable" };
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [unavailable] }));
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.out).status, "fallback");
});

test("executable path sanitizes oversized stdin", async () => {
  let err = "";
  const code = await execute({
    argv: ["validate", "snapshot"],
    stdin: Readable.from([Buffer.alloc(262145)]),
    stdout: { write() {} },
    stderr: { write: value => { err += value; } },
    readFixture: async () => "",
  });
  assert.equal(code, 2);
  assert.equal(JSON.parse(err).error, "input");

  err = "";
  const artifactCode = await execute({
    argv: ["reduce"],
    stdin: Readable.from([Buffer.alloc(262145)]),
    stdout: { write() {} },
    stderr: { write: value => { err += value; } },
    readFixture: async () => "",
  });
  assert.equal(artifactCode, 6);
});

test("stdin reader stops at the transport ceiling", async () => {
  await assert.rejects(
    () => readBounded(Readable.from([Buffer.alloc(262144), Buffer.from("x")])),
    error => error?.code === "input",
  );
  assert.equal(await readBounded(Readable.from(["{}"])), "{}");
});
