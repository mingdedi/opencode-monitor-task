// Server-side state bridge (v2, session-scoped): the registry
// snapshot is written PER SESSION into `state_<hash>.json` files under one
// shared dir, plus one `state_heartbeat_<pid>_<ws-hash>.json` per plugin
// instance (pid alone is NOT unique under a shared V2 server).
// The TUI plugin (isolated runtime — V2 has no plugin-to-plugin event
// channel) scans the dir, picks the current session's file, and renders a
// session-scoped sidebar panel. Session ids are globally unique, so every
// file has exactly one writer — concurrent projects/instances can no longer
// clobber each other's state. The file set is a side channel only: write
// failures must never disturb the monitor lifecycle, so every error is
// logged and swallowed.
import { createHash } from "node:crypto"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./log"
import type { PublicInfo } from "./registry"

export const STATE_SCHEMA = 2

/**
 * Canonical state dir, shared by both runtimes of the plugin.
 *
 * Rationale: neither runtime can trust its process cwd (a shared OpenCode
 * server runs with cwd=$HOME — verified live in M5). Both sides hard-code
 * this resolver instead of guessing from cwd.
 */
export function stateDir(): string {
  const base =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.startsWith("/")
      ? process.env.XDG_DATA_HOME
      : join(homedir(), ".local", "share")
  return join(base, "opencode", "monitor-task")
}

/** Stable short hash for file names; the raw session id lives inside the file. */
export function hashSessionId(sessionId: string): string {
  return createHash("sha1").update(sessionId).digest("hex").slice(0, 12)
}

export function sessionStatePath(dir: string, sessionId: string): string {
  return join(dir, `state_${hashSessionId(sessionId)}.json`)
}

/** 8-char short hash for per-workspace heartbeat file names. */
function hashWorkspaceKey(workspace: string): string {
  return createHash("sha1").update(workspace).digest("hex").slice(0, 8)
}

export function heartbeatStatePath(
  dir: string,
  pid: number = process.pid,
  workspace: string | null = null,
): string {
  // The pid alone is not a unique instance key: a V2 shared server hosts
  // every per-project plugin instance in ONE process, so all instances
  // share a pid and would clobber a single heartbeat file. Keying by
  // workspace hash gives each instance its own file.
  // `hashSessionId` deliberately stays 12 chars — its length is baked into
  // existing session file names.
  const ws = workspace === null ? "nows" : hashWorkspaceKey(workspace)
  return join(dir, `state_heartbeat_${pid}_${ws}.json`)
}

/** Is this file name one of ours (used by the reader scan and the GC)? */
export function isStateFileName(name: string): boolean {
  return (
    name.startsWith("state_") && name.endsWith(".json")
  )
}

/**
 * Normalised workspace identity shared by both runtimes. `project.canonical`
 * is the most stable anchor: the TUI may be opened from a sub-directory
 * (observed live: location.directory was <project>/analysis-subdir while
 * project.directory stayed at the project root), and per-project plugin
 * instances carry the same project block. Falls back through project fields
 * to location.directory; undefined when the host provides none.
 */
export function workspaceRootOf(location: unknown): string | undefined {
  const loc = location as
    | {
        directory?: unknown
        project?: { directory?: unknown; canonical?: unknown }
      }
    | null
    | undefined
  const candidates = [loc?.project?.canonical, loc?.project?.directory, loc?.directory]
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("/")) {
      try {
        return realpathSync(c)
      } catch {
        return c
      }
    }
  }
  return undefined
}

/** On-disk contract: one session's panel projection. */
export interface SessionStateFile {
  schema: 2
  session_id: string
  /** Normalised workspace root (diagnostics + reader-side filtering). */
  workspace: string | null
  generated_at: string
  heartbeat_at: string
  monitors: PublicInfo[]
}

/** On-disk contract: plugin-instance liveness + active-session hint. */
export interface HeartbeatFile {
  schema: 2
  server_pid: number
  workspace: string | null
  /** Session that last ran ANY tool in this instance (source ② of the panel). */
  active_session_id: string | null
  heartbeat_at: string
}

export interface StateWriterOptions {
  /** Shared state dir (see stateDir()). */
  dir: string
  /** Normalised workspace root (workspaceRootOf(ctx.location)). */
  workspace: string | undefined
  /** Live "last active session" getter (session-resolver lastActive()). */
  activeSession: () => string | null
  /** Live snapshot of monitor records (registry.list()). */
  snapshot: () => PublicInfo[]
  /** Coalescing window for change-triggered writes. Default 250ms. */
  debounceMs?: number
  /** Rewrite interval. Default 5000ms. */
  heartbeatMs?: number
  /** How long a finished-only session file keeps being refreshed before it is
   *  deleted (the terminal record's display window). Default 5 minutes. */
  lingerMs?: number
}

export interface StateWriter {
  /** A registry mutation happened; schedule a coalesced sync. */
  change(): void
  /** Recompute and write immediately, bypassing the debounce window. */
  flush(): void
  /** Stop timers and write a final snapshot set. */
  dispose(): void
}

let tmpSeq = 0

function writeAtomic(path: string, state: unknown): void {
  // Monotonic suffix: same-pid writers (multiple instances inside one
  // shared server) must never share a tmp path, even if the host ever
  // moves writes off the main thread.
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    mkdirSync(dirnameOf(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, path)
  } catch (err) {
    try {
      // Best effort: remove a half-written tmp file so the directory stays
      // clean. (Renaming it into place would PUBLISH the partial file —
      // exactly what must not happen.)
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    log(`state write failed: ${String(err)}`)
  }
}

function removeQuiet(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // ignore
  }
}

