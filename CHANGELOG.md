# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `coalesce_ms` now defaults to 500 (previously 0/off): wake lines arriving
  within a 500ms window merge into one notification by default — one batch
  counts as a single event against `max_events` and the token bucket.
  Explicit `coalesce_ms: 0` still opts out.
- README (en/zh) now carries an explicit Windows warning: the plugin is
  developed and tested on Linux/macOS only, and external-program stdout
  capture is broken on Windows (`lines_scanned` stays 0 in all wake modes),
  degrading monitors to run/exit sentinels with false idle arbitrations.
  Windows is unvalidated — use with caution until a fix lands.

## [0.1.0] - 2026-09-22

Initial public release.

### Added

- `monitor` tool: run a background command whose output wakes the agent line by line.
  Regex wake filtering (`pattern` / `wake_mode`), token-bucket throttling
  (burst 5 + 1/s), `coalesce_ms` burst merging, auto-stop rules
  (`max_events`, `idle_timeout_ms`, command exit), and per-session concurrency cap (16).
- `monitor_stop` tool: SIGTERM to the process group, escalating to SIGKILL.
- `monitor_list` tool: running and finished monitors with state, counters, and exit info.
- TUI sidebar panel showing live per-session monitor states, two-level workspace
  summaries, and plugin liveness indication (`src/tui.ts`).
- File-based state bridge between the server and TUI plugin runtimes
  (`~/.local/share/opencode/monitor-task/`).
- Unit test suite (108 tests) and scenario simulation scripts under `test/`.
- Publish hygiene: `prepublishOnly` gate (typecheck + tests + pack dry-run),
  `CHANGELOG.md` shipped in the npm package, and context-shape probes behind
  `OPENCODE_MONITOR_TASK_DEBUG` (off by default).

[Unreleased]: https://github.com/mingdedi/opencode-monitor-task/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mingdedi/opencode-monitor-task/releases/tag/v0.1.0
