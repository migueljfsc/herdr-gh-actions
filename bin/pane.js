import { spawn } from 'node:child_process';
import { loadConfig, configDir } from '../lib/config.js';
import { createGit } from '../lib/git.js';
import { createGh } from '../lib/gh.js';
import { createHerdr } from '../lib/herdr.js';
import { withPath } from '../lib/exec.js';
import { deriveStatus, sortRuns } from '../lib/state.js';
import { renderPane, buildItems, formatLog, wrapLines, clampTop, followSelection } from '../lib/render.js';
import { parseKeys } from '../lib/keys.js';

const out = process.stdout;
const { config } = loadConfig(configDir());
// --inline: running in the user's own pane (herdr-gh launcher); quitting returns to the shell.
const inline = process.argv.includes('--inline');
const git = createGit();
const gh = createGh({ accounts: config.accounts });

const S = {
  repo: null,
  branch: null,
  oid: null,
  ahead: null,
  behind: null,
  headTime: null,
  upstream: null,
  headSeenAt: Date.now(),
  runs: [],
  jobsByRun: new Map(),
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
  timer: null,
  busy: false,
};

const size = () => ({ cols: out.columns || 80, rows: out.rows || 24 });
const bodyH = () => size().rows - 2;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false });

function selectedIndex() {
  const i = S.items.findIndex((it) => it.key === S.selectedKey);
  return i >= 0 ? i : 0;
}

function rebuild() {
  S.items = buildItems({ runs: S.runs, jobsByRun: S.jobsByRun, expandedRuns: S.expandedRuns, expandedJobs: S.expandedJobs, head: S.oid });
  if (!S.items.some((it) => it.key === S.selectedKey)) S.selectedKey = S.items[0]?.key ?? null;
  S.top = followSelection(S.top, selectedIndex(), bodyH());
}

function header() {
  if (!S.repo) return null;
  const st = deriveStatus({ runs: S.runs, head: S.oid, headTime: S.headTime, ahead: S.ahead, behind: S.behind, upstream: S.upstream, headSeenAt: S.headSeenAt, pushedGraceMs: config.pushed_grace_seconds * 1000 });
  return { owner: S.repo.owner, repo: S.repo.repo, branch: S.branch, headShort: S.oid?.slice(0, 7), pushed: st.kind === 'pushed', ahead: S.ahead };
}

function draw() {
  const { cols, rows } = size();
  rebuild();
  const lines = renderPane(
    { header: header(), view: S.view, items: S.items, selected: selectedIndex(), top: S.top, log: S.log, status: S.status, empty: S.empty },
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
  const secs = anyActive() || pushed ? config.poll_seconds : config.idle_poll_seconds;
  S.timer = setTimeout(refresh, secs * 1000);
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
  if (S.busy) return;
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
      S.expandedRuns.clear();
      S.expandedJobs.clear();
      S.jobsByRun.clear();
      S.firstLoad = true;
    }
    Object.assign(S, { branch: bs?.head ?? null, oid: bs?.oid ?? null, headTime: bs?.time ?? null, ahead: bs?.ahead ?? null, behind: bs?.behind ?? null, upstream: bs?.upstream ?? null });
    if (!S.branch) {
      S.runs = [];
      S.empty = 'detached HEAD: no branch to watch';
      S.status = { updatedAt: clock(Date.now()) };
      return;
    }
    const { runs, authWarning } = await gh.runList(S.repo.owner, S.repo.repo, S.branch, config.runs_per_branch);
    S.runs = sortRuns(runs);
    S.empty = 'no runs for this branch';
    if (S.firstLoad && S.runs.length) {
      S.expandedRuns.add(S.runs[0].databaseId);
      S.selectedKey = `run:${S.runs[0].databaseId}`;
      S.firstLoad = false;
    }
    const ids = new Set(S.runs.map((r) => r.databaseId));
    for (const id of S.jobsByRun.keys()) if (!ids.has(id)) S.jobsByRun.delete(id);
    await Promise.all(
      S.runs
        .filter((r) => S.expandedRuns.has(r.databaseId))
        .filter((r) => !S.jobsByRun.get(r.databaseId)?.jobs || r.status !== 'completed' || hasActiveJobs(r.databaseId))
        .map((r) => loadJobs(r.databaseId)),
    );
    S.status = { updatedAt: clock(Date.now()), message: authWarning ? `⚠ gh auth fallback · updated ${clock(Date.now())}` : null, messageSgr: '33' };
    if (S.log?.pending) await openLog(freshTarget(S.log.target), S.log.failedOnly, true);
  } catch (e) {
    S.status = { stale: true, message: e.message, messageSgr: '33' };
  } finally {
    S.busy = false;
    draw();
    schedule();
  }
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

// target: { run, job? }. A job/run still running has no log yet: show steps and re-check on poll.
async function openLog(target, failedOnly, quiet = false) {
  const { run, job } = target;
  const title = `${job ? job.name : run.workflowName} · ${failedOnly ? 'failed steps' : 'log'}`;
  const done = job ? job.status === 'completed' : run.status === 'completed';
  if (!done) {
    const lines = job ? stepSummary(job) : [];
    lines.push({ text: '', sgr: null }, { text: 'log available when the job completes; re-checking on poll', sgr: '2' });
    S.log = { title, lines, top: 0, pending: true, target, failedOnly };
    S.view = 'log';
    draw();
    return;
  }
  if (!quiet) {
    S.log = { title, lines: [{ text: 'loading…', sgr: '2' }], top: 0, target, failedOnly };
    S.view = 'log';
    draw();
  }
  try {
    const raw = await gh.jobLog(S.repo.owner, S.repo.repo, run.databaseId, job?.databaseId ?? null, failedOnly);
    const lines = formatLog(raw);
    if (!lines.length) lines.push({ text: failedOnly ? 'no failed steps' : 'empty log', sgr: '2' });
    S.log = { title, lines, top: 0, target, failedOnly };
  } catch (e) {
    S.log = { title, lines: [{ text: `⚠ ${e.message}`, sgr: '33' }], top: 0, target, failedOnly };
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

async function handle({ action, y }) {
  if (action === 'quit') return quit();
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
      if (it.type === 'run') await toggleRun(it.run);
      else if (it.type === 'job' && it.expandable) {
        if (S.expandedJobs.has(it.job.databaseId)) S.expandedJobs.delete(it.job.databaseId);
        else S.expandedJobs.add(it.job.databaseId);
      } else if (it.type === 'step' || it.type === 'job') return openLog({ run: it.run, job: it.job }, false);
      break;
    case 'log':
    case 'failed':
      if (it) return openLog({ run: it.run, job: it.job ?? null }, action === 'failed');
      break;
    case 'open':
      if (it) openUrl(it.job?.url ?? it.run.url);
      break;
    case 'refresh':
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
    for (const k of parseKeys(chunk)) handle(k).catch(() => {});
  });
  out.on('resize', () => {
    out.write('\x1b[2J');
    draw();
  });
  setInterval(() => anyActive() && S.view === 'list' && draw(), 1000).unref();
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => quit({ close: false }));
  if (inline && process.env.HERDR_PANE_ID) createHerdr().call(['pane', 'rename', process.env.HERDR_PANE_ID, 'GH Actions']).catch(() => {});
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
