# Changelog

## Unreleased

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
