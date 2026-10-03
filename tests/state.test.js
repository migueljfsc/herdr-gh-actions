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
