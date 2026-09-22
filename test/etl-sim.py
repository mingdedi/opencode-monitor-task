#!/usr/bin/env python3
"""Simulated nightly ETL / batch data pipeline for monitor-tool scenario testing.

Real-world shape: a cron-style pipeline churning through dozens of batches.
Per-batch progress lines are noise; the interesting events are sparse —
periodic warehouse checkpoints, occasional quarantined rows (data quality),
and the final summary. Watched by the opencode-monitor-task plugin with a
pattern, it exercises the filter counters end to end:

  - lines_scanned counts every batch line, lines_matched only the sparse
    wake lines — a correct run shows a high filter ratio (~87%)
  - the wakes are spaced far enough apart (~2.5s) that the token bucket
    never engages: events_sent must equal lines_matched, dropped stays 0
  - the final wake carries a structured summary the agent can parse
  - --fail-batch N aborts mid-run -> exit 3 -> "monitor failed: Exit code 3"

Output shape (one line per batch, flush=True):

    batch 12/100 rows=842 loaded=840 dup=2                     <- noise
    CHECKPOINT batch 10/100 cumulative_rows=8339 flushed to warehouse
    BAD ROW batch 23 row 5124: schema mismatch (expected int, got "N/A") - quarantined
    ETL DONE batches=100 rows=84321 loaded=84288 quarantined=33 duration=25.0s

Suggested monitor call:
  monitor(command="python3 test/etl-sim.py",
          description="nightly etl",
          pattern="CHECKPOINT|BAD ROW|FATAL|ETL DONE")

What a correct plugin does (recommended call, defaults):
  - monitor_list: lines_scanned = batches + bad_rows + checkpoints + 1
    (= 114 with defaults), lines_matched = bad_rows + checkpoints + 1 (= 14)
  - 14 wakes in pipeline order (each acknowledged by the agent), no drops
  - final lifecycle: "monitor completed: exit code 0"
  - with --fail-batch 40: the batch-40 FATAL wakes the agent once, then
    lifecycle "monitor failed: Exit code 3"; CHECKPOINT/BAD ROW lines that
    never happened are simply absent

Usage:
  python3 etl-sim.py [--batches 100] [--batch-seconds 0.25] [--seed 42]
                     [--bad-batches 3] [--fail-batch 0]
"""
import argparse
import random
import sys
import time

parser = argparse.ArgumentParser(description="Simulated nightly ETL pipeline")
parser.add_argument("--batches", type=int, default=100)
parser.add_argument("--batch-seconds", type=float, default=0.25)
parser.add_argument("--seed", type=int, default=42)
parser.add_argument(
    "--bad-batches",
    type=int,
    default=3,
    help="how many random batches hit quarantinable rows (seeded, deterministic)",
)
parser.add_argument(
    "--fail-batch",
    type=int,
    default=0,
    help="abort with FATAL at this batch (exit 3); 0 = never fail",
)
args = parser.parse_args()

rng = random.Random(args.seed)
# Quarantine events land in random batches (never the first few, so early
# wakes prove filtering rather than luck; never the last, so the summary
# always follows at least one BAD ROW).
safe = list(range(5, args.batches))
bad = set(rng.sample(safe, k=min(args.bad_batches, len(safe)))) if safe else set()

rows_total = 0
loaded_total = 0
quarantined = 0
started = time.time()

for b in range(1, args.batches + 1):
    rows = rng.randint(700, 900)
    dup = rng.randint(0, 4)
    loaded = rows - dup
    rows_total += rows
    loaded_total += loaded
    print(f"batch {b}/{args.batches} rows={rows} loaded={loaded} dup={dup}", flush=True)

    if b in bad:
        q = rng.randint(5, 30)
        quarantined += q
        row_no = rows_total - rng.randint(0, rows)
        print(
            f'BAD ROW batch {b} row {row_no}: schema mismatch '
            f'(expected int, got "N/A") - quarantined',
            flush=True,
        )

    if args.fail_batch and b == args.fail_batch:
        print(
            f"FATAL: upstream connection lost during batch {b}, pipeline aborted",
            flush=True,
        )
        sys.exit(3)

    if b % 10 == 0:
        print(
            f"CHECKPOINT batch {b}/{args.batches} "
            f"cumulative_rows={rows_total} flushed to warehouse",
            flush=True,
        )

    if args.batch_seconds > 0:
        time.sleep(args.batch_seconds)

duration = time.time() - started
print(
    f"ETL DONE batches={args.batches} rows={rows_total} "
    f"loaded={loaded_total} quarantined={quarantined} duration={duration:.1f}s",
    flush=True,
)
