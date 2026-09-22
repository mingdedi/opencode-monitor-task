// Source ① of the current-session chain: which session is
// the user LOOKING at, straight from the TUI.
//
// Two host signals exist (as of v2.0.11),
// and they do NOT always agree:
// - ui.tabs.list() — the live session-tab set; the focused tab carries
//   active === true (sessionTabs.current() === sessionID). This is the
//   authoritative "focused session" signal, including Tab-key switching.
// - ui.router.current() — the route data; its session variant is
//   {type: "session", sessionID}. Route data follows leader navigation
//   but was observed lagging behind tab switches / detouring through
//   non-session routes, so it is only the fallback.
//
// With neither signal the getter returns undefined ("source ① unusable")
// and the reader falls back to the heartbeat hint (source ②); a usable
// signal that points at no session yields null (empty state — adopting
// the heartbeat's hint there is exactly the cross-session detail leak
// source ① exists to prevent).
//
// Undocumented API — every access is probed defensively and never throws.
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TuiContext } from "./types"

const logFile = join(tmpdir(), "opencode-monitor-tui.log")
const log = (s: string) => {
  try {
    appendFileSync(logFile, s + "\n")
  } catch {
    // Diagnostics only.
  }
}

/**
 * What source ① reports for "the session this panel is viewed from":
 * - string — the focused session's id;
 * - null — a usable signal says NO session is focused (panel collapses
 *   to the empty state; the heartbeat hint must NOT be adopted — that
 *   is another session's view);
 * - undefined — no usable signal at all (old host; reader falls back to
 *   the heartbeat hint, source ②).
 */
export type CurrentSession = string | null | undefined

interface RouteDataLike {
  type?: unknown
  sessionID?: unknown
}

interface TabLike {
  sessionID?: unknown
  active?: unknown
}

interface TabsLike {
  enabled?: () => unknown
  list?: () => unknown
}

interface RouterLike {
  current?: () => unknown
}

/** Read the focused tab's session id: string = focused, null = tabs on
 *  but nothing focused, undefined = tabs not usable as a signal. */
function viaTabs(ui: TuiContext["ui"]): string | null | undefined {
  try {
    const tabs = (ui as { tabs?: TabsLike } | undefined)?.tabs
    if (typeof tabs?.enabled !== "function" || typeof tabs?.list !== "function") {
      return undefined
    }
    if (tabs.enabled() !== true) return undefined
    const items = tabs.list()
    if (!Array.isArray(items)) return undefined
    for (const t of items) {
      if (t !== null && typeof t === "object" && (t as TabLike).active === true) {
        const sid = (t as TabLike).sessionID
        if (typeof sid === "string" && sid !== "") return sid
        break
      }
    }
    return null
  } catch {
    return undefined
  }
}

/** Read the router's session route: string = focused, null = usable but
 *  not on a session route, undefined = router not usable. */
function viaRouter(ui: TuiContext["ui"]): string | null | undefined {
  try {
    const router = (ui as { router?: RouterLike } | undefined)?.router
    if (typeof router?.current !== "function") return undefined
    const r = router.current()
    if (r !== null && typeof r === "object" && (r as RouteDataLike).type === "session") {
      const sid = (r as RouteDataLike).sessionID
      return typeof sid === "string" && sid !== "" ? sid : null
    }
    return null
  } catch {
    return undefined
  }
}

export function createCurrentSessionGetter(
  context: TuiContext,
): () => CurrentSession {
  // Last valid focused session: a brief signal detour (home route, a
  // tabs hiccup) must not blank the panel — the window keeps its last
  // session while the user checks something else.
  let remembered: string | null = null
  let lastLogged: string | undefined

  return () => {
    const tabs = viaTabs(context.ui)
    const route = viaRouter(context.ui)

    // Focused tab wins (covers Tab-key switching the route data misses);
    // the router's session route is the fallback. Neither being a string
    // means no live pointer: keep the remembered session, else the empty
    // state. No usable signal at all -> undefined (source ② takes over).
    let outcome: CurrentSession
    let source: string
    if (typeof tabs === "string") {
      outcome = tabs
      source = "tabs"
    } else if (typeof route === "string") {
      outcome = route
      source = "route"
    } else if (tabs !== undefined || route !== undefined) {
      outcome = remembered
      source = "kept"
    } else {
      outcome = undefined
      source = "unavailable"
    }

    if (typeof outcome === "string") remembered = outcome
    const key =
      outcome === undefined
        ? "unavailable"
        : outcome === null
          ? "null (no session focused)"
          : `${source}:${outcome.slice(0, 12)}`
    if (key !== lastLogged) {
      lastLogged = key
      log(`session view: ${key}`)
    }
    return outcome
  }
}
