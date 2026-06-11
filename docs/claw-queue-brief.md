---
title: Claw Queue Brief
layout: default
permalink: /claw-queue/brief/
description: "A human-readable one-page summary of the Claw Queue workflow."
---

# Claw Queue: One-Page Summary

Claw Queue is an OpenClaw-focused workflow layer inside Crabfleet. Its goal is to help contributors and trial maintainers turn good GitHub issues into good PRs without losing track of the process, the proof, or the work already in progress.

It does not replace GitHub, ClawSweeper, maintainers, or the existing contribution rules. It sits on top of them and makes the path from "this issue looks queueable" to "this PR is ready for maintainer review" clearer and harder to get wrong.

## The Problem

OpenClaw already has useful issue queues, labels, ClawSweeper comments, CI checks, Mantis proof when available, and contribution guidance. The problem is that a contributor still has to join those pieces together manually.

That becomes especially messy when someone is juggling more than one Codex session or local terminal. It is easy to pick an issue that already has a PR, miss a higher-priority queue, forget to wait for ClawSweeper, open a PR without enough proof, lose track of CI, or ask maintainers to review something that is not actually ready.

## What Claw Queue Does

Claw Queue turns that scattered process into one operating surface.

It can:

- show ClawSweeper-screened queueable issues in priority order,
- prefer issues with no linked/open PR and warn when recent open PRs appear to reference the same issue,
- load a specific issue by URL or number when the user already knows what they want to inspect,
- support contributor, trial-maintainer, and maintainer modes,
- apply personal limits such as open PR count, worker count, usage budget, and minimum issue age,
- choose a default Codex thinking mode, choose a proof route, and override both per issue before launch,
- pass Tokenjuice output-compaction guidance to started workers and copy/paste prompts,
- use Crabbox or Blacksmith Testbox for remote/cross-version validation when local proof is not enough,
- generate a complete Codex-ready prompt for a selected issue,
- open issue and PR context in a side GitHub blade while keeping the queue visible,
- post or reuse a marker-backed issue claim comment before starting or tracking safe work,
- connect to a local Codex bridge to start or track work,
- track active work across Codex, tmux, local shells, or manual copy/paste,
- show a short inline activity tail for bridge-managed Codex runs,
- show a Master Loop swimlane view across ready issues, validation, coding, PR readiness, maintainer handoff, handoff sent, and completed work,
- monitor authored PRs for CI, ClawSweeper readiness, proof labels, and Mantis visibility,
- produce a short Discord-ready maintainer handoff when a PR is ready.

The important shift is that the page is not only an issue picker. It tries to carry the work through the whole contribution loop.

For data discovery, Claw Queue follows the same pattern used elsewhere in the OpenClaw ecosystem: archive/cache first for broad issue and PR discovery, live GitHub only for final verification and mutations. The Worker still asks live GitHub for final state, but when the local Codex bridge is connected the page also reads a Gitcrawl workflow snapshot for broad queue rows, possible PR coverage, and authored open PR rows. The local snapshot is not final authority for bypassing live open-PR limits. The next production-grade step is a central Gitcrawl-backed snapshot source so hosted Crabfleet can do the same without relying on each user's local store.

## How The Workflow Feels

The user starts in Command Center. If new work is allowed, it shows the next safest issue to pick. If work is already active, it helps resume or close out that plate instead. If limits, GitHub errors, usage budget, or worker capacity block new work, it says so directly.

Master Loop is the controller view at `/app/claw-loop`. It reads the same queue, active-work, PR, CI, proof, and ClawSweeper state and classifies every visible item into full-width swimlanes. In the current safe phase it observes, explains, and recommends the next action. Later phases can auto-move rows, generate handoffs, and start Codex workers within user limits.

Queue candidates can be rejected locally from either Claw Queue rows or Loop swimlane candidate cards. This is a personal hide list with a reason and restore action, not a GitHub mutation. It is meant for cases where a trial maintainer manually confirms an item is not suitable, already has a linked PR, needs a decision, or otherwise should not keep appearing as available work.

When a user starts or tracks an issue, Claw Queue uses the local bridge and the user's `gh` auth to post or find the "working on this" claim comment when the issue is safe to claim. If possible PR coverage is still unknown, Track records the investigation without pretending the issue is claimed. Each active row records the selected thinking mode, proof mode, and claim state, can be resumed, linked to a PR, marked ready, parked, or archived. For Start Codex runs, the local bridge creates a separate git worktree and branch per issue, then exposes that path in Active Work. Worker Runway shows how many local plates are open based on the user's worker count, so running two or three parallel Codex jobs becomes isolated and visible rather than remembered in someone's head.

For users who cannot or do not want to start Codex directly from the page, Claw Queue still provides a copy/paste prompt. That prompt tells Codex to use Tokenjuice for noisy terminal output when available, re-check the issue and any possible PR coverage, read the current OpenClaw guidance, follow ClawSweeper, keep the fix focused, run tests, use Codex review, monitor CI, and stop only when the PR is genuinely ready for maintainer look.

The prompt also carries maintainer-handbook guardrails. Release-sensitive work needs release-branch awareness, plugin install/update/SDK/package work needs maintainer discussion and broader contract validation, security-adjacent work should be escalated without public vulnerability metadata, and issues owned by another OpenClaw repo should be routed instead of patched in the wrong place. For a trial maintainer, the target outcome is evidence and a handoff, not merge authority.

## What Counts As Done

In this workflow, "done" does not mean "a PR exists."

Done means:

- the issue is linked,
- the fix is focused,
- proof or tests are included,
- Codex review has been run,
- CI is green or failures are clearly explained,
- ClawSweeper/status labels indicate readiness,
- the maintainer handoff is short enough to post directly in Discord.

If proof is not good enough and Mantis is unavailable or broken, the correct outcome is to park the work with a clear blocker note rather than push a weak PR.

## Why It Matters

For contributors, Claw Queue should make OpenClaw work less intimidating and less ambiguous.

For trial maintainers, it provides a responsible way to help with high-priority issues without needing merge permissions.

For maintainers, it should reduce duplicate, incomplete, or low-proof PRs and make review requests easier to act on.

For Codex users, it gives the agent a process-aware work order instead of a bare issue link.

The bigger aim is to make OpenClaw contribution work feel less chaotic: pick the right issue, start it with the right instructions, track the active plates, prove the fix, watch the PR, and hand it to maintainers only when it is ready.

## Current Shape

This is currently built as an OpenClaw-specific Crabfleet feature. It can be tested safely against a fork with dummy issues and PRs, and the local Codex bridge supports dry-run mode so the workflow can be demonstrated without launching real work.

The next useful proof is to test it hard against forked OpenClaw issues and PRs, then decide whether it should remain a Crabfleet feature, be proposed upstream, or become a more general contributor workflow surface.
