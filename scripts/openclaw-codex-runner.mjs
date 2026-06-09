#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const host = String(args.host || process.env.OPENCLAW_CODEX_RUNNER_HOST || "127.0.0.1");
const port = integer(args.port || process.env.OPENCLAW_CODEX_RUNNER_PORT, 4545);
const workspace = path.resolve(String(args.workspace || process.cwd()));
const codexBin = String(args["codex-bin"] || process.env.CODEX_BIN || "codex");
const codexLaunch = resolveCodexLaunch(codexBin);
const tokenjuiceBin = String(args["tokenjuice-bin"] || process.env.TOKENJUICE_BIN || "tokenjuice");
const tokenjuiceLaunch = resolveCommandLaunch(tokenjuiceBin);
const providedToken = String(args.token || process.env.OPENCLAW_CODEX_RUNNER_TOKEN || "");
const token = providedToken || crypto.randomBytes(24).toString("base64url");
const dryRun = Boolean(args["dry-run"]);
const skillsDir = path.resolve(
  String(
    args["skills-dir"] ||
      process.env.OPENCLAW_CODEX_SKILLS_DIR ||
      process.env.CODEX_SKILLS_DIR ||
      path.join(os.homedir(), ".codex", "skills"),
  ),
);
const skillRoots = relevantSkillRoots(skillsDir);
const includeSkillContext = !args["no-skill-context"];
const defaultReasoningEffort = reasoningEffort(
  args["reasoning-effort"] || process.env.OPENCLAW_CODEX_REASONING_EFFORT,
  "high",
);
const maxActive = Math.max(
  1,
  Math.min(16, integer(args["max-active"] || process.env.OPENCLAW_CODEX_RUNNER_MAX_ACTIVE, 1)),
);
const defaultLogDir = path.join(
  os.tmpdir(),
  "crabfleet-openclaw-codex-runs",
  sha256(workspace).slice(0, 16),
);
const logDir = path.resolve(String(args["log-dir"] || defaultLogDir));
const worktreeDir = path.resolve(
  String(
    args["worktree-dir"] ||
      process.env.OPENCLAW_CODEX_WORKTREE_DIR ||
      path.join(logDir, "worktrees"),
  ),
);
const worktreeBase = clean(
  args["worktree-base"] || process.env.OPENCLAW_CODEX_WORKTREE_BASE || "HEAD",
  160,
);
const statePath = path.join(logDir, "runs.json");
const runs = new Map();
const trackReservations = new Map();
const claimReservations = new Map();
let persistTimer = null;
let gitcrawlDoctorCache = null;

if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  console.error(`Workspace does not exist or is not a directory: ${workspace}`);
  process.exit(1);
}

await loadPersistedRuns();

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(
      request,
      response,
      { ok: false, error: error.message || String(error), claim: error.claim || null },
      integer(error.status, 500),
    );
  });
});

server.listen(port, host, () => {
  console.log(`Claw Queue Codex bridge listening on http://${host}:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Logs: ${logDir}`);
  console.log(`Tokenjuice: ${tokenjuiceLaunch.display}`);
  if (includeSkillContext) console.log(`Skills: ${skillRoots.join(", ")}`);
  console.log(`Token: ${token}`);
  if (!providedToken) {
    console.log("A token was generated for this run. Paste it into Claw Queue before testing.");
  }
  if (!isLoopbackHost(host)) {
    console.warn("Warning: this bridge is not bound to a loopback-only host.");
  }
});

async function handleRequest(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }

  const url = new URL(request.url || "/", `http://${header(request, "host") || `${host}:${port}`}`);
  if (url.pathname === "/health" && request.method === "GET") {
    if (!authorized(request)) return unauthorized(request, response);
    sendJson(request, response, {
      ok: true,
      runner: "claw-queue-codex-bridge",
      workspace,
      codexBin,
      codexCommand: codexLaunch.display,
      tokenjuiceBin,
      tokenjuiceCommand: tokenjuiceLaunch.display,
      dryRun,
      defaultReasoningEffort,
      active: activeRuns().length,
      maxActive,
      baseWorkspace: workspace,
      worktreeDir,
      worktreeBase,
      logDir,
    });
    return;
  }

  if (url.pathname === "/runs" && request.method === "GET") {
    if (!authorized(request)) return unauthorized(request, response);
    sendJson(request, response, { ok: true, runs: visibleRuns() });
    return;
  }

  if (url.pathname === "/gitcrawl/coverage" && request.method === "POST") {
    if (!authorized(request)) return unauthorized(request, response);
    const body = await readJson(request);
    const result = await readGitcrawlCoverage(body).catch((error) => ({
      ok: false,
      source: "gitcrawl",
      error: error.message || String(error),
    }));
    sendJson(request, response, result);
    return;
  }

  if (url.pathname === "/gitcrawl/workflow" && request.method === "POST") {
    if (!authorized(request)) return unauthorized(request, response);
    const body = await readJson(request);
    const result = await readGitcrawlWorkflow(body).catch((error) => ({
      ok: false,
      source: "gitcrawl",
      error: error.message || String(error),
    }));
    sendJson(request, response, result);
    return;
  }

  if (url.pathname === "/claim" && request.method === "POST") {
    if (!authorized(request)) return unauthorized(request, response);
    const body = await readJson(request);
    const result = await claimGitHubIssueSerialized(body);
    sendJson(request, response, result);
    return;
  }

  const logMatch = url.pathname.match(/^\/runs\/([^/]+)\/log$/);
  if (logMatch && request.method === "GET") {
    if (!authorized(request)) return unauthorized(request, response);
    const id = decodeURIComponent(logMatch[1] || "");
    const run = runs.get(id);
    if (!run) {
      sendJson(request, response, { ok: false, error: "run not found" }, 404);
      return;
    }
    const log = await readRunLog(run, url);
    sendJson(request, response, { ok: true, run, log });
    return;
  }

  const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch && request.method === "GET") {
    if (!authorized(request)) return unauthorized(request, response);
    const run = runs.get(decodeURIComponent(runMatch[1] || ""));
    sendJson(
      request,
      response,
      run ? { ok: true, run } : { ok: false, error: "run not found" },
      run ? 200 : 404,
    );
    return;
  }

  if (runMatch && request.method === "PATCH") {
    if (!authorized(request)) return unauthorized(request, response);
    const id = decodeURIComponent(runMatch[1] || "");
    const run = runs.get(id);
    if (!run) {
      sendJson(request, response, { ok: false, error: "run not found" }, 404);
      return;
    }
    const body = await readJson(request);
    const updateError = updateRunFromBody(run, body);
    if (updateError) {
      sendJson(request, response, { ok: false, error: updateError.error }, updateError.status);
      return;
    }
    updateRunClaimFromBody(run, body);
    persistRunsSoon();
    sendJson(request, response, { ok: true, run });
    return;
  }

  if (url.pathname === "/start" && request.method === "POST") {
    if (!authorized(request)) return unauthorized(request, response);
    const body = await readJson(request);
    const prompt = clean(body.prompt, 100_000);
    if (!prompt) {
      sendJson(request, response, { ok: false, error: "prompt is required" }, 400);
      return;
    }
    const existing = visibleRunForIssue(integer(body.issueNumber, null), clean(body.issueUrl, 500));
    if (existing) {
      updateRunClaimFromBody(existing, body);
      sendJson(request, response, { ok: true, duplicate: true, run: existing }, 200);
      return;
    }
    const active = activeRuns();
    if (active.length >= maxActive) {
      sendJson(
        request,
        response,
        {
          ok: false,
          error: `runner already has ${active.length} active Codex run(s) in this workspace`,
          run: active[0],
          runs: active,
        },
        409,
      );
      return;
    }
    const run = await startCodexRun(body, prompt, { beforePrompt: claimStartedRunIfRequested });
    sendJson(request, response, { ok: true, run }, 202);
    return;
  }

  if (url.pathname === "/track" && request.method === "POST") {
    if (!authorized(request)) return unauthorized(request, response);
    const body = await readJson(request);
    const run = await trackManualRun(body);
    sendJson(request, response, { ok: true, run }, 201);
    return;
  }

  sendJson(request, response, { ok: false, error: "not found" }, 404);
}

