import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AdwError } from "../core.mjs";
import { createGitHub, normalizeEvent } from "../github.mjs";

const repository = {
  id: "R_1",
  name: "smith",
  full_name: "bugabinga/smith",
  default_branch: "main",
  owner: { login: "bugabinga" },
};
const sender = { id: 7, login: "bugabinga", type: "User" };

test("GitHub events normalize into forge-neutral records", async () => {
  const cases = JSON.parse(await readFile(new URL("./fixtures/events/cases.json", import.meta.url)));
  for (const item of cases) {
    const value = normalizeEvent(item.name, { ...item.body, repository, sender });
    assert.equal(value.kind, item.kind, item.name);
    assert.equal(value.entityId, item.entity, item.name);
    assert.deepEqual(value.repository, { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" });
    assert.deepEqual(value.actor, { id: "7", login: "bugabinga", type: "User" });
  }
});

test("event normalization rejects unsupported or incomplete events", () => {
  assert.throws(() => normalizeEvent("deployment", { repository, sender }), error => error?.code === "contract");
  assert.throws(() => normalizeEvent("issues", { action: "opened", sender, issue: { number: 1 } }), error => error?.code === "contract");
});

function adapter(run, token = "token") {
  return createGitHub({
    repository: "bugabinga/smith",
    token,
    appIdentity: { id: "A_1", login: "smith[bot]" },
    ghPath: process.execPath,
    run,
    baseEnv: { PATH: "/trusted/bin", HOME: "/tmp/home", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  });
}

test("adapter rejects repository traversal segments", () => {
  assert.throws(
    () => createGitHub({ repository: "../smith", token: null, appIdentity: { id: "A", login: "bot" }, ghPath: process.execPath, run: async () => {}, baseEnv: {} }),
    error => error?.code === "contract",
  );
});

test("closed reads use exact gh argv and environment", async () => {
  const calls = [];
  const github = adapter(async request => {
    calls.push(request);
    return { code: 0, signal: null, stdout: JSON.stringify({ id: 1 }), stderr: "" };
  });
  assert.deepEqual(await github.repository(), { id: 1 });
  assert.deepEqual(calls[0].args, ["api", "--method", "GET", "/repos/bugabinga/smith"]);
  assert.equal(calls[0].env.GH_TOKEN, "token");
  assert.equal(calls[0].env.GH_HOST, "github.com");
  assert.equal(Object.hasOwn(calls[0].env, "CLAUDE_CODE_OAUTH_TOKEN"), false);
  assert.equal(github.get, undefined);
});

test("paginated reads stop without gh auto-pagination", async () => {
  let page = 0;
  const github = adapter(async request => {
    page++;
    assert.equal(request.args.includes("--paginate"), false);
    assert.match(request.args.at(-1), /per_page=100&page=\d+$/);
    const records = page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }];
    return { code: 0, signal: null, stdout: JSON.stringify(records), stderr: "" };
  });
  assert.equal((await github.comments("issues", 1)).length, 101);
  assert.equal(page, 2);
});

test("workflow run pagination unwraps GitHub collection objects", async () => {
  const github = adapter(async () => ({ code: 0, signal: null, stdout: JSON.stringify({ workflow_runs: [{ id: 1 }] }), stderr: "" }));
  assert.deepEqual(await github.runs(), [{ id: 1 }]);
});

test("live snapshot dispatches and normalizes the event entity", async () => {
  const github = adapter(async request => {
    const endpoint = request.args.at(-1);
    if (endpoint === "/repos/bugabinga/smith") {
      return { code: 0, signal: null, stdout: JSON.stringify({ id: 1, owner: { login: "bugabinga" }, name: "smith", default_branch: "main" }), stderr: "" };
    }
    assert.equal(endpoint, "/repos/bugabinga/smith/pulls/2");
    return { code: 0, signal: null, stdout: JSON.stringify({ id: 2, head: { sha: "b".repeat(40) }, state: "open" }), stderr: "" };
  });
  const event = normalizeEvent("pull_request", {
    action: "synchronize", repository, sender,
    pull_request: { number: 2, head: { sha: "b".repeat(40), repo: { full_name: "bugabinga/smith" } }, base: { ref: "main" }, updated_at: "2026-07-28T00:00:00Z" },
  });
  assert.deepEqual(await github.readSnapshot(event), {
    repository: { id: "1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
    entity: { id: "2", headSha: "b".repeat(40), state: "open" },
  });
});

test("HTTP failures become sanitized forge classes", async () => {
  for (const [status, reason] of [[404, "not_found"], [401, "auth"], [403, "forbidden"], [429, "rate_limit"], [500, "server"]]) {
    const github = adapter(async () => { throw new AdwError("provider", "exit", { httpStatus: status }); });
    await assert.rejects(() => github.repository(), error => error?.code === "forge" && error.message === reason);
  }
});

test("dry-run recorder deduplicates closed operations without gh", async () => {
  let calls = 0;
  const github = adapter(async () => { calls++; return { code: 0, signal: null, stdout: "{}", stderr: "" }; });
  const operation = { type: "comment", entityId: "I_1", body: "body", marker: "m1" };
  github.record(operation);
  github.record(operation);
  assert.deepEqual(github.intents(), [operation]);
  assert.equal(calls, 0);
  assert.throws(() => github.record({ type: "publish_everything" }), error => error?.code === "contract");
  assert.ok(Object.isFrozen(github.capabilities()));
});
