import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("local Codex bridge dry-runs starts and exposes private-network CORS", async (t) => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-dry-run-"));
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
    "--log-dir",
    logDir,
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

  const crabyardPreflight = await fetch(`${base}/health`, {
    method: "OPTIONS",
    headers: {
      origin: "https://crabyard.openclaw.ai",
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(crabyardPreflight.status, 204);
  assert.equal(
    crabyardPreflight.headers.get("access-control-allow-origin"),
    "https://crabyard.openclaw.ai",
  );

  const ipv6LoopbackPreflight = await fetch(`${base}/health`, {
    method: "OPTIONS",
    headers: {
      origin: "http://[::1]:5173",
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(ipv6LoopbackPreflight.status, 204);
  assert.equal(
    ipv6LoopbackPreflight.headers.get("access-control-allow-origin"),
    "http://[::1]:5173",
  );

  const started = await postStart(base, token, "dry-run prompt", {
    codexReasoningEffort: "xhigh",
    proofMode: "crabbox",
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.run.status, "dry-run");
  assert.equal(started.body.run.codexReasoningEffort, "xhigh");
  assert.equal(started.body.run.proofMode, "crabbox");

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].id, started.body.run.id);
  assert.equal(runs.runs[0].status, "dry-run");

  const log = await getRunLog(base, token, started.body.run.id);
  assert.equal(log.ok, true);
  assert.equal(log.log.exists, true);
  assert.equal(
    log.log.entries.some(
      (entry: any) => entry.type === "request" && /thinking xhigh/.test(entry.text),
    ),
    true,
  );
  assert.equal(
    log.log.entries.some(
      (entry: any) => entry.type === "request" && /proof crabbox/.test(entry.text),
    ),
    true,
  );
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

  const retry = await postStart(base, token, "dry-run retry prompt");
  assert.equal(retry.status, 202);
  assert.notEqual(retry.body.run.id, started.body.run.id);
  assert.equal(retry.body.run.status, "dry-run");
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
  const second = await postStart(base, token, "second bad log prompt", {
    issueNumber: 2,
    issueUrl: "https://github.com/openclaw/openclaw/issues/2",
  });
  const tracked = await postTrackIssue(base, token, {
    issueNumber: 3,
    issueUrl: "https://github.com/openclaw/openclaw/issues/3",
    prompt: "manual bad log prompt",
  });

  assert.equal(first.status, 500);
  assert.equal(second.status, 500);
  assert.equal(tracked.status, 500);
  assert.notEqual(second.status, 409);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].status, "failed");
  assert.equal(runs.runs[1].status, "failed");
  assert.equal(
    runs.runs.some((run: any) => run.status === "tracked"),
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
  const tracked = await postTrack(base, token, "manual prompt", { proofMode: "mantis" });
  assert.equal(tracked.status, 201);
  assert.equal(tracked.body.run.status, "tracked");
  assert.equal(tracked.body.run.codexReasoningEffort, "high");
  assert.equal(tracked.body.run.proofMode, "mantis");
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
  assert.equal(restored.runs[0].proofMode, "mantis");

  const archived = await patchRun(base, token, tracked.body.run.id, { status: "archive" });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.run.status, "archived");

  const visible = await getRuns(base, token);
  assert.equal(
    visible.runs.some((run: any) => run.id === tracked.body.run.id),
    false,
  );
});

test("local Codex bridge claims issues through gh before tracked work", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-gh-claim-"));
  const fakeGh = await writeFakeGhCommand(temp);
  const logDir = path.join(temp, "logs");
  const port = await freePort();
  const token = "runner-claim-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    ["--workspace", repoRoot, "--port", String(port), "--token", token, "--log-dir", logDir],
    { PATH: `${path.dirname(fakeGh)}${path.delimiter}${process.env.PATH || ""}` },
  );
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const firstClaim = await postClaim(base, token, {
    issueNumber: 7,
    issueUrl: "https://github.com/openclaw/openclaw/issues/7",
    title: "Claim probe",
  });
  assert.equal(firstClaim.status, 200);
  assert.equal(firstClaim.body.claim.status, "posted");
  assert.match(firstClaim.body.claim.url, /issues\/7#issuecomment-1/);

  const secondClaim = await postClaim(base, token, {
    issueNumber: 7,
    issueUrl: "https://github.com/openclaw/openclaw/issues/7",
    title: "Claim probe",
  });
  assert.equal(secondClaim.status, 200);
  assert.equal(secondClaim.body.claim.status, "already-commented");

  const tracked = await postTrackIssue(base, token, {
    issueNumber: 7,
    issueUrl: "https://github.com/openclaw/openclaw/issues/7",
    prompt: "manual claim prompt",
    extra: {
      claimCommentStatus: secondClaim.body.claim.status,
      claimCommentUrl: secondClaim.body.claim.url,
    },
  });
  assert.equal(tracked.status, 201);
  assert.equal(tracked.body.run.claimCommentStatus, "already-commented");
  assert.equal(tracked.body.run.claimCommentUrl, secondClaim.body.claim.url);

  const commentsPath = path.join(temp, "comments.json");
  const state = JSON.parse(await fs.readFile(commentsPath, "utf8"));
  assert.equal(state.length, 1);
  assert.equal(state[0].user.login, "brokemac79");
  assert.match(state[0].body, /claw-queue-claim repo=openclaw\/openclaw issue=7/);

  await fs.writeFile(
    commentsPath,
    JSON.stringify(
      [
        ...state,
        {
          html_url: "https://github.com/openclaw/openclaw/issues/8#issuecomment-2",
          body: "<!-- claw-queue-claim repo=openclaw/openclaw issue=8 -->",
          user: { login: "someone-else" },
        },
      ],
      null,
      2,
    ),
    "utf8",
  );
  const otherClaim = await postClaim(base, token, {
    issueNumber: 8,
    issueUrl: "https://github.com/openclaw/openclaw/issues/8",
    title: "Claimed by another user",
  });
  assert.equal(otherClaim.status, 200);
  assert.equal(otherClaim.body.ok, false);
  assert.equal(otherClaim.body.claim.status, "claimed-by-other");
  assert.match(otherClaim.body.error, /@someone-else/);
  const finalState = JSON.parse(await fs.readFile(commentsPath, "utf8"));
  assert.equal(finalState.length, 2);

  const closedClaim = await postClaim(base, token, {
    issueNumber: 10,
    issueUrl: "https://github.com/openclaw/openclaw/issues/10",
    title: "Closed issue",
  });
  assert.equal(closedClaim.status, 200);
  assert.equal(closedClaim.body.ok, false);
  assert.equal(closedClaim.body.claim.status, "not-open");

  const pullRequestClaim = await postClaim(base, token, {
    issueNumber: 11,
    issueUrl: "https://github.com/openclaw/openclaw/issues/11",
    title: "PR ref",
  });
  assert.equal(pullRequestClaim.status, 200);
  assert.equal(pullRequestClaim.body.ok, false);
  assert.equal(pullRequestClaim.body.claim.status, "pull-request");

  const [concurrentOne, concurrentTwo] = await Promise.all([
    postClaim(base, token, {
      issueNumber: 9,
      issueUrl: "https://github.com/openclaw/openclaw/issues/9",
      title: "Concurrent claim",
    }),
    postClaim(base, token, {
      issueNumber: 9,
      issueUrl: "https://github.com/openclaw/openclaw/issues/9",
      title: "Concurrent claim",
    }),
  ]);
  assert.equal(concurrentOne.status, 200);
  assert.equal(concurrentTwo.status, 200);
  assert.deepEqual([concurrentOne.body.claim.status, concurrentTwo.body.claim.status].sort(), [
    "already-commented",
    "posted",
  ]);
  const concurrentState = JSON.parse(await fs.readFile(commentsPath, "utf8"));
  assert.equal(
    concurrentState.filter((comment: any) =>
      String(comment.body).includes("claw-queue-claim repo=openclaw/openclaw issue=9"),
    ).length,
    1,
  );
});

test("local Codex bridge keeps running after claim command failures", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-claim-failure-"));
  const fakeGh = await writeFakeFailingGhCommand(temp);
  const logDir = path.join(temp, "logs");

  const port = await freePort();
  const token = "runner-claim-failure-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    [
      "--workspace",
      repoRoot,
      "--port",
      String(port),
      "--token",
      token,
      "--log-dir",
      logDir,
      "--dry-run",
    ],
    { PATH: `${path.dirname(fakeGh)}${path.delimiter}${process.env.PATH || ""}` },
  );
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const claim = await postClaim(base, token, {
    issueNumber: 41,
    issueUrl: "https://github.com/openclaw/openclaw/issues/41",
    title: "claim failure should not crash",
  });
  assert.equal(claim.status, 500);
  assert.match(claim.body.error, /fake gh failure/);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const health = await waitForHealth(base, token, runner);
  assert.equal(health.ok, true);
});

