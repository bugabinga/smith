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

test("paginated reads flatten bounded pages", async () => {
  const github = adapter(async request => {
    assert.ok(request.args.includes("--paginate"));
    assert.ok(request.args.includes("--slurp"));
    return { code: 0, signal: null, stdout: JSON.stringify([[{ id: 1 }], [{ id: 2 }]]), stderr: "" };
  });
  assert.deepEqual(await github.comments("issues", 1), [{ id: 1 }, { id: 2 }]);
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
