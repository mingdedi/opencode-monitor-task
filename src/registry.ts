import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { cleanLine } from "./clean"
import { newMonitorId } from "./ids"
import { log } from "./log"
import type { SessionResolver } from "./session-resolver"
import { stateDir } from "./state"
import { TokenBucket } from "./throttle"
import {
  buildWrapperScript,
  isTerminalTaskState,
  listTaskDirs,
  readExitCode,
  readMeta,
  readProcFields,
  sweepTaskDirs,
  taskDirOf,
  taskExitPath,
  taskLogPath,
  writeMeta,
  WRAPPER_EXIT_ENV,
  type DetachedMeta,
} from "./taskstore"
import { createTail, type TailHandle } from "./tail"
import type { PluginContext } from "./types"
import {
  validateCommand,
  validateCoalesce,
  validateDelivery,
  validateDirectory,
  validateMode,
  validateParams,
  validatePattern,
  validateWakeMode,
  type Delivery,
  type MonitorMode,
  type WakeMode,
} from "./validate"

const KILL_GRACE_MS = 200
const THROTTLE_BURST = 5
const THROTTLE_REFILL_PER_SECOND = 1
// Finished monitors are kept for monitor_list inspection, but only this many —
// a long-lived OpenCode service must not grow the registry (and its child
// process references) without bound.
const MAX_RETAINED = 200
// A stream chunk carrying no newline for longer than this is soft-wrapped:
// progress-bar style output (`\r`-only) and binary-ish streams would otherwise
// accumulate in the line buffer indefinitely.
const MAX_LINE_BUFFER = 64 * 1024
// Coalesced batches show at most this many lines (each capped in width) plus
// a suppression note — the batch signals "a burst of similar events", not a
// full transcript.
const COALESCE_MAX_SHOWN = 10
const COALESCE_SHOWN_WIDTH = 200
// Hard cap on pending coalesced lines so a firehose cannot grow memory.
const MAX_PENDING_LINES = 1000
// Detached meta flush cadence while a detached monitor is live: bounds how
// much of the log a reattach re-reads as silent history after a hard
// crash (graceful paths flush immediately).
const META_FLUSH_MS = 5000
// Task-store TTL sweep cadence inside the meta flusher. The TTL itself is
// 1h (TASK_TTL_MS), so a coarse cadence is fine — sweeping on every 5s
// flush tick would be pure IO waste. A sweep also runs at the head of
// every reattachDetached scan (service start), the one moment the store
// is guaranteed to be visited even when no detached task ever goes live
// in this service lifetime.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
// Preview lines kept during a silent reattach replay for the summary note.
const REPLAY_PREVIEW_LINES = 5

// "idle" = idle_timeout_ms elapsed without output; the command is STILL
// ALIVE and the agent is asked to decide (keepalive vs kill) within one
// more idle window before the grace timer kills the process group.
type MonitorState = "starting" | "running" | "idle" | "completed" | "failed" | "stopped"

interface MonitorEntry {
  id: string
  command: string
  description: string
  sessionID: string | null
  state: MonitorState
  /** Lifetime mode (M9): attached dies with the service; detached survives
   *  it via the task store (log file + meta + exit file) and reattaches. */
  mode: MonitorMode
  child: ChildProcess | null
  pid: number | null
  startedAt: number
  stoppedAt: number | null
  exitInfo: string | null
  eventsSent: number
  eventsDropped: number
  linesScanned: number
  linesMatched: number | null
  maxEvents: number
  idleTimeoutMs: number
  directory: string | null
  patternSource: string | null
  matcher: RegExp | null
  wakeMode: WakeMode
  delivery: Delivery
  coalesceMs: number
  pendingLines: string[]
  coalesceTimer: ReturnType<typeof setTimeout> | null
  /** Serialises synthetic calls so wake/lifecycle notices keep send order. */
  deliverChain: Promise<void>
  bucket: TokenBucket
  outBuffer: string
  errBuffer: string
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Grace timer armed when entering "idle"; expiry without a keepalive kills. */
  graceTimer: ReturnType<typeof setTimeout> | null
  /** Epoch ms after which an idle monitor is killed (publicInfo → idle_deadline). */
  idleDeadline: number | null
  killTimer: ReturnType<typeof setTimeout> | null
  finalized: boolean
  // --- detached-mode fields (null/0 for attached) -----------------------
  /** Task store directory (meta/log/exit), or null for attached monitors. */
  taskDir: string | null
  /** Tail reader over the task log; stopped on finalize/dispose. */
  tail: TailHandle | null
  /** True while reattach replays history: lines are counted and previewed
   *  but never dispatched (the old session cannot be un-missed). */
  silent: boolean
  /** Counters as of the reattach claim — the "+N lines while away" base. */
  replayBase: { scanned: number; matched: number } | null
  /** Rolling preview of replayed lines for the reattach summary note. */
  replayPreview: string[]
  /** True when this entry was claimed from the task store, not spawned here. */
  reattached: boolean
  /** Consumed log bytes (== resume offset); surfaced as log_bytes. */
  logBytes: number
}

export interface PublicInfo {
  id: string
  command: string
  description: string
  state: MonitorState
  /** Lifetime mode: "attached" (dies with the service) or "detached"
   *  (survives the service; reattaches from the task store). */
  mode: MonitorMode
  pid: number | null
  /** Owning session (state bridge groups by this; always set in practice). */
  session_id: string | null
  events_sent: number
  events_dropped: number
  lines_scanned: number
  lines_matched: number | null
  max_events: number
  idle_timeout_ms: number
  directory: string | null
  pattern: string | null
  wake_mode: WakeMode
  delivery: Delivery
  coalesce_ms: number
  started_at: string
  stopped_at: string | null
  exit_info: string | null
  /** Set while state === "idle": when the grace window kills the command. */
  idle_deadline: string | null
  /** True when this monitor was re-claimed from the task store after a
   *  service restart (detached only). */
  reattached: boolean
  /** Detached only: consumed log bytes (≈ log size; visibility for disk
   *  usage — no rotation in M9). Null for attached monitors. */
  log_bytes: number | null
}

export type StartResult =
  | { ok: true; monitor: PublicInfo }
  | { ok: false; error: string }