test("local Codex bridge claims starts only after active capacity is available", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-start-claim-capacity-"));
  const fakeGh = await writeFakeGhCommand(temp);
  const fakeCodex = await writeFakeCodexCommand(temp);
  const workspace = await createGitWorkspace("claim-capacity");

  const port = await freePort();
  const token = "runner-start-claim-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    [
      "--workspace",
      workspace,
      "--worktree-dir",
      path.join(temp, "worktrees"),
      "--port",
      String(port),
      "--token",
      token,
      "--codex-bin",
      fakeCodex,
      "--max-active",
      "1",
    ],
    { PATH: `${path.dirname(fakeGh)}${path.delimiter}${process.env.PATH || ""}` },
  );
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const first = await postStart(base, token, "first claimed start", {
    issueNumber: 21,
    issueUrl: "https://github.com/openclaw/openclaw/issues/21",
    claimIssue: true,
  });
  assert.equal(first.status, 202);
  assert.equal(first.body.run.claimCommentStatus, "posted");

  const second = await postStart(base, token, "second blocked start", {
    issueNumber: 22,
    issueUrl: "https://github.com/openclaw/openclaw/issues/22",
    claimIssue: true,
  });
  assert.equal(second.status, 409);

  const commentsPath = path.join(temp, "comments.json");
  const comments = JSON.parse(await fs.readFile(commentsPath, "utf8"));
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /issue=21/);
  assert.doesNotMatch(comments[0].body, /issue=22/);

  await waitForRun(base, token, first.body.run.id, "completed");
});

