import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, configDir, expandHome, LAYOUTS } from '../lib/config.js';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, chmodSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createGit } from '../lib/git.js';
import { createGh } from '../lib/gh.js';
import { createHerdr } from '../lib/herdr.js';
import { withPath } from '../lib/exec.js';
import { deriveStatus, sortRuns, runAction, commitAction, findDispatchedRun, groupByCommit, commitStatus, FAIL } from '../lib/state.js';
import { sessionDir, stateRoot, readJson, writeJsonAtomic } from '../lib/session.js';
import { runningDaemon, codeIdentity } from '../lib/daemon-ctl.js';
import { renderPane, paneTitle, buildItems, buildFlatItems, footerHeight, formatLog, formatAnnotations, fmtSize, wrapLines, clampTop, followSelection } from '../lib/render.js';
import { keyStream, hintsFor, bandsFor } from '../lib/keys.js';
import { matchLines, errorLines, stepIndex } from '../lib/search.js';
import { failedSteps, buildExcerpt, agentPrompt, agentTargets } from '../lib/excerpt.js';
import { initialValue, missingInputs, inputFlags } from '../lib/dispatch-inputs.js';
import { prSummary } from '../lib/pr.js';

const out = process.stdout;
const { config } = loadConfig(configDir());
// --inline: running in the user's own pane (herdr-gh launcher); quitting returns to the shell.
const inline = process.argv.includes('--inline');
const git = createGit();
const gh = createGh({ accounts: config.accounts });

// The layout last picked with `v` wins over the config default, across panes and restarts.
const prefsPath = () => join(stateRoot(), 'pane.json');
function loadLayout() {
  const saved = readJson(prefsPath())?.layout;
  return LAYOUTS.has(saved) ? saved : config.pane_layout;
}
function saveLayout(layout) {
  try {
    writeJsonAtomic(prefsPath(), { layout });
  } catch {}
}

// Runs are read in steps of 100 until they cover the commits on show (commitLimit + 1, to know
// whether older ones exist) or the branch has no more runs. The ceiling only stops a runaway loop.
const RUN_STEP = 100;
const RUN_CEILING = 5000;

const S = {
  repo: null,
  branch: null,
  oid: null,
  ahead: null,
  behind: null,
  headTime: null,
  skipCi: false,
  upstream: null,
  headSeenAt: Date.now(),
  runs: [],
  jobsByRun: new Map(),
  // Commits start collapsed except the newest; when a newer one arrives it takes over, unless the
  // user toggled the previous one themselves (userCommits).
  expandedCommits: new Set(),
  userCommits: new Set(),
  newestSha: null,
  subjects: new Map(),
  expandedRuns: new Set(),
  expandedJobs: new Set(),
  items: [],
  selectedKey: null,
  top: 0,
  view: 'list',
  log: null,
  status: { loading: true },
  empty: 'loading…',
  firstLoad: true,
  commitLimit: config.commits_per_branch,
  runLimit: RUN_STEP,
  olderOnServer: false,
  timer: null,
  busy: false,
  again: false,
  confirm: null,
  layout: loadLayout(),
  keysOpen: false,
  picker: null,
  workflows: null,
  watch: null,
  pausedUntil: 0,
  input: null,
  // The branch's PR, read at most once per idle interval (R forces it): { branch, at, summary }.
  pr: null,
  prForce: false,
  // The default branch and its newest commit's status, read like the PR: { name, at, status }.
  base: null,
};

const DISPATCH_WATCH_MS = 120000;

const size = () => ({ cols: out.columns || 80, rows: out.rows || 24 });

function hasMore() {
  return new Set(S.runs.map((r) => r.headSha)).size > S.commitLimit || S.olderOnServer;
}

function footerModel() {
  const it = { list: S.items[selectedIndex()], log: S.log, picker: S.picker }[S.view] ?? null;
  return {
    status: S.status,
    confirm: S.confirm?.prompt,
    input: S.input,
    footer: { actions: hintsFor(S.view, it), bands: bandsFor(S.view, S.layout), open: S.keysOpen },
  };
}

// Rows under the header that the footer (one row, more with `?` open) leaves for the body.
const bodyH = () => size().rows - 1 - footerHeight(footerModel(), size().cols, size().rows);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false });

function selectedIndex() {
  const i = S.items.findIndex((it) => it.key === S.selectedKey);
  return i >= 0 ? i : 0;
}

function rebuild() {
  const args = {
    runs: S.runs,
    jobsByRun: S.jobsByRun,
    expandedCommits: S.expandedCommits,
    expandedRuns: S.expandedRuns,
    expandedJobs: S.expandedJobs,
    head: S.oid,
    commitLimit: S.commitLimit,
    subjects: S.subjects,
    more: hasMore() ? (S.layout === 'flat' ? 'more runs' : `${config.commits_per_branch} more commits`) : null,
  };
  S.items = S.layout === 'flat' ? buildFlatItems(args) : buildItems(args);
  if (!S.items.some((it) => it.key === S.selectedKey)) S.selectedKey = S.items[0]?.key ?? null;
  S.top = followSelection(S.top, selectedIndex(), bodyH());
}

