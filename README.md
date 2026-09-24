# pi-startup-update

A Bash prelaunch wrapper for an ordinary interactive Pi launch. **This is not a Pi extension**: it runs before Pi starts and does not use Pi's extension API.

It only attempts updates for a zero-argument `pi` launch with stdin and stdout attached to a TTY. Any Pi arguments—including package-management or update subcommands—are passed straight through without running update work. It also skips updates for noninteractive launches, AI-agent environments, and `PI_OFFLINE`. If an active `pi` or `pi-rpc` process is detected, it skips updating and launches the installed Pi executable. Process checks are best-effort, not a lock coordinated with every Pi launch: another session could start after the final check, and direct launches do not share the wrapper's lock.

## Install

Copy the script into the user-level agent bin directory:

```sh
mkdir -p "$HOME/.pi/agent/bin"
install -m 755 pi-startup-update "$HOME/.pi/agent/bin/pi-startup-update"
```

Add this function to `~/.zshrc` (or adapt it for your shell). It resolves Pi from the current `PATH` and falls back to launching Pi directly if the wrapper is absent:

```zsh
pi() {
  local pi_bin updater
  pi_bin="$(whence -p pi)"
  if [[ -z "$pi_bin" || ! -x "$pi_bin" ]]; then
    print -u2 -- "pi: executable not found on PATH"
    return 127
  fi

  updater="$HOME/.pi/agent/bin/pi-startup-update"
  if [[ -x "$updater" ]]; then
    "$updater" "$pi_bin" "$@"
  else
    "$pi_bin" "$@"
  fi
}
```

## Update behavior

Updates run only for a zero-argument interactive launch, after a nonblocking `flock` and two best-effort checks for active `pi`/`pi-rpc` processes. The final check happens immediately before updating. Direct Pi launches do not share this lock, so this is not a guarantee against another session starting after that check.

The wrapper invokes the installed Pi executable in order:

```sh
pi update --extensions --no-approve
pi update --self --no-approve
```

The first command delegates user-scoped extension/package updates to Pi; the second updates Pi itself. The wrapper does not resolve package metadata, inspect Git status, or run a custom per-package update loop. `--no-approve` is retained to avoid approval prompts and exclude untrusted project packages under Pi's own update policy. This CLI is verified with Pi 0.87.1; older versions must support `update --extensions`.

**Pi's normal package-update behavior can destroy local data.** Updating a Git package may reset its checkout (`git reset --hard`), remove untracked and ignored files (`git clean -fdx`), then reinstall it. Local edits and generated files inside updated package directories are not preserved. The wrapper intentionally does not add a Git-status safety gate. Pi does not provide a hard atomicity or rollback guarantee: a failed update may leave packages partially changed. If the extension update fails, the wrapper warns with captured error output, skips the core update, and launches the installed Pi. A core-update failure also warns and launches the installed executable.

Runtime requirements are Bash, `ps`, and `flock`; if the lock is unavailable, updates are skipped and Pi is launched. The wrapper uses the installed Pi executable and local utilities; it does not invoke external AI tools or models.

## Tests

Run the isolated mock-based tests with Node.js:

```sh
bash -n pi-startup-update
node --test tests/pi-startup-update.test.mjs
```

The tests use temporary fixtures, a mocked Pi executable, and mocked process/lock checks. They do not run a live updater. `script` is required to provide a pseudo-terminal for the interactive-launch cases.
