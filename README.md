# opencode-monitor-task

> OpenCode V2 plugin · Qwen Code-style `monitor` tools
> Let the agent run background commands whose **stage output wakes it up automatically** — turning "block and wait" into event-driven collaboration.

**[中文文档](./README.zh-CN.md)**

## Platform support

> ⚠️ **Windows: unvalidated — use with caution.** This plugin is developed and tested on Linux/macOS only. On Windows the core feature is broken: stdout of external programs is never captured (`lines_scanned` stays 0 in all wake modes; output written by `cmd.exe` built-ins does come through — likely a pipe-inheritance issue in the `cmd.exe` wrapper layer). A monitor therefore degrades to a "did it finish / did it crash" sentinel: no line-level wake-ups, and actively-printing tasks trigger false idle arbitrations. Process startup, lifecycle states, exit codes and idle arbitration themselves work. Treat Windows as unsupported until a fix lands.

## Why

OpenCode's native background command notifies the agent **once, when the whole command finishes**. Mid-run milestones of long tasks (training epochs, build stages, log lines) never wake the agent, so the model either blocks doing nothing or burns tokens on polling.

Qwen Code's built-in `monitor` tool fixed this: output streams back line by line, **every non-empty line becomes a notification that re-invokes the session**. This plugin brings that experience to OpenCode V2, plus a differentiator: **regex wake filtering**.

## User story

1. You: "Run this 3-hour training script and check the loss after each epoch."
2. Agent calls `monitor(command="python train.py 2>&1", pattern="epoch \\d+0/|NEW BEST|ERROR")` → returns instantly with a monitor id.
3. Agent tells you monitoring has started, then goes idle.
4. A matched line arrives → `<task-notification>` wakes the agent → it decides (keep waiting / alert / adjust / stop).
5. Command exits → final notification with exit code → agent wraps up.

## Measured results

| Scenario | Result |
|---|---|
| Notification injection latency | 1–8 ms |
| Noisy training log, regex filter | 28 lines scanned → 4 woke the agent (85.7% filtered) |
| Error storm with `coalesce_ms` | 30 ERROR lines → **1** notification |
| 60-epoch training simulation | 61 lines scanned → 11 wakes (82% filtered), 0 dropped |
| Concurrency cap | 17th concurrent monitor per session is rejected |
| Orphan processes | 0 across all tests (process-group kill, host-exit guards) |

## Install

Requires OpenCode V2 (`opencode --version` reports v2.0.11 or newer).

### Global install (recommended)

One command, available in every project. Straight from GitHub — works as soon as the repo is public:

```sh
opencode plugin add github:mingdedi/opencode-monitor-task
```

Or from npm, once published:

```sh
opencode plugin add opencode-monitor-task
```

Package installs pick up **both** entries automatically through the package `exports` map — `src/index.ts` for the server tools, `src/tui.ts` for the sidebar panel. Nothing extra to do for the TUI panel. Verify and manage with:

```sh
opencode plugin list     # the plugin id should appear here
opencode plugin update   # pull updates (unpinned npm/git targets)
opencode plugin remove opencode-monitor-task
```

If the plugin does not show up right away, run `opencode service restart` (or restart the TUI).

### Project-only install

Add the package to the `plugins` array in the project's `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-monitor-task"]
}
```

### From source (pre-publish / development)

```sh
git clone https://github.com/mingdedi/opencode-monitor-task.git
cd opencode-monitor-task
./scripts/install-local.sh --global-full   # recommended: full plugin into the global dir (publish-like layout) — every project gets the tools
```

Dev layout for hacking inside this repo (two commands):

```sh
./scripts/install-local.sh            # server entry -> project-level .opencode/plugins/
./scripts/install-local.sh --global   # TUI entry -> global dir (the TUI scans the global dir only)
```

`--global-full` installs both entry shims plus `package.json` and `src/` into `~/.config/opencode/plugins/` and removes the project-level copy — the server scans both dirs, so a leftover copy would load two server-plugin instances. The default mode refuses to run while a full global install exists. After changing `src/`, rerun the matching command to hot-reload (`opencode service restart` if hot reload does not pick it up).

`--link` replaces the global install with a **single symlink** to the repo root (which already is the full plugin layout). Edits to `src/` are live immediately — just `touch` the entry to hot-reload, no reinstall. Handy when `~/.config/opencode` is itself a git repo: it tracks one symlink entry instead of 20+ copied files, so reinstalls never dirty its status. Switch back anytime with `./scripts/install-local.sh --global-full` (it unlinks the symlink first).

> ⚠️ V2.0.x (verified up to 2.0.11) silently ignores **local path entries** inside the `plugins` config array (`"plugins": ["."]`, absolute paths, `file://`) — `opencode plugin list` shows an empty ID. Use `opencode plugin add`, the auto-discovered `.opencode/plugins/` directory, or upgrade OpenCode.

