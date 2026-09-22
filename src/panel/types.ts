// Minimal structural types for the OpenCode V2 TUI plugin context
// (v2.0.11 `packages/plugin/src/tui/context.ts`). Kept local, mirroring the
// zero-dependency approach of ../types.ts; swap to @opencode/plugin types if
// the publish pipeline ever pins them.

export interface TuiLocation {
  directory?: string
  /** Observed live on v2.0.11: same project block as the server context. */
  project?: {
    id?: string
    directory?: string
    canonical?: string
  }
}

export interface TuiMemoryStore<Value extends object> {
  readonly initial: Value
}

export interface TuiStorage {
  memory<Value extends object>(
    key: string,
    options: TuiMemoryStore<Value>,
  ): readonly [Value, (mutation: (draft: Value) => void) => void]
}

export interface TuiSlotClaim {
  readonly append: string
  readonly render: (input: unknown) => unknown
}

export interface TuiTheme {
  text: { muted: string }
}

export interface TuiRouter {
  /**
   * v2.0.11 (undocumented, verified against the shipped binary): returns
   * the live route data. The session variant carries
   * {type: "session", sessionID} — how the host's own ui.panel.open
   * resolves "the session in view". Follows leader navigation; observed
   * lagging behind TAB switches (those go through sessionTabs instead).
   * Absent/throwing on other builds.
   */
  current?: () => unknown
}

export interface TuiTabs {
  /**
   * v2.0.11 (undocumented): whether session-tabs mode is enabled. Only
   * when true does list() say anything about the focused session.
   */
  enabled?: () => unknown
  /**
   * v2.0.11 (undocumented): live tab list; the focused tab carries
   * active === true and a sessionID string — the authoritative "which
   * session is the user looking at" signal (covers Tab-key switching).
   */
  list?: () => unknown
}

export interface TuiContext {
  readonly location: TuiLocation | undefined
  readonly storage: TuiStorage
  readonly theme: TuiTheme
  readonly app: { version: string }
  /**
   * Reactive-ish data domain observed in the v2.0.11 probe
   * ({on/listen/session/project/shell/location}) — opaque for now; the
   * deep-probe logs decide whether it can serve as source ① (current
   * session) later.
   */
  readonly data?: unknown
  readonly ui: {
    slot: (claim: TuiSlotClaim) => () => void
    router?: TuiRouter
    tabs?: TuiTabs
  }
}
