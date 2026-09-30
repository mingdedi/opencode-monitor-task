// File tail-follow reader for detached monitors (M9). The monitored
// command appends to its log file; this reader polls the file and hands
// decoded increments to the same line-buffering pipeline that pipe chunks
// take (registry feedChunk). The registry is thereby a tail reader that
// may leave (service death) and come back (reattach) — the file never
// notices.
//
// Polling (fstat + read on a persistent fd) is chosen over fs.watch
// deliberately: watch events are unreliable across filesystems (NFS,
// some bind mounts, container volumes), and the poll cadence doubles as
// the liveness-probe cadence (registry onTick) for the owning monitor.

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { log } from "./log"

const READ_CHUNK = 64 * 1024

export interface TailHandle {
  /** Stop polling and close the fd. Idempotent. */
  stop(): void
  /** Bytes consumed so far — the reattach resume point. */
  getOffset(): number
}

export interface TailOptions {
  path: string
  /** Start reading at this byte offset (reattach resume). Default 0. */
  startOffset?: number
  /** Poll interval. Default 250ms. */
  intervalMs?: number
  /** Decoded incremental output. Multi-byte UTF-8 boundaries split across
   *  reads are reassembled via StringDecoder. */
  onChunk: (chunk: string) => void
  /** Called once per tick AFTER increments were drained — the registry's
   *  liveness/exit probe slot. Errors are logged and swallowed. */
  onTick?: () => void
  /** Fired exactly once, when the reader first reaches end-of-file — the
   *  reattach replay boundary: "everything up to here was history". */
  onCaughtUp?: () => void
}

export function createTail(opts: TailOptions): TailHandle {
  const intervalMs = opts.intervalMs ?? 250
  const decoder = new StringDecoder("utf8")
  let offset = opts.startOffset ?? 0
  let fd: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let caughtUpFired = false
  let stopped = false

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
      fd = null
    }
  }

  try {
    fd = openSync(opts.path, "r")
    const size = fstatSync(fd).size
    // Truncated/rotated under us (not expected — offsets are absolute and
    // nothing rotates in M9): restart from zero rather than read garbage.
    if (size < offset) {
      log(`tail ${opts.path}: file shrank (${size} < ${offset}); restarting at 0`)
      offset = 0
    }
  } catch (err) {
    log(`tail ${opts.path}: open failed: ${String(err)}`)
    stop()
    // A tail that cannot open its file delivers nothing but still honors
    // getOffset — the registry's probe path still works.
    return { stop, getOffset: () => offset }
  }

  const drain = () => {
    if (fd === null || stopped) return
    const buf = Buffer.alloc(READ_CHUNK)
    for (;;) {
      let bytesRead: number
      try {
        bytesRead = readSync(fd, buf, 0, READ_CHUNK, offset)
      } catch (err) {
        log(`tail ${opts.path}: read failed: ${String(err)}`)
        stop()
        return
      }
      if (bytesRead === 0) break
      offset += bytesRead
      const text = decoder.write(buf.subarray(0, bytesRead))
      if (text.length > 0) opts.onChunk(text)
    }
  }

  const tick = () => {
    drain()
    if (!stopped && !caughtUpFired) {
      caughtUpFired = true
      try {
        opts.onCaughtUp?.()
      } catch (err) {
        log(`tail ${opts.path}: onCaughtUp failed: ${String(err)}`)
      }
    }
    try {
      opts.onTick?.()
    } catch (err) {
      log(`tail ${opts.path}: onTick failed: ${String(err)}`)
    }
  }

  timer = setInterval(tick, intervalMs)
  timer.unref?.()

  return { stop, getOffset: () => offset }
}
