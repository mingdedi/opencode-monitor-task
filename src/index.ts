import { createStateWriter, stateDir, workspaceRootOf } from "./state"
import { log, DEBUG } from "./log"
import { createRegistry, type Registry } from "./registry"
import { createSessionResolver } from "./session-resolver"
import { createTools } from "./tools"
import type { PluginContext } from "./types"

export default {
  id: "opencode-monitor-task",
  async setup(ctx: PluginContext) {
    // M6/M7 context probe (one-shot per instance): the top-level context
    // shape is undocumented and version-dependent; a keys line plus the
    // resolved location makes future workspace-resolution regressions
    // diagnosable. Off by default — it writes workspace paths into the
    // shared tmp log; set OPENCODE_MONITOR_TASK_DEBUG=1 to enable.
    if (DEBUG) {
      try {
        const c = ctx as unknown as Record<string, any>
        log(`ctx keys: ${Object.keys(c).join(",")}`)
        log(`ctx.location: ${JSON.stringify(c.location)?.slice(0, 300)}`)
      } catch (err) {
        log(`ctx probe failed: ${String(err)}`)
      }
    }
    const resolver = createSessionResolver(ctx)
    // The writer snapshots the registry before it exists — the closure only
    // evaluates at write time, after both objects are constructed.
    let registry!: Registry
    const dir = stateDir()
    const workspace = workspaceRootOf(ctx.location)
    const writer = createStateWriter({
      dir,
      workspace,
      activeSession: () => resolver.lastActive(),
      snapshot: () => registry.list(),
    })
    registry = createRegistry(ctx, resolver, {
      onChange: () => writer.change(),
    })

    await resolver.ready
    await ctx.tool.transform((editor) => {
      for (const tool of createTools(registry)) editor.add(tool)
    })

    log(`plugin loaded at ${ctx.location?.directory ?? "(unknown location)"}`)
    log(`state bridge: ${dir} (workspace ${workspace ?? "?"})`)

    return () => {
      registry.dispose()
      writer.dispose()
      resolver.dispose()
    }
  },
}
