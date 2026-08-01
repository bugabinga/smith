import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controlSnapshotPlan, roleSnapshotPlan } from "../github.mjs";
import { ARTIFACT_LAYOUT } from "../main.mjs";
import { listRoles, role } from "../roles.mjs";

const wrapperDirectory = new URL("../../prototypes/p38-adw-disposable/wrappers/", import.meta.url);
const names = ["adw-issues.yml", "adw-pulls.yml", "adw-maintenance.yml"];
const paths = Object.fromEntries(names.map(name => [name, new URL(name, wrapperDirectory)]));
const ACTIONS = Object.freeze({
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  upload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  download: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  appToken: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
});
const assessmentOnlyBoundary = `## MJS assessment-only boundary

When \`adw/main.mjs\` invokes this charter, analyze only the normalized snapshot and return only JSON matching the supplied schema. Do not call GitHub, commit, push, open, close, label, comment on, dispatch, rerun, or merge forge objects, and do not claim those effects occurred. For patch roles, edits in the tokenless assessment checkout are proposed patch bytes only; tokenless verification and the serialized App-token apply job own all effects. Return \`noop\` when no canonical operation is warranted.`;
const charterArtifacts = new Map([
  [".claude/agents/adw-doctor.md", "proposed health finding/issue or noop"],
  [".claude/agents/builder.md", "proposed patch manifest+bytes, summary, or blocked/noop"],
  [".claude/agents/dependency-manager.md", "proposed verdict/comment/label operations or noop"],
  [".claude/agents/docs-writer.md", "proposed docs patch or noop"],
  [".claude/agents/planner.md", "proposed issue/milestone operations or noop"],
  [".claude/agents/reviewer.md", "structured approve/reject findings only"],
  [".claude/agents/security-reviewer.md", "structured risk/findings only"],
  [".claude/agents/steerer.md", "bounded comment recommendation or noop"],
  [".claude/agents/surveyor.md", "proposed next work-order or noop"],
  [".claude/agents/sweeper.md", "proposed maintenance operations or noop"],
  [".claude/agents/triager.md", "structured triage body/labels or noop"],
  [".claude/skills/pioneer/SKILL.md", "proposed prototype patch and proof verdict or noop"],
]);
const commands = new Set([
  "node adw/main.mjs prepare",
  "node adw/main.mjs assess --provider claude",
  "node adw/main.mjs assess --provider codex",
  "node adw/main.mjs reduce",
  "node adw/main.mjs reconcile",
  "node adw/main.mjs audit",
  "node adw/main.mjs verify",
  "node adw/main.mjs apply",
]);

