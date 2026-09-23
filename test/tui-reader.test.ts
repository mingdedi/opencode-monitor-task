// Panel reader v2: dir scan, heartbeat-based offline detection,
// current-session source chain (① caller-provided ② heartbeat active), and
// the two-level summaries (workspace others / all workspaces).
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { OFFLINE_AFTER_MS, readPanelState, sessionFileName } from "../src/panel/reader"
import type { HeartbeatFile, SessionStateFile } from "../src/state"
import type { PublicInfo } from "../src/registry"

function tmpStateDir(): { dir: string; cleanup: () => void } {
  const parent = join(tmpdir(), "opencode")
  const dir = mkdtempSync(join(parent, "m7read-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function heartbeat(over: Partial<HeartbeatFile> = {}): HeartbeatFile {
  return {
    schema: 2,
    server_pid: 111,
    workspace: "/ws/one",
    active_session_id: null,
    heartbeat_at: new Date().toISOString(),
    ...over,
  }
}

function sessionFile(sessionId: string, workspace: string | null, monitors: PublicInfo[]): SessionStateFile {
  return {
    schema: 2,
    session_id: sessionId,
    workspace,
    generated_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    monitors,
  }
}

function m(state: PublicInfo["state"], id = "mon_x1"): PublicInfo {
  return {
    id,
    command: "sleep 1",
    description: "",
    state,
    pid: state === "running" ? 42 : null,
    session_id: "unused",
    events_sent: 0,
    events_dropped: 0,
    lines_scanned: 0,
    lines_matched: null,
    max_events: 1000,
    idle_timeout_ms: 300000,
    directory: null,
    pattern: null,
    wake_mode: "all",
    delivery: "queue",
    coalesce_ms: 0,
    started_at: "2026-09-22T10:00:00Z",
    stopped_at: state === "running" || state === "starting" ? null : "2026-09-22T10:00:05Z",
    exit_info: state === "running" || state === "starting" ? null : "exit code 0",
    idle_deadline: state === "idle" ? "2026-09-22T10:00:10Z" : null,
  }
}

function write(dir: string, name: string, content: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(content))
}

test("missing dir / no heartbeat -> offline", () => {
  const missing = join(tmpdir(), "opencode", "m7read-missing-" + Date.now())
  assert.equal(readPanelState(missing).status, "offline")
  const t = tmpStateDir()
  try {
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running")]))
    const s = readPanelState(t.dir) // heartbeat file absent
    assert.equal(s.status, "offline")
    assert.equal(s.monitors.length, 0)
  } finally {
    t.cleanup()
  }
})

test("stale heartbeat or old schema -> offline; current session via source ②", () => {
  const t = tmpStateDir()
  try {
    write(
      t.dir,
      "state_heartbeat_111.json",
      heartbeat({ heartbeat_at: new Date(Date.now() - OFFLINE_AFTER_MS - 1).toISOString() }),
    )
    assert.equal(readPanelState(t.dir).status, "offline")

    write(t.dir, "state_heartbeat_222.json", { ...heartbeat(), schema: 1 })
    assert.equal(readPanelState(t.dir).status, "offline", "schema 1 rejected")

    // Fresh heartbeat with active hint + matching session file.
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: "ses_a" }))
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.equal(s.status, "ok")
    assert.equal(s.currentSession, "ses_a")
    assert.equal(s.monitors.length, 1)
    assert.equal(s.workspaceOthers, null)
    assert.equal(s.allActive, null)
  } finally {
    t.cleanup()
  }
})

test("source ① (caller-provided currentSession) wins over heartbeat hint", () => {
  const t = tmpStateDir()
  try {
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: "ses_a" }))
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running")]))
    write(t.dir, sessionFileName("ses_b"), sessionFile("ses_b", "/ws/one", [m("running", "mon_b")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one", currentSession: "ses_b" })
    assert.equal(s.currentSession, "ses_b")
    assert.deepEqual(
      s.monitors.map((x) => x.id),
      ["mon_b"],
    )
    // ses_a still shows up in the level-① summary.
    assert.deepEqual(s.workspaceOthers, { running: 1, sessions: 1 })
  } finally {
    t.cleanup()
  }
})

test("source ① null (no session focused) -> empty state, heartbeat hint NOT adopted", () => {
  // The exact cross-session leak observed live: session B's monitor runs,
  // the heartbeat's active hint still points at B, and the user opens the
  // panel from session A (which ran no tool yet). A null from source ①
  // must collapse to the empty state instead of rendering B's rows.
  const t = tmpStateDir()
  try {
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: "ses_b" }))
    write(t.dir, sessionFileName("ses_b"), sessionFile("ses_b", "/ws/one", [m("running", "mon_b")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one", currentSession: null })
    assert.equal(s.status, "ok")
    assert.equal(s.currentSession, null, "heartbeat hint of another session not adopted")
    assert.deepEqual(s.monitors, [], "no foreign detail rows")
    assert.equal(s.workspaceOthers, null, "no summaries without a session anchor")
  } finally {
    t.cleanup()
  }
})

