import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOpenClawDiscordHandoff,
  buildOpenClawIssuePrompt,
  buildOpenClawIssueSearchQuery,
  evaluateOpenClawGovernor,
  normalizeGitHubLogin,
  openClawCandidateMatchesQueue,
  normalizeOpenClawPreferences,
  openClawCandidatePriorityLabel,
  openClawCandidatePriorityRank,
  openClawIssueSignals,
  openClawProofModeLabel,
  openClawPrSignals,
  queuesForOpenClawRole,
  summarizeOpenClawChecks,
  unknownOpenClawCheckSummary,
  type OpenClawWorkflowPreferences,
} from "../src/openclaw-workflow.ts";

const now = Date.UTC(2026, 5, 3, 12, 0, 0);

test("trial maintainer queues start with P0, P1, and P2 no-linked candidates", () => {
  const queues = queuesForOpenClawRole("trial_maintainer");
  const query = buildOpenClawIssueSearchQuery("openclaw/openclaw", queues[0], now);

  assert.deepEqual(
    queues.slice(0, 3).map((queue) => queue.priority),
    ["P0", "P1", "P2"],
  );
  assert.match(query, /repo:openclaw\/openclaw is:issue is:open -linked:pr/);
  assert.match(query, /created:>=2026-05-04/);
  assert.match(query, /label:"P0" label:"clawsweeper:queueable-fix"/);
  assert.match(query, /-label:"clawsweeper:linked-pr-open"/);
});

test("secondary queues are still constrained to queueable fixes", () => {
  const queues = queuesForOpenClawRole("contributor").filter((queue) =>
    ["contributor-clear-shape", "contributor-source-repro"].includes(queue.id),
  );

  for (const queue of queues) {
    assert.match(
      buildOpenClawIssueSearchQuery("openclaw/openclaw", queue, now),
      /label:"clawsweeper:queueable-fix"/,
    );
  }
});

test("issue signals require ClawSweeper queueable labels and the age gate", () => {
  const labels = [
    "P1",
    "clawsweeper:queueable-fix",
    "clawsweeper:source-repro",
    "clawsweeper:current-main-repro",
  ];

  const signals = openClawIssueSignals(labels, "2026-06-02T12:00:00Z", now);

  assert.equal(signals.readyForPickup, true);
  assert.equal(signals.sourceRepro, true);
  assert.equal(signals.currentMainRepro, true);
  assert.equal(signals.ageGate, "eligible");
});

test("issue signals block linked PRs, no-new-fix labels, and too-new issues", () => {
  const linked = openClawIssueSignals(
    ["clawsweeper:queueable-fix", "clawsweeper:linked-pr-open"],
    "2026-06-02T12:00:00Z",
    now,
  );
  const tooNew = openClawIssueSignals(["clawsweeper:queueable-fix"], "2026-06-03T10:00:00Z", now);

  assert.equal(linked.readyForPickup, false);
  assert.equal(linked.linkedPr, true);
  assert.equal(tooNew.readyForPickup, false);
  assert.equal(tooNew.ageGate, "too-new");
});

test("issue signals treat needs-live-repro as a live proof hint", () => {
  const signals = openClawIssueSignals(
    ["clawsweeper:queueable-fix", "clawsweeper:needs-live-repro"],
    "2026-06-02T12:00:00Z",
    now,
  );

  assert.equal(signals.needsLiveValidation, true);
  assert.equal(signals.readyForPickup, true);
});

test("issue age gate can be lowered for fork testing", () => {
  const labels = ["clawsweeper:queueable-fix"];
  const createdTwoHoursAgo = "2026-06-03T10:00:00Z";

  const defaultGate = openClawIssueSignals(labels, createdTwoHoursAgo, now);
  const testGate = openClawIssueSignals(labels, createdTwoHoursAgo, now, 0);

  assert.equal(defaultGate.readyForPickup, false);
  assert.equal(defaultGate.ageGate, "too-new");
  assert.equal(testGate.readyForPickup, true);
  assert.equal(testGate.ageGate, "eligible");
});