const expectedPermissions = {
  schemaVersion: 1,
  installationPermissions: {
    actions: "write", administration: "read", checks: "write", contents: "write", issues: "write",
    metadata: "read", pull_requests: "write", security_events: "read", vulnerability_alerts: "read",
  },
  mintedTokenPermissions: {
    "prepare-issue": {
      capabilities: ["contents:read", "issues:read", "pulls:read", "repository:read"],
      permissions: { contents: "read", issues: "read", metadata: "read", pull_requests: "read" },
    },
    "prepare-maintenance": {
      capabilities: ["actions:read", "alerts:read", "checks:read", "contents:read", "issues:read", "pulls:read", "repository:read", "settings:read"],
      permissions: { actions: "read", administration: "read", checks: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read", security_events: "read", vulnerability_alerts: "read" },
    },
    "prepare-pull": {
      capabilities: ["actions:read", "checks:read", "contents:read", "issues:read", "pulls:read", "repository:read"],
      permissions: { actions: "read", checks: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read" },
    },
    "apply-issue-code": {
      capabilities: ["contents:write", "issues:write", "pulls:write", "repository:read"],
      permissions: { contents: "write", issues: "write", metadata: "read", pull_requests: "write" },
    },
    "apply-issue-state": {
      capabilities: ["contents:read", "issues:write", "pulls:read", "repository:read"],
      permissions: { contents: "read", issues: "write", metadata: "read", pull_requests: "read" },
    },
    "apply-maintenance-audit": {
      capabilities: ["checks:write", "contents:read", "issues:write", "pulls:write", "repository:read", "settings:read"],
      permissions: { administration: "read", checks: "write", contents: "read", issues: "write", metadata: "read", pull_requests: "write" },
    },
    "apply-maintenance-reconcile": {
      capabilities: ["actions:write", "checks:write", "contents:read", "issues:write", "pulls:read", "repository:read"],
      permissions: { actions: "write", checks: "write", contents: "read", issues: "write", metadata: "read", pull_requests: "read" },
    },
    "apply-pull-code": {
      capabilities: ["contents:write", "issues:write", "pulls:write", "repository:read"],
      permissions: { contents: "write", issues: "write", metadata: "read", pull_requests: "write" },
    },
    "apply-pull-state": {
      capabilities: ["checks:write", "contents:write", "issues:write", "pulls:write", "repository:read"],
      permissions: { checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write" },
    },
  },
  jobTokenPermissions: {
    apply: { contents: "read" }, evidence: {}, prepare: { contents: "read" }, provider: {}, reconcile: { contents: "read" }, reduce: {}, verify: {},
  },
};

function sourceLines(source) {
  assert.equal(source.includes("\t"), false, "workflow YAML must not contain tabs");
  return source.replace(/\r\n/g, "\n").split("\n");
}

function indentedBlock(source, header, indentation = 0) {
  const lines = sourceLines(source);
  const prefix = " ".repeat(indentation);
  const start = lines.findIndex(line => line === `${prefix}${header}:`);
  assert.notEqual(start, -1, `missing ${header} block`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith(`${prefix} `))) end++;
  return lines.slice(start, end).join("\n");
}

function jobs(source) {
  const block = indentedBlock(source, "jobs");
  const lines = block.split("\n");
  const starts = [];
  for (let index = 1; index < lines.length; index++) if (/^  [a-z][a-z0-9-]*:$/.test(lines[index])) starts.push(index);
  const result = new Map();
  for (const [position, start] of starts.entries()) {
    const name = lines[start].trim().slice(0, -1);
    result.set(name, lines.slice(start, starts[position + 1] ?? lines.length).join("\n"));
  }
  return result;
}

function runCommands(source) {
  return sourceLines(source).filter(line => /^\s+run:/.test(line)).map(line => line.slice(line.indexOf("run:") + 4).trim());
}

function actionUses(source) {
  return sourceLines(source).map(line => /^\s+(?:-\s+)?uses:\s*(\S+)\s*$/.exec(line)?.[1]).filter(Boolean);
}

function actionInputKeys(block, action) {
  const lines = block.split("\n");
  const result = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(`uses: ${action}`)) continue;
    const useIndent = lines[index].match(/^\s*/)[0].length;
    const stepIndent = lines[index].trimStart().startsWith("- ") ? useIndent : useIndent - 2;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const indentation = lines[cursor].match(/^\s*/)[0].length;
      if (lines[cursor].trim() && indentation <= stepIndent) break;
      const inline = /^\s+with:\s*\{(.*)\}\s*$/.exec(lines[cursor]);
      if (inline) for (const match of inline[1].matchAll(/(?:^|,\s*)([a-z][a-z0-9-]*):/g)) result.push(match[1]);
      if (!/^\s+with:\s*$/.test(lines[cursor])) continue;
      const withIndent = indentation;
      for (cursor++; cursor < lines.length; cursor++) {
        const inputIndent = lines[cursor].match(/^\s*/)[0].length;
        if (lines[cursor].trim() && inputIndent <= withIndent) { cursor--; break; }
        const key = /^\s+([a-z][a-z0-9-]*):/.exec(lines[cursor]);
        if (key) result.push(key[1]);
      }
    }
  }
  return result;
}

function uploadNames(block) {
  const lines = block.split("\n");
  const result = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(`uses: ${ACTIONS.upload}`)) continue;
    for (let cursor = index + 1; cursor < lines.length && !/^\s+- /.test(lines[cursor]); cursor++) {
      const match = /(?:^\s+name:\s*|\{name:\s*)"?([a-z0-9-]+)/.exec(lines[cursor]);
      if (match) { result.push(match[1]); break; }
    }
  }
  return result;
}

function permissionBlock(block) {
  const lines = block.split("\n");
  const empty = lines.find(line => /^\s+permissions:\s*\{\}\s*$/.test(line));
  if (empty) return {};
  const start = lines.findIndex(line => /^\s+permissions:\s*$/.test(line));
  assert.notEqual(start, -1, "job permissions are missing");
  const indentation = lines[start].match(/^\s*/)[0].length;
  const value = {};
  for (let index = start + 1; index < lines.length; index++) {
    const current = lines[index].match(/^\s*/)[0].length;
    if (lines[index].trim() && current <= indentation) break;
    const pair = /^\s+([a-z-]+):\s*(read|write)\s*$/.exec(lines[index]);
    if (pair) value[pair[1]] = pair[2];
  }
  return value;
}

function exactPermissionContract(value) {
  assert.deepEqual(value, expectedPermissions);
}

async function sources() {
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(paths[name], "utf8")])));
}