test("local Codex bridge does not claim starts that fail before work begins", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-start-claim-failure-"));
  const fakeGh = await writeFakeGhCommand(temp);
  const fakeCodex = await writeFakeCodexCommand(temp);
  const workspace = await createGitWorkspace("claim-failure");

  const port = await freePort();
  const token = "runner-start-claim-failure-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    [
      "--workspace",
      workspace,
      "--worktree-dir",
      path.join(temp, "worktrees"),
      "--worktree-base",
      "missing-ref",
      "--port",
      String(port),
      "--token",
      token,
      "--codex-bin",
      fakeCodex,
    ],
    { PATH: `${path.dirname(fakeGh)}${path.delimiter}${process.env.PATH || ""}` },
  );
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const started = await postStart(base, token, "claimed start that cannot create worktree", {
    issueNumber: 31,
    issueUrl: "https://github.com/openclaw/openclaw/issues/31",
    claimIssue: true,
  });
  assert.equal(started.status, 500);

  const comments = JSON.parse(await fs.readFile(path.join(temp, "comments.json"), "utf8"));
  assert.deepEqual(comments, []);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].status, "failed");
  assert.equal(runs.runs[0].claimCommentStatus, null);
  assert.match(runs.runs[0].error, /missing-ref|invalid reference|not a commit/i);
});