function header() {
  if (!S.repo) return null;
  const st = deriveStatus({ runs: S.runs, head: S.oid, headTime: S.headTime, skipCi: S.skipCi, ahead: S.ahead, behind: S.behind, upstream: S.upstream, headSeenAt: S.headSeenAt, pushedGraceMs: config.pushed_grace_seconds * 1000 });
  const pr = S.pr?.branch === S.branch ? S.pr.summary : null;
  const base = S.base?.status && S.base.name !== S.branch ? S.base : null;
  return { owner: S.repo.owner, repo: S.repo.repo, branch: S.branch, headShort: S.oid?.slice(0, 7), pushed: st.kind === 'pushed', ahead: S.ahead, pr, base };
}

function draw() {
  const { cols, rows } = size();
  rebuild();
  const lines = renderPane(
    {
      header: header(),
      view: S.view,
      items: S.items,
      selected: selectedIndex(),
      top: S.top,
      log: S.log,
      picker: S.picker,
      empty: S.empty,
      ...footerModel(),
    },
    cols,
    rows,
  );
  let buf = '';
  lines.forEach((l, i) => (buf += `\x1b[${i + 1};1H${l}`));
  out.write(buf);
}

function anyActive() {
  return S.runs.some((r) => r.status !== 'completed');
}

function schedule() {
  clearTimeout(S.timer);
  const pushed = header()?.pushed;
  const secs = anyActive() || pushed || S.watch ? config.poll_seconds : config.idle_poll_seconds;
  S.timer = setTimeout(refresh, Math.max(secs * 1000, S.pausedUntil - Date.now()));
}

function refreshSoon(ms = 3000) {
  clearTimeout(S.timer);
  S.timer = setTimeout(refresh, ms);
}

function flash(message, sgr = '32') {
  S.status = { ...S.status, loading: false, message, messageSgr: sgr };
  draw();
}

// Let the sidebar daemon pick up a rerun/cancel/dispatch now instead of on its idle interval.
function nudgeDaemon() {
  if (!process.env.HERDR_SOCKET_PATH) return;
  try {
    const pid = runningDaemon(sessionDir());
    if (pid) process.kill(pid, 'SIGUSR1');
  } catch {}
}

// Expands and selects the run a dispatch created (before jobs load, so its jobs come with this poll).
// Returns the status-line message, if any.
function watchDispatch() {
  if (!S.watch) return null;
  const run = findDispatchedRun(S.runs, S.watch);
  if (run) {
    S.expandedCommits.add(run.headSha);
    S.expandedRuns.add(run.databaseId);
    S.selectedKey = `run:${run.databaseId}`;
    S.watch = null;
    nudgeDaemon();
    return { message: `watching ${run.workflowName} #${run.databaseId}`, messageSgr: '32' };
  }
  if (Date.now() > S.watch.until) {
    const message = `no run for ${S.watch.workflowName} yet; R to refresh`;
    S.watch = null;
    return { message, messageSgr: '33' };
  }
  return null;
}

async function loadJobs(runId) {
  try {
    const jobs = await gh.runJobs(S.repo.owner, S.repo.repo, runId);
    S.jobsByRun.set(runId, { jobs });
  } catch (e) {
    if (!S.jobsByRun.get(runId)?.jobs) S.jobsByRun.set(runId, { error: e.message });
  }
}

async function refresh() {
  // A refresh asked for mid-fetch (R, m, an action) runs right after it instead of being dropped.
  if (S.busy) {
    S.again = true;
    return;
  }
  S.busy = true;
  S.status = { ...S.status, loading: true };
  draw();
  try {
    if (!S.repo) {
      const root = await git.toplevel(process.cwd());
      const repo = root && (await git.githubRepo(root));
      if (!repo) {
        S.empty = `not a GitHub repo: ${process.cwd()}`;
        S.status = { message: 'nothing to watch' };
        return;
      }
      S.repo = { root, ...repo };
    }
    const bs = await git.branchState(S.repo.root);
    if (bs?.oid !== S.oid) S.headSeenAt = Date.now();
    if (bs?.head !== S.branch) {
      S.commitLimit = config.commits_per_branch;
      S.runLimit = RUN_STEP;
      S.expandedCommits.clear();
      S.userCommits.clear();
      S.newestSha = null;
      S.expandedRuns.clear();
      S.expandedJobs.clear();
      S.jobsByRun.clear();
      S.firstLoad = true;
      S.prForce = true;
    }
    Object.assign(S, { branch: bs?.head ?? null, oid: bs?.oid ?? null, headTime: bs?.time ?? null, skipCi: bs?.skipCi ?? false, ahead: bs?.ahead ?? null, behind: bs?.behind ?? null, upstream: bs?.upstream ?? null });
    if (!S.branch) {
      S.runs = [];
      S.empty = 'detached HEAD: no branch to watch';
      S.status = { updatedAt: clock(Date.now()) };
      return;
    }
    let runs;
    let authWarning;
    for (;;) {
      ({ runs, authWarning } = await gh.runList(S.repo.owner, S.repo.repo, S.branch, S.runLimit));
      const commits = new Set(runs.map((r) => r.headSha)).size;
      if (runs.length < S.runLimit || commits > S.commitLimit || S.runLimit >= RUN_CEILING) break;
      S.runLimit += RUN_STEP;
    }
    S.olderOnServer = runs.length >= S.runLimit;
    S.runs = sortRuns(runs);
    S.empty = 'no runs for this branch';
    refreshPr(S.prForce);
    refreshBase(S.prForce);
    S.prForce = false;
    followNewestCommit();
    await loadSubjects();
    const watched = watchDispatch();
    const ids = new Set(S.runs.map((r) => r.databaseId));
    for (const id of S.jobsByRun.keys()) if (!ids.has(id)) S.jobsByRun.delete(id);
    await Promise.all(
      S.runs
        .filter((r) => (S.layout === 'flat' || S.expandedCommits.has(r.headSha)) && S.expandedRuns.has(r.databaseId))
        .filter((r) => !S.jobsByRun.get(r.databaseId)?.jobs || r.status !== 'completed' || hasActiveJobs(r.databaseId))
        .map((r) => loadJobs(r.databaseId)),
    );
    S.status = { updatedAt: clock(Date.now()), message: authWarning ? `⚠ gh auth fallback · updated ${clock(Date.now())}` : null, messageSgr: '33' };
    if (watched) Object.assign(S.status, watched);
    if (S.log?.pending) await openLog(freshTarget(S.log.target), S.log.failedOnly, true);
  } catch (e) {
    if (e.rateLimited) S.pausedUntil = e.resetAt ?? Date.now() + 60000;
    const message = e.rateLimited ? `rate limited until ${clock(S.pausedUntil)}` : e.message;
    S.status = { stale: true, message, messageSgr: '33' };
  } finally {
    S.busy = false;
    draw();
    if (S.again) {
      S.again = false;
      refreshSoon(0);
    } else schedule();
  }
}

