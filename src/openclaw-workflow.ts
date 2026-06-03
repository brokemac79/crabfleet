export type OpenClawRoleMode = "contributor" | "trial_maintainer" | "maintainer";

export type OpenClawWorkflowPreferences = {
  subject: string;
  roleMode: OpenClawRoleMode;
  targetRepo: string;
  githubLogin: string | null;
  activeOpenPrLimit: number;
  hardOpenPrCap: number;
  dailyUsageDropLimit: number;
  maxParallelWorkers: number;
  weeklyRemainingBaseline: number | null;
  weeklyRemainingCurrent: number | null;
  usageWindowStartedAt: number | null;
  updatedAt: number;
};

export type OpenClawQueueDefinition = {
  id: string;
  audience: OpenClawRoleMode[];
  title: string;
  priority: string | null;
  labels: string[];
  excludeLabels: string[];
  sort: "created" | "updated";
  order: "asc" | "desc";
  why: string;
};

export type OpenClawIssueSignals = {
  clawsweeperPass: boolean;
  queueable: boolean;
  linkedPr: boolean;
  noNewFixPr: boolean;
  sourceRepro: boolean;
  currentMainRepro: boolean;
  fixShapeClear: boolean;
  needsLiveValidation: boolean;
  blockers: string[];
  ageGate: "too-new" | "eligible" | "too-old" | "unknown";
  readyForPickup: boolean;
};

export type OpenClawCandidate = {
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  labels: string[];
  queueId: string;
  signals: OpenClawIssueSignals;
  workPrompt?: string;
};

export type OpenClawPrSignals = {
  readyForMaintainer: boolean;
  needsProof: boolean;
  waitingOnAuthor: boolean;
  reReviewLoop: boolean;
  proofSufficient: boolean;
  mergeReady: boolean;
  mantisRequested: boolean;
  clawsweeperHumanReview: boolean;
  statusLabel: string | null;
};

export type OpenClawGovernor = {
  canStartNewWork: boolean;
  reasons: string[];
  activeOpenPrLimit: number;
  hardOpenPrCap: number;
  openPrCount: number;
  usageDrop: number | null;
  usageLimit: number;
  usageWindowAgeHours: number | null;
};

export type OpenClawHandoffInput = {
  prUrl?: string | null;
  issueUrl?: string | null;
  title?: string | null;
  summary?: string | null;
  proof?: string | null;
  ci?: string | null;
  clawsweeper?: string | null;
  codexReview?: string | null;
};

export const openClawDefaultRepo = "openclaw/openclaw";
const openClawMinimumIssueAgeMs = 6 * 60 * 60 * 1000;
const openClawMaximumIssueAgeMs = 30 * 24 * 60 * 60 * 1000;

export const openClawDefaultPreferences: Omit<
  OpenClawWorkflowPreferences,
  "subject" | "updatedAt"
> = {
  roleMode: "trial_maintainer",
  targetRepo: openClawDefaultRepo,
  githubLogin: null,
  activeOpenPrLimit: 10,
  hardOpenPrCap: 20,
  dailyUsageDropLimit: 5,
  maxParallelWorkers: 2,
  weeklyRemainingBaseline: null,
  weeklyRemainingCurrent: null,
  usageWindowStartedAt: null,
};

const sharedBlockedLabels = [
  "clawsweeper:no-new-fix-pr",
  "clawsweeper:linked-pr-open",
  "clawsweeper:needs-maintainer-review",
  "clawsweeper:needs-product-decision",
  "clawsweeper:needs-security-review",
  "clawsweeper:needs-info",
];