async function startCodexRun(body, prompt, options = {}) {
  const id = `oc-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const logPath = path.join(logDir, `${id}.jsonl`);
  const codexReasoningEffort = reasoningEffort(
    body.codexReasoningEffort || body.reasoningEffort,
    defaultReasoningEffort,
  );
  const proofModeValue = proofMode(body.proofMode || body.openClawProofMode, "auto");
  const run = {
    id,
    status: dryRun ? "dry-run" : "starting",
    pid: null,
    issueNumber: integer(body.issueNumber, null),
    issueUrl: clean(body.issueUrl, 500),
    title: clean(body.title, 300),
    queueId: clean(body.queueId, 80),
    codexReasoningEffort,
    proofMode: proofModeValue,
    claimCommentUrl: clean(body.claimCommentUrl, 500) || null,
    claimCommentStatus: clean(body.claimCommentStatus, 80) || null,
    workspace: dryRun ? workspace : null,
    baseWorkspace: workspace,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBase,
    logPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    note: null,
    lastActivityLines: [],
    source: "codex",
    updatedAt: new Date().toISOString(),
  };
  runs.set(id, run);
  persistRunsSoon();

  let log;
  try {
    await fsp.mkdir(logDir, { recursive: true });
    log = await openLogStream(logPath);
    log.write(
      `${JSON.stringify({
        type: "request",
        at: run.startedAt,
        issueNumber: run.issueNumber,
        issueUrl: run.issueUrl,
        title: run.title,
        queueId: run.queueId,
        codexReasoningEffort: run.codexReasoningEffort,
        proofMode: run.proofMode,
        claimCommentUrl: run.claimCommentUrl,
        claimCommentStatus: run.claimCommentStatus,
        baseWorkspace: run.baseWorkspace,
        worktreeBase: run.worktreeBase,
        dryRun,
      })}\n`,
    );
  } catch (error) {
    markRunFailed(run, error);
    throw error;
  }

  if (dryRun) {
    log.write(`${JSON.stringify({ type: "prompt", text: prompt })}\n`);
    log.end();
    run.finishedAt = new Date().toISOString();
    run.exitCode = 0;
    run.updatedAt = run.finishedAt;
    persistRunsSoon();
    return run;
  }

  let runWorkspace;
  try {
    runWorkspace = await createRunWorktree(run, log);
  } catch (error) {
    markRunFailed(run, error);
    log.write(`${JSON.stringify({ type: "error", error: run.error, at: run.finishedAt })}\n`);
    log.end();
    throw error;
  }

  let childEnv;
  try {
    childEnv = await prepareCodexRunEnvironment(runWorkspace, log);
  } catch (error) {
    await cleanupRunWorktree(run, log).catch((cleanupError) => {
      log.write(
        `${JSON.stringify({
          type: "cleanup-error",
          error: cleanupError.message || String(cleanupError),
          at: new Date().toISOString(),
        })}\n`,
      );
    });
    markRunFailed(run, error);
    log.write(`${JSON.stringify({ type: "error", error: run.error, at: run.finishedAt })}\n`);
    log.end();
    throw error;
  }
  const observer = createRunOutputObserver();
  const codexArgs = [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-c",
    `model_reasoning_effort='${run.codexReasoningEffort}'`,
    "-",
  ];
  const child = spawn(codexLaunch.command, codexLaunchArgs(codexLaunch, codexArgs), {
    cwd: runWorkspace,
    env: childEnv,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(codexLaunch.cmdTarget),
  });

  run.pid = child.pid ?? null;
  run.status = "running";
  let childError = null;
  let logEnded = false;
  const writeLog = (value) => {
    appendRunActivity(run, value);
    if (!logEnded) log.write(value);
  };
  const endLog = () => {
    if (logEnded) return;
    logEnded = true;
    log.end();
  };

  child.stdin.on("error", (error) => {
    writeLog(`${JSON.stringify({ type: "stdin-error", error: error.message || String(error) })}\n`);
  });
  child.stdout.on("data", (chunk) => {
    observer.push(String(chunk));
    writeLog(chunk);
  });
  child.stderr.on("data", (chunk) => {
    writeLog(`${JSON.stringify({ type: "stderr", text: String(chunk) })}\n`);
  });
  child.once("error", (error) => {
    childError = error;
  });
  child.once("close", (code, signal) => {
    const outcome = childError || code !== 0 ? null : observer.outcome();
    run.status = childError || code !== 0 ? "failed" : outcome?.status || "completed";
    run.exitCode = code;
    run.signal = signal;
    if (childError) run.error = childError.message || String(childError);
    if (outcome?.note && !run.note) run.note = outcome.note;
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    writeLog(
      `${JSON.stringify({
        type: childError ? "error" : "exit",
        code,
        signal,
        error: run.error || null,
        at: run.finishedAt,
      })}\n`,
    );
    endLog();
    persistRunsSoon();
  });
  const assertChildPromptable = () => {
    if (
      run.status === "failed" ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      childError
    ) {
      const message =
        run.error ||
        childError?.message ||
        `Codex process exited before prompt (code ${child.exitCode ?? run.exitCode ?? "unknown"})`;
      run.status = "failed";
      run.error = message;
      run.finishedAt = run.finishedAt || new Date().toISOString();
      run.updatedAt = run.finishedAt;
      persistRunsSoon();
      throw new Error(message);
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    assertChildPromptable();
  } catch (error) {
    await cleanupRunWorktree(run, { write() {} }).catch(() => {});
    throw error;
  }
  try {
    await options.beforePrompt?.(run, body, log, assertChildPromptable);
    assertChildPromptable();
  } catch (error) {
    await stopChild(child);
    await cleanupRunWorktree(run, log).catch((cleanupError) => {
      writeLog(
        `${JSON.stringify({
          type: "cleanup-error",
          error: cleanupError.message || String(cleanupError),
          at: new Date().toISOString(),
        })}\n`,
      );
    });
    markRunFailed(run, error);
    run.note = clean(error.claim?.error || error.message || String(error), 500);
    writeLog(
      `${JSON.stringify({
        type: "error",
        error: run.error,
        claim: error.claim || null,
        at: run.finishedAt,
      })}\n`,
    );
    endLog();
    throw error;
  }
  assertChildPromptable();
  child.stdin.end(openClawRunnerPrompt(prompt, run));
  return run;
}

async function claimStartedRunIfRequested(run, body, log, assertChildPromptable = () => {}) {
  if (dryRun || !flag(body.claimIssue) || clean(body.claimCommentStatus, 80)) {
    return;
  }
  assertChildPromptable();
  const result = await claimGitHubIssueSerialized(body).catch((error) => ({
    ok: false,
    error: error.message || String(error),
    claim: error.claim || null,
  }));
  if (result.ok === false) {
    const status = blockedClaimStatus(result.claim?.status) ? 409 : 500;
    const error = new Error(result.error || "Claim comment failed");
    error.status = status;
    error.claim = result.claim || null;
    throw error;
  }
  run.claimCommentStatus = result.claim?.status || null;
  run.claimCommentUrl = result.claim?.url || null;
  run.updatedAt = new Date().toISOString();
  log.write(
    `${JSON.stringify({
      type: "claim",
      at: run.updatedAt,
      status: run.claimCommentStatus,
      url: run.claimCommentUrl,
      claim: result.claim || null,
    })}\n`,
  );
  persistRunsSoon();
}

async function trackManualRun(body) {
  const issueNumber = integer(body.issueNumber, null);
  const issueUrl = clean(body.issueUrl, 500);
  const existing = visibleRunForIssue(issueNumber, issueUrl);
  if (existing) return existing;
  const key = issueKey(issueNumber, issueUrl);
  const pending = key ? trackReservations.get(key) : null;
  if (pending) return pending;

  const pendingRun = createManualTrackedRun(body, issueNumber, issueUrl);
  if (key) {
    trackReservations.set(key, pendingRun);
    pendingRun
      .finally(() => {
        trackReservations.delete(key);
      })
      .catch(() => {});
  }
  return pendingRun;
}

async function claimGitHubIssue(body) {
  const parsedIssue = parseIssueRef(body.issueUrl);
  const repo = normalizeRepo(body.repo || parsedIssue.repo || "openclaw/openclaw");
  const issueNumber = integer(body.issueNumber, null) || parsedIssue.issueNumber;
  if (!repo) return { ok: false, error: "repo must be owner/name" };
  if (!issueNumber || issueNumber <= 0) return { ok: false, error: "issueNumber is required" };

  const issue = await ghJson(["api", `repos/${repo}/issues/${issueNumber}`]);
  if (issue?.pull_request) {
    return {
      ok: false,
      error: "Refusing to claim a pull request URL as issue work.",
      claim: {
        status: "pull-request",
        url: clean(issue.html_url, 500) || null,
      },
    };
  }
  if (clean(issue?.state, 40).toLowerCase() !== "open") {
    const state = clean(issue?.state, 40) || "not open";
    return {
      ok: false,
      error: `Refusing to claim issue because it is ${state}.`,
      claim: {
        status: "not-open",
        url: clean(issue?.html_url, 500) || null,
        state,
      },
    };
  }

  const currentUserLogin = await ghCurrentUserLogin();
  const marker = claimCommentMarker(repo, issueNumber);
  const existingPages = await ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
  ]);
  const existing = flattenGhPages(existingPages);
  const existingComment = Array.isArray(existing)
    ? existing.find((comment) => String(comment?.body || "").includes(marker))
    : null;
  if (existingComment) {
    const authorLogin = clean(existingComment?.user?.login, 80).toLowerCase();
    if (authorLogin !== currentUserLogin) {
      const author = authorLogin ? `@${authorLogin}` : "an unknown user";
      return {
        ok: false,
        error: `Issue already has a Claw Queue claim by ${author}`,
        claim: {
          status: "claimed-by-other",
          url: clean(existingComment.html_url, 500) || null,
          author: authorLogin || null,
          marker,
        },
      };
    }
    return {
      ok: true,
      claim: {
        status: "already-commented",
        url: clean(existingComment.html_url, 500) || null,
        marker,
      },
    };
  }

  const comment = claimCommentBody(body, repo, issueNumber, marker);
  const created = await ghJson(
    ["api", "-X", "POST", `repos/${repo}/issues/${issueNumber}/comments`, "--input", "-"],
    { input: JSON.stringify({ body: comment }) },
  );
  return {
    ok: true,
    claim: {
      status: "posted",
      url: clean(created?.html_url, 500) || null,
      marker,
    },
  };
}

async function claimGitHubIssueSerialized(body) {
  const key = claimIssueKey(body);
  if (!key) return claimGitHubIssue(body);
  const previous = claimReservations.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => claimGitHubIssue(body));
  const reservation = next
    .catch(() => {})
    .finally(() => {
      if (claimReservations.get(key) === reservation) claimReservations.delete(key);
    });
  claimReservations.set(key, reservation);
  return next;
}

function blockedClaimStatus(status) {
  return ["claimed-by-other", "not-open", "pull-request"].includes(clean(status, 80));
}

function claimIssueKey(body) {
  const parsedIssue = parseIssueRef(body.issueUrl);
  const repo = normalizeRepo(body.repo || parsedIssue.repo || "openclaw/openclaw");
  const issueNumber = integer(body.issueNumber, null) || parsedIssue.issueNumber;
  return repo && issueNumber && issueNumber > 0 ? `${repo}#${issueNumber}` : "";
}

