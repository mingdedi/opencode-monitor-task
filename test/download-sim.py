#!/usr/bin/env python3
"""Simulated large-file download with a progress bar for monitor-tool scenario testing.

Real-world shape: pulling a multi-GB model from an HF mirror — a carriage
return progress bar (pip/wget style, ANSI colored) that overwrites itself
in place, plus a handful of real newline milestones (mirror resolution, a
stalled node switch, checksum verification, completion).

This is the canonical payload for the plugin's progress-bar handling:

  - \\r-only updates must be split into their own lines (never accumulate
    in the line buffer) and land in lines_scanned
  - cleaned progress lines like "[=====>    ] 45% 921/2048MB eta=23s"
    must NOT match the milestone pattern — a correct monitor stays asleep
    through the whole bar
  - without a pattern, every progress frame wakes the agent until the
    token bucket throttles (burst 5 + 1/s) — a live demo of why patterns
    matter for progress-bar output

Output shape (progress frames end in bare \\r, milestones in \\n):

    RESOLVED hf-mirror.com -> cdn-node-3 (2048 MB, xet disabled)
    [=====>    ] 45% 921/2048MB eta=23s          <- \\r, overwrites in place
    SWITCHING MIRROR: cdn-node-3 stalled at 45%, retrying on cdn-node-7
    [======>   ] 70% 1433/2048MB eta=14s
    checksum ok: sha256 9f2ac4…e1b7 (blob main.safetensors)
    DOWNLOAD COMPLETE: models--acme--demo-lm/blob/main.safetensors (2048 MB) saved to hub cache

Suggested monitor calls:
  milestones only (recommended — the progress bar never wakes):
    monitor(command="python3 test/download-sim.py",
            description="demo-lm weights download",
            pattern="RESOLVED|SWITCHING MIRROR|checksum|DOWNLOAD (COMPLETE|FAILED)")
  no pattern (throttle demo — expect ~5 wakes then drops):
    monitor(command="python3 test/download-sim.py")

What a correct plugin does (recommended call, defaults):
  - every progress frame appears in lines_scanned but not lines_matched
  - exactly 4 wakes: RESOLVED, SWITCHING MIRROR, "checksum ok",
    DOWNLOAD COMPLETE + lifecycle "monitor completed: exit code 0"
  - with --corrupt: the checksum line reads "DOWNLOAD FAILED: checksum
    mismatch …", still matches the pattern; lifecycle is
    "monitor failed: Exit code 2"

Usage:
  python3 download-sim.py [--total-mb 2048] [--mb-per-frame 64]
                          [--frame-seconds 0.2] [--stall-seconds 1.0] [--corrupt]
"""
import argparse
import sys
import time

parser = argparse.ArgumentParser(description="Simulated large-file download")
parser.add_argument("--total-mb", type=int, default=2048)
parser.add_argument("--mb-per-frame", type=int, default=64)
parser.add_argument("--frame-seconds", type=float, default=0.2)
parser.add_argument(
    "--stall-seconds",
    type=float,
    default=1.0,
    help="how long the first mirror stalls at 45% before the switch",
)
parser.add_argument(
    "--corrupt",
    action="store_true",
    help="fail checksum verification instead of completing (exit 2)",
)
args = parser.parse_args()

GREEN = "\033[32m"
YELLOW = "\033[33m"
RESET = "\033[0m"
BLOB = "models--acme--demo-lm/blob/main.safetensors"
SWITCH_AT = 45  # percent of the way where node-3 stalls

print(
    f"RESOLVED hf-mirror.com -> cdn-node-3 ({args.total_mb} MB, xet disabled)",
    flush=True,
)


def bar(done: int, total: int) -> str:
    pct = done / total
    filled = int(pct * 24)
    arrow = ">" if 0 < filled < 24 else ("=" if filled else " ")
    body = "=" * max(filled - 1, 0) + arrow + " " * (24 - filled)
    eta = (total - done) / (args.mb_per_frame / args.frame_seconds) if filled else 0
    return f"[{body}] {pct * 100:3.0f}% {done}/{total}MB eta={eta:.0f}s"


def run_leg(done_from: int, done_to: int, faster: bool = False) -> None:
    d = done_from
    step = args.mb_per_frame * (2 if faster else 1)
    sec = args.frame_seconds / (2 if faster else 1)
    while d < done_to:
        d = min(d + step, done_to)
        sys.stdout.write("\r" + GREEN + bar(d, args.total_mb) + RESET)
        sys.stdout.flush()
        if d < done_to:
            time.sleep(sec)


# First leg up to the stall point, then the mirror switch milestone.
stall_mb = int(args.total_mb * SWITCH_AT / 100)
run_leg(0, stall_mb)
time.sleep(args.stall_seconds)  # node-3 stalls silently
print(
    YELLOW
    + f"SWITCHING MIRROR: cdn-node-3 stalled at {SWITCH_AT}%, retrying on cdn-node-7"
    + RESET,
    flush=True,
)

# Second leg (faster node), then finish the bar with a newline.
run_leg(stall_mb, args.total_mb, faster=True)
sys.stdout.write("\r" + GREEN + bar(args.total_mb, args.total_mb) + RESET + "\n")
sys.stdout.flush()

if args.corrupt:
    print(
        "DOWNLOAD FAILED: checksum mismatch "
        '(expected 9f2ac4…e1b7, got deadbeef…feed) - retry with HF_HUB_DISABLE_XET=1',
        flush=True,
    )
    sys.exit(2)

print(f"checksum ok: sha256 9f2ac4…e1b7 (blob main.safetensors)", flush=True)
print(
    f"DOWNLOAD COMPLETE: {BLOB} ({args.total_mb} MB) saved to hub cache",
    flush=True,
)
