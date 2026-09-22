// Output hygiene pipeline applied to every captured line (qwen parity).

// CSI sequences: colors, cursor movement, etc.
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// OSC sequences: window titles, hyperlinks.
const ANSI_OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g
// Single-character escape sequences (ESC followed by one final byte).
const ANSI_SINGLE = /\x1b[@-Z\\-_]/g
// Remaining C0/C1 control characters.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f\x9b]/g

export const LINE_MAX_LENGTH = 2000
const TRUNCATION_MARKER = "…[truncated]"

/**
 * Clean one raw output line. Returns null when the line carries no content.
 */
export function cleanLine(raw: string): string | null {
  let line = raw
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_SINGLE, "")
    .replace(CONTROLS, "")
    .trim()
  if (line.length === 0) return null
  if (line.length > LINE_MAX_LENGTH) {
    line = line.slice(0, LINE_MAX_LENGTH) + TRUNCATION_MARKER
  }
  return line
}