async function ghCurrentUserLogin() {
  const user = await ghJson(["api", "user"]);
  const login = clean(user?.login, 80).toLowerCase();
  if (!login) throw new Error("gh api user did not return a login");
  return login;
}

function flattenGhPages(value) {
  if (!Array.isArray(value)) return [];
  if (value.every((page) => Array.isArray(page))) return value.flat();
  return value;
}

async function readGitcrawlCoverage(body) {
  const repo = normalizeRepo(body.repo || "openclaw/openclaw");
  if (!repo) return { ok: false, error: "repo must be owner/name" };
  const issueNumbers = uniqueIssueNumbers(body.issueNumbers || body.numbers).slice(0, 80);
  if (!issueNumbers.length) {
    return { ok: true, source: "gitcrawl", repo, coverage: {}, warning: null };
  }

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    return {
      ok: false,
      error: `node:sqlite is unavailable in this Node runtime: ${error.message || String(error)}`,
    };
  }

  const doctor = await gitcrawlDoctor();
  const dbPath = doctor?.runtime_db_health?.path || doctor?.db_path;
  if (!dbPath) return { ok: false, error: "gitcrawl doctor did not report a database path" };

  const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const coverage = await readGitcrawlCoverageFromDatabase(database, repo, issueNumbers, doctor);
    return {
      ok: true,
      source: "gitcrawl",
      repo,
      coverage: coverage.coverage,
      lastSyncAt: doctor?.last_sync_at || null,
      dbPath,
      warning:
        "Local Gitcrawl fallback checks open PR titles and indexed excerpts; use live GitHub before final claims.",
    };
  } finally {
    database.close();
  }
}

async function readGitcrawlWorkflow(body) {
  const repo = normalizeRepo(body.repo || "openclaw/openclaw");
  if (!repo) return { ok: false, error: "repo must be owner/name" };
  const roleMode = oneOf(
    body.roleMode,
    ["contributor", "trial_maintainer", "maintainer"],
    "trial_maintainer",
  );
  const minimumIssueAgeHours = Math.max(0, Math.min(168, integer(body.minimumIssueAgeHours, 6)));
  const githubLogin = clean(body.githubLogin || body.login, 80).toLowerCase();

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    return {
      ok: false,
      error: `node:sqlite is unavailable in this Node runtime: ${error.message || String(error)}`,
    };
  }

  const doctor = await gitcrawlDoctor();
  const dbPath = doctor?.runtime_db_health?.path || doctor?.db_path;
  if (!dbPath) return { ok: false, error: "gitcrawl doctor did not report a database path" };

  const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const now = Date.now();
    const queueDefinitions = localOpenClawQueuesForRole(roleMode);
    const queues = queueDefinitions.map((definition) =>
      readGitcrawlQueue(database, repo, definition, now, minimumIssueAgeHours),
    );
    const issueNumbers = uniqueIssueNumbers(
      queues.flatMap((queue) => queue.candidates.map((candidate) => candidate.number)),
    ).slice(0, 80);
    const coverage = issueNumbers.length
      ? await readGitcrawlCoverageFromDatabase(database, repo, issueNumbers, doctor)
      : { coverage: {}, coveredIssueCount: 0 };
    const coverageMap = coverage.coverage || {};
    const queuesWithCoverage = queues.map((queue) => ({
      ...queue,
      candidates: queue.candidates.map((candidate) => ({
        ...candidate,
        possiblePrCoverage: coverageMap[String(candidate.number)] || [],
        prCoverageUnknown: false,
        prCoverageWarning: null,
      })),
    }));
    return {
      ok: true,
      source: "gitcrawl",
      repo,
      generatedAt: Date.now(),
      queues: queuesWithCoverage,
      pullRequests: {
        items: githubLogin ? readGitcrawlAuthoredPullRequests(database, repo, githubLogin) : [],
        error: githubLogin ? null : "GitHub login is not configured",
        source: "gitcrawl",
        loginConfigured: Boolean(githubLogin),
      },
      localCoverage: {
        source: "gitcrawl",
        lastSyncAt: doctor?.last_sync_at || null,
        warning:
          "Local Gitcrawl snapshot is used for broad queue and PR coverage reads; live GitHub is still required before claims, comments, PR updates, and final handoff.",
        lookupIssueCount: issueNumbers.length,
        coveredIssueCount: coverage.coveredIssueCount || 0,
      },
    };
  } finally {
    database.close();
  }
}

async function readGitcrawlCoverageFromDatabase(database, repo, issueNumbers, doctor) {
  const rows = queryGitcrawlOpenPullRequests(database, repo, issueNumbers);
  const coverage = {};
  for (const issueNumber of issueNumbers) coverage[String(issueNumber)] = [];
  const coveredIssues = new Set();
  for (const row of rows) {
    for (const issueNumber of issueNumbers) {
      const reason = gitcrawlPrIssueReferenceReason(repo, row, issueNumber);
      if (!reason) continue;
      const list = coverage[String(issueNumber)] || [];
      if (list.some((item) => item.number === row.number)) continue;
      list.push({
        number: row.number,
        title: row.title,
        url: row.html_url,
        author: row.author_login || null,
        draft: Boolean(row.is_draft),
        updatedAt: row.updated_at_gh || row.updated_at || null,
        reason,
      });
      coverage[String(issueNumber)] = list;
      coveredIssues.add(issueNumber);
    }
  }
  return {
    ok: true,
    source: "gitcrawl",
    repo,
    coverage,
    lastSyncAt: doctor?.last_sync_at || null,
    coveredIssueCount: coveredIssues.size,
  };
}

function parseIssueRef(value) {
  try {
    const url = new URL(String(value || ""));
    const parts = url.pathname.split("/").filter(Boolean);
    const issueNumber = Number(parts[3]);
    if (
      url.hostname.toLowerCase() === "github.com" &&
      parts.length >= 4 &&
      parts[2] === "issues" &&
      Number.isInteger(issueNumber) &&
      issueNumber > 0
    ) {
      return {
        repo: normalizeRepo(`${parts[0]}/${parts[1]}`),
        issueNumber,
      };
    }
  } catch {}
  return { repo: "", issueNumber: null };
}

function claimCommentMarker(repo, issueNumber) {
  return `<!-- claw-queue-claim repo=${repo} issue=${issueNumber} -->`;
}

function claimCommentBody(body, repo, issueNumber, marker) {
  const custom = clean(body.claimComment || body.comment, 2000);
  if (custom) return custom.includes(marker) ? custom : `${custom}\n\n${marker}`;
  const title = clean(body.title, 180);
  return [
    "I'm working on a focused fix for this now.",
    title ? `Scope: ${title}` : `Issue: ${repo}#${issueNumber}`,
    "I'll keep it scoped, include relevant tests/proof, run Codex review, and only hand off when the PR is ready for maintainer look.",
    "",
    marker,
  ].join("\n");
}

