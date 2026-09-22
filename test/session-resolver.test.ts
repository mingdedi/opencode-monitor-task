import assert from "node:assert/strict"
import { test } from "node:test"
import { createSessionResolver } from "../src/session-resolver"
import type { PluginContext } from "../src/types"

function makeCtx() {
  return {
    tool: { transform: async () => {} },
    session: {},
    event: {
      subscribe: (_options?: { signal?: AbortSignal }) =>
        (async function* () {})() as AsyncIterable<unknown>,
    },
  } as unknown as PluginContext
}

test("resolves from the execute context and reuses it while fresh", async () => {
  const resolver = createSessionResolver(makeCtx(), { reuseWindowMs: 60_000 })
  await resolver.ready
  assert.equal(await resolver.resolve({ sessionID: "ses_fresh" }), "ses_fresh")
  // No sessionID on the context: the recent record is reused.
  assert.equal(await resolver.resolve({}), "ses_fresh")
  resolver.dispose()
})

test("stale remembered sessionID is not reused beyond the window", async () => {
  const resolver = createSessionResolver(makeCtx(), { reuseWindowMs: 40 })
  await resolver.ready
  assert.equal(await resolver.resolve({ sessionID: "ses_old" }), "ses_old")
  await new Promise((r) => setTimeout(r, 80))
  // Record is now older than the reuse window and no fallback applies
  // (session.status unavailable in this context) -> must resolve null rather
  // than deliver notifications to a possibly-wrong session.
  assert.equal(await resolver.resolve({}), null)
  resolver.dispose()
})

test("dispose aborts the event stream subscription", async () => {
  let aborted = false
  const ctx = {
    tool: { transform: async () => {} },
    session: {},
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => {
        options?.signal?.addEventListener("abort", () => (aborted = true))
        return (async function* () {
          await new Promise(() => {}) // never yields
        })() as AsyncIterable<unknown>
      },
    },
  } as unknown as PluginContext
  const resolver = createSessionResolver(ctx)
  await resolver.ready
  resolver.dispose()
  assert.ok(aborted, "subscription signal must be aborted on dispose")
})

test("list-shaped session.status is never mistaken for a session map", async () => {
  // If a host build returns an array, Object.keys yields indices ("0");
  // those must never be adopted as session ids — resolve null instead of
  // delivering notifications to a bogus session.
  const ctx = {
    tool: { transform: async () => {} },
    session: {
      status: async () => [{ id: "ses_real" }] as unknown as Record<string, unknown>,
    },
    event: {
      subscribe: () => (async function* () {})() as AsyncIterable<unknown>,
    },
  } as unknown as PluginContext
  const resolver = createSessionResolver(ctx, { reuseWindowMs: 0 })
  await resolver.ready
  assert.equal(await resolver.resolve({}), null)
  resolver.dispose()
})
