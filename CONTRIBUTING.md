# Contributing

Thanks for your interest in improving `opencode-monitor-task`!

## Development setup

```sh
git clone https://github.com/mingdedi/opencode-monitor-task.git
cd opencode-monitor-task
npm install
```

Requires Node.js >= 20.6.

## Testing & typechecking

Run both checks before opening a PR — CI enforces them too:

```sh
npm test          # 108 unit tests, <2s
npm run typecheck
```

Add or update tests for any behavior change. Scenario simulation scripts
(under `test/`) are for manual verification; see [test/README.md](./test/README.md).

## Trying your changes locally

The repo doubles as a plugin layout. Sync `src/` into OpenCode and hot-reload:

```sh
./scripts/install-local.sh              # server entry -> project-level .opencode/plugins/
./scripts/install-local.sh --global     # TUI entry -> global dir (TUI scans the global dir only)
opencode service restart                # if hot reload does not pick it up
```

See the [README](./README.md#from-source-pre-publish--development) for all install
modes (`--global-full`, `--link`) and their trade-offs.

## Pull requests

- Keep changes focused — one topic per PR.
- `npm test` and `npm run typecheck` must pass.
- English or Chinese is fine for issues and PRs.

## Reporting bugs

Open an issue with your OpenCode version (`opencode --version`), Node version,
and relevant log excerpts:

- Server log: `$TMPDIR/opencode/opencode-monitor-task.log`
- TUI log: `$TMPDIR/opencode-monitor-tui.log`
