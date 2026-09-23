// Pure validation helpers — no side effects, fully unit-testable.

import { realpathSync, statSync } from "node:fs"
import { isAbsolute, sep } from "node:path"

export const MAX_EVENTS_DEFAULT = 50
export const MAX_EVENTS_LIMIT = 10_000
export const IDLE_TIMEOUT_DEFAULT = 300_000
export const IDLE_TIMEOUT_LIMIT = 600_000
export const COALESCE_DEFAULT = 0
export const COALESCE_LIMIT = 60_000

export type WakeMode = "all" | "pattern"
export type Delivery = "queue" | "steer"

// Command substitution is rejected outright (qwen parity) to limit injection.
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\$\(/, label: "$( ... )" },
  { re: /`/, label: "backticks" },
  { re: /<\(/, label: "<( ... )" },
  { re: />\(/, label: ">( ... )" },
]

// A lone '&' that is not part of '&&' — i.e. shell backgrounding.
const LONE_AMPERSAND = /(?<!&)&(?!&)/

// Segments where '&' is lexical payload, never shell backgrounding:
// - fd redirection compounds: 2>&1, >&2, 3>&1 …
// - quoted strings: '…' / "…" (an & inside quotes never backgrounds)
const FD_REDIRECT = /\d*>&\d+/g
const SINGLE_QUOTED = /'[^']*'/g
const DOUBLE_QUOTED = /"[^"]*"/g

export interface CommandValidation {
  command?: string
  error?: string
}

/**
 * Validate and normalize a monitor command:
 * - reject command substitution (`$(...)`, backticks, `<( ...)`, `>(...)`)
 * - strip a trailing `&` (backgrounding is managed by the monitor itself)
 * - reject a non-final lone `&`; `&&` conditional chaining is allowed
 */
export function validateCommand(raw: unknown): CommandValidation {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: "command must be a non-empty string" }
  }
  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(raw)) {
      return {
        error: `command rejected: ${label} command substitution is not allowed in monitor commands`,
      }
    }
  }
  const command = raw.trim().replace(/&+\s*$/, "").trim()
  // Mask non-backgrounding '&' before the lone-& check so fd redirections
  // (`python train.py 2>&1` — the README user story) and quoted text
  // (`echo "tom & jerry"`) are not misrejected, while real backgrounding
  // (`sleep 1 & echo hi`) still is.
  const masked = command
    .replace(SINGLE_QUOTED, "''")
    .replace(DOUBLE_QUOTED, '""')
    .replace(FD_REDIRECT, "")
  if (LONE_AMPERSAND.test(masked)) {
    return {
      error:
        "command rejected: non-final '&' (backgrounding inside the command) is not allowed; split into separate monitors ('&&' conditional chaining is fine)",
    }
  }
  if (command === "") {
    return { error: "command must be a non-empty string" }
  }
  return { command }
}

export interface PatternValidation {
  pattern?: string
  error?: string
}

/**
 * Validate the wake filter regex: non-empty string, compilable by
 * the JS RegExp engine. Rejections quote the engine error so the caller can
 * fix the pattern in place.
 */
export function validatePattern(raw: unknown): PatternValidation {
  if (raw === undefined || raw === null || raw === "") return {}
  if (typeof raw !== "string") {
    return { error: `pattern must be a string; got ${typeof raw}` }
  }
  const pattern = raw.trim()
  if (pattern === "") {
    return { error: "pattern must be a non-empty regular expression" }
  }
  try {
    void new RegExp(pattern)
  } catch (err) {
    return {
      error: `pattern is not a valid regular expression: ${pattern} (engine said: ${String(
        err instanceof Error ? err.message : err,
      )}) — fix the syntax, e.g. escape special characters like ( ) [ ] { } * + ? . ^ $ | \\`,
    }
  }
  return { pattern }
}

export interface ModeValidation {
  wakeMode?: WakeMode
  error?: string
}

/**
 * Resolve the effective wake mode: implicit `pattern` when a pattern
 * is present, `all` otherwise; explicit wake_mode wins, but `pattern` mode
 * without a pattern is rejected with an actionable message.
 */
export function validateWakeMode(raw: unknown, pattern: string | undefined): ModeValidation {
  if (raw === undefined || raw === null || raw === "") {
    return { wakeMode: pattern ? "pattern" : "all" }
  }
  if (raw !== "all" && raw !== "pattern") {
    return { error: `wake_mode must be "all" or "pattern"; got ${String(raw)}` }
  }
  if (raw === "pattern" && !pattern) {
    return {
      error:
        'wake_mode "pattern" requires a pattern — pass pattern: "<regex>" too, or drop wake_mode to get all-line wake',
    }
  }
  return { wakeMode: raw }
}

export interface DeliveryValidation {
  delivery?: Delivery
  error?: string
}

/** Delivery policy forwarded to the V2 session inbox. */
export function validateDelivery(raw: unknown): DeliveryValidation {
  if (raw === undefined || raw === null || raw === "") return { delivery: "queue" }
  if (raw !== "queue" && raw !== "steer") {
    return { error: `delivery must be "queue" or "steer"; got ${String(raw)}` }
  }
  return { delivery: raw }
}

export interface CoalesceValidation {
  coalesceMs?: number
  error?: string
}

/** Coalescing window: 0 disables, (0, 60000] allowed. */
export function validateCoalesce(raw: unknown): CoalesceValidation {
  if (raw === undefined || raw === null || raw === "") return { coalesceMs: COALESCE_DEFAULT }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > COALESCE_LIMIT
  ) {
    return {
      error: `coalesce_ms must be an integer in [0, ${COALESCE_LIMIT}] (0 disables merging); got ${String(raw)}`,
    }
  }
  return { coalesceMs: raw }
}

export interface ParamValidation {
  maxEvents: number
  idleTimeoutMs: number
  error?: string
}

/**
 * Validate numeric tool parameters. Out-of-range values are rejected
 * (qwen parity: no silent clamping).
 */
export function validateParams(input: {
  max_events?: unknown
  idle_timeout_ms?: unknown
}): ParamValidation {
  const fail = (message: string): ParamValidation => ({
    maxEvents: 0,
    idleTimeoutMs: 0,
    error: message,
  })

  const maxEvents = input.max_events ?? MAX_EVENTS_DEFAULT
  if (
    typeof maxEvents !== "number" ||
    !Number.isInteger(maxEvents) ||
    maxEvents <= 0 ||
    maxEvents > MAX_EVENTS_LIMIT
  ) {
    return fail(
      `max_events must be an integer in (0, ${MAX_EVENTS_LIMIT}]; got ${String(input.max_events)}`,
    )
  }

  const idleTimeoutMs = input.idle_timeout_ms ?? IDLE_TIMEOUT_DEFAULT
  if (
    typeof idleTimeoutMs !== "number" ||
    !Number.isInteger(idleTimeoutMs) ||
    idleTimeoutMs <= 0 ||
    idleTimeoutMs > IDLE_TIMEOUT_LIMIT
  ) {
    return fail(
      `idle_timeout_ms must be an integer in (0, ${IDLE_TIMEOUT_LIMIT}]; got ${String(input.idle_timeout_ms)}`,
    )
  }

  return { maxEvents, idleTimeoutMs }
}

export interface DirectoryValidation {
  directory?: string
  error?: string
}

/**
 * Validate the optional working directory: it must be an absolute path that
 * resolves (after symlink resolution) inside the project workspace.
 */
export function validateDirectory(raw: unknown, rootDir: string): DirectoryValidation {
  if (raw === undefined || raw === null || raw === "") return {}
  if (typeof raw !== "string") return { error: "directory must be a string" }
  if (!isAbsolute(raw)) {
    return { error: `directory must be an absolute path; got "${raw}"` }
  }
  let realDir: string
  let realRoot: string
  try {
    realDir = realpathSync(raw)
    realRoot = realpathSync(rootDir)
  } catch {
    return { error: `directory does not exist or cannot be resolved: "${raw}"` }
  }
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    return { error: `directory "${raw}" resolves outside the project workspace (${rootDir})` }
  }
  try {
    if (!statSync(realDir).isDirectory()) {
      return { error: `directory is not a directory: "${raw}"` }
    }
  } catch {
    return { error: `directory cannot be accessed: "${raw}"` }
  }
  return { directory: realDir }
}
