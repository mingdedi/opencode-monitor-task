import assert from "node:assert/strict"
import { test } from "node:test"
import {
  fmtDuration,
  PANEL_WIDTH,
  renderLines,
  shortId,
  truncate,
} from "../src/panel/format"
import type { PanelState } from "../src/panel/reader"
import type { PublicInfo } from "../src/registry"

const T0 = Date.parse("2026-09-22T12:00:00Z")

function monitor(over: Partial<PublicInfo> = {}): PublicInfo {
  return {
    id: "mon_ab12cd34",
    command: "python train.py",
    description: "",
    state: "running",
    pid: 4242,
    session_id: "ses_cur",
    events_sent: 11,
    events_dropped: 0,
    lines_scanned: 61,
    lines_matched: null,
    max_events: 1000,
    idle_timeout_ms: 300000,
    directory: null,
    pattern: null,
    wake_mode: "all",
    delivery: "queue",
    coalesce_ms: 0,
    started_at: new Date(T0 - 12 * 60_000).toISOString(),
    stopped_at: null,
    exit_info: null,
    ...over,
  }
}

function state(over: Partial<PanelState> = {}, monitors: PublicInfo[] = [monitor()]): PanelState {
  return {
    status: "ok",
    monitors,
    currentSession: "ses_cur",
    workspaceOthers: null,
    allActive: null,
    heartbeatAt: T0,
    readAt: T0,
    ...over,
  }
}

test("fmtDuration buckets", () => {
  assert.equal(fmtDuration(0), "0s")
  assert.equal(fmtDuration(45_000), "45s")
  assert.equal(fmtDuration(60_000), "1m")
  assert.equal(fmtDuration(720_000), "12m")
  assert.equal(fmtDuration(3_780_000), "1h03m")
  assert.equal(fmtDuration(8_040_000), "2h14m")
})

test("shortId / truncate", () => {
  assert.equal(shortId("mon_ab12cd34"), "mon_ab12")
  assert.equal(shortId("mon_ab"), "mon_ab")
  assert.equal(truncate("abcdef", 4), "abc…")
  assert.equal(truncate("abc", 4), "abc")
})

test("offline renders a single warn line", () => {
  const lines = renderLines(state({ status: "offline", monitors: [] }))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].tone, "warn")
  assert.match(lines[0].text, /offline/)
})

test("ok with no monitors and no summaries collapses to zero lines", () => {
  assert.deepEqual(renderLines(state({}, [])), [])
})

test("running monitor: head/command/counts, pid shown, width respected", () => {
  const lines = renderLines(state({}, [monitor({ lines_matched: 11 })]), T0)
  assert.equal(lines.length, 4) // head + 3 rows
  assert.equal(lines[0].text, "MONITORS · 1 running")
  assert.equal(lines[1].text, "● mon_ab12 12m")
  assert.equal(lines[2].text, "  python train.py")
  assert.equal(lines[3].text, "  scan 61 · sent 11 · hit 11 · pid 4242")
  for (const l of lines) {
    assert.ok(l.text.length <= PANEL_WIDTH, `line too wide (${l.text.length}): ${l.text}`)
  }
})

test("finished monitor shows exit info instead of pid", () => {
  const lines = renderLines(
    state(
      {},
      [monitor({ state: "failed", pid: null, stopped_at: new Date(T0).toISOString(), exit_info: "Exit code 1" })],
    ),
  )
  assert.equal(lines[0].text, "MONITORS · 0 running · 1 done")
  assert.equal(lines[1].text, "✘ mon_ab12 Exit code 1")
  assert.ok(!lines[3].text.includes("pid"), "finished monitors do not show pid")
})

test("folding beyond MAX_SHOWN", () => {
  const many = Array.from({ length: 9 }, (_, i) => monitor({ id: `mon_${i}0000000` }))
  const lines = renderLines(state({}, many))
  const fold = lines.find((l) => l.text.startsWith("  +"))
  assert.ok(fold, "fold row present")
  assert.equal(fold!.text, "  +3 more…")
})

test("long commands and exit info are truncated to panel width", () => {
  const long = "x".repeat(200)
  for (const l of renderLines(state({}, [monitor({ command: long })]))) {
    assert.ok(l.text.length <= PANEL_WIDTH, `line too wide: ${l.text.length}`)
  }
})

test("level-① summary: other sessions of this workspace", () => {
  const lines = renderLines(state({ workspaceOthers: { running: 2, sessions: 1 } }))
  assert.equal(lines.at(-1)!.text, "  +2 running in 1 other session")
  const plural = renderLines(state({ workspaceOthers: { running: 3, sessions: 12 } }))
  assert.equal(plural.at(-1)!.text, "  +3 running in 12 other sessions")
  for (const l of plural) {
    assert.ok(l.text.length <= PANEL_WIDTH, `line too wide: ${l.text}`)
  }
})

test("level-② summary: all workspaces, appended after level ①", () => {
  const lines = renderLines(
    state({ workspaceOthers: { running: 1, sessions: 1 }, allActive: 5 }),
  )
  assert.equal(lines.at(-2)!.text, "  +1 running in 1 other session")
  assert.equal(lines.at(-1)!.text, "  +5 running across all workspaces")
  assert.ok(lines.at(-1)!.text.length <= PANEL_WIDTH)
})

test("summaries render even when the current session has no monitors", () => {
  const lines = renderLines(
    state({ monitors: [], workspaceOthers: { running: 4, sessions: 2 }, allActive: 9 }),
  )
  assert.equal(lines.length, 2, "no head/detail rows, both summaries kept")
  assert.equal(lines[0].text, "  +4 running in 2 other sessions")
  assert.equal(lines[1].text, "  +9 running across all workspaces")
})

test("empty current session without summaries collapses", () => {
  assert.deepEqual(renderLines(state({ monitors: [], currentSession: null })), [])
})
