// TUI-plugin entrypoint (second runtime of the dual-entry plugin package).
// The server side lives in ./index.ts (default export); this file is reached
// via the package "./tui" export or the root tui.ts shim installed by
// scripts/install-local.sh.
//
// IMPORTANT: this module must have ZERO bare-specifier imports at the top
// level. Host module injection (@opencode/plugin, @opentui/*) turned out to be
// unreliable for files re-exported through a shim (verified live on v2.0.11:
// "Cannot find package '@opencode/plugin' imported from .../src/tui.ts",
// while a single-file plugin importing the same specifier loads fine). So the
// entry is a plain { id, setup } object — Plugin.define() is an identity
// function — and every host-provided module is imported dynamically inside
// setup, where failures degrade to a logged skip instead of a module
// resolution error. The server process also scans plugin dirs and loads this
// file; it lacks TUI APIs, which the storage probe catches.
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const logFile = join(tmpdir(), "opencode-monitor-tui.log")
const log = (s: string) => {
  try {
    appendFileSync(logFile, s + "\n")
  } catch {
    // Diagnostics only.
  }
}

export interface TuiPluginDefinition {
  readonly id: string
  readonly setup: (
    context: any,
  ) => Promise<void | (() => void)> | void | (() => void)
}

export default {
  id: "opencode-monitor-task",
  async setup(context: any) {
    try {
      // Probe: a TUI context carries storage.memory; the server context does
      // not — bail out quietly when this file is loaded by the server scan.
      if (typeof context?.storage?.memory !== "function") {
        log("skip: no TUI storage (server-side scan)")
        return () => {}
      }
      log(`tui start app=${context.app?.version} platform=${process.platform}`)
      // M7 probe (one-shot per TUI load): the TUI context shape is
      // undocumented; capture top-level keys plus one level of object keys
      // to find whether a "current session" source exists (source ① of the
      // session-scope panel) and what `location` actually carries.
      try {
        const c = context as Record<string, unknown>
        const shape = Object.keys(c)
          .map((k) => {
            const v = c[k]
            if (v !== null && typeof v === "object") {
              try {
                return `${k}:{${Object.keys(v as object).slice(0, 10).join("/")}}`
              } catch {
                return `${k}:{?}`
              }
            }
            return `${k}:${typeof v}`
          })
          .join(" ")
        log(`tui ctx shape: ${shape.slice(0, 1200)}`)
        log(`tui location: ${JSON.stringify(c.location)?.slice(0, 300)}`)
      } catch (err) {
        log(`tui ctx probe failed: ${String(err).slice(0, 120)}`)
      }
      // M7 deep probe (one-shot): the `data` domain looked like the best
      // candidate for "current session" (source ①). Capture the shape of its
      // session/project/location entries and its on/listen subscribe pair —
      // values only, no speculative calls (side-effect risk in the host).
      try {
        const c = context as Record<string, unknown>
        const d = c.data as Record<string, unknown> | undefined
        const desc = (v: unknown): string => {
          if (typeof v === "function")
            return `fn(arity ${String((v as (...a: unknown[]) => unknown).length)})`
          if (v === null) return "null"
          if (Array.isArray(v)) return `array[${v.length}]`
          if (typeof v === "object")
            try {
              return `{${Object.keys(v as object).slice(0, 10).join("/")}}`
            } catch {
              return "{?}"
            }
          return `${typeof v}:${String(v).slice(0, 60)}`
        }
        if (d) {
          log(
            `tui data.session: ${desc(d.session)} project: ${desc(d.project)} location: ${desc(d.location)}`,
          )
          log(`tui data.on: ${desc(d.on)} listen: ${desc(d.listen)}`)
        } else {
          log("tui data domain absent")
        }
      } catch (err) {
        log(`tui data probe failed: ${String(err).slice(0, 120)}`)
      }
      const { createPanel } = await import("./panel/view")
      const { createCurrentSessionGetter } = await import(
        "./panel/current-session"
      )
      // Source ①: the TUI router knows which session this window
      // is actually looking at; the heartbeat hint (source ②) only knows
      // which session last ran a tool in the workspace — with two sessions
      // in one workspace that renders the OTHER session's monitor rows.
      // Degrades to undefined (→ source ②) on builds without a router.
      const panel = createPanel(context, {
        currentSession: createCurrentSessionGetter(context),
      })
      const off = context.ui.slot({
        append: "sidebar.content",
        render: () => panel.el(),
      })
      log("claimed sidebar.content")
      return () => {
        off()
        panel.dispose()
        log("tui cleanup")
      }
    } catch (err) {
      // A broken panel must never take the whole TUI down.
      log(`setup error ${String(err).slice(0, 160)}`)
      return () => {}
    }
  },
} satisfies TuiPluginDefinition