## Sidebar panel (TUI)

A second plugin entry (`src/tui.ts`) renders a live monitor panel in the TUI sidebar (`<leader>b` to toggle), scoped to your **current session**:

```
 MONITORS · 2 running · 1 done
 ● mon_ab12 12m
   python train.py 2>&1
   scan 61 · sent 11 · hit 11 · pid 4242
 ✔ mon_cd34 exit code 0
   +1 running in 1 other session
   +5 running across all workspaces
```

- **Session scope**: the panel shows the current session's monitors only. The current session resolves through a source chain: the TUI context (when available) → the heartbeat file's `active_session_id` (the session that last ran any tool in this workspace) → nothing (collapsed). Switching sessions is picked up on the next 500ms poll.
- **Two-level summaries**: `+N running in M other sessions` covers the rest of this workspace; `+N running across all workspaces` appears when other workspaces have active monitors. Terminal records from other sessions are not summarised.
- **States**: `◐ starting` (spawn in flight) → `● running` → `○ idle` (silent, arbitration pending) → `✔ completed` / `✘ failed` / `■ stopped`; live rows show the pid.
- **Terminal record TTL**: each session keeps at most ONE newest terminal record (completed/failed/stopped); it disappears 5 minutes after the task finished.
- **Plugin liveness**: every plugin instance heartbeats every 5s into its own `state_heartbeat_<pid>.json`; if no fresh heartbeat exists the panel shows `MONITORS · plugin offline` — distinguishing "no monitors" from "plugin not running".
- **Coexistence**: the panel claims `sidebar.content` *additively* — other sidebar plugins (e.g. statusline) keep working; empty state collapses to nothing.

**Architecture**: the server plugin and the TUI plugin run in **isolated runtimes** (V2 has no plugin-to-plugin event channel), bridged by atomically-written files under `~/.local/share/opencode/monitor-task/` (`$XDG_DATA_HOME` respected): one `state_<hash>.json` per session (session ids are globally unique, so concurrent projects/instances never clobber each other) plus one heartbeat file per plugin instance, polled every 500ms.

**Install** — package installs (`opencode plugin add` or the `plugins` array) and `install-local.sh --global-full` discover the TUI entry automatically; no extra step. Only the project-level dev layout needs it: the TUI runtime (v2.0.11) scans just the global dir (`~/.config/opencode/plugins/`), not the project-level one, so after the normal install run:

```sh
./scripts/install-local.sh --global   # TUI entry only (tui.ts + src), no server duplicate
```

Then restart the TUI; `/tmp/opencode-monitor-tui.log` should show `claimed sidebar.content`.

## Tools

### `monitor` — start a background watch

| Parameter | Type / range | Default | Notes |
|---|---|---|---|
| `command` | string, required | — | Shell command to run and watch. Trailing `&` is stripped; a stray `&` elsewhere is rejected (`&&` allowed, and `&` inside fd redirections like `2>&1` or inside quotes is fine). `$(...)`, backticks, `<(...)`, `>(...)` are rejected. |
| `description` | string ≤ 80 chars | — | Short note shown in every notification. |
| `max_events` | int (0, 10000] | 50 | Ceiling on output notifications before the monitor stops (and kills the command). An agent-tunable safety ceiling, not a fixed budget — estimate duration × wake rate for long/high-output tasks and pass an appropriate value; adjust later on a live monitor via `monitor_update`. Out-of-range values are rejected, not clamped. |
| `idle_timeout_ms` | int (0, 600000] | 300000 | When the command is silent for this long, the monitor does **not** kill it: the agent gets an arbitration notice — `monitor_keepalive` resets the timer, `monitor_stop` kills now, and no decision within one more window (grace period) kills it then. Fresh output self-heals back to `running`. |
| `directory` | absolute path | workspace root | Working directory; must resolve inside the project workspace. The default resolves from the plugin instance's workspace (`ctx.location`), which is correct even under a shared OpenCode service whose own cwd is `$HOME`. |
| `pattern` | regex | — | Only matching lines wake the agent. Non-matching lines still count in `lines_scanned`. Invalid regex is rejected with the engine error. |
| `wake_mode` | `all` \| `pattern` | implicit | `pattern` when `pattern` is given, else `all`. `all` + `pattern` counts matches but does not filter. |
| `delivery` | `queue` \| `steer` | `queue` | What to do when the session is busy. Lifecycle notices are always queued. |
| `coalesce_ms` | int [0, 60000] | 500 | Merge wake lines arriving within this window into one notification (first 10 lines, 200 chars each; one batch = one event against `max_events`). On by default — bursts of high-frequency output cost one notification per batch. 0 disables. |

