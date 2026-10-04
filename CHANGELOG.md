## v1.3.0 (2026-10-04)

### Feat

- **pane**: excerpt limits, version in the pane label, AI agent docs (#3)

## v1.2.0 (2026-10-04)

### Feat

- pane workbench: log search, annotations, dispatch inputs, deployments, artifacts, agents, PR header (#1)

## v1.1.0 (2026-10-03)

### Feat

- move a running poller onto the installed version after an update

## v1.0.0 (2026-10-03)

First stable release. Everything from the 0.x series, now with a documented, stable surface:

- **Sidebar token** `$ci` per workspace and per agent pane (`↑ pushed` · `◌ CI` · `✓ CI` · `✗ CI` · `⚠ CI`), from a poller per herdr session
- **Pane** with commits → runs → jobs → steps, grouped by commit or as a flat list (`v`, remembered), older commits on demand (`▾ more` / `m`)
- **Logs**: full or failed steps only, inside the pane
- **Actions**: re-run failed or all jobs and cancel, per run or per commit; dispatch a `workflow_dispatch` workflow and follow its run
- **Shortcuts footer** with the keys for the selected row, `?` for all of them
- **Notifications** when a watched run fails
- **Accounts** per repo owner, for work and personal `gh` logins

## v0.6.1 (2026-10-03)

### Fix

- **pane**: refresh goes back to the first commits_per_branch commits

## v0.6.0 (2026-10-03)

### Feat

- **pane**: load older commits with a more row or m

## v0.5.0 (2026-10-03)

### Feat

- **pane**: flat or by-commit layout (v) and a shortcuts footer (?)

## v0.4.0 (2026-10-03)

### Feat

- **pane**: group runs by commit

### Fix

- read 20 runs per branch so the newest commit's status is complete

## v0.3.1 (2026-10-03)

### Fix

- **pane**: load a dispatched run's jobs in the poll that finds it

## v0.3.0 (2026-10-03)

### Feat

- **pane**: re-run, cancel and dispatch workflows from the pane
- ci token on agent panes for the branch their cwd is on

## v0.2.0 (2026-10-03)

### Feat

- GitHub Actions status per workspace branch for herdr