export interface Registry {
  start(input: {
    command: unknown
    description?: unknown
    max_events?: unknown
    idle_timeout_ms?: unknown
    directory?: unknown
    pattern?: unknown
    wake_mode?: unknown
    delivery?: unknown
    coalesce_ms?: unknown
    mode?: unknown
    executeContext: unknown
  }): Promise<StartResult>
  stop(id: string): { ok: boolean; message: string }
  /**
   * Reset the idle timer (agent answered "keep it" to an idle notice).
   * On an "idle" monitor this revives it to "running"; on a "running"
   * monitor it is a harmless explicit keepalive. Terminal states error.
   */
  keepalive(id: string): { ok: boolean; message: string }
  /**
   * Runtime parameter adjustment for a LIVE monitor (running/idle).
   * Raising max_events lets a long noisy task keep its monitor after the
   * initial estimate proved too low; lowering it to <= eventsSent stops the
   * monitor immediately (same ceiling rule as dispatch).
   */
  update(id: string, maxEvents: number | null): { ok: boolean; message: string }
  list(): PublicInfo[]
  /**
   * Scan the detached task store and claim tasks that belong to this
   * registry's workspace (M9). Alive tasks are re-armed (tail from
   * last_offset, counters restored, idle re-armed per the frozen-clock
   * semantics) and their owners get one summary notification; tasks that
   * died while unattended are finalized from their exit files. Idempotent:
   * already-claimed / already-known tasks are skipped. Returns the number
   * of live tasks claimed. Runs once automatically at registry creation.
   */
  reattachDetached(): Promise<number>
  stopAll(reason: string): void
  /** Stop everything and detach from process guards (plugin unload). */
  dispose(): void
}

export interface RegistryOptions {
  /** Per-session concurrent monitor cap. Default 16 (qwen parity). */
  maxConcurrent?: number
  /** Workspace root for directory validation and default cwd. Default process.cwd(). */
  rootDir?: string
  /** Max finished monitors retained in the registry. Default 200. */
  maxRetained?: number
  /** Base dir of the detached task store. Default stateDir(). */
  tasksBase?: string
  /** Mutation callback (state bridge, tests). Fired after every registry change. */
  onChange?: () => void
}

// Process-wide guards: shared across every registry instance created by this
// plugin (and across tests). Module-level so listeners are installed once.
const liveKillers = new Set<() => void>()
let processGuardsInstalled = false

/**
 * Resolve the workspace root for a plugin instance (M6).
 *
 * The registry needs the CALLING WORKSPACE as its default cwd and directory
 * validation base. `process.cwd()` is the OpenCode server process's cwd,
 * which under a shared service is $HOME, not any workspace (verified live:
 * monitors silently ran in ~, and the "must be inside the workspace" check
 * degraded to "must be inside ~"). Plugin instances are per-project on
 * v2.0.11, so ctx.location carries the right root; cwd stays as the last
 * resort for hosts without location data.
 */
export function resolveRootDir(ctx: PluginContext): string {
  const candidates = [
    ctx.location?.directory,
    ctx.location?.project?.directory,
    ctx.location?.project?.canonical,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("/")) return c
  }
  return process.cwd()
}

function installProcessGuardsOnce(): void {
  if (processGuardsInstalled) return
  processGuardsInstalled = true

  const killAllImmediate = () => {
    for (const kill of liveKillers) kill()
  }
  const onExit = () => killAllImmediate()

  const makeRelay = (sig: NodeJS.Signals) => {
    return () => {
      killAllImmediate()
      process.removeListener("exit", onExit)
      process.removeListener("SIGTERM", onTerm)
      process.removeListener("SIGINT", onInt)
      // Re-raise so the host process keeps its default/own signal semantics.
      try {
        process.kill(process.pid, sig)
      } catch {
        // ignore
      }
    }
  }
  const onTerm = makeRelay("SIGTERM")
  const onInt = makeRelay("SIGINT")

  process.on("exit", onExit)
  process.on("SIGTERM", onTerm)
  process.on("SIGINT", onInt)
}

