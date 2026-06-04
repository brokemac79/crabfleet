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
- prefer issues with no linked/open PR,
- support contributor, trial-maintainer, and maintainer modes,
- apply personal limits such as open PR count, worker count, usage budget, and minimum issue age,
- generate a complete Codex-ready prompt for a selected issue,
- connect to a local Codex bridge to start or track work,
- track active work across Codex, tmux, local shells, or manual copy/paste,
- monitor authored PRs for CI, ClawSweeper readiness, proof labels, and Mantis visibility,
- produce a short Discord-ready maintainer handoff when a PR is ready.

The important shift is that the page is not only an issue picker. It tries to carry the work through the whole contribution loop.

For data discovery, Claw Queue is moving toward the same pattern used elsewhere in the OpenClaw ecosystem: archive/cache first for broad issue and PR discovery, live GitHub only for final verification and mutations. The current app has GitHub Search caching and REST fallbacks for rate-limit cases; the next production-grade step is a Gitcrawl-backed snapshot source.

## How The Workflow Feels

The user starts in Command Center. If new work is allowed, it shows the next safest issue to pick. If work is already active, it helps resume or close out that plate instead. If limits, GitHub errors, usage budget, or worker capacity block new work, it says so directly.

When a user starts or tracks an issue, Claw Queue keeps it in Active Work. Each active row can be resumed, linked to a PR, marked ready, parked, or archived. Worker Runway shows how many local plates are open based on the user's worker count, so running two or three parallel Codex jobs becomes visible rather than remembered in someone's head.

For users who cannot or do not want to start Codex directly from the page, Claw Queue still provides a copy/paste prompt. That prompt tells Codex to re-check the issue, read the current OpenClaw guidance, follow ClawSweeper, keep the fix focused, run tests, use Codex review, monitor CI, and stop only when the PR is genuinely ready for maintainer look.

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
