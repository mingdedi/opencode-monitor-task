#!/usr/bin/env python3
"""Simulated model training loop for monitor-tool scenario testing.

Emits one line per epoch on stdout (line-buffered, flush=True) so the
opencode-monitor-task plugin can stream it:

    epoch 7/60 loss=1.1042 val_loss=1.2018 lr=0.00026

Wake-worthy lines a `pattern` regex can target:

  - every 10th epoch      -> "epoch 10/60", "epoch 20/60", ... (epoch id ends in 0)
  - historic val_loss low -> trailing " NEW BEST"
  - final line            -> "TRAINING COMPLETE best_loss=... at epoch ..."

Loss design:
  - train loss decays fast and monotonically (looks great forever, like real training)
  - val loss decays slowly (exp time constant 40) and only picks up an overfit
    penalty after epoch 30 (0.0015 * max(0, epoch-30)^2), so the historic low
    lands around epoch 30 and never improves afterwards
  - NEW BEST requires beating the reported best by --best-margin (0.05 default,
    early-stopping style): on the default curves with seed 7 the substantive
    lows land at epochs 1, 3, 9, 19, 30 — sparse enough to wake on.

Usage:
  python3 train-sim.py [--epochs 60] [--epoch-seconds 1.5] [--seed 42]
"""
import argparse
import math
import random
import time

parser = argparse.ArgumentParser(description="Simulated training loop")
parser.add_argument("--epochs", type=int, default=60)
parser.add_argument("--epoch-seconds", type=float, default=1.5)
parser.add_argument("--seed", type=int, default=42)
parser.add_argument(
    "--best-margin",
    type=float,
    default=0.05,
    help="only flag NEW BEST when val_loss beats the reported best by this margin "
    "(early-stopping style: filters noise-level improvements)",
)
args = parser.parse_args()

rng = random.Random(args.seed)
best_val = math.inf
best_epoch = 0
started = time.time()

for epoch in range(1, args.epochs + 1):
    train_loss = 1.5 * math.exp(-epoch / 12) + 0.30 + rng.gauss(0, 0.02)
    overfit = 0.0015 * max(0, epoch - 30) ** 2
    val_loss = 0.6 * math.exp(-epoch / 40) + 0.42 + overfit + rng.gauss(0, 0.04)
    lr = 3e-4 * 0.97 ** epoch

    line = (
        f"epoch {epoch}/{args.epochs} "
        f"loss={train_loss:.4f} val_loss={val_loss:.4f} lr={lr:.5f}"
    )
    if val_loss < best_val - args.best_margin:
        best_val, best_epoch = val_loss, epoch
        line += " NEW BEST"
    print(line, flush=True)
    if args.epoch_seconds > 0:
        time.sleep(args.epoch_seconds)

duration = time.time() - started
print(
    f"TRAINING COMPLETE best_loss={best_val:.4f} at epoch {best_epoch} "
    f"in {duration:.1f}s",
    flush=True,
)