// In the background: a slow or failing PR lookup never holds up the run list.
function refreshPr(force = false) {
  const branch = S.branch;
  if (!branch || (!force && S.pr?.branch === branch && Date.now() - S.pr.at < config.idle_poll_seconds * 1000)) return;
  S.pr = { branch, at: Date.now(), summary: S.pr?.branch === branch ? S.pr.summary : null };
  gh.prForBranch(S.repo.owner, S.repo.repo, branch)
    .then((pr) => {
      if (S.pr?.branch !== branch) return;
      S.pr.summary = prSummary(pr);
      draw();
    })
    .catch(() => {});
}

// Status of the default branch's newest commit, for the header while on another branch.
function refreshBase(force = false) {
  if (!force && S.base?.at && Date.now() - S.base.at < config.idle_poll_seconds * 1000) return;
  S.base = { ...S.base, at: Date.now() };
  (async () => {
    S.base.name ??= (await git.defaultBranch(S.repo.root)) ?? (await gh.defaultBranch(S.repo.owner, S.repo.repo));
    if (!S.base.name || S.base.name === S.branch) return;
    const { runs } = await gh.runList(S.repo.owner, S.repo.repo, S.base.name, config.runs_per_branch);
    const newest = groupByCommit(runs)[0];
    S.base.status = newest ? commitStatus(newest.runs) : null;
    draw();
  })().catch(() => {});
}

async function loadSubjects() {
  const shas = [...new Set(S.runs.map((r) => r.headSha))].slice(0, S.commitLimit).filter((sha) => !S.subjects.has(sha));
  // null caches "not in the local clone"; the commit row then falls back to the runs' title.
  await Promise.all(shas.map(async (sha) => S.subjects.set(sha, await git.subject(S.repo.root, sha).catch(() => null))));
}

function followNewestCommit() {
  const newest = S.runs[0]?.headSha;
  if (!newest) return;
  if (S.firstLoad) {
    S.expandedCommits = new Set([newest]);
    S.selectedKey = `commit:${newest}`;
    S.firstLoad = false;
  } else if (newest !== S.newestSha) {
    if (S.newestSha && !S.userCommits.has(S.newestSha)) S.expandedCommits.delete(S.newestSha);
    S.expandedCommits.add(newest);
  }
  S.newestSha = newest;
}

function freshTarget({ run, job }) {
  const r = S.runs.find((x) => x.databaseId === run.databaseId) ?? run;
  const j = job && ((S.jobsByRun.get(r.databaseId)?.jobs ?? []).find((x) => x.databaseId === job.databaseId) ?? job);
  return { run: r, job: j };
}

function hasActiveJobs(runId) {
  return (S.jobsByRun.get(runId)?.jobs ?? []).some((j) => j.status !== 'completed');
}

function stepSummary(job) {
  return (job.steps ?? []).map((s) => {
    const mark = s.status === 'completed' ? s.conclusion : s.status;
    return { text: `${s.number}. ${s.name} — ${mark}`, sgr: s.status === 'in_progress' ? '33' : '2' };
  });
}

