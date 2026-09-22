import { appendFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Debug flag: mirrors the server log to stderr AND enables context probes. */
export const DEBUG = process.env.OPENCODE_MONITOR_TASK_DEBUG === "1"
const LOG_FILE =
  process.env.OPENCODE_MONITOR_TASK_LOG_FILE ||
  join(tmpdir(), "opencode", "opencode-monitor-task.log")

/** Best-effort file log; never throws. */
export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  if (DEBUG) console.error(`[opencode-monitor-task] ${message}`)
  try {
    mkdirSync(join(tmpdir(), "opencode"), { recursive: true })
    appendFileSync(LOG_FILE, line)
  } catch {
    // Logging must never break the plugin.
  }
}