test("candidate priority ranking keeps maintainer priority ahead of overlapping contributor queues", () => {
  const p1Candidate = {
    labels: ["P1", "clawsweeper:queueable-fix", "clawsweeper:source-repro"],
    queueId: "contributor-source-repro",
    signals: {
      sourceRepro: true,
      currentMainRepro: false,
      fixShapeClear: true,
      needsLiveValidation: false,
    },
  };
  const clearShapeCandidate = {
    labels: ["clawsweeper:queueable-fix", "clawsweeper:fix-shape-clear"],
    queueId: "contributor-clear-shape",
    signals: {
      sourceRepro: false,
      currentMainRepro: false,
      fixShapeClear: true,
      needsLiveValidation: false,
    },
  };

  assert.equal(openClawCandidatePriorityLabel(p1Candidate), "P1");
  assert.equal(
    openClawCandidatePriorityRank(p1Candidate) < openClawCandidatePriorityRank(clearShapeCandidate),
    true,
  );
});

test("candidate queue matching can reuse broader queue data for partial lookup failures", () => {
  const queues = queuesForOpenClawRole("trial_maintainer");
  const p2Queue = queues.find((queue) => queue.id === "maintainer-p2");
  const sourceQueue = queues.find((queue) => queue.id === "contributor-source-repro");
  assert.ok(p2Queue);
  assert.ok(sourceQueue);

  const p2Candidate = {
    labels: ["P2", "clawsweeper:queueable-fix"],
    signals: openClawIssueSignals(["P2", "clawsweeper:queueable-fix"], "2026-06-02T12:00:00Z", now),
  };
  const sourceCandidate = {
    labels: ["clawsweeper:queueable-fix", "clawsweeper:source-repro"],
    signals: openClawIssueSignals(
      ["clawsweeper:queueable-fix", "clawsweeper:source-repro"],
      "2026-06-02T12:00:00Z",
      now,
    ),
  };
  const blockedCandidate = {
    labels: ["P2", "clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"],
    signals: openClawIssueSignals(
      ["P2", "clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"],
      "2026-06-02T12:00:00Z",
      now,
    ),
  };

  assert.equal(openClawCandidateMatchesQueue(p2Candidate, p2Queue), true);
  assert.equal(openClawCandidateMatchesQueue(sourceCandidate, sourceQueue), true);
  assert.equal(openClawCandidateMatchesQueue(blockedCandidate, p2Queue), false);
  assert.equal(openClawCandidateMatchesQueue(sourceCandidate, p2Queue), false);
});

test("governor pauses new work at personal PR and usage limits", () => {
  const preferences = basePreferences({
    activeOpenPrLimit: 10,
    hardOpenPrCap: 20,
    weeklyRemainingBaseline: 97,
    weeklyRemainingCurrent: 91,
    dailyUsageDropLimit: 5,
    usageWindowStartedAt: now - 60 * 60 * 1000,
  });

  const governor = evaluateOpenClawGovernor(preferences, 10, now);

  assert.equal(governor.canStartNewWork, false);
  assert.equal(governor.usageDrop, 6);
  assert.match(governor.reasons.join(" "), /Personal open PR limit/);
  assert.match(governor.reasons.join(" "), /Usage budget/);
});

test("governor does not pause usage budgets without a started window", () => {
  const preferences = basePreferences({
    weeklyRemainingBaseline: 97,
    weeklyRemainingCurrent: 90,
    dailyUsageDropLimit: 5,
    usageWindowStartedAt: null,
  });

  const governor = evaluateOpenClawGovernor(preferences, 2, now);

  assert.equal(governor.canStartNewWork, true);
  assert.equal(governor.usageDrop, 7);
  assert.equal(
    governor.reasons.some((reason) => /Usage budget/.test(reason)),
    false,
  );
});

test("governor does not keep an expired usage window paused forever", () => {
  const preferences = basePreferences({
    weeklyRemainingBaseline: 97,
    weeklyRemainingCurrent: 90,
    usageWindowStartedAt: now - 25 * 60 * 60 * 1000,
  });

  const governor = evaluateOpenClawGovernor(preferences, 2, now);

  assert.equal(governor.canStartNewWork, true);
  assert.equal(governor.usageDrop, 7);
  assert.equal(
    governor.reasons.some((reason) => /Usage budget/.test(reason)),
    false,
  );
});

