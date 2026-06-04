---
title: Claw Queue
layout: default
permalink: /claw-queue/
description: "Use Claw Queue to pick OpenClaw issues, hand them to Codex, track parallel work, and prepare maintainer handoffs."
---

# Claw Queue

Claw Queue is the OpenClaw contribution cockpit in Crabfleet. It turns the OpenClaw issue queues into a guided workflow for contributors, trial maintainers, and maintainers: pick eligible issues, hand work to Codex, track multiple plates, and copy a short maintainer handoff when the PR is ready.

It does not merge PRs, land code, enable automerge, or replace maintainer judgement. Trial maintainers should use it to prepare ready-for-review PRs and Discord handoffs.

## Before You Begin

You need:

- Access to the Crabfleet app at `/app/claw-queue`.
- GitHub access to the target OpenClaw repo.
- A GitHub login entered in Claw Queue when PR monitoring should count your open PRs.
- A local OpenClaw checkout when you want the local Codex bridge to start real work.
- Codex installed on the machine running the bridge.

For dummy testing, use a fork such as `brokemac79/openclaw`, set **Min issue age** to `0`, and create test issues/PRs there. Do not use upstream OpenClaw issues or PRs for dry-run product testing.

## Quickstart

1. Open `/app/claw-queue`.
2. Sign in or apply a preview identity in local development.
3. Set **Repo** to the target repo, normally `openclaw/openclaw` or your fork.
4. Set **GitHub login** to the author login used for open PR monitoring.
5. Set **Role**:
   - `Contributor`: contributor-safe queue views.
   - `Trial maintainer`: priority queues plus maintainer handoff guardrails.
   - `Maintainer`: maintainer queue views for users with full permissions.
6. Set **Workers** to the number of local Codex plates you want to juggle.
7. Set **Usage limit** and weekly usage fields when you want Claw Queue to pause new work after a configured daily drop.
8. Connect the local Codex bridge.
9. Use **Command Center** first. It tells you the next safest action.

## Connect the Local Codex Bridge

The local bridge is a loopback HTTP service that lets the browser page start or track local Codex work. It persists active-work rows and exposes run status back to the page.

Use the **Runner command** button in the app, or run:

```bash
pnpm openclaw:runner -- --workspace <path-to-openclaw> --port 4545 --max-active 2 --token <secret-token>
```

For a non-launching demo:

```bash
pnpm openclaw:runner -- --workspace <path-to-openclaw> --port 4545 --max-active 2 --token <secret-token> --dry-run
```

Paste the runner URL and token into **Codex Handoff**, then click **Test**.

Use a strong token. Keep the bridge bound to `127.0.0.1` or another loopback host. The page intentionally rejects non-local runner URLs.

## What the Top Command Center Means

Command Center is the place to start. It chooses one of three states:

- **Next eligible issue**: no active plate exists, so it shows the highest-priority queueable issue.
- **Resume or handoff**: a plate exists, so it tells you what to do with the most important active row.
- **Paused or blocked**: GitHub, usage, open PR limits, or bridge state prevent new work.

The gates show:

| Gate   | Meaning                                                                            |
| ------ | ---------------------------------------------------------------------------------- |
| GitHub | Queue and PR lookups are loaded, partial, or blocked by GitHub errors/rate limits. |
| Limits | New work is allowed or paused by open PR count or usage drop.                      |
| Bridge | Local Codex bridge state: connected, dry-run, unknown, or error.                   |
| Lanes  | Filled worker lanes against your configured worker count.                          |
| Next   | The next eligible issue held by the queue planner.                                 |

Primary actions:

- **Start**: send the generated issue prompt to the local Codex bridge. In dry-run mode this records the prompt without launching Codex.
- **Track**: add the issue to Active Work when you started it manually in Codex, tmux, or another app.
- **Prompt**: copy the full Codex-ready prompt.
- **Card**: create a Crabfleet board card for the issue.
- **Resume**: copy a prompt to resume an active plate.
- **Handoff**: copy a short maintainer-review message for Discord or PR comments.

## How Issues Are Selected

Claw Queue uses the OpenClaw queue rules from the "Contributor / Maintainer Start Here" issue, then filters for issues that are:

- open,
- not linked to a PR,
- marked queueable by ClawSweeper,
- outside the configured minimum issue age,
- not already tracked in Active Work.

Trial maintainer ordering is:

1. `P0` queueable issues.
2. `P1` queueable issues.
3. `P2` queueable issues.
4. Contributor-safe queueable issues with clear fix shape or source reproduction.

If the same issue appears in multiple queue views, Claw Queue keeps the best priority identity for Worker Runway and Command Center.

## Data Sources And Rate Limits

The wider OpenClaw ecosystem generally follows an archive-first pattern for broad discovery:

- use Gitcrawl or refreshed Gitcrawl-store data for issue/PR discovery, clustering, and report generation,
- keep that archive fresh outside the interactive request path,
- use live GitHub only for final truth before comments, labels, PR creation, review, merge, or other mutations,
- fall back to live GitHub search only when the archive is missing, stale, or cannot express the query.

Claw Queue now follows the same direction in the parts it can control from a Worker:

- issue queues try GitHub Search first, then fall back to normal repo issue listing plus label, blocker, and age filtering when Search is rate-limited,
- authored PR monitoring tries GitHub Search first, then falls back to repo PR listing and issue-label reads,
- PR limits stay fail-closed when the fallback cannot prove it scanned the complete open PR list,
- queue fallback results are shown with a warning so users know the page is in a degraded data-source mode.

