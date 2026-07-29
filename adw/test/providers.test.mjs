import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { runProcess } from "../providers.mjs";

const base = {
  file: process.execPath,
  args: ["-e", "process.stdin.pipe(process.stdout)"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "", HOME: "/tmp/adw-home", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  input: "smith",
  timeoutMs: 3000,
  maxOutputBytes: 1024,
};

test("process runner uses exact shell-free options and env", async () => {
  let observed;
  const result = await runProcess(base, (file, args, options) => {
    observed = { file, args, options };
    return spawn(file, args, options);
  });
  assert.deepEqual(result, { code: 0, signal: null, stdout: "smith", stderr: "" });
  assert.equal(observed.file, process.execPath);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  assert.deepEqual(observed.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(observed.options.env, base.env);
  assert.equal(Object.hasOwn(observed.options.env, "GH_TOKEN"), false);
});

test("process runner rejects unsafe requests", async () => {
  await assert.rejects(() => runProcess({ ...base, file: "node" }), error => error?.code === "provider");
  await assert.rejects(() => runProcess({ ...base, cwd: "relative" }), error => error?.code === "provider");
  await assert.rejects(() => runProcess({ ...base, timeoutMs: 0 }), error => error?.code === "provider");
  await assert.rejects(() => runProcess({ ...base, env: { OK: 1 } }), error => error?.code === "provider");
});

test("process runner classifies exit without leaking stderr", async () => {
  await assert.rejects(
    () => runProcess({ ...base, args: ["-e", "console.error('secret');process.exit(7)"], input: "" }),
    error => error?.code === "provider" && error.message === "exit" && error.details.code === 7 && !JSON.stringify(error).includes("secret"),
  );
});

test("process runner bounds output", async () => {
  await assert.rejects(
    () => runProcess({ ...base, args: ["-e", "process.stdout.write('x'.repeat(20))"], input: "", maxOutputBytes: 10 }),
    error => error?.code === "provider" && error.message === "output",
  );
});

test("process runner terminates timeout", async () => {
  await assert.rejects(
    () => runProcess({ ...base, args: ["-e", "setTimeout(()=>{},10000)"], input: "", timeoutMs: 30 }),
    error => error?.code === "provider" && error.message === "timeout",
  );
});
