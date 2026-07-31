#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AdwError,
  canonicalBytes,
  digestBytes,
  planReconciliation,
  reduceAssessments,
  validateAssessment,
  validateDecision,
  validateSnapshot,
  validateVerification,
} from "./core.mjs";
import { createDefaultGitHub, createDryRunGitHub, normalizeEvent } from "./github.mjs";
import { reduceRoleArtifact, role } from "./roles.mjs";
import { createDefaultVcs } from "./vcs.mjs";

const MAX_INPUT = 262_144;

export async function readBounded(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT) throw new AdwError("input", "input is oversized");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString();
}

function inputError(message) {
  throw new AdwError("input", message);
}

function parse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_INPUT) inputError("input is missing or oversized");
  try {
    return JSON.parse(text);
  } catch {
    inputError("input is not JSON");
  }
}

function isArtifactCommand(argv) {
  return Array.isArray(argv) && (argv[0] === "reduce" || (argv[0] === "validate" && new Set(["assessment", "decision", "verification"]).has(argv[1])));
}

function errorCode(error, artifactInput) {
  if (error instanceof AdwError) {
    if (error.code === "stale") return 3;
    if (error.code === "provider") return 4;
    if (error.code === "forge") return 5;
    if (error.code === "verification") return 7;
    if (artifactInput && (error.code === "contract" || error.code === "input" || error.code === "role")) return 6;
  }
  return 2;
}

function safeMessage(error) {
  if (!(error instanceof AdwError)) return "invalid input";
  return error.message.replace(/[\r\n\t]/g, " ").slice(0, 240);
}

async function source(argv, stdin, readFixture) {
  const index = argv.indexOf("--fixture");
  if (index === -1) return stdin;
  if (index !== argv.length - 2) inputError("fixture arguments are invalid");
  const name = argv[index + 1];
  if (!name || basename(name) !== name || !/^[A-Za-z0-9._-]+\.json$/.test(name)) inputError("fixture name is invalid");
  try {
    return await readFixture(name);
  } catch {
    inputError("fixture cannot be read");
  }
}

