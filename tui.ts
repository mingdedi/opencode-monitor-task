// Host-injection entry for the TUI runtime.
//
// The host resolves bare @opentui/* specifiers ONLY in this file — the one
// it actually scans (verified v2.2.5: panel/view.ts failed with "Cannot
// find package '@opentui/solid'" while the single-file statusline plugin
// with a top-level import loads fine). So the jsx-runtime pair is imported
// HERE and handed to src/tui.ts, which itself stays free of bare
// specifiers. The server process never evaluates this file (it loads the
// "." export, index.ts).
import * as jsxrt from "@opentui/solid/jsx-runtime"
import { defineTuiPlugin } from "./src/tui"

export default defineTuiPlugin({
  jsx: jsxrt.jsx,
  jsxs: jsxrt.jsxs ?? jsxrt.jsx,
})
