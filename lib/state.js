// Latest attempt's start: a re-run keeps createdAt from the first attempt.
export const runStart = (r) => Date.parse(r.startedAt || r.createdAt);

export const FAIL = new Set(['failure', 'timed_out', 'startup_failure']);
export const BAD = new Set([...FAIL, 'cancelled']);

// Newest first; runs created in the same second (one push, several workflows) tie-break on id so
// rows never swap places between polls.
export function sortRuns(runs) {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId);
}

// Latest run per workflow among runs for one commit (re-runs and re-triggers collapse).
export function latestPerWorkflow(runs) {
  const seen = new Set();
  const out = [];
  for (const r of sortRuns(runs)) {
    if (seen.has(r.workflowName)) continue;
    seen.add(r.workflowName);
    out.push(r);
  }
  return out;
}

/**
 * Status of the branch from its newest runs and the local checkout.
 * kind: none | pushed | running | success | failure
 * "pushed" = HEAD is on the upstream, committed after the newest run, and no run carries it yet.
 * It lapses after pushedGraceMs (a push may trigger no workflow), falling back to the newest run.
 * A checkout behind its upstream, or with HEAD older than the newest run, is just stale; a HEAD
 * carrying a [skip ci] marker never gets a run.
 */
export function deriveStatus({ runs = [], head = null, headTime = null, skipCi = false, ahead = null, behind = null, upstream = null, headSeenAt = 0, now = Date.now(), pushedGraceMs = 300000 }) {
  const sorted = sortRuns(runs);
  if (!sorted.length) return { kind: 'none' };
  const headInRuns = head != null && sorted.some((r) => r.headSha === head);
  const newerThanRuns = headTime == null || headTime > Date.parse(sorted[0].createdAt);
  if (head && !headInRuns && !skipCi && upstream && ahead === 0 && !behind && newerThanRuns && now - headSeenAt < pushedGraceMs) {
    return { kind: 'pushed', sha: head, current: true };
  }
  const sha = headInRuns ? head : sorted[0].headSha;
  const group = latestPerWorkflow(sorted.filter((r) => r.headSha === sha));
  const current = sha === head;
  const active = group.filter((r) => r.status !== 'completed');
  if (active.length) {
    const since = Math.min(...active.map(runStart));
    return { kind: 'running', sha, current, since, workflows: group.map((r) => r.workflowName) };
  }
  const failed = group.filter((r) => BAD.has(r.conclusion));
  if (failed.length) return { kind: 'failure', sha, current, failed: failed.map((r) => r.workflowName) };
  return { kind: 'success', sha, current };
}

/**
 * Whether a run action applies to `run`. → { ok, prompt } or { ok: false, reason }.
 * rerun needs a finished run; cancel needs one still going.
 */
export function runAction(action, run) {
  if (!run) return { ok: false, reason: 'select a run' };
  const done = run.status === 'completed';
  const name = `"${run.workflowName}" #${run.databaseId} (${run.displayTitle})`;
  switch (action) {
    case 'rerun-failed':
      if (!done) return { ok: false, reason: `${name} is still running` };
      if (!BAD.has(run.conclusion)) return { ok: false, reason: `${name} has no failed jobs (X reruns all)` };
      return { ok: true, prompt: `rerun failed jobs of ${name}?` };
    case 'rerun-all':
      if (!done) return { ok: false, reason: `${name} is still running` };
      return { ok: true, prompt: `rerun all jobs of ${name}?` };
    case 'cancel':
      if (done) return { ok: false, reason: `${name} already finished` };
      return { ok: true, prompt: `cancel ${name}?` };
    default:
      return { ok: false, reason: `unknown action ${action}` };
  }
}

// The run a workflow_dispatch produced: newest manual run of that workflow created since the dispatch
// (10s slack for clock skew between this machine and GitHub).
export function findDispatchedRun(runs, { workflowName, since }) {
  return (
    sortRuns(runs).find((r) => r.event === 'workflow_dispatch' && r.workflowName === workflowName && Date.parse(r.createdAt) >= since - 10000) ?? null
  );
}

/**
 * Runs grouped by commit, newest commit first (by its newest run). The title prefers a push run's
 * displayTitle (the commit subject); a dispatched run's displayTitle is just the workflow name.
 */
export function groupByCommit(runs) {
  const groups = new Map();
  for (const r of sortRuns(runs)) {
    if (!groups.has(r.headSha)) groups.set(r.headSha, []);
    groups.get(r.headSha).push(r);
  }
  return [...groups].map(([sha, list]) => ({
    sha,
    runs: list,
    title: (list.find((r) => r.event === 'push' || r.event === 'pull_request') ?? list[0]).displayTitle,
  }));
}

// Overall status of one commit's runs: running | failure | success (latest run per workflow).
export function commitStatus(runs) {
  const group = latestPerWorkflow(runs);
  if (group.some((r) => r.status !== 'completed')) return 'running';
  if (group.some((r) => BAD.has(r.conclusion))) return 'failure';
  return 'success';
}

/**
 * A run action applied to every run of a commit it fits. → { ok, prompt, runs } or { ok: false, reason }.
 * x: re-run failed jobs of its finished failed runs · X: re-run all its finished runs · c: cancel its active runs.
 */
export function commitAction(action, commit) {
  const sha = commit.sha.slice(0, 7);
  const latest = latestPerWorkflow(commit.runs);
  const plural = (n) => `${n} run${n === 1 ? '' : 's'}`;
  let runs;
  let what;
  if (action === 'rerun-failed') {
    runs = latest.filter((r) => r.status === 'completed' && BAD.has(r.conclusion));
    what = 'rerun failed jobs of';
  } else if (action === 'rerun-all') {
    runs = latest.filter((r) => r.status === 'completed');
    what = 'rerun all jobs of';
  } else if (action === 'cancel') {
    runs = latest.filter((r) => r.status !== 'completed');
    what = 'cancel';
  } else {
    return { ok: false, reason: `unknown action ${action}` };
  }
  if (!runs.length) {
    const none = { 'rerun-failed': 'no failed runs', 'rerun-all': 'no finished runs', cancel: 'no active runs' }[action];
    return { ok: false, reason: `${sha}: ${none}` };
  }
  const names = runs.map((r) => r.workflowName).join(', ');
  return { ok: true, prompt: `${what} ${plural(runs.length)} of ${sha} (${names})?`, runs };
}

export function isActive(status) {
  return status.kind === 'running' || status.kind === 'pushed';
}

/**
 * Runs that completed since the last observation. A run first seen already completed only counts
 * when created after `sinceMs` (when this workspace started being watched).
 * Returns { done, known } where known is the next id → status map.
 */
export function newlyCompleted(runs, known, sinceMs) {
  const done = [];
  const next = new Map();
  for (const r of runs) {
    next.set(r.databaseId, r.status);
    if (r.status !== 'completed') continue;
    const prev = known.get(r.databaseId);
    if (prev === 'completed') continue;
    if (prev !== undefined || Date.parse(r.createdAt) >= sinceMs) done.push(r);
  }
  return { done, known: next };
}

export function shouldNotify(mode, run) {
  if (mode === 'all') return true;
  if (mode === 'fail') return FAIL.has(run.conclusion);
  return false;
}

export function notification(runs, { repo, branch }) {
  const failed = runs.filter((r) => BAD.has(r.conclusion));
  const title = failed.length ? `✗ CI failed · ${repo}@${branch}` : `✓ CI passed · ${repo}@${branch}`;
  const body = runs.map((r) => `${r.workflowName}: ${r.conclusion}`).join('\n');
  return { title, body, sound: failed.length ? 'request' : 'done' };
}
