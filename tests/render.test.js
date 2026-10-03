import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenText, fmtDuration, fit, formatLog, wrapLines, renderPane, followSelection } from '../lib/render.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const w = (s) => [...strip(s)].length;

test('fmtDuration', () => {
  assert.equal(fmtDuration(5000), '5s');
  assert.equal(fmtDuration(125000), '2m');
  assert.equal(fmtDuration(125000, true), '2m05s');
  assert.equal(fmtDuration(3725000), '1h02m');
  assert.equal(fmtDuration(-1), '0s');
});

test('token text per kind, ≤ 80 chars', () => {
  const now = Date.parse('2026-10-03T12:02:00Z');
  const cases = [
    [{ kind: 'none' }, null],
    [{ kind: 'pushed' }, '↑ pushed'],
    [{ kind: 'running', since: now - 120000 }, '◌ CI 2m'],
    [{ kind: 'success' }, '✓ CI'],
    [{ kind: 'failure' }, '✗ CI'],
    [{ kind: 'error' }, '⚠ CI'],
    [{ kind: 'success', authWarning: true }, '✓ CI ⚠auth'],
  ];
  for (const [status, want] of cases) {
    const t = tokenText(status, now);
    assert.equal(t, want);
    if (t) assert.ok([...t].length <= 80);
  }
});

test('fit truncates with ellipsis and pads', () => {
  assert.equal(strip(fit([['hello world', '1']], 8)), 'hello w…');
  assert.equal(fit([['ab', null]], 4), 'ab  ');
  assert.equal(w(fit([['✓', '32'], [' x', null]], 6)), 6);
});

test('formatLog strips gh prefixes and styles markers', () => {
  const raw = [
    'deploy\tUNKNOWN STEP\t﻿2026-10-03T11:39:28.6000565Z ##[group]Run actions/checkout@v4',
    'deploy\tUNKNOWN STEP\t2026-10-03T11:39:28.6Z \x1b[32mok\x1b[0m',
    'deploy\tUNKNOWN STEP\t2026-10-03T11:39:28.6Z ##[endgroup]',
    'deploy\tUNKNOWN STEP\t2026-10-03T11:39:28.6Z ##[error]boom',
    'deploy\tUNKNOWN STEP\t2026-10-03T11:39:28.6Z ^[[36;1mnpm test^[[0m',
    'deploy\tUNKNOWN STEP\t2026-10-03T11:39:28.6Z 10%\r50%\r100%',
    '',
  ].join('\n');
  assert.deepEqual(formatLog(raw), [
    { text: '▸ Run actions/checkout@v4', sgr: '1' },
    { text: 'ok', sgr: null },
    { text: 'boom', sgr: '31' },
    { text: 'npm test', sgr: null },
    { text: '100%', sgr: null },
  ]);
});

test('wrapLines', () => {
  assert.deepEqual(wrapLines([{ text: 'abcdef', sgr: null }, { text: '', sgr: null }], 4).map((l) => l.text), ['abcd', 'ef', '']);
});

function model(extra = {}) {
  return {
    header: { owner: 'migueljfsc', repo: 'herdr-gh-actions', branch: 'feature/a-very-long-branch-name', headShort: 'abc1234', pushed: true },
    view: 'list',
    items: [
      { depth: 0, expandable: true, expanded: true, glyph: ['✗', '31'], label: 'CI · Fix the thing that broke', meta: 'push · 3m' },
      { depth: 1, expandable: true, expanded: false, glyph: ['✓', '32'], label: 'lint', meta: '45s' },
      { depth: 1, expandable: true, expanded: false, glyph: ['✗', '31'], label: 'test', meta: '2m10s' },
      { depth: 0, expandable: true, expanded: false, glyph: ['◌', '33'], label: 'Deploy', meta: 'push · 1m' },
    ],
    selected: 2,
    top: 0,
    status: { updatedAt: '12:00:00' },
    ...extra,
  };
}