test("PR signals identify ready-for-maintainer handoff state", () => {
  const signals = openClawPrSignals([
    "proof: sufficient",
    "status: ready for maintainer look",
    "clawsweeper:merge-ready",
  ]);

  assert.equal(signals.readyForMaintainer, true);
  assert.equal(signals.proofSufficient, true);
  assert.equal(signals.mergeReady, true);
});

test("check summary uses the newest run per check name", () => {
  const signals = openClawPrSignals(["status: ready for maintainer look"]);
  const checks = summarizeOpenClawChecks(
    [
      {
        name: "Real behavior proof",
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-06-05T10:00:00Z",
      },
      {
        name: "Real behavior proof",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-05T11:00:00Z",
      },
      {
        name: "checks-node-agentic-plugin-sdk",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-05T11:05:00Z",
      },
    ],
    { state: "pending", statuses: [] },
    signals,
  );

  assert.equal(checks.state, "green");
  assert.deepEqual(checks.failing, []);
  assert.equal(checks.total, 2);
});

test("check summary keeps newer queued duplicate runs pending", () => {
  const checks = summarizeOpenClawChecks(
    [
      {
        name: "unit tests",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-05T11:00:00Z",
      },
      {
        name: "unit tests",
        status: "queued",
        conclusion: null,
        created_at: "2026-06-05T11:05:00Z",
      },
    ],
    null,
    { mantisRequested: false },
  );

  assert.equal(checks.state, "pending");
  assert.deepEqual(checks.pending, ["unit tests"]);
});

test("check summary still works when only one GitHub checks endpoint has data", () => {
  const signals = openClawPrSignals([]);

  const checkRunsOnly = summarizeOpenClawChecks(
    [
      {
        name: "unit tests",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-05T11:00:00Z",
      },
    ],
    null,
    signals,
  );
  const combinedOnly = summarizeOpenClawChecks([], { state: "success", statuses: [] }, signals);

  assert.equal(checkRunsOnly.state, "green");
  assert.equal(combinedOnly.state, "green");
  assert.equal(unknownOpenClawCheckSummary(signals).state, "unknown");
});

test("issue prompt carries the OpenClaw fix process into Codex", () => {
  const prompt = buildOpenClawIssuePrompt({
    number: 99,
    title: "Queue guard ignores linked PRs",
    url: "https://github.com/openclaw/openclaw/issues/99",
    author: "reporter",
    createdAt: "2026-06-02T12:00:00Z",
    updatedAt: "2026-06-03T12:00:00Z",
    labels: ["P1", "clawsweeper:queueable-fix", "clawsweeper:source-repro"],
    queueId: "maintainer-p1",
    signals: openClawIssueSignals(
      ["P1", "clawsweeper:queueable-fix", "clawsweeper:source-repro"],
      "2026-06-02T12:00:00Z",
      now,
    ),
  });

  assert.match(prompt, /CONTRIBUTING\.md/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /codex review --base origin\/main/);
  assert.match(prompt, /model_reasoning_effort="high"/);
  assert.match(prompt, /Mode: Auto proof/);
  assert.match(prompt, /Tokenjuice/);
  assert.match(prompt, /tokenjuice doctor hooks/);
  assert.match(prompt, /contributor\/trial-maintainer posture/);
  assert.match(prompt, /release-branch awareness/);
  assert.match(prompt, /plugin install\/update\/SDK\/package behavior/);
  assert.match(prompt, /security-adjacent auth/);
  assert.match(prompt, /target repo owns the surface/);
  assert.match(prompt, /monitor CI and ClawSweeper/);
  assert.match(prompt, /ready for maintainer look/);
  assert.match(prompt, /Discord-ready maintainer handoff/);

  const extraHighPrompt = buildOpenClawIssuePrompt(
    {
      number: 100,
      title: "Queue guard needs deeper investigation",
      url: "https://github.com/openclaw/openclaw/issues/100",
      author: "reporter",
      createdAt: "2026-06-02T12:00:00Z",
      updatedAt: "2026-06-03T12:00:00Z",
      labels: ["P0", "clawsweeper:queueable-fix"],
      queueId: "maintainer-p0",
      signals: openClawIssueSignals(
        ["P0", "clawsweeper:queueable-fix"],
        "2026-06-02T12:00:00Z",
        now,
      ),
    },
    { codexReasoningEffort: "xhigh", proofMode: "crabbox" },
  );
  assert.match(extraHighPrompt, /model_reasoning_effort="xhigh"/);
  assert.match(extraHighPrompt, /Extra high/);
  assert.match(extraHighPrompt, /Mode: Crabbox proof/);
  assert.equal(openClawProofModeLabel("mantis"), "Mantis if available");
});

