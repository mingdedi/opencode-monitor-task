import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  validateCoalesce,
  validateCommand,
  validateDelivery,
  validateDirectory,
  validateParams,
  validatePattern,
  validateWakeMode,
} from "../src/validate"

// ------------------------------------------------------------ validateCommand

test("rejects command substitution", () => {
  for (const command of [
    "echo $(whoami)",
    "echo `whoami`",
    "cat <(ls)",
    "echo >(x)",
  ]) {
    const r = validateCommand(command)
    assert.ok(r.error, `should reject: ${command}`)
    assert.match(r.error, /not allowed/)
  }
})

test("rejects empty commands", () => {
  assert.ok(validateCommand("").error)
  assert.ok(validateCommand("   ").error)
  assert.ok(validateCommand(42).error)
})

test("strips trailing background ampersand", () => {
  assert.equal(validateCommand("echo hi &").command, "echo hi")
  assert.equal(validateCommand("echo hi &\t ").command, "echo hi")
  assert.equal(validateCommand("tail -f log &&").command, "tail -f log")
})

test("rejects non-final lone ampersand but allows &&", () => {
  assert.ok(validateCommand("sleep 1 & echo hi").error)
  assert.equal(validateCommand("echo a && echo b").command, "echo a && echo b")
})

test("allows fd redirection and quoted ampersands (not backgrounding)", () => {
  // README user-story command: stderr merge is not backgrounding.
  assert.equal(validateCommand("python train.py 2>&1").command, "python train.py 2>&1")
  assert.equal(validateCommand("make build >&2").command, "make build >&2")
  assert.equal(validateCommand('grep "tom & jerry" file').command, 'grep "tom & jerry" file')
  assert.equal(
    validateCommand("sh -c 'echo stage && echo next'").command,
    "sh -c 'echo stage && echo next'",
  )
  // real backgrounding is still rejected alongside the allowances above
  assert.ok(validateCommand("python train.py 2>&1 & tail -f log").error)
  assert.ok(validateCommand('echo "safe" & echo bg').error)
})

// ------------------------------------------------------------- validateParams

test("parameter defaults", () => {
  const r = validateParams({})
  assert.equal(r.maxEvents, 1000)
  assert.equal(r.idleTimeoutMs, 300_000)
})

test("rejects out-of-range or non-integer parameters", () => {
  for (const input of [
    { max_events: 0 },
    { max_events: -1 },
    { max_events: 10_001 },
    { max_events: 1.5 },
    { max_events: "100" },
    { idle_timeout_ms: 0 },
    { idle_timeout_ms: 600_001 },
    { idle_timeout_ms: 12.5 },
  ]) {
    const r = validateParams(input)
    assert.ok(r.error, `should reject: ${JSON.stringify(input)}`)
  }
})

test("accepts boundary values", () => {
  assert.ok(!validateParams({ max_events: 10_000 }).error)
  assert.ok(!validateParams({ max_events: 1 }).error)
  assert.ok(!validateParams({ idle_timeout_ms: 600_000 }).error)
  assert.ok(!validateParams({ idle_timeout_ms: 1 }).error)
})

// ---------------------------------------------------------- validateDirectory

test("directory validation against a workspace root", () => {
  const parent = join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "validate-"))
  const sub = join(root, "sub")
  mkdirSync(sub)
  const file = join(root, "plain-file")
  writeFileSync(file, "x")
  symlinkSync("/", join(root, "escape"))

  try {
    // omitted -> fine (no directory)
    assert.ok(!validateDirectory(undefined, root).error)
    // the root itself and a subdirectory are fine
    assert.ok(!validateDirectory(root, root).error)
    assert.ok(!validateDirectory(sub, root).error)
    // relative path rejected
    assert.ok(validateDirectory("sub", root).error)
    // outside the workspace rejected
    assert.ok(validateDirectory("/usr", root).error)
    // symlink escaping the workspace rejected
    assert.ok(validateDirectory(join(root, "escape"), root).error)
    // nonexistent path rejected
    assert.ok(validateDirectory(join(root, "nope"), root).error)
    // not a directory rejected
    assert.ok(validateDirectory(file, root).error)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- M3: pattern

test("validatePattern accepts valid regex and rejects bad ones verbosely", () => {
  assert.equal(validatePattern(undefined).pattern, undefined)
  assert.equal(validatePattern("epoch \\d+ done").pattern, "epoch \\d+ done")
  const bad = validatePattern("([unclosed")
  assert.ok(bad.error)
  assert.match(bad.error, /not a valid regular expression/)
  assert.match(bad.error, /engine said/)
  assert.match(bad.error, /escape special characters/)
  assert.ok(validatePattern(42).error)
  assert.ok(validatePattern("   ").error)
})

test("validateWakeMode resolves implicit and explicit modes", () => {
  assert.equal(validateWakeMode(undefined, "HIT").wakeMode, "pattern")
  assert.equal(validateWakeMode(undefined, undefined).wakeMode, "all")
  assert.equal(validateWakeMode("all", "HIT").wakeMode, "all")
  assert.equal(validateWakeMode("pattern", "HIT").wakeMode, "pattern")
  assert.ok(validateWakeMode("pattern", undefined).error)
  assert.match(validateWakeMode("pattern", undefined).error!, /requires a pattern/)
  assert.ok(validateWakeMode("sometimes", undefined).error)
})

test("validateDelivery and validateCoalesce bounds", () => {
  assert.equal(validateDelivery(undefined).delivery, "queue")
  assert.equal(validateDelivery("steer").delivery, "steer")
  assert.ok(validateDelivery("now").error)
  assert.equal(validateCoalesce(undefined).coalesceMs, 0)
  assert.equal(validateCoalesce(0).coalesceMs, 0)
  assert.equal(validateCoalesce(60_000).coalesceMs, 60_000)
  assert.ok(validateCoalesce(60_001).error)
  assert.ok(validateCoalesce(-1).error)
  assert.ok(validateCoalesce(1.5).error)
})
