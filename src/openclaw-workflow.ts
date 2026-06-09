export type OpenClawRoleMode = "contributor" | "trial_maintainer" | "maintainer";
export type OpenClawReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type OpenClawProofMode = "auto" | "local" | "crabbox" | "testbox" | "mantis";

export type OpenClawWorkflowPreferences = {
  subject: string;
  roleMode: OpenClawRoleMode;
  targetRepo: string;
  githubLogin: string | null;
  activeOpenPrLimit: number;
  hardOpenPrCap: number;
  dailyUsageDropLimit: number;
  maxParallelWorkers: number;
  minimumIssueAgeHours: number;
  codexReasoningEffort: OpenClawReasoningEffort;
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
  possiblePrCoverage?: OpenClawPrCoverage[];
  prCoverageUnknown?: boolean;
  prCoverageWarning?: string | null;
  workPrompt?: string;
};

export type OpenClawPrCoverage = {
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  updatedAt: string | null;
  reason: string;
};

type OpenClawCandidatePriorityInput = {
  labels?: readonly string[] | null;
  queueId?: string | null;
  signals?: Partial<
    Pick<
      OpenClawIssueSignals,
      "sourceRepro" | "currentMainRepro" | "fixShapeClear" | "needsLiveValidation"
    >
  > | null;
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

export type OpenClawCheckSummary = {
  state: "unknown" | "green" | "pending" | "failing";
  total: number;
  failing: string[];
  pending: string[];
  timedOut: string[];
  mantis: string | null;
};

export type OpenClawCheckRunLike = {
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

export type OpenClawCombinedStatusLike = {
  state?: string | null;
  statuses?: Array<{
    state?: string | null;
    context?: string | null;
  }> | null;
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
export const openClawDefaultMinimumIssueAgeHours = 6;
export const openClawDefaultReasoningEffort: OpenClawReasoningEffort = "high";
export const openClawDefaultProofMode: OpenClawProofMode = "auto";
export const openClawMaximumIssueAgeMs = 30 * 24 * 60 * 60 * 1000;
export const openClawReasoningEfforts: OpenClawReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];
export const openClawProofModes: OpenClawProofMode[] = [
  "auto",
  "local",
  "crabbox",
  "testbox",
  "mantis",
];

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
  minimumIssueAgeHours: openClawDefaultMinimumIssueAgeHours,
  codexReasoningEffort: openClawDefaultReasoningEffort,
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
    githubLogin: normalizeGitHubLogin(value.githubLogin) || fallback.githubLogin,
    activeOpenPrLimit: integerInRange(value.activeOpenPrLimit, 1, 20, fallback.activeOpenPrLimit),
    hardOpenPrCap: integerInRange(value.hardOpenPrCap, 1, 20, fallback.hardOpenPrCap),
    dailyUsageDropLimit: integerInRange(
      value.dailyUsageDropLimit,
      1,
      25,
      fallback.dailyUsageDropLimit,
    ),
    maxParallelWorkers: integerInRange(value.maxParallelWorkers, 1, 8, fallback.maxParallelWorkers),
    minimumIssueAgeHours: integerInRange(
      value.minimumIssueAgeHours,
      0,
      168,
      fallback.minimumIssueAgeHours,
    ),
    codexReasoningEffort: normalizeOpenClawReasoningEffort(
      value.codexReasoningEffort,
      fallback.codexReasoningEffort,
    ),
    weeklyRemainingBaseline:
      value.weeklyRemainingBaseline === undefined
        ? fallback.weeklyRemainingBaseline
        : nullablePercent(value.weeklyRemainingBaseline),
    weeklyRemainingCurrent:
      value.weeklyRemainingCurrent === undefined
        ? fallback.weeklyRemainingCurrent
        : nullablePercent(value.weeklyRemainingCurrent),
    usageWindowStartedAt:
      value.usageWindowStartedAt === undefined
        ? fallback.usageWindowStartedAt
        : nullablePositiveInteger(value.usageWindowStartedAt),
    updatedAt: nullablePositiveInteger(value.updatedAt) ?? fallback.updatedAt,
  };
}

