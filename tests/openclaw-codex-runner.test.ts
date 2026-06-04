import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("local Codex bridge dry-runs starts and exposes private-network CORS", async (t) => {
  const port = await freePort();
  const token = "runner-dry-run-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner([
    "--workspace",
    repoRoot,
    "--port",
    String(port),
    "--token",
    token,
    "--dry-run",
  ]);
  t.after(() => stopRunner(runner));

  const health = await waitForHealth(base, token, runner);
  assert.equal(health.runner, "claw-queue-codex-bridge");
  assert.equal(health.dryRun, true);

  const preflight = await fetch(`${base}/health`, {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:5177",
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

  const started = await postStart(base, token, "dry-run prompt");
  assert.equal(started.status, 202);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.run.status, "dry-run");

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].id, started.body.run.id);
  assert.equal(runs.runs[0].status, "dry-run");
});

test("local Codex bridge marks log setup failures as failed runs", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-bad-log-"));
  const badLogDir = path.join(temp, "not-a-directory");
  await fs.writeFile(badLogDir, "x");

  const port = await freePort();
  const token = "runner-bad-log-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner([
    "--workspace",
    repoRoot,
    "--port",
    String(port),
    "--token",
    token,
    "--log-dir",
    badLogDir,
  ]);
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const first = await postStart(base, token, "first bad log prompt");
  const second = await postStart(base, token, "second bad log prompt");

  assert.equal(first.status, 500);
  assert.equal(second.status, 500);
  assert.notEqual(second.status, 409);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].status, "failed");
  assert.equal(runs.runs[1].status, "failed");
});

test("local Codex bridge tracks parallel active runs up to max-active", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-parallel-codex-"));
  const fakeCodex = await writeFakeCodexCommand(temp);

  const port = await freePort();
  const token = "runner-parallel-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner([
    "--workspace",
    repoRoot,
    "--port",
    String(port),
    "--token",
    token,
    "--codex-bin",
    fakeCodex,
    "--max-active",
    "2",
  ]);
  t.after(() => stopRunner(runner));

  const health = await waitForHealth(base, token, runner);
  assert.equal(health.maxActive, 2);

  const first = await postStart(base, token, "first parallel prompt");
  const second = await postStart(base, token, "second parallel prompt");
  const third = await postStart(base, token, "third parallel prompt");

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(third.status, 409);
  assert.match(third.body.error, /2 active Codex run/);

  const activeHealth = await waitForHealth(base, token, runner);
  assert.equal(activeHealth.active, 2);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs.filter((run: any) => run.status === "running").length, 2);

  await waitForRun(base, token, first.body.run.id, "completed");
  await waitForRun(base, token, second.body.run.id, "completed");
});

test(
  "local Codex bridge launches Windows cmd shims and rejects concurrent starts",
  { skip: process.platform !== "win32" },
  async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-codex-shim-"));
    const fakeCmd = path.join(temp, "codex.cmd");
    await fs.writeFile(
      fakeCmd,
      "@echo off\r\nmore >nul\r\nping 127.0.0.1 -n 3 >nul\r\nexit /b 0\r\n",
    );

    const port = await freePort();
    const token = "runner-shim-token";
    const base = `http://127.0.0.1:${port}`;
    const runner = startRunner([
      "--workspace",
      repoRoot,
      "--port",
      String(port),
      "--token",
      token,
      "--codex-bin",
      fakeCmd,
    ]);
    t.after(() => stopRunner(runner));

    const health = await waitForHealth(base, token, runner);
    assert.equal(health.codexCommand.toLowerCase().endsWith("codex.cmd"), true);

    const first = await postStart(base, token, "first shim prompt");
    assert.equal(first.status, 202);
    assert.equal(first.body.run.status, "running");

    const second = await postStart(base, token, "second shim prompt");
    assert.equal(second.status, 409);
    assert.match(second.body.error, /active Codex run/);

    const finalRun = await waitForRun(base, token, first.body.run.id, "completed");
    assert.equal(finalRun.exitCode, 0);
  },
);

function startRunner(args: string[]) {
  const child = spawn(process.execPath, ["scripts/openclaw-codex-runner.mjs", ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  return { child, output: () => output };
}

async function stopRunner(runner: { child: ChildProcess }) {
  if (!runner.child.killed) runner.child.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitForHealth(
  base: string,
  token: string,
  runner: { output: () => string },
): Promise<Record<string, any>> {
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok === true) return body;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runner did not become healthy: ${runner.output()}`);
}

async function waitForRun(
  base: string,
  token: string,
  id: string,
  status: string,
): Promise<Record<string, any>> {
  let body: any = {};
  for (let index = 0; index < 60; index += 1) {
    body = await getRun(base, token, id);
    if (body.run?.status === status) return body.run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${id} did not reach ${status}: ${JSON.stringify(body)}`);
}

async function postStart(base: string, token: string, prompt: string) {
  const response = await fetch(`${base}/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      issueNumber: 1,
      issueUrl: "https://github.com/openclaw/openclaw/issues/1",
      queueId: "probe",
      title: "probe",
      prompt,
    }),
  });
  return { body: await response.json().catch(() => ({})), status: response.status };
}

async function getRun(base: string, token: string, id: string) {
  const response = await fetch(`${base}/runs/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.json();
}

async function getRuns(base: string, token: string) {
  const response = await fetch(`${base}/runs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.json();
}

async function writeFakeCodexCommand(directory: string): Promise<string> {
  const fakeScript = path.join(directory, "fake-codex.mjs");
  await fs.writeFile(
    fakeScript,
    [
      "import { setTimeout } from 'node:timers/promises';",
      "process.stdin.resume();",
      "await setTimeout(1200);",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    const command = path.join(directory, "codex.cmd");
    await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
    return command;
  }
  const command = path.join(directory, "codex");
  await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, {
    mode: 0o755,
  });
  return command;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