test("source ① empty string is defended as null, not as source-②-missing", () => {
  const t = tmpStateDir()
  try {
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: "ses_b" }))
    write(t.dir, sessionFileName("ses_b"), sessionFile("ses_b", "/ws/one", [m("running", "mon_b")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one", currentSession: "" })
    assert.equal(s.currentSession, null)
    assert.deepEqual(s.monitors, [])
  } finally {
    t.cleanup()
  }
})

test("current session without a file -> ok but empty; summaries still work", () => {
  const t = tmpStateDir()
  try {
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: "ses_none" }))
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.equal(s.status, "ok")
    assert.deepEqual(s.monitors, [])
    assert.deepEqual(s.workspaceOthers, { running: 1, sessions: 1 })
  } finally {
    t.cleanup()
  }
})

test("no current session resolvable -> empty state (no detail, no summaries)", () => {
  const t = tmpStateDir()
  try {
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: null }))
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.equal(s.status, "ok")
    assert.equal(s.currentSession, null)
    assert.deepEqual(s.monitors, [])
    assert.equal(s.workspaceOthers, null, "level-① needs a current-session anchor")
  } finally {
    t.cleanup()
  }
})

test("foreign-workspace heartbeat is not used as the active-session source", () => {
  const t = tmpStateDir()
  try {
    write(t.dir, "state_heartbeat_111.json", heartbeat({ workspace: "/ws/other", active_session_id: "ses_x" }))
    write(t.dir, "state_heartbeat_222.json", heartbeat({ server_pid: 222, workspace: "/ws/one", active_session_id: "ses_a" }))
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.equal(s.currentSession, "ses_a", "workspace-matching instance wins")
  } finally {
    t.cleanup()
  }
})

test("level-② summary appears only when OTHER workspaces have active monitors", () => {
  const t = tmpStateDir()
  try {
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: "ses_a" }))
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running"), m("starting", "mon_a2")]))
    // Same workspace, other session: counts toward level ① only.
    write(t.dir, sessionFileName("ses_b"), sessionFile("ses_b", "/ws/one", [m("running", "mon_b")]))
    // Other workspace: triggers level ②.
    write(t.dir, sessionFileName("ses_c"), sessionFile("ses_c", "/ws/other", [m("running", "mon_c"), m("running", "mon_c2")]))
    // Finished records never count toward summaries.
    write(t.dir, sessionFileName("ses_d"), sessionFile("ses_d", "/ws/other", [m("completed", "mon_d")]))

    const s = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.deepEqual(s.workspaceOthers, { running: 1, sessions: 1 })
    assert.equal(s.allActive, 5, "2 current + 1 other-session + 2 other-workspace; finished excluded")

    // Remove the other-workspace file -> level ② disappears (would be redundant).
    rmSync(join(t.dir, sessionFileName("ses_c")))
    rmSync(join(t.dir, sessionFileName("ses_d")))
    const s2 = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.equal(s2.allActive, null)
    assert.deepEqual(s2.workspaceOthers, { running: 1, sessions: 1 })
  } finally {
    t.cleanup()
  }
})

test("known workspace without its own heartbeat -> empty state (no foreign details)", () => {
  const t = tmpStateDir()
  try {
    // Only a foreign instance heartbeats; this workspace has no plugin.
    write(t.dir, "state_heartbeat_111.json", heartbeat({ workspace: "/ws/other", active_session_id: "ses_x" }))
    write(t.dir, sessionFileName("ses_x"), sessionFile("ses_x", "/ws/other", [m("running")]))
    const s = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.equal(s.status, "ok", "globally the plugin is alive")
    assert.equal(s.currentSession, null, "foreign active_session_id not adopted")
    assert.deepEqual(s.monitors, [], "no cross-workspace detail rows")
    // Unknown workspace (TUI without location) still falls back to any heartbeat.
    const unaware = readPanelState(t.dir, {})
    assert.equal(unaware.currentSession, "ses_x")
    assert.equal(unaware.monitors.length, 1)
  } finally {
    t.cleanup()
  }
})

test("corrupt files and unknown schemas are ignored", () => {
  const t = tmpStateDir()
  try {
    mkdirSync(t.dir, { recursive: true })
    write(t.dir, "state_heartbeat_111.json", heartbeat({ active_session_id: "ses_a" }))
    write(t.dir, sessionFileName("ses_a"), sessionFile("ses_a", "/ws/one", [m("running")]))
    writeFileSync(join(t.dir, "state_corrupt.json"), "{not json")
    write(t.dir, "state_ffffffffffff.json", { schema: 3, session_id: "ses_z" })
    const s = readPanelState(t.dir, { workspace: "/ws/one" })
    assert.equal(s.status, "ok")
    assert.equal(s.currentSession, "ses_a")
    assert.equal(s.monitors.length, 1)
  } finally {
    t.cleanup()
  }
})