async function ghJson(args, options = {}) {
  const result = await runCommand("gh", args, {
    allowFailure: true,
    input: options.input,
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${clean(result.stderr || result.stdout, 1200)}`);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `gh ${args.join(" ")} returned invalid JSON: ${error.message || String(error)}`,
    );
  }
}

async function gitcrawlDoctor() {
  const envDbPath = clean(process.env.OPENCLAW_GITCRAWL_DB_PATH, 1000);
  if (envDbPath) {
    return {
      db_path: envDbPath,
      runtime_db_health: { path: envDbPath },
      last_sync_at: process.env.OPENCLAW_GITCRAWL_LAST_SYNC_AT || null,
    };
  }
  if (gitcrawlDoctorCache && gitcrawlDoctorCache.expiresAt > Date.now()) {
    return gitcrawlDoctorCache.value;
  }
  const result = await runCommand("gitcrawl", ["doctor", "--json"], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`gitcrawl doctor failed: ${clean(result.stderr || result.stdout, 1000)}`);
  }
  try {
    const value = JSON.parse(result.stdout);
    gitcrawlDoctorCache = { value, expiresAt: Date.now() + 60_000 };
    return value;
  } catch (error) {
    throw new Error(`gitcrawl doctor returned invalid JSON: ${error.message || String(error)}`);
  }
}

function queryGitcrawlOpenPullRequests(database, repo, issueNumbers) {
  const clauses = [];
  const params = {};
  issueNumbers.forEach((number, index) => {
    params[`n${index}`] = `%${number}%`;
    clauses.push(`t.title LIKE $n${index}`);
    clauses.push(`t.body_excerpt LIKE $n${index}`);
  });
  const where = clauses.length ? `AND (${clauses.join(" OR ")})` : "";
  const statement = database.prepare(`
    SELECT
      t.number,
      t.title,
      t.html_url,
      t.author_login,
      t.is_draft,
      t.updated_at_gh,
      t.updated_at,
      t.body_excerpt
    FROM threads t
    JOIN repositories r ON r.id = t.repo_id
    WHERE r.full_name = $repo
      AND t.kind = 'pull_request'
      AND t.state = 'open'
      ${where}
    ORDER BY COALESCE(t.updated_at_gh, t.updated_at) DESC
    LIMIT 500
  `);
  return statement.all({ ...params, repo });
}

function gitcrawlPrIssueReferenceReason(repo, pull, issueNumber) {
  const number = String(issueNumber);
  const text = `${pull.title || ""}\n${pull.body_excerpt || ""}`;
  const repoPattern = escapeRegExp(repo);
  if (
    new RegExp(
      `\\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\\s+(?:${repoPattern})?#${number}\\b`,
      "i",
    ).test(text)
  ) {
    return `Gitcrawl PR text uses a closing reference to #${number}`;
  }
  if (new RegExp(`github\\.com/${repoPattern}/issues/${number}\\b`, "i").test(text)) {
    return `Gitcrawl PR text links the issue URL for #${number}`;
  }
  if (new RegExp(`(?:^|[^A-Za-z0-9_])#${number}\\b`, "i").test(text)) {
    return `Gitcrawl PR text mentions #${number}`;
  }
  return null;
}

const localSharedBlockedLabels = [
  "clawsweeper:no-new-fix-pr",
  "clawsweeper:linked-pr-open",
  "clawsweeper:needs-maintainer-review",
  "clawsweeper:needs-product-decision",
  "clawsweeper:needs-security-review",
  "clawsweeper:needs-info",
];

const localOpenClawQueueDefinitions = [
  localPriorityQueue("maintainer-p0", "P0", "Emergency queueable fixes"),
  localPriorityQueue("maintainer-p1", "P1", "High-priority queueable fixes"),
  localPriorityQueue("maintainer-p2", "P2", "Normal queueable fixes"),
  {
    id: "contributor-ready",
    audience: ["contributor", "trial_maintainer", "maintainer"],
    title: "Ready-to-queue fixes",
    priority: null,
    labels: ["clawsweeper:queueable-fix"],
    excludeLabels: localSharedBlockedLabels,
    sort: "created",
    order: "asc",
    why: "Issues ClawSweeper marked as suitable queued-fix candidates without linked fix PRs.",
  },
  {
    id: "contributor-clear-shape",
    audience: ["contributor", "trial_maintainer", "maintainer"],
    title: "Clear-shape fixes",
    priority: null,
    labels: ["clawsweeper:queueable-fix", "clawsweeper:fix-shape-clear"],
    excludeLabels: localSharedBlockedLabels,
    sort: "created",
    order: "asc",
    why: "Issues where ClawSweeper found a likely implementation path.",
  },
  {
    id: "contributor-source-repro",
    audience: ["contributor", "trial_maintainer", "maintainer"],
    title: "Ready fixes with source repro",
    priority: null,
    labels: ["clawsweeper:queueable-fix", "clawsweeper:source-repro"],
    excludeLabels: localSharedBlockedLabels,
    sort: "created",
    order: "asc",
    why: "Queueable fixes backed by source-level reproduction evidence.",
  },
];

function localPriorityQueue(id, priority, title) {
  return {
    id,
    audience: ["trial_maintainer", "maintainer"],
    title,
    priority,
    labels: [priority, "clawsweeper:queueable-fix"],
    excludeLabels: localSharedBlockedLabels,
    sort: "created",
    order: "asc",
    why: `${priority} issue triage, queueable, and without a linked fix PR.`,
  };
}

function localOpenClawQueuesForRole(roleMode) {
  return localOpenClawQueueDefinitions.filter((queue) => queue.audience.includes(roleMode));
}

function readGitcrawlQueue(database, repo, definition, now, minimumIssueAgeHours) {
  const rows = queryGitcrawlOpenIssues(database, repo, definition);
  const candidates = rows
    .map((row) => localOpenClawCandidateFromThread(row, definition.id, now, minimumIssueAgeHours))
    .filter((candidate) => localOpenClawCandidateMatchesQueue(candidate, definition))
    .sort((left, right) => localOpenClawCandidateSort(left, right, definition))
    .slice(0, 6);
  return {
    definition,
    query: localOpenClawIssueSearchQuery(repo, definition, now),
    totalCount: candidates.length,
    candidates,
    error: null,
    source: "gitcrawl",
  };
}

function queryGitcrawlOpenIssues(database, repo, definition) {
  const clauses = [];
  const params = {
    repo,
    createdAfter: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
  };
  for (const [index, label] of definition.labels.entries()) {
    params[`label${index}`] = `%${label}%`;
    clauses.push(`t.labels_json LIKE $label${index}`);
  }
  for (const [index, label] of definition.excludeLabels.entries()) {
    params[`exclude${index}`] = `%${label}%`;
    clauses.push(`t.labels_json NOT LIKE $exclude${index}`);
  }
  const statement = database.prepare(`
    SELECT
      t.number,
      t.title,
      t.html_url,
      t.author_login,
      t.labels_json,
      t.created_at_gh,
      t.updated_at_gh,
      t.updated_at
    FROM threads t
    JOIN repositories r ON r.id = t.repo_id
    WHERE r.full_name = $repo
      AND t.kind = 'issue'
      AND t.state = 'open'
      AND COALESCE(t.created_at_gh, t.updated_at) >= $createdAfter
      ${clauses.length ? `AND ${clauses.join("\n      AND ")}` : ""}
    ORDER BY COALESCE(t.created_at_gh, t.updated_at) ASC
    LIMIT 120
  `);
  return statement.all(params);
}

function localOpenClawCandidateFromThread(row, queueId, now, minimumIssueAgeHours) {
  const labels = labelsFromJson(row.labels_json);
  return {
    number: Number(row.number),
    title: clean(row.title, 240),
    url: clean(row.html_url, 1000) || `https://github.com/openclaw/openclaw/issues/${row.number}`,
    author: row.author_login || null,
    createdAt: row.created_at_gh || null,
    updatedAt: row.updated_at_gh || row.updated_at || null,
    labels,
    queueId,
    signals: localOpenClawIssueSignals(labels, row.created_at_gh, now, minimumIssueAgeHours),
    possiblePrCoverage: [],
    prCoverageUnknown: false,
    prCoverageWarning: null,
    source: "gitcrawl",
  };
}

function localOpenClawIssueSignals(labels, createdAt, now, minimumIssueAgeHours) {
  const has = (label) => labels.some((item) => item.toLowerCase() === label.toLowerCase());
  const ageMs = createdAt ? now - Date.parse(createdAt) : NaN;
  const ageGate = !Number.isFinite(ageMs)
    ? "unknown"
    : ageMs < minimumIssueAgeHours * 3_600_000
      ? "too-new"
      : ageMs > 30 * 24 * 3_600_000
        ? "too-old"
        : "eligible";
  const linkedPr = has("clawsweeper:linked-pr-open");
  const noNewFixPr = has("clawsweeper:no-new-fix-pr");
  const blockers = localSharedBlockedLabels.filter(has);
  const queueable = has("clawsweeper:queueable-fix");
  const clawsweeperPass = labels.some((label) => label.toLowerCase().startsWith("clawsweeper:"));
  return {
    clawsweeperPass,
    queueable,
    linkedPr,
    noNewFixPr,
    sourceRepro: has("clawsweeper:source-repro"),
    currentMainRepro: has("clawsweeper:current-main-repro"),
    fixShapeClear: has("clawsweeper:fix-shape-clear"),
    needsLiveValidation:
      has("clawsweeper:needs-live-repro") || has("clawsweeper:needs-live-validation"),
    blockers,
    ageGate,
    readyForPickup:
      clawsweeperPass && queueable && !linkedPr && !noNewFixPr && ageGate === "eligible",
  };
}

