import assert from "node:assert/strict"
import { test } from "node:test"
import { TokenBucket } from "../src/throttle"

function makeBucket() {
  let now = 0
  return { bucket: new TokenBucket({ now: () => now }), advance: (ms: number) => (now += ms) }
}

test("allows the initial burst then drops", () => {
  const { bucket } = makeBucket()
  for (let i = 0; i < 5; i++) {
    assert.ok(bucket.tryTake(), `burst event ${i + 1} should pass`)
  }
  assert.ok(!bucket.tryTake(), "6th immediate event should be dropped")
})

test("refills at ~1 token per second", () => {
  const { bucket, advance } = makeBucket()
  for (let i = 0; i < 5; i++) bucket.tryTake()
  advance(1000)
  assert.ok(bucket.tryTake(), "one token after 1s")
  assert.ok(!bucket.tryTake(), "no second token immediately after")
  advance(500)
  assert.ok(!bucket.tryTake(), "half a token is not enough")
  advance(500)
  assert.ok(bucket.tryTake(), "full token after another 500ms")
})

test("caps refill at capacity", () => {
  const { bucket, advance } = makeBucket()
  advance(600_000) // far in the future: cannot hoard more than 5 tokens
  for (let i = 0; i < 5; i++) {
    assert.ok(bucket.tryTake(), `capped burst ${i + 1}`)
  }
  assert.ok(!bucket.tryTake(), "capacity cap respected")
})
