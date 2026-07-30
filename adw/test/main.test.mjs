import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { digestJson } from "../core.mjs";
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
  state: {},
};
const rolePolicy = {
  name: "reviewer",
  charter: ".claude/agents/reviewer.md",
  mode: "single",
  primary: "claude",
  fallback: "codex",
  providers: ["claude", "codex"],
  providerConfig: {
    claude: { model: "fixture-claude", effort: "high", timeoutSeconds: 300 },
    codex: { model: "fixture-codex", effort: "high", timeoutSeconds: 300 },
  },
  capabilities: ["pulls:read"],
  snapshot: { fields: ["pull"], maxBytes: 262144 },
  payload: { outcomes: ["negative", "noop", "positive", "unable"], requiredKeys: ["verdict"] },
  operations: ["publish_check", "terminal"],
  fallbackAuthority: { protected: false, incomplete: false, fork: false, binary: false, oversized: false },
  patch: null,
};
const payload = { verdict: "approve" };
const assessment = {
  schemaVersion: 1,
  controlSha,
  role: "reviewer",
  provider: "claude",
  model: "fixture-claude",
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

async function invoke(argv, input, fixtures = {}) {
  let out = "";
  let err = "";
  const code = await run({
    argv,
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

test("reduce accepts an explicit policy and stamped assessments", async () => {
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, rolePolicy, assessments: [assessment] }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out).status, "artifact");
  const unknown = await invoke(["reduce"], JSON.stringify({ snapshot, rolePolicy, assessments: [assessment], surprise: true }));
  assert.equal(unknown.code, 6);
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
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, rolePolicy, assessments: [unavailable] }));
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
