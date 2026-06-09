---
title: Claw Queue
layout: default
permalink: /claw-queue/
description: "Use Claw Queue to pick OpenClaw issues, hand them to Codex, track parallel work, and prepare maintainer handoffs."
---

# Claw Queue

Claw Queue is the OpenClaw contribution cockpit in Crabfleet. It turns the OpenClaw issue queues into a guided workflow for contributors, trial maintainers, and maintainers: pick eligible issues, hand work to Codex, track multiple plates, and copy a short maintainer handoff when the PR is ready.

It does not merge PRs, land code, enable automerge, or replace maintainer judgement. Trial maintainers should use it to prepare ready-for-review PRs and Discord handoffs.

Claw Queue also applies the maintainer-handbook rules that matter before a contributor or trial maintainer starts work: release-sensitive fixes need release-branch awareness, plugin install/update/SDK/package changes need maintainer discussion before final shape, and security-adjacent work should be escalated rather than handled as an ordinary public PR.

## Before You Begin

You need:

- Access to the Crabfleet app at `/app/claw-queue`; the full-width loop view is at `/app/claw-loop`.
- GitHub access to the target OpenClaw repo.
- A GitHub login entered in Claw Queue when PR monitoring should count your open PRs.
- A local OpenClaw checkout when you want the local Codex bridge to start real work.
- Codex installed on the machine running the bridge.
- Tokenjuice installed when you want Codex workers to compact noisy terminal output. The recommended setup is `npm install -g tokenjuice`, `tokenjuice install codex`, then `tokenjuice doctor hooks`.

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
7. Set **Thinking** to the default Codex reasoning effort for copied prompts and local starts. The default is `High`; individual issue rows can override it before launch.
8. Set **Usage limit** and weekly usage fields when you want Claw Queue to pause new work after a configured daily drop.
9. Connect the local Codex bridge.
10. Use **Command Center** first. It tells you the next safest action.
11. Open `/app/claw-loop` when you want the full-width Master Loop swimlane view.

## Connect the Local Codex Bridge

The local bridge is a loopback HTTP service that lets the browser page start or track local Codex work. It persists active-work rows and exposes run status back to the page.

Use the **Runner command** button in the app, or run:

```bash
pnpm openclaw:runner -- --workspace <path-to-openclaw> --worktree-dir <path-to-openclaw-worktrees> --port 4545 --max-active 2 --reasoning-effort high --token <secret-token>
```

`--workspace` should point at a clean base OpenClaw checkout. Each **Start Codex** run creates a separate git worktree under `--worktree-dir`, creates a unique `claw-queue/issue-...` branch, launches Codex inside that worktree, and records the worktree path in Active Work. This is what makes `--max-active 2` or `--max-active 3` safe for parallel fixes. The worktree is intentionally kept after Codex exits so you can inspect, resume, push, or repair the PR branch.

The bridge also injects a bounded local Codex skills packet into every started run. By default it scans `%USERPROFILE%\.codex\skills` and the common OpenClaw maintainer skills checkout at `%LOCALAPPDATA%\OpenClawMaintainer\repos\maintainers\.agents\skills`, then lists high-signal skills such as `openclaw-pre-pr-check`, `openclaw-pr-maintainer`, `openclaw-testing`, `clawsweeper`, `crabbox`, `gitcrawl`, `tokenjuice`, `pr-cluster`, `review-pr`, `gh-fix-ci`, `gh-address-comments`, `ghsa-opengrep-detector`, `openclaw-opengrep-remediation`, and `codex-review` with absolute `SKILL.md` paths. Override the primary directory with `--skills-dir <path>` or `OPENCLAW_CODEX_SKILLS_DIR`; override the maintainer skills directory with `--maintainer-skills-dir <path>`, `OPENCLAW_MAINTAINER_SKILLS_DIR`, or `OPENCLAW_MAINTAINERS_DIR`; pass `--no-skill-context` only when a run must avoid local skill hints.

The bridge also tells each started worker where the `tokenjuice` CLI resolves. Override that with `--tokenjuice-bin <path>` or `TOKENJUICE_BIN` if the command is not on `PATH`. Tokenjuice is an output-compaction layer only; Claw Queue usage-limit gates still use the weekly usage remaining fields entered in the UI.

For a non-launching demo:

```bash
pnpm openclaw:runner -- --workspace <path-to-openclaw> --worktree-dir <path-to-openclaw-worktrees> --port 4545 --max-active 2 --reasoning-effort high --token <secret-token> --dry-run
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

- **Start**: post/fetch the issue claim comment through the local bridge, then send the generated issue prompt to local Codex. In dry-run mode this records the prompt without launching Codex.
- **Track**: add the issue to Active Work when you started it manually in Codex, tmux, or another app. When the row is safe to claim, Claw Queue posts or reuses the marker-backed claim first; when possible PR coverage is unknown or needs investigation, Track records the investigation without pretending the issue is claimed.
- **Prompt**: copy the full Codex-ready prompt.
- **Blade**: open the issue or PR in a right-side GitHub blade without leaving the workflow page. The blade includes copy/open actions because GitHub can block embedded previews.
- **Card**: create a Crabfleet board card for the issue.
- **Resume**: copy a prompt to resume an active plate.
- **Handoff**: copy a short maintainer-review message for Discord or PR comments.

If a candidate has possible open PR coverage, **Start** is blocked until you inspect the listed PRs. **Prompt** still works so you can ask Codex to do that preflight, and **Track** still works when you already started an external/manual investigation.

## Specific Issue Intake

Use **Specific Issue** when you already know the issue you want but it is not visible in the queue. Paste a GitHub issue URL, `#number`, or number, then click **Load issue**.

The loaded row uses the same checks and actions as queue rows:

- live title, author, labels, and ClawSweeper readiness,
- minimum issue age gate,
- possible open PR coverage warning,
- per-issue **Thinking** and **Proof** controls,
- **Copy prompt**, **Track**, **Start Codex**, and **New card** actions.

For a plain number or `#number`, Claw Queue uses the configured **Repo**. For a full GitHub URL, it uses the repo from the URL.

## How Issues Are Selected

Claw Queue uses the OpenClaw queue rules from the "Contributor / Maintainer Start Here" issue, then filters for issues that are:

- open,
- not linked to a PR,
- marked queueable by ClawSweeper,
- outside the configured minimum issue age,
- not already tracked in Active Work,
- not flagged with possible open PR coverage.

Trial maintainer ordering is:

1. `P0` queueable issues.
2. `P1` queueable issues.
3. `P2` queueable issues.
4. Contributor-safe queueable issues with clear fix shape or source reproduction.

If the same issue appears in multiple queue views, Claw Queue keeps the best priority identity for Worker Runway and Command Center.

## Maintainer-Handbook Guardrails

Claw Queue is role-aware. For a trial maintainer, the expected output is a focused PR, proof, Codex review, and a short maintainer handoff. The tool should not ask a trial maintainer to merge, land, close, approve, enable automerge, mutate release branches, or make GHSA state changes.

The generated prompt asks Codex to stop or park before ordinary coding when the issue crosses a maintainer boundary:

- release-sensitive fixes: validate or reason about `main` and the relevant `release/*` branch, then include a release-pick note instead of assuming the trial maintainer can pick it;
- plugin install, uninstall, update, packaging, SDK, or package upgrade behavior: require maintainer-channel discussion before the final shape and broaden validation to plugin contract surfaces such as plugin-inspector, kitchen-sink, or crabpot when relevant;
- security-adjacent work: auth, sandbox, command execution, file access, token, updater, provider, GHSA, CVE, advisory, or hardening issues should avoid public vulnerability metadata and be escalated instead of handled as a normal public PR;
- repo ownership: if the surface belongs in ClawHub, skills, plugin-inspector, kitchen-sink, crabpot, crabbox, gitcrawl, ClawSweeper, maintainers, or another OpenClaw repo, route or park it rather than patching the wrong repo;
- validation breadth: narrow changes can use scoped tests, but shared runtime, plugin contracts, release paths, security paths, package management, onboarding, and cross-platform behavior need broader proof, often Crabbox or Blacksmith Testbox.

## Data Sources And Rate Limits

The wider OpenClaw ecosystem generally follows an archive-first pattern for broad discovery:

- use Gitcrawl or refreshed Gitcrawl-store data for issue/PR discovery, clustering, and report generation,
- keep that archive fresh outside the interactive request path,
- use live GitHub only for final truth before comments, labels, PR creation, review, merge, or other mutations,
- fall back to live GitHub search only when the archive is missing, stale, or cannot express the query.

Claw Queue now follows the same direction in the parts it can control:

- the Worker still fetches live GitHub data for final safety state: issue lookups, authored PRs, labels, CI/check-runs, and handoff readiness,
- the Worker uses GitHub Search caching and lower-pressure REST fallbacks when Search is rate-limited,
- when the local Codex bridge is connected, the browser also asks the bridge for one Gitcrawl workflow snapshot,
- that local snapshot can replace broad issue queue rows, clear broad PR-coverage uncertainty, and fill authored open PR rows when live authored-PR lookup is unavailable,
- live PR monitor rows are kept when they succeed, especially for CI state; local Gitcrawl only fills gaps such as missing rows or `unknown` cached checks,
- PR limits remain conservative when live lookup fails. A local Gitcrawl count can keep the page informative, but it is not treated as final authority to bypass a live open-PR limit failure.

