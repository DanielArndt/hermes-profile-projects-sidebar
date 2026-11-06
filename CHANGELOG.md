# Changelog

## Unreleased

- Keep the animated session-row glow active while sub-agents or background terminal jobs are running after the parent turn ends.
- Show background work with a filled yellow status dot, preserving the host's status classes and attention-state priority.
- Apply the hollow done-session dot only while the session is no longer live.
- Add Node regression tests for status detection, glow eligibility, palette overrides, and done-marker precedence. Verified all four tests, ESM syntax, desktop admission lint, and computed dot colors in Chromium.