export const openClawQueueDefinitions: OpenClawQueueDefinition[] = [
  priorityQueue("maintainer-p0", "P0", "Emergency queueable fixes"),
  priorityQueue("maintainer-p1", "P1", "High-priority queueable fixes"),
  priorityQueue("maintainer-p2", "P2", "Normal queueable fixes"),
  {
    id: "contributor-ready",
    audience: ["contributor", "trial_maintainer", "maintainer"],
    title: "Ready-to-queue fixes",
    priority: null,
    labels: ["clawsweeper:queueable-fix"],
    excludeLabels: sharedBlockedLabels,
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
    excludeLabels: sharedBlockedLabels,
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
    excludeLabels: sharedBlockedLabels,
    sort: "created",
    order: "asc",
    why: "Queueable fixes backed by source-level reproduction evidence.",
  },
];

function priorityQueue(id: string, priority: string, title: string): OpenClawQueueDefinition {
  return {
    id,
    audience: ["trial_maintainer", "maintainer"],
    title,
    priority,
    labels: [priority, "clawsweeper:queueable-fix"],
    excludeLabels: sharedBlockedLabels,
    sort: "created",
    order: "asc",
    why: `${priority} issue triage, queueable, and without a linked fix PR.`,
  };
}

export function queuesForOpenClawRole(roleMode: OpenClawRoleMode): OpenClawQueueDefinition[] {
  return openClawQueueDefinitions.filter((queue) => queue.audience.includes(roleMode));
}

export function normalizeOpenClawPreferences(
  value: Partial<OpenClawWorkflowPreferences>,
  fallback: OpenClawWorkflowPreferences,
): OpenClawWorkflowPreferences {
  return {
    subject: fallback.subject,
    roleMode: roleMode(value.roleMode, fallback.roleMode),
    targetRepo: normalizeGitHubRepo(value.targetRepo) || fallback.targetRepo,
    githubLogin: cleanText(value.githubLogin, 80) || fallback.githubLogin,
    activeOpenPrLimit: integerInRange(value.activeOpenPrLimit, 1, 20, fallback.activeOpenPrLimit),
    hardOpenPrCap: integerInRange(value.hardOpenPrCap, 1, 20, fallback.hardOpenPrCap),
    dailyUsageDropLimit: integerInRange(
      value.dailyUsageDropLimit,
      1,
      25,
      fallback.dailyUsageDropLimit,
    ),
    maxParallelWorkers: integerInRange(value.maxParallelWorkers, 1, 8, fallback.maxParallelWorkers),
    weeklyRemainingBaseline: nullablePercent(value.weeklyRemainingBaseline),
    weeklyRemainingCurrent: nullablePercent(value.weeklyRemainingCurrent),
    usageWindowStartedAt: nullablePositiveInteger(value.usageWindowStartedAt),
    updatedAt: nullablePositiveInteger(value.updatedAt) ?? fallback.updatedAt,
  };
}

export function normalizeGitHubRepo(value: unknown): string {
  const repo = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) ? repo : "";
}

export function buildOpenClawIssueSearchQuery(
  repo: string,
  queue: OpenClawQueueDefinition,
  now = Date.now(),
): string {
  const parts = [
    `repo:${normalizeGitHubRepo(repo) || openClawDefaultRepo}`,
    "is:issue",
    "is:open",
    "-linked:pr",
    `created:>=${githubSearchDate(now - openClawMaximumIssueAgeMs)}`,
    ...queue.labels.map((label) => `label:${quoteSearchValue(label)}`),
    ...queue.excludeLabels.map((label) => `-label:${quoteSearchValue(label)}`),
  ];
  return parts.join(" ");
}

export function openClawIssueSignals(
  labels: string[],
  createdAt: string | null | undefined,
  now = Date.now(),
): OpenClawIssueSignals {
  const lower = labels.map((label) => label.toLowerCase());
  const has = (label: string) => lower.includes(label.toLowerCase());
  const hasPrefix = (prefix: string) => lower.some((label) => label.startsWith(prefix));
  const blockers = sharedBlockedLabels.filter(has);
  const ageGate = issueAgeGate(createdAt, now);
  const queueable = has("clawsweeper:queueable-fix");
  const linkedPr = has("clawsweeper:linked-pr-open");
  const noNewFixPr = has("clawsweeper:no-new-fix-pr");
  const clawsweeperPass = hasPrefix("clawsweeper:");

  return {
    clawsweeperPass,
    queueable,
    linkedPr,
    noNewFixPr,
    sourceRepro: has("clawsweeper:source-repro"),
    currentMainRepro: has("clawsweeper:current-main-repro"),
    fixShapeClear: has("clawsweeper:fix-shape-clear"),
    needsLiveValidation: has("clawsweeper:needs-live-validation"),
    blockers,
    ageGate,
    readyForPickup:
      clawsweeperPass &&
      queueable &&
      !linkedPr &&
      !noNewFixPr &&
      blockers.length === 0 &&
      ageGate === "eligible",
  };
}