test("local Codex bridge stops Codex before prompting when issue claim is blocked", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-start-claim-blocked-"));
  const fakeGh = await writeFakeGhCommand(temp);
  const markerPath = path.join(temp, "codex-started.txt");
  const fakeCodex = await writeFakeCodexCommand(temp, { markerPath });
  const workspace = await createGitWorkspace("claim-blocked");

  await fs.writeFile(
    path.join(temp, "comments.json"),
    JSON.stringify(
      [
        {
          html_url: "https://github.com/openclaw/openclaw/issues/51#issuecomment-1",
          body: "<!-- claw-queue-claim repo=openclaw/openclaw issue=51 -->",
          user: { login: "someone-else" },
        },
      ],
      null,
      2,
    ),
    "utf8",
  );

  const port = await freePort();
  const token = "runner-start-claim-blocked-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    [
      "--workspace",
      workspace,
      "--worktree-dir",
      path.join(temp, "worktrees"),
      "--port",
      String(port),
      "--token",
      token,
      "--codex-bin",
      fakeCodex,
    ],
    { PATH: `${path.dirname(fakeGh)}${path.delimiter}${process.env.PATH || ""}` },
  );
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const started = await postStart(base, token, "claim blocked start", {
    issueNumber: 51,
    issueUrl: "https://github.com/openclaw/openclaw/issues/51",
    claimIssue: true,
  });
  assert.equal(started.status, 409);
  assert.match(started.body.error, /@someone-else/);
  assert.equal(await fileExists(markerPath), true);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].status, "failed");
  assert.equal(typeof runs.runs[0].pid, "number");
  assert.equal(runs.runs[0].claimCommentStatus, null);
  assert.equal(runs.runs[0].worktreePath, null);
  assert.deepEqual(await readDirIfExists(path.join(temp, "worktrees")), []);
});

test("local Codex bridge does not claim when Codex exits before prompt", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-start-codex-early-exit-"));
  const fakeGh = await writeFakeGhCommand(temp);
  const fakeScript = path.join(temp, "fake-codex-exit.mjs");
  await fs.writeFile(fakeScript, "process.exit(1);\n", "utf8");
  const fakeCodex = await writeCommandShim(temp, fakeScript);
  const workspace = await createGitWorkspace("codex-early-exit");

  const port = await freePort();
  const token = "runner-start-codex-early-exit-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    [
      "--workspace",
      workspace,
      "--worktree-dir",
      path.join(temp, "worktrees"),
      "--port",
      String(port),
      "--token",
      token,
      "--codex-bin",
      fakeCodex,
    ],
    { PATH: `${path.dirname(fakeGh)}${path.delimiter}${process.env.PATH || ""}` },
  );
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const started = await postStart(base, token, "early exit before prompt", {
    issueNumber: 53,
    issueUrl: "https://github.com/openclaw/openclaw/issues/53",
    claimIssue: true,
  });
  assert.equal(started.status, 500);
  assert.match(started.body.error, /exited before prompt/);

  const comments = JSON.parse(await fs.readFile(path.join(temp, "comments.json"), "utf8"));
  assert.deepEqual(comments, []);
  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].status, "failed");
  assert.equal(runs.runs[0].claimCommentStatus, null);
  assert.equal(runs.runs[0].worktreePath, null);
});

