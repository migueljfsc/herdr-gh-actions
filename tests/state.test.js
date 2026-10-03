import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, newlyCompleted, shouldNotify, notification, latestPerWorkflow } from '../lib/state.js';

const T0 = Date.parse('2026-10-03T12:00:00Z');
let n = 0;
function run(over = {}) {
  n += 1;
  return {
    databaseId: n,
    status: 'completed',
    conclusion: 'success',
    headSha: 'aaa',
    workflowName: 'CI',
    createdAt: new Date(T0 + n * 1000).toISOString(),
    ...over,
  };
}

test('no runs → none', () => {
  assert.deepEqual(deriveStatus({ runs: [], head: 'aaa' }), { kind: 'none' });
});

for (const [status, conclusion, kind] of [
  ['queued', null, 'running'],
  ['in_progress', null, 'running'],
  ['waiting', null, 'running'],
  ['completed', 'success', 'success'],
  ['completed', 'skipped', 'success'],
  ['completed', 'neutral', 'success'],
  ['completed', 'failure', 'failure'],
  ['completed', 'cancelled', 'failure'],
  ['completed', 'timed_out', 'failure'],
  ['completed', 'startup_failure', 'failure'],
]) {
  test(`${status}/${conclusion} → ${kind}`, () => {
    const s = deriveStatus({ runs: [run({ status, conclusion })], head: 'aaa', now: T0 + 60000 });
    assert.equal(s.kind, kind);
    assert.equal(s.current, true);
  });
}

test('running reports earliest active createdAt as since', () => {
  const a = run({ status: 'in_progress', conclusion: null, workflowName: 'A' });
  const b = run({ status: 'queued', conclusion: null, workflowName: 'B' });
  const s = deriveStatus({ runs: [b, a], head: 'aaa' });
  assert.equal(s.since, Date.parse(a.createdAt));
});

test('any workflow failing on the commit fails it; one still running keeps it running', () => {
  const ok = run({ workflowName: 'A' });
  const bad = run({ workflowName: 'B', conclusion: 'failure' });
  assert.equal(deriveStatus({ runs: [ok, bad], head: 'aaa' }).kind, 'failure');
  const busy = run({ workflowName: 'C', status: 'in_progress', conclusion: null });
  assert.equal(deriveStatus({ runs: [ok, bad, busy], head: 'aaa' }).kind, 'running');
});

test('a re-run supersedes the earlier run of the same workflow', () => {
  const first = run({ conclusion: 'failure' });
  const rerun = run({ conclusion: 'success' });
  assert.equal(deriveStatus({ runs: [first, rerun], head: 'aaa' }).kind, 'success');
  assert.equal(latestPerWorkflow([first, rerun]).length, 1);
});

test('HEAD pushed but no run yet → pushed (within grace)', () => {
  const old = run({ headSha: 'old' });
  const args = { runs: [old], head: 'new', ahead: 0, upstream: 'origin/main', headSeenAt: T0, now: T0 + 1000 };
  assert.deepEqual(deriveStatus(args), { kind: 'pushed', sha: 'new', current: true });
});

test('pushed lapses after grace → newest run status, not current', () => {
  const old = run({ headSha: 'old', conclusion: 'failure' });
  const s = deriveStatus({ runs: [old], head: 'new', ahead: 0, upstream: 'origin/main', headSeenAt: T0, now: T0 + 301000 });
  assert.equal(s.kind, 'failure');
  assert.equal(s.current, false);
});

test('unpushed commits (ahead) or no upstream → newest run status, never pushed', () => {
  const old = run({ headSha: 'old' });
  assert.equal(deriveStatus({ runs: [old], head: 'new', ahead: 2, upstream: 'origin/main', headSeenAt: T0, now: T0 }).kind, 'success');
  assert.equal(deriveStatus({ runs: [old], head: 'new', ahead: null, upstream: null, headSeenAt: T0, now: T0 }).kind, 'success');
});

test('HEAD with a run wins over a newer run for another sha', () => {
  const mine = run({ headSha: 'head', conclusion: 'failure' });
  const other = run({ headSha: 'later' });
  const s = deriveStatus({ runs: [other, mine], head: 'head' });
  assert.equal(s.kind, 'failure');
  assert.equal(s.sha, 'head');
});