The local Gitcrawl workflow snapshot reads open issues, labels, open authored PRs, PR title/body excerpts, and any cached check rows from the user's Gitcrawl store. It is a practical rate-limit safety net, not final proof. Live GitHub checks should still run before starting work, opening/updating PRs, or generating final maintainer handoffs. Claim comments are live GitHub mutations and deliberately go through the local bridge's `gh` CLI instead of a background Codex tool call.

Use the big page **Refresh** button when you want the normal hybrid load with the local Gitcrawl snapshot applied. Use the small refresh button on a queue or PR row when you want a live GitHub API refresh for that slice without the local Gitcrawl overlay; this is useful when you suspect the local snapshot is stale or a PR has just gone green.

The intended production version should add a central Gitcrawl-backed snapshot source rather than asking every browser load to hit GitHub Search or every user to maintain a local store. A scheduled OpenClaw service can read Gitcrawl-store, write queue and open-PR snapshots into Crabfleet storage, and let the Worker use those snapshots for broad discovery.

## Worker Runway

Worker Runway maps your configured worker count to lanes:

- Filled lanes are issues already in Active Work.
- Open lanes show the next eligible issue.
- Suggestions skip issues already being worked locally.
- Lane order follows priority and ClawSweeper signals.

Use **Copy lane plan** when you want a compact summary of all active and suggested work.

Changing **Workers** changes how many lanes are shown after you save preferences; the page reloads workflow data after the save. It does not automatically start new issues; it only makes room for more suggested or tracked plates.

Command Center, Worker Runway, Specific Issue, and each suggested issue row have a **Thinking** dropdown. It defaults to the saved Claw Queue setting and controls the generated prompt, Track row, and Start Codex request for that issue action. Start Codex passes the value to the local bridge as `codexReasoningEffort`, and the bridge launches Codex with `model_reasoning_effort="<value>"`.

They also have a **Proof** dropdown:

- `Auto proof`: Codex chooses the cheapest credible proof path after intake.
- `Local proof`: prefer local reproduction, focused regression tests, or command-line proof.
- `Crabbox proof`: require live or remote validation before the row is ready, including reported branch/version, latest release, and current main when relevant.
- `Blacksmith Testbox`: use Blacksmith Testbox through Crabbox for remote validation and before/after proof when available.
- `Mantis if available`: ask for or use Mantis when it adds real evidence, then park if proof is still insufficient.

The selected proof mode is copied into the prompt and stored on Active Work rows.

## Master Loop And Swimlanes

Master Loop is the read-only controller for the whole Claw Queue surface. It lives on `/app/claw-loop` so the swimlanes can use the full screen width instead of competing with the queue controls. It observes queues, local Codex runs, authored PRs, usage/open-PR limits, bridge status, proof state, CI, and ClawSweeper readiness. It does not merge, close, approve, or mutate GitHub. Its first job is to show the current state machine and the next safest action.

The swimlanes are inferred automatically:

- **Ready to start**: eligible queue items with no known PR coverage.
- **Validating**: items that need PR coverage checks, repro checks, latest release/current main validation, reported-branch validation, Crabbox proof, Blacksmith Testbox proof, or a human blocker decision.
- **Coding**: Codex, tmux, or manual plates before a linked PR is ready.
- **PR not ready**: authored/open PRs or linked rows that still need proof, CI, Codex review, or ClawSweeper readiness.
- **Ready handoff**: PRs/rows that appear ready for maintainer-look Discord text.
- **Handoff sent**: rows where the Discord handoff has been posted and the next step is maintainer feedback, merge, or follow-up.
- **Merged / closed**: completed rows to archive after the short lookback.

Use **Copy loop brief** when you want a concise status dump. The intended later phases are: auto-move rows, auto-generate handoffs, then optionally auto-start Codex workers within user limits. The default behavior remains observe/recommend first.

Each swimlane tile has **Blade** and **Open** actions. **Blade** keeps the issue or PR in-context beside the swimlanes; **Open** launches the GitHub page directly in a browser tab.

## Active Work

Active Work is the local truth for what Codex or external sessions are working on.

Rows can come from:

- **Start**: created by the local Codex bridge.
- **Track**: manually tracked work from copy/paste, tmux, another Codex app, or another local workflow.
- persisted bridge state after reload.

Rows show the Codex thinking mode, proof route, and claim state that were used when the row was started or tracked, for example `thinking high`, `thinking xhigh`, `proof crabbox`, or `claimed`.

