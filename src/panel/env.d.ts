// Ambient declarations for the TUI-plugin runtime modules the host injects.
// The plugin package ships zero runtime dependencies; these modules resolve
// inside the OpenCode TUI process only, so we type them locally for
// `npm run typecheck` instead of adding devDependencies pinned to a specific
// host version.
//
// NOTE: this file must stay a global script (no top-level imports) — a
// top-level import would turn it into a module and scope the `declare module`
// blocks to this file only.

declare module "@opentui/solid/jsx-runtime" {
  // Opaque element handles: the panel only ever passes them back to the host.
  export type Element = unknown
  export const jsx: (tag: string, props: Record<string, unknown>) => Element
  export const jsxs: typeof jsx
}