function localOpenClawCandidateMatchesQueue(candidate, definition) {
  const lowerLabels = new Set(candidate.labels.map((label) => label.toLowerCase()));
  const has = (label) => lowerLabels.has(label.toLowerCase());
  return (
    definition.labels.every(has) &&
    !definition.excludeLabels.some(has) &&
    candidate.signals.ageGate !== "too-old" &&
    !candidate.signals.linkedPr &&
    !candidate.signals.noNewFixPr
  );
}

function localOpenClawCandidateSort(left, right, definition) {
  const leftTime = Date.parse(definition.sort === "updated" ? left.updatedAt : left.createdAt) || 0;
  const rightTime =
    Date.parse(definition.sort === "updated" ? right.updatedAt : right.createdAt) || 0;
  return definition.order === "desc" ? rightTime - leftTime : leftTime - rightTime;
}

function localOpenClawIssueSearchQuery(repo, definition, now) {
  const parts = [
    `repo:${repo}`,
    "is:issue",
    "is:open",
    "-linked:pr",
    `created:>=${new Date(now - 30 * 24 * 3_600_000).toISOString().slice(0, 10)}`,
    ...definition.labels.map((label) => `label:"${label}"`),
    ...definition.excludeLabels.map((label) => `-label:"${label}"`),
  ];
  return parts.join(" ");
}

function readGitcrawlAuthoredPullRequests(database, repo, login) {
  const statement = database.prepare(`
    SELECT
      t.id,
      t.number,
      t.title,
      t.html_url,
      t.author_login,
      t.labels_json,
      t.is_draft,
      t.updated_at_gh,
      t.updated_at,
      d.head_ref,
      d.head_sha
    FROM threads t
    JOIN repositories r ON r.id = t.repo_id
    LEFT JOIN pull_request_details d ON d.thread_id = t.id
    WHERE r.full_name = $repo
      AND t.kind = 'pull_request'
      AND t.state = 'open'
      AND lower(t.author_login) = $login
    ORDER BY COALESCE(t.updated_at_gh, t.updated_at) DESC
    LIMIT 20
  `);
  return statement.all({ repo, login }).map((row) => {
    const labels = labelsFromJson(row.labels_json);
    return {
      number: Number(row.number),
      title: clean(row.title, 240),
      url: clean(row.html_url, 1000) || `https://github.com/${repo}/pull/${row.number}`,
      author: row.author_login || null,
      labels,
      branch: row.head_ref || null,
      headSha: row.head_sha || null,
      draft: Boolean(row.is_draft),
      updatedAt: row.updated_at_gh || row.updated_at || null,
      signals: localOpenClawPrSignals(labels),
      checks: localGitcrawlCheckSummary(database, row.id, localOpenClawPrSignals(labels)),
      source: "gitcrawl",
    };
  });
}

function localGitcrawlCheckSummary(database, threadId, signals) {
  const rows = database
    .prepare(
      `
      SELECT name, status, conclusion, started_at, completed_at, fetched_at
      FROM pull_request_checks
      WHERE thread_id = $threadId
      ORDER BY COALESCE(completed_at, started_at, fetched_at) DESC
    `,
    )
    .all({ threadId });
  if (!rows.length) {
    return {
      state: "unknown",
      total: 0,
      failing: [],
      pending: [],
      timedOut: [],
      mantis: signals.mantisRequested ? "requested" : null,
    };
  }
  const latestByName = new Map();
  for (const row of rows) {
    const name = clean(row.name, 160) || "check";
    if (!latestByName.has(name)) latestByName.set(name, row);
  }
  const latest = [...latestByName.values()];
  const failing = [];
  const pending = [];
  const timedOut = [];
  for (const row of latest) {
    const name = clean(row.name, 160) || "check";
    const status = String(row.status || "").toLowerCase();
    const conclusion = String(row.conclusion || "").toLowerCase();
    if (status !== "completed") {
      pending.push(name);
      continue;
    }
    if (["timed_out", "startup_failure"].includes(conclusion)) timedOut.push(name);
    if (
      ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(
        conclusion,
      )
    ) {
      failing.push(name);
    }
  }
  const mantisCheck = latest.find((row) => /mantis/i.test(String(row.name || "")));
  return {
    state: failing.length ? "failing" : pending.length ? "pending" : "green",
    total: latest.length,
    failing,
    pending,
    timedOut,
    mantis: mantisCheck
      ? String(mantisCheck.conclusion || mantisCheck.status || "seen").toLowerCase()
      : signals.mantisRequested
        ? "requested"
        : null,
  };
}

function localOpenClawPrSignals(labels) {
  const lower = labels.map((label) => label.toLowerCase());
  const has = (label) => lower.some((item) => item === label.toLowerCase());
  const includes = (needle) => lower.some((label) => label.includes(needle));
  const statusLabel =
    labels.find((label) => label.toLowerCase().startsWith("status:")) ||
    labels.find((label) => label.toLowerCase().startsWith("clawsweeper:")) ||
    null;
  const needsProof = includes("needs proof") || includes("proof: needed");
  const waitingOnAuthor = includes("waiting on author") || includes("actively grinding");
  return {
    readyForMaintainer:
      (includes("ready for maintainer look") || has("clawsweeper:ready-for-maintainer-look")) &&
      !needsProof &&
      !waitingOnAuthor,
    needsProof,
    waitingOnAuthor,
    reReviewLoop: includes("re-review") || has("clawsweeper:re-review"),
    proofSufficient: includes("proof: sufficient"),
    mergeReady: includes("merge-ready"),
    mantisRequested: lower.some((label) => label.startsWith("mantis:")),
    clawsweeperHumanReview: has("clawsweeper:needs-maintainer-review"),
    statusLabel,
  };
}

function labelsFromJson(value) {
  try {
    const labels = JSON.parse(String(value || "[]"));
    return Array.isArray(labels)
      ? labels
          .map((label) => (typeof label === "string" ? label : label?.name))
          .filter(Boolean)
          .map(String)
      : [];
  } catch {
    return [];
  }
}

function normalizeRepo(value) {
  const repo = clean(value, 160).toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) ? repo : "";
}

function oneOf(value, values, fallback) {
  const text = String(value || "");
  return values.includes(text) ? text : fallback;
}