The intended production version should add a Gitcrawl-backed snapshot source rather than asking every browser load to hit GitHub Search. A central OpenClaw service or scheduled sync can read Gitcrawl-store, write queue and open-PR snapshots into Crabfleet storage, and let the Worker use those snapshots for broad discovery. Live GitHub checks should still run before starting work, claiming, opening/updating PRs, or generating final maintainer handoffs.

## Worker Runway

Worker Runway maps your configured worker count to lanes:

- Filled lanes are issues already in Active Work.
- Open lanes show the next eligible issue.
- Suggestions skip issues already being worked locally.
- Lane order follows priority and ClawSweeper signals.

Use **Copy lane plan** when you want a compact summary of all active and suggested work.

Changing **Workers** changes how many lanes are shown after you save preferences and reload workflow data. It does not automatically start new issues; it only makes room for more suggested or tracked plates.

## Active Work

Active Work is the local truth for what Codex or external sessions are working on.

Rows can come from:

- **Start**: created by the local Codex bridge.
- **Track**: manually tracked work from copy/paste, tmux, another Codex app, or another local workflow.
- persisted bridge state after reload.

The closeout radar shows how many active rows still need:

- PR link,
- proof/tests,
- Codex review,
- CI/ClawSweeper state,
- ready handoff.

Use row actions:

- **Resume**: copy the resume prompt for that plate.
- **Handoff**: copy the maintainer handoff.
- **Link PR**: attach the GitHub PR URL.
- **Ready**: mark a row ready for maintainer look once proof, PR, CI, Codex review, and ClawSweeper status are acceptable.
- **Park**: stop when proof is insufficient, Mantis is unavailable, or a maintainer/reporter/security/product decision is needed.
- **Archive**: remove completed, stale, failed, or dry-run rows from the visible active list.

## PR Monitor And Handoffs

PR Monitor looks for authored open PRs for the configured GitHub login. It summarizes:

- CI state,
- failing or pending checks,
- Mantis check visibility when present,
- ClawSweeper readiness labels,
- proof status labels.

Use **Handoff** to generate a short Discord-ready message. A good handoff includes:

- PR link,
- issue link,
- one-line summary,
- proof/tests,
- Codex review result,
- CI state,
- ClawSweeper readiness.

Trial maintainers should copy this to Discord or the maintainer coordination channel. They should not merge, land, squash, or enable automerge.

## Generated Codex Prompt

Every issue prompt tells Codex to:

1. Re-check the issue before coding.
2. Confirm it is still open, queueable, and not already covered by a linked/open fix PR.
3. Read the latest local `AGENTS.md`, `CONTRIBUTING.md`, and pull request template.
4. Follow ClawSweeper's assessment and suggested route.
5. Comment that you are working on the issue when claiming is unavailable.
6. Keep the fix focused.
7. Run relevant tests and collect proof, including Mantis when available.
8. Run Codex review before opening or updating the PR.
9. Monitor CI and ClawSweeper after PR updates.
10. Stop only when the PR is ready for maintainer look, or park with a blocker note.

## Usage And PR Limits

Claw Queue pauses new work when:

- authored open PR count reaches the configured personal limit,
- authored open PR count reaches the hard cap,
- weekly usage remaining drops by at least the configured daily percentage limit inside the active 24-hour window,
- GitHub PR lookup fails, because the page cannot safely know whether the PR limit was reached.

When GitHub rate limits the page, existing local Active Work is still useful, but new work should stay paused until the lookup can be refreshed.

## Testing A Demo Safely

Recommended demo path:

1. Set **Repo** to a fork.
2. Set **Min issue age** to `0`.
3. Start the local bridge with `--dry-run`.
4. Connect the bridge in Claw Queue.
5. Click **Start** from Command Center.
6. Verify the dry-run row appears in Active Work.
7. Click **Resume**, **Handoff**, and **Copy work brief** to verify copy flows.
8. Archive dry-run rows before ending the demo.

Dry-run rows are stored by the bridge under the log directory printed at startup. The default location is inside the OS temp directory under `crabfleet-openclaw-codex-runs`.

## Local Bridge API

The page uses the local bridge at the configured runner URL:

```text
GET /health
GET /runs
GET /runs/:id
PATCH /runs/:id
POST /start
POST /track
```

Requests require:

```text
Authorization: Bearer <runner-token>
```

The Worker-backed Claw Queue page uses:

```text
GET /api/openclaw/workflow
PUT /api/openclaw/preferences
POST /api/openclaw/handoff
```

These endpoints are same-origin app endpoints and require the normal Crabfleet session.

## Troubleshooting

### GitHub rate limit reached

Refresh after a short wait. Claw Queue will try lower-pressure REST fallbacks when GitHub Search is limited. If PR lookup still fails or the fallback is only partial, Claw Queue pauses new work because it cannot prove you are under the open PR limit.

### Start is disabled

Check the Command Center gates. Common causes:

- local bridge is not connected,
- usage or PR limit is reached,
- issue is inside the configured age gate,
- issue is already in Active Work,
- GitHub lookup is partial or failed.

### Bridge says missing or invalid token

Copy the token printed by the runner command into the Token field and click **Test**. If the runner generated a token automatically, use that exact value.

### No eligible issues appear

Refresh the workflow. For fork testing, lower **Min issue age** to `0`. For real OpenClaw work, wait until ClawSweeper has marked issues with queueable labels.

### Active Work shows old dry-run rows

Use **Archive inactive** or archive individual rows. This only clears the local visible work list; it does not touch GitHub.

## See Also

- [One-page Claw Queue brief](/claw-queue/brief/)
- [Quickstart](/quickstart/)
- [Cards](/cards/)
- [Runs](/runs/)
- [API Reference](/api/)
