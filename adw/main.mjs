#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AdwError,
  canonicalBytes,
  planReconciliation,
  reduceAssessments,
  validateAssessment,
  validateDecision,
  validateSnapshot,
  validateVerification,
} from "./core.mjs";
import { defineRole } from "./roles.mjs";

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

export async function run({ argv, stdin, stdout, stderr, readFixture }) {
  let artifactInput = false;
  try {
    if (!Array.isArray(argv) || argv.length === 0) inputError("command is required");
    const args = argv.includes("--fixture") ? argv.slice(0, argv.indexOf("--fixture")) : argv;
    const recordTypes = new Set(["snapshot", "assessment", "decision", "verification"]);
    const supported =
      (args[0] === "validate" && args.length === 2 && recordTypes.has(args[1])) ||
      (args[0] === "reduce" && args.length === 1) ||
      (args[0] === "reconcile" && args.length === 1);
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
      if (keys.length !== 3 || keys.some((key, i) => key !== ["assessments", "rolePolicy", "snapshot"][i])) throw new AdwError("contract", "reduce request has invalid fields");
      if (!Array.isArray(value.assessments)) throw new AdwError("contract", "reduce assessments must be an array");
      result = reduceAssessments({
        snapshot: validateSnapshot(value.snapshot),
        rolePolicy: defineRole(value.rolePolicy),
        assessments: value.assessments,
      });
    } else if (args[0] === "reconcile" && args.length === 1) {
      result = planReconciliation(value);
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

export async function execute({ argv, stdin, stdout, stderr, readFixture }) {
  try {
    return await run({ argv, stdin: await readBounded(stdin), stdout, stderr, readFixture });
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
