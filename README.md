# pi-startup-update

A small Pi extension that awaits Pi's own `update --all --no-approve` from `session_start` on a plain interactive startup. It does not reload the running session, so updated code takes effect on the next launch.

## Install

Copy the extension into the user extension directory; no settings change or shell wrapper is needed:

```sh
mkdir -p "$HOME/.pi/agent/extensions"
install -m 644 startup-update.ts "$HOME/.pi/agent/extensions/startup-update.ts"
```

## Update behavior

The awaited `session_start` handler runs only for a plain, zero-argument TUI startup. It skips reloads, non-TUI modes, `PI_OFFLINE`, nested `PI_SESSION_ID` sessions, and starts with CLI arguments. It deliberately does not skip on `AI_AGENT` or `PI_CODING_AGENT`, which Pi sets for its own active process.

This requires a Node-based Pi CLI, `ps`, and `flock`; compiled Bun binaries are not supported. Before updating, it checks for other `pi`/`pi-rpc` processes and Node-based Pi CLI processes, excluding its own PID. It skips on inspection errors, unusable process-list output, or another detected session. The check is best-effort: another Pi session can start immediately afterward, and `flock` serializes updater runs but does not lock ordinary Pi sessions.

The extension invokes the current Node CLI entry directly, without a shell or `pi` wrapper. Pi's `update` command does not load extensions, so this cannot recursively trigger the handler:

```sh
flock -n -E 75 <agent-dir>/.startup-auto-update.lock <node> <pi-cli-entry> update --all --no-approve
```

Pi 0.87.1's `--all` update handles packages and core together; package-update failure prevents the core update. The extension does not print updater output or retry in the same session. It leaves the current session running and reports only a generic status on failure or interruption. Successful updates take effect on the next launch; the running session is not reloaded.

**This mutates the live Pi installation during startup.** A direct session can still start after the process scan, so it may overlap with package or core replacement. Pi's normal package updater may replace Git package contents, reset checkouts, or remove untracked and ignored files; failures may leave partial changes. Local package data can be lost, so back up anything you need.

## Tests

Run the isolated tests with Node.js 24. They mock the Pi API, process scan, and lock command; the bundled-path case covers Node's `dist/bundle/cli.js`, not a compiled Bun binary. Tests never run a live updater:

```sh
node --experimental-strip-types --test tests/startup-update.test.mjs
```
