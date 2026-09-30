// Detached-mode task store (M9): one directory per monitor under
// <stateDir>/tasks/<mon_id>/ holding
//   meta.json — the cross-restart record (identity, pid/pgid/starttime,
//               parameters, counters, last resume offset, claimed_by)
//   log       — raw combined stdout+stderr, appended by the command itself
//               (the file IS the pipe; the registry is a tail reader that
//               may leave and come back)
//   exit      — the command's exit code, written by the spawn wrapper
//
// The store is the single source of truth for a detached monitor across
// service restarts: reattach reads meta.json, probes the recorded pid
// against /proc (pgid + starttime — the pid-reuse defense), and tails
// `log` from `last_offset`. All writes are atomic (tmp+rename, the same
// pattern as the state bridge) and best-effort: a store failure must
// never disturb the monitor lifecycle, mirroring state.ts.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { log } from "./log"
import { stateDir } from "./state"
import type { Delivery, WakeMode } from "./validate"

export const TASK_STORE_SCHEMA = 1

/**
 * How long a terminal task directory (log + meta) is kept after the
 * terminal state was recorded. Detached logs can be large; the TTL bounds
 * disk usage without a rotation scheme (M9 scope decision: visibility
 * first, rotation deferred — last_offset is an absolute byte offset and
 * rotation would invalidate it).
 */
export const TASK_TTL_MS = 60 * 60 * 1000 // 1 hour

export type DetachedTaskState =
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"

export function isTerminalTaskState(s: DetachedTaskState): boolean {
  return s === "completed" || s === "failed" || s === "stopped"
}

/** On-disk contract for one detached monitor. */
export interface DetachedMeta {
  schema: 1
  id: string
  command: string
  description: string
  sessionID: string | null
  /** Wrapper shell pid; == process group id (detached spawn). */
  pid: number
  pgid: number
  /** /proc/<pid>/stat field 22 captured at spawn/claim time — pid-reuse defense. */
  procStartTime: string
  startedAt: number
  directory: string | null
  pattern: string | null
  wakeMode: WakeMode
  delivery: Delivery
  coalesceMs: number
  maxEvents: number
  idleTimeoutMs: number
  /** realpath of the owning workspace at spawn time; reattach only claims
   *  tasks whose workspace matches THIS registry instance (shared-server
   *  instances must not steal each other's tasks). */
  workspace: string
  /** Bytes of `log` already consumed — the reattach resume point. */
  lastOffset: number
  linesScanned: number
  linesMatched: number | null
  eventsSent: number
  eventsDropped: number
  state: DetachedTaskState
  /** Terminal states only: how it ended (monitor_list text for a task the
   *  current registry instance never saw live). */
  exitInfo: string | null
  /** Service pid currently watching this task (double-claim guard);
   *  cleared on dispose so a hot-reload successor may claim. */
  claimedBy: number | null
  updatedAt: number
}

export function tasksDirOf(base: string = stateDir()): string {
  return join(base, "tasks")
}

export function taskDirOf(id: string, base: string = stateDir()): string {
  return join(tasksDirOf(base), id)
}

export function taskLogPath(taskDir: string): string {
  return join(taskDir, "log")
}

export function taskExitPath(taskDir: string): string {
  return join(taskDir, "exit")
}

export function taskMetaPath(taskDir: string): string {
  return join(taskDir, "meta.json")
}

let tmpSeq = 0

/** Atomic best-effort meta write (tmp+rename; never throws). */
export function writeMeta(taskDir: string, meta: DetachedMeta): void {
  const path = taskMetaPath(taskDir)
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(meta))
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    log(`taskstore: meta write failed for ${meta.id}: ${String(err)}`)
  }
}

/** Read a task meta; null when missing or corrupt (corrupt = unclaimable,
 *  the sweeper's problem). */
export function readMeta(taskDir: string): DetachedMeta | null {
  try {
    const raw = JSON.parse(readFileSync(taskMetaPath(taskDir), "utf8"))
    if (
      typeof raw !== "object" ||
      raw === null ||
      raw.schema !== TASK_STORE_SCHEMA ||
      typeof raw.id !== "string" ||
      typeof raw.pid !== "number"
    ) {
      return null
    }
    return raw as DetachedMeta
  } catch {
    return null
  }
}