// Annotation lines for a failed job, or for each failed job of a run; [] when there are none.
async function annotationLines({ run, job }, failedOnly) {
  let jobs;
  if (job) jobs = failedOnly || FAIL.has(job.conclusion) ? [job] : [];
  else if (failedOnly || FAIL.has(run.conclusion)) {
    if (!S.jobsByRun.get(run.databaseId)?.jobs) await loadJobs(run.databaseId);
    jobs = (S.jobsByRun.get(run.databaseId)?.jobs ?? []).filter((j) => FAIL.has(j.conclusion));
  } else jobs = [];
  const groups = await Promise.all(
    jobs.map(async (j) => ({ job: j.name, list: await gh.annotations(S.repo.owner, S.repo.repo, j.databaseId).catch(() => []) })),
  );
  return formatAnnotations(groups);
}

// target: { run, job? }. A job/run still running has no log yet: show steps and re-check on poll.
async function openLog(target, failedOnly, quiet = false) {
  const { run, job } = target;
  const title = `${job ? job.name : run.workflowName} · ${failedOnly ? 'failed steps' : 'log'}`;
  // Reloading the same log keeps its search, including one typed while it loads.
  const kept = () => (S.log && S.log.target.run.databaseId === run.databaseId && S.log.target.job?.databaseId === job?.databaseId ? S.log.query : null);
  const done = job ? job.status === 'completed' : run.status === 'completed';
  if (!done) {
    const lines = job ? stepSummary(job) : [];
    lines.push({ text: '', sgr: null }, { text: 'log available when the job completes; re-checking on poll', sgr: '2' });
    S.log = { title, lines, top: 0, pending: true, target, failedOnly, query: kept() };
    S.view = 'log';
    draw();
    return;
  }
  if (!quiet) {
    S.log = { title, lines: [{ text: 'loading…', sgr: '2' }], top: 0, target, failedOnly, query: kept() };
    S.view = 'log';
    draw();
  }
  try {
    const [raw, notes] = await Promise.all([gh.jobLog(S.repo.owner, S.repo.repo, run.databaseId, job?.databaseId ?? null, failedOnly), annotationLines(target, failedOnly)]);
    const lines = [...notes, ...formatLog(raw)];
    if (lines.length === notes.length) lines.push({ text: failedOnly ? 'no failed steps' : 'empty log', sgr: '2' });
    S.log = { title, lines, top: 0, target, failedOnly, query: kept() };
  } catch (e) {
    S.log = { title, lines: [{ text: `⚠ ${e.message}`, sgr: '33' }], top: 0, target, failedOnly, query: kept() };
  }
  if (S.view === 'log') draw();
}

function openUrl(url) {
  if (!url) return;
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore', env: withPath() }).unref();
  } catch {}
}

function move(delta) {
  if (!S.items.length) return;
  const i = Math.max(0, Math.min(S.items.length - 1, selectedIndex() + delta));
  S.selectedKey = S.items[i].key;
}

function scrollLog(delta) {
  const total = wrapLines(S.log.lines, size().cols).length;
  S.log.top = clampTop(S.log.top + delta, total, bodyH() - 1);
}

// Moves the log cursor to the next/previous of `indices` (source lines) and scrolls it into view
// with two rows of context above.
function logJump(indices, dir, what) {
  const log = S.log;
  const idx = stepIndex(indices, log.cursor ?? (dir > 0 ? -1 : Infinity), dir);
  if (idx == null) return flash(`no ${what}`, '33');
  log.cursor = idx;
  const wrapped = wrapLines(log.lines, size().cols);
  log.top = clampTop(wrapped.findIndex((l) => l.src === idx) - 2, wrapped.length, bodyH() - 1);
  flash(`${what} ${indices.indexOf(idx) + 1}/${indices.length}`, '2');
}

// One-line text prompt in the footer; submit(value) runs on Enter, Esc cancels.
function prompt(label, value, submit) {
  S.input = { prompt: label, value, submit };
  draw();
}

function handleInput({ action, ch }) {
  const input = S.input;
  if (action === 'char') input.value += ch;
  else if (action === 'backspace') input.value = [...input.value].slice(0, -1).join('');
  else if (action === 'clear') input.value = '';
  else if (action === 'back') S.input = null;
  else if (action === 'enter') {
    S.input = null;
    return input.submit(input.value);
  }
  draw();
}

async function toggleRun(run) {
  const id = run.databaseId;
  if (S.expandedRuns.has(id)) S.expandedRuns.delete(id);
  else {
    S.expandedRuns.add(id);
    if (!S.jobsByRun.get(id)?.jobs) {
      draw();
      await loadJobs(id);
    }
  }
}

function askRunAction(action, run) {
  const check = runAction(action, run);
  if (!check.ok) return flash(check.reason, '33');
  S.confirm = {
    prompt: check.prompt,
    run: async () => {
      flash(`${action === 'cancel' ? 'cancelling' : 'requesting rerun'}…`, '2');
      if (action === 'cancel') await gh.cancel(S.repo.owner, S.repo.repo, run.databaseId);
      else await gh.rerun(S.repo.owner, S.repo.repo, run.databaseId, action === 'rerun-failed');
      S.jobsByRun.delete(run.databaseId);
      flash(action === 'cancel' ? 'cancel requested' : 'rerun requested');
      nudgeDaemon();
      refreshSoon();
    },
  };
  draw();
}

