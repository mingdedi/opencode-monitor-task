// TUI-plugin entrypoint (second runtime of the dual-entry plugin package).
// The server side lives in ./index.ts (default export); this file is reached
// via the package "./tui" export or the root tui.ts shim installed by
// scripts/install-local.sh.
//
// IMPORTANT: this module must have ZERO bare-specifier imports at the top
// level. The host resolves bare @opentui/* / @opencode/* specifiers ONLY in
// the entry file it actually scanned. Verified live: v2.0.11 rejected
// "@opencode/plugin imported from .../src/tui.ts" (shim re-export = not the
// entry), and v2.2.5 rejected "@opentui/solid imported from
// .../src/panel/view.ts" (dynamic import from the entry = still not the
// entry), while a single-file plugin (statusline) importing the same
// specifiers top-level loads fine on the same build. Hence this shape:
//
//   root tui.ts (THE entry)  →  imports @opentui/solid/jsx-runtime itself
//   └─ defineTuiPlugin(host) →  hands jsx/jsxs down to the panel
//
// Every other host API is still imported dynamically inside setup, where
// failures degrade to a logged skip instead of a module resolution error.
// The server process loads only the "." export (index.ts); it never
// evaluates this file (verified on v2.2.5: a probe entry with top-level
// side effects left no trace across server plugin reloads).
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const logFile = join(tmpdir(), "opencode-monitor-tui.log")
// Same flag as the server-side log.ts: gates the context-shape probes.
// Reads process.env directly — this entry keeps its imports node:-only.
const DEBUG = process.env.OPENCODE_MONITOR_TASK_DEBUG === "1"
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

/** jsx-runtime pair supplied by the real entry file (root tui.ts). */
export interface HostJsx {
  jsx: (tag: string, props: Record<string, unknown>) => unknown
  jsxs: (tag: string, props: Record<string, unknown>) => unknown
}

/**
 * Build the TUI plugin definition.
 *
 * @param host jsx-runtime pair imported by the plugin ENTRY file — the only
 * place the host resolves @opentui/* specifiers. The install-local shims
 * always provide it. When absent (this file loaded directly as the entry,
 * e.g. through the package "./tui" export on a host that resolves the
 * specifier there) setup falls back to a dynamic import and logs a skip if
 * that too fails.
 */
export function defineTuiPlugin(host?: HostJsx): TuiPluginDefinition {
  return {
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
        // Off by default — it writes workspace paths into the shared tmp log;
        // set OPENCODE_MONITOR_TASK_DEBUG=1 to enable.
        if (DEBUG) {
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
          // candidate for "current session" (source ①). Capture the shape of
          // its session/project/location entries and its on/listen subscribe
          // pair — values only, no speculative calls (side-effect risk in the
          // host).
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
        }
        // jsx-runtime: prefer the pair handed down by the entry file. The
        // dynamic fallback only has a chance when THIS file is itself the
        // scanned entry (see header note); anywhere else it throws and we
        // log a skip — a missing panel must not take the TUI down.
        let jsxRt: HostJsx | undefined = host
        if (!jsxRt) {
          try {
            const m: {
              jsx: HostJsx["jsx"]
              jsxs?: HostJsx["jsxs"]
            } = await import("@opentui/solid/jsx-runtime")
            jsxRt = { jsx: m.jsx, jsxs: m.jsxs ?? m.jsx }
            log("jsx runtime: dynamic import at entry")
          } catch (err) {
            log(
              `no jsx runtime (host param absent, dynamic import failed): ${String(err).slice(0, 120)}`,
            )
            return () => {}
          }
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
          jsx: jsxRt.jsx,
          jsxs: jsxRt.jsxs,
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
  }
}

// Default export keeps the "./tui" package export loadable on hosts that
// inject specifiers at this file (it then self-supplies via the dynamic
// fallback); shim installs never take this path.
export default defineTuiPlugin()
