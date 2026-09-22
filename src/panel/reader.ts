// TUI-side reader for the session-scoped state bridge. The server
// plugin (separate process) atomically rewrites per-session files
// `state_<hash>.json` plus one `state_heartbeat_<pid>.json` per instance
// under one shared dir; the panel scans the dir every poll. A missing,
// corrupt, or stale-heartbeat heartbeat set means "server plugin not
// running" — the panel shows an offline marker instead of silently
// pretending everything is fine. The current session resolves through the
// source chain: caller-provided (TUI context, source ①) → fresh heartbeat
// active_session_id of a workspace-matching instance (source ②) → empty.
import { readdirSync, readFileSync } from "node:fs"
import type { PublicInfo } from "../registry"
import {
  hashSessionId,
  isStateFileName,
  type HeartbeatFile,
  type SessionStateFile,
} from "../state"

/** Heartbeat is 5s; three missed beats => declare the plugin offline. */
export const OFFLINE_AFTER_MS = 15_000

export type PanelStatus = "ok" | "offline"

export interface SessionSummary {
  /** running/starting monitors */
  running: number
  /** sessions contributing those monitors */
  sessions: number
}

export interface PanelState {
  status: PanelStatus
  /** Current session's monitors (empty when none / unknown session). */
  monitors: PublicInfo[]
  /** Session the panel is scoped to; null when unresolvable (empty state). */
  currentSession: string | null
  /**
   * Level-① summary: active monitors in OTHER sessions of THIS workspace.
   * Null when the workspace is unknown or there is nothing to summarise.
   */
  workspaceOthers: SessionSummary | null
  /**
   * Level-② summary: active monitors across ALL workspaces. Present (non-
   * null) only when OTHER workspaces have active monitors — otherwise it
   * would just repeat the visible detail rows.
   */
  allActive: number | null
  /** Newest fresh heartbeat epoch ms; null when unknown/unreadable. */
  heartbeatAt: number | null
  /** When this read happened (epoch ms). */
  readAt: number
}

export interface ReadOptions {
  /** Normalised workspace root (workspaceRootOf(context.location)). */
  workspace?: string
  /**
   * Source ① of the current-session chain, straight from the TUI router.
   * Three states: undefined = source ① unavailable (old host — fall back
   * to the heartbeat hint); null = the router says NO session is focused
   * (collapse to the empty state — adopting the heartbeat's hint here is
   * exactly the cross-session detail leak source ① exists to prevent);
   * string = the focused session's id.
   */
  currentSession?: string | null
  now?: number
}

interface SessionFileRecord {
  sessionId: string
  workspace: string | null
  monitors: PublicInfo[]
}

function isLive(m: PublicInfo): boolean {
  return m.state === "running" || m.state === "starting"
}

export function readPanelState(dir: string, opts: ReadOptions = {}): PanelState {
  const now = opts.now ?? Date.now()
  const offline: PanelState = {
    status: "offline",
    monitors: [],
    currentSession: null,
    workspaceOthers: null,
    allActive: null,
    heartbeatAt: null,
    readAt: now,
  }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return offline
  }

  // ---- parse everything once ------------------------------------------------
  const heartbeats: Array<{ file: HeartbeatFile; at: number }> = []
  const sessions: SessionFileRecord[] = []
  for (const name of entries) {
    // isStateFileName covers both session files and heartbeat files
    // (state_*.json); tmp residue and foreign files are skipped.
    if (!isStateFileName(name)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"))
    } catch {
      continue
    }
    const f = parsed as Partial<HeartbeatFile & SessionStateFile>
    if (f?.schema !== 2) continue
    const at = Date.parse(f.heartbeat_at ?? "")
    if (!Number.isFinite(at) || now - at > OFFLINE_AFTER_MS) continue
    if (/^state_heartbeat_/.test(name)) {
      heartbeats.push({ file: f as HeartbeatFile, at })
    } else if (typeof f.session_id === "string" && Array.isArray(f.monitors)) {
      sessions.push({
        sessionId: f.session_id,
        workspace: typeof f.workspace === "string" ? f.workspace : null,
        monitors: f.monitors as PublicInfo[],
      })
    }
  }

  if (heartbeats.length === 0) return offline

  // ---- current session: source ① → ② → none --------------------------------
  let currentSession: string | null = null
  if (opts.currentSession !== undefined) {
    // Source ① present (router-based). A non-empty string wins; anything
    // else means "no session focused" and must NOT fall through to the
    // heartbeat hint — that hint describes whichever session last ran a
    // tool in the workspace, not the one this panel is viewed from.
    if (typeof opts.currentSession === "string" && opts.currentSession !== "") {
      currentSession = opts.currentSession
    }
  } else {
    // Source ② (fallback for hosts without a usable router):
    // workspace-matching instances win; freshest heartbeat wins.
    // The any-heartbeat fallback applies ONLY when the workspace itself is
    // unknown — a known workspace without its own heartbeat must resolve to
    // the empty state: other workspaces' details belong to the level-②
    // summary, never to the detail rows.
    const inWorkspace = opts.workspace
      ? heartbeats.filter((h) => h.file.workspace === opts.workspace)
      : heartbeats
    const pool =
      inWorkspace.length > 0 ? inWorkspace : opts.workspace ? [] : heartbeats
    pool.sort((a, b) => b.at - a.at)
    const active = pool[0]?.file.active_session_id
    if (typeof active === "string" && active !== "") currentSession = active
  }

  // ---- detail rows: only the current session's file -------------------------
  const monitors =
    currentSession === null
      ? []
      : (sessions.find((s) => s.sessionId === currentSession)?.monitors ?? [])

  // ---- level ①: other sessions of this workspace ----------------------------
  // Source ③ (no current session resolvable) means a full empty state:
  // no detail rows AND no summaries — there is no anchor to scope against.
  let workspaceOthers: SessionSummary | null = null
  if (opts.workspace && currentSession !== null) {
    let running = 0
    let count = 0
    for (const s of sessions) {
      if (s.workspace !== opts.workspace || s.sessionId === currentSession) continue
      const r = s.monitors.filter(isLive).length
      if (r > 0) {
        running += r
        count++
      }
    }
    if (running > 0) workspaceOthers = { running, sessions: count }
  }

  // ---- level ②: everywhere (only when other workspaces are active) ----------
  let allActive: number | null = null
  const othersHaveActive =
    currentSession !== null &&
    sessions.some(
      (s) =>
        s.workspace !== null &&
        s.workspace !== opts.workspace &&
        s.monitors.some(isLive),
    )
  if (othersHaveActive) {
    allActive = sessions.reduce((sum, s) => sum + s.monitors.filter(isLive).length, 0)
  }

  return {
    status: "ok",
    monitors,
    currentSession,
    workspaceOthers,
    allActive,
    heartbeatAt: heartbeats.reduce((m, h) => Math.max(m, h.at), 0),
    readAt: now,
  }
}

/** File name a session's state lives in (diagnostics / tests). */
export function sessionFileName(sessionId: string): string {
  return `state_${hashSessionId(sessionId)}.json`
}