function askCommitAction(action, commit) {
  const check = commitAction(action, commit);
  if (!check.ok) return flash(check.reason, '33');
  S.confirm = {
    prompt: check.prompt,
    run: async () => {
      flash(`${action === 'cancel' ? 'cancelling' : 'requesting reruns'}…`, '2');
      const failed = [];
      for (const r of check.runs) {
        try {
          if (action === 'cancel') await gh.cancel(S.repo.owner, S.repo.repo, r.databaseId);
          else await gh.rerun(S.repo.owner, S.repo.repo, r.databaseId, action === 'rerun-failed');
          S.jobsByRun.delete(r.databaseId);
        } catch (e) {
          failed.push(`${r.workflowName}: ${e.message}`);
        }
      }
      const done = check.runs.length - failed.length;
      if (failed.length) flash(`⚠ ${done}/${check.runs.length} requested · ${failed[0]}`, '33');
      else flash(`${action === 'cancel' ? 'cancel' : 'rerun'} requested for ${done} run${done === 1 ? '' : 's'}`);
      nudgeDaemon();
      refreshSoon();
    },
  };
  draw();
}

// Next batch of commits; the selection stays on the last row that was already shown.
function loadMore() {
  if (!hasMore()) return flash('no older runs on this branch', '2');
  const i = S.items.findIndex((it) => it.key === 'more');
  if (S.selectedKey === 'more' && i > 0) S.selectedKey = S.items[i - 1].key;
  S.commitLimit += config.commits_per_branch;
  flash('loading more…', '2');
  clearTimeout(S.timer);
  return refresh();
}

// Keep the selection across layouts: a commit row maps to its newest run; a run/job/step keeps its
// key and, going back to commits, its commit is opened so the row stays visible.
function switchLayout(it) {
  S.layout = S.layout === 'commit' ? 'flat' : 'commit';
  if (S.layout === 'flat' && it?.type === 'commit') S.selectedKey = `run:${it.commit.runs[0].databaseId}`;
  if (S.layout === 'commit' && it?.commit) {
    S.expandedCommits.add(it.commit.sha);
    S.userCommits.add(it.commit.sha);
  }
  saveLayout(S.layout);
  flash(S.layout === 'flat' ? 'flat list' : 'grouped by commit', '2');
}

// A list to pick from. load() → { items, empty }; pick(item) runs on Enter; verb labels Enter.
async function showPicker({ title, verb, loading, load, pick, back }) {
  const p = { title, verb, pick, back, items: [], selected: 0, top: 0, empty: loading };
  S.view = 'picker';
  S.picker = p;
  draw();
  try {
    Object.assign(p, await load());
  } catch (e) {
    Object.assign(p, { items: [], empty: `⚠ ${e.message}` });
  }
  p.top = followSelection(0, p.selected, bodyH() - 1);
  if (S.view === 'picker' && S.picker === p) draw();
}