function dirnameOf(path: string): string {
  // Local join-free dirname (path.dirname would need another import; the
  // tmp file lives next to the target anyway).
  const i = path.lastIndexOf("/")
  return i > 0 ? path.slice(0, i) : "."
}

/**
 * Group a registry snapshot by session. Each group keeps ALL active
 * (running/starting) monitors plus the single newest terminal record —
 * finished history belongs to monitor_list, not the sidebar.
 */
export function groupSessions(
  monitors: PublicInfo[],
): Map<string, PublicInfo[]> {
  const bySession = new Map<string, PublicInfo[]>()
  for (const m of monitors) {
    const sid = m.session_id ?? "(unknown)"
    const list = bySession.get(sid) ?? []
    list.push(m)
    bySession.set(sid, list)
  }
  for (const [sid, list] of bySession) {
    const active = list.filter(
      (m) => m.state === "running" || m.state === "starting",
    )
    const finished = list
      .filter((m) => m.state !== "running" && m.state !== "starting")
      .sort((a, b) =>
        (b.stopped_at ?? "").localeCompare(a.stopped_at ?? ""),
      )
      .slice(0, 1)
    bySession.set(sid, [...active, ...finished])
  }
  return bySession
}

/** Stale foreign files are removed after this long without a heartbeat. */
const GC_AFTER_MS = 10 * 60_000
/** GC runs every N heartbeat ticks (readdir + file parses are not free). */
const GC_EVERY_TICKS = 12

export function createStateWriter(options: StateWriterOptions): StateWriter {
  const debounceMs = options.debounceMs ?? 250
  const heartbeatMs = options.heartbeatMs ?? 5000
  const lingerMs = options.lingerMs ?? 5 * 60_000
  const workspace = options.workspace ?? null
  const hbPath = heartbeatStatePath(options.dir, process.pid, workspace)
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let ticks = 0
  // Session files we own; entries leave this set when their session's
  // monitors vanish from the registry (file deleted on next sync).
  const tracked = new Set<string>()

  /** Full recompute: session files (create/update/linger-delete) + heartbeat. */
  const sync = () => {
    // Guard the WHOLE body, snapshot() included: this runs inside a bare
    // setInterval callback, and the side channel must never throw into the
    // host process.
    try {
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const groups = groupSessions(options.snapshot())

      for (const [sid, monitors] of groups) {
        const path = sessionStatePath(options.dir, sid)
        const hasActive = monitors.some(
          (m) => m.state === "running" || m.state === "starting",
        )
        if (!hasActive) {
          // Finished-only session: show the terminal record for lingerMs
          // after it stopped, then drop the file entirely.
          let lastStop = 0
          for (const m of monitors) {
            const t = m.stopped_at ? Date.parse(m.stopped_at) : 0
            if (Number.isFinite(t) && t > lastStop) lastStop = t
          }
          if (lastStop > 0 && now > lastStop + lingerMs) {
            removeQuiet(path)
            tracked.delete(sid)
            continue
          }
        }
        writeAtomic(path, {
          schema: STATE_SCHEMA,
          session_id: sid,
          workspace,
          generated_at: nowIso,
          heartbeat_at: nowIso,
          monitors,
        } satisfies SessionStateFile)
        tracked.add(sid)
      }

      // Sessions whose monitors disappeared from the registry entirely
      // (pruned, or the group evaporated): remove their files.
      for (const sid of [...tracked]) {
        if (!groups.has(sid)) {
          removeQuiet(sessionStatePath(options.dir, sid))
          tracked.delete(sid)
        }
      }

      writeAtomic(hbPath, {
        schema: STATE_SCHEMA,
        server_pid: process.pid,
        workspace,
        active_session_id: options.activeSession(),
        heartbeat_at: nowIso,
      } satisfies HeartbeatFile)

      if (++ticks % GC_EVERY_TICKS === 0) gc()
    } catch (err) {
      log(`state sync failed: ${String(err)}`)
    }
  }

  /** Remove foreign state files whose heartbeat died long ago. */
  const gc = () => {
    let entries: string[]
    try {
      entries = readdirSync(options.dir)
    } catch {
      return
    }
    const now = Date.now()
    for (const name of entries) {
      if (!isStateFileName(name)) continue
      const full = join(options.dir, name)
      try {
        const parsed = JSON.parse(
          readFileSync(full, "utf8"),
        ) as { heartbeat_at?: string }
        const hb = Date.parse(parsed.heartbeat_at ?? "")
        if (Number.isFinite(hb) && now - hb > GC_AFTER_MS) {
          removeQuiet(full)
        }
      } catch {
        // Unreadable/corrupt: the reader ignores it; leave GC out of it.
      }
    }
  }

  const heartbeat = setInterval(() => {
    if (!disposed) sync()
  }, heartbeatMs)

  return {
    change() {
      if (disposed || timer) return
      timer = setTimeout(() => {
        timer = null
        sync()
      }, debounceMs)
    },
    flush() {
      if (disposed) return
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      sync()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      clearInterval(heartbeat)
      sync() // final snapshot set; files then age out via heartbeat staleness
    },
  }
}