/** The wrapper-recorded exit code, or null when absent (group SIGKILLed
 *  before the wrapper could record — surfaced as "exit unknown"). */
export function readExitCode(taskDir: string): number | null {
  try {
    const raw = readFileSync(taskExitPath(taskDir), "utf8").trim()
    const code = Number.parseInt(raw, 10)
    return Number.isInteger(code) ? code : null
  } catch {
    return null
  }
}

/** List task directory names (non-recursive, entries only). */
export function listTaskDirs(base: string): string[] {
  try {
    return readdirSync(tasksDirOf(base)).map((id) => taskDirOf(id, base))
  } catch {
    return []
  }
}

/**
 * Wrapper script for detached commands (M9). The exit code is recorded by
 * an EXIT trap rather than trailing statements: an explicit `exit N` in
 * the command would skip any trailer, while a trap fires on EVERY exit
 * path (normal end, explicit exit, bash receiving SIGTERM/SIGINT — only
 * SIGKILL beats it, and that case is exactly what "exit unknown" in the
 * reattach probe is for). The exit file path travels via the environment
 * (WRAPPER_EXIT_ENV) so no quoting hazards exist at all.
 *
 * Assembled by the plugin itself and executed as `bash -c <script>` with
 * NO extra shell layer, so the command-injection rules of
 * validateCommand are not in play here.
 */
export const WRAPPER_EXIT_ENV = "_MONITOR_TASK_EXIT_FILE"

export function buildWrapperScript(command: string): string {
  return [
    // `$?` inside the trap is the shell's exit status at trap time.
    `trap 'printf "%s\\n" "$?" > "$${WRAPPER_EXIT_ENV}" 2>/dev/null' EXIT`,
    command,
  ].join("\n")
}

export interface ProcFields {
  /** Process state letter (stat field 3: R, S, D, Z, ...). 'Z' means the
   *  process has exited and only awaits reaping — kill(pid, 0) still
   *  succeeds against it, so callers must not treat zombies as alive. */
  state: string
  /** Process group id (stat field 5). */
  pgid: string
  /** Scheduler start time (stat field 22) — changes whenever the pid is
   *  reused for a new process, so (pid, starttime) is a stable identity. */
  starttime: string
}

/**
 * Parse /proc/<pid>/stat on Linux. null when unreadable (gone, zombie
 * reaped, non-Linux). Field indexing: after "pid (comm) " the first token
 * is field 3 (state), so field N sits at index N-3.
 */
export function readProcFields(pid: number): ProcFields | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // comm may contain spaces/parens — everything before the LAST ')' is
    // fields 1-2.
    const close = stat.lastIndexOf(")")
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(" ")
    if (fields.length < 20) return null
    // state = field 3 (index 0), pgid = field 5 (index 2), starttime =
    // field 22 (index 19) — see the field-indexing note above.
    return { state: fields[0], pgid: fields[2], starttime: fields[19] }
  } catch {
    return null
  }
}

/**
 * Sweep the task store: terminal records older than the TTL are deleted
 * (log included); corrupt directories whose exit file proves the command
 * finished are deleted on the same TTL (exit mtime as the terminal time);
 * corrupt directories with no verdict are left alone — deleting a live
 * task's directory would orphan it silently.
 */
export function sweepTaskDirs(
  base: string,
  nowMs: number = Date.now(),
  ttlMs: number = TASK_TTL_MS,
): number {
  let removed = 0
  for (const dir of listTaskDirs(base)) {
    const meta = readMeta(dir)
    if (meta && isTerminalTaskState(meta.state)) {
      if (nowMs - meta.updatedAt > ttlMs) {
        rmSync(dir, { recursive: true, force: true })
        removed++
      }
      continue
    }
    if (!meta) {
      const exitAge = mtimeAgeMs(taskExitPath(dir), nowMs)
      if (exitAge !== null && exitAge > ttlMs) {
        rmSync(dir, { recursive: true, force: true })
        removed++
      }
    }
  }
  return removed
}

function mtimeAgeMs(path: string, nowMs: number): number | null {
  try {
    return nowMs - statSync(path).mtimeMs
  } catch {
    return null
  }
}
