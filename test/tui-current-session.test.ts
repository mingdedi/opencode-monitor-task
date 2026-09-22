// Source ① of the current-session chain: which session the user is
// looking at. Signal preference under test:
// 1. ui.tabs.list() — the focused tab (active === true); covers Tab-key
//    switching the route data misses;
// 2. ui.router.current() — the session route;
// 3. remembered last value while a usable signal points at no session;
// Outcome contract (see CurrentSession): string = focused session;
// null = a usable signal, no session focused (empty state); undefined =
// no usable signal at all (reader falls back to source ②).
import assert from "node:assert/strict"
import { test } from "node:test"
import { createCurrentSessionGetter } from "../src/panel/current-session"
import type { TuiContext } from "../src/panel/types"

interface Signals {
  route?: () => unknown
  tabsEnabled?: () => unknown
  tabsList?: () => unknown
}

function ctxWith(signals: Signals): TuiContext {
  return {
    location: undefined,
    storage: undefined as unknown as TuiContext["storage"],
    theme: { text: { muted: "#888888" } },
    app: { version: "test" },
    ui: {
      slot: () => () => {},
      ...(signals.route ? { router: { current: signals.route } } : {}),
      ...(signals.tabsList || signals.tabsEnabled
        ? {
            tabs: {
              ...(signals.tabsEnabled ? { enabled: signals.tabsEnabled } : {}),
              ...(signals.tabsList ? { list: signals.tabsList } : {}),
            },
          }
        : {}),
    },
  }
}

const sessionRoute = (sid: string) => () => ({ type: "session", sessionID: sid })
const tabsWith = (items: unknown[]) => () => items
const tab = (sid: string, active = true) => ({ sessionID: sid, active })

test("focused tab wins (Tab-key switching the route misses)", () => {
  const g = createCurrentSessionGetter(
    ctxWith({
      route: sessionRoute("ses_route"),
      tabsEnabled: () => true,
      tabsList: tabsWith([tab("ses_aaa"), tab("ses_bbb", false)]),
    }),
  )
  assert.equal(g(), "ses_aaa", "active tab beats the route's session")
})

test("router fallback when tabs carry no active tab", () => {
  const g = createCurrentSessionGetter(
    ctxWith({
      route: sessionRoute("ses_route"),
      tabsEnabled: () => true,
      tabsList: tabsWith([tab("ses_aaa", false)]),
    }),
  )
  assert.equal(g(), "ses_route")
})

test("router fallback when tabs mode is disabled", () => {
  const g = createCurrentSessionGetter(
    ctxWith({
      route: sessionRoute("ses_route"),
      tabsEnabled: () => false,
      tabsList: tabsWith([tab("ses_aaa")]),
    }),
  )
  assert.equal(g(), "ses_route")
})

test("session route without tabs still resolves", () => {
  const g = createCurrentSessionGetter(ctxWith({ route: sessionRoute("ses_aaa") }))
  assert.equal(g(), "ses_aaa")
})

test("non-session route after a session -> remembered session", () => {
  let route: unknown = { type: "session", sessionID: "ses_aaa" }
  const g = createCurrentSessionGetter(ctxWith({ route: () => route }))
  assert.equal(g(), "ses_aaa")
  route = { type: "home" }
  assert.equal(g(), "ses_aaa", "detour through a non-session route keeps the panel")
  route = { type: "session", sessionID: "ses_bbb" }
  assert.equal(g(), "ses_bbb", "a new session route updates the memory")
})

test("tabs focused -> tabs active switching updates immediately", () => {
  let items: unknown[] = [tab("ses_aaa"), tab("ses_bbb", false)]
  const g = createCurrentSessionGetter(
    ctxWith({ tabsEnabled: () => true, tabsList: () => items }),
  )
  assert.equal(g(), "ses_aaa")
  items = [tab("ses_aaa", false), tab("ses_bbb")]
  assert.equal(g(), "ses_bbb")
})

test("usable signals, none pointing at a session, no memory -> null", () => {
  const g = createCurrentSessionGetter(
    ctxWith({ route: () => ({ type: "home" }), tabsEnabled: () => true, tabsList: tabsWith([]) }),
  )
  assert.equal(g(), null)
})

test("session route without a usable sessionID -> null, not undefined", () => {
  const g = createCurrentSessionGetter(
    ctxWith({ route: () => ({ type: "session", sessionID: 42 }) }),
  )
  assert.equal(g(), null)
})

test("no signals at all -> undefined (source ② stays in charge)", () => {
  const g = createCurrentSessionGetter(ctxWith({}))
  assert.equal(g(), undefined)
})

test("throwing signals -> undefined, never breaks the poll", () => {
  const g = createCurrentSessionGetter(
    ctxWith({
      route: () => {
        throw new Error("boom")
      },
      tabsEnabled: () => {
        throw new Error("boom")
      },
    }),
  )
  assert.equal(g(), undefined)
  assert.equal(g(), undefined)
})

test("tabs.list throwing degrades to the router", () => {
  const g = createCurrentSessionGetter(
    ctxWith({
      route: sessionRoute("ses_route"),
      tabsEnabled: () => true,
      tabsList: () => {
        throw new Error("boom")
      },
    }),
  )
  assert.equal(g(), "ses_route")
})

test("odd shapes degrade safely", () => {
  const g = createCurrentSessionGetter(ctxWith({ route: () => null }))
  assert.equal(g(), null)
  const g2 = createCurrentSessionGetter(ctxWith({ route: () => "session" }))
  assert.equal(g2(), null)
  const g3 = createCurrentSessionGetter(
    ctxWith({ tabsEnabled: () => true, tabsList: tabsWith([null, 42, "x"]) }),
  )
  assert.equal(g3(), null)
})

test("remembered session survives a signal error mid-detour", () => {
  let route: unknown = { type: "session", sessionID: "ses_aaa" }
  let throwNow = false
  const g = createCurrentSessionGetter(
    ctxWith({
      route: () => {
        if (throwNow) throw new Error("boom")
        return route
      },
    }),
  )
  assert.equal(g(), "ses_aaa")
  route = { type: "home" }
  throwNow = true
  // Error path returns undefined (source ② fallback for this poll) — safe:
  // the next successful poll resumes from the remembered session.
  assert.equal(g(), undefined)
  throwNow = false
  assert.equal(g(), "ses_aaa")
})
