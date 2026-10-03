# herdr-gh-actions

[herdr](https://herdr.dev) plugin that shows GitHub Actions status for the branch checked out in
each workspace:

- **Sidebar token** `$ci` per workspace: `↑ pushed` · `◌ CI 2m` · `✓ CI` · `✗ CI` · `⚠ CI`
- **Pane** (split) with the branch's latest runs → jobs → steps, and job logs
- **Notification** when a run on a watched branch finishes (failures only by default)

Branch-based (`gh run list -b <branch>`), so it works right after a push, no PR needed.
Node ≥ 22, zero npm dependencies, uses your `gh` CLI auth.

## Install

```sh
herdr plugin install migueljfsc/herdr-gh-actions
# or, from a local checkout
herdr plugin link ~/path/to/herdr-gh-actions
```

The poller daemon starts with the herdr server. To start it without restarting the server, run the
refresh action once: `herdr plugin action invoke refresh --plugin migueljfsc.gh-actions`.

### Sidebar token

Add `$ci` to your spaces rows in `~/.config/herdr/config.toml`, then `herdr server reload-config`:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status", { token = "$ci", bold = true }]]
```

### Inline (in the current pane)

`herdr-gh` runs the same UI in the pane you're in; `q` returns to the shell. The plugin keeps
`~/.local/bin/herdr-gh` symlinked to its launcher (only when that dir exists, never over a real
file). A shell wrapper in the style of reviewr's:

```zsh
herdr() {
  case "$1" in
    gh) shift
        case "$1" in
          toggle|refresh) command herdr plugin action invoke "$1" --plugin migueljfsc.gh-actions ;;
          *) herdr-gh "$@" ;;
        esac ;;
    *) command herdr "$@" ;;
  esac
}
```

### Keybinding

```toml
[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "migueljfsc.gh-actions.toggle"
description = "GH Actions pane"
```

## Pane keys

| key | action |
| --- | --- |
| `j`/`k`, `↑`/`↓`, wheel | move |
| `Enter`, `→` | expand/collapse run or job; on a step, open its job log |
| `l` | log of selected job (or whole run) |
| `f` | failed steps only |
| `o` | open run/job in browser |
| `R` | refresh now |
| `g`/`G`, `PgUp`/`PgDn` | jump / page |
| `Esc` | back from log view |
| `q` | close pane |

Logs exist only once a job finishes; for a running job the log view shows live step status and
loads the log when the job completes.

## Config

Optional `config.json` in the plugin config dir (`herdr plugin config-dir migueljfsc.gh-actions`):

```json
{
  "poll_seconds": 10,
  "idle_poll_seconds": 60,
  "notify": "fail",
  "runs_per_branch": 5,
  "pushed_grace_seconds": 300,
  "accounts": { "my-org": "work-login", "*": "personal-login" }
}
```

| key | default | meaning |
| --- | --- | --- |
| `poll_seconds` | 10 | interval while any run is active or a push awaits its run |
| `idle_poll_seconds` | 60 | interval when everything is settled |
| `notify` | `fail` | `fail`: failed/timed-out runs · `all`: also successes · `off` |
| `runs_per_branch` | 5 | runs listed per branch |
| `pushed_grace_seconds` | 300 | how long `↑ pushed` waits for a run before falling back to the last run |
| `accounts` | `{}` | repo owner → `gh` login; `*` is the fallback. Token via `gh auth token --user <login>` |

Without `accounts`, `gh`'s active account is used. A mapped login without a token falls back to the
active account and the token shows `⚠auth`.

## How it works

- `startup` spawns a detached daemon per herdr session (state under
  `$HERDR_PLUGIN_STATE_DIR/sessions/<hash of socket path>/`: `daemon.pid`, `daemon.log`, `status.json`).
  It exits when the session's socket disappears.
- Each tick: `herdr pane list` → per workspace, the first pane cwd inside a GitHub repo
  (ssh host aliases resolved via `ssh -G`) → `git status --porcelain=v2 --branch` →
  `gh run list` (deduped per repo+branch) → token via `herdr workspace report-metadata` with a TTL of
  3× the interval, so tokens self-clear if the daemon dies.
- `refresh` action and `workspace.created`/`worktree.created` events send `SIGUSR1` for an immediate tick.
- The pane is pinned to the repo it was opened in and polls `gh` itself.

## Development

```sh
npm test                                            # node --test, no network
herdr plugin log list --plugin migueljfsc.gh-actions
tail -f ~/.local/state/herdr/plugins/migueljfsc.gh-actions/sessions/*/daemon.log
```

## License

MIT
