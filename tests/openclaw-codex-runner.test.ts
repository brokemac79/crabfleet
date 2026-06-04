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

  const log = await getRunLog(base, token, started.body.run.id);
  assert.equal(log.ok, true);
  assert.equal(log.log.exists, true);
  assert.equal(
    log.log.entries.some(
      (entry: any) => entry.type === "prompt" && /dry-run prompt/.test(entry.text),
    ),
    true,
  );

  await fs.appendFile(
    started.body.run.logPath,
    Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({ type: "agent_message", message: `default tail event ${index}` }),
    ).join("\n") + "\n",
    "utf8",
  );
  const defaultTail = await getRunLog(base, token, started.body.run.id);
  assert.equal(defaultTail.ok, true);
  assert.equal(defaultTail.log.entries.length >= 30, true);
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
  const tracked = await postTrack(base, token, "manual bad log prompt");

  assert.equal(first.status, 500);
  assert.equal(second.status, 500);
  assert.equal(tracked.status, 500);
  assert.notEqual(second.status, 409);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].status, "failed");
  assert.equal(runs.runs[1].status, "failed");
  assert.equal(
    runs.runs.some((run: any) => run.status === "tracked" || run.issueNumber === 2),
    false,
  );
});

test("local Codex bridge persists manual tracked work and archived rows", async (t) => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-run-state-"));
  const port = await freePort();
  const token = "runner-state-token";
  const base = `http://127.0.0.1:${port}`;
  let runner = startRunner([
    "--workspace",
    repoRoot,
    "--port",
    String(port),
    "--token",
    token,
    "--log-dir",
    logDir,
  ]);
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const tracked = await postTrack(base, token, "manual prompt");
  assert.equal(tracked.status, 201);
  assert.equal(tracked.body.run.status, "tracked");
  const duplicate = await postTrack(base, token, "duplicate manual prompt");
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.body.run.id, tracked.body.run.id);
  const forkIssue = await postTrackIssue(base, token, {
    issueNumber: 2,
    issueUrl: "https://github.com/brokemac79/openclaw/issues/2",
    prompt: "same issue number in a fork",
  });
  assert.equal(forkIssue.status, 201);
  assert.notEqual(forkIssue.body.run.id, tracked.body.run.id);
  const [raceOne, raceTwo] = await Promise.all([
    postTrackIssue(base, token, {
      issueNumber: 3,
      issueUrl: "https://github.com/openclaw/openclaw/issues/3",
      prompt: "first concurrent manual prompt",
    }),
    postTrackIssue(base, token, {
      issueNumber: 3,
      issueUrl: "https://github.com/openclaw/openclaw/issues/3",
      prompt: "second concurrent manual prompt",
    }),
  ]);
  assert.equal(raceOne.status, 201);
  assert.equal(raceTwo.status, 201);
  assert.equal(raceOne.body.run.id, raceTwo.body.run.id);
  const fakeLive = await patchRun(base, token, tracked.body.run.id, { status: "running" });
  assert.equal(fakeLive.status, 409);
  assert.match(fakeLive.body.error, /live status/);
  const stillTracked = await getRun(base, token, tracked.body.run.id);
  assert.equal(stillTracked.run.status, "tracked");

  const parked = await patchRun(base, token, tracked.body.run.id, {
    status: "parked",
    note: "waiting for Mantis proof",
  });
  assert.equal(parked.status, 200);
  assert.equal(parked.body.run.status, "parked");
  await waitForPersistedRun(logDir, tracked.body.run.id, "parked");

  await stopRunner(runner);
  runner = startRunner([
    "--workspace",
    repoRoot,
    "--port",
    String(port),
    "--token",
    token,
    "--log-dir",
    logDir,
  ]);
  await waitForHealth(base, token, runner);

  const restored = await getRuns(base, token);
  assert.equal(restored.runs[0].id, tracked.body.run.id);
  assert.equal(restored.runs[0].status, "parked");
  assert.equal(restored.runs[0].note, "waiting for Mantis proof");

  const archived = await patchRun(base, token, tracked.body.run.id, { status: "archive" });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.run.status, "archived");

  const visible = await getRuns(base, token);
  assert.equal(
    visible.runs.some((run: any) => run.id === tracked.body.run.id),
    false,
  );
});