test("permission contract has three exact, non-conflated layers and rejects supersets", async () => {
  const value = JSON.parse(await readFile(new URL("../permissions.json", import.meta.url), "utf8"));
  exactPermissionContract(value);
  const rank = { read: 1, write: 2 };
  const mapped = { actions: ["actions"], alerts: ["security_events", "vulnerability_alerts"], checks: ["checks"], contents: ["contents"], issues: ["issues"], pulls: ["pull_requests"], repository: ["metadata"], settings: ["administration"] };
  const union = {};
  for (const token of Object.values(value.mintedTokenPermissions)) {
    assert.deepEqual([...token.capabilities].sort(), token.capabilities, "capabilities must be canonical");
    const derived = {};
    for (const capability of token.capabilities) {
      const [name, level] = capability.split(":");
      assert.ok(mapped[name]);
      for (const permission of mapped[name]) if (!derived[permission] || rank[level] > rank[derived[permission]]) derived[permission] = level;
    }
    assert.deepEqual(Object.fromEntries(Object.entries(derived).sort()), token.permissions, "minted scope is not exact");
    for (const [name, level] of Object.entries(token.permissions)) if (!union[name] || rank[level] > rank[union[name]]) union[name] = level;
  }
  assert.deepEqual(Object.fromEntries(Object.entries(union).sort()), value.installationPermissions);
  assert.equal(Object.values(value.jobTokenPermissions).some(layer => Object.hasOwn(layer, "metadata")), false, "job and App permission vocabularies are conflated");
  for (const mutate of [
    copy => { copy.installationPermissions.packages = "read"; },
    copy => { copy.mintedTokenPermissions["apply-issue-state"].permissions.packages = "read"; },
    copy => { copy.jobTokenPermissions.provider.contents = "read"; },
  ]) {
    const copy = structuredClone(value); mutate(copy);
    assert.throws(() => exactPermissionContract(copy));
  }
});

test("active charters enforce the assessment-only boundary and exclude release-manager", async () => {
  const roleNames = listRoles();
  assert.equal(roleNames.includes("release-manager"), false);
  const charterPaths = [...new Set(roleNames.map(name => role(name).charter))].sort();
  assert.equal(charterPaths.includes(".claude/agents/release-manager.md"), false);
  assert.deepEqual(charterPaths, [...charterArtifacts.keys()].sort());
  for (const charterPath of charterPaths) {
    const charter = await readFile(new URL(`../../${charterPath}`, import.meta.url), "utf8");
    assert.ok(charter.includes(assessmentOnlyBoundary), `${charterPath} lacks the exact assessment-only boundary`);
    assert.ok(charter.includes(charterArtifacts.get(charterPath)), `${charterPath} lacks its exact proposed artifact semantics`);
  }
  assert.doesNotMatch(Object.values(await sources()).join("\n"), /release-manager/i);
});

test("candidate wrappers are inactive, complete, and physically below 400 lines", async () => {
  const values = await sources();
  for (const name of names) {
    await access(paths[name]);
    await assert.rejects(() => access(new URL(`../../.github/workflows/${name}`, import.meta.url)));
  }
  const lineCount = Object.values(values).reduce((sum, source) => sum + sourceLines(source).length - 1, 0);
  assert.ok(lineCount < 400, `combined candidate YAML is ${lineCount} lines`);
});

test("wrappers expose only exact triggers and semantically named lanes", async () => {
  const values = await sources();
  const issueOn = indentedBlock(values["adw-issues.yml"], "on");
  for (const trigger of ["workflow_call:", "repository_dispatch:", "issues:", "issue_comment:"]) assert.match(issueOn, new RegExp(`^  ${trigger.replace(":", "\\:")}`, "m"));
  assert.match(issueOn, /types:\s*\[retry_route, fallback_route, retry_pioneer\]/);
  assert.doesNotMatch(issueOn, /workflow_dispatch/);
  const pullOn = indentedBlock(values["adw-pulls.yml"], "on");
  for (const trigger of ["repository_dispatch:", "pull_request_target:", "pull_request_review:", "pull_request_review_comment:", "check_run:", "check_suite:"]) assert.match(pullOn, new RegExp(`^  ${trigger.replace(":", "\\:")}`, "m"));
  assert.match(pullOn, /types:\s*\[run_review\]/);
  assert.doesNotMatch(pullOn, /^  pull_request:/m);
  assert.doesNotMatch(pullOn, /workflow_dispatch/);
  const maintenanceOn = indentedBlock(values["adw-maintenance.yml"], "on");
  for (const trigger of ["push:", "schedule:", "dependabot_alert:", "code_scanning_alert:", "repository_dispatch:", "workflow_dispatch:"]) assert.match(maintenanceOn, new RegExp(`^  ${trigger.replace(":", "\\:")}`, "m"));
  assert.match(maintenanceOn, /repository_dispatch:\n    types:\s*\[run_obligation\]/);
  assert.match(maintenanceOn, /lane:\s*\{description:[^}]*type:\s*choice, options:\s*\[audit, reconcile\]\}/);
  assert.match(maintenanceOn, /branches:\s*\[main\]/);
  assert.doesNotMatch(maintenanceOn, /\btags(?:-ignore)?\s*:/);
  assert.doesNotMatch(Object.values(values).join("\n"), /\brelease(?:s|[-_ ]manager)?\b/i);
  assert.ok(jobs(values["adw-pulls.yml"]).has("pull-event-lane"));
  assert.ok(jobs(values["adw-maintenance.yml"]).has("maintenance-event-lane"));
  assert.match(values["adw-pulls.yml"], /pull-reconcile/);
  assert.match(values["adw-maintenance.yml"], /maintenance-(?:reconcile|audit)/);
  assert.match(values["adw-issues.yml"], /^run-name: "\$\{\{ github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.smith_operation_digest \|\| format\('ADW issue #\{0\}', github\.event\.issue\.number\) \}\}"$/m);
  assert.match(values["adw-pulls.yml"], /^run-name: "\$\{\{ github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.smith_operation_digest \|\|.*\}\}"$/m);
  assert.match(values["adw-maintenance.yml"], /^run-name: "\$\{\{ github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.smith_operation_digest \|\|.*\}\}"$/m);
  assert.doesNotMatch(Object.values(values).join("\n"), /inputs\.smith_operation_digest/);
  assert.match(values["adw-maintenance.yml"], /cron:\s*'7 \*\/6 \* \* \*'/);
  assert.doesNotMatch(Object.values(values).join("\n"), /cancel-in-progress:\s*true/);
});

