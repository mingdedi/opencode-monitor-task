# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **TUI sidebar panel stopped loading on OpenCode ≥ 2.1.4** ("Cannot find package
  '@opentui/solid' imported from .../src/panel/view.ts" in
  `/tmp/opencode-monitor-tui.log`). The host resolves bare `@opentui/*` /
  `@opencode/*` specifiers only in the plugin entry file it scans; the panel's
  top-level `@opentui/solid/jsx-runtime` import lived in a file reached through
  the shim + dynamic-import chain, so it stopped resolving when the host's
  injection behavior tightened. The jsx-runtime pair is now imported by the
  entry file itself (root `tui.ts`, mirroring the single-file statusline
  plugin) and handed down to the panel via the new `defineTuiPlugin(host)`
  factory; `src/panel/view.ts` no longer imports any host package. Server
  side is unaffected (it never evaluates `tui.ts`, verified on v2.2.5).

## [0.2.0] - 2026-09-30

### Added

- **Detached mode** (`mode: "detached"`, Linux only, default `attached`): monitor
  commands that survive OpenCode service death/restart. The command runs in its
  own process group writing stdout+stderr to a per-task log file (no pipe to the
  service — service death cannot SIGPIPE it; host-exit guards deliberately skip
  it). Exit codes are recorded by an `EXIT`-trap wrapper. A restarted service
  scans the task store at plugin load and reattaches its workspace's tasks:
  counters resume from `meta.json`, missed lines arrive as ONE summary
  notification (never replayed), the idle clock is frozen while unattended and
  re-armed from zero on reattach. Pid reuse is defended via `/proc` `starttime`
  matching, and zombie wrappers (non-reaping PID 1) are detected via the
  `/proc` state letter; a task that died unattended is finalized from its exit file
  (`exit unknown` when the group was SIGKILLed) and its owning session is
  notified with the outcome; terminal records are swept after a 1h TTL (at
  every service start and every 10 minutes while any detached task is live). `monitor_stop`/`monitor_keepalive`/`monitor_update` operate
  on reattached monitors exactly as before; `monitor_list` now reports `mode`,
  `reattached`, and `log_bytes` for detached tasks.
- New modules `src/taskstore.ts` (atomic per-task meta/exit store + `/proc`
  helpers + TTL sweeper) and `src/tail.ts` (polled file tail-follow reader
  feeding the same line pipeline pipes use).

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
