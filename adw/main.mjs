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

function errorCode(error, artifactInput) {
  if (error instanceof AdwError) {
    if (error.code === "stale") return 3;
    if (error.code === "provider") return 4;
    if (error.code === "forge") return 5;
    if (error.code === "verification") return 7;
    if (error.code === "contract" && artifactInput) return 6;
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
    const text = await source(argv, stdin, readFixture);
    const args = argv.includes("--fixture") ? argv.slice(0, argv.indexOf("--fixture")) : argv;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stdin = await readFile(0, "utf8");
  process.exitCode = await run({
    argv: process.argv.slice(2),
    stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    readFixture: localFixture,
  });
}
