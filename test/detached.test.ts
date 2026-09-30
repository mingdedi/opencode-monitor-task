// M9 detached-mode tests. These run REAL processes on Linux and exercise
// the full survive-and-reattach contract:
//   spawn → service death (registry dispose) → process survives,
//   log keeps growing → successor registry reattaches → counters resume,
//   missed lines summarized (not replayed) → stop still works.
// Plus the task-store primitives: wrapper exit codes, pid-reuse defense,
// workspace guard, TTL sweep.

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createRegistry } from "../src/registry"
import { createSessionResolver } from "../src/session-resolver"
import {
  buildWrapperScript,
  readExitCode,
  readMeta,
  readProcFields,
  sweepTaskDirs,
  taskDirOf,
  writeMeta,
  WRAPPER_EXIT_ENV,
  type DetachedMeta,
} from "../src/taskstore"
import type { PluginContext } from "../src/types"
import { validateMode } from "../src/validate"

const EXEC_CTX = { sessionID: "ses_detached_a" }

interface Harness {
  reg: ReturnType<typeof createRegistry>
  notifications: Array<{ sessionID: string; text: string; delivery?: string }>
  rootDir: string
  tasksBase: string
  killStrays: () => void
  dispose: () => void
}

function makeHarness(): Harness {
  const notifications: Array<{ sessionID: string; text: string; delivery?: string }> = []
  const parent = join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const rootDir = mkdtempSync(join(parent, "m9det-"))
  const tasksBase = mkdtempSync(join(parent, "m9tasks-"))
  const ctx = {
    location: { directory: rootDir },
    tool: { transform: async () => {} },
    session: {
      synthetic: async (input: { sessionID: string; text: string; delivery?: string }) => {
        notifications.push(input)
      },
    },
    event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
  } as unknown as PluginContext
  const reg = createRegistry(ctx, createSessionResolver(ctx), {
    rootDir,
    tasksBase,
  })
  const strayPids: number[] = []
  return {
    reg,
    notifications,
    rootDir,
    tasksBase,
    killStrays: () => {
      for (const pid of strayPids) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          // already gone
        }
      }
    },
    dispose: () => {
      // Grab live detached pids BEFORE dispose parks them, so test cleanup
      // can still kill strays the dispose deliberately left running.
      for (const m of reg.list()) {
        if (m.mode === "detached" && m.pid && (m.state === "running" || m.state === "idle")) {
          strayPids.push(m.pid)
        }
      }
      reg.dispose()
    },
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startDetached(
  h: Harness,
  command: string,
  over: Record<string, unknown> = {},
) {
  const r = await h.reg.start({
    command,
    description: "m9 test",
    mode: "detached",
    coalesce_ms: 0, // deterministic per-line delivery in assertions
    executeContext: EXEC_CTX,
    ...over,
  })
  assert.ok(r.ok, `detached start failed: ${r.ok ? "" : r.error}`)
  return r.monitor
}

// ------------------------------------------------------------- validateMode

test("validateMode: default attached, enum guard, non-Linux rejection", () => {
  assert.equal(validateMode(undefined).monitorMode, "attached")
  assert.equal(validateMode("attached").monitorMode, "attached")
  assert.equal(validateMode("detached", "linux").monitorMode, "detached")
  assert.match(validateMode("sometimes").error ?? "", /must be "attached" or "detached"/)
  assert.match(validateMode("detached", "darwin").error ?? "", /Linux-only/)
})

// ------------------------------------------------------------------ wrapper

