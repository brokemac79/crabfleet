import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOpenClawDiscordHandoff,
  buildOpenClawIssueSearchQuery,
  evaluateOpenClawGovernor,
  normalizeOpenClawPreferences,
  openClawIssueSignals,
  openClawPrSignals,
  queuesForOpenClawRole,
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

test("governor pauses new work at personal PR and usage limits", () => {
  const preferences = basePreferences({
    activeOpenPrLimit: 10,
    hardOpenPrCap: 20,
    weeklyRemainingBaseline: 97,
    weeklyRemainingCurrent: 91,
    dailyUsageDropLimit: 5,
  });

  const governor = evaluateOpenClawGovernor(preferences, 10, now);

  assert.equal(governor.canStartNewWork, false);
  assert.equal(governor.usageDrop, 6);
  assert.match(governor.reasons.join(" "), /Personal open PR limit/);
  assert.match(governor.reasons.join(" "), /Usage budget/);
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
      weeklyRemainingBaseline: 97,
    },
    basePreferences(),
  );

  assert.equal(normalized.targetRepo, "brokemac79/openclaw");
  assert.equal(normalized.githubLogin, "brokemac79");
  assert.equal(normalized.activeOpenPrLimit, 20);
  assert.equal(normalized.maxParallelWorkers, 1);
  assert.equal(normalized.weeklyRemainingBaseline, 97);
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
    weeklyRemainingBaseline: null,
    weeklyRemainingCurrent: null,
    usageWindowStartedAt: now,
    updatedAt: now,
    ...overrides,
  };
}
