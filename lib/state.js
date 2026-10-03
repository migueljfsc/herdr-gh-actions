export const FAIL = new Set(['failure', 'timed_out', 'startup_failure']);
export const BAD = new Set([...FAIL, 'cancelled']);

export function sortRuns(runs) {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
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
 * A checkout behind its upstream, or with HEAD older than the newest run, is just stale.
 */
export function deriveStatus({ runs = [], head = null, headTime = null, ahead = null, behind = null, upstream = null, headSeenAt = 0, now = Date.now(), pushedGraceMs = 300000 }) {
  const sorted = sortRuns(runs);
  if (!sorted.length) return { kind: 'none' };
  const headInRuns = head != null && sorted.some((r) => r.headSha === head);
  const newerThanRuns = headTime == null || headTime > Date.parse(sorted[0].createdAt);
  if (head && !headInRuns && upstream && ahead === 0 && !behind && newerThanRuns && now - headSeenAt < pushedGraceMs) {
    return { kind: 'pushed', sha: head, current: true };
  }
  const sha = headInRuns ? head : sorted[0].headSha;
  const group = latestPerWorkflow(sorted.filter((r) => r.headSha === sha));
  const current = sha === head;
  const active = group.filter((r) => r.status !== 'completed');
  if (active.length) {
    const since = Math.min(...active.map((r) => Date.parse(r.createdAt)));
    return { kind: 'running', sha, current, since, workflows: group.map((r) => r.workflowName) };
  }
  const failed = group.filter((r) => BAD.has(r.conclusion));
  if (failed.length) return { kind: 'failure', sha, current, failed: failed.map((r) => r.workflowName) };
  return { kind: 'success', sha, current };
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