export function openClawPrSignals(labels: string[]): OpenClawPrSignals {
  const lower = labels.map((label) => label.toLowerCase());
  const includes = (needle: string) => lower.some((label) => label.includes(needle));
  const statusLabel = labels.find((label) => label.toLowerCase().startsWith("status:")) ?? null;
  const needsProof = includes("needs proof");
  const waitingOnAuthor = includes("waiting on author") || includes("actively grinding");
  const reReviewLoop = includes("re-review loop");
  const proofSufficient = lower.includes("proof: sufficient");
  const mergeReady = lower.includes("clawsweeper:merge-ready");
  const readyForMaintainer =
    includes("ready for maintainer look") && !needsProof && !waitingOnAuthor;

  return {
    readyForMaintainer,
    needsProof,
    waitingOnAuthor,
    reReviewLoop,
    proofSufficient,
    mergeReady,
    mantisRequested: lower.some((label) => label.startsWith("mantis:")),
    clawsweeperHumanReview: lower.includes("clawsweeper:human-review"),
    statusLabel,
  };
}

export function evaluateOpenClawGovernor(
  preferences: OpenClawWorkflowPreferences,
  openPrCount: number,
  now = Date.now(),
): OpenClawGovernor {
  const activeOpenPrLimit = Math.min(preferences.activeOpenPrLimit, preferences.hardOpenPrCap);
  const usageDrop =
    preferences.weeklyRemainingBaseline === null || preferences.weeklyRemainingCurrent === null
      ? null
      : Math.max(0, preferences.weeklyRemainingBaseline - preferences.weeklyRemainingCurrent);
  const usageWindowAgeHours = preferences.usageWindowStartedAt
    ? Math.max(0, (now - preferences.usageWindowStartedAt) / 3_600_000)
    : null;
  const usageWindowActive = usageWindowAgeHours === null || usageWindowAgeHours <= 24;
  const reasons: string[] = [];
  if (openPrCount >= preferences.hardOpenPrCap) {
    reasons.push(`Hard OpenClaw cap reached (${openPrCount}/${preferences.hardOpenPrCap}).`);
  } else if (openPrCount >= activeOpenPrLimit) {
    reasons.push(`Personal open PR limit reached (${openPrCount}/${activeOpenPrLimit}).`);
  }
  if (usageWindowActive && usageDrop !== null && usageDrop >= preferences.dailyUsageDropLimit) {
    reasons.push(
      `Usage budget reached (${usageDrop}/${preferences.dailyUsageDropLimit} weekly percentage points).`,
    );
  }

  return {
    canStartNewWork: reasons.length === 0,
    reasons,
    activeOpenPrLimit,
    hardOpenPrCap: preferences.hardOpenPrCap,
    openPrCount,
    usageDrop,
    usageLimit: preferences.dailyUsageDropLimit,
    usageWindowAgeHours,
  };
}

