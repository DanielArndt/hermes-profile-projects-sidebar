# Changelog

## Unreleased

- Add setting preference to configure collapsing finished sessions behind "Show x finished sessions" (`collapseFinishedSessions`, enabled by default). When disabled, finished chats remain inline with active chats in their normal list order.

- Add **4 hours** and **8 hours** choices to **Archive done chats after**. Sub-day thresholds are stored as fractional days, so existing settings are unchanged.

- Prevent in-flight Bot Chat activity polls from writing stale unread receipts after the plugin is disposed during hot reload. Add regression coverage for late successful and failed polls, preserving acknowledgements across subsequent reloads.

- Track canonical Bot Chat activity at plugin scope every 15 seconds and on focus/reconnect, independently of the Bots/Projects panes. Persist connection/profile/canonical-root activity and pending-unread receipts, then mark the current compression tip through the SDK unread store; seed existing history on first sight.
- Acknowledge focused Bot Chats, including reads between polls, without re-arming unread for unchanged activity. Preserve baselines through offline/malformed responses and tolerate unavailable storage. Dispose timers/listeners and discard stale connection responses.
- Validation: all 67 Node tests, ESM syntax, and Desktop admission lint pass. An isolated React/Chromium fixture verifies Bot Chat actionable-border transitions, selection/read clearing, and profile expansion in light and dark modes with zero page errors; running packaged Desktop UI was not inspected because it exposes no CDP port.
- Reserve glowing session borders for actionable chats: green for unread responses, red for pending input (command approval or clarification). Working, stalled, background, draft, and idle chats have no glow, including scheduled-run rows; preserve existing selection styling.
- Show compact rotating yellow ring spinners for working, quiet-but-running, and background states. Preserve the host status classes, respect reduced motion, and pause animations while the Desktop renderer is inactive.
- Share the host status-dot observer between regular and scheduled-run rows, and keep live-turn/done-marker logic independent from glow eligibility. Use fixed lead boxes on scheduled-run and Bot Chat rows to prevent labels shifting between spinner and dot states.
- Validation: all 47 Node tests, ESM syntax, and Desktop admission lint pass. An isolated real-React Chromium fixture verifies actionable border transitions, spinner geometry and rotation, and pause/reduced-motion behavior in light and dark modes with zero page errors. The running Desktop window was not inspected because its CDP port is closed.

- Add **Open In VS Code** to project `…` and right-click menus for projects with a folder. Launch through a short-lived Desktop terminal so it also works without an open chat, safely quotes folder paths, and reports launcher failures.

- Add opt-in **Auto-archive done chats** setting: a periodic sweep archives only sessions marked as done once they have been idle for a configurable number of days (1/3/7/14/30, default 3), measured from the later of last activity and the done marker.
- Skip pinned, running, scheduled-owned, currently focused, and canonical Bot Chat sessions; archive through the existing profile-scoped, mutation-fenced session PATCH so nothing is deleted.
- Record when each chat was marked done and whether the sweep already archived it, so restored chats are not re-archived until re-marked done, and re-marking re-arms the sweep.
- Add `tests/auto-archive-done.test.mjs` covering sweep eligibility, grace periods, lineage tips, multi-profile lookup, pagination, failure retry, and done-marker metadata.

- Add collapsible **Scheduled** (cron) bucket per profile, listing configured cron jobs with live schedules, next-run countdowns, active execution states, and quick-trigger actions (`zap`).
- Support expanding each scheduled job to peek recent run sessions with live glowing status, status dots, and one-click transcript navigation.
- Add real-time `cron.changed` event subscription to refresh scheduled tasks and runs dynamically without manual reloads.
- Add search filtering and settings preference toggle for the Scheduled bucket.
- Add setting preference to hide the Scheduled bucket in profiles that have zero scheduled tasks (`hideEmptyScheduled`).
- Add unit test suite (`tests/scheduled-cron.test.mjs`) covering job title derivation, running state detection, next-run countdown formatting, and execution timestamp rendering.

- Add a **Rename session…** action to each session's right-click menu, with a rename dialog and profile-scoped, mutation-fenced title updates.
- Keep quiet-but-running (`stalled`) sessions filled yellow and retain their animated row glow instead of treating silence as inactivity.
- Add regression coverage for the stalled glow and fill; verified all five Node tests, ESM syntax, and computed status-dot colors/masks in Chromium.

- Keep the animated session-row glow active while sub-agents or background terminal jobs are running after the parent turn ends.
- Show background work with a filled yellow status dot, preserving the host's status classes and attention-state priority.
- Apply the hollow done-session dot only while the session is no longer live.
- Add Node regression tests for status detection, glow eligibility, palette overrides, and done-marker precedence. Verified all four tests, ESM syntax, desktop admission lint, and computed dot colors in Chromium.