for (const cols of [40, 80, 120]) {
  test(`pane frame at ${cols} cols: exact size`, () => {
    const lines = renderPane(model(), cols, 12);
    assert.equal(lines.length, 12);
    for (const l of lines) assert.equal(w(l), cols, JSON.stringify(strip(l)));
    assert.match(strip(lines[0]), /^migueljfsc\/herdr-gh-actions/);
    assert.match(strip(lines[3]), /✗ test/);
  });

  test(`log view at ${cols} cols: exact size, wrapped`, () => {
    const log = { title: 'test · log', lines: [{ text: 'x'.repeat(200), sgr: null }], top: 0 };
    const lines = renderPane(model({ view: 'log', log }), cols, 8);
    assert.equal(lines.length, 8);
    for (const l of lines) assert.equal(w(l), cols);
    assert.equal(strip(lines[2]), 'x'.repeat(cols));
  });
}

test('empty list shows placeholder', () => {
  const lines = renderPane(model({ items: [], empty: 'not a github repo' }), 40, 5);
  assert.match(strip(lines[1]), /not a github repo/);
});

test('followSelection keeps selection in view', () => {
  assert.equal(followSelection(0, 3, 5), 0);
  assert.equal(followSelection(0, 7, 5), 3);
  assert.equal(followSelection(4, 2, 5), 2);
});

test('buildItems flattens expanded runs/jobs/steps and marks HEAD', async () => {
  const { buildItems } = await import('../lib/render.js');
  const now = Date.parse('2026-10-03T12:10:00Z');
  const runs = [
    { databaseId: 1, status: 'completed', conclusion: 'failure', headSha: 'abcdef123', workflowName: 'CI', displayTitle: 'msg', event: 'push', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:02:05Z' },
    { databaseId: 2, status: 'in_progress', conclusion: null, headSha: 'zzz', workflowName: 'Deploy', displayTitle: 'm2', event: 'push', createdAt: '2026-10-03T12:08:00Z' },
  ];
  const jobs = [
    { databaseId: 10, name: 'test', status: 'completed', conclusion: 'failure', startedAt: '2026-10-03T12:00:05Z', completedAt: '2026-10-03T12:01:05Z', steps: [{ number: 1, name: 'Set up', status: 'completed', conclusion: 'success' }] },
  ];
  const items = buildItems({ runs, jobsByRun: new Map([[1, { jobs }]]), expandedRuns: new Set([1, 2]), expandedJobs: new Set([10]), head: 'abcdef123', now });
  assert.deepEqual(items.map((i) => i.key), ['run:1', 'job:10', 'step:10:1', 'run:2', 'note:2']);
  assert.equal(items[0].meta, 'push · abcdef1 (HEAD) · 2m05s · 7m ago');
  assert.equal(items[1].meta, '1m00s');
  assert.equal(items[3].meta, 'push · zzz · 2m');
  assert.equal(items[4].label, 'loading jobs…');
});

test('picker view and confirm prompt render at exact size', () => {
  const picker = { title: 'Run workflow on main', items: [{ depth: 0, label: 'publish', meta: '.github/workflows/publish.yml', glyph: ['▶', '36'] }], selected: 0, top: 0 };
  for (const cols of [40, 80]) {
    const lines = renderPane(model({ view: 'picker', picker, confirm: 'rerun failed jobs of "CI"?' }), cols, 6);
    assert.equal(lines.length, 6);
    for (const l of lines) assert.equal(w(l), cols);
    assert.match(strip(lines[1]), /^Run workflow on main/);
    assert.match(strip(lines[2]), /▶ publish/);
    assert.match(strip(lines[5]), /rerun failed jobs of "CI"\? \[y\/n\]/);
  }
});

test('re-run row shows attempt and times the latest attempt', async () => {
  const { buildItems } = await import('../lib/render.js');
  const now = Date.parse('2026-10-03T12:10:00Z');
  const runs = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'abc', workflowName: 'ci', displayTitle: 't', event: 'push', attempt: 2, createdAt: '2026-10-03T11:00:00Z', startedAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:16Z' }];
  const [row] = buildItems({ runs, jobsByRun: new Map(), expandedRuns: new Set(), expandedJobs: new Set(), head: 'x', now });
  assert.equal(row.meta, 'push · abc · attempt 2 · 16s · 9m ago');
});