test('newlyCompleted: first observation of old completed runs is silent', () => {
  const r = run();
  const { done, known } = newlyCompleted([r], new Map(), Date.parse(r.createdAt) + 1);
  assert.deepEqual(done, []);
  assert.equal(known.get(r.databaseId), 'completed');
});

test('newlyCompleted: running → completed notifies once', () => {
  const r = run({ status: 'in_progress', conclusion: null });
  let { done, known } = newlyCompleted([r], new Map(), T0 + 10e9);
  assert.equal(done.length, 0);
  const finished = { ...r, status: 'completed', conclusion: 'failure' };
  ({ done, known } = newlyCompleted([finished], known, T0 + 10e9));
  assert.deepEqual(done, [finished]);
  ({ done } = newlyCompleted([finished], known, T0 + 10e9));
  assert.equal(done.length, 0);
});

test('newlyCompleted: a run started and finished between ticks notifies', () => {
  const r = run({ conclusion: 'failure' });
  const { done } = newlyCompleted([r], new Map(), Date.parse(r.createdAt) - 1);
  assert.deepEqual(done, [r]);
});

test('shouldNotify modes', () => {
  const fail = run({ conclusion: 'failure' });
  const ok = run();
  const cancelled = run({ conclusion: 'cancelled' });
  assert.equal(shouldNotify('fail', fail), true);
  assert.equal(shouldNotify('fail', ok), false);
  assert.equal(shouldNotify('fail', cancelled), false);
  assert.equal(shouldNotify('all', ok), true);
  assert.equal(shouldNotify('off', fail), false);
});

test('notification text', () => {
  const n1 = notification([run({ conclusion: 'failure', workflowName: 'Build' })], { repo: 'r', branch: 'main' });
  assert.equal(n1.title, '✗ CI failed · r@main');
  assert.equal(n1.body, 'Build: failure');
  assert.equal(n1.sound, 'request');
  assert.equal(notification([run()], { repo: 'r', branch: 'b' }).sound, 'done');
});

test('stale checkout (HEAD older than newest run) is not pushed', () => {
  const newer = run({ headSha: 'newer' });
  const base = { runs: [newer], head: 'old', ahead: 0, upstream: 'origin/main', headSeenAt: T0, now: T0 + 1000 };
  assert.equal(deriveStatus({ ...base, headTime: Date.parse(newer.createdAt) - 86400000 }).kind, 'success');
  assert.equal(deriveStatus({ ...base, headTime: Date.parse(newer.createdAt) + 1000 }).kind, 'pushed');
  assert.equal(deriveStatus({ ...base, headTime: Date.parse(newer.createdAt) + 1000, behind: 2 }).kind, 'success');
});

test('runAction gating', async () => {
  const { runAction } = await import('../lib/state.js');
  const failed = run({ conclusion: 'failure' });
  const ok = run();
  const busy = run({ status: 'in_progress', conclusion: null });
  assert.deepEqual(runAction('rerun-failed', { ...failed, displayTitle: 'fix x' }), { ok: true, prompt: `rerun failed jobs of "CI" #${failed.databaseId} (fix x)?` });
  assert.equal(runAction('rerun-failed', ok).ok, false);
  assert.equal(runAction('rerun-failed', busy).ok, false);
  assert.equal(runAction('rerun-all', ok).ok, true);
  assert.equal(runAction('rerun-all', busy).ok, false);
  assert.equal(runAction('cancel', busy).ok, true);
  assert.equal(runAction('cancel', ok).ok, false);
  assert.equal(runAction('cancel', null).ok, false);
});

test('findDispatchedRun picks newest manual run of the workflow since dispatch', async () => {
  const { findDispatchedRun } = await import('../lib/state.js');
  const since = Date.parse('2026-10-03T12:00:00Z');
  const runs = [
    { databaseId: 1, event: 'workflow_dispatch', workflowName: 'publish', createdAt: '2026-10-03T11:00:00Z' },
    { databaseId: 2, event: 'push', workflowName: 'publish', createdAt: '2026-10-03T12:00:05Z' },
    { databaseId: 3, event: 'workflow_dispatch', workflowName: 'other', createdAt: '2026-10-03T12:00:05Z' },
    { databaseId: 4, event: 'workflow_dispatch', workflowName: 'publish', createdAt: '2026-10-03T11:59:55Z' },
  ];
  assert.equal(findDispatchedRun(runs, { workflowName: 'publish', since })?.databaseId, 4);
  assert.equal(findDispatchedRun(runs.slice(0, 3), { workflowName: 'publish', since }), null);
});

