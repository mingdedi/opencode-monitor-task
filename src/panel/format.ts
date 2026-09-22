// Pure line-model helpers for the sidebar panel: everything here is a plain
// function over the PanelState so the 42-column layout is unit-testable
// without a TUI.
import type { PublicInfo } from "../registry"
import type { PanelState } from "./reader"

/** Sidebar width is fixed at 42 columns by the host. */
export const PANEL_WIDTH = 42
/** Live monitors shown before folding into a "+N more" row. */
export const MAX_SHOWN = 6

export type Tone = "head" | "live" | "dim" | "warn"

export interface Line {
  readonly text: string
  readonly tone: Tone
}

const ICONS: Record<PublicInfo["state"], string> = {
  starting: "◐",
  running: "●",
  completed: "✔",
  failed: "✘",
  stopped: "■",
}

export function stateIcon(state: PublicInfo["state"]): string {
  return ICONS[state] ?? "·"
}

/** mon_ab12cd34 -> mon_ab12 */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 45s / 12m / 1h03m / 2h14m — compact elapsed time for column budgets. */
export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, "0")}m`
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s
}

function elapsedOf(m: PublicInfo, now: number): number {
  const started = Date.parse(m.started_at)
  if (!Number.isFinite(started)) return 0
  const end = m.stopped_at ? Date.parse(m.stopped_at) : now
  return end - started
}

function monitorLines(m: PublicInfo, now: number): Line[] {
  const isLive = m.state === "running" || m.state === "starting"
  const head = isLive
    ? `${stateIcon(m.state)} ${shortId(m.id)} ${fmtDuration(elapsedOf(m, now))}`
    : `${stateIcon(m.state)} ${shortId(m.id)} ${truncate(m.exit_info ?? m.state, PANEL_WIDTH - 4 - shortId(m.id).length)}`
  const counts = [`scan ${m.lines_scanned}`, `sent ${m.events_sent}`]
  if (m.lines_matched !== null) counts.push(`hit ${m.lines_matched}`)
  if (m.events_dropped > 0) counts.push(`drop ${m.events_dropped}`)
  if (isLive && m.pid !== null) counts.push(`pid ${m.pid}`)
  return [
    { text: head, tone: "live" },
    { text: `  ${truncate(m.command, PANEL_WIDTH - 2)}`, tone: "dim" },
    { text: `  ${truncate(counts.join(" · "), PANEL_WIDTH - 2)}`, tone: "dim" },
  ]
}

/** Full panel line model. Empty array = render nothing (collapsed). */
export function renderLines(state: PanelState, now = Date.now()): Line[] {
  if (state.status === "offline") {
    return [{ text: "MONITORS · plugin offline", tone: "warn" }]
  }
  const lines: Line[] = []
  if (state.monitors.length > 0) {
    const live = state.monitors.filter(
      (m) => m.state === "running" || m.state === "starting",
    )
    const finished = state.monitors.length - live.length
    const headParts = ["MONITORS", `${live.length} running`]
    if (finished > 0) headParts.push(`${finished} done`)
    lines.push({ text: headParts.join(" · "), tone: "head" })

    const shown = state.monitors.slice(0, MAX_SHOWN)
    for (const m of shown) lines.push(...monitorLines(m, now))
    const rest = state.monitors.length - shown.length
    if (rest > 0) {
      lines.push({ text: `  +${rest} more…`, tone: "dim" })
    }
  }
  // Level-① summary: other sessions of this workspace.
  if (state.workspaceOthers) {
    const { running, sessions } = state.workspaceOthers
    lines.push({
      text: `  +${running} running in ${sessions} other session${sessions > 1 ? "s" : ""}`,
      tone: "dim",
    })
  }
  // Level-② summary: everywhere — only present when other workspaces are
  // actually active (otherwise it just repeats the rows above).
  if (state.allActive !== null) {
    lines.push({
      text: `  +${state.allActive} running across all workspaces`,
      tone: "dim",
    })
  }
  return lines
}