export function buildOpenClawIssuePrompt(candidate: OpenClawCandidate): string {
  const labels = candidate.labels.length ? candidate.labels.join(", ") : "none";
  return [
    `Start work on this OpenClaw issue: ${candidate.url}`,
    "",
    `Title: ${candidate.title}`,
    `Issue number: #${candidate.number}`,
    `Queue: ${candidate.queueId}`,
    `Labels: ${labels}`,
    "",
    "Goal:",
    "Produce a focused fix PR that is ready for maintainer review. Do not merge, land, or enable automerge.",
    "",
    "Process:",
    "1. Re-check the issue on GitHub before coding. Confirm it is still open, has no linked/open fix PR, and ClawSweeper marked it queueable.",
    "2. Read and follow the latest local OpenClaw AGENTS.md, CONTRIBUTING.md, and pull request template. If they are missing locally, fetch the current files from the target OpenClaw repo before continuing.",
    "3. Use the OpenClaw pre-PR issue intake gate: understand the report, reproduce or prove the behavior where feasible, and identify the smallest safe fix shape.",
    "4. Follow ClawSweeper's assessment and suggested route. Stop with a concise blocker note if it needs a product, security, maintainer, or reporter decision.",
    "5. If issue claiming is not available, comment on the issue that you are working on it before making the PR.",
    "6. Keep the change focused. Avoid unrelated refactors and avoid CHANGELOG edits unless OpenClaw's current contributing guidance explicitly requires one.",
    "7. Run the relevant local tests and proof commands. Include before/after evidence when the issue needs behavior proof. Use Mantis if it is available and relevant.",
    "8. Before opening or updating the PR, run Codex review with the appropriate base, normally: codex review --base origin/main.",
    "9. Open or update the PR only when the fix is ready for maintainer review. The PR body must link the issue and include proof, tests, Codex review, and any Mantis/ClawSweeper notes.",
    "10. After opening/updating the PR, monitor CI and ClawSweeper. If checks fail, fix them and update the PR. If CI times out/flakes, rerun or make a harmless update only when that is the accepted OpenClaw process.",
    "11. Do not stop just because the PR exists. Stop only when CI is green or failures are explained, Codex review has passed, proof is sufficient, and ClawSweeper/status labels indicate it is ready for maintainer look.",
    "12. If proof is insufficient and Mantis is unavailable or broken, park the work with a short blocker note explaining what is missing.",
    "",
    "When finished, provide a short Discord-ready maintainer handoff: PR link, issue link, one-line summary, proof/tests, Codex review result, CI state, and ClawSweeper readiness.",
  ].join("\n");
}

export function buildOpenClawDiscordHandoff(input: OpenClawHandoffInput): string {
  const title = cleanText(input.title, 160) || "OpenClaw PR ready for maintainer review";
  const pr = cleanText(input.prUrl, 300);
  const issue = cleanText(input.issueUrl, 300);
  const summary = cleanText(input.summary, 220) || "Focused fix is ready for maintainer review.";
  const proof = cleanText(input.proof, 220) || "Local validation passed and Codex review was run.";
  const ci = cleanText(input.ci, 160) || "CI is green or no failing required checks are known.";
  const clawsweeper =
    cleanText(input.clawsweeper, 180) || "ClawSweeper has no known contributor-facing blocker.";
  const codexReview =
    cleanText(input.codexReview, 160) || "codex review --base origin/main passed.";
  return [
    `Maintainer review requested: ${title}`,
    pr ? `PR: ${pr}` : "",
    issue ? `Issue: ${issue}` : "",
    `Summary: ${summary}`,
    `Proof: ${proof}`,
    `State: ${ci}; ${clawsweeper}; ${codexReview}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function issueAgeGate(
  createdAt: string | null | undefined,
  now: number,
): OpenClawIssueSignals["ageGate"] {
  if (!createdAt) return "unknown";
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "unknown";
  const ageMs = now - created;
  if (ageMs < openClawMinimumIssueAgeMs) return "too-new";
  if (ageMs > openClawMaximumIssueAgeMs) return "too-old";
  return "eligible";
}

function githubSearchDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function roleMode(value: unknown, fallback: OpenClawRoleMode): OpenClawRoleMode {
  return value === "contributor" || value === "trial_maintainer" || value === "maintainer"
    ? value
    : fallback;
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function nullablePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(100, Math.max(0, Math.trunc(parsed)));
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function quoteSearchValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}
