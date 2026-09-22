// M5 bridge tests: the registry must notify the state writer on every
// mutation and expose pid/state for the sidebar panel.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createRegistry } from "../src/registry"
import { createSessionResolver } from "../src/session-resolver"
import type { PluginContext } from "../src/types"

interface Harness {
  reg: ReturnType<typeof createRegistry>
  changes: number
  cleanup: () => void
}

function makeHarness(): Harness {
  const parent = join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const rootDir = mkdtempSync(join(parent, "m5reg-"))
  const ctx = {
    location: { directory: rootDir },
    tool: { transform: async () => {} },
    session: {
      synthetic: async () => {},
    },
    event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
  } as unknown as PluginContext
  let changes = 0
  const reg = createRegistry(ctx, createSessionResolver(ctx), {
    rootDir,
    onChange: () => changes++,
  })
  return {
    reg,
    get changes() {
      return changes
    },
    cleanup: () => {
      reg.stopAll("test cleanup")
      try {
        rmSync(rootDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

test("start -> running with pid, onChange fired (starting + running + lines)", async () => {
  const h = makeHarness()
  try {
    const r = await h.reg.start({
      command: "echo one; sleep 0.3; echo two",
      executeContext: { sessionID: "ses_m5" },
    })
    assert.ok(r.ok)
    assert.equal(r.monitor.state, "running")
    assert.equal(typeof r.monitor.pid, "number")
    assert.ok(r.monitor.pid! > 0)
    assert.equal(r.monitor.session_id, "ses_m5", "PublicInfo carries the owning session")
    const afterStart = h.changes
    assert.ok(afterStart >= 2, `starting + running notifies (got ${afterStart})`)
    await waitFor(() => h.changes > afterStart)
    await waitFor(() => h.reg.list().some((m) => m.exit_info !== null))
    assert.ok(h.changes > afterStart, "line events and finalize bump onChange")
    const done = h.reg.list().find((m) => m.id === r.monitor.id)!
    assert.equal(done.state, "completed")
  } finally {
    h.cleanup()
  }
})

test("monitor_list exposes pid", async () => {
  const h = makeHarness()
  try {
    const r = await h.reg.start({
      command: "sleep 5",
      executeContext: { sessionID: "ses_m5" },
    })
    assert.ok(r.ok)
    const listed = h.reg.list().find((m) => m.id === r.monitor.id)
    assert.ok(listed)
    assert.equal(typeof listed!.pid, "number")
  } finally {
    h.cleanup()
  }
})

test("onChange callback errors are swallowed", async () => {
  const parent = join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const rootDir = mkdtempSync(join(parent, "m5reg-"))
  const ctx = {
    location: { directory: rootDir },
    tool: { transform: async () => {} },
    session: { synthetic: async () => {} },
    event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
  } as unknown as PluginContext
  const reg = createRegistry(ctx, createSessionResolver(ctx), {
    rootDir,
    onChange: () => {
      throw new Error("boom")
    },
  })
  const r = await reg.start({
    command: "echo hi",
    executeContext: { sessionID: "ses_m5" },
  })
  assert.ok(r.ok, "a throwing onChange must not break start()")
  reg.stopAll("cleanup")
  rmSync(rootDir, { recursive: true, force: true })
})