test("local Codex bridge marks failed when worktree environment setup fails", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-start-env-failure-"));
  const fakeGh = await writeFakeGhCommand(temp);
  const markerPath = path.join(temp, "codex-started.txt");
  const fakeCodex = await writeFakeCodexCommand(temp, { markerPath });
  const workspace = await createGitWorkspace("env-failure");
  await fs.writeFile(path.join(workspace, ".tmp"), "blocks temp directory", "utf8");
  await runGit(["add", ".tmp"], workspace);
  await runGit(["commit", "-m", "block temp dir"], workspace);

  const port = await freePort();
  const token = "runner-start-env-failure-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    [
      "--workspace",
      workspace,
      "--worktree-dir",
      path.join(temp, "worktrees"),
      "--port",
      String(port),
      "--token",
      token,
      "--codex-bin",
      fakeCodex,
    ],
    { PATH: `${path.dirname(fakeGh)}${path.delimiter}${process.env.PATH || ""}` },
  );
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const started = await postStart(base, token, "env setup failure", {
    issueNumber: 52,
    issueUrl: "https://github.com/openclaw/openclaw/issues/52",
    claimIssue: true,
  });
  assert.equal(started.status, 500);
  assert.equal(await fileExists(markerPath), false);
  const comments = JSON.parse(await fs.readFile(path.join(temp, "comments.json"), "utf8"));
  assert.deepEqual(comments, []);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs[0].status, "failed");
  assert.equal(runs.runs[0].pid, null);
  assert.equal(runs.runs[0].worktreePath, null);
  assert.deepEqual(await readDirIfExists(path.join(temp, "worktrees")), []);
  const health = await waitForHealth(base, token, runner);
  assert.equal(health.active, 0);
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
  const fakeCodex = await writeFakeCodexCommand(temp, { delayMs: 5000 });
  const workspace = await createGitWorkspace("parallel");
  const worktreeDir = path.join(temp, "worktrees");

  const port = await freePort();
  const token = "runner-parallel-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner([
    "--workspace",
    workspace,
    "--worktree-dir",
    worktreeDir,
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
  assert.equal(health.baseWorkspace, workspace);
  assert.equal(health.worktreeDir, worktreeDir);

  const first = await postStart(base, token, "first parallel prompt", {
    codexReasoningEffort: "xhigh",
    proofMode: "local",
  });
  const duplicateFirst = await postStart(base, token, "duplicate first parallel prompt", {
    claimCommentStatus: "already-commented",
    claimCommentUrl: "https://github.com/openclaw/openclaw/issues/1#issuecomment-1",
  });
  const second = await postStart(base, token, "second parallel prompt", {
    issueNumber: 2,
    issueUrl: "https://github.com/openclaw/openclaw/issues/2",
  });
  const hidden = await patchRun(base, token, first.body.run.id, { status: "ready" });
  const third = await postStart(base, token, "third parallel prompt", {
    issueNumber: 3,
    issueUrl: "https://github.com/openclaw/openclaw/issues/3",
  });

  assert.equal(first.status, 202);
  assert.equal(first.body.run.codexReasoningEffort, "xhigh");
  assert.equal(first.body.run.proofMode, "local");
  assert.equal(first.body.run.baseWorkspace, workspace);
  assert.match(first.body.run.workspace, /worktrees/);
  assert.equal(first.body.run.workspace, first.body.run.worktreePath);
  assert.match(first.body.run.worktreeBranch, /^claw-queue\/issue-1-/);
  assert.equal(duplicateFirst.status, 200);
  assert.equal(duplicateFirst.body.duplicate, true);
  assert.equal(duplicateFirst.body.run.id, first.body.run.id);
  assert.equal(duplicateFirst.body.run.claimCommentStatus, "already-commented");
  assert.match(duplicateFirst.body.run.claimCommentUrl, /issuecomment-1/);
  assert.equal(second.status, 202);
  assert.equal(second.body.run.codexReasoningEffort, "high");
  assert.equal(second.body.run.proofMode, "auto");
  assert.notEqual(second.body.run.workspace, first.body.run.workspace);
  assert.match(second.body.run.worktreeBranch, /^claw-queue\/issue-2-/);
  assert.equal(hidden.status, 409);
  assert.match(hidden.body.error, /Codex process is active/);
  assert.equal(third.status, 409);
  assert.match(third.body.error, /2 active Codex run/);

  const activeHealth = await waitForHealth(base, token, runner);
  assert.equal(activeHealth.active, 2);

  const runs = await getRuns(base, token);
  assert.equal(runs.runs.filter((run: any) => run.status === "running").length, 2);

  const liveLog = await waitForRunLog(
    base,
    token,
    first.body.run.id,
    /model_reasoning_effort='xhigh'|Worktree/,
  );
  assert.equal(
    liveLog.entries.some((entry: any) => /model_reasoning_effort='xhigh'/.test(entry.text)),
    true,
  );
  assert.equal(
    liveLog.entries.some(
      (entry: any) => entry.type === "worktree" && /claw-queue/.test(entry.text),
    ),
    true,
  );
  assert.equal(
    liveLog.entries.some((entry: any) => entry.text?.includes(first.body.run.workspace)),
    true,
  );
  assert.equal(
    liveLog.entries.some((entry: any) => /fake codex started/.test(entry.text)),
    true,
  );

  await waitForRun(base, token, first.body.run.id, "completed");
  await waitForRun(base, token, second.body.run.id, "completed");
});