test('[skip ci] HEAD is never pushed', () => {
  const old = run({ headSha: 'old' });
  const s = deriveStatus({ runs: [old], head: 'new', headTime: Date.parse(old.createdAt) + 1000, skipCi: true, ahead: 0, upstream: 'origin/main', headSeenAt: T0, now: T0 + 1000 });
  assert.equal(s.kind, 'success');
});

test('sortRuns breaks createdAt ties by id, newest first', async () => {
  const { sortRuns } = await import('../lib/state.js');
  const at = '2026-10-03T15:11:14Z';
  const order = sortRuns([
    { databaseId: 100, createdAt: at },
    { databaseId: 92, createdAt: at },
    { databaseId: 50, createdAt: '2026-10-03T16:00:00Z' },
  ]).map((r) => r.databaseId);
  assert.deepEqual(order, [50, 100, 92]);
});

test('running since uses the latest attempt start (re-runs keep createdAt)', () => {
  const r = run({ status: 'in_progress', conclusion: null, createdAt: '2026-10-03T11:00:00Z', startedAt: '2026-10-03T12:00:00Z', attempt: 2 });
  assert.equal(deriveStatus({ runs: [r], head: 'aaa' }).since, Date.parse('2026-10-03T12:00:00Z'));
});

test('groupByCommit orders commits by newest run and prefers the push title', async () => {
  const { groupByCommit } = await import('../lib/state.js');
  const groups = groupByCommit([
    { databaseId: 1, headSha: 'a', event: 'push', displayTitle: 'feat: a', createdAt: '2026-10-03T10:00:00Z' },
    { databaseId: 2, headSha: 'b', event: 'push', displayTitle: 'fix: b', createdAt: '2026-10-03T11:00:00Z' },
    { databaseId: 3, headSha: 'a', event: 'workflow_dispatch', displayTitle: 'publish', createdAt: '2026-10-03T12:00:00Z' },
  ]);
  assert.deepEqual(groups.map((g) => [g.sha, g.title, g.runs.map((r) => r.databaseId)]), [
    ['a', 'feat: a', [3, 1]],
    ['b', 'fix: b', [2]],
  ]);
});

test('commitStatus: running beats failure beats success; re-run supersedes', async () => {
  const { commitStatus } = await import('../lib/state.js');
  assert.equal(commitStatus([run({ workflowName: 'A' }), run({ workflowName: 'B', conclusion: 'failure' })]), 'failure');
  assert.equal(commitStatus([run({ workflowName: 'A', conclusion: 'failure' }), run({ workflowName: 'B', status: 'queued', conclusion: null })]), 'running');
  assert.equal(commitStatus([run({ conclusion: 'failure' }), run()]), 'success');
});

test('commitAction targets the fitting runs of a commit', async () => {
  const { commitAction } = await import('../lib/state.js');
  const commit = {
    sha: 'abcdef1234',
    runs: [
      run({ workflowName: 'ci', conclusion: 'failure' }),
      run({ workflowName: 'lint' }),
      run({ workflowName: 'deploy', status: 'in_progress', conclusion: null }),
    ],
  };
  const x = commitAction('rerun-failed', commit);
  assert.equal(x.prompt, 'rerun failed jobs of 1 run of abcdef1 (ci)?');
  assert.deepEqual(x.runs.map((r) => r.workflowName), ['ci']);
  assert.deepEqual(commitAction('rerun-all', commit).runs.map((r) => r.workflowName).sort(), ['ci', 'lint']);
  assert.deepEqual(commitAction('cancel', commit).runs.map((r) => r.workflowName), ['deploy']);
  assert.deepEqual(commitAction('rerun-failed', { sha: 'abcdef1234', runs: [run()] }), { ok: false, reason: 'abcdef1: no failed runs' });
});