test("local Codex bridge dedupes and persists active work beyond display caps", async (t) => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-run-history-"));
  const port = await freePort();
  const token = "runner-history-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner([
    "--workspace",
    repoRoot,
    "--port",
    String(port),
    "--token",
    token,
    "--log-dir",
    logDir,
  ]);
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const first = await postTrackIssue(base, token, {
    issueNumber: 1,
    issueUrl: "https://github.com/openclaw/openclaw/issues/1",
    prompt: "first history prompt",
  });
  assert.equal(first.status, 201);

  for (let issueNumber = 2; issueNumber <= 55; issueNumber += 1) {
    const tracked = await postTrackIssue(base, token, {
      issueNumber,
      issueUrl: `https://github.com/openclaw/openclaw/issues/${issueNumber}`,
      prompt: `history prompt ${issueNumber}`,
    });
    assert.equal(tracked.status, 201);
  }

  const duplicate = await postTrackIssue(base, token, {
    issueNumber: 1,
    issueUrl: "https://github.com/openclaw/openclaw/issues/1",
    prompt: "duplicate outside visible cap",
  });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.body.run.id, first.body.run.id);

  for (let issueNumber = 56; issueNumber <= 205; issueNumber += 1) {
    const tracked = await postTrackIssue(base, token, {
      issueNumber,
      issueUrl: `https://github.com/openclaw/openclaw/issues/${issueNumber}`,
      prompt: `history prompt ${issueNumber}`,
    });
    assert.equal(tracked.status, 201);
  }

  const parked = await patchRun(base, token, first.body.run.id, { status: "parked" });
  assert.equal(parked.status, 200);
  await waitForPersistedRun(logDir, first.body.run.id, "parked");
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
  const hidden = await patchRun(base, token, first.body.run.id, { status: "ready" });
  const third = await postStart(base, token, "third parallel prompt");

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(hidden.status, 409);
  assert.match(hidden.body.error, /Codex process is active/);
  assert.equal(third.status, 409);
  assert.match(third.body.error, /2 active Codex run/);

  const activeHealth = await waitForHealth(base, token, runner);
  assert.equal(activeHealth.active, 2);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs.filter((run: any) => run.status === "running").length, 2);

  const liveLog = await waitForRunLog(base, token, first.body.run.id, /fake codex started/);
  assert.equal(
    liveLog.entries.some((entry: any) => /fake codex started/.test(entry.text)),
    true,
  );

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

async function waitForRunLog(
  base: string,
  token: string,
  id: string,
  pattern: RegExp,
): Promise<Record<string, any>> {
  let body: any = {};
  for (let index = 0; index < 60; index += 1) {
    body = await getRunLog(base, token, id);
    const text = [
      body.log?.text || "",
      ...(body.log?.entries || []).map((entry: any) => entry.text || ""),
    ].join("\n");
    if (pattern.test(text)) return body.log;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${id} log did not match ${pattern}: ${JSON.stringify(body)}`);
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

async function postTrack(base: string, token: string, prompt: string) {
  return postTrackIssue(base, token, {
    issueNumber: 2,
    issueUrl: "https://github.com/openclaw/openclaw/issues/2",
    prompt,
  });
}

async function postTrackIssue(
  base: string,
  token: string,
  issue: { issueNumber: number; issueUrl: string; prompt: string },
) {
  const response = await fetch(`${base}/track`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      issueNumber: issue.issueNumber,
      issueUrl: issue.issueUrl,
      queueId: "manual",
      title: "manual track probe",
      prompt: issue.prompt,
    }),
  });
  return { body: await response.json().catch(() => ({})), status: response.status };
}

async function patchRun(base: string, token: string, id: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/runs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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

async function getRunLog(base: string, token: string, id: string) {
  const response = await fetch(`${base}/runs/${encodeURIComponent(id)}/log`, {
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
      "console.log(JSON.stringify({ type: 'agent_message', message: 'fake codex started' }));",
      "console.error('fake codex stderr proof');",
      "process.stdin.resume();",
      "await setTimeout(1200);",
      "console.log(JSON.stringify({ type: 'agent_message', message: 'fake codex completed' }));",
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

async function waitForPersistedRun(logDir: string, id: string, status: string) {
  const statePath = path.join(logDir, "runs.json");
  let last = "";
  for (let index = 0; index < 60; index += 1) {
    try {
      last = await fs.readFile(statePath, "utf8");
      const state = JSON.parse(last);
      const run = state.runs?.find((item: any) => item.id === id);
      if (run?.status === status) return run;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${id} was not persisted as ${status}: ${last}`);
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
