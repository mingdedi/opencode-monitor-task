// Sidebar panel runtime: polls the state bridge file on an interval and
// renders the line model into the sidebar.content slot. Follows the proven
// patterns of the statusline plugin — a static jsx-runtime import (the host
// resolves it inside the TUI process; ambient types cover typecheck),
// storage.memory as the reactive store (survives hot reloads), and a probe
// log for load diagnostics.
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as jsxrt from "@opentui/solid/jsx-runtime"
import { stateDir, workspaceRootOf } from "../state"
import { renderLines, type Line } from "./format"
import type { CurrentSession } from "./current-session"
import { readPanelState } from "./reader"
import type { TuiContext } from "./types"

const logFile = join(tmpdir(), "opencode-monitor-tui.log")
const log = (s: string) => {
  try {
    appendFileSync(logFile, s + "\n")
  } catch {
    // Diagnostics only.
  }
}

const jsx = jsxrt.jsx
const jsxs = jsxrt.jsxs ?? jsxrt.jsx

export interface PanelHandle {
  el: () => unknown
  dispose: () => void
}

export interface PanelOptions {
  pollMs?: number
  /**
   * Source ① of the current-session chain: the session the TUI router is
   * focused on (see createCurrentSessionGetter). Three states — string /
   * null (no session focused → empty state) / undefined (no usable router
   * → the reader falls back to the heartbeat hint, source ②).
   */
  currentSession?: () => CurrentSession
}

export function createPanel(
  context: TuiContext,
  opts: PanelOptions = {},
): PanelHandle {
  const pollMs = opts.pollMs ?? 500
  const dir = stateDir()
  const workspace = workspaceRootOf(context.location)
  const muted = context.theme.text.muted

  const [store, updateStore] = context.storage.memory("opencode-monitor-task", {
    initial: { lines: [] as Line[] },
  })

  const refresh = () => {
    try {
      const lines = renderLines(
        readPanelState(dir, {
          workspace,
          // Three-valued on purpose: undefined keeps source ② alive on
          // hosts without a router; null must collapse to the empty state.
          currentSession: opts.currentSession?.(),
        }),
      )
      updateStore((draft) => {
        draft.lines = lines
      })
    } catch (err) {
      log(`refresh error ${String(err).slice(0, 120)}`)
    }
  }

  refresh()
  const timer = setInterval(refresh, pollMs)
  log(`panel polling ${dir} every ${pollMs}ms (workspace ${workspace ?? "?"})`)

  const el = () => {
    try {
      if (store.lines.length === 0) return jsx("text", { children: "" })
      const children = store.lines.map((l) =>
        l.tone === "dim"
          ? jsx("text", { fg: muted, children: l.text })
          : jsx("text", { children: l.text }),
      )
      return jsxs("box", { flexDirection: "column", children })
    } catch (err) {
      log(`render error ${String(err).slice(0, 120)}`)
      return jsx("text", { children: "" })
    }
  }

  return {
    el,
    dispose: () => {
      clearInterval(timer)
      log("panel disposed")
    },
  }
}
