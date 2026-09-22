import assert from "node:assert/strict"
import { test } from "node:test"
import { cleanLine, LINE_MAX_LENGTH } from "../src/clean"

test("keeps plain text", () => {
  assert.equal(cleanLine("hello world"), "hello world")
})

test("preserves inner tabs", () => {
  assert.equal(cleanLine("a\tb"), "a\tb")
})

test("returns null for empty/whitespace lines", () => {
  assert.equal(cleanLine(""), null)
  assert.equal(cleanLine("   \t "), null)
})

test("strips CSI color and cursor sequences", () => {
  assert.equal(cleanLine("\x1b[31mred\x1b[0m"), "red")
  assert.equal(cleanLine("\x1b[1;32mbold\x1b[0m text"), "bold text")
  assert.equal(cleanLine("\x1b[2Kcleared"), "cleared")
})

test("strips OSC sequences", () => {
  assert.equal(cleanLine("\x1b]0;title\x07after"), "after")
  assert.equal(cleanLine("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link")
})

test("strips single-character escapes and control chars", () => {
  assert.equal(cleanLine("a\x00b\x0bc"), "abc")
  assert.equal(cleanLine("a\x7fb"), "ab")
  assert.equal(cleanLine("\x1bMline"), "line")
})

test("truncates lines longer than the limit", () => {
  const long = "x".repeat(LINE_MAX_LENGTH + 500)
  const result = cleanLine(long)
  assert.ok(result)
  assert.ok(result.startsWith("x".repeat(LINE_MAX_LENGTH)))
  assert.ok(result.includes("[truncated]"))
  assert.ok(result.length < LINE_MAX_LENGTH + 50)
})

test("keeps lines exactly at the limit intact", () => {
  const exact = "y".repeat(LINE_MAX_LENGTH)
  assert.equal(cleanLine(exact), exact)
})
