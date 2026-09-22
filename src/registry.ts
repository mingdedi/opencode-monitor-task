import { spawn, type ChildProcess } from "node:child_process"
import { cleanLine } from "./clean"
import { newMonitorId } from "./ids"
import { log } from "./log"
import type { SessionResolver } from "./session-resolver"
import { TokenBucket } from "./throttle"
import type { PluginContext } from "./types"
import {
  validateCommand,
  validateCoalesce,
  validateDelivery,
  validateDirectory,
  validateParams,
  validatePattern,
  validateWakeMode,
  type Delivery,
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

type MonitorState = "starting" | "running" | "completed" | "failed" | "stopped"

interface MonitorEntry {
  id: string
  command: string
  description: string
  sessionID: string | null
  state: MonitorState
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
  killTimer: ReturnType<typeof setTimeout> | null
  finalized: boolean
}

export interface PublicInfo {
  id: string
  command: string
  description: string
  state: MonitorState
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
    executeContext: unknown
  }): Promise<StartResult>
  stop(id: string): { ok: boolean; message: string }
  list(): PublicInfo[]
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
  const monitors = new Map<string, MonitorEntry>()
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

  function armIdle(e: MonitorEntry) {
    clearIdle(e)
    e.idleTimer = setTimeout(() => {
      if (e.state === "running") {
        log(`${e.id}: idle timeout after ${e.idleTimeoutMs}ms`)
        finalize(e, "stopped", `idle timeout after ${e.idleTimeoutMs}ms without output`)
      }
    }, e.idleTimeoutMs)
  }

  /**
   * Kill the command's process group. `immediate` skips the SIGTERM grace
   * period and SIGKILLs synchronously — required on the process "exit" path
   * where timers can no longer fire.
   */
  function killGroup(e: MonitorEntry, immediate = false): void {
    const pid = e.child?.pid
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
    if (state === "stopped" || state === "failed") killGroup(e)
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
      if (e.state === "running" || e.state === "starting") continue
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
    if (e.state !== "running" || e.finalized) return
    if (e.coalesceMs > 0) {
      queueCoalesceLine(e, line)
      return
    }
    dispatchLine(e, line)
  }

  function attachStream(
    e: MonitorEntry,
    stream: NodeJS.ReadableStream | null,
    key: "outBuffer" | "errBuffer",
  ) {
    if (!stream) return
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      if (e.state !== "running") return
      armIdle(e) // any output resets the idle timer, even throttled lines
      const buffer = (e[key] += chunk)
      // Split on \n as well as \r / \r\n: progress-bar style output
      // (pip, docker, tqdm) overwrites lines with bare \r and would otherwise
      // never produce a "line" at all.
      const parts = buffer.split(/\r\n|\r|\n/)
      e[key] = parts.pop() ?? ""
      for (const part of parts) emitLine(e, part)
      // Soft-wrap guard: a stream with no newline at all must not grow the
      // buffer without bound. cleanLine() truncates the emitted line anyway.
      if (e[key].length > MAX_LINE_BUFFER) {
        const rest = e[key]
        e[key] = ""
        emitLine(e, rest)
      }
    })
    stream.on("error", (err) => log(`${e.id} stream error: ${String(err)}`))
  }

  function flushBuffer(e: MonitorEntry, key: "outBuffer" | "errBuffer") {
    const rest = e[key]
    e[key] = ""
    if (rest.trim().length > 0) emitLine(e, rest)
  }

  const killRunningImmediate = () => {
    for (const e of monitors.values()) {
      if (e.state === "running") killGroup(e, true)
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
        (e.state === "running" || e.state === "starting") &&
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
      killTimer: null,
      finalized: false,
    }

    // Register before spawn so the panel can show the starting state, and so
    // a spawn failure leaves a traceable "failed" record instead of vanishing.
    monitors.set(entry.id, entry)
    notifyChange()

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
    if (e.state !== "running") {
      return { ok: true, message: `monitor ${id} already ${e.state}: ${e.exitInfo}` }
    }
    finalize(e, "stopped", "stopped by monitor_stop")
    return {
      ok: true,
      message: `monitor ${id} stopped (SIGTERM -> SIGKILL process group)`,
    }
  }

  function list(): PublicInfo[] {
    return [...monitors.values()].map(publicInfo)
  }

  function stopAll(reason: string): void {
    for (const e of monitors.values()) {
      if (e.state === "running") {
        finalize(e, "stopped", reason)
      }
    }
  }

  /**
   * Full teardown for plugin unload / hot reload: stop everything and detach
   * from the module-level process guards so a disposed registry no longer
   * keeps closures alive in `liveKillers`.
   */
  function dispose(): void {
    stopAll("registry disposed")
    liveKillers.delete(killRunningImmediate)
  }

  return { start, stop, list, stopAll, dispose }
}
