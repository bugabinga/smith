import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestBytes, planReconciliation, validateAssessment, validateSnapshot } from "../core.mjs";
import { deterministicSnapshotPlan, normalizeEvent, roleSnapshotPlan } from "../github.mjs";
import { run, writeDryRunArtifact } from "../main.mjs";
import { defineRole } from "../roles.mjs";

const controlSha = "a".repeat(40);
const repository = {
  id: "R_1", name: "smith", full_name: "bugabinga/smith", default_branch: "main", owner: { login: "bugabinga" },
};
const sender = { id: 7, login: "bugabinga", type: "User" };
const request = {
  schemaVersion: 1,
  controlSha,
  eventName: "pull_request",
  event: {
    action: "synchronize",
    repository,
    sender,
    pull_request: { number: 2, head: { sha: "b".repeat(40), repo: { full_name: "bugabinga/smith" } }, base: { ref: "main" }, updated_at: "2026-07-28T00:00:00Z" },
  },
  repository: "bugabinga/smith",
  repositoryPath: "/checkout",
  live: false,
  operations: [{ type: "comment", entityId: "I_1", body: "body", marker: "m1" }],
};

function io(input, head = controlSha) {
  let out = "";
  let err = "";
  let artifact;
  const intents = [];
  return {
    options: {
      argv: ["dry-run", "--output", "/artifacts"],
      stdin: JSON.stringify(input),
      stdout: { write: value => { out += value; } },
      stderr: { write: value => { err += value; } },
      readFixture: async () => "",
      adapters: {
        vcs: { head: async path => { assert.equal(path, "/checkout"); return head; } },
        githubFactory: () => ({
          record: operation => intents.push(operation),
          intents: () => intents,
          readSnapshot: async () => ({ repository: { id: "1" }, entity: { id: "2" } }),
        }),
      },
      writeArtifact: async (directory, bytes, digest) => { artifact = { directory, bytes, digest }; },
    },
    result: () => ({ out, err, artifact }),
  };
}

test("offline dry-run emits canonical intent artifact without external reads", async () => {
  const state = io(request);
  assert.equal(await run(state.options), 0);
  const { out, err, artifact } = state.result();
  assert.equal(err, "");
  const value = JSON.parse(out);
  assert.equal(value.controlSha, controlSha);
  assert.equal(value.event.kind, "pull_request");
  assert.deepEqual(value.intents, request.operations);
  assert.equal(artifact.directory, "/artifacts");
  assert.equal(artifact.digest, digestBytes(artifact.bytes));
  assert.deepEqual(JSON.parse(artifact.bytes), value);
});

test("live dry-run reads only bounded event state", async () => {
  const state = io({ ...request, live: true });
  assert.equal(await run(state.options), 0);
  assert.deepEqual(JSON.parse(state.result().out).snapshot.live, { repository: { id: "1" }, entity: { id: "2" } });
});

test("dry-run fails on unknown input or control drift", async () => {
  const unknown = io({ ...request, surprise: true });
  assert.equal(await run(unknown.options), 2);
  const stale = io(request, "f".repeat(40));
  assert.equal(await run(stale.options), 3);
  const mixed = io({ ...request, repository: "other/repository" });
  assert.equal(await run(mixed.options), 2);
});

test("artifact writer refuses existing output-file symlinks", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repository");
  const output = join(root, "output");
  const victim = join(root, "victim");
  await mkdir(repositoryPath);
  await mkdir(output);
  await writeFile(victim, "safe");
  await symlink(victim, join(output, "dry-run.json"));
  await assert.rejects(() => writeDryRunArtifact(output, Buffer.from("{}"), "a".repeat(64), repositoryPath));
  assert.equal(await readFile(victim, "utf8"), "safe");
});

test("checked-in fixtures satisfy their executable contracts", async () => {
  const load = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  validateSnapshot(await load("reviewer-snapshot.json"));
  defineRole(await load("reviewer-policy.json"));
  for (const assessment of await load("reviewer-assessments.json")) validateAssessment(assessment);
  planReconciliation(await load("reconcile.json"));
  for (const item of await load("events/cases.json")) normalizeEvent(item.name, { ...item.body, repository, sender });
  for (const plan of await load("snapshots/plans.json")) assert.deepEqual(roleSnapshotPlan(plan.role, plan.event).fields, plan.fields);
  assert.deepEqual(deterministicSnapshotPlan("label-sync", "schedule").fields, ["labels"]);
});
