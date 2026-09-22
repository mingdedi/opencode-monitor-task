# Tests

## Unit tests

```sh
npm test          # runs all *.test.ts, <1s, no network, no model
npm run typecheck
```

| File | Covers |
|------|--------|
| `clean.test.ts` | Output pipeline: ANSI strip, blank-line drop, 2000-char truncation, `\r`/`\r\n` line splitting |
| `throttle.test.ts` | Token bucket: burst 5 + 1/s, drop counting |
| `validate.test.ts` | Tool argument validation: ranges, regex, command-injection guards |
| `registry.test.ts` | Monitor lifecycle: start/stop semantics, auto-stop conditions, exit-code mapping, concurrency cap |
| `session-resolver.test.ts` | Session ID resolution strategies and freshness window |
| `state.test.ts` | State bridge: atomic writes, debounce coalescing, heartbeat, dispose final snapshot, XDG path resolution, panel snapshot filtering |
| `registry-state.test.ts` | Registry→writer bridge: onChange fired on start/lines/finalize, pid exposure, callback errors swallowed |
| `tui-reader.test.ts` | Panel state reader: missing/corrupt/schema-mismatch files, stale-heartbeat offline detection |
| `tui-format.test.ts` | Panel line model: duration/id formatting, state icons, pid/exit-info rows, folding, 42-column width regression |

## Scenario scripts (manual, require a model)

| File | Purpose |
|------|---------|
| `m1-verify.sh <model>` | Minimal wake-chain smoke test: multi-stage background command wakes the agent once per stage, no orphans |
| `m2-verify.sh <model>` | P0 full acceptance run |
| `train-sim.py` | Simulated 60-epoch training loop for regex-wake testing: emits one line per epoch, flags `NEW BEST` (with margin) and every 10th epoch. Watch it with: `monitor(command="python3 test/train-sim.py --seed 7", pattern="epoch \\d+0/|NEW BEST|TRAINING COMPLETE")` |
| `build-sim.sh` | Simulated `make -j16` build: per-file compile noise on stdout, colored gcc warnings on stderr, optional hard error (`--fail-at N`). Exercises ANSI stripping, stdout/stderr merge and non-zero exit mapping. Suggested pattern: `error:|BUILD (OK|FAILED)` |
| `etl-sim.py` | Simulated nightly ETL: dense per-batch noise, sparse `CHECKPOINT`/`BAD ROW`/`FATAL`/`ETL DONE` wakes (~87% filter ratio, `lines_scanned` vs `lines_matched`). Suggested pattern: `CHECKPOINT|BAD ROW|FATAL|ETL DONE` |
| `storm-sim.sh` | Simulated service error storm: healthy start, then a 30-line `ERROR` burst and a `FATAL`, exit 1. Run it twice — with `coalesce_ms=1500` (burst merges into one notification) and without (token bucket drops all but 5). Suggested pattern: `ERROR|FATAL` |
| `watch-sim.py` | Simulated wait-for-upstream-result: total silence for `--wait-seconds`, then exactly one line, exit 0. Covers the no-pattern (all-line wake) path and the `idle_timeout_ms` semantics — including the control call `idle_timeout_ms=5000` that must stop the monitor early. Optional `--path` mode polls for a real file appearing |
| `download-sim.py` | Simulated HF-mirror download: bare-`\r` ANSI progress bar (never wakes under a pattern, but must still be split into `lines_scanned`) plus sparse milestones — `RESOLVED`, `SWITCHING MIRROR`, `checksum`, `DOWNLOAD COMPLETE/FAILED`. Suggested pattern: `RESOLVED|SWITCHING MIRROR|checksum|DOWNLOAD (COMPLETE|FAILED)` |

The `*-sim.*` scripts are payload simulators for manual / real-session testing:
each file's header documents the suggested `monitor(...)` call, the exact
plugin behavior a correct run must show (wake counts, `monitor_list`
counters, exit-state mapping), and at least one control variant that must
behave differently. Watch them from a real OpenCode session (TUI or
`opencode run`) with the plugin installed via `.opencode/plugins/`.

The verify scripts install the plugin into a throwaway project under
`/tmp/opencode/` and run `opencode run --standalone` — they never touch your
shared OpenCode service.