test("local Codex bridge injects primary and maintainer skill paths", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-skill-roots-"));
  const fakeCodex = await writeFakeCodexCommand(temp, {
    delayMs: 10,
    logStdin: true,
  });
  const workspace = await createGitWorkspace("skill-roots");
  const primarySkills = path.join(temp, "codex-skills");
  const maintainerSkills = path.join(temp, "maintainer-skills");
  await fs.mkdir(path.join(primarySkills, "openclaw-pre-pr-check"), { recursive: true });
  await fs.mkdir(path.join(primarySkills, "tokenjuice"), { recursive: true });
  await fs.mkdir(path.join(maintainerSkills, "review-pr"), { recursive: true });
  await fs.writeFile(
    path.join(primarySkills, "openclaw-pre-pr-check", "SKILL.md"),
    "# OpenClaw pre PR check\n",
  );
  await fs.writeFile(path.join(primarySkills, "tokenjuice", "SKILL.md"), "# Tokenjuice\n");
  await fs.writeFile(path.join(maintainerSkills, "review-pr", "SKILL.md"), "# Review PR\n");

  const port = await freePort();
  const token = "runner-skill-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner(
    [
      "--workspace",
      workspace,
      "--port",
      String(port),
      "--token",
      token,
      "--codex-bin",
      fakeCodex,
      "--skills-dir",
      primarySkills,
    ],
    { OPENCLAW_MAINTAINER_SKILLS_DIR: maintainerSkills },
  );
  t.after(() => stopRunner(runner));

  const health = await waitForHealth(base, token, runner);
  assert.match(health.tokenjuiceCommand, /tokenjuice/i);
  const started = await postStart(base, token, "skill context prompt", {
    issueNumber: 77,
    issueUrl: "https://github.com/openclaw/openclaw/issues/77",
  });
  assert.equal(started.status, 202);

  const log = await waitForRunLog(base, token, started.body.run.id, /fake codex stdin/);
  const text = [log.text || "", ...(log.entries || []).map((entry: any) => entry.text || "")].join(
    "\n",
  );
  assert.match(text, /openclaw-pre-pr-check/);
  assert.match(text, /Tokenjuice output compaction/);
  assert.match(text, /tokenjuice doctor hooks/);
  assert.match(text, /tokenjuice: .*SKILL\.md/i);
  assert.match(text, /review-pr/);
  assert.match(text, /maintainer handbook gates/);
});

test("local Codex bridge classifies successful parked handoffs as parked", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-parked-codex-"));
  const fakeCodex = await writeFakeCodexCommand(temp, {
    delayMs: 500,
    finalMessage:
      "Parked before PR. I did not open a PR because Crabbox/live proof is required and unavailable.\nCodex review: blocked locally.\nCI/ClawSweeper: no PR opened.",
  });
  const workspace = await createGitWorkspace("parked");

  const port = await freePort();
  const token = "runner-parked-token";
  const base = `http://127.0.0.1:${port}`;
  const runner = startRunner([
    "--workspace",
    workspace,
    "--worktree-dir",
    path.join(temp, "worktrees"),
    "--port",
    String(port),
    "--token",
    token,
    "--codex-bin",
    fakeCodex,
  ]);
  t.after(() => stopRunner(runner));

  await waitForHealth(base, token, runner);
  const started = await postStart(base, token, "parked prompt", {
    issueNumber: 11,
    issueUrl: "https://github.com/openclaw/openclaw/issues/11",
  });
  assert.equal(started.status, 202);

  const run = await waitForRun(base, token, started.body.run.id, "parked");
  assert.equal(run.exitCode, 0);
  assert.match(run.note, /Parked before PR/);
  assert.match(run.note, /Codex review: blocked/);

  const log = await getRunLog(base, token, run.id);
  assert.equal(
    log.log.entries.some(
      (entry: any) => entry.type === "environment" && /lock worktree/.test(entry.text),
    ),
    true,
  );
});