export function createRegistry(
  ctx: PluginContext,
  resolver: SessionResolver,
  options: RegistryOptions = {},
): Registry {
  const maxConcurrent = options.maxConcurrent ?? 16
  // The workspace root must be where the user's project lives. resolveRootDir
  // prefers the plugin instance's workspace (ctx.location, correct under
  // shared servers since instances are per-project) and falls back to the
  // server process cwd. NOT ctx-only and NOT cwd-first: both were wrong in
  // different eras (M2: cwd; M6 re-verified location on v2.0.11).
  const rootDir = options.rootDir ?? resolveRootDir(ctx)
  const maxRetained = options.maxRetained ?? MAX_RETAINED
  const tasksBase = options.tasksBase ?? stateDir()
  const monitors = new Map<string, MonitorEntry>()
  // Lazy 5s flusher for live detached metas (see ensureMetaFlusher).
  let metaFlushTimer: ReturnType<typeof setInterval> | null = null
  // Next due TTL sweep (epoch ms); 0 = sweep on the next flusher tick.
  // Reset by ensureMetaFlusher so every flusher lifetime opens with a sweep.
  let nextSweepAt = 0
  const notifyChange = () => {
    try {
      options.onChange?.()
    } catch (err) {
      log(`onChange callback failed: ${String(err)}`)
    }
  }

  // ---------------------------------------------------------------- helpers

  function publicInfo(e: MonitorEntry): PublicInfo {
    return {
      id: e.id,
      command: e.command,
      description: e.description,
      state: e.state,
      mode: e.mode,
      pid: e.pid,
      session_id: e.sessionID,
      events_sent: e.eventsSent,
      events_dropped: e.eventsDropped,
      lines_scanned: e.linesScanned,
      lines_matched: e.linesMatched,
      max_events: e.maxEvents,
      idle_timeout_ms: e.idleTimeoutMs,
      directory: e.directory,
      pattern: e.patternSource,
      wake_mode: e.wakeMode,
      delivery: e.delivery,
      coalesce_ms: e.coalesceMs,
      started_at: new Date(e.startedAt).toISOString(),
      stopped_at: e.stoppedAt ? new Date(e.stoppedAt).toISOString() : null,
      exit_info: e.exitInfo,
      idle_deadline: e.idleDeadline ? new Date(e.idleDeadline).toISOString() : null,
      reattached: e.reattached,
      log_bytes: e.mode === "detached" ? e.logBytes : null,
    }
  }

  function wrapNotification(e: MonitorEntry, text: string): string {
    // The label and text come from command output; neutralise the wrapper tag
    // so monitored content cannot forge or terminate our notification envelope.
    const label = escapeTag(
      e.description ? `${e.id} · ${e.description}` : e.id,
    )
    return `<task-notification>\n[monitor ${label}]\n${escapeTag(text)}\n</task-notification>`
  }

  function escapeTag(text: string): string {
    // Entity-escape the envelope tags so monitored output can neither forge
    // nor terminate the wrapper: the escaped form stays readable in the model
    // context but cannot reassemble into a live tag. (A previous version
    // replaced the tags with themselves — a no-op the weak envelope test
    // failed to catch.)
    return text
      .replaceAll("<task-notification>", "&lt;task-notification&gt;")
      .replaceAll("</task-notification>", "&lt;/task-notification&gt;")
  }

  async function deliver(
    e: MonitorEntry,
    text: string,
    delivery: Delivery = e.delivery,
  ): Promise<void> {
    if (!e.sessionID) {
      log(`deliver ${e.id}: no sessionID, dropping: ${text.slice(0, 60)}`)
      return
    }
    const payload = wrapNotification(e, text)
    try {
      if (typeof ctx.session.synthetic === "function") {
        try {
          await ctx.session.synthetic({ sessionID: e.sessionID, text: payload, delivery })
        } catch (err) {
          // Older hosts reject the delivery FIELD itself, regardless of its
          // value. Retry once without it for BOTH values: "queue"
          // degrades to the host default — queue-like on every such host;
          // "steer" degrades to default delivery. (Re-throwing for queue —
          // the old behaviour — dropped the notification entirely, even
          // though queue is both the user-facing default and the forced
          // mode of every lifecycle notice.)
          log(`deliver ${e.id}: retrying without delivery field (${String(err)})`)
          await ctx.session.synthetic({ sessionID: e.sessionID, text: payload })
        }
      } else if (typeof ctx.session.prompt === "function") {
        log("session.synthetic unavailable; falling back to session.prompt")
        await ctx.session.prompt({ sessionID: e.sessionID, text: payload })
      } else {
        log(`deliver ${e.id}: no synthetic/prompt API available`)
        return
      }
      log(`delivered ${e.id} [${delivery}]: ${text.slice(0, 80)}`)
    } catch (err) {
      log(`deliver ${e.id} failed: ${String(err)}`)
    }
  }

  function clearIdle(e: MonitorEntry) {
    if (e.idleTimer) {
      clearTimeout(e.idleTimer)
      e.idleTimer = null
    }
  }

  function clearGrace(e: MonitorEntry) {
    if (e.graceTimer) {
      clearTimeout(e.graceTimer)
      e.graceTimer = null
    }
    e.idleDeadline = null
  }

  function armIdle(e: MonitorEntry) {
    clearIdle(e)
    e.idleTimer = setTimeout(() => enterIdleGrace(e), e.idleTimeoutMs)
  }

  /**
   * Idle timeout fired. Instead of killing a merely-silent command, ask the
   * agent: keepalive resets the timer, monitor_stop kills now, and doing
   * nothing for one more idle window (the grace period) kills then. The
   * command keeps running throughout — its state stays queryable via
   * monitor_list ("idle"), and any new output self-heals back to "running".
   */
  function enterIdleGrace(e: MonitorEntry) {
    if (e.state !== "running" || e.finalized) return
    // Flush any pending coalesce batch first, while the state is still
    // "running" — the arbitration notice must not swallow the batch tail.
    flushCoalesce(e)
    e.state = "idle"
    e.idleDeadline = Date.now() + e.idleTimeoutMs
    notifyChange()
    log(`${e.id}: idle ${e.idleTimeoutMs}ms without output — arbitration notice sent (grace ${e.idleTimeoutMs}ms)`)
    const ms = e.idleTimeoutMs
    const text = [
      `monitor idle: no output for ${ms}ms — command still running (pid ${e.pid}).`,
      `Keep it: call monitor_keepalive("${e.id}") to reset the idle timer.`,
      `Kill it now: monitor_stop("${e.id}").`,
      `No decision within ${ms}ms (grace period): it will be killed automatically.`,
    ].join("\n")
    // Same channel/rules as lifecycle notices: queue mode, no max_events cost.
    e.deliverChain = e.deliverChain.then(() => deliver(e, text, "queue"))
    e.graceTimer = setTimeout(() => {
      if (e.state === "idle") {
        finalize(
          e,
          "stopped",
          `idle timeout after ${ms}ms without output (no keepalive within ${ms}ms grace period)`,
        )
      }
    }, ms)
  }

  /** Leave "idle" back to "running": agent keepalive or fresh command output. */
  function resumeRunning(e: MonitorEntry, reason: string) {
    if (e.state !== "idle") return
    clearGrace(e)
    e.state = "running"
    notifyChange()
    log(`${e.id}: resumed running (${reason})`)
  }

  /**
   * Kill the command's process group. `immediate` skips the SIGTERM grace
   * period and SIGKILLs synchronously — required on the process "exit" path
   * where timers can no longer fire.
   */
  function killGroup(e: MonitorEntry, immediate = false): void {
    // Reattached detached monitors have no child handle — the recorded pid
    // (= pgid for detached spawns) is still a valid group target.
    const pid = e.child?.pid ?? e.pid
    if (!pid) return
    const send = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig) // negative pid = process group
      } catch {
        try {
          process.kill(pid, sig)
        } catch {
          // Already gone.
        }
      }
    }
    if (e.killTimer) {
      clearTimeout(e.killTimer)
      e.killTimer = null
    }
    send("SIGTERM")
    if (immediate) {
      send("SIGKILL")
      try {
        e.child?.kill("SIGKILL")
      } catch {
        // Already gone.
      }
    } else {
      e.killTimer = setTimeout(() => {
        send("SIGKILL")
        try {
          e.child?.kill("SIGKILL")
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS)
    }
  }

  function finalize(e: MonitorEntry, state: MonitorState, exitInfo: string) {
    if (e.finalized) return
    e.finalized = true
    e.state = state
    e.stoppedAt = Date.now()
    e.exitInfo = exitInfo
    notifyChange()
    clearIdle(e)
    clearGrace(e)
    if (state === "stopped" || state === "failed") killGroup(e)
    if (e.mode === "detached") {
      // Record the terminal state in the store — this is what the next
      // service start (and the TTL sweeper) will see. Flush BEFORE
      // stopping the tail: the live handle carries the true offset.
      if (state === "completed" || state === "failed" || state === "stopped") {
        flushDetachedMeta(e, state)
      }
      e.tail?.stop()
      e.tail = null
    }
    log(`${e.id}: finalized state=${state} exit="${exitInfo}"`)
    // A coalescing batch that has not hit its window yet still belongs to the
    // agent — flush it before the lifecycle notice (no tail loss).
    flushCoalesce(e, true)
    pruneFinished()
    // Lifecycle notifications bypass the throttle and do not count toward
    // max_events — the exit status must always reach the agent. They are
    // always delivered queue-mode so they never interrupt a live turn.
    // Chained after any pending wake delivery: the flushed coalesce tail must
    // reach the agent before the lifecycle notice regardless of how the host
    // schedules async synthetic calls.
    e.deliverChain = e.deliverChain.then(() =>
      deliver(e, `monitor ${state}: ${exitInfo}`, "queue"),
    )
  }

  /**
   * Throttled dispatch of one wake event (a single line or a coalesced batch).
   * `ignoreFinalized` is used by the finalize flush path, which must bypass
   * the finalized flag while keeping the token bucket and max_events ceiling.
   */
  function dispatchLine(e: MonitorEntry, text: string, ignoreFinalized = false) {
    if (!ignoreFinalized && (e.state !== "running" || e.finalized)) return
    if (e.eventsSent >= e.maxEvents) return
    if (!e.bucket.tryTake()) {
      e.eventsDropped++
      notifyChange()
      if (e.eventsDropped === 1 || e.eventsDropped % 25 === 0) {
        log(`${e.id}: throttled lines dropped so far: ${e.eventsDropped}`)
      }
      return
    }
    e.eventsSent++
    notifyChange()
    // Chain onto the per-monitor deliver queue: notifications must reach the
    // agent in the order they were produced, even if the host's synthetic API
    // resolves out of order.
    e.deliverChain = e.deliverChain.then(() => deliver(e, text))
    if (!ignoreFinalized && e.eventsSent >= e.maxEvents) {
      finalize(e, "stopped", `reached max_events=${e.maxEvents}`)
    }
  }

  /** Merge pending coalesced lines into one wake event. */
  function flushCoalesce(e: MonitorEntry, ignoreFinalized = false) {
    if (e.coalesceTimer) {
      clearTimeout(e.coalesceTimer)
      e.coalesceTimer = null
    }
    const lines = e.pendingLines
    e.pendingLines = []
    if (lines.length === 0) return
    const shown = lines
      .slice(0, COALESCE_MAX_SHOWN)
      .map((l) => (l.length > COALESCE_SHOWN_WIDTH ? l.slice(0, COALESCE_SHOWN_WIDTH) + "…" : l))
    const rest = lines.length - shown.length
    const parts = [
      `[${lines.length} line${lines.length > 1 ? "s" : ""} coalesced]`,
      ...shown,
    ]
    if (rest > 0) parts.push(`(… ${rest} more lines suppressed)`)
    dispatchLine(e, parts.join("\n"), ignoreFinalized)
  }

  function queueCoalesceLine(e: MonitorEntry, line: string) {
    if (e.pendingLines.length >= MAX_PENDING_LINES) {
      if (e.pendingLines.length === MAX_PENDING_LINES) {
        log(`${e.id}: coalesce pending cap hit (${MAX_PENDING_LINES}); dropping oldest`)
      }
      e.pendingLines.shift()
    }
    e.pendingLines.push(line)
    if (!e.coalesceTimer) {
      e.coalesceTimer = setTimeout(() => flushCoalesce(e), e.coalesceMs)
    }
  }

  /** Bound the registry size by evicting the oldest finished monitors. */
  function pruneFinished(): void {
    if (monitors.size <= maxRetained) return
    let pruned = false
    for (const [id, e] of monitors) {
      if (monitors.size <= maxRetained) break
      if (e.state !== "completed" && e.state !== "failed" && e.state !== "stopped") continue
      e.child = null // release process/stream references
      monitors.delete(id)
      pruned = true
    }
    if (pruned) notifyChange()
  }

  function emitLine(e: MonitorEntry, raw: string) {
    e.linesScanned++
    notifyChange()
    const line = cleanLine(raw)
    if (!line) return
    if (e.matcher) {
      const hit = e.matcher.test(line)
      if (hit) {
        e.linesMatched!++
      } else if (e.wakeMode === "pattern") {
        return // filtered out: counted in lines_scanned, never wakes
      }
    }
    if (e.silent) {
      // Reattach replay: history is counted (and previewed for the
      // summary note) but never dispatched — the missed lines cannot be
      // un-missed, and re-firing them would storm the session.
      e.replayPreview.push(line)
      if (e.replayPreview.length > REPLAY_PREVIEW_LINES) e.replayPreview.shift()
      return
    }
    if (e.state !== "running" || e.finalized) return
    if (e.coalesceMs > 0) {
      queueCoalesceLine(e, line)
      return
    }
    dispatchLine(e, line)
  }

  /**
   * Shared chunk pipeline for both sources: attached pipes (stream "data"
   * events) and detached log tails. Handles idle self-heal, idle re-arm
   * and the line buffering (split on \n as well as \r / \r\n: progress-bar
   * style output overwrites lines with bare \r), plus the 64KB soft-wrap
   * guard for streams that never emit a newline.
   */
  function feedChunk(
    e: MonitorEntry,
    chunk: string,
    key: "outBuffer" | "errBuffer",
  ) {
    if (e.state === "idle") {
      // The command broke its silence during the grace window — the
      // arbitration question answered itself. Revive first so this chunk
      // flows through the normal pipeline (it can still wake the agent).
      resumeRunning(e, "new output during idle grace")
    }
    if (e.state !== "running") return
    armIdle(e) // any output resets the idle timer, even throttled lines
    const buffer = (e[key] += chunk)
    const parts = buffer.split(/\r\n|\r|\n/)
    e[key] = parts.pop() ?? ""
    for (const part of parts) emitLine(e, part)
    if (e[key].length > MAX_LINE_BUFFER) {
      const rest = e[key]
      e[key] = ""
      emitLine(e, rest)
    }
  }

  function attachStream(
    e: MonitorEntry,
    stream: NodeJS.ReadableStream | null,
    key: "outBuffer" | "errBuffer",
  ) {
    if (!stream) return
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => feedChunk(e, chunk, key))
    stream.on("error", (err) => log(`${e.id} stream error: ${String(err)}`))
  }

  function flushBuffer(e: MonitorEntry, key: "outBuffer" | "errBuffer") {
    const rest = e[key]
    e[key] = ""
    if (rest.trim().length > 0) emitLine(e, rest)
  }

  // -------------------------------------------------- detached (M9) helpers

  function ensureMetaFlusher(): void {
    if (metaFlushTimer) return
    nextSweepAt = 0 // a fresh flusher lifetime always opens with a sweep
    metaFlushTimer = setInterval(() => {
      let live = 0
      for (const e of monitors.values()) {
        if (e.mode === "detached" && !e.finalized) {
          flushDetachedMeta(e)
          live++
        }
      }
      // Opportunistic TTL sweep of the task store. Runs on the first tick
      // of every flusher lifetime (nextSweepAt starts at 0) and then at
      // SWEEP_INTERVAL_MS cadence — the store is only visited while some
      // detached task is live here, so a terminal dir left behind by the
      // LAST task of a lifetime is picked up by the next service start's
      // reattach sweep instead.
      if (Date.now() >= nextSweepAt) {
        nextSweepAt = Date.now() + SWEEP_INTERVAL_MS
        const removed = sweepTaskDirs(tasksBase)
        if (removed > 0) log(`task store: TTL sweep removed ${removed} dir(s)`)
      }
      // Nothing to watch anymore — don't keep a timer warm.
      if (live === 0) stopMetaFlusher()
    }, META_FLUSH_MS)
    metaFlushTimer.unref?.()
  }

  function stopMetaFlusher(): void {
    if (metaFlushTimer) {
      clearInterval(metaFlushTimer)
      metaFlushTimer = null
    }
  }

  /** Snapshot a live (or about-to-finalize) detached entry into the store. */
  function flushDetachedMeta(e: MonitorEntry, state?: DetachedMeta["state"]): void {
    if (e.mode !== "detached" || !e.taskDir) return
    const offset = e.tail?.getOffset() ?? e.logBytes
    if (e.tail) e.logBytes = offset
    const proc = e.pid ? readProcFields(e.pid) : null
    writeMeta(e.taskDir, {
      schema: 1,
      id: e.id,
      command: e.command,
      description: e.description,
      sessionID: e.sessionID,
      pid: e.pid ?? 0,
      pgid: e.pid ?? 0,
      procStartTime: proc?.starttime ?? "",
      startedAt: e.startedAt,
      directory: e.directory,
      pattern: e.patternSource,
      wakeMode: e.wakeMode,
      delivery: e.delivery,
      coalesceMs: e.coalesceMs,
      maxEvents: e.maxEvents,
      idleTimeoutMs: e.idleTimeoutMs,
      workspace: tasksWorkspace(),
      lastOffset: offset,
      linesScanned: e.linesScanned,
      linesMatched: e.linesMatched,
      eventsSent: e.eventsSent,
      eventsDropped: e.eventsDropped,
      state: state ?? (e.state === "idle" ? "idle" : "running"),
      exitInfo: state && isTerminalTaskState(state) ? e.exitInfo : null,
      claimedBy: state && isTerminalTaskState(state) ? null : process.pid,
      updatedAt: Date.now(),
    })
  }

  /** Workspace identity recorded in metas: rootDir, realpath-normalised
   *  when possible (survives symlinked clones swapping underneath). */
  function tasksWorkspace(): string {
    try {
      return realpathSync(rootDir)
    } catch {
      return rootDir
    }
  }

  function probeDetached(e: MonitorEntry): void {
    if (e.finalized || e.state === "starting") return
    if (e.state !== "running" && e.state !== "idle") return
    if (!e.pid) return
    try {
      process.kill(e.pid, 0)
      // Signal 0 succeeds on ZOMBIES too. A reattached wrapper has no
      // parent waiting on it (the spawning service died), so in
      // non-reaping environments (bare docker / devcontainer PID 1) it
      // stays undead forever — and would hold this monitor in "running"
      // until idle-grace misreports it as stopped. The /proc state letter
      // tells the exited apart from the living; an unreadable stat is no
      // verdict, so stay conservative and keep watching.
      const proc = readProcFields(e.pid)
      if (!proc || proc.state !== "Z") return // still alive
      log(`${e.id}: pid ${e.pid} is a zombie — treating as exited`)
    } catch {
      // fall through: dead
    }
    // Died possibly-unattended: the wrapper's exit file is the authority;
    // its absence means the whole group was killed before the wrapper
    // could record anything.
    const code = e.taskDir ? readExitCode(e.taskDir) : null
    if (code === 0) {
      finalize(e, "completed", "exit code 0 (recorded while unattended)")
    } else if (code !== null) {
      finalize(e, "failed", `Exit code ${code} (recorded while unattended)`)
    } else {
      finalize(e, "failed", "process died while unattended (exit code unknown)")
    }
  }

  /**
   * Spawn a detached monitor: the command is wrapped in a bash shell that
   * appends combined stdout/stderr to the task log and records the exit
   * code; the service holds NO pipe to the process, so its death cannot
   * SIGPIPE the command. The tail reader turns the log file back into the
   * same streaming pipeline attached monitors use.
   */
  function spawnDetached(entry: MonitorEntry): { ok: true } | { ok: false; error: string } {
    const dir = taskDirOf(entry.id, tasksBase)
    const logPath = taskLogPath(dir)
    const exitPath = taskExitPath(dir)
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      finalize(entry, "failed", `failed to create task dir: ${String(err)}`)
      return { ok: false, error: `failed to create task dir: ${String(err)}` }
    }
    let logFd: number
    try {
      logFd = openSync(logPath, "a")
    } catch (err) {
      finalize(entry, "failed", `failed to open log file: ${String(err)}`)
      return { ok: false, error: `failed to open log file: ${String(err)}` }
    }
    const script = buildWrapperScript(entry.command)
    let child: ChildProcess
    try {
      child = spawn("bash", ["-c", script], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: entry.directory ?? rootDir,
        env: { ...process.env, [WRAPPER_EXIT_ENV]: exitPath },
      })
    } catch (err) {
      try {
        closeSync(logFd)
      } catch {
        // ignore
      }
      finalize(entry, "failed", `failed to spawn: ${String(err)}`)
      return { ok: false, error: `failed to spawn: ${String(err)}` }
    }
    // The child holds inherited dups; the parent copy is not needed.
    try {
      closeSync(logFd)
    } catch {
      // ignore
    }
    if (!child.pid) {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      finalize(entry, "failed", "failed to spawn: no pid")
      return { ok: false, error: "failed to spawn: no pid" }
    }
    // Detached semantics: the event loop must not keep the SERVICE alive
    // for the monitor, and exit events still fire while it is alive.
    child.unref()

    entry.taskDir = dir
    entry.child = child
    entry.pid = child.pid
    flushDetachedMeta(entry) // pid + starttime captured here
    entry.tail = createTail({
      path: logPath,
      startOffset: 0,
      onChunk: (c) => feedChunk(entry, c, "outBuffer"),
      onTick: () => probeDetached(entry),
    })
    entry.state = "running"
    ensureMetaFlusher()
    child.on("error", (err) => {
      log(`${entry.id}: spawn error ${String(err)}`)
      finalize(entry, "failed", String(err))
    })
    child.on("close", (code, signal) => {
      if (entry.finalized) return
      // Prefer the wrapper's recorded code — `code` here is the wrapper's
      // own exit, which mirrors it (`exit "$_ec"`), but the file is the
      // source of truth across restarts.
      const recorded = readExitCode(dir)
      if (recorded !== null) {
        if (recorded === 0) finalize(entry, "completed", "exit code 0")
        else finalize(entry, "failed", `Exit code ${recorded}`)
      } else if (signal) {
        finalize(entry, "failed", `Killed by signal ${signal}`)
      } else if (code === 0) {
        finalize(entry, "completed", "exit code 0")
      } else {
        finalize(entry, "failed", `Exit code ${code}`)
      }
    })
    return { ok: true }
  }

  /** Rebuild a registry entry from a claimed task-store meta. */
  function entryFromMeta(meta: DetachedMeta, taskDir: string): MonitorEntry {
    const entry: MonitorEntry = {
      id: meta.id,
      command: meta.command,
      description: meta.description,
      sessionID: meta.sessionID,
      state: "running",
      mode: "detached",
      child: null, // not our child — liveness is polled, exits are read
      pid: meta.pid,
      startedAt: meta.startedAt,
      stoppedAt: null,
      exitInfo: null,
      eventsSent: meta.eventsSent,
      eventsDropped: meta.eventsDropped,
      linesScanned: meta.linesScanned,
      linesMatched: meta.linesMatched,
      maxEvents: meta.maxEvents,
      idleTimeoutMs: meta.idleTimeoutMs,
      directory: meta.directory,
      patternSource: meta.pattern,
      matcher: meta.pattern ? new RegExp(meta.pattern) : null,
      wakeMode: meta.wakeMode,
      delivery: meta.delivery,
      coalesceMs: meta.coalesceMs,
      pendingLines: [],
      coalesceTimer: null,
      deliverChain: Promise.resolve(),
      bucket: new TokenBucket({
        capacity: THROTTLE_BURST,
        refillPerSecond: THROTTLE_REFILL_PER_SECOND,
      }),
      outBuffer: "",
      errBuffer: "",
      idleTimer: null,
      graceTimer: null,
      idleDeadline: null,
      killTimer: null,
      finalized: false,
      taskDir,
      tail: null,
      silent: true,
      replayBase: { scanned: meta.linesScanned, matched: meta.linesMatched ?? 0 },
      replayPreview: [],
      reattached: true,
      logBytes: meta.lastOffset,
    }
    return entry
  }

  /**
   * The tail first caught up with the log end: everything drained so far
   * was history. Close the silent replay window with one summary note
   * (queue mode, no max_events cost — same rules as lifecycle notices)
   * and re-arm the idle clock per the frozen-clock semantics: absence
   * froze it, presence restarts it from zero.
   */
  function finishReplay(e: MonitorEntry): void {
    if (!e.silent) return
    e.silent = false
    const base = e.replayBase ?? { scanned: 0, matched: 0 }
    const newLines = e.linesScanned - base.scanned
    const newMatched = e.linesMatched === null ? null : e.linesMatched - base.matched
    armIdle(e)
    notifyChange()
    log(
      `${e.id}: reattached (pid ${e.pid}); ${newLines} line(s) replayed silently, resuming at offset ${e.logBytes}`,
    )
    if (newLines <= 0) {
      // Nothing was missed — no summary needed, the monitor just resumes.
      return
    }
    const parts = [
      `detached monitor ${e.id} reattached (pid ${e.pid}) — the service restarted while it kept running.`,
      `${newLines} line(s) were logged while away${newMatched === null ? "" : ` (${newMatched} matched the pattern)`}; they are counted in lines_scanned but NOT re-delivered.`,
      "Latest:",
      ...e.replayPreview.map((l) => `  ${l}`),
      `Monitoring resumed (idle timer re-armed at ${e.idleTimeoutMs}ms). monitor_stop / monitor_keepalive work as before.`,
    ]
    e.deliverChain = e.deliverChain.then(() =>
      deliver(e, parts.join("\n"), "queue"),
    )
  }

  /**
   * Scan the task store and claim this workspace's detached tasks (M9).
   * See Registry.reattachDetached for the contract.
   */
  async function reattachDetached(): Promise<number> {
    let claimed = 0
    const workspace = tasksWorkspace()
    // TTL sweep FIRST (service start): expired terminal dirs are removed
    // before the scan, so the loop below never even iterates them. This
    // is the only sweep path guaranteed to run regardless of whether any
    // detached task goes live in this service lifetime.
    const swept = sweepTaskDirs(tasksBase)
    if (swept > 0) log(`task store: TTL sweep removed ${swept} dir(s)`)
    for (const dir of listTaskDirs(tasksBase)) {
      const meta = readMeta(dir)
      if (!meta) continue // corrupt: leave for the TTL sweeper
      if (isTerminalTaskState(meta.state)) continue // terminal: sweeper's
      // Workspace guard: shared-server instances must not steal tasks
      // belonging to other projects (same pid, different workspace).
      let metaWorkspace: string
      try {
        metaWorkspace = realpathSync(meta.workspace)
      } catch {
        metaWorkspace = meta.workspace
      }
      if (metaWorkspace !== workspace) continue
      // Claim guard: a live claimer (another instance, hot-reload
      // predecessor that hasn't disposed yet) still owns the watch.
      if (meta.claimedBy && meta.claimedBy !== process.pid) {
        try {
          process.kill(meta.claimedBy, 0)
          continue // claimer alive — hands off
        } catch {
          // dead claimer (crashed service) — claimable below
        }
      }
      if (monitors.has(meta.id)) continue // already ours (idempotency)
      // Liveness probe with pid-reuse defense: (pid, starttime) must both
      // match, otherwise the recorded process is gone and the pid may
      // belong to somebody else entirely. A ZOMBIE passes kill(pid, 0)
      // and keeps its original starttime, but the process has exited —
      // same non-reaping-PID-1 defense as probeDetached; its exit file
      // carries the verdict.
      const proc = readProcFields(meta.pid)
      if (!proc || proc.state === "Z" || proc.starttime !== meta.procStartTime) {
        const code = readExitCode(dir)
        const state: DetachedMeta["state"] =
          code === 0 ? "completed" : "failed"
        const exitInfo =
          code === 0
            ? "exit code 0 (recorded while unattended)"
            : code !== null
              ? `Exit code ${code} (recorded while unattended)`
              : "process died while unattended (exit code unknown)"
        writeMeta(dir, {
          ...meta,
          state,
          exitInfo,
          claimedBy: null,
          updatedAt: Date.now(),
        })
        log(`reattach ${meta.id}: dead while unattended — recorded "${exitInfo}"`)
        // The outcome must reach the owning session: a terminal meta is
        // skipped by every future scan and never enters this registry, so
        // without a notice the agent has no way to learn how the task
        // ended. Same channel/rules as the reattach summary: queue mode,
        // no max_events cost. entryFromMeta is used purely as the
        // notification carrier (id/description/sessionID) — no tail is
        // started and nothing is registered.
        const ghost = entryFromMeta(meta, dir)
        void deliver(
          ghost,
          [
            `detached monitor ${meta.id} ended while the service was down.`,
            `monitor ${state}: ${exitInfo}`,
            "It is finalized in the task store and will not appear in monitor_list.",
          ].join("\n"),
          "queue",
        )
        continue
      }
      // Alive → claim it.
      writeMeta(dir, { ...meta, claimedBy: process.pid, updatedAt: Date.now() })
      const e = entryFromMeta(meta, dir)
      monitors.set(e.id, e)
      e.tail = createTail({
        path: taskLogPath(dir),
        startOffset: meta.lastOffset,
        onChunk: (c) => feedChunk(e, c, "outBuffer"),
        onTick: () => probeDetached(e),
        onCaughtUp: () => finishReplay(e),
      })
      ensureMetaFlusher()
      claimed++
      log(`reattach ${meta.id}: claimed (pid ${e.pid}, offset ${meta.lastOffset})`)
    }
    if (claimed > 0) notifyChange()
    return claimed
  }

  const killRunningImmediate = () => {
    for (const e of monitors.values()) {
      // Detached monitors are exempt from host-death guards BY DESIGN:
      // their whole point is surviving the service. Their store records
      // (last flushed meta) let the next service start reattach.
      if (e.mode === "detached") continue
      if (e.state === "running" || e.state === "idle") killGroup(e, true)
    }
  }

  // ------------------------------------------------------------------ start

  async function start(input: {
    command: unknown
    description?: unknown
    max_events?: unknown
    idle_timeout_ms?: unknown
    directory?: unknown
    pattern?: unknown
    wake_mode?: unknown
    delivery?: unknown
    coalesce_ms?: unknown
    mode?: unknown
    executeContext: unknown
  }): Promise<StartResult> {
    const cmd = validateCommand(input.command)
    if (cmd.error) return { ok: false, error: cmd.error }

    const params = validateParams(input)
    if (params.error) return { ok: false, error: params.error }

    const dir = validateDirectory(input.directory, rootDir)
    if (dir.error) return { ok: false, error: dir.error }

    const pat = validatePattern(input.pattern)
    if (pat.error) return { ok: false, error: pat.error }

    const mode = validateWakeMode(input.wake_mode, pat.pattern)
    if (mode.error) return { ok: false, error: mode.error }

    const del = validateDelivery(input.delivery)
    if (del.error) return { ok: false, error: del.error }

    const coal = validateCoalesce(input.coalesce_ms)
    if (coal.error) return { ok: false, error: coal.error }

    const lifetime = validateMode(input.mode)
    if (lifetime.error) return { ok: false, error: lifetime.error }

    const sessionID = await resolver.resolve(input.executeContext)
    if (!sessionID) {
      return {
        ok: false,
        error:
          "could not determine the calling session; set OPENCODE_MONITOR_TASK_DEBUG=1 and check the plugin log",
      }
    }

    const runningForSession = [...monitors.values()].filter(
      (e) =>
        (e.state === "running" || e.state === "starting" || e.state === "idle") &&
        e.sessionID === sessionID,
    )
    if (runningForSession.length >= maxConcurrent) {
      return {
        ok: false,
        error: `concurrency limit reached (${maxConcurrent} running monitors for this session); stop one with monitor_stop first`,
      }
    }

    const entry: MonitorEntry = {
      id: newMonitorId(),
      command: cmd.command!,
      description:
        typeof input.description === "string" ? input.description.slice(0, 80) : "",
      sessionID,
      // "starting" is visible to the state bridge/TUI panel until spawn()
      // resolves; spawn errors transition it to "failed" with exit info.
      state: "starting",
      mode: lifetime.monitorMode!,
      child: null,
      pid: null,
      startedAt: Date.now(),
      stoppedAt: null,
      exitInfo: null,
      eventsSent: 0,
      eventsDropped: 0,
      linesScanned: 0,
      linesMatched: pat.pattern ? 0 : null,
      maxEvents: params.maxEvents,
      idleTimeoutMs: params.idleTimeoutMs,
      directory: dir.directory ?? null,
      patternSource: pat.pattern ?? null,
      matcher: pat.pattern ? new RegExp(pat.pattern) : null,
      wakeMode: mode.wakeMode!,
      delivery: del.delivery!,
      coalesceMs: coal.coalesceMs!,
      pendingLines: [],
      coalesceTimer: null,
      deliverChain: Promise.resolve(),
      bucket: new TokenBucket({
        capacity: THROTTLE_BURST,
        refillPerSecond: THROTTLE_REFILL_PER_SECOND,
      }),
      outBuffer: "",
      errBuffer: "",
      idleTimer: null,
      graceTimer: null,
      idleDeadline: null,
      killTimer: null,
      finalized: false,
      taskDir: null,
      tail: null,
      silent: false,
      replayBase: null,
      replayPreview: [],
      reattached: false,
      logBytes: 0,
    }

    // Register before spawn so the panel can show the starting state, and so
    // a spawn failure leaves a traceable "failed" record instead of vanishing.
    monitors.set(entry.id, entry)
    notifyChange()

    // Detached (M9): file-backed spawn that survives the service. The
    // attached path below is untouched — same pipes, same guards.
    if (entry.mode === "detached") {
      const r = spawnDetached(entry)
      if (!r.ok) return { ok: false, error: r.error }
      installProcessGuardsOnce() // still installs host-exit cleanup for ATTACHED monitors
      notifyChange()
      log(
        `${entry.id}: started detached (pid ${entry.pid}, pgid ${entry.pid}, cwd ${entry.directory ?? rootDir}) "${cmd.command}" for session ${sessionID}`,
      )
      return { ok: true, monitor: publicInfo(entry) }
    }

    let child: ChildProcess
    try {
      child = spawn(cmd.command!, {
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: dir.directory ?? rootDir,
      })
    } catch (err) {
      finalize(entry, "failed", `failed to spawn: ${String(err)}`)
      return { ok: false, error: `failed to spawn: ${String(err)}` }
    }
    if (!child.pid || child.stdout == null || child.stderr == null) {
      // Half-spawned child: kill it before reporting failure, otherwise it
      // survives as an orphan nobody owns.
      try {
        child.kill("SIGKILL")
      } catch {
        // Already gone.
      }
      finalize(entry, "failed", "failed to spawn: no pid or output pipes")
      return { ok: false, error: "failed to spawn: no pid or output pipes" }
    }

    entry.child = child
    entry.pid = child.pid
    entry.state = "running"
    liveKillers.add(killRunningImmediate)
    installProcessGuardsOnce()
    notifyChange()
    log(
      `${entry.id}: started (pid ${child.pid}, pgid ${child.pid}, cwd ${dir.directory ?? rootDir}) "${cmd.command}" for session ${sessionID}`,
    )

    attachStream(entry, child.stdout, "outBuffer")
    attachStream(entry, child.stderr, "errBuffer")
    armIdle(entry)

    child.on("error", (err) => {
      log(`${entry.id}: spawn error ${String(err)}`)
      finalize(entry, "failed", String(err))
    })
    child.on("close", (code, signal) => {
      if (entry.killTimer) {
        clearTimeout(entry.killTimer)
        entry.killTimer = null
      }
      flushBuffer(entry, "outBuffer")
      flushBuffer(entry, "errBuffer")
      if (entry.finalized) return
      if (signal) {
        finalize(entry, "failed", `Killed by signal ${signal}`)
      } else if (code === 0) {
        finalize(entry, "completed", "exit code 0")
      } else {
        finalize(entry, "failed", `Exit code ${code}`)
      }
    })

    return { ok: true, monitor: publicInfo(entry) }
  }

  // ------------------------------------------------------------- stop/list

  function stop(id: string): { ok: boolean; message: string } {
    const e = monitors.get(id)
    if (!e) {
      return { ok: false, message: `unknown monitor id: ${id}` }
    }
    if (e.state !== "running" && e.state !== "idle") {
      return { ok: true, message: `monitor ${id} already ${e.state}: ${e.exitInfo}` }
    }
    finalize(e, "stopped", "stopped by monitor_stop")
    return {
      ok: true,
      message: `monitor ${id} stopped (SIGTERM -> SIGKILL process group)`,
    }
  }

  function keepalive(id: string): { ok: boolean; message: string } {
    const e = monitors.get(id)
    if (!e) {
      return { ok: false, message: `unknown monitor id: ${id}` }
    }
    if (e.state === "idle") {
      resumeRunning(e, "monitor_keepalive")
      armIdle(e)
      return {
        ok: true,
        message: `monitor ${id} resumed from idle-grace; idle timer reset to ${e.idleTimeoutMs}ms`,
      }
    }
    if (e.state === "running") {
      armIdle(e)
      return {
        ok: true,
        message: `monitor ${id} idle timer reset to ${e.idleTimeoutMs}ms (was running)`,
      }
    }
    return { ok: false, message: `monitor ${id} already ${e.state}: ${e.exitInfo}` }
  }

  function update(id: string, maxEvents: number | null): { ok: boolean; message: string } {
    if (maxEvents === null) {
      return { ok: false, message: "nothing to update: pass max_events" }
    }
    const e = monitors.get(id)
    if (!e) {
      return { ok: false, message: `unknown monitor id: ${id}` }
    }
    if (e.state !== "running" && e.state !== "idle") {
      return { ok: false, message: `monitor ${id} already ${e.state}: ${e.exitInfo}` }
    }
    const v = validateParams({ max_events: maxEvents })
    if (v.error) {
      return { ok: false, message: v.error }
    }
    e.maxEvents = v.maxEvents
    // Same ceiling semantics as dispatchLine: a lowered ceiling already
    // reached stops the monitor right away.
    if (e.eventsSent >= e.maxEvents) {
      finalize(e, "stopped", `reached max_events=${e.maxEvents} (lowered by monitor_update)`)
      return { ok: true, message: `monitor ${id} max_events set to ${e.maxEvents}; ceiling already reached — stopped` }
    }
    notifyChange()
    return {
      ok: true,
      message: `monitor ${id} max_events set to ${e.maxEvents} (sent ${e.eventsSent} so far)`,
    }
  }

  function list(): PublicInfo[] {
    return [...monitors.values()].map(publicInfo)
  }

  function stopAll(reason: string): void {
    for (const e of monitors.values()) {
      if (e.state === "running" || e.state === "idle") {
        finalize(e, "stopped", reason)
      }
    }
  }

  /**
   * Full teardown for plugin unload / hot reload: stop everything and detach
   * from the module-level process guards so a disposed registry no longer
   * keeps closures alive in `liveKillers`.
   *
   * Detached monitors are NOT killed — surviving the host is their contract.
   * They are parked instead: tail stopped, meta flushed with the resume
   * offset, and `claimedBy` cleared so a successor instance (hot reload in
   * the same process, or a restarted service) can claim them. If the host
   * dies right after this, the recorded offset is at most META_FLUSH_MS
   * stale and the process keeps running on its own process group.
   */
  function dispose(): void {
    for (const e of monitors.values()) {
      if (
        e.mode === "detached" &&
        (e.state === "running" || e.state === "idle") &&
        !e.finalized
      ) {
        // Park BEFORE stopping the tail: the live handle carries the
        // true resume offset.
        parkDetached(e)
        e.tail?.stop()
        e.tail = null
        // Drop every timer: the successor re-arms idle from zero on
        // reattach (frozen-clock semantics), and a lingering 5-minute
        // setTimeout would pin the host's event loop alive.
        clearIdle(e)
        clearGrace(e)
        if (e.coalesceTimer) {
          clearTimeout(e.coalesceTimer)
          e.coalesceTimer = null
        }
        // Hand the child off: the successor registry now owns lifecycle
        // bookkeeping. Keeping our close listener would let a late exit
        // overwrite the successor's terminal record (observed in tests:
        // its "stopped" clobbered to "failed" by our stale close path).
        e.child?.removeAllListeners("close")
        e.child?.removeAllListeners("error")
        continue
      }
      if (e.state === "running" || e.state === "idle") {
        finalize(e, "stopped", "registry disposed")
      }
    }
    liveKillers.delete(killRunningImmediate)
    stopMetaFlusher()
  }

  /** Write a park record: resume offset + no claimer + still "running". */
  function parkDetached(e: MonitorEntry): void {
    if (e.mode !== "detached" || !e.taskDir) return
    // The process is alive at park time (dispose only parks live entries),
    // so /proc is the authoritative starttime source.
    const proc = e.pid ? readProcFields(e.pid) : null
    // getOffset() works on a stopped tail (last consumed byte stands).
    const offset = e.tail?.getOffset() ?? e.logBytes
    e.logBytes = offset
    writeMeta(e.taskDir, {
      schema: 1,
      id: e.id,
      command: e.command,
      description: e.description,
      sessionID: e.sessionID,
      pid: e.pid ?? 0,
      pgid: e.pid ?? 0,
      procStartTime: proc?.starttime ?? "",
      startedAt: e.startedAt,
      directory: e.directory,
      pattern: e.patternSource,
      wakeMode: e.wakeMode,
      delivery: e.delivery,
      coalesceMs: e.coalesceMs,
      maxEvents: e.maxEvents,
      idleTimeoutMs: e.idleTimeoutMs,
      workspace: tasksWorkspace(),
      lastOffset: offset,
      linesScanned: e.linesScanned,
      linesMatched: e.linesMatched,
      eventsSent: e.eventsSent,
      eventsDropped: e.eventsDropped,
      state: "running",
      exitInfo: null,
      claimedBy: null,
      updatedAt: Date.now(),
    })
    log(`${e.id}: parked for reattach (offset ${offset})`)
  }
  // Auto-reattach at creation: a restarted service picks up its
  // workspace's surviving detached tasks without anyone calling a tool.
  void reattachDetached().catch((err) =>
    log(`reattach scan failed: ${String(err)}`),
  )

  return { start, stop, keepalive, update, list, reattachDetached, stopAll, dispose }
}
