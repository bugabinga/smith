import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { AdwError } from "./core.mjs";

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