test("issue prompt warns about possible open PR coverage", () => {
  const prompt = buildOpenClawIssuePrompt(
    {
      number: 90157,
      title: "Fix queue candidate",
      url: "https://github.com/openclaw/openclaw/issues/90157",
      author: "reporter",
      createdAt: "2026-06-02T12:00:00Z",
      updatedAt: "2026-06-03T12:00:00Z",
      labels: ["P1", "clawsweeper:queueable-fix"],
      queueId: "specific-issue",
      signals: openClawIssueSignals(
        ["P1", "clawsweeper:queueable-fix"],
        "2026-06-02T12:00:00Z",
        now,
      ),
      possiblePrCoverage: [
        {
          number: 90339,
          title: "Fix same issue",
          url: "https://github.com/openclaw/openclaw/pull/90339",
          author: "alice",
          draft: true,
          updatedAt: "2026-06-03T13:00:00Z",
          reason: "PR text mentions #90157",
        },
      ],
    },
    { proofMode: "mantis" },
  );

  assert.match(prompt, /Possible open PR coverage/);
  assert.match(prompt, /PR #90339/);
  assert.match(prompt, /do not start a competing fix/i);
  assert.match(prompt, /Mode: Mantis if available/);
});

test("issue prompt warns when PR coverage is unresolved", () => {
  const prompt = buildOpenClawIssuePrompt({
    number: 90158,
    title: "Fix coverage unknown candidate",
    url: "https://github.com/openclaw/openclaw/issues/90158",
    author: "reporter",
    createdAt: "2026-06-02T12:00:00Z",
    updatedAt: "2026-06-03T12:00:00Z",
    labels: ["P1", "clawsweeper:queueable-fix"],
    queueId: "specific-issue",
    signals: openClawIssueSignals(["P1", "clawsweeper:queueable-fix"], "2026-06-02T12:00:00Z", now),
    prCoverageUnknown: true,
    prCoverageWarning: "Possible PR coverage lookup failed",
  });

  assert.match(prompt, /coverage lookup did not complete/);
  assert.match(prompt, /do not start a competing fix/i);
});

test("issue prompt skips duplicate claim comments when Claw Queue already claimed", () => {
  const prompt = buildOpenClawIssuePrompt(
    {
      number: 90315,
      title: "Gateway catalog drops Ollama capabilities",
      url: "https://github.com/openclaw/openclaw/issues/90315",
      author: "reporter",
      createdAt: "2026-06-02T12:00:00Z",
      updatedAt: "2026-06-03T12:00:00Z",
      labels: ["P2", "clawsweeper:queueable-fix"],
      queueId: "maintainer-p2",
      signals: openClawIssueSignals(
        ["P2", "clawsweeper:queueable-fix"],
        "2026-06-02T12:00:00Z",
        now,
      ),
    },
    { claimCommentStatus: "posted" },
  );

  assert.match(prompt, /already posted or found the issue claim comment/);
  assert.match(prompt, /Do not post a duplicate claim comment/);

  const bridgeManagedPrompt = buildOpenClawIssuePrompt(
    {
      number: 90316,
      title: "Bridge handles claim before Codex starts",
      url: "https://github.com/openclaw/openclaw/issues/90316",
      author: "reporter",
      createdAt: "2026-06-02T12:00:00Z",
      updatedAt: "2026-06-03T12:00:00Z",
      labels: ["P2", "clawsweeper:queueable-fix"],
      queueId: "maintainer-p2",
      signals: openClawIssueSignals(
        ["P2", "clawsweeper:queueable-fix"],
        "2026-06-02T12:00:00Z",
        now,
      ),
    },
    { claimCommentStatus: "bridge-managed" },
  );
  assert.match(bridgeManagedPrompt, /Do not post a duplicate claim comment/);
});

test("Discord handoff stays short and includes Codex review", () => {
  const text = buildOpenClawDiscordHandoff({
    prUrl: "https://github.com/openclaw/openclaw/pull/123",
    issueUrl: "https://github.com/openclaw/openclaw/issues/99",
    title: "#123 Fix queue guard",
    summary: "Queue guard now respects linked PR labels.",
    proof: "pnpm test and Codex review passed.",
    ci: "CI green",
    clawsweeper: "ready for maintainer look",
  });

  assert.match(text, /Maintainer review requested/);
  assert.match(text, /codex review/i);
  assert.equal(text.split("\n").length <= 6, true);
});

test("preferences normalize repo, limits, role, and login", () => {
  const normalized = normalizeOpenClawPreferences(
    {
      roleMode: "trial_maintainer",
      targetRepo: "https://github.com/BrokeMac79/openclaw.git",
      githubLogin: " brokemac79 ",
      activeOpenPrLimit: 99,
      maxParallelWorkers: 0,
      minimumIssueAgeHours: Number.NaN,
      codexReasoningEffort: "xhigh",
      weeklyRemainingBaseline: 97,
    },
    basePreferences(),
  );

  assert.equal(normalized.targetRepo, "brokemac79/openclaw");
  assert.equal(normalized.githubLogin, "brokemac79");
  assert.equal(normalized.activeOpenPrLimit, 20);
  assert.equal(normalized.maxParallelWorkers, 1);
  assert.equal(normalized.minimumIssueAgeHours, 6);
  assert.equal(normalized.codexReasoningEffort, "xhigh");
  assert.equal(normalized.weeklyRemainingBaseline, 97);

  const testMode = normalizeOpenClawPreferences(
    { minimumIssueAgeHours: 0, codexReasoningEffort: "turbo" as any },
    basePreferences(),
  );
  assert.equal(testMode.minimumIssueAgeHours, 0);
  assert.equal(testMode.codexReasoningEffort, "high");

  assert.equal(normalizeGitHubLogin(" BrokeMac79 "), "brokemac79");
  assert.equal(normalizeGitHubLogin("octocat repo:other/private"), "");
  const injectedLogin = normalizeOpenClawPreferences(
    { githubLogin: "octocat repo:other/private" },
    basePreferences(),
  );
  assert.equal(injectedLogin.githubLogin, "brokemac79");
});

test("partial preferences preserve existing usage budget fields", () => {
  const fallback = basePreferences({
    weeklyRemainingBaseline: 97,
    weeklyRemainingCurrent: 92,
    usageWindowStartedAt: now - 60 * 60 * 1000,
  });
  const unrelated = normalizeOpenClawPreferences({ minimumIssueAgeHours: 0 }, fallback);

  assert.equal(unrelated.minimumIssueAgeHours, 0);
  assert.equal(unrelated.weeklyRemainingBaseline, 97);
  assert.equal(unrelated.weeklyRemainingCurrent, 92);
  assert.equal(unrelated.usageWindowStartedAt, fallback.usageWindowStartedAt);

  const cleared = normalizeOpenClawPreferences(
    {
      weeklyRemainingBaseline: null,
      weeklyRemainingCurrent: null,
      usageWindowStartedAt: null,
    },
    fallback,
  );
  assert.equal(cleared.weeklyRemainingBaseline, null);
  assert.equal(cleared.weeklyRemainingCurrent, null);
  assert.equal(cleared.usageWindowStartedAt, null);
});

function basePreferences(
  overrides: Partial<OpenClawWorkflowPreferences> = {},
): OpenClawWorkflowPreferences {
  return {
    subject: "github:1",
    roleMode: "trial_maintainer",
    targetRepo: "openclaw/openclaw",
    githubLogin: "brokemac79",
    activeOpenPrLimit: 10,
    hardOpenPrCap: 20,
    dailyUsageDropLimit: 5,
    maxParallelWorkers: 2,
    minimumIssueAgeHours: 6,
    codexReasoningEffort: "high",
    weeklyRemainingBaseline: null,
    weeklyRemainingCurrent: null,
    usageWindowStartedAt: now,
    updatedAt: now,
    ...overrides,
  };
}
