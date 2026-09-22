// Token bucket rate limiter (qwen parity: burst of 5, then ~1 event/second;
// over-limit lines are dropped, never queued).

export interface TokenBucketOptions {
  capacity?: number
  refillPerSecond?: number
  now?: () => number
}

export class TokenBucket {
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly now: () => number
  private tokens: number
  private lastRefill: number

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? 5
    this.refillPerSecond = options.refillPerSecond ?? 1
    this.now = options.now ?? (() => Date.now())
    this.tokens = this.capacity
    this.lastRefill = this.now()
  }

  /**
   * Try to consume one token. Returns false when the line must be dropped.
   * Refill is computed lazily from the injected clock.
   */
  tryTake(): boolean {
    const now = this.now()
    const elapsed = Math.max(0, now - this.lastRefill)
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (elapsed / 1000) * this.refillPerSecond,
      )
      this.lastRefill = now
    }
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }
}
