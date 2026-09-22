// M6: workspace-root resolution. The registry must treat the CALLING
// workspace (per-project plugin instance location) as root, not the shared
// server's process cwd.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createRegistry, resolveRootDir } from "../src/registry"
import { createSessionResolver } from "../src/session-resolver"
import type { PluginContext } from "../src/types"

function ctxWithLocation(directory?: string): PluginContext {
  return {
    location: directory === undefined ? undefined : { directory },
    tool: { transform: async () => {} },
    session: { synthetic: async () => {} },
    event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
  } as unknown as PluginContext
}

test("resolveRootDir prefers location, then project fields, then cwd", () => {
  const cwd = process.cwd()
  assert.equal(resolveRootDir(ctxWithLocation("/ws/a")), "/ws/a")
  assert.equal(resolveRootDir({ ...ctxWithLocation(), location: { project: { directory: "/ws/b" } } }), "/ws/b")
  assert.equal(
    resolveRootDir({ ...ctxWithLocation(), location: { project: { canonical: "/ws/c" } } }),
    "/ws/c",
  )
  // Relative or missing values must never be adopted as roots.
  assert.equal(resolveRootDir({ ...ctxWithLocation(), location: { directory: "relative/path" } }), cwd)
  assert.equal(resolveRootDir(ctxWithLocation()), cwd)
})

test("registry without explicit rootDir spawns in the location workspace", async () => {
  const parent = join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const ws = mkdtempSync(join(parent, "m6ws-"))
  const notifications: string[] = []
  const ctx = {
    location: { directory: ws },
    tool: { transform: async () => {} },
    session: {
      synthetic: async (input: { text: string }) => {
        notifications.push(input.text)
      },
    },
    event: { subscribe: () => (async function* () {})() as AsyncIterable<unknown> },
  } as unknown as PluginContext
  const reg = createRegistry(ctx, createSessionResolver(ctx)) // no rootDir option!
  try {
    const r = await reg.start({
      command: "pwd",
      executeContext: { sessionID: "ses_m6" },
    })
    assert.ok(r.ok)
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !notifications.some((n) => n.includes(ws))) {
      await new Promise((res) => setTimeout(res, 50))
    }
    assert.ok(
      notifications.some((n) => n.includes(ws)),
      `child ran in the location workspace (pwd output); got: ${notifications.join(" | ")}`,
    )
  } finally {
    reg.stopAll("cleanup")
    rmSync(ws, { recursive: true, force: true })
  }
})