function openPicker() {
  if (!S.repo || !S.branch) return flash('no branch to run a workflow on', '33');
  return showPicker({
    title: `Run workflow on ${S.branch}`,
    verb: 'run',
    loading: 'loading workflows…',
    load: async () => {
      if (S.workflows?.branch !== S.branch) S.workflows = { branch: S.branch, list: await gh.workflows(S.repo.owner, S.repo.repo, S.branch) };
      const items = S.workflows.list
        .filter((w) => w.dispatchable)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((w) => {
          const n = w.inputs?.length ?? 0;
          return { key: `wf:${w.id}`, workflow: w, depth: 0, glyph: ['▶', '36'], label: w.name, meta: [w.path.split('/').pop(), n ? `${n} input${n === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') };
        });
      return { items, empty: `no workflow on ${S.branch} has a workflow_dispatch trigger` };
    },
    pick: (it) => (it.workflow.inputs?.length ? showForm({ workflow: it.workflow, values: Object.fromEntries(it.workflow.inputs.map((i) => [i.name, initialValue(i)])) }) : askDispatch(it.workflow)),
  });
}

const CHOOSE = new Set(['choice', 'environment']);

function formItems({ workflow: w, values }) {
  const rows = w.inputs.map((inp) => {
    const v = values[inp.name];
    const shown = inp.type === 'boolean' ? String(v) : v === '' ? '—' : v;
    return {
      key: `input:${inp.name}`,
      input: inp,
      depth: 0,
      glyph: inp.type === 'boolean' ? (v ? ['☑', '32'] : ['☐', '2']) : ['›', '36'],
      label: `${inp.name}${inp.required ? ' *' : ''} = ${shown}`,
      meta: inp.description.split('\n')[0],
      verb: inp.type === 'boolean' ? 'toggle' : CHOOSE.has(inp.type) ? 'choose' : 'edit',
    };
  });
  return [...rows, { key: 'run', depth: 0, glyph: ['▶', '32'], label: `run ${w.name} on ${S.branch}`, verb: 'run' }];
}

// Dispatch form: a row per input and a run row; Esc goes back to the workflow list.
function showForm(form, selected = 0) {
  S.view = 'picker';
  S.picker = {
    title: `Run ${form.workflow.name} on ${S.branch}`,
    items: formItems(form),
    selected,
    top: 0,
    empty: '',
    pick: (it) => editField(form, it),
    back: () => openPicker(),
  };
  S.picker.top = followSelection(0, selected, bodyH() - 1);
  draw();
}

function editField(form, it) {
  const at = S.picker.selected;
  if (it.key === 'run') {
    const missing = missingInputs(form.workflow.inputs, form.values);
    if (missing.length) return flash(`required: ${missing.join(', ')}`, '33');
    return askDispatch(form.workflow, inputFlags(form.workflow.inputs, form.values));
  }
  const inp = it.input;
  const set = (v) => {
    form.values[inp.name] = v;
    showForm(form, at);
  };
  if (inp.type === 'boolean') return set(!form.values[inp.name]);
  if (CHOOSE.has(inp.type)) {
    return showPicker({
      title: `${inp.name}${inp.description ? ` · ${inp.description.split('\n')[0]}` : ''}`,
      verb: 'choose',
      loading: 'loading environments…',
      load: async () => {
        const options = inp.type === 'environment' ? await gh.environments(S.repo.owner, S.repo.repo) : inp.options;
        const items = options.map((o) => ({ key: `opt:${o}`, value: o, depth: 0, glyph: o === form.values[inp.name] ? ['●', '32'] : ['○', '2'], label: o }));
        return { items, selected: Math.max(0, options.indexOf(form.values[inp.name])), empty: 'no options' };
      },
      pick: (row) => set(row.value),
      back: () => showForm(form, at),
    });
  }
  return prompt(`${inp.name}: `, String(form.values[inp.name] ?? ''), (v) => {
    if (inp.type === 'number' && v.trim() !== '' && !Number.isFinite(Number(v))) return flash(`${inp.name} must be a number`, '33');
    set(v);
  });
}

// Environments a waiting run needs approval for: an approve and a reject row per environment.
function openDeployments(run) {
  if (!run) return flash('select a run', '33');
  if (run.status !== 'waiting') return flash(`${run.workflowName} #${run.databaseId} is not waiting for a deployment review`, '33');
  return showPicker({
    title: `Review deployments of ${run.workflowName} #${run.databaseId}`,
    verb: 'review',
    loading: 'loading pending deployments…',
    load: async () => {
      const pending = await gh.pendingDeployments(S.repo.owner, S.repo.repo, run.databaseId);
      const items = pending.flatMap((d) =>
        ['approved', 'rejected'].map((state) => ({
          key: `deploy:${d.environment.id}:${state}`,
          env: d.environment,
          state,
          canApprove: d.current_user_can_approve,
          depth: 0,
          glyph: state === 'approved' ? ['✓', '32'] : ['✗', '31'],
          label: `${state === 'approved' ? 'approve' : 'reject'} ${d.environment.name}`,
          meta: d.current_user_can_approve ? null : 'not a reviewer',
          dim: !d.current_user_can_approve,
        })),
      );
      return { items, empty: 'no pending deployments' };
    },
    pick: (it) => {
      if (!it.canApprove) return flash(`you can't review ${it.env.name}`, '33');
      const verb = it.state === 'approved' ? 'approve' : 'reject';
      S.confirm = {
        prompt: `${verb} deployment of ${run.workflowName} #${run.databaseId} to ${it.env.name}?`,
        run: async () => {
          flash(`${verb === 'approve' ? 'approving' : 'rejecting'}…`, '2');
          await gh.reviewDeployments(S.repo.owner, S.repo.repo, run.databaseId, [it.env.id], it.state, `${it.state} from herdr`);
          S.view = 'list';
          flash(`${it.env.name} ${it.state}`);
          nudgeDaemon();
          refreshSoon();
        },
      };
      draw();
    },
  });
}

const EXCERPT_TTL_MS = 7 * 24 * 3600 * 1000;

// Excerpts can hold log lines GitHub didn't mask: owner-only, and pruned after a week.
function writeExcerpt(name, text) {
  const dir = join(stateRoot(), 'excerpts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(dir)) {
    try {
      if (Date.now() - statSync(join(dir, f)).mtimeMs > EXCERPT_TTL_MS) rmSync(join(dir, f));
    } catch {}
  }
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// Types a one-line prompt pointing at a failure excerpt into an agent pane, without pressing Enter.
async function deliverToAgent(pane, run, job) {
  flash('collecting failed steps…', '2');
  try {
    const [raw, notes] = await Promise.all([
      gh.jobLog(S.repo.owner, S.repo.repo, run.databaseId, job?.databaseId ?? null, true),
      annotationLines({ run, job }, true),
    ]);
    const ctx = { owner: S.repo.owner, repo: S.repo.repo, branch: S.branch, sha: run.headSha, workflow: run.workflowName, job: job?.name, url: job?.url ?? run.url };
    const path = writeExcerpt(`${S.repo.owner}-${S.repo.repo}-${run.databaseId}${job ? `-${job.databaseId}` : ''}.md`, buildExcerpt(ctx, failedSteps(raw), notes));
    await createHerdr().call(['pane', 'send-text', pane.pane_id, agentPrompt(ctx, path)]);
    if (S.view === 'picker') S.view = 'list';
    flash(`sent to ${pane.agent} (${pane.pane_id}); press Enter there to submit`);
  } catch (e) {
    flash(`⚠ ${e.message}`, '33');
  }
}

async function sendToAgent(it) {
  const run = it?.run;
  if (!run) return flash('select a failed run or job', '33');
  const job = it.type === 'run' ? null : it.job;
  if (!FAIL.has((job ?? run).conclusion)) return flash(`${(job ?? run).name ?? run.workflowName} has not failed`, '33');
  if (!process.env.HERDR_SOCKET_PATH) return flash('agents need herdr: not running inside it', '33');
  flash('looking for agents…', '2');
  const self = process.env.HERDR_PANE_ID;
  let targets;
  try {
    const panes = await createHerdr().paneList();
    const agents = await Promise.all(
      panes.filter((p) => p.agent).map(async (p) => ({ ...p, root: await git.toplevel(p.foreground_cwd || p.cwd).catch(() => null) })),
    );
    targets = agentTargets(agents, { root: S.repo.root, workspaceId: panes.find((p) => p.pane_id === self)?.workspace_id, selfId: self });
  } catch (e) {
    return flash(`⚠ ${e.message}`, '33');
  }
  if (!targets.length) return flash('no agent pane in this repo or workspace', '33');
  if (targets.length === 1) {
    const [p] = targets;
    S.confirm = { prompt: `send ${job ? job.name : run.workflowName} failure to ${p.agent} (${p.pane_id})?`, run: () => deliverToAgent(p, run, job) };
    return draw();
  }
  return showPicker({
    title: `Send ${job ? job.name : run.workflowName} failure to an agent`,
    verb: 'send',
    loading: '',
    load: async () => ({
      items: targets.map((p) => ({
        key: `agent:${p.pane_id}`,
        pane: p,
        depth: 0,
        glyph: ['›', '36'],
        label: `${p.agent} · ${p.pane_id}`,
        meta: p.root === S.repo.root ? 'this repo' : (p.foreground_cwd || p.cwd),
      })),
      empty: 'no agents',
    }),
    pick: (row) => deliverToAgent(row.pane, run, job),
  });
}

function openArtifacts(run) {
  if (!run) return flash('select a run to see its artifacts', '33');
  const dir = join(expandHome(config.artifact_dir), `${S.repo.repo}-${run.databaseId}`);
  return showPicker({
    title: `Artifacts of ${run.workflowName} #${run.databaseId}`,
    verb: 'download',
    loading: 'loading artifacts…',
    load: async () => {
      const list = await gh.artifacts(S.repo.owner, S.repo.repo, run.databaseId);
      const items = list.map((a) => ({
        key: `artifact:${a.id}`,
        artifact: a,
        depth: 0,
        glyph: a.expired ? ['–', '2'] : ['↓', '36'],
        label: a.name,
        meta: [fmtSize(a.size_in_bytes), a.expired ? 'expired' : null].filter(Boolean).join(' · '),
        dim: a.expired,
      }));
      return { items, empty: run.status === 'completed' ? 'no artifacts' : 'no artifacts yet (run still going)' };
    },
    pick: async ({ artifact: a }) => {
      if (a.expired) return flash(`${a.name} has expired`, '33');
      flash(`downloading ${a.name}…`, '2');
      try {
        const to = await gh.download(S.repo.owner, S.repo.repo, run.databaseId, a, dir);
        flash(`saved ${a.name} to ${to.replace(homedir(), '~')}`);
      } catch (e) {
        flash(`⚠ ${e.message}`, '33');
      }
    },
  });
}

// flags: `-f name=value` pairs from the dispatch form.
function askDispatch(w, flags = []) {
  const pairs = flags.filter((f) => f !== '-f');
  S.confirm = {
    prompt: `run "${w.name}" on ${S.branch}${pairs.length ? ` with ${pairs.join(' ')}` : ''}?`,
    run: async () => {
      flash(`dispatching ${w.name}…`, '2');
      await gh.dispatch(S.repo.owner, S.repo.repo, w.id, S.branch, flags);
      S.view = 'list';
      S.watch = { workflowName: w.name, since: Date.now(), until: Date.now() + DISPATCH_WATCH_MS };
      flash(`dispatched ${w.name}; waiting for its run…`);
      nudgeDaemon();
      refreshSoon();
    },
  };
  draw();
}

async function handle({ action, y, ch }) {
  rebuild();
  if (S.confirm) {
    const c = S.confirm;
    S.confirm = null;
    if (action !== 'yes') return flash('cancelled', '2');
    try {
      await c.run();
    } catch (e) {
      flash(`⚠ ${e.message}`, '33');
    }
    return;
  }
  if (S.input) return handleInput({ action, ch });
  if (action === 'quit') return quit();
  if (action === 'keys') {
    S.keysOpen = !S.keysOpen;
    return draw();
  }
  if (action === 'back' && S.keysOpen) {
    S.keysOpen = false;
    return draw();
  }
  if (S.view === 'picker') {
    const p = S.picker;
    const viewH = bodyH() - 1;
    if (action === 'back') {
      if (p.back) return p.back();
      S.view = 'list';
    } else if (action === 'up' || action === 'down') {
      p.selected = Math.max(0, Math.min(p.items.length - 1, p.selected + (action === 'up' ? -1 : 1)));
      p.top = followSelection(p.top, p.selected, viewH);
    } else if (action === 'click') {
      const row = p.top + (y - 3);
      if (row >= 0 && row < p.items.length) p.selected = row;
    } else if (action === 'enter' && p.items[p.selected]) return p.pick(p.items[p.selected]);
    return draw();
  }
  if (S.view === 'log') {
    const page = bodyH() - 2;
    if (action === 'back') S.view = 'list';
    else if (action === 'up') scrollLog(-1);
    else if (action === 'down') scrollLog(1);
    else if (action === 'pageup') scrollLog(-page);
    else if (action === 'pagedown') scrollLog(page);
    else if (action === 'top') scrollLog(-Infinity);
    else if (action === 'bottom') scrollLog(Number.MAX_SAFE_INTEGER);
    else if (action === 'refresh') await openLog(S.log.target, S.log.failedOnly);
    else if (action === 'search')
      return prompt('/', S.log.query ?? '', (q) => {
        S.log.query = q || null;
        S.log.cursor = null;
        if (!q) return draw();
        logJump(matchLines(S.log.lines, q), 1, `"${q}"`);
      });
    else if (action === 'next' || action === 'prev') {
      if (!S.log.query) return flash('/ to search', '33');
      return logJump(matchLines(S.log.lines, S.log.query), action === 'next' ? 1 : -1, `"${S.log.query}"`);
    } else if (action === 'error-next' || action === 'error-prev') return logJump(errorLines(S.log.lines), action === 'error-next' ? 1 : -1, 'error');
    else if (action === 'open') openUrl(S.log.target.job?.url ?? S.log.target.run.url);
    return draw();
  }
  const it = S.items[selectedIndex()];
  switch (action) {
    case 'up':
      move(-1);
      break;
    case 'down':
      move(1);
      break;
    case 'pageup':
      move(-(bodyH() - 1));
      break;
    case 'pagedown':
      move(bodyH() - 1);
      break;
    case 'top':
      move(-Infinity);
      break;
    case 'bottom':
      move(Infinity);
      break;
    case 'click': {
      const row = S.top + (y - 2);
      if (row >= 0 && row < S.items.length) S.selectedKey = S.items[row].key;
      break;
    }
    case 'enter':
      if (!it) break;
      if (it.type === 'more') return loadMore();
      if (it.type === 'commit') {
        const sha = it.commit.sha;
        if (S.expandedCommits.has(sha)) S.expandedCommits.delete(sha);
        else S.expandedCommits.add(sha);
        S.userCommits.add(sha);
      } else if (it.type === 'run') await toggleRun(it.run);
      else if (it.type === 'job' && it.expandable) {
        if (S.expandedJobs.has(it.job.databaseId)) S.expandedJobs.delete(it.job.databaseId);
        else S.expandedJobs.add(it.job.databaseId);
      } else if (it.type === 'step' || it.type === 'job') return openLog({ run: it.run, job: it.job }, false);
      break;
    case 'log':
    case 'failed':
      if (it?.type === 'commit' || it?.type === 'more') return flash('select a run or job to see its log', '33');
      if (it) return openLog({ run: it.run, job: it.job ?? null }, action === 'failed');
      break;
    case 'open':
      if (it?.type === 'commit') openUrl(`https://github.com/${S.repo.owner}/${S.repo.repo}/commit/${it.commit.sha}`);
      else if (it?.run) openUrl(it.job?.url ?? it.run.url);
      break;
    case 'rerun-failed':
    case 'rerun-all':
    case 'cancel':
      if (it?.type === 'commit') return askCommitAction(action, it.commit);
      return askRunAction(action, it?.run);
    case 'workflows':
      return openPicker();
    case 'artifacts':
      return openArtifacts(it?.run);
    case 'deployments':
      return openDeployments(it?.run);
    case 'agent':
      return sendToAgent(it);
    case 'layout':
      switchLayout(it);
      break;
    case 'more':
      return loadMore();
    case 'pr':
      if (S.pr?.branch === S.branch && S.pr.summary) openUrl(S.pr.summary.url);
      else flash(`no pull request for ${S.branch}`, '33');
      break;
    case 'refresh':
      S.prForce = true;
      // A manual refresh also drops commits loaded with `more`, back to commits_per_branch.
      S.commitLimit = config.commits_per_branch;
      S.runLimit = RUN_STEP;
      clearTimeout(S.timer);
      return refresh();
  }
  draw();
}

function setup() {
  out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const k of keyStream(chunk, () => S.input != null)) handle(k).catch(() => {});
  });
  out.on('resize', () => {
    out.write('\x1b[2J');
    draw();
  });
  setInterval(() => anyActive() && S.view === 'list' && draw(), 1000).unref();
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => quit({ close: false }));
  if (process.env.HERDR_PANE_ID) createHerdr().call(['pane', 'rename', process.env.HERDR_PANE_ID, paneTitle(codeIdentity().version)]).catch(() => {});
}

function restore() {
  out.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function quit({ close = true } = {}) {
  restore();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) process.exit(0);
  const herdr = createHerdr();
  const done = inline
    ? herdr.call(['pane', 'rename', pane, '--clear'])
    : close
      ? herdr.paneClose(pane)
      : Promise.resolve();
  done.catch(() => {}).finally(() => process.exit(0));
}

setup();
draw();
refresh();