test("wrapper event truth table prevents provider loops and reserves manual dispatch for owner controls", async () => {
  const values = await sources();
  const issue = values["adw-issues.yml"];
  const pull = values["adw-pulls.yml"];
  const maintenance = values["adw-maintenance.yml"];
  const prepare = jobs(issue).get("prepare");
  const pullLane = jobs(pull).get("pull-event-lane");
  const maintenanceLane = jobs(maintenance).get("maintenance-event-lane");

  for (const value of ["ready", "codex", "needs:prototype", "needs:breakdown"]) assert.match(prepare, new RegExp(`github\\.event\\.label\\.name == '${value.replace(":", "\\:")}'`));
  assert.match(prepare, /github\.event\.action != 'labeled'.*'triager'/s);
  assert.match(prepare, /github\.event_name == 'issues'.*github\.event\.action == 'labeled'.*\('ready'|'ready'.*'codex'.*'needs:prototype'.*'needs:breakdown'/s);
  assert.match(prepare, /github\.event_name == 'issue_comment'.*github\.event\.sender\.id == github\.event\.repository\.owner\.id.*github\.event\.sender\.type == 'User'/s);
  assert.doesNotMatch(prepare, /contains\(github\.event\.comment\.body/);
  assert.match(prepare, /github\.event_name == 'repository_dispatch'.*APP_BOT_USER_ID|github\.event\.sender\.id == fromJSON\(vars\.APP_BOT_USER_ID\)/s);
  assert.match(prepare, /github\.event_name == 'issue_comment'.*'steerer'/s);
  assert.match(prepare, /github\.event\.label\.name == 'codex'.*'codex-builder'/s);
  assert.match(prepare, /github\.event\.label\.name == 'needs:prototype'.*'pioneer'/s);
  assert.match(prepare, /github\.event\.label\.name == 'needs:breakdown'.*'planner'/s);
  assert.match(prepare, /github\.event\.label\.name == 'ready'.*'builder'/s);

  for (const handoff of ["changes-requested", "reviewed"]) assert.match(pullLane, new RegExp(`github\\.event\\.label\\.name == '${handoff}'`));
  for (const roleName of ["reviewer", "reviser", "security-reviewer", "docs-writer", "reconciler"]) assert.match(pullLane, new RegExp(`'${roleName}'`));
  assert.match(pullLane, /github\.event\.action == 'closed'.*github\.event\.pull_request\.merged == true.*'docs-writer'/s);
  assert.match(pullLane, /github\.event\.action == 'closed'.*github\.event\.pull_request\.merged != true.*'reconciler'/s);
  assert.match(pullLane, /github\.event\.action == 'labeled'.*github\.event\.label\.name != 'changes-requested'.*github\.event\.label\.name != 'reviewed'.*'reconciler'/s);
  assert.match(pullLane, /pull_request_review_comment.*check_.*'reconciler'/s);
  assert.match(pullLane, /github\.event_name == 'repository_dispatch'.*github\.event\.client_payload\.role/s);
  assert.doesNotMatch(pullLane, /dependabot\[bot\]/);

  assert.match(maintenanceLane, /inputs\.lane == 'reconcile'.*'reconciler'/s);
  assert.match(maintenanceLane, /inputs\.lane == 'audit'.*'auditor'/s);
  assert.match(maintenanceLane, /github\.event_name == 'workflow_dispatch'.*github\.event\.sender\.id == github\.event\.repository\.owner\.id/s);
  assert.match(maintenanceLane, /github\.event_name == 'repository_dispatch'.*github\.event\.client_payload\.role/s);
  assert.match(maintenanceLane, /github\.event\.client_payload\.mergeSha/);

  for (const lane of [pullLane, maintenanceLane]) {
    assert.match(lane, /decision:.*'reconcile'/s);
    assert.match(lane, /primary:.*'none'/s);
  }
  for (const name of ["primary-claude", "primary-codex", "fallback-claude", "fallback-codex"]) assert.match(jobs(issue).get(name), /needs\.prepare\.outputs\.(?:decision|fallback|primary)/);
});

test("cutover hold guards every operational job before tokens, artifacts, or assessment", async () => {
  const values = await sources();
  for (const [file, source] of Object.entries(values)) for (const [name, block] of jobs(source)) {
    assert.match(block, /^    if: .*vars\.ADW_CUTOVER_HOLD != 'true'/m, `${file}:${name} lacks the global hold guard`);
  }
  const selftest = await readFile(new URL("../../.github/workflows/adw-selftest.yml", import.meta.url), "utf8");
  assert.doesNotMatch(selftest, /ADW_CUTOVER_HOLD/);
});

test("MJS rejects wrapper role and event mismatches; review-comment and checks reconcile only", () => {
  const providerRoutes = {
    issue: ["builder", "codex-builder", "pioneer", "planner", "triager"],
    issue_comment: ["steerer"],
    pull_request: ["dependency-manager", "docs-writer", "reviewer", "reviser", "security-reviewer"],
    pull_request_review: ["reviser"],
    push: ["planner"],
    schedule: ["adw-doctor", "alert-triager", "surveyor", "sweeper"],
    alert: ["alert-triager"],
  };
  for (const [event, roles] of Object.entries(providerRoutes)) for (const name of roles) assert.equal(roleSnapshotPlan(name, event).role, name);
  assert.equal(controlSnapshotPlan("reconciler", "pull_request_review_comment").role, "reconciler");
  assert.equal(controlSnapshotPlan("reconciler", "check").role, "reconciler");
  assert.equal(controlSnapshotPlan("reconciler", "pull_request").role, "reconciler");
  assert.equal(controlSnapshotPlan("reconciler", "dispatch").role, "reconciler");
  for (const event of ["pull_request_review_comment", "check"]) for (const roles of Object.values(providerRoutes)) for (const name of roles) assert.throws(() => roleSnapshotPlan(name, event), error => error?.code === "contract");
  assert.throws(() => roleSnapshotPlan("reviewer", "issue"), error => error?.code === "contract");
});

test("shared graph separates prepare, providers, one fallback, decisions, verify, apply, and evidence", async () => {
  const issue = await readFile(paths["adw-issues.yml"], "utf8");
  const graph = jobs(issue);
  const expected = ["prepare", "primary-claude", "primary-codex", "fallback-claude", "fallback-codex", "reduce", "reconcile", "audit", "verify", "apply", "evidence"];
  assert.deepEqual([...graph.keys()], expected);
  assert.deepEqual(permissionBlock(graph.get("prepare")), expectedPermissions.jobTokenPermissions.prepare);
  for (const name of ["primary-claude", "primary-codex", "fallback-claude", "fallback-codex"]) assert.deepEqual(permissionBlock(graph.get(name)), {});
  assert.deepEqual(permissionBlock(graph.get("reduce")), {});
  assert.deepEqual(permissionBlock(graph.get("verify")), {});
  assert.deepEqual(permissionBlock(graph.get("reconcile")), { contents: "read" });
  assert.deepEqual(permissionBlock(graph.get("apply")), { contents: "read" });
  assert.deepEqual(permissionBlock(graph.get("evidence")), {});

  assert.match(graph.get("fallback-claude"), /if:.*always\(\).*primary-codex.*(?:failure|cancelled|!= 'success')/s);
  assert.match(graph.get("fallback-codex"), /if:.*always\(\).*primary-claude.*(?:failure|cancelled|!= 'success')/s);
  assert.doesNotMatch(graph.get("fallback-claude"), /primary-claude\.result/);
  assert.doesNotMatch(graph.get("fallback-codex"), /primary-codex\.result/);
  assert.match(graph.get("reduce"), /needs:\s*\[primary-claude, primary-codex, fallback-claude, fallback-codex\]/);
  assert.match(graph.get("reduce"), /ADW_FALLBACK_ATTEMPTED:.*fallback-claude\.result != 'skipped'.*fallback-codex\.result != 'skipped'/);
  assert.match(graph.get("verify"), /if:.*vars\.ADW_CUTOVER_HOLD != 'true'.*always\(\)/);
  assert.match(graph.get("apply"), /if:.*vars\.ADW_CUTOVER_HOLD != 'true'.*always\(\)/);
  assert.match(graph.get("apply"), /group:\s*adw-write/);
  assert.match(graph.get("apply"), /cancel-in-progress:\s*false/);
  assert.match(graph.get("evidence"), /if:.*vars\.ADW_CUTOVER_HOLD != 'true'.*always\(\)/);
  for (const [file, source] of Object.entries(await sources())) for (const [name, block] of jobs(source)) {
    assert.match(block, /^    (?:uses:|steps:)\s*/m, `${file}:${name} has no executable grammar`);
    if (/^    steps:\s*$/m.test(block)) assert.match(block, /^    runs-on: ubuntu-24\.04$/m, `${file}:${name} has no pinned runner`);
    assert.equal((block.match(/^    steps:\s*$/gm) ?? []).length + (block.match(/^    uses:\s*\S+/gm) ?? []).length, 1, `${file}:${name} mixes reusable and step job grammar`);
    assert.doesNotMatch(block, /^      (?:runs-on|steps|uses):/m, `${file}:${name} has misindented job grammar`);
  }

  assert.deepEqual(ARTIFACT_LAYOUT, {
    snapshot: ["snapshot.json", "snapshot.sha256"],
    assessment: ["envelope.json", "envelope.sha256", "change.patch?", "change.patch.sha256?"],
    decision: ["decision.json", "decision.sha256", "change.patch?", "change.patch.sha256?"],
    verification: ["verification.json", "verification.sha256", "change.patch?", "change.patch.sha256?"],
    applyResult: ["result.json", "result.sha256"],
    source: ["control/**", "target.bundle", "manifest.json", "manifest.sha256"],
  });
  assert.deepEqual(uploadNames(graph.get("prepare")).sort(), ["adw-snapshot", "adw-source"]);
  assert.deepEqual(uploadNames(graph.get("primary-claude")), ["adw-assessment-claude"]);
  assert.deepEqual(uploadNames(graph.get("primary-codex")), ["adw-assessment-codex"]);
  assert.deepEqual(uploadNames(graph.get("fallback-claude")), ["adw-assessment-claude"]);
  assert.deepEqual(uploadNames(graph.get("fallback-codex")), ["adw-assessment-codex"]);
  assert.deepEqual(uploadNames(graph.get("reduce")), ["adw-decision"]);
  assert.deepEqual(uploadNames(graph.get("reconcile")), ["adw-decision"]);
  assert.deepEqual(uploadNames(graph.get("audit")), ["adw-decision"]);
  assert.deepEqual(uploadNames(graph.get("verify")), ["adw-verification"]);
  assert.deepEqual(uploadNames(graph.get("apply")), ["adw-apply-result-"]);
  for (const name of ["reduce", "reconcile", "audit"]) {
    assert.match(graph.get(name), /outputs:\s*\{apply_class:.*apply_capabilities:.*permission_actions:.*permission_vulnerability_alerts:/);
    assert.match(graph.get(name), /id:\s*decision/);
    assert.match(graph.get(name), /ADW_EMIT_GITHUB_OUTPUT:\s*exact-permissions-v1/);
  }
  for (const name of ["primary-claude", "primary-codex", "fallback-claude", "fallback-codex", "reduce", "reconcile", "audit", "verify", "apply"]) assert.match(graph.get(name), new RegExp(ACTIONS.download.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("provider jobs receive one credential and no forge, checkout, or opposite-provider secret", async () => {
  const graph = jobs(await readFile(paths["adw-issues.yml"], "utf8"));
  for (const [provider, opposite, credential] of [["claude", "CODEX_AUTH_JSON", "CLAUDE_CODE_OAUTH_TOKEN"], ["codex", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON"]]) {
    for (const phase of ["primary", "fallback"]) {
      const block = graph.get(`${phase}-${provider}`);
      assert.ok(block.includes(`ADW_PROVIDER_CREDENTIAL: "\${{ secrets.${credential} }}"`));
      assert.doesNotMatch(block, new RegExp(opposite));
      assert.doesNotMatch(block, /ADW_GITHUB_TOKEN|APP_PRIVATE_KEY|GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK/);
      assert.doesNotMatch(block, /actions\/checkout@/);
      assert.deepEqual(runCommands(block), [`node adw/main.mjs assess --provider ${provider}`]);
    }
  }
});

test("control and target checkouts are immutable and never persist credentials", async () => {
  const values = await sources();
  const prepare = jobs(values["adw-issues.yml"]).get("prepare");
  const checkoutCount = actionUses(prepare).filter(value => value === ACTIONS.checkout).length;
  assert.equal(checkoutCount, 2);
  assert.match(prepare, /name:\s*checkout immutable control[\s\S]*ref:\s*"\$\{\{ inputs\.control_sha \|\| github\.sha \}\}"[\s\S]*path:\s*control[\s\S]*persist-credentials:\s*false/);
  assert.match(prepare, /name:\s*checkout immutable target[\s\S]*ref:\s*"\$\{\{ inputs\.target_sha \|\| github\.sha \}\}"[\s\S]*path:\s*target[\s\S]*persist-credentials:\s*false/);
  assert.match(prepare, /ADW_CONTROL_CHECKOUT:\s*\$\{\{ github\.workspace \}\}\/control/);
  assert.match(prepare, /ADW_TARGET_CHECKOUT:\s*\$\{\{ github\.workspace \}\}\/target/);
  assert.match(values["adw-pulls.yml"], /control_sha:[^\n]*github\.sha/);
  assert.match(values["adw-pulls.yml"], /target_sha:[^\n]*(?:head\.sha|head_sha|client_payload\.headSha)/);
  assert.match(values["adw-pulls.yml"], /target_repository:[^\n]*github\.repository/);
  assert.doesNotMatch(Object.values(values).join("\n"), /client_payload\.(?:repository|ref|token)/);
  assert.match(prepare, /ADW_EVENT_NAME:\s*\$\{\{ github\.event_name == 'pull_request_target' && 'pull_request' \|\| github\.event_name \}\}/);
  assert.doesNotMatch(Object.values(values).join("\n"), /persist-credentials:\s*true|ref:\s*(?:main|master|refs\/heads\/)/);
});

test("actions, commands, App inputs, and policy-free YAML are exact", async () => {
  const values = await sources();
  const combined = Object.values(values).join("\n");
  for (const [name, source] of Object.entries(values)) {
    for (const use of actionUses(source)) {
      if (use.startsWith("./")) assert.equal(use, "./.github/workflows/adw-issues.yml", name);
      else assert.ok(Object.values(ACTIONS).includes(use), `${name} has unpinned or unknown action ${use}`);
    }
    for (const command of runCommands(source)) assert.ok(commands.has(command), `${name} has non-ADW command ${command}`);
    assert.doesNotMatch(source, /^\s+run:\s*[|>]/m);
    assert.doesNotMatch(source, /^\s+shell:/m);
  }
  assert.equal((combined.match(/app-id:\s*\$\{\{ secrets\.APP_ID \}\}/g) ?? []).length, 2);
  assert.match(combined, /private-key:\s*\$\{\{ secrets\.APP_PRIVATE_KEY \}\}/);
  assert.doesNotMatch(combined, /client-id:|APP_CLIENT_ID/);
  assert.match(values["adw-issues.yml"], /APP_ID:\s*\{required: true\}/);
  assert.equal((values["adw-issues.yml"].match(/ADW_APP_ID:\s*\$\{\{ secrets\.APP_ID \}\}/g) ?? []).length, 2);
  for (const name of ["adw-pulls.yml", "adw-maintenance.yml"]) assert.match(values[name], /APP_ID:\s*\$\{\{ secrets\.APP_ID \}\}/);
  assert.match(combined, /ADW_BOT_USER_ID:\s*\$\{\{ vars\.APP_BOT_USER_ID \}\}/);
  assert.match(combined, /ADW_BOT_LOGIN:\s*\$\{\{ vars\.APP_BOT_LOGIN \}\}/);
  assert.doesNotMatch(combined, /\b(?:GH_TOKEN|GITHUB_TOKEN|github_token|github-token|SSH_AUTH_SOCK)\b/);
  assert.doesNotMatch(combined, /^\s+(?:prompt|token):/m);
  assert.equal((combined.match(/ADW_GITHUB_TOKEN_EXPIRES_AT:\s*job-scoped/g) ?? []).length, 1);
  assert.match(combined, /ADW_GITHUB_TOKEN_EXPIRES_AT:.*apply-token\.outputs\.token.*job-scoped/);
  assert.doesNotMatch(combined, /ADW_GITHUB_TOKEN_EXPIRES_AT:\s*['"]?[0-9]{4}-/);
  const executed = runCommands(combined).join("\n");
  assert.doesNotMatch(executed, /claude\s+-p|codex\s+exec|\b(?:gh|git|jq|npm|cargo|rustup|make)\s+/);
  assert.doesNotMatch(executed, /\b(?:test|build|install|exec|eval|source)\s+(?:\.\/|["'])/);
  assert.deepEqual(new Set(runCommands(combined)), commands);
});

test("all action inputs exist in the exact pinned action metadata contracts", async () => {
  const values = await sources();
  const allowed = {
    [ACTIONS.checkout]: new Set(["fetch-depth", "path", "persist-credentials", "ref", "repository"]),
    [ACTIONS.upload]: new Set(["if-no-files-found", "include-hidden-files", "name", "overwrite", "path", "retention-days"]),
    [ACTIONS.download]: new Set(["name", "path", "pattern"]),
  };
  for (const [file, source] of Object.entries(values)) for (const [action, inputs] of Object.entries(allowed)) {
    for (const input of actionInputKeys(source, action)) assert.ok(inputs.has(input), `${file} assumes unsupported ${action} input ${input}`);
  }
  const appInputs = actionInputKeys(values["adw-issues.yml"], ACTIONS.appToken);
  assert.equal(appInputs.filter(value => value === "app-id").length, 2);
  assert.equal(appInputs.filter(value => value === "private-key").length, 2);
  assert.equal(appInputs.some(value => value === "client-id"), false);
  assert.equal(appInputs.every(value => value === "app-id" || value === "private-key" || /^permission-[a-z-]+$/.test(value)), true);
});

test("artifact action inputs preserve exact hidden trees and rerun receipts", async () => {
  const graph = jobs(await readFile(paths["adw-issues.yml"], "utf8"));
  for (const name of ["prepare", "reduce", "reconcile", "audit", "verify"]) {
    const block = graph.get(name);
    for (const artifact of uploadNames(block).filter(value => new Set(["adw-source", "adw-snapshot", "adw-decision", "adw-verification"]).has(value))) {
      assert.match(block, new RegExp(`name: ${artifact}[^\\n]*include-hidden-files: true[^\\n]*overwrite: true`), `${artifact} loses exact or rerun-safe transport`);
    }
  }
  const apply = graph.get("apply");
  assert.match(apply, /pattern: adw-apply-result-\*/);
  assert.match(apply, /continue-on-error: true/);
  assert.match(apply, /ADW_PREVIOUS_APPLY_RESULTS_ROOT:\s*\$\{\{ github\.workspace \}\}\/previous-apply-results/);
  assert.match(apply, /ADW_RUN_ATTEMPT:\s*\$\{\{ github\.run_attempt \}\}/);
  assert.match(apply, /if: always\(\)[\s\S]*uses: actions\/upload-artifact@[\s\S]*name: "adw-apply-result-\$\{\{ github\.run_attempt \}\}"[^\n]*include-hidden-files: true/);
  assert.doesNotMatch(apply, /name: "adw-apply-result-[^\n]*overwrite: true/);
  assert.doesNotMatch(apply, /name: adw-apply-result(?:[,}\s]|$)/);
  assert.match(graph.get("evidence"), /name: "adw-apply-result-\$\{\{ github\.run_attempt \}\}"/);
});

test("workspace roots are existing or non-overlapping and provider installs use runner temp", async () => {
  const graph = jobs(await readFile(paths["adw-issues.yml"], "utf8"));
  const combinedProviders = ["primary-claude", "primary-codex", "fallback-claude", "fallback-codex"].map(name => graph.get(name)).join("\n");
  assert.match(combinedProviders, /ADW_RUNNER_TEMP: "\$\{\{ runner\.temp \}\}"/);
  assert.doesNotMatch(combinedProviders, /runner\.tool_cache/);
  assert.doesNotMatch(await readFile(paths["adw-issues.yml"], "utf8"), /github\.workspace \}\}\/output\//);
  assert.match(graph.get("prepare"), /ADW_SOURCE_ARTIFACT:\s*\$\{\{ github\.workspace \}\}\/source[\s\S]*ADW_SNAPSHOT_ARTIFACT:\s*\$\{\{ github\.workspace \}\}\/output/);
  for (const name of ["primary-claude", "primary-codex", "fallback-claude", "fallback-codex"]) assert.match(graph.get(name), /ADW_ASSESSMENT_ARTIFACT:\s*"\$\{\{ github\.workspace \}\}\/output"/);
  for (const [name, variable] of [["reduce", "DECISION"], ["reconcile", "DECISION"], ["audit", "DECISION"], ["verify", "VERIFICATION"], ["apply", "APPLY_RESULT"]]) assert.match(graph.get(name), new RegExp(`ADW_${variable}_ARTIFACT:.*github\\.workspace.*\\/output`));
  for (const name of ["primary-claude", "primary-codex", "fallback-claude", "fallback-codex", "verify", "apply"]) {
    const block = graph.get(name);
    assert.match(block, /with:\s*\{name: adw-source, path: "\$\{\{ github\.workspace \}\}\/source"\}/);
    assert.match(block, /ADW_SOURCE_ARTIFACT:[^\n]*github\.workspace[^\n]*\/source/);
    assert.doesNotMatch(block, /ADW_SOURCE_ARTIFACT:[^,\n]*\/transport\//);
    assert.match(block, /ADW_TARGET_DIRECTORY:[^\n]*github\.workspace[^\n]*\/target/);
  }
  for (const name of ["verify", "apply"]) assert.match(graph.get(name), /ADW_TEMPORARY_DIRECTORY:[^\n]*runner\.temp/);
});

test("prepare is read-only and apply mints one explicit operation-class token", async () => {
  const graph = jobs(await readFile(paths["adw-issues.yml"], "utf8"));
  const prepare = graph.get("prepare");
  const apply = graph.get("apply");
  assert.equal((prepare.match(new RegExp(ACTIONS.appToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  assert.doesNotMatch(prepare, /permission-[a-z-]+:\s*write/);
  assert.equal((apply.match(new RegExp(ACTIONS.appToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  for (const name of Object.keys(expectedPermissions.installationPermissions)) assert.match(apply, new RegExp(`permission-${name.replaceAll("_", "-")}:`));
  assert.match(apply, /ADW_GITHUB_TOKEN_PERMISSIONS:.*steps\.apply-token\.outputs\.token.*needs\.reduce\.outputs\.apply_capabilities.*needs\.reconcile\.outputs\.apply_capabilities.*needs\.audit\.outputs\.apply_capabilities/);
  assert.match(apply, /ADW_GITHUB_TOKEN:\s*\$\{\{ steps\.apply-token\.outputs\.token \}\}/);
  assert.match(apply, /apply_class != 'none'/);
  assert.doesNotMatch(apply, /CLAUDE_CODE_OAUTH_TOKEN|CODEX_AUTH_JSON/);
  for (const name of Object.keys(expectedPermissions.installationPermissions)) {
    const key = name.replaceAll("_", "-");
    assert.match(apply, new RegExp(`permission-${key}: \\$\\{\\{ needs\\.reduce\\.outputs\\.permission_${name} \\|\\| needs\\.reconcile\\.outputs\\.permission_${name} \\|\\| needs\\.audit\\.outputs\\.permission_${name} \\}\\}`));
  }
});