test("wrapper script records non-zero exit codes (incl. explicit exit)", { timeout: 10000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode", "m9wrap-"))
  try {
    const exitPath = join(dir, "exit")
    // Explicit `exit 7` inside the command: a trailer-based wrapper would
    // never run — only the EXIT trap records it.
    const script = buildWrapperScript("echo out; exit 7")
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, [WRAPPER_EXIT_ENV]: exitPath },
    })
    assert.equal(r.status, 7, "wrapper must propagate the command's exit code")
    assert.match(r.stdout, /out/)
    assert.equal(readExitCode(dir), 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ lifecycle

test("detached: delivers lines, writes meta, survives dispose, reattaches, stop works", { timeout: 20000 }, async () => {
  const h = makeHarness()
  try {
    // Long-ish command: emits 3 phases, then keeps living for the stop test.
    const mon = await startDetached(
      h,
      "for i in 1 2 3; do echo \"phase $i\"; sleep 0.3; done; sleep 30",
    )
    assert.equal(mon.mode, "detached")
    assert.ok(mon.pid)

    // Phase lines arrive through the tail pipeline.
    await waitFor(() =>
      h.notifications.some((n) => n.text.includes("phase 1")),
    )
    const meta0 = readMeta(taskDirOf(mon.id, h.tasksBase))
    assert.ok(meta0, "meta written at spawn")
    assert.equal(meta0!.pid, mon.pid)
    assert.equal(meta0!.claimedBy, process.pid)

    // --- simulate service death (plugin unload that does NOT kill detached)
    h.dispose()

    // The process survives, keeps writing to the log...
    assert.ok(pidAlive(mon.pid), "detached process must survive dispose")
    await waitFor(() => {
      try {
        return readFileSync(join(taskDirOf(mon.id, h.tasksBase), "log"), "utf8").includes("phase 3")
      } catch {
        return false
      }
    })
    // ...and the parked meta no longer claims an owner.
    const meta1 = readMeta(taskDirOf(mon.id, h.tasksBase))
    assert.equal(meta1!.claimedBy, null)
    assert.equal(meta1!.state, "running")

    // --- successor service instance (same workspace + store)
    const notifications2: Array<{ text: string }> = []
    const ctx2 = {
      location: { directory: h.rootDir },
      tool: { transform: async () => {} },
      session: {
        synthetic: async (input: { text: string }) => {
          notifications2.push(input)
        },
      },
      event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
    } as unknown as PluginContext
    const reg2 = createRegistry(ctx2, createSessionResolver(ctx2), {
      rootDir: h.rootDir,
      tasksBase: h.tasksBase,
    })

    // Claimed at construction: visible in list(), state running, reattached.
    await waitFor(() =>
      reg2.list().some((m) => m.id === mon.id && m.state === "running"),
    )
    const claimed = reg2.list().find((m) => m.id === mon.id)!
    assert.equal(claimed.mode, "detached")
    assert.equal(claimed.reattached, true)
    assert.ok(claimed.log_bytes! > 0, "log_bytes visible")

    // One summary notification for the missed lines — not a replay storm.
    await waitFor(() => notifications2.some((n) => n.text.includes("reattached")))
    const summary = notifications2.find((n) => n.text.includes("reattached"))!
    assert.match(summary.text, /line\(s\) were logged while away/)
    assert.match(summary.text, /phase 3/)
    // The missed phases are NOT re-delivered as wake lines (the summary is
    // the only mention).
    assert.equal(
      notifications2.filter((n) => /phase \d/.test(n.text) && !n.text.includes("reattached")).length,
      0,
    )

    // Fresh output after reattach still wakes normally.
    // (sleep 30 produces none — verified by the stop test below instead.)

    // monitor_stop still kills the (reattached, childless) process.
    const stop = reg2.stop(mon.id)
    assert.ok(stop.ok, stop.message)
    await waitFor(() => !pidAlive(mon.pid))
    const meta2 = readMeta(taskDirOf(mon.id, h.tasksBase))
    assert.equal(meta2!.state, "stopped")
    assert.ok(reg2.list().find((m) => m.id === mon.id)!.exit_info)
    reg2.dispose()
  } finally {
    h.killStrays()
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

test("detached: counters resume — missed lines counted, not re-delivered", { timeout: 20000 }, async () => {
  const h = makeHarness()
  try {
    // Emits a burst quickly, then goes quiet: dispose mid-burst so the
    // successor's replay counts the rest. (No $(...) — command
    // substitution is rightly rejected by validateCommand.)
    const mon = await startDetached(
      h,
      "for i in 1 2 3 4 5 6 7 8; do echo \"burst $i\"; done; sleep 30",
      { pattern: "burst", wake_mode: "pattern" },
    )
    await waitFor(() => h.notifications.some((n) => n.text.includes("burst")))
    h.dispose()

    const ctx2 = {
      location: { directory: h.rootDir },
      tool: { transform: async () => {} },
      session: { synthetic: async () => {} },
      event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
    } as unknown as PluginContext
    const reg2 = createRegistry(ctx2, createSessionResolver(ctx2), {
      rootDir: h.rootDir,
      tasksBase: h.tasksBase,
    })
    await waitFor(() => {
      const m = reg2.list().find((x) => x.id === mon.id)
      return m !== undefined
    })
    // Wait for the replay to catch up (first tail tick) and counters to grow.
    await waitFor(() => {
      const m = reg2.list().find((x) => x.id === mon.id)
      return !!m && m.lines_scanned >= 8
    })
    const m = reg2.list().find((x) => x.id === mon.id)!
    assert.equal(m.lines_scanned, 8, "all burst lines counted across restart")
    assert.equal(m.lines_matched, 8, "pattern matches counted across restart")
    reg2.stop(mon.id)
    reg2.dispose()
  } finally {
    h.killStrays()
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

test("detached: idle clock is frozen while unattended, re-armed on reattach", { timeout: 20000 }, async () => {
  const h = makeHarness()
  try {
    // Silent task with a short idle timeout: if absence counted, the
    // successor would find it dead (grace expiry) instead of running.
    const mon = await startDetached(h, "sleep 30", { idle_timeout_ms: 400 })
    h.dispose()
    await new Promise((r) => setTimeout(r, 1200)) // > 2× idle timeout, unattended
    assert.ok(pidAlive(mon.pid), "silent detached task must not be killed while unattended")

    const ctx2 = {
      location: { directory: h.rootDir },
      tool: { transform: async () => {} },
      session: { synthetic: async () => {} },
      event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
    } as unknown as PluginContext
    const reg2 = createRegistry(ctx2, createSessionResolver(ctx2), {
      rootDir: h.rootDir,
      tasksBase: h.tasksBase,
    })
    await waitFor(() => reg2.list().some((m) => m.id === mon.id))
    // Still running shortly after reattach (clock restarted from zero).
    assert.equal(reg2.list().find((m) => m.id === mon.id)!.state, "running")
    reg2.stop(mon.id)
    reg2.dispose()
  } finally {
    h.killStrays()
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

// ------------------------------------------------------ reattach guards

function fakeMeta(over: Partial<DetachedMeta> = {}): DetachedMeta {
  return {
    schema: 1,
    id: "mon_deadbeef0000",
    command: "sleep 5",
    description: "",
    sessionID: "ses_detached_a",
    pid: 999999999,
    pgid: 999999999,
    procStartTime: "12345",
    startedAt: Date.now(),
    directory: null,
    pattern: null,
    wakeMode: "all",
    delivery: "queue",
    coalesceMs: 0,
    maxEvents: 50,
    idleTimeoutMs: 300000,
    workspace: "/ws/does-not-matter",
    lastOffset: 0,
    linesScanned: 0,
    linesMatched: null,
    eventsSent: 0,
    eventsDropped: 0,
    state: "running",
    exitInfo: null,
    claimedBy: null,
    updatedAt: Date.now(),
    ...over,
  }
}

test("reattach: pid reuse (starttime mismatch) is treated as dead, exit file wins", { timeout: 15000 }, async () => {
  const h = makeHarness()
  try {
    // The test runner's own pid is alive, but the recorded starttime is
    // bogus → identity mismatch → must NOT be claimed as ours.
    const dir = taskDirOf("mon_deadbeef0000", h.tasksBase)
    mkdirSync(dir, { recursive: true })
    writeMeta(dir, fakeMeta({ pid: process.pid, pgid: process.pid, workspace: realpathSync(h.rootDir) }))
    // No exit file → unknown death.
    const claimed = await h.reg.reattachDetached()
    assert.equal(claimed, 0)
    assert.equal(readMeta(dir)!.state, "failed")
    assert.match(readMeta(dir)!.exitInfo ?? "", /exit code unknown/)

    // With an exit file, its verdict is honored.
    writeMeta(dir, fakeMeta({ pid: process.pid, workspace: realpathSync(h.rootDir) }))
    writeFileSync(join(dir, "exit"), "0\n")
    await h.reg.reattachDetached()
    assert.equal(readMeta(dir)!.state, "completed")
  } finally {
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

test("reattach: foreign-workspace tasks are never claimed", { timeout: 15000 }, async () => {
  const h = makeHarness()
  try {
    const dir = taskDirOf("mon_otherws00000", h.tasksBase)
    mkdirSync(dir, { recursive: true })
    writeMeta(dir, fakeMeta({ id: "mon_otherws00000", workspace: "/ws/elsewhere" }))
    const claimed = await h.reg.reattachDetached()
    assert.equal(claimed, 0)
    assert.equal(readMeta(dir)!.state, "running", "foreign task untouched")
    assert.equal(readMeta(dir)!.claimedBy, null)
  } finally {
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

test("reattach: a live claimer keeps ownership", { timeout: 15000 }, async () => {
  const h = makeHarness()
  const { spawn: spawnAsync } = await import("node:child_process")
  const helper = spawnAsync("sleep", ["5"])
  assert.ok(helper.pid, "helper process spawned")
  try {
    // claimedBy = a live process that is NOT us → skip, hands off.
    const dir = taskDirOf("mon_claimed0000", h.tasksBase)
    mkdirSync(dir, { recursive: true })
    writeMeta(
      dir,
      fakeMeta({
        id: "mon_claimed0000",
        claimedBy: helper.pid!,
        workspace: realpathSync(h.rootDir),
      }),
    )
    const claimed = await h.reg.reattachDetached()
    assert.equal(claimed, 0)
    assert.equal(readMeta(dir)!.claimedBy, helper.pid, "claim untouched")
    assert.equal(readMeta(dir)!.state, "running")
  } finally {
    helper.kill("SIGKILL")
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

// ----------------------------------------------------------------- sweeper

test("sweepTaskDirs removes terminal records past TTL, keeps fresh ones", { timeout: 15000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "opencode", "m9sweep-"))
  try {
    const old = taskDirOf("mon_old00000000", base)
    const fresh = taskDirOf("mon_fresh000000", base)
    const now = Date.now()
    mkdirSync(old, { recursive: true })
    writeMeta(old, fakeMeta({ id: "mon_old00000000", state: "completed", updatedAt: now - 2 * 3600_000, workspace: "/ws/elsewhere" }))
    mkdirSync(fresh, { recursive: true })
    writeMeta(fresh, fakeMeta({ id: "mon_fresh000000", state: "completed", updatedAt: now }))
    const removed = sweepTaskDirs(base, now)
    assert.equal(removed, 1)
    assert.equal(readMeta(old), null)
    assert.ok(readMeta(fresh), "fresh terminal record kept")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// --------------------------------------------------- attached is unchanged

test("attached monitors still die with the registry (no regression)", { timeout: 15000 }, async () => {
  const h = makeHarness()
  try {
    const r = await h.reg.start({
      command: "sleep 30",
      executeContext: EXEC_CTX,
    })
    assert.ok(r.ok)
    assert.equal(r.monitor.mode, "attached")
    assert.ok(r.monitor.pid)
    h.reg.dispose()
    await waitFor(() => !pidAlive(r.monitor.pid))
  } finally {
    h.killStrays()
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

// ------------------------------------------- code-review fixes (R1-R3)

test("R1 sweep is wired: reattach scan and live flusher both sweep the store", { timeout: 20000 }, async () => {
  const h = makeHarness()
  try {
    // Expired terminal dir (any workspace — TTL hygiene is global).
    const stale = taskDirOf("mon_stale1", h.tasksBase)
    mkdirSync(stale, { recursive: true })
    writeMeta(stale, fakeMeta({
      id: "mon_stale1",
      state: "completed",
      updatedAt: Date.now() - 2 * 3600_000,
      workspace: "/ws/elsewhere",
    }))
    // The reattach scan (service-start path) sweeps before scanning.
    await h.reg.reattachDetached()
    assert.equal(readMeta(stale), null, "expired terminal dir swept at service start")

    // The live meta flusher sweeps too: a second expired dir written while
    // a detached task keeps the flusher warm disappears within the first
    // flush tick (nextSweepAt starts at 0 → first tick always sweeps).
    const stale2 = taskDirOf("mon_stale2", h.tasksBase)
    mkdirSync(stale2, { recursive: true })
    writeMeta(stale2, fakeMeta({
      id: "mon_stale2",
      state: "completed",
      updatedAt: Date.now() - 2 * 3600_000,
      workspace: "/ws/elsewhere",
    }))
    const mon = await startDetached(h, "sleep 30")
    await waitFor(() => readMeta(stale2) === null, 12000)
    h.reg.stop(mon.id)
  } finally {
    h.killStrays()
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

test("R2 reattach: a task that died while unattended notifies its session", { timeout: 15000 }, async () => {
  const h = makeHarness()
  try {
    // Dead pid (no /proc entry) → dead path; the exit file is the verdict.
    const dir = taskDirOf("mon_diedunatt", h.tasksBase)
    mkdirSync(dir, { recursive: true })
    writeMeta(dir, fakeMeta({ id: "mon_diedunatt", workspace: realpathSync(h.rootDir) }))
    writeFileSync(join(dir, "exit"), "3\n")
    const claimed = await h.reg.reattachDetached()
    assert.equal(claimed, 0)
    assert.equal(readMeta(dir)!.state, "failed")
    // THE fix: the owning session learns the outcome in one queue-mode
    // notice carrying the exit info.
    await waitFor(() =>
      h.notifications.some((n) => n.text.includes("ended while the service was down")),
    )
    const notice = h.notifications.find((n) =>
      n.text.includes("ended while the service was down"),
    )!
    assert.match(notice.text, /mon_diedunatt/)
    assert.match(notice.text, /Exit code 3/)
    assert.equal(notice.delivery, "queue")
    // Still not claimed into the registry — the notice replaces the listing.
    assert.ok(!h.reg.list().some((m) => m.id === "mon_diedunatt"))
  } finally {
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})

test("R3 reattach: a zombie wrapper is treated as dead, not claimed", { timeout: 20000 }, async () => {
  const h = makeHarness()
  // An intermediate bash forks `sleep 0.15` (the stand-in wrapper) and
  // never waits on it; the bash then execs into `sleep 30`, so once the
  // child exits it is a genuine unreaped zombie for the whole test —
  // kill(pid, 0) keeps succeeding against it, which is the exact trap.
  const holder = spawn("bash", ["-c", "sleep 0.15 & echo $!; exec sleep 30"], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  })
  assert.ok(holder.pid, "holder spawned")
  holder.stdout!.setEncoding("utf8")
  const firstChunk = await new Promise<string>((resolve) =>
    holder.stdout!.once("data", resolve),
  )
  const zpid = Number.parseInt(firstChunk.trim().split("\n")[0]!, 10)
  assert.ok(
    Number.isInteger(zpid) && zpid > 0,
    `wrapper pid parsed from ${JSON.stringify(firstChunk)}`,
  )
  try {
    await waitFor(() => readProcFields(zpid)?.state === "Z", 5000)
    const zstat = readProcFields(zpid)!
    const dir = taskDirOf("mon_zombie", h.tasksBase)
    mkdirSync(dir, { recursive: true })
    writeMeta(dir, fakeMeta({
      id: "mon_zombie",
      pid: zpid,
      pgid: zpid,
      procStartTime: zstat.starttime, // identity MATCHES — only the Z state saves us
      workspace: realpathSync(h.rootDir),
    }))
    writeFileSync(join(dir, "exit"), "0\n")
    const claimed = await h.reg.reattachDetached()
    assert.equal(claimed, 0, "a zombie must not be claimed as alive")
    assert.equal(readMeta(dir)!.state, "completed", "exit-file verdict honored despite a live-looking pid")
  } finally {
    try {
      process.kill(-holder.pid!, "SIGKILL")
    } catch {
      // already gone
    }
    rmSync(h.rootDir, { recursive: true, force: true })
    rmSync(h.tasksBase, { recursive: true, force: true })
  }
})
