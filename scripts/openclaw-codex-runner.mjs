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
const providedToken = String(args.token || process.env.OPENCLAW_CODEX_RUNNER_TOKEN || "");
const token = providedToken || crypto.randomBytes(24).toString("base64url");
const dryRun = Boolean(args["dry-run"]);
const defaultLogDir = path.join(
  os.tmpdir(),
  "crabfleet-openclaw-codex-runs",
  sha256(workspace).slice(0, 16),
);
const logDir = path.resolve(String(args["log-dir"] || defaultLogDir));
const runs = new Map();

if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  console.error(`Workspace does not exist or is not a directory: ${workspace}`);
  process.exit(1);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(request, response, { ok: false, error: error.message || String(error) }, 500);
  });
});

server.listen(port, host, () => {
  console.log(`Claw Queue Codex bridge listening on http://${host}:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Logs: ${logDir}`);
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
      dryRun,
      active: [...runs.values()].filter((run) => run.status === "running").length,
      logDir,
    });
    return;
  }

  if (url.pathname === "/runs" && request.method === "GET") {
    if (!authorized(request)) return unauthorized(request, response);
    sendJson(request, response, { ok: true, runs: [...runs.values()].slice(-50).reverse() });
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

  if (url.pathname === "/start" && request.method === "POST") {
    if (!authorized(request)) return unauthorized(request, response);
    const body = await readJson(request);
    const prompt = clean(body.prompt, 100_000);
    if (!prompt) {
      sendJson(request, response, { ok: false, error: "prompt is required" }, 400);
      return;
    }
    const active = activeRun();
    if (active) {
      sendJson(
        request,
        response,
        {
          ok: false,
          error: "runner already has an active Codex run in this workspace",
          run: active,
        },
        409,
      );
      return;
    }
    const run = await startCodexRun(body, prompt);
    sendJson(request, response, { ok: true, run }, 202);
    return;
  }

  sendJson(request, response, { ok: false, error: "not found" }, 404);
}

async function startCodexRun(body, prompt) {
  const id = `oc-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const logPath = path.join(logDir, `${id}.jsonl`);
  const run = {
    id,
    status: dryRun ? "dry-run" : "starting",
    pid: null,
    issueNumber: integer(body.issueNumber, null),
    issueUrl: clean(body.issueUrl, 500),
    title: clean(body.title, 300),
    queueId: clean(body.queueId, 80),
    workspace,
    logPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
  };
  runs.set(id, run);

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
    return run;
  }

  const codexArgs = ["exec", "--json", "--sandbox", "workspace-write", "-"];
  const child = spawn(codexLaunch.command, codexLaunchArgs(codexLaunch, codexArgs), {
    cwd: workspace,
    env: process.env,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(codexLaunch.cmdTarget),
  });

  run.pid = child.pid ?? null;
  run.status = "running";

  child.stdin.on("error", (error) => {
    log.write(
      `${JSON.stringify({ type: "stdin-error", error: error.message || String(error) })}\n`,
    );
  });
  child.stdout.on("data", (chunk) => log.write(chunk));
  child.stderr.on("data", (chunk) => {
    log.write(`${JSON.stringify({ type: "stderr", text: String(chunk) })}\n`);
  });
  child.once("error", (error) => {
    run.status = "failed";
    run.error = error.message || String(error);
    run.finishedAt = new Date().toISOString();
    log.write(`${JSON.stringify({ type: "error", error: run.error, at: run.finishedAt })}\n`);
    log.end();
  });
  child.once("exit", (code, signal) => {
    run.status = code === 0 ? "completed" : "failed";
    run.exitCode = code;
    run.signal = signal;
    run.finishedAt = new Date().toISOString();
    log.write(
      `${JSON.stringify({
        type: "exit",
        code,
        signal,
        at: run.finishedAt,
      })}\n`,
    );
    log.end();
  });
  child.stdin.end(prompt);

  await new Promise((resolve) => setTimeout(resolve, 25));
  if (run.status === "failed" && run.error) {
    throw new Error(run.error);
  }
  return run;
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
}

function activeRun() {
  return (
    [...runs.values()].find((run) => run.status === "starting" || run.status === "running") || null
  );
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
      url.hostname === "crabfleet.openclaw.ai"
    );
  } catch {
    return false;
  }
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
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

function codexLaunchArgs(launch, args) {
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
