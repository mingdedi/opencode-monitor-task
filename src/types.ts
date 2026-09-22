// Minimal structural types for the OpenCode V2 plugin context.
// Kept local so the plugin has zero runtime dependencies; swap to
// @opencode/plugin types when the publish pipeline lands (M4).

export interface ToolExecuteContext {
  signal?: AbortSignal
  progress?: (input: { status?: string }) => Promise<void> | void
  [key: string]: unknown
}

export interface ToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (
    input: unknown,
    context: ToolExecuteContext,
  ) => Promise<{ content: string }>
}

export interface ToolEditor {
  add(tool: ToolDefinition): void
  namespace?(ns: { name: string; description?: string }): void
}

export interface PluginContextLocation {
  directory?: string
  workspaceID?: string
  project?: {
    id?: string
    directory?: string
    canonical?: string
  }
}

export interface PluginContext {
  location?: PluginContextLocation
  tool: {
    transform(cb: (editor: ToolEditor) => void): Promise<unknown>
    hook?(
      name: "execute.before" | "execute.after",
      cb: (event: unknown) => void,
    ): Promise<unknown>
  }
  session: {
    synthetic?(input: {
      sessionID: string
      text: string
      delivery?: "steer" | "queue"
    }): Promise<unknown>
    prompt?(input: { sessionID: string; text: string }): Promise<unknown>
    status?(): Promise<Record<string, unknown>>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
}