Returns immediately with the monitor record (`mon_...` id, state, counters).

### `monitor_stop` — stop a monitor

SIGTERM to the command's process group, escalating to SIGKILL. Takes `monitor_id`. Works on `running` and `idle` monitors alike.

### `monitor_keepalive` — reset the idle timer

Answers "keep it" to a monitor-idle arbitration notice: revives an `idle` monitor back to `running` and resets the timer. On a `running` monitor it is a harmless explicit keepalive — useful when you know a silent phase (data loading, long validation) is coming. Terminal states are rejected.

### `monitor_update` — adjust a live monitor

Runtime parameter adjustment for a **live** monitor (`running`/`idle`; terminal monitors are rejected). Currently supports `max_events`: raise it when a long task is outgrowing the initial estimate (watch `events_sent` via `monitor_list` and adjust before the ceiling is hit — hitting it stops and kills the command), or lower it to stop early. A lowered ceiling already reached stops the monitor immediately.

### `monitor_list` — list all monitors

Running and finished (up to 200 retained), with state, counters (`events_sent` / `events_dropped` / `lines_scanned` / `lines_matched`), config echo, and exit info.

## Behavior & guarantees

- **Coalescing** — wake lines arriving within a 500ms window (default `coalesce_ms`) merge into ONE notification: first 10 lines at 200 chars each, the rest suppressed with a count. One batch counts as a single event against `max_events` and the token bucket. `coalesce_ms: 0` opts out.
- **Throttling** — token bucket: burst 5 notifications + 1/s sustained; over-limit lines are dropped (counted, never buffered).
- **Lifecycle** — `starting` (spawn in flight, counted toward the concurrency cap) → `running` → terminal state; records expose the live `pid`.
- **Idle arbitration** — an `idle_timeout_ms` expiry does not kill a merely-silent command: state flips to `idle`, the command keeps running, and a wake notice asks the agent to decide (`monitor_keepalive` vs `monitor_stop`). No decision within one more idle window (grace period) kills it; any fresh output self-heals back to `running`.
- **Auto-stop** — any of: `max_events` reached, idle grace expired without a keepalive, command exit. On exit: code 0 → `completed`; non-zero → `failed: Exit code N`; signal → `failed: Killed by signal SIGxxx`.
- **Output pipeline** — stdout+stderr merged, ANSI stripped, blank lines dropped, lines split on `\n`/`\r`/`\r\n` (progress-bar friendly), 64 KB no-newline soft wrap, 2000-char truncation per line.
- **Concurrency** — max 16 running monitors per session.
- **Cleanup** — process-group kill on stop; guards on host exit (`exit`/`SIGTERM`/`SIGINT`) leave zero orphans.

## Security notes

Monitored output flows into the model's context. **Do not monitor externally-writable streams** (e.g. a publicly postable channel) unless you trust the model to ignore embedded instructions. Notification envelopes escape `</task-notification>` forgery. Use `pattern` to shrink the injection surface — and token spend.

### Logs and state files on multi-user hosts

The plugin writes diagnostics and panel state to fixed paths on the machine running OpenCode:

- **Server log** — `$TMPDIR/opencode/opencode-monitor-task.log` (usually `/tmp/...`). Records the **full text of every monitored command**, session-context probes (off unless `OPENCODE_MONITOR_TASK_DEBUG=1` is set), and notification excerpts. Redirect with `OPENCODE_MONITOR_TASK_LOG_FILE` if you need it elsewhere.
- **TUI log** — `$TMPDIR/opencode-monitor-tui.log`. TUI context probes (same flag, off by default) and session-view diagnostics; same location class, no override variable.
- **Panel state** — `${XDG_DATA_HOME:-~/.local/share}/opencode/monitor-task/`. Per-session `state_*.json` files carry the full command text, workspace path, and session id. They are transient: files for finished sessions are deleted after ~5 minutes, files without a heartbeat after ~10 minutes.

On a single-user machine these are as private as anything else under `$TMPDIR` and `~/.local`. On **shared multi-user systems**, though, both locations are readable by other local accounts under default permissions — anything your monitored commands contain, including embedded credentials (tokens, passwords, URLs with keys), is exposed to every user on the host. Prefer: (a) keeping secrets out of monitored command lines, (b) pointing `OPENCODE_MONITOR_TASK_LOG_FILE` at a protected path under your home, and (c) a restrictive umask or ACLs on `~/.local`.

## Development

```sh
npm install
npm test          # 116 unit tests, <2s
npm run typecheck
./scripts/install-local.sh   # sync src/ into .opencode/plugins/ and hot-reload
```

Test layout and scenario scripts are documented in [test/README.md](./test/README.md).

## License

[MIT](./LICENSE)
