import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { AdwError, digestJson, validateAssessmentArtifact } from "./core.mjs";

export const PROVIDER_PINS = Object.freeze({
  claude: Object.freeze({ package: "@anthropic-ai/claude-code", version: "2.1.220", executable: "claude" }),
  codex: Object.freeze({ package: "@openai/codex", version: "0.145.0", executable: "codex" }),
});

function rejectRequest(message) {
  throw new AdwError("provider", message);
}

function validateRequest(request) {
  if (!request || typeof request !== "object") rejectRequest("request");
  if (typeof request.file !== "string" || !isAbsolute(request.file)) rejectRequest("file");
  if (typeof request.cwd !== "string" || !isAbsolute(request.cwd)) rejectRequest("cwd");
  if (!Array.isArray(request.args) || request.args.some(value => typeof value !== "string")) rejectRequest("args");
  if (!request.env || Array.isArray(request.env) || Object.values(request.env).some(value => typeof value !== "string")) rejectRequest("env");
  if (typeof request.input !== "string") rejectRequest("input");
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 300_000) rejectRequest("timeout");
  if (!Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 1_048_576) rejectRequest("output");
}

function terminate(child) {
  const send = signal => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch {}
    }
  };
  send("SIGTERM");
  return setTimeout(() => send("SIGKILL"), 100).unref();
}

export async function runProcess(request, spawnImpl = spawn) {
  validateRequest(request);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(request.file, request.args, {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(new AdwError("provider", "spawn"));
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let killTimer;
    const timeout = setTimeout(() => {
      failure ??= "timeout";
      killTimer ??= terminate(child);
    }, request.timeoutMs);
    timeout.unref();

    const collect = (target, chunk, stream) => {
      const bytes = Buffer.from(chunk);
      if (stream === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes > request.maxOutputBytes || stderrBytes > request.maxOutputBytes) {
        failure ??= "output";
        killTimer ??= terminate(child);
        return;
      }
      target.push(bytes);
    };

    child.stdout.on("data", chunk => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", chunk => collect(stderr, chunk, "stderr"));
    child.once("error", () => {
      failure ??= "spawn";
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (failure) {
        reject(new AdwError("provider", failure, { code, signal }));
      } else if (code !== 0) {
        reject(new AdwError("provider", "exit", { code, signal }));
      } else {
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request.input);
  });
}

function baseEnvironment(input, home) {
  const env = {};
  for (const key of ["PATH", "LANG", "TMPDIR"]) if (typeof input[key] === "string") env[key] = input[key];
  env.HOME = home;
  return env;
}

async function externalPath(path, repository) {
  if (!isAbsolute(path) || !isAbsolute(repository)) rejectRequest("path");
  const repo = await realpath(repository);
  const parent = await realpath(dirname(path));
  if (parent === repo || parent.startsWith(`${repo}${sep}`)) rejectRequest("path");
  return { repo, parent };
}

export async function installProvider({ provider, prefix, npmPath, repository, run = runProcess, baseEnv }) {
  const pin = PROVIDER_PINS[provider];
  if (!pin || !isAbsolute(npmPath)) rejectRequest("install");
  await externalPath(prefix, repository);
  const env = baseEnvironment(baseEnv, dirname(prefix));
  await run({
    file: npmPath,
    args: ["install", "--prefix", prefix, "--no-save", "--package-lock=false", `${pin.package}@${pin.version}`],
    cwd: dirname(prefix), env, input: "", timeoutMs: 300_000, maxOutputBytes: 262_144,
  });
  const executable = join(prefix, "node_modules", ".bin", pin.executable);
  const version = await run({ file: executable, args: ["--version"], cwd: dirname(prefix), env, input: "", timeoutMs: 30_000, maxOutputBytes: 4096 });
  if (!new RegExp(`(^|[^0-9])${pin.version.replaceAll(".", "\\.")}([^0-9]|$)`).test(`${version.stdout}\n${version.stderr}`)) rejectRequest("version");
  return Object.freeze({ executable, version: pin.version });
}

function exactCredential(provider, credential) {
  const key = provider === "claude" ? "CLAUDE_CODE_OAUTH_TOKEN" : "CODEX_AUTH_JSON";
  if (!credential || Object.keys(credential).length !== 1 || typeof credential[key] !== "string" || credential[key].length === 0) rejectRequest("credential");
  return { key, value: credential[key] };
}

function parsePayload(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 262_144) rejectRequest("output");
  let value;
  try { value = JSON.parse(text); } catch { rejectRequest("malformed"); }
  if (!value || Array.isArray(value) || typeof value !== "object") rejectRequest("malformed");
  return value;
}

export async function invokeProvider({
  provider, executable, cliVersion, rolePolicy, snapshot, idempotencyKey, prompt,
  schemaPath, home, repository, credential, runIdentity, baseEnv, now, run = runProcess,
}) {
  const pin = PROVIDER_PINS[provider];
  if (!pin || !isAbsolute(executable) || !isAbsolute(schemaPath) || !isAbsolute(home)) rejectRequest("invoke");
  if (cliVersion !== pin.version || rolePolicy.providerConfig[provider]?.model === undefined) rejectRequest("version");
  if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 262_144) rejectRequest("prompt");
  await externalPath(home, repository);
  const auth = exactCredential(provider, credential);
  const schema = await readFile(schemaPath, "utf8");
  if (Buffer.byteLength(schema) > 262_144) rejectRequest("schema");
  const startedAt = now();
  let raw;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const env = baseEnvironment(baseEnv, home);
    env[auth.key] = auth.value;
    const config = rolePolicy.providerConfig[provider];
    if (provider === "claude") {
      const result = await run({
        file: executable,
        args: ["-p", prompt, "--output-format", "json", "--json-schema", schema, "--model", config.model],
        cwd: repository, env, input: "", timeoutMs: config.timeoutSeconds * 1000, maxOutputBytes: 262_144,
      });
      raw = parsePayload(result.stdout).structured_output;
    } else {
      const codexHome = join(home, ".codex");
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      const authPath = join(codexHome, "auth.json");
      await writeFile(authPath, auth.value, { mode: 0o600 });
      await chmod(authPath, 0o600);
      env.CODEX_HOME = codexHome;
      delete env.CODEX_AUTH_JSON;
      const output = join(home, "result.json");
      await run({
        file: executable,
        args: ["exec", "-m", config.model, "-c", `model_reasoning_effort=${config.effort}`, "--sandbox", "workspace-write", "--output-schema", schemaPath, "--output-last-message", output, prompt],
        cwd: repository, env, input: "", timeoutMs: config.timeoutSeconds * 1000, maxOutputBytes: 262_144,
      });
      raw = parsePayload(await readFile(output, "utf8"));
    }
    if (!raw || Array.isArray(raw) || !rolePolicy.payload.outcomes.includes(raw.outcome) || typeof raw.payload !== "object" || raw.payload === null) rejectRequest("malformed");
    const assessment = {
      schemaVersion: 1,
      controlSha: snapshot.controlSha,
      role: rolePolicy.name,
      provider,
      model: rolePolicy.providerConfig[provider].model,
      idempotencyKey,
      snapshotDigest: digestJson(snapshot),
      cliVersion,
      run: runIdentity,
      outcome: raw.outcome,
      payload: raw.payload,
      payloadDigest: digestJson(raw.payload),
      patch: raw.patch ?? null,
      startedAt,
      completedAt: now(),
    };
    return validateAssessmentArtifact({ assessment, patchBytes: undefined });
  } catch (error) {
    if (error instanceof AdwError && error.code === "provider") throw error;
    throw new AdwError("provider", "malformed");
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