test(
  "local Codex bridge launches Windows cmd shims and rejects concurrent starts",
  { skip: process.platform !== "win32" },
  async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-codex-shim-"));
    const fakeCmd = path.join(temp, "codex.cmd");
    const argsPath = path.join(temp, "args.txt");
    const workspace = await createGitWorkspace("shim");
    await fs.writeFile(
      fakeCmd,
      `@echo off\r\necho %* > "${argsPath}"\r\nmore >nul\r\nping 127.0.0.1 -n 3 >nul\r\nexit /b 0\r\n`,
    );

    const port = await freePort();
    const token = "runner-shim-token";
    const base = `http://127.0.0.1:${port}`;
    const runner = startRunner([
      "--workspace",
      workspace,
      "--worktree-dir",
      path.join(temp, "worktrees"),
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

    const first = await postStart(base, token, "first shim prompt", {
      codexReasoningEffort: "xhigh",
    });
    assert.equal(first.status, 202);
    assert.equal(first.body.run.status, "running");

    const second = await postStart(base, token, "second shim prompt", {
      issueNumber: 2,
      issueUrl: "https://github.com/openclaw/openclaw/issues/2",
    });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /active Codex run/);

    const finalRun = await waitForRun(base, token, first.body.run.id, "completed");
    assert.equal(finalRun.exitCode, 0);
    const argsText = await fs.readFile(argsPath, "utf8");
    assert.match(argsText, /model_reasoning_effort='xhigh'/);
    assert.equal(argsText.includes('model_reasoning_effort=\\"xhigh\\"'), false);
  },
);

function startRunner(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["scripts/openclaw-codex-runner.mjs", ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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

async function postStart(
  base: string,
  token: string,
  prompt: string,
  extra: Record<string, unknown> = {},
) {
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
      ...extra,
    }),
  });
  return { body: await response.json().catch(() => ({})), status: response.status };
}

async function postTrack(
  base: string,
  token: string,
  prompt: string,
  extra: Record<string, unknown> = {},
) {
  return postTrackIssue(base, token, {
    issueNumber: 2,
    issueUrl: "https://github.com/openclaw/openclaw/issues/2",
    prompt,
    extra,
  });
}

async function postTrackIssue(
  base: string,
  token: string,
  issue: {
    issueNumber: number;
    issueUrl: string;
    prompt: string;
    extra?: Record<string, unknown>;
  },
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
      ...issue.extra,
    }),
  });
  return { body: await response.json().catch(() => ({})), status: response.status };
}

