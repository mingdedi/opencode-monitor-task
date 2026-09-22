#!/usr/bin/env python3
"""Simulated "wait for an upstream result" task for monitor-tool scenario testing.

Real-world shape: the agent needs something only another process can
produce — a checkpoint written by a training run in another session, a GPU
to be released, a data export to land on disk. The task is silent for a
long time, then emits exactly ONE line and exits.

This is the natural payload for the plugin's no-pattern path (implicit
wake_mode "all") and for the idle_timeout_ms semantics:

  - a correct monitor stays silent for the whole wait when
    idle_timeout_ms (default 5 min) exceeds it: zero notifications until
    the single result line arrives
  - the one wake must go through immediately (no throttle interference —
    one event is far below the burst of 5)
  - clean exit 0 -> lifecycle "monitor completed: exit code 0"
  - control experiment: idle_timeout_ms=5000 with --wait-seconds 40 must
    STOP the monitor at ~5s ("idle timeout after 5000ms without output"),
    state "stopped", and the eventual result line then wakes nobody —
    proving the timer both fires when it should and not before

--path mode polls for a real file appearing on disk (created by whoever
the agent is waiting for), so two agent turns / terminals can interact:
one runs the monitor, the other drops the file.

Output shape (a single line, flush=True):

    RESULT READY after 41.9s - upstream job finished, safe to proceed
    RESULT FILE APPEARED: /tmp/opencode/upstream-result.json (size 218 B) after 12.4s
    RESULT FILE MISSING after 300s: /tmp/opencode/upstream-result.json   (exit 4)

Suggested monitor calls:
  fixed silent wait (simplest):
    monitor(command="python3 test/watch-sim.py --wait-seconds 40",
            description="wait for upstream result")
  wait for a real file (drop it from another shell when ready):
    monitor(command="python3 test/watch-sim.py --path /tmp/opencode/upstream-result.json",
            description="wait for export file")
  control experiment for the idle timer (expect an early stop):
    monitor(command="python3 test/watch-sim.py --wait-seconds 40",
            description="idle-timeout control", idle_timeout_ms=5000)

What a correct plugin does (defaults):
  - zero notifications during the silent wait, then exactly one wake with
    the result line + lifecycle "monitor completed: exit code 0"
  - the control call stops at ~5s with "monitor stopped: idle timeout
    after 5000ms without output" and never wakes on the late result line

Usage:
  python3 watch-sim.py [--wait-seconds 40] [--poll 0.5]
                       [--path FILE] [--deadline 300]
"""
import argparse
import os
import sys
import time

parser = argparse.ArgumentParser(description="Simulated wait-for-upstream-result task")
parser.add_argument(
    "--wait-seconds",
    type=float,
    default=40,
    help="silent wait before emitting the result line (no --path mode)",
)
parser.add_argument(
    "--poll",
    type=float,
    default=0.5,
    help="file-existence poll interval in --path mode",
)
parser.add_argument(
    "--path",
    type=str,
    default=None,
    help="poll for this file instead of a fixed sleep; emit one line when it appears",
)
parser.add_argument(
    "--deadline",
    type=float,
    default=300,
    help="give up in --path mode after this many seconds (exit 4)",
)
args = parser.parse_args()

started = time.time()

if args.path:
    while not os.path.exists(args.path):
        if time.time() - started > args.deadline:
            print(f"RESULT FILE MISSING after {args.deadline:.0f}s: {args.path}", flush=True)
            sys.exit(4)
        time.sleep(args.poll)
    size = os.path.getsize(args.path)
    print(
        f"RESULT FILE APPEARED: {args.path} (size {size} B) "
        f"after {time.time() - started:.1f}s",
        flush=True,
    )
else:
    time.sleep(args.wait_seconds)
    print(
        f"RESULT READY after {args.wait_seconds:.1f}s - "
        "upstream job finished, safe to proceed",
        flush=True,
    )
