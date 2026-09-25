# pi-startup-update

A small Pi extension that runs Pi's own `update --all --no-approve` on every TUI startup. It does not reload the running session, so updated code takes effect on the next launch.

## Install

Copy the extension into the user extension directory; no settings change or shell wrapper is needed:

```sh
mkdir -p "$HOME/.pi/agent/extensions"
install -m 644 startup-update.ts "$HOME/.pi/agent/extensions/startup-update.ts"
```

## Update behavior

On `session_start` the extension checks exactly two conditions and nothing else: `event.reason === "startup"` and `ctx.mode === "tui"`. Every fresh TUI launch passes this — a new session, `--continue`, or resuming a previous session — while `/reload`, in-session session switches, subagent sessions, and non-TUI modes (print, rpc) skip. There are no other guards: no offline check, no process scan, no lock, and no argument filtering.

It then awaits the installed Node Pi CLI directly, without a shell or `pi` wrapper:

```sh
node <pi-cli-entry> update --all --no-approve
```

Pi 0.87.1's `--all` updates the core and installed packages together. A nonzero exit or a spawn failure produces a warning notification; success produces one informational notice. The running session is never reloaded or interrupted, and the update is never retried within the same session.

**This mutates the live Pi installation during startup with no hard guarantees.** In-session updates can race across concurrent Pi sessions: another session may start while the update runs, and Pi's package updater may replace Git package contents, reset checkouts, or remove untracked files. Failures can leave partial changes, so back up anything you need. The update is best-effort — the session continues either way, and changes apply on the next launch.

## Tests

Run the smoke tests with Node.js 24. They mock `pi.exec` and never run a live updater:

```sh
node --experimental-strip-types --test tests/startup-update.test.mjs
```
