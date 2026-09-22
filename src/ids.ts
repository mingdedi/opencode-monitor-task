import { randomBytes } from "node:crypto"

/** qwen-style monitor id, e.g. mon_1a2b3c4d5e6f7a8b */
export function newMonitorId(): string {
  return `mon_${randomBytes(8).toString("hex")}`
}
