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

The wrapper asks the installed Pi version to resolve user-global package sources, then checks configured Git checkouts before allowing Pi's Git update. A clean checkout at or behind its unpinned upstream target can be updated. Dirty checkouts, local-ahead commits, or checkouts that cannot be verified cause Git updates to be skipped, preserving local edits. Explicit pinned Git refs are conservatively treated as unverifiable and skipped. The check uses cached Git refs without fetching; a stale ref or movement after the check can affect the comparison. Ignored generated files/directories can also block a Git update because Pi may clean them during its update.

When Git updates are skipped, configured npm packages and Pi core are updated instead. If Pi's internal package resolver cannot be used, it falls back to core-only. Update failures do not prevent launching the installed Pi executable. Project package settings are excluded.

Runtime requirements are Bash, Node.js, Git, `ps`, `flock`, and standard Unix utilities including `mktemp` and `rm`. Tests additionally require `script` and `which`. The wrapper uses local command-line utilities and the installed Pi executable; it does not invoke external AI tools or models. It is intentionally coupled to Pi's internal package resolver, which is not a stable public interface and may change across Pi versions. Treat the resolver as best-effort and review this script when upgrading Pi.

## Tests

Run the isolated mock-based tests from this repository with Node.js:

```sh
bash -n pi-startup-update
node --test tests/pi-startup-update.test.mjs
```

The tests use temporary directories and mocked Pi/process inspection; they do not run a live updater.