function uniqueIssueNumbers(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((item) => integer(item, null)).filter((item) => item && item > 0))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createManualTrackedRun(body, issueNumber, issueUrl) {
  const id = `oc-track-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  const prompt = clean(body.prompt, 100_000);
  const logPath = path.join(logDir, `${id}.jsonl`);
  const status = runStatus(body.status, "tracked");
  const codexReasoningEffort = reasoningEffort(
    body.codexReasoningEffort || body.reasoningEffort,
    defaultReasoningEffort,
  );
  const proofModeValue = proofMode(body.proofMode || body.openClawProofMode, "auto");
  const run = {
    id,
    status: status === "starting" || status === "running" ? "tracked" : status,
    pid: null,
    issueNumber,
    issueUrl,
    title: clean(body.title, 300),
    queueId: clean(body.queueId, 80),
    codexReasoningEffort,
    proofMode: proofModeValue,
    claimCommentUrl: clean(body.claimCommentUrl, 500) || null,
    claimCommentStatus: clean(body.claimCommentStatus, 80) || null,
    workspace,
    baseWorkspace: workspace,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBase: null,
    logPath,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    note: clean(body.note, 500) || "Manual track entry for copy/paste or external Codex work.",
    lastActivityLines: [],
    source: clean(body.source, 80) || "manual",
    updatedAt: now,
  };
  appendRunActivity(run, "Tracked external/manual Codex work.");
  await writeRunLog(run, {
    type: "track",
    at: now,
    prompt,
    codexReasoningEffort,
    proofMode: proofModeValue,
  });
  runs.set(id, run);
  persistRunsSoon();
  return run;
}

async function createRunWorktree(run, log) {
  await ensureGitWorkspace();
  await fsp.mkdir(worktreeDir, { recursive: true });
  const worktreeName = runWorktreeName(run);
  const target = path.join(worktreeDir, worktreeName);
  const branch = runWorktreeBranch(run);
  await git(["-C", workspace, "worktree", "add", "-b", branch, target, worktreeBase]);
  run.workspace = target;
  run.worktreePath = target;
  run.worktreeBranch = branch;
  run.updatedAt = new Date().toISOString();
  appendRunActivity(run, `Worktree ready: ${branch}`);
  log.write(
    `${JSON.stringify({
      type: "worktree",
      at: run.updatedAt,
      path: target,
      branch,
      baseWorkspace: workspace,
      baseRef: worktreeBase,
    })}\n`,
  );
  persistRunsSoon();
  return target;
}

async function cleanupRunWorktree(run, log) {
  if (!run.worktreePath && !run.worktreeBranch) return;
  const at = new Date().toISOString();
  const worktreePath = run.worktreePath;
  const branch = run.worktreeBranch;
  const removedWorktree = worktreePath
    ? await git(["-C", workspace, "worktree", "remove", "--force", worktreePath], {
        allowFailure: true,
      })
    : null;
  const removedBranch = branch
    ? await git(["-C", workspace, "branch", "-D", branch], { allowFailure: true })
    : null;
  if (removedWorktree && removedWorktree.status !== 0) {
    throw new Error(`worktree cleanup failed: ${clean(removedWorktree.stderr, 500)}`);
  }
  if (removedBranch && removedBranch.status !== 0) {
    throw new Error(`branch cleanup failed: ${clean(removedBranch.stderr, 500)}`);
  }
  run.workspace = null;
  run.worktreePath = null;
  run.worktreeBranch = null;
  run.updatedAt = at;
  log.write(
    `${JSON.stringify({
      type: "cleanup",
      at,
      worktreePath,
      branch,
    })}\n`,
  );
  persistRunsSoon();
}

async function prepareCodexRunEnvironment(runWorkspace, log) {
  const tempRoot = path.join(runWorkspace, ".tmp", "claw-queue");
  const tempDir = path.join(tempRoot, "tmp");
  const corepackHome = path.join(tempRoot, "corepack");
  const npmCache = path.join(tempRoot, "npm-cache");
  await ensureWorktreeGitExclude(runWorkspace, ".tmp/claw-queue/");
  await Promise.all([
    fsp.mkdir(tempDir, { recursive: true }),
    fsp.mkdir(corepackHome, { recursive: true }),
    fsp.mkdir(npmCache, { recursive: true }),
  ]);
  const env = {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT || "0",
    COREPACK_HOME: process.env.COREPACK_HOME || corepackHome,
    OPENCLAW_HEAVY_CHECK_LOCK_SCOPE: process.env.OPENCLAW_HEAVY_CHECK_LOCK_SCOPE || "worktree",
    npm_config_cache: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || npmCache,
    TEMP: tempDir,
    TMP: tempDir,
  };
  log.write(
    `${JSON.stringify({
      type: "environment",
      at: new Date().toISOString(),
      tempDir,
      corepackHome: env.COREPACK_HOME,
      npmCache: env.npm_config_cache,
      heavyCheckLockScope: env.OPENCLAW_HEAVY_CHECK_LOCK_SCOPE,
    })}\n`,
  );
  return env;
}

async function ensureWorktreeGitExclude(runWorkspace, pattern) {
  const result = await git(["-C", runWorkspace, "rev-parse", "--git-path", "info/exclude"]);
  const excludePath = path.resolve(runWorkspace, result.stdout.trim());
  const existing = await fsp.readFile(excludePath, "utf8").catch(() => "");
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(pattern)) return;
  await fsp.mkdir(path.dirname(excludePath), { recursive: true });
  await fsp.appendFile(
    excludePath,
    `${existing.endsWith("\n") || !existing ? "" : "\n"}${pattern}\n`,
  );
}

function openClawRunnerPrompt(prompt, run) {
  const lines = [
    "Claw Queue runner context:",
    "- You are running in a bridge-created git worktree. Do not run `git pull` inside this worktree; the bridge chose the base ref and branch.",
    "- Re-check live GitHub state, but if local `gh` or `gitcrawl` cannot read config from outside the worktree sandbox, use the available GitHub connector instead of spending time repairing local CLI config.",
    "- The bridge sets worktree-local TEMP/TMP/Corepack/npm cache paths and `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree`; prefer commands that respect those defaults.",
    `- Tokenjuice output compaction is expected for noisy terminal output. CLI command: ${tokenjuiceLaunch.display}. Use \`tokenjuice doctor hooks\` to verify Codex hook wiring, \`tokenjuice stats --timezone utc\` for compaction stats, and \`tokenjuice wrap --raw -- <command>\` when exact raw output is required.`,
    "- Check required proof tooling early. If Crabbox, Blacksmith Testbox, Mantis, live credentials, or Codex review are unavailable, park with a concise blocker instead of opening an under-proved PR.",
    "- Apply the OpenClaw maintainer handbook gates: release-sensitive fixes need release-branch awareness, plugin install/update/SDK/package changes need maintainer-channel discussion, and security-adjacent work must avoid public vulnerability metadata or trial-maintainer direct-to-main assumptions.",
    ...localSkillContextLines(),
    run.claimCommentStatus
      ? `- Claim comment status from Claw Queue: ${run.claimCommentStatus}${run.claimCommentUrl ? ` (${run.claimCommentUrl})` : ""}. Do not post a duplicate claim.`
      : "",
  ].filter(Boolean);
  return `${lines.join("\n")}\n\n${prompt}`;
}

function localSkillContextLines() {
  if (!includeSkillContext) return [];
  const skills = discoverRelevantSkills(skillRoots);
  if (!skills.length) {
    return [
      `- Local Codex skill directories checked: ${skillRoots.join(", ")}. No relevant SKILL.md files were found, so continue with repo guidance and available tools.`,
    ];
  }
  return [
    `- Local Codex skill directories checked: ${skillRoots.join(", ")}`,
    "- Use relevant local skills before acting when they match the work. High-signal skills found:",
    ...skills.map((skill) => `  - ${skill.name}: ${skill.path}`),
  ];
}

function relevantSkillRoots(primaryRoot) {
  const roots = [
    primaryRoot,
    args["maintainer-skills-dir"],
    process.env.OPENCLAW_MAINTAINER_SKILLS_DIR,
    process.env.OPENCLAW_MAINTAINERS_DIR
      ? path.join(process.env.OPENCLAW_MAINTAINERS_DIR, ".agents", "skills")
      : "",
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "OpenClawMaintainer",
      "repos",
      "maintainers",
      ".agents",
      "skills",
    ),
  ].filter(Boolean);
  const seen = new Set();
  return roots
    .map((root) => path.resolve(String(root)))
    .filter((root) => {
      const key = root.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function discoverRelevantSkills(roots) {
  const wanted = [
    "openclaw-pre-pr-check",
    "openclaw-pr-maintainer",
    "openclaw-testing",
    "openclaw-debugging",
    "openclaw-qa-testing",
    "openclaw-docker-e2e-authoring",
    "openclaw-small-bugfix-sweep",
    "clawsweeper",
    "clawdtributor",
    "crabbox",
    "gitcrawl",
    "tokenjuice",
    "pr-cluster",
    "review-pr",
    "tag-duplicate-prs-issues",
    "gh-fix-ci",
    "gh-address-comments",
    "ghsa-opengrep-detector",
    "opengrep-rule-review",
    "openclaw-opengrep-remediation",
    "crabpot-perf-metrics",
    "codex-review",
    "agent-transcript",
    "tmux-lane-orchestrator",
    "technical-documentation",
  ];
  const results = [];
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const name of wanted) {
      const skillPath = path.join(root, name, "SKILL.md");
      const key = name.toLowerCase();
      if (!seen.has(key) && fs.existsSync(skillPath)) {
        seen.add(key);
        results.push({ name, path: skillPath });
      }
    }
  }
  return results;
}

function createRunOutputObserver() {
  let buffer = "";
  let outcome = null;
  return {
    push(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const inferred = inferRunOutcomeFromLogLine(line);
        if (inferred) outcome = inferred;
      }
    },
    outcome() {
      if (!outcome && buffer.trim()) outcome = inferRunOutcomeFromLogLine(buffer);
      return outcome;
    },
  };
}

function inferRunOutcomeFromLogLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return inferRunOutcomeFromText(line);
  }
  const text =
    parsed?.item?.type === "agent_message"
      ? parsed.item.text
      : parsed?.type === "agent_message"
        ? parsed.text || parsed.message
        : parsed?.message || parsed?.text || "";
  return inferRunOutcomeFromText(text);
}

function inferRunOutcomeFromText(value) {
  const text = clean(value, 12_000);
  if (!text) return null;
  const lower = text.toLowerCase();
  const parked =
    /\bparked before pr\b/.test(lower) ||
    /\bpr:\s*not opened\b/.test(lower) ||
    /\bno pr opened\b/.test(lower) ||
    /\bdid not open a pr\b/.test(lower) ||
    /\bblocked proof\b/.test(lower) ||
    /\bcannot honestly be marked\b/.test(lower);
  if (!parked) return null;
  return {
    status: "parked",
    note: summarizeRunOutcomeNote(text),
  };
}

