import { log } from "./log"
import type { PluginContext } from "./types"

// The V2 plugin docs only document `signal` and `progress` on tool execute
// contexts — no sessionID. This resolver combines several strategies,
// remembers which one worked, and logs enough diagnostics to debug quickly.

export interface SessionResolver {
  /** Resolves once hook registrations have been attempted. */
  ready: Promise<void>
  /** Best-effort resolve of the session that invoked a tool. */
  resolve(executeContext: unknown): Promise<string | null>
  lastKnown(): string | null
  /**
   * Session that last executed ANY tool in this instance (not just monitor
   * tools) — the "active session" hint for the session-scoped panel
   * (source ②). Per-project instances each track their own workspace's
   * activity, so this needs no extra scoping.
   */
  lastActive(): string | null
  /** Abort background event subscription (plugin unload / hot reload). */
  dispose(): void
}

export interface SessionResolverOptions {
  /**
   * A remembered sessionID may only be reused within this window after it
   * was last observed. Guards against delivering notifications to a stale
   * session when the execute context carries no sessionID. Default 30s.
   */
  reuseWindowMs?: number
}

export function createSessionResolver(
  ctx: PluginContext,
  options: SessionResolverOptions = {},
): SessionResolver {
  const reuseWindowMs = options.reuseWindowMs ?? 30_000
  let lastSessionID: string | null = null
  let lastSessionAt = 0
  let via = ""
  let probedContext = false
  let probedHook = false
  let probedAnyTool = false
  let lastActiveSessionID: string | null = null
  const streamAbort = new AbortController()

  function record(sid: unknown, source: string): boolean {
    if (typeof sid === "string" && sid !== "") {
      lastSessionID = sid
      lastSessionAt = Date.now()
      via = source
      return true
    }
    return false
  }

  // Strategy 1: probe the tool execute context object itself.
  function probeContext(context: unknown): boolean {
    if (!context || typeof context !== "object") return false
    const c = context as Record<string, unknown>
    if (!probedContext) {
      probedContext = true
      log(`execute context keys: ${Object.keys(c).join(",") || "(none)"}`)
      // M6 workspace probe: dump the full structure once so unknown fields
      // (agent, directory, worktree...) can be identified from real sessions.
      try {
        log(`execute context dump: ${JSON.stringify(c).slice(0, 600)}`)
      } catch {
        // Non-serialisable context: keys list above is all we get.
      }
    }
    if (record(c.sessionID, "execute context .sessionID")) return true
    const session = c.session as Record<string, unknown> | undefined
    if (session && record(session.id, "execute context .session.id")) return true
    return false
  }

  // Strategy 2: tool execute.before hook events (expected to carry sessionID).
  const hookReady = (async () => {
    try {
      if (typeof ctx.tool?.hook !== "function") {
        log("ctx.tool.hook unavailable in this build")
        return
      }
      await ctx.tool.hook("execute.before", (event: unknown) => {
        const e = event as Record<string, any> | null
        // M7 probe (one-shot): dump the FIRST execute.before event of ANY
        // tool — the existing dump below only fires for monitor tools.
        // lastActive() (session-scope panel, source ②) will key off
        // non-monitor events; confirm they carry sessionID first.
        if (!probedAnyTool) {
          probedAnyTool = true
          try {
            log(`execute.before any-tool dump: ${JSON.stringify(e).slice(0, 400)}`)
          } catch {
            // ignore
          }
        }
        if (!e || typeof e.tool !== "string" || !e.tool.startsWith("monitor")) {
          // Non-monitor tool execution: still the best signal of "which
          // session is the user currently working in" (source ②).
          if (e && typeof e.sessionID === "string" && e.sessionID !== "") {
            lastActiveSessionID = e.sessionID
          }
          return
        }
        if (!probedHook) {
          probedHook = true
          try {
            log(`execute.before dump: ${JSON.stringify(e).slice(0, 600)}`)
          } catch {
            // ignore
          }
        }
        if (record(e.sessionID, "tool.hook execute.before")) return
        if (e.session && record(e.session.id, "tool.hook execute.before .session.id")) return
      })
    } catch (err) {
      log(`tool.hook registration failed: ${String(err)}`)
    }
  })()

  // Strategy 3: scan the public event stream for executions of our tools.
  void (async () => {
    try {
      const stream = ctx.event.subscribe({ signal: streamAbort.signal })
      for await (const event of stream) {
        if (!event || typeof event !== "object") continue
        const e = event as Record<string, any>
        const type = String(e.type ?? "")
        if (!type.includes("tool")) continue
        const encoded = JSON.stringify(event)
        if (!encoded.includes("monitor")) continue
        if (record(e.sessionID, `event ${type}`)) continue
        const props = e.properties ?? e
        if (record(props.sessionID, `event ${type} .properties.sessionID`)) continue
      }
    } catch {
      // Stream ended, unavailable, or disposed; other strategies still work.
    }
  })()

  // M6 workspace probe (one-shot): dump session.status() so the session info
  // shape (directory field?) can be established from real sessions.
  // REMOVED after probing: under a shared service session.status() never
  // resolves from plugin context, and ctx.location (per-project instance)
  // turned out to carry the authoritative workspace root directly.

  return {
    ready: hookReady,
    async resolve(executeContext: unknown) {
      if (probeContext(executeContext)) {
        log(`sessionID resolved via ${via}: ${lastSessionID}`)
        return lastSessionID
      }
      const fresh = Date.now() - lastSessionAt <= reuseWindowMs
      if (lastSessionID && fresh) {
        log(`sessionID reused from ${via}: ${lastSessionID}`)
        return lastSessionID
      }
      if (lastSessionID) {
        log(`discarding stale sessionID ${lastSessionID} (seen ${Math.round((Date.now() - lastSessionAt) / 1000)}s ago)`)
      }
      // Strategy 4 (fallback): if exactly one session is active, it is us.
      try {
        if (typeof ctx.session.status === "function") {
          const status = await ctx.session.status()
          // Pure-numeric keys are array indices from a list-shaped status
          // payload, not session ids. Never adopt one: failing to resolve is
          // safer than delivering notifications to a bogus session.
          const ids = Object.keys(status ?? {}).filter((k) => !/^\d+$/.test(k))
          if (ids.length === 1 && record(ids[0], "session.status sole active session")) {
            log(`sessionID resolved via ${via}: ${lastSessionID}`)
            return lastSessionID
          }
          log(`session.status fallback ambiguous: ${ids.length} active sessions`)
        }
      } catch (err) {
        log(`session.status fallback failed: ${String(err)}`)
      }
      log("sessionID could not be resolved")
      return null
    },
    lastKnown: () => lastSessionID,
    lastActive: () => lastActiveSessionID,
    dispose: () => {
      streamAbort.abort()
    },
  }
}