export async function run({ argv, stdin, stdout, stderr, readFixture, adapters, writeArtifact }) {
  let artifactInput = false;
  try {
    if (!Array.isArray(argv) || argv.length === 0) inputError("command is required");
    const fixtureIndex = argv.indexOf("--fixture");
    const withoutFixture = fixtureIndex === -1 ? [...argv] : argv.slice(0, fixtureIndex);
    const outputIndex = withoutFixture.indexOf("--output");
    const outputDirectory = outputIndex === -1 ? null : withoutFixture[outputIndex + 1];
    const args = outputIndex === -1 ? withoutFixture : [...withoutFixture.slice(0, outputIndex), ...withoutFixture.slice(outputIndex + 2)];
    const recordTypes = new Set(["snapshot", "assessment", "decision", "verification"]);
    const supported =
      (args[0] === "validate" && args.length === 2 && recordTypes.has(args[1])) ||
      (args[0] === "reduce" && args.length === 1) ||
      (args[0] === "reconcile" && args.length === 1) ||
      (args[0] === "dry-run" && args.length === 1 && typeof outputDirectory === "string" && outputDirectory.startsWith("/"));
    if (!supported) inputError("command is unsupported");
    artifactInput = args[0] === "reduce" || (args[0] === "validate" && args[1] !== "snapshot");
    const text = await source(argv, stdin, readFixture);
    const value = parse(text);
    let result;
    if (args[0] === "validate" && args.length === 2) {
      const validators = {
        snapshot: validateSnapshot,
        assessment: validateAssessment,
        decision: validateDecision,
        verification: validateVerification,
      };
      const validator = validators[args[1]];
      if (!validator) inputError("record type is unsupported");
      artifactInput = args[1] !== "snapshot";
      result = validator(value);
    } else if (args[0] === "reduce" && args.length === 1) {
      artifactInput = true;
      if (!value || Array.isArray(value) || typeof value !== "object") inputError("reduce request must be an object");
      const keys = Object.keys(value).sort();
      if (keys.length !== 2 || keys.some((key, i) => key !== ["assessments", "snapshot"][i])) throw new AdwError("contract", "reduce request has invalid fields");
      if (!Array.isArray(value.assessments)) throw new AdwError("contract", "reduce assessments must be an array");
      const snapshot = validateSnapshot(value.snapshot);
      const rolePolicy = role(snapshot.routing.role);
      const assessments = value.assessments.map(entry => {
        const assessment = entry?.assessment ?? entry;
        if (assessment?.patch === null) return assessment;
        if (!entry || entry.assessment !== assessment || typeof entry.patchBase64 !== "string" || Object.keys(entry).sort().join(",") !== "assessment,patchBase64") throw new AdwError("contract", "patched assessment sidecar is missing");
        if (entry.patchBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.patchBase64)) throw new AdwError("contract", "patch sidecar encoding is invalid");
        const patchBytes = Buffer.from(entry.patchBase64, "base64");
        if (patchBytes.toString("base64") !== entry.patchBase64) throw new AdwError("contract", "patch sidecar encoding is invalid");
        return { assessment, patchBytes };
      });
      const reduction = reduceAssessments({ snapshot, rolePolicy, assessments });
      result = reduction.status === "artifact"
        ? reduceRoleArtifact({ snapshot, rolePolicy, reduction, assessments })
        : reduction;
    } else if (args[0] === "reconcile" && args.length === 1) {
      result = planReconciliation(value);
    } else if (args[0] === "dry-run") {
      if (!value || Array.isArray(value) || typeof value !== "object") inputError("dry-run request must be an object");
      const keys = Object.keys(value).sort();
      const expected = ["controlSha", "event", "eventName", "live", "operations", "repository", "repositoryPath", "schemaVersion"].sort();
      if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) inputError("dry-run request has invalid fields");
      if (value.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(value.controlSha) || typeof value.live !== "boolean" || !Array.isArray(value.operations)) inputError("dry-run request is invalid");
      const activeAdapters = adapters ?? { vcs: createDefaultVcs(), githubFactory: value.live ? createDefaultGitHub : createDryRunGitHub };
      const artifactWriter = writeArtifact ?? writeDryRunArtifact;
      if (!activeAdapters?.vcs?.head || !activeAdapters?.githubFactory || typeof artifactWriter !== "function") inputError("dry-run adapters are unavailable");
      const liveHead = await activeAdapters.vcs.head(value.repositoryPath);
      if (liveHead !== value.controlSha) throw new AdwError("stale", "control SHA changed");
      const event = normalizeEvent(value.eventName, value.event);
      if (`${event.repository.owner}/${event.repository.name}` !== value.repository) inputError("event repository does not match request");
      const github = activeAdapters.githubFactory(value.repository);
      for (const operation of value.operations) github.record(operation);
      let live = null;
      if (value.live) {
        if (typeof github.readSnapshot !== "function") inputError("live snapshot reader is unavailable");
        live = await github.readSnapshot(event);
      }
      result = { schemaVersion: 1, controlSha: value.controlSha, event, snapshot: { live }, intents: github.intents() };
      const bytes = canonicalBytes(result);
      await artifactWriter(outputDirectory, bytes, digestBytes(bytes), value.repositoryPath);
    } else {
      inputError("command is unsupported");
    }
    stdout.write(`${canonicalBytes(result).toString()}\n`);
    if (result?.status === "fallback") return 4;
    if (result?.status === "terminal") {
      return new Set(["provider_unavailable", "providers_unavailable", "quorum_incomplete", "advisory_unavailable"]).has(result.reason) ? 4 : 6;
    }
    return 0;
  } catch (error) {
    const code = errorCode(error, artifactInput);
    const category = error instanceof AdwError ? error.code : "input";
    stderr.write(`${canonicalBytes({ error: category, message: safeMessage(error) }).toString()}\n`);
    return code;
  }
}

async function localFixture(name) {
  return readFile(new URL(`./test/fixtures/${name}`, import.meta.url), "utf8");
}

export async function writeDryRunArtifact(directory, bytes, digest, repositoryPath) {
  const repository = await realpath(repositoryPath);
  const parent = await realpath(dirname(directory));
  if (parent === repository || parent.startsWith(`${repository}${sep}`)) inputError("artifact path is inside repository");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) inputError("artifact directory is a symlink");
  const output = await realpath(directory);
  if (output === repository || output.startsWith(`${repository}${sep}`) || repository.startsWith(`${output}${sep}`)) inputError("artifact path overlaps repository");
  await writeFile(`${output}/dry-run.json`, bytes, { mode: 0o600, flag: "wx" });
  await writeFile(`${output}/dry-run.sha256`, `${digest}\n`, { mode: 0o600, flag: "wx" });
}

export async function execute({ argv, stdin, stdout, stderr, readFixture, adapters, writeArtifact }) {
  try {
    return await run({ argv, stdin: await readBounded(stdin), stdout, stderr, readFixture, adapters, writeArtifact });
  } catch (error) {
    const category = error instanceof AdwError ? error.code : "input";
    stderr.write(`${canonicalBytes({ error: category, message: safeMessage(error) }).toString()}\n`);
    return errorCode(error, isArtifactCommand(argv));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await execute({
    argv: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    readFixture: localFixture,
  });
}
