# Changelog

## Unreleased

- Keep quiet-but-running (`stalled`) sessions filled yellow and retain their animated row glow instead of treating silence as inactivity.
- Add regression coverage for the stalled glow and fill; verified all five Node tests, ESM syntax, and computed status-dot colors/masks in Chromium.

- Keep the animated session-row glow active while sub-agents or background terminal jobs are running after the parent turn ends.
- Show background work with a filled yellow status dot, preserving the host's status classes and attention-state priority.
- Apply the hollow done-session dot only while the session is no longer live.
- Add Node regression tests for status detection, glow eligibility, palette overrides, and done-marker precedence. Verified all four tests, ESM syntax, desktop admission lint, and computed dot colors in Chromium.