function summarizeRunOutcomeNote(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) =>
    /parked before pr|did not open a pr|blocked proof|codex review:|ci\/clawsweeper:|crabbox|mantis|live proof/i.test(
      line,
    ),
  );
  return clean((important.length ? important : lines).slice(0, 4).join(" "), 500);
}

async function ensureGitWorkspace() {
  const result = await git(["-C", workspace, "rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
  });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error(`Workspace is not a git work tree: ${workspace}`);
  }
}

function runWorktreeName(run) {
  const issuePart = run.issueNumber ? `issue-${run.issueNumber}` : "issue";
  return safePathSegment(`${issuePart}-${run.id}`);
}

function runWorktreeBranch(run) {
  const issuePart = run.issueNumber ? `issue-${run.issueNumber}` : "issue";
  return `claw-queue/${safeBranchSegment(issuePart)}-${safeBranchSegment(run.id)}`;
}

function safePathSegment(value) {
  return (
    String(value || "run")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "run"
  );
}

function safeBranchSegment(value) {
  return (
    String(value || "run")
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/\/+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/\.+$/g, "")
      .slice(0, 120) || "run"
  );
}

async function git(args, options = {}) {
  return runCommand("git", args, options);
}

async function runCommand(command, commandArgs, options = {}) {
  const launch = resolveCommandLaunch(command);
  const child = spawn(launch.command, commandLaunchArgs(launch, commandArgs), {
    cwd: workspace,
    env: process.env,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(launch.cmdTarget),
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  const result = { status, stdout, stderr };
  if (status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with ${status}: ${clean(stderr || stdout, 1000)}`,
    );
  }
  return result;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  if (!child.killed) child.kill();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

async function writeRunLog(run, event) {
  appendRunActivity(run, event);
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.appendFile(run.logPath, `${JSON.stringify(event)}\n`, "utf8");
}

function appendRunActivity(run, value) {
  if (!run) return;
  const lines = runActivityLines(value);
  if (!lines.length) return;
  const current = Array.isArray(run.lastActivityLines) ? run.lastActivityLines : [];
  run.lastActivityLines = [...current, ...lines].slice(-4);
}

function runActivityLines(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "object" && !Buffer.isBuffer(value)) {
    const type = clean(value.type, 40);
    const text = clean(value.text || value.error || value.label || value.status || value.path, 220);
    if (type === "prompt") return [];
    return [clean([type, text].filter(Boolean).join(": "), 240)].filter(Boolean);
  }
  const text = String(value || "")
    .split(/\r?\n/)
    .map((line) => clean(runActivityLineText(line), 240))
    .filter(Boolean)
    .filter((line) => !/"type":"prompt"/.test(line))
    .slice(-4);
  return text;
}

function runActivityLineText(line) {
  const text = String(line || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed?.type === "prompt") return "";
    const type = clean(parsed?.type, 40);
    const body = clean(
      parsed?.message ||
        parsed?.text ||
        parsed?.error ||
        parsed?.label ||
        parsed?.status ||
        parsed?.event ||
        "",
      220,
    );
    return [type, body].filter(Boolean).join(": ");
  } catch {
    return text;
  }
}

function openLogStream(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  return new Promise((resolve, reject) => {
    function cleanup() {
      stream.off("open", onOpen);
      stream.off("error", onError);
    }
    function onOpen() {
      cleanup();
      resolve(stream);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

function markRunFailed(run, error) {
  run.status = "failed";
  run.error = error.message || String(error);
  run.finishedAt = new Date().toISOString();
  run.updatedAt = run.finishedAt;
  persistRunsSoon();
}

function activeRuns() {
  return [...runs.values()].filter((run) => runIsLive(run));
}

function runIsLive(run) {
  return !run?.finishedAt && (run?.status === "starting" || run?.status === "running");
}

function visibleRuns() {
  return unarchivedRuns().slice(0, 50);
}

function unarchivedRuns() {
  return [...runs.values()]
    .filter((run) => !run.archivedAt)
    .sort((left, right) => runSortTime(right) - runSortTime(left));
}

function visibleRunForIssue(issueNumber, issueUrl) {
  const key = issueKey(issueNumber, issueUrl);
  if (!key) return null;
  return (
    unarchivedRuns().find(
      (run) => runBlocksDuplicateWork(run) && issueKey(run.issueNumber, run.issueUrl) === key,
    ) || null
  );
}

function runBlocksDuplicateWork(run) {
  return ["starting", "running", "tracked", "ready", "parked", "handoff-sent"].includes(
    run?.status,
  );
}

async function readRunLog(run, url) {
  const bytesParam = url.searchParams.get("bytes") ?? undefined;
  const entriesParam = url.searchParams.get("entries") ?? undefined;
  const maxBytes = Math.max(4096, Math.min(1_000_000, integer(bytesParam, 200_000)));
  const maxEntries = Math.max(20, Math.min(500, integer(entriesParam, 160)));
  const logPath = safeRunLogPath(run);
  let stat;
  try {
    stat = await fsp.stat(logPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: logPath,
        exists: false,
        size: 0,
        truncated: false,
        entries: [],
        text: "",
      };
    }
    throw error;
  }

  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const handle = await fsp.open(logPath, "r");
  let text = "";
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    text = buffer.toString("utf8");
  } finally {
    await handle.close();
  }

  let truncated = start > 0;
  if (truncated) {
    const newline = text.indexOf("\n");
    if (newline !== -1) text = text.slice(newline + 1);
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const selected = lines.slice(-maxEntries);
  return {
    path: logPath,
    exists: true,
    size: stat.size,
    truncated: truncated || lines.length > selected.length,
    entries: selected.map((line, index) =>
      normalizeRunLogLine(line, lines.length - selected.length + index),
    ),
    text: selected.join("\n"),
    updatedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

function safeRunLogPath(run) {
  const fallback = path.join(logDir, `${run.id}.jsonl`);
  const resolved = path.resolve(String(run.logPath || fallback));
  const root = path.resolve(logDir);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("run log path is outside the bridge log directory");
  }
  return resolved;
}

function normalizeRunLogLine(line, index) {
  try {
    const parsed = JSON.parse(line);
    return normalizeRunLogEvent(parsed, index, line);
  } catch {
    return {
      index,
      type: "output",
      label: "Output",
      text: clean(line, 8000),
    };
  }
}

function normalizeRunLogEvent(event, index, line) {
  const type = clean(event?.type, 80) || "event";
  const at = clean(event?.at, 80) || null;
  const base = { index, type, at };
  if (type === "request") {
    return {
      ...base,
      label: "Start request",
      text: [
        event.issueNumber ? `Issue #${event.issueNumber}` : "",
        clean(event.title, 220),
        event.queueId ? `Queue ${clean(event.queueId, 80)}` : "",
        event.codexReasoningEffort ? `thinking ${clean(event.codexReasoningEffort, 20)}` : "",
        event.proofMode ? `proof ${clean(event.proofMode, 20)}` : "",
        event.dryRun ? "dry-run" : "",
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }
  if (type === "prompt") {
    return {
      ...base,
      label: "Prompt",
      text: summarizePrompt(event.text),
    };
  }
  if (type === "worktree") {
    return {
      ...base,
      label: "Worktree",
      text: [
        event.path ? `path ${clean(event.path, 500)}` : "",
        event.branch ? `branch ${clean(event.branch, 220)}` : "",
        event.baseRef ? `base ${clean(event.baseRef, 120)}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }
  if (type === "environment") {
    return {
      ...base,
      label: "Runner environment",
      text: [
        event.tempDir ? `temp ${clean(event.tempDir, 500)}` : "",
        event.corepackHome ? `corepack ${clean(event.corepackHome, 500)}` : "",
        event.heavyCheckLockScope ? `lock ${clean(event.heavyCheckLockScope, 80)}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }
  if (type === "stderr") {
    return {
      ...base,
      label: "stderr",
      text: clean(event.text, 8000),
    };
  }
  if (type === "stdin-error" || type === "error") {
    return {
      ...base,
      label: "Error",
      text: clean(event.error || event.text || line, 8000),
    };
  }
  if (type === "exit") {
    return {
      ...base,
      label: "Exit",
      text: `code=${event.code ?? "null"}${event.signal ? ` signal=${event.signal}` : ""}`,
    };
  }
  return {
    ...base,
    label: eventLabel(type),
    text: runLogEventText(event, line),
  };
}

function summarizePrompt(value) {
  const text = clean(value, 12_000);
  const firstLines = text.split(/\r?\n/).slice(0, 28).join("\n");
  return text.length > firstLines.length ? `${firstLines}\n...` : firstLines;
}

function runLogEventText(event, fallback) {
  const candidates = [
    event?.message,
    event?.text,
    event?.summary,
    event?.content,
    event?.prompt,
    event?.error,
    event?.delta,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return clean(candidate, 8000);
  }
  return clean(JSON.stringify(event), 8000) || clean(fallback, 8000);
}

function eventLabel(type) {
  return type.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function issueKey(issueNumber, issueUrl) {
  const normalized = integer(issueNumber, null);
  let parsedIssueNumber = normalized;
  try {
    const url = new URL(String(issueUrl || ""));
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[2] === "issues") {
      const urlIssueNumber = integer(parts[3], null);
      parsedIssueNumber = urlIssueNumber || parsedIssueNumber;
      if (parsedIssueNumber) {
        return `${url.hostname.toLowerCase()}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}#${parsedIssueNumber}`;
      }
    }
  } catch {}
  return parsedIssueNumber ? `#${parsedIssueNumber}` : "";
}

function runSortTime(run) {
  const parsed = Date.parse(run?.updatedAt || run?.startedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function updateRunFromBody(run, body) {
  const status = body.status === "archive" ? "archived" : runStatus(body.status, run.status);
  if ((status === "starting" || status === "running") && status !== run.status) {
    return {
      error: "cannot set live status with PATCH",
      status: 409,
    };
  }
  if (runIsLive(run) && status !== run.status) {
    return {
      error: "cannot change status while Codex process is active",
      status: 409,
    };
  }
  const now = new Date().toISOString();
  run.status = status;
  run.updatedAt = now;
  if (body.note !== undefined) run.note = clean(body.note, 500);
  if (body.prUrl !== undefined) run.prUrl = clean(body.prUrl, 500);
  if (status === "archived") run.archivedAt = now;
  if (
    (status === "ready" ||
      status === "handoff-sent" ||
      status === "parked" ||
      status === "completed") &&
    !run.finishedAt
  ) {
    run.finishedAt = now;
  }
  return null;
}

function updateRunClaimFromBody(run, body) {
  const claimCommentUrl = clean(body.claimCommentUrl, 500);
  const claimCommentStatus = clean(body.claimCommentStatus, 80);
  let changed = false;
  if (claimCommentUrl && !run.claimCommentUrl) {
    run.claimCommentUrl = claimCommentUrl;
    changed = true;
  }
  if (claimCommentStatus && !run.claimCommentStatus) {
    run.claimCommentStatus = claimCommentStatus;
    changed = true;
  }
  if (changed) {
    run.updatedAt = new Date().toISOString();
    persistRunsSoon();
  }
}

function runStatus(value, fallback) {
  const status = clean(value, 40);
  return [
    "tracked",
    "starting",
    "running",
    "completed",
    "failed",
    "dry-run",
    "parked",
    "ready",
    "handoff-sent",
    "stale",
    "archived",
  ].includes(status)
    ? status
    : fallback;
}

function reasoningEffort(value, fallback) {
  const effort = clean(value, 20).toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(effort) ? effort : fallback;
}

function proofMode(value, fallback) {
  const mode = clean(value, 20).toLowerCase();
  return ["auto", "local", "crabbox", "testbox", "mantis"].includes(mode) ? mode : fallback;
}

async function loadPersistedRuns() {
  let changed = false;
  try {
    const text = await fsp.readFile(statePath, "utf8");
    const parsed = JSON.parse(text);
    const now = new Date().toISOString();
    for (const run of Array.isArray(parsed?.runs) ? parsed.runs : []) {
      if (!run?.id) continue;
      const restored = { ...run };
      if (restored.status === "starting" || restored.status === "running") {
        restored.status = "stale";
        restored.error = restored.error || "Runner restarted before this Codex process finished.";
        restored.finishedAt = restored.finishedAt || now;
        restored.updatedAt = now;
        changed = true;
      }
      runs.set(String(restored.id), restored);
    }
    if (changed) persistRunsSoon();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not load run state: ${error.message || String(error)}`);
    }
  }
}

function persistRunsSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistRuns().catch((error) => {
      console.warn(`Could not persist run state: ${error.message || String(error)}`);
    });
  }, 25);
}

async function persistRuns() {
  await fsp.mkdir(logDir, { recursive: true });
  const persistedRuns = [...runs.values()]
    .sort((left, right) => {
      if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) {
        return left.archivedAt ? 1 : -1;
      }
      return runSortTime(right) - runSortTime(left);
    })
    .slice(0, 200);
  const payload = JSON.stringify({ version: 1, runs: persistedRuns }, null, 2);
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, payload, "utf8");
  await fsp.rename(tempPath, statePath);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function authorized(request) {
  return timingSafeEqualText(header(request, "authorization"), `Bearer ${token}`);
}

function unauthorized(request, response) {
  sendJson(request, response, { ok: false, error: "missing or invalid runner token" }, 401);
}

function sendJson(request, response, body, status = 200) {
  response.writeHead(status, {
    ...corsHeaders(request),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function corsHeaders(request) {
  const origin = header(request, "origin");
  const headers = {
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-max-age": "600",
  };
  if (!origin || allowedOrigin(origin)) {
    headers["access-control-allow-origin"] = origin || "http://127.0.0.1";
    if (header(request, "access-control-request-private-network") === "true") {
      headers["access-control-allow-private-network"] = "true";
    }
  }
  return headers;
}

function allowedOrigin(origin) {
  try {
    const url = new URL(origin);
    return (
      isLoopbackHost(url.hostname) ||
      url.hostname === "clawfleet.openclaw.ai" ||
      url.hostname === "crabfleet.openclaw.ai" ||
      url.hostname === "crabyard.openclaw.ai"
    );
  } catch {
    return false;
  }
}

function isLoopbackHost(value) {
  const host = String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function header(request, name) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const equal = item.indexOf("=");
    if (equal !== -1) {
      result[item.slice(2, equal)] = item.slice(equal + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function resolveCodexLaunch(value) {
  if (process.platform !== "win32") return { command: value, args: [], display: value };
  const commandPath = resolveWindowsCommand(value);
  if (!commandPath) return { command: value, args: [], display: value };
  const lower = commandPath.toLowerCase();
  if (lower.endsWith(".exe")) return { command: commandPath, args: [], display: commandPath };
  if (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".ps1")) {
    const npmJs = path.join(
      path.dirname(commandPath),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (fs.existsSync(npmJs)) return { command: "node.exe", args: [npmJs], display: commandPath };
    if (lower.endsWith(".ps1")) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", commandPath],
        display: commandPath,
      };
    }
    return {
      command: process.env.ComSpec || "cmd.exe",
      cmdTarget: commandPath,
      args: [],
      display: commandPath,
    };
  }
  const siblingExe = `${commandPath}.exe`;
  if (fs.existsSync(siblingExe)) return { command: siblingExe, args: [], display: siblingExe };
  const siblingCmd = `${commandPath}.cmd`;
  if (fs.existsSync(siblingCmd)) {
    const npmJs = path.join(
      path.dirname(siblingCmd),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (fs.existsSync(npmJs)) return { command: "node.exe", args: [npmJs], display: siblingCmd };
    return {
      command: process.env.ComSpec || "cmd.exe",
      cmdTarget: siblingCmd,
      args: [],
      display: siblingCmd,
    };
  }
  return { command: commandPath, args: [], display: commandPath };
}

function resolveCommandLaunch(value) {
  if (process.platform !== "win32") return { command: value, args: [], display: value };
  const commandPath = resolveWindowsCommand(value);
  if (!commandPath) return { command: value, args: [], display: value };
  const lower = commandPath.toLowerCase();
  if (lower.endsWith(".exe")) return { command: commandPath, args: [], display: commandPath };
  if (lower.endsWith(".ps1")) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", commandPath],
      display: commandPath,
    };
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      cmdTarget: commandPath,
      args: [],
      display: commandPath,
    };
  }
  const siblingExe = `${commandPath}.exe`;
  if (fs.existsSync(siblingExe)) return { command: siblingExe, args: [], display: siblingExe };
  const siblingCmd = `${commandPath}.cmd`;
  if (fs.existsSync(siblingCmd)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      cmdTarget: siblingCmd,
      args: [],
      display: siblingCmd,
    };
  }
  return { command: commandPath, args: [], display: commandPath };
}

function codexLaunchArgs(launch, args) {
  return commandLaunchArgs(launch, args);
}

function commandLaunchArgs(launch, args) {
  if (launch.cmdTarget) {
    return ["/d", "/c", ["call", cmdQuote(launch.cmdTarget), ...args.map(cmdQuote)].join(" ")];
  }
  return [...launch.args, ...args];
}

function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function resolveWindowsCommand(value) {
  if (/[\\/]/.test(value)) return path.resolve(value);
  const hasExtension = Boolean(path.extname(value));
  const names = hasExtension
    ? [value]
    : [`${value}.exe`, `${value}.cmd`, `${value}.bat`, `${value}.ps1`, value];
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function clean(value, max) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function flag(value) {
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
