import type { Registry } from "./registry"
import {
  COALESCE_DEFAULT,
  COALESCE_LIMIT,
  IDLE_TIMEOUT_DEFAULT,
  IDLE_TIMEOUT_LIMIT,
  MAX_EVENTS_DEFAULT,
  MAX_EVENTS_LIMIT,
} from "./validate"
import type { ToolDefinition } from "./types"

export function createTools(registry: Registry): ToolDefinition[] {
  const monitor: ToolDefinition = {
    name: "monitor",
    description: [
      "Run a long-running shell command in the background and watch its output.",
      "Each non-empty stdout/stderr line is delivered back to this session as a <task-notification> that wakes the agent automatically — no polling needed.",
      "Use it for stage-marked long jobs (training runs, builds, test suites), `tail -f` log watching, or health polling.",
      "STRONGLY RECOMMENDED: pass `pattern` (a regex) so only meaningful lines wake you — noisy lines are counted in lines_scanned but discarded, saving context tokens and shrinking the prompt-injection surface (e.g. pattern=\"epoch.*done|ERROR|FAILED\").",
      "The command must be non-interactive (stdin is closed) and must not append '&' — backgrounding is managed for you.",
      "Output is rate-limited (burst 5, then 1/s; excess lines are dropped, counted in monitor_list). Wake lines arriving within a short window are merged into one notification by default (`coalesce_ms`, default 500ms) — high-frequency output costs one event per batch, not one per line.",
      "Stops automatically when the command exits or when max_events is reached; an idle_timeout_ms expiry asks the agent first (keepalive vs kill) instead of killing a silent command outright. The exit status is sent as a final notification.",
      "Returns immediately with a monitor id. Stop early with monitor_stop; inspect states with monitor_list.",
    ].join(" "),
    input: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run and watch.",
        },
        description: {
          type: "string",
          description: "Short human-readable note about what is being watched (max 80 chars).",
        },
        max_events: {
          type: "integer",
          description: `Ceiling on output notifications before the monitor stops (and kills the command). Default ${MAX_EVENTS_DEFAULT} — an agent-tunable safety ceiling, NOT a fixed budget: for a long-running or high-output task, estimate the wake count (duration × wake rate) and pass an appropriate value yourself; you can also adjust it later on a live monitor via monitor_update. Integer in (0, ${MAX_EVENTS_LIMIT}]. Out-of-range values are rejected.`,
        },
        idle_timeout_ms: {
          type: "integer",
          description: `When the command is silent for this long, the monitor does NOT kill it right away: the agent is asked via a wake notification — call monitor_keepalive to reset the timer, or monitor_stop to kill; no decision within one more window (grace period) kills it. Fresh output self-heals back to running. Integer in (0, ${IDLE_TIMEOUT_LIMIT}]. Default ${IDLE_TIMEOUT_DEFAULT} (5 min).`,
        },
        directory: {
          type: "string",
          description:
            "Absolute working directory for the command; must resolve inside the project workspace. Defaults to the project root.",
        },
        pattern: {
          type: "string",
          description:
            'Regex wake filter: only matching lines become notifications (e.g. "epoch \\\\d+ done|ERROR"). Non-matching lines are scanned but dropped — use it to strip noisy output. Invalid regex is rejected with the engine error.',
        },
        wake_mode: {
          type: "string",
          enum: ["all", "pattern"],
          description:
            'Explicit override of the implicit behavior: default is "pattern" when `pattern` is given, "all" otherwise. "all" + pattern still counts lines_matched without filtering.',
        },
        delivery: {
          type: "string",
          enum: ["queue", "steer"],
          description:
            'What to do when the session is busy: "queue" (default) waits for the current turn to finish, "steer" interrupts to steer the active turn. Lifecycle notices are always queued.',
        },
        coalesce_ms: {
          type: "integer",
          description: `Merge wake lines arriving within this window into ONE notification (first 10 lines, 200 chars each; the batch counts as a single event). Default ${COALESCE_DEFAULT}ms — bursts of high-frequency output become one notification instead of one per line. 0 disables merging; max ${COALESCE_LIMIT}.`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      const i = input as Record<string, unknown>
      const result = await registry.start({
        command: i.command,
        description: i.description,
        max_events: i.max_events,
        idle_timeout_ms: i.idle_timeout_ms,
        directory: i.directory,
        pattern: i.pattern,
        wake_mode: i.wake_mode,
        delivery: i.delivery,
        coalesce_ms: i.coalesce_ms,
        executeContext: context,
      })
      if (!result.ok) {
        return { content: `monitor: rejected — ${result.error}` }
      }
      return { content: `monitor started\n${JSON.stringify(result.monitor, null, 2)}` }
    },
  }

  const monitorStop: ToolDefinition = {
    name: "monitor_stop",
    description:
      "Stop a running monitor started with the `monitor` tool. Sends SIGTERM to the command's process group, escalating to SIGKILL after ~200ms.",
    input: {
      type: "object",
      properties: {
        monitor_id: {
          type: "string",
          description: "Monitor id returned by the monitor tool (mon_...).",
        },
      },
      required: ["monitor_id"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const id = (input as { monitor_id?: unknown })?.monitor_id
      const r = registry.stop(typeof id === "string" ? id : "")
      return { content: `monitor_stop: ${r.message}` }
    },
  }

  const monitorKeepalive: ToolDefinition = {
    name: "monitor_keepalive",
    description:
      'Reset a monitor\'s idle timer. Primary use: answer "keep it" to a monitor-idle arbitration notice (revives the monitor from the idle-grace state back to running). Calling it on a running monitor is a harmless explicit keepalive — useful when you know a silent phase (data loading, long validation) is coming. Terminal states are rejected.',
    input: {
      type: "object",
      properties: {
        monitor_id: {
          type: "string",
          description: "Monitor id returned by the monitor tool (mon_...).",
        },
      },
      required: ["monitor_id"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const id = (input as { monitor_id?: unknown })?.monitor_id
      const r = registry.keepalive(typeof id === "string" ? id : "")
      return { content: `monitor_keepalive: ${r.message}` }
    },
  }

  const monitorUpdate: ToolDefinition = {
    name: "monitor_update",
    description:
      "Adjust a LIVE monitor's parameters at runtime (it must be running or idle-grace; terminal monitors are rejected). Currently supports max_events: raise it when a long task is outgrowing your initial estimate (watch events_sent via monitor_list and adjust before the ceiling is hit — hitting it stops and kills the command), or lower it to stop early. A lowered ceiling already reached stops the monitor immediately.",
    input: {
      type: "object",
      properties: {
        monitor_id: {
          type: "string",
          description: "Monitor id returned by the monitor tool (mon_...).",
        },
        max_events: {
          type: "integer",
          description: `New notification ceiling. Integer in (0, ${MAX_EVENTS_LIMIT}].`,
        },
      },
      required: ["monitor_id", "max_events"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const i = input as { monitor_id?: unknown; max_events?: unknown }
      const id = typeof i.monitor_id === "string" ? i.monitor_id : ""
      const maxEvents =
        typeof i.max_events === "number" && Number.isInteger(i.max_events)
          ? i.max_events
          : null
      const r = registry.update(id, maxEvents)
      return { content: `monitor_update: ${r.message}` }
    },
  }

  const monitorList: ToolDefinition = {
    name: "monitor_list",
    description:
      "List all monitors (running and finished) with state, counters (sent/dropped/scanned), and exit information.",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => ({ content: JSON.stringify(registry.list(), null, 2) }),
  }

  return [monitor, monitorStop, monitorKeepalive, monitorUpdate, monitorList]
}