async function postClaim(
  base: string,
  token: string,
  issue: { issueNumber: number; issueUrl: string; title: string },
) {
  const response = await fetch(`${base}/claim`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(issue),
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readDirIfExists(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeFakeCodexCommand(
  directory: string,
  options: {
    delayMs?: number;
    finalMessage?: string;
    markerPath?: string;
    logStdin?: boolean;
  } = {},
): Promise<string> {
  const fakeScript = path.join(directory, "fake-codex.mjs");
  const delayMs = options.delayMs ?? 1200;
  const finalMessage = options.finalMessage || "fake codex completed";
  await fs.writeFile(
    fakeScript,
    [
      "import { setTimeout } from 'node:timers/promises';",
      "import fs from 'node:fs/promises';",
      options.markerPath
        ? `await fs.writeFile(${JSON.stringify(options.markerPath)}, 'started', 'utf8');`
        : "",
      "console.log(JSON.stringify({ type: 'agent_message', message: 'fake codex started' }));",
      "console.log(JSON.stringify({ type: 'agent_message', message: `fake codex cwd ${process.cwd()}` }));",
      "console.log(JSON.stringify({ type: 'agent_message', message: `fake codex argv ${JSON.stringify(process.argv.slice(2))}` }));",
      "console.log(JSON.stringify({ type: 'agent_message', message: `fake codex env temp ${process.env.TEMP || process.env.TMP || ''} corepack ${process.env.COREPACK_HOME || ''} lock ${process.env.OPENCLAW_HEAVY_CHECK_LOCK_SCOPE || ''}` }));",
      "console.error('fake codex stderr proof');",
      options.logStdin
        ? "let stdin = ''; for await (const chunk of process.stdin) stdin += String(chunk); console.log(JSON.stringify({ type: 'agent_message', message: `fake codex stdin ${stdin}` }));"
        : "process.stdin.resume();",
      `await setTimeout(${JSON.stringify(delayMs)});`,
      `console.log(JSON.stringify({ type: 'agent_message', message: ${JSON.stringify(finalMessage)} }));`,
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

async function writeCommandShim(directory: string, scriptPath: string): Promise<string> {
  if (process.platform === "win32") {
    const command = path.join(directory, "codex-exit.cmd");
    await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return command;
  }
  const command = path.join(directory, "codex-exit");
  await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, {
    mode: 0o755,
  });
  return command;
}

async function writeFakeGhCommand(directory: string): Promise<string> {
  const commentsPath = path.join(directory, "comments.json");
  await fs.writeFile(commentsPath, "[]", "utf8");
  const fakeScript = path.join(directory, "fake-gh.mjs");
  await fs.writeFile(
    fakeScript,
    [
      "import fs from 'node:fs/promises';",
      `const commentsPath = ${JSON.stringify(commentsPath)};`,
      "const args = process.argv.slice(2);",
      "const input = await new Promise((resolve) => { let text = ''; process.stdin.on('data', (chunk) => text += chunk); process.stdin.on('end', () => resolve(text)); });",
      "const read = async () => JSON.parse(await fs.readFile(commentsPath, 'utf8'));",
      "const write = async (comments) => fs.writeFile(commentsPath, JSON.stringify(comments, null, 2));",
      "if (args[0] !== 'api') { console.error('expected api'); process.exit(2); }",
      "if (args[1] === 'user') { console.log(JSON.stringify({ login: 'brokemac79' })); process.exit(0); }",
      "const pathArg = args.find((arg) => /^repos\\//.test(arg));",
      "if (!pathArg) { console.error('missing path'); process.exit(2); }",
      "const comments = await read();",
      "const issueOnly = pathArg.match(/^repos\\/([^/]+)\\/([^/]+)\\/issues\\/(\\d+)$/);",
      "if (issueOnly) {",
      "  const issue = issueOnly[3];",
      "  console.log(JSON.stringify({ html_url: `https://github.com/openclaw/openclaw/issues/${issue}`, state: issue === '10' ? 'closed' : 'open', pull_request: issue === '11' ? {} : undefined }));",
      "  process.exit(0);",
      "}",
      "if (args.includes('-X') && args.includes('POST')) {",
      "  const payload = JSON.parse(input || '{}');",
      "  const issue = pathArg.match(/issues\\/(\\d+)\\/comments/)?.[1] || '0';",
      "  const row = { html_url: `https://github.com/openclaw/openclaw/issues/${issue}#issuecomment-${comments.length + 1}`, body: payload.body || '', user: { login: 'brokemac79' } };",
      "  comments.push(row);",
      "  await write(comments);",
      "  console.log(JSON.stringify(row));",
      "  process.exit(0);",
      "}",
      "if (!args.includes('--paginate') || !args.includes('--slurp')) { console.error('missing pagination'); process.exit(3); }",
      "console.log(JSON.stringify([comments]));",
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    const command = path.join(directory, "gh.cmd");
    await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
    return command;
  }
  const command = path.join(directory, "gh");
  await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, {
    mode: 0o755,
  });
  return command;
}

async function writeFakeFailingGhCommand(directory: string): Promise<string> {
  const fakeScript = path.join(directory, "fake-failing-gh.mjs");
  await fs.writeFile(
    fakeScript,
    ["console.error('fake gh failure');", "process.exit(42);", ""].join("\n"),
  );
  if (process.platform === "win32") {
    const command = path.join(directory, "gh.cmd");
    await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
    return command;
  }
  const command = path.join(directory, "gh");
  await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, {
    mode: 0o755,
  });
  return command;
}

async function createGitWorkspace(name: string): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `cf-git-${name}-`));
  await runGit(["init"], workspace);
  await runGit(["config", "user.email", "claw-queue@example.invalid"], workspace);
  await runGit(["config", "user.name", "Claw Queue Test"], workspace);
  await fs.writeFile(path.join(workspace, "README.md"), `# ${name}\n`, "utf8");
  await runGit(["add", "README.md"], workspace);
  await runGit(["commit", "-m", "initial"], workspace);
  return workspace;
}

async function runGit(args: string[], cwd: string): Promise<void> {
  const child = spawn("git", args, {
    cwd,
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
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 0));
  });
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${output}`);
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
