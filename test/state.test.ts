// State bridge v2: per-session files + instance heartbeat under
// one dir. Writer behaviour: grouping, linger expiry, file cleanup, GC.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  createStateWriter,
  groupSessions,
  hashSessionId,
  heartbeatStatePath,
  sessionStatePath,
  stateDir,
  workspaceRootOf,
  type HeartbeatFile,
  type SessionStateFile,
} from "../src/state"
import type { PublicInfo } from "../src/registry"

test("stateDir honours XDG_DATA_HOME and falls back to ~/.local/share", () => {
  const home = process.env.HOME
  const xdg = process.env.XDG_DATA_HOME
  try {
    process.env.XDG_DATA_HOME = "/custom/xdg-data"
    assert.equal(stateDir(), "/custom/xdg-data/opencode/monitor-task")
    delete process.env.XDG_DATA_HOME
    process.env.HOME = "/home/tester"
    assert.equal(
      stateDir(),
      join("/home/tester", ".local", "share", "opencode", "monitor-task"),
    )
  } finally {
    if (xdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = xdg
    if (home !== undefined) process.env.HOME = home
  }
})

test("workspaceRootOf prefers project.canonical, then project.directory, then directory", () => {
  const realRoot = workspaceRootOf({ directory: "/tmp" })
  assert.ok(realRoot === "/tmp" || realRoot?.startsWith("/private/tmp"), "realpath-normalised")
  // Sub-directory open: project block wins over location.directory.
  assert.equal(
    workspaceRootOf({ directory: "/ws/proj/sub", project: { directory: "/ws/proj", canonical: "/ws/proj" } }),
    workspaceRootOf({ directory: "/ws/proj", project: { directory: "/ws/proj", canonical: "/ws/proj" } }),
  )
  assert.equal(workspaceRootOf({ directory: "/ws/x" }), workspaceRootOf({ directory: "/ws/x" }))
  assert.equal(workspaceRootOf({ directory: "relative/path" }), undefined)
  assert.equal(workspaceRootOf(undefined), undefined)
})

test("hashSessionId is stable and short", () => {
  assert.equal(hashSessionId("ses_abc"), hashSessionId("ses_abc"))
  assert.equal(hashSessionId("ses_abc").length, 12)
  assert.notEqual(hashSessionId("ses_abc"), hashSessionId("ses_abd"))
})

function tmpDir(): { dir: string; cleanup: () => void } {
  const parent = join(tmpdir(), "opencode")
  const dir = mkdtempSync(join(parent, "m7state-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function monitor(over: Partial<PublicInfo> = {}): PublicInfo {
  return {
    id: "mon_aaaaaaaa",
    command: "echo hi",
    description: "",
    state: "running",
    pid: 123,
    session_id: "ses_main",
    events_sent: 1,
    events_dropped: 0,
    lines_scanned: 2,
    lines_matched: null,
    max_events: 1000,
    idle_timeout_ms: 300000,
    directory: null,
    pattern: null,
    wake_mode: "all",
    delivery: "queue",
    coalesce_ms: 0,
    started_at: new Date().toISOString(),
    stopped_at: null,
    exit_info: null,
    idle_deadline: null,
    ...over,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("flush writes per-session files + heartbeat with the v2 contract", () => {
  const t = tmpDir()
  try {
    let calls = 0
    const w = createStateWriter({
      dir: t.dir,
      workspace: "/ws/proj",
      activeSession: () => "ses_main",
      snapshot: () => (calls++, [monitor()]),
    })
    w.flush()
    const sessionPath = sessionStatePath(t.dir, "ses_main")
    assert.ok(existsSync(sessionPath), "session file written")
    const parsed = JSON.parse(readFileSync(sessionPath, "utf8")) as SessionStateFile
    assert.equal(parsed.schema, 2)
    assert.equal(parsed.session_id, "ses_main")
    assert.equal(parsed.workspace, "/ws/proj")
    assert.equal(parsed.monitors.length, 1)
    const hb = JSON.parse(
      readFileSync(heartbeatStatePath(t.dir, process.pid, "/ws/proj"), "utf8"),
    ) as HeartbeatFile
    assert.equal(hb.schema, 2)
    assert.equal(hb.server_pid, process.pid)
    assert.equal(hb.workspace, "/ws/proj")
    assert.equal(hb.active_session_id, "ses_main")
    const residue = readdirSync(t.dir).filter((f) => f.endsWith(".tmp"))
    assert.deepEqual(residue, [], "no tmp files left behind")
    const beforeDispose = calls
    w.dispose()
    assert.equal(calls, beforeDispose + 1, "dispose writes one final snapshot")
  } finally {
    t.cleanup()
  }
})

test("same-process writers with different workspaces keep separate heartbeats", () => {
  const t = tmpDir()
  try {
    // Path shape: pid + 8-char workspace hash ("nows" when unknown).
    assert.match(heartbeatStatePath(t.dir, 4242), /state_heartbeat_4242_nows\.json$/)
    assert.match(
      heartbeatStatePath(t.dir, 4242, "/ws/one"),
      /state_heartbeat_4242_[0-9a-f]{8}\.json$/,
    )
    // Two instances inside ONE process (shared V2 server): same pid,
    // different workspaces. On the old pid-only key the second writer
    // silently clobbered the first.
    const one = createStateWriter({
      dir: t.dir,
      workspace: "/ws/one",
      activeSession: () => "ses_one",
      snapshot: () => [monitor({ session_id: "ses_one" })],
    })
    const two = createStateWriter({
      dir: t.dir,
      workspace: "/ws/two",
      activeSession: () => "ses_two",
      snapshot: () => [monitor({ id: "mon_b", session_id: "ses_two" })],
    })
    one.flush()
    two.flush()
    one.flush() // re-sync must not resurrect the clobber on any code path
    const hbOne = JSON.parse(
      readFileSync(heartbeatStatePath(t.dir, process.pid, "/ws/one"), "utf8"),
    ) as HeartbeatFile
    assert.equal(hbOne.workspace, "/ws/one")
    assert.equal(hbOne.active_session_id, "ses_one")
    const hbTwo = JSON.parse(
      readFileSync(heartbeatStatePath(t.dir, process.pid, "/ws/two"), "utf8"),
    ) as HeartbeatFile
    assert.equal(hbTwo.workspace, "/ws/two")
    assert.equal(hbTwo.active_session_id, "ses_two")
    const hbs = readdirSync(t.dir).filter((f) => /^state_heartbeat_/.test(f))
    assert.equal(hbs.length, 2, "one heartbeat file per instance")
    one.dispose()
    two.dispose()
  } finally {
    t.cleanup()
  }
})

test("groupSessions: active kept, finished capped at newest 1 per session", () => {
  const groups = groupSessions([
    monitor({ id: "mon_old1", state: "completed", stopped_at: "2026-09-22T10:00:00Z" }),
    monitor({ id: "mon_run1", session_id: "ses_main" }),
    monitor({ id: "mon_old2", state: "failed", stopped_at: "2026-09-22T11:00:00Z" }),
    monitor({ id: "mon_run2", session_id: "ses_other" }),
  ])
  assert.deepEqual([...groups.keys()], ["ses_main", "ses_other"])
  const main = groups.get("ses_main")!
  assert.equal(main.length, 2, "one active + newest terminal only")
  assert.deepEqual(
    main.map((m) => m.id),
    ["mon_run1", "mon_old2"],
  )
  assert.equal(groups.get("ses_other")!.length, 1)
})

test("finished-only session lingers then its file is deleted", async () => {
  const t = tmpDir()
  try {
    // stopped_at must be FIXED outside the snapshot closure, otherwise every
    // flush mints a fresh "now" and the linger window never expires.
    const stoppedAt = new Date().toISOString()
    const w = createStateWriter({
      dir: t.dir,
      workspace: undefined,
      activeSession: () => null,
      snapshot: () => [
        monitor({ state: "completed", stopped_at: stoppedAt, pid: null, exit_info: "exit code 0" }),
      ],
      lingerMs: 60,
    })
    w.flush()
    assert.ok(existsSync(sessionStatePath(t.dir, "ses_main")), "visible during linger")
    await sleep(90)
    w.flush()
    assert.ok(!existsSync(sessionStatePath(t.dir, "ses_main")), "deleted after linger")
    w.dispose()
  } finally {
    t.cleanup()
  }
})

test("session files are removed once their monitors vanish from the registry", () => {
  const t = tmpDir()
  try {
    let snap: PublicInfo[] = [monitor({ session_id: "ses_gone" })]
    const w = createStateWriter({
      dir: t.dir,
      workspace: undefined,
      activeSession: () => null,
      snapshot: () => snap,
    })
    w.flush()
    assert.ok(existsSync(sessionStatePath(t.dir, "ses_gone")))
    snap = []
    w.flush()
    assert.ok(!existsSync(sessionStatePath(t.dir, "ses_gone")), "orphan file cleaned")
    w.dispose()
  } finally {
    t.cleanup()
  }
})

test("two sessions land in two files; change() coalesces; dispose freezes", async () => {
  const t = tmpDir()
  try {
    let calls = 0
    const w = createStateWriter({
      dir: t.dir,
      workspace: undefined,
      activeSession: () => null,
      debounceMs: 20,
      snapshot: () => (
        calls++,
        [monitor({ session_id: "ses_a" }), monitor({ id: "mon_b", session_id: "ses_b" })]
      ),
    })
    w.change()
    w.change()
    w.change()
    assert.ok(!existsSync(sessionStatePath(t.dir, "ses_a")), "nothing before the window")
    await sleep(80)
    assert.ok(existsSync(sessionStatePath(t.dir, "ses_a")))
    assert.ok(existsSync(sessionStatePath(t.dir, "ses_b")))
    assert.equal(calls, 1, "three changes -> one snapshot")
    w.dispose()
    const after = calls
    w.change()
    w.flush()
    await sleep(80)
    assert.equal(calls, after, "no writes after dispose")
  } finally {
    t.cleanup()
  }
})

test("write failures are swallowed (side channel must not throw)", () => {
  const blocker = join(tmpdir(), "opencode", "m7blocker-" + Date.now())
  const w = createStateWriter({
    dir: blocker,
    workspace: undefined,
    activeSession: () => null,
    snapshot: () => [monitor()],
  })
  assert.doesNotThrow(() => w.flush())
  w.dispose()
})

test("snapshot errors are swallowed too (interval must never throw)", () => {
  const t = tmpDir()
  try {
    const w = createStateWriter({
      dir: t.dir,
      workspace: undefined,
      activeSession: () => null,
      snapshot: () => {
        throw new Error("boom")
      },
    })
    assert.doesNotThrow(() => w.flush())
    assert.doesNotThrow(() => w.dispose())
  } finally {
    t.cleanup()
  }
})

test("GC removes foreign files whose heartbeat died long ago", () => {
  const t = tmpDir()
  try {
    const w = createStateWriter({
      dir: t.dir,
      workspace: undefined,
      activeSession: () => null,
      snapshot: () => [monitor()],
    })
    // Foreign stale session file (heartbeat 11 minutes old) + fresh-ish tmp.
    const stale = join(t.dir, `state_${"f".repeat(12)}.json`)
    writeFileSync(
      stale,
      JSON.stringify({ schema: 2, heartbeat_at: new Date(Date.now() - 11 * 60_000).toISOString() }),
    )
    writeFileSync(join(t.dir, "state_deadbeef.json.999.tmp"), "{}")
    for (let i = 0; i < 12; i++) w.flush() // GC runs every 12th tick
    assert.ok(!existsSync(stale), "stale foreign file removed")
    assert.ok(existsSync(sessionStatePath(t.dir, "ses_main")), "own file survives")
    w.dispose()
  } finally {
    t.cleanup()
  }
})