Started bridge runs also show a short inline activity tail. This is the latest few sanitized status/log lines from the local runner so you can see what an agent is doing without opening the full log viewer. Use **Watch log** when you need the larger bounded log tail.

The closeout radar shows how many active rows still need:

- PR link,
- proof/tests,
- Codex review,
- CI/ClawSweeper state,
- ready handoff.

Use row actions:

- **Resume**: copy the resume prompt for that plate.
- **Blade**: open the linked PR when present, otherwise the issue, in the side GitHub blade.
- **Handoff**: copy the maintainer handoff.
- **Link PR**: attach the GitHub PR URL.
- **Watch log**: open a live local Codex log viewer. Running rows poll automatically; completed rows show a snapshot.
- **Ready**: mark a row ready for maintainer look once proof, PR, CI, Codex review, and ClawSweeper status are acceptable.
- **Handoff sent**: move a ready row into the waiting-for-maintainer lane after posting the Discord message.
- **Park**: stop when proof is insufficient, Mantis is unavailable, or a maintainer/reporter/security/product decision is needed.
- **Archive**: remove completed, stale, failed, or dry-run rows from the visible active list.

The log viewer reads the bridge's local JSONL run log and shows a bounded tail, not the full file. It is meant for quick situational awareness while multiple Codex sessions are running. The underlying log path stays local and can be copied when deeper debugging is needed.

## PR Monitor And Handoffs

PR Monitor looks for authored open PRs for the configured GitHub login. It summarizes:

- CI state,
- failing or pending checks,
- Mantis check visibility when present,
- ClawSweeper readiness labels,
- proof status labels.

Use **Handoff** to generate a short Discord-ready message. It is available even when the row is not fully ready; in that case the copied text includes the current caveat, such as failing CI, pending CI, missing proof, or waiting-on-author state. A good handoff includes:

Use **Blade** on a PR row when you need to inspect the GitHub page without losing your queue context. If GitHub refuses the embedded preview, use the blade's **Open GitHub** action.

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

1. Use the selected `model_reasoning_effort`.
2. Use the selected proof mode.
3. Use Tokenjuice for noisy terminal output when available, with `tokenjuice wrap --raw -- <command>` as the raw-output escape hatch.
4. Re-check the issue before coding.
5. Confirm it is still open, queueable, and not already covered by a linked/open or possible open fix PR.
6. Read the latest local `AGENTS.md`, `CONTRIBUTING.md`, and pull request template.
7. Apply the maintainer-handbook release, plugin, security, repo-ownership, and validation gates.
8. Follow ClawSweeper's assessment and suggested route.
9. Avoid duplicate claim comments when Claw Queue has already posted or found the issue claim.
10. Keep the fix focused.
11. Run relevant tests and collect proof, including Crabbox, Blacksmith Testbox, or Mantis when they add necessary evidence.
12. Run Codex review before opening or updating the PR.
13. Monitor CI and ClawSweeper after PR updates.
14. Stop only when the PR is ready for maintainer look, or park with a blocker note.

## Usage And PR Limits

Claw Queue pauses new work when:

- authored open PR count reaches the configured personal limit,
- authored open PR count reaches the hard cap,
- weekly usage remaining drops by at least the configured daily percentage limit inside the active 24-hour window,
- GitHub PR lookup fails, because the page cannot safely know whether the PR limit was reached.

When GitHub rate limits the page, existing local Active Work is still useful. If the local Codex bridge is connected and Gitcrawl is installed with a fresh OpenClaw store, Claw Queue can still load broad queue rows, possible open PR coverage, and authored open PR rows from the local snapshot. If live PR-limit lookup fails, new work should stay paused until the lookup can be refreshed; the local snapshot is useful context, not final authority for bypassing that safety gate.

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
GET /runs/:id/log
PATCH /runs/:id
POST /claim
POST /start
POST /track
POST /gitcrawl/coverage
POST /gitcrawl/workflow
```

Requests require:

```text
Authorization: Bearer <runner-token>
```

The Worker-backed Claw Queue page uses:

```text
GET /api/openclaw/workflow
GET /api/openclaw/issue
PUT /api/openclaw/preferences
POST /api/openclaw/handoff
```

These endpoints are same-origin app endpoints and require the normal Crabfleet session.

## Troubleshooting

### GitHub rate limit reached

Refresh after a short wait. Claw Queue will try lower-pressure REST fallbacks when GitHub Search is limited. If PR lookup still fails or the fallback is only partial, Claw Queue pauses new work because it cannot prove you are under the open PR limit.

If the local Codex bridge is connected, refresh after Gitcrawl has synced. The queue should show a local Gitcrawl snapshot banner and broad queue/coverage data should come from the snapshot instead of the PR-coverage rate-limit warning.

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