export function normalizeOpenClawReasoningEffort(
  value: unknown,
  fallback: OpenClawReasoningEffort = openClawDefaultReasoningEffort,
): OpenClawReasoningEffort {
  const effort = String(value ?? "")
    .trim()
    .toLowerCase();
  return openClawReasoningEfforts.includes(effort as OpenClawReasoningEffort)
    ? (effort as OpenClawReasoningEffort)
    : fallback;
}

export function openClawReasoningEffortLabel(value: unknown): string {
  const effort = normalizeOpenClawReasoningEffort(value);
  if (effort === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function normalizeOpenClawProofMode(
  value: unknown,
  fallback: OpenClawProofMode = openClawDefaultProofMode,
): OpenClawProofMode {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  return openClawProofModes.includes(mode as OpenClawProofMode)
    ? (mode as OpenClawProofMode)
    : fallback;
}

export function openClawProofModeLabel(value: unknown): string {
  const mode = normalizeOpenClawProofMode(value);
  if (mode === "auto") return "Auto proof";
  if (mode === "local") return "Local proof";
  if (mode === "crabbox") return "Crabbox proof";
  if (mode === "testbox") return "Blacksmith Testbox";
  return "Mantis if available";
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

export function normalizeGitHubLogin(value: unknown): string {
  const login = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login) ? login : "";
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
  minimumIssueAgeHours = openClawDefaultMinimumIssueAgeHours,
): OpenClawIssueSignals {
  const lower = labels.map((label) => label.toLowerCase());
  const has = (label: string) => lower.includes(label.toLowerCase());
  const hasPrefix = (prefix: string) => lower.some((label) => label.startsWith(prefix));
  const blockers = sharedBlockedLabels.filter(has);
  const ageGate = issueAgeGate(createdAt, now, minimumIssueAgeHours);
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
    needsLiveValidation:
      has("clawsweeper:needs-live-validation") || has("clawsweeper:needs-live-repro"),
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

export function summarizeOpenClawChecks(
  checkRuns: OpenClawCheckRunLike[],
  combined: OpenClawCombinedStatusLike | null | undefined,
  signals: Pick<OpenClawPrSignals, "mantisRequested">,
): OpenClawCheckSummary {
  const failing = new Set<string>();
  const pending = new Set<string>();
  const timedOut = new Set<string>();
  const latestRuns = latestOpenClawCheckRuns(checkRuns);
  let mantis: string | null = signals.mantisRequested ? "requested" : null;

  for (const run of latestRuns) {
    const name = run.name || "check";
    const status = (run.status || "").toLowerCase();
    const conclusion = (run.conclusion ?? "").toLowerCase();
    if (name.toLowerCase().includes("mantis")) {
      mantis = conclusion || status || "seen";
    }
    if (status !== "completed") {
      pending.add(name);
      continue;
    }
    if (conclusion === "timed_out") timedOut.add(name);
    if (
      ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(
        conclusion,
      )
    ) {
      failing.add(name);
    }
  }

  for (const status of combined?.statuses ?? []) {
    const context = status.context || "status";
    const state = (status.state || "").toLowerCase();
    if (state === "pending") pending.add(context);
    if (["failure", "error"].includes(state)) failing.add(context);
  }

  const total = latestRuns.length + (combined?.statuses?.length ?? 0);
  const state =
    failing.size > 0
      ? "failing"
      : pending.size > 0
        ? "pending"
        : total > 0 || combined?.state === "success"
          ? "green"
          : "unknown";

  return {
    state,
    total,
    failing: [...failing].sort(),
    pending: [...pending].sort(),
    timedOut: [...timedOut].sort(),
    mantis,
  };
}

export function unknownOpenClawCheckSummary(
  signals: Pick<OpenClawPrSignals, "mantisRequested">,
): OpenClawCheckSummary {
  return {
    state: "unknown",
    total: 0,
    failing: [],
    pending: [],
    timedOut: [],
    mantis: signals.mantisRequested ? "requested" : null,
  };
}

function latestOpenClawCheckRuns(checkRuns: OpenClawCheckRunLike[]): OpenClawCheckRunLike[] {
  const latestByName = new Map<string, OpenClawCheckRunLike>();
  for (const run of [...checkRuns].sort(compareOpenClawCheckRunsNewestFirst)) {
    const name = run.name || "check";
    if (!latestByName.has(name)) latestByName.set(name, run);
  }
  return [...latestByName.values()];
}

function compareOpenClawCheckRunsNewestFirst(
  left: OpenClawCheckRunLike,
  right: OpenClawCheckRunLike,
): number {
  return openClawCheckRunTime(right) - openClawCheckRunTime(left);
}

function openClawCheckRunTime(run: OpenClawCheckRunLike): number {
  const value = run.completed_at || run.started_at || run.created_at || "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function openClawCandidateMatchesQueue(
  candidate: Pick<OpenClawCandidate, "labels" | "signals">,
  queue: Pick<OpenClawQueueDefinition, "labels" | "excludeLabels">,
): boolean {
  const labels = candidate.labels.map((label) => label.toLowerCase());
  const has = (label: string) => labels.includes(label.toLowerCase());
  return (
    queue.labels.every(has) &&
    !queue.excludeLabels.some(has) &&
    candidate.signals.ageGate !== "too-old" &&
    !candidate.signals.linkedPr &&
    !candidate.signals.noNewFixPr
  );
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
  const usageWindowActive = usageWindowAgeHours !== null && usageWindowAgeHours <= 24;
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

export function openClawCandidatePriorityLabel(
  candidate: OpenClawCandidatePriorityInput,
  queue?: Pick<OpenClawQueueDefinition, "id" | "priority"> | null,
): "P0" | "P1" | "P2" | null {
  const labels = (candidate.labels ?? []).map((label) => String(label).toLowerCase());
  const queueId = String(candidate.queueId || queue?.id || "").toLowerCase();
  const queuePriority = String(queue?.priority || "").toLowerCase();
  if (labels.includes("p0") || queuePriority === "p0" || queueId === "maintainer-p0") return "P0";
  if (labels.includes("p1") || queuePriority === "p1" || queueId === "maintainer-p1") return "P1";
  if (labels.includes("p2") || queuePriority === "p2" || queueId === "maintainer-p2") return "P2";
  return null;
}

export function openClawCandidatePriorityRank(
  candidate: OpenClawCandidatePriorityInput,
  queue?: Pick<OpenClawQueueDefinition, "id" | "priority"> | null,
): number {
  const queueId = String(candidate.queueId || queue?.id || "").toLowerCase();
  const priority = openClawCandidatePriorityLabel(candidate, queue);
  let score =
    priority === "P0"
      ? 0
      : priority === "P1"
        ? 10
        : priority === "P2"
          ? 20
          : queueId === "contributor-ready"
            ? 40
            : queueId === "contributor-clear-shape"
              ? 50
              : queueId === "contributor-source-repro"
                ? 60
                : 80;
  if (candidate.signals?.sourceRepro) score -= 3;
  if (candidate.signals?.currentMainRepro) score -= 2;
  if (candidate.signals?.fixShapeClear) score -= 1;
  if (candidate.signals?.needsLiveValidation) score += 4;
  return score;
}

export function buildOpenClawIssuePrompt(
  candidate: OpenClawCandidate,
  options: {
    codexReasoningEffort?: OpenClawReasoningEffort;
    proofMode?: OpenClawProofMode;
    claimCommentStatus?: unknown;
  } = {},
): string {
  const labels = candidate.labels.length ? candidate.labels.join(", ") : "none";
  const reasoningEffort = normalizeOpenClawReasoningEffort(options.codexReasoningEffort);
  const reasoningLabel = openClawReasoningEffortLabel(reasoningEffort);
  const proofMode = normalizeOpenClawProofMode(options.proofMode);
  const proofLabel = openClawProofModeLabel(proofMode);
  const possibleCoverage = (candidate.possiblePrCoverage ?? []).slice(0, 5);
  const coverageUnknown = Boolean(candidate.prCoverageUnknown);
  const claimStatus = String(options.claimCommentStatus || "");
  const claimAlreadyHandled = ["posted", "already-commented", "bridge-managed"].includes(
    claimStatus,
  );
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
    "You are working from a contributor/trial-maintainer posture unless explicitly told otherwise. Prepare evidence and handoff text; do not assume merge, close, direct-land, or release-pick permissions.",
    "",
    "Codex setup:",
    `Use model_reasoning_effort="${reasoningEffort}" (${reasoningLabel}) for this fix unless the local session already has a more specific explicit setting.`,
    "If this came from Claw Queue, work in the bridge-created worktree/branch and avoid `git pull` inside that worktree. Re-check GitHub live state with the available GitHub connector if local `gh` or `gitcrawl` config is outside the sandbox.",
    "",
    "Proof setup:",
    `Mode: ${proofLabel}. ${openClawProofModeInstruction(proofMode)}`,
    "Check required proof tooling early. If Crabbox, Blacksmith Testbox, Mantis, live credentials, or Codex review are unavailable, park with a concise blocker note instead of opening an under-proved PR.",
    "Use Tokenjuice for terminal-heavy output compaction when available. Verify with `tokenjuice doctor hooks` if output compaction looks broken, use `tokenjuice stats --timezone utc` for compaction stats, and use `tokenjuice wrap --raw -- <command>` when exact raw output is required.",
    "",
    ...openClawPossibleCoveragePromptLines(possibleCoverage),
    ...(coverageUnknown
      ? [
          "Possible open PR coverage lookup did not complete. Re-check open PRs before coding and do not start a competing fix if an existing PR covers this issue.",
          "",
        ]
      : []),
    "Process:",
    "1. Re-check the issue on GitHub before coding. Confirm it is still open, has no linked/open fix PR, no possible open PR already covering the same fix, and ClawSweeper marked it queueable.",
    "2. Read and follow the latest local OpenClaw AGENTS.md, CONTRIBUTING.md, and pull request template. If they are missing locally, fetch the current files from the target OpenClaw repo before continuing.",
    "3. Use the OpenClaw pre-PR issue intake gate: understand the report, reproduce or prove the behavior where feasible, check whether the issue still exists on current main and latest release, check the reported branch/version when available, and identify the smallest focused fix shape.",
    "4. Follow ClawSweeper's assessment and suggested route. Stop with a concise blocker note if it needs a product, security, maintainer, or reporter decision.",
    claimAlreadyHandled
      ? "5. Claw Queue already posted or found the issue claim comment for this run. Do not post a duplicate claim comment; just verify the issue is still yours before opening the PR."
      : "5. If issue claiming is not available, comment on the issue that you are working on it before making the PR.",
    "6. Check maintainer-handbook routing before editing: release-sensitive fixes need release-branch awareness and a release-pick note; plugin install/update/SDK/package behavior needs maintainer-channel discussion before final shape; security-adjacent auth, sandbox, command execution, file access, token, updater, provider, GHSA, CVE, advisory, or hardening work must avoid public vulnerability metadata and should be parked/escalated rather than handled as an ordinary public PR.",
    "7. Confirm the target repo owns the surface. If the issue belongs in ClawHub, plugin-inspector, kitchen-sink, crabpot, crabbox, gitcrawl, ClawSweeper, maintainers, or another OpenClaw repo, route or park it instead of patching the wrong repo.",
    "8. Keep the change focused. Avoid unrelated refactors and avoid CHANGELOG edits unless OpenClaw's current contributing guidance explicitly requires one. If the change is user-visible, operationally meaningful, security-relevant, or release-note worthy, include release-note context in the PR body or handoff as the current repo guidance allows.",
    "9. Run the relevant proof for the selected proof mode plus local tests where useful. Include before/after evidence when the issue needs behavior proof. Use Crabbox/Blacksmith Testbox for remote validation when available, and use Mantis if it is available and relevant. Broaden validation for shared runtime, plugin contracts, release paths, security paths, package management, onboarding, or cross-platform behavior; do not duplicate heavy checks already running, and document unrelated baseline failures.",
    "10. Before opening or updating the PR, run Codex review with the appropriate base, normally: codex review --base origin/main.",
    "11. Open or update the PR only when the fix is ready for maintainer review. The PR body must link the issue and include proof, tests, Codex review, release/plugin/security notes when relevant, and any Mantis/ClawSweeper notes.",
    "12. After opening/updating the PR, monitor CI and ClawSweeper. If checks fail, fix them and update the PR. If CI times out/flakes, rerun or make a harmless update only when that is the accepted OpenClaw process.",
    "13. Do not stop just because the PR exists. Stop only when CI is green or failures are explained, Codex review has passed, proof is sufficient, and ClawSweeper/status labels indicate it is ready for maintainer look.",
    "14. If proof is insufficient, required tooling is unavailable, the surface needs maintainer/security/product/reporter discussion, or Mantis is unavailable/broken when required, park the work with a short blocker note explaining what is missing.",
    "",
    "When finished, provide a short Discord-ready maintainer handoff: PR link, issue link, one-line summary, proof/tests, Codex review result, CI state, and ClawSweeper readiness.",
  ].join("\n");
}

function openClawProofModeInstruction(mode: OpenClawProofMode): string {
  if (mode === "local") {
    return "Prefer a local reproduction, focused regression test, or command-line proof. Use Crabbox or Mantis only if local proof cannot credibly prove the fix.";
  }
  if (mode === "crabbox") {
    return "Plan on Crabbox/live validation before the PR is marked ready. Use the Crabbox wrapper to validate the reported branch/version, latest release, and current main where relevant. Park the issue if live proof is required and Crabbox is unavailable.";
  }
  if (mode === "testbox") {
    return "Plan on Blacksmith Testbox validation through Crabbox before the PR is marked ready. Use it to prove whether the issue exists on the reported branch/version, latest release, and current main, then capture before/after evidence for the PR.";
  }
  if (mode === "mantis") {
    return "Use or request Mantis proof if it is available. If Mantis is unavailable, collect the strongest local, Crabbox, or Blacksmith Testbox proof and park if that still is not enough.";
  }
  return "Choose the cheapest credible proof path after intake: local tests first, Crabbox or Blacksmith Testbox for environment/live behavior and cross-version validation, and Mantis when it is available and adds real evidence.";
}

function openClawPossibleCoveragePromptLines(coverage: OpenClawPrCoverage[]): string[] {
  if (!coverage.length) return [];
  return [
    "Possible open PR coverage to inspect before coding:",
    ...coverage.map((pr) => {
      const draft = pr.draft ? "draft " : "";
      const author = pr.author ? ` by @${pr.author}` : "";
      return `- ${draft}PR #${pr.number}${author}: ${pr.title} (${pr.url}) - ${pr.reason}`;
    }),
    "If any listed PR already covers this issue, do not start a competing fix. Review that PR instead, or park this item with a short note.",
    "",
  ];
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
  minimumIssueAgeHours: number,
): OpenClawIssueSignals["ageGate"] {
  if (!createdAt) return "unknown";
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "unknown";
  const ageMs = now - created;
  const minimumIssueAgeMs = Math.max(0, minimumIssueAgeHours) * 60 * 60 * 1000;
  if (ageMs < minimumIssueAgeMs) return "too-new";
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
