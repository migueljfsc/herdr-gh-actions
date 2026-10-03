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
  assert.equal(fmtDuration(25 * 3600000 + 59000), '1d01h');
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

test('buildItems: commits → runs → jobs → steps, HEAD marked, collapsed commits hide runs', async () => {
  const { buildItems } = await import('../lib/render.js');
  const now = Date.parse('2026-10-03T12:10:00Z');
  const runs = [
    { databaseId: 1, status: 'completed', conclusion: 'failure', headSha: 'abcdef123', workflowName: 'ci', displayTitle: 'fix: thing', event: 'push', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:02:05Z' },
    { databaseId: 3, status: 'completed', conclusion: 'success', headSha: 'abcdef123', workflowName: 'publish', displayTitle: 'publish', event: 'workflow_dispatch', createdAt: '2026-10-03T12:05:00Z', updatedAt: '2026-10-03T12:06:00Z' },
    { databaseId: 2, status: 'completed', conclusion: 'success', headSha: 'zzz9999', workflowName: 'ci', displayTitle: 'feat: older', event: 'push', createdAt: '2026-10-03T11:00:00Z', updatedAt: '2026-10-03T11:01:00Z' },
  ];
  const jobs = [
    { databaseId: 10, name: 'test', status: 'completed', conclusion: 'failure', startedAt: '2026-10-03T12:00:05Z', completedAt: '2026-10-03T12:01:05Z', steps: [{ number: 1, name: 'Set up', status: 'completed', conclusion: 'success' }] },
  ];
  const items = buildItems({
    runs,
    jobsByRun: new Map([[1, { jobs }]]),
    expandedCommits: new Set(['abcdef123']),
    expandedRuns: new Set([1, 2]),
    expandedJobs: new Set([10]),
    head: 'abcdef123',
    now,
  });
  assert.deepEqual(items.map((i) => i.key), ['commit:abcdef123', 'run:3', 'run:1', 'job:10', 'step:10:1', 'commit:zzz9999']);
  assert.equal(items[0].label, 'abcdef1 (HEAD) · fix: thing');
  assert.deepEqual(items[0].glyph, ['✗', '31']);
  assert.equal(items[0].meta, 'workflow_dispatch · 4m ago');
  assert.equal(items[1].meta, 'workflow_dispatch · 1m00s');
  assert.equal(items[2].meta, '2m05s');
  assert.deepEqual([items[3].depth, items[4].depth], [2, 3]);
  assert.equal(items[5].label, 'zzz9999 · feat: older');
});

test('buildItems: commitLimit caps commits; running commit shows elapsed', async () => {
  const { buildItems } = await import('../lib/render.js');
  const now = Date.parse('2026-10-03T12:10:00Z');
  const mk = (id, sha, over = {}) => ({ databaseId: id, status: 'completed', conclusion: 'success', headSha: sha, workflowName: 'ci', displayTitle: sha, event: 'push', createdAt: `2026-10-03T1${id}:00:00Z`, updatedAt: `2026-10-03T1${id}:01:00Z`, ...over });
  const runs = [mk(1, 'a'), mk(2, 'b'), mk(3, 'c', { status: 'in_progress', conclusion: null, createdAt: '2026-10-03T12:07:00Z' })];
  const items = buildItems({ runs, jobsByRun: new Map(), expandedCommits: new Set(), expandedRuns: new Set(), expandedJobs: new Set(), head: null, now, commitLimit: 2 });
  assert.deepEqual(items.map((i) => i.key), ['commit:c', 'commit:b']);
  assert.equal(items[0].meta, 'push · 3m');
  assert.deepEqual(items[0].glyph, ['◌', '33']);
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
  const [, row] = buildItems({ runs, jobsByRun: new Map(), expandedCommits: new Set(['abc']), expandedRuns: new Set(), expandedJobs: new Set(), head: 'x', now });
  assert.equal(row.meta, 'attempt 2 · 16s');
});

test('buildItems prefers the local commit subject over run titles', async () => {
  const { buildItems } = await import('../lib/render.js');
  const runs = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'abc1234def', workflowName: 'ci', displayTitle: 'ci', event: 'workflow_dispatch', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:01:00Z' }];
  const args = { runs, jobsByRun: new Map(), expandedCommits: new Set(), expandedRuns: new Set(), expandedJobs: new Set(), head: null, now: Date.parse('2026-10-03T12:10:00Z') };
  assert.equal(buildItems(args)[0].label, 'abc1234 · ci');
  assert.equal(buildItems({ ...args, subjects: new Map([['abc1234def', 'chore(release): bump']]) })[0].label, 'abc1234 · chore(release): bump');
});

test('footer row 1: status left, actions right, ? last; overflow goes to the do band when open', async () => {
  const { footerLines } = await import('../lib/render.js');
  const actions = [['↵', 'jobs'], ['l', 'log'], ['f', 'failed steps'], ['x', 'rerun failed'], ['X', 'rerun all'], ['o', 'open']];
  const bands = [['view', [['v', 'flat list'], ['w', 'run workflow'], ['R', 'refresh']]], ['go', [['j/k', 'move'], ['q', 'quit']]]];
  const model = { status: { updatedAt: '12:00:00' }, footer: { actions, bands, open: false } };
  const [row] = footerLines(model, 60);
  assert.equal(w(row), 60);
  assert.match(strip(row), /^updated 12:00:00 +↵ jobs · l log/);
  assert.match(strip(row), / \?$/);
  assert.doesNotMatch(strip(row), /rerun all/);
  const open = footerLines({ ...model, footer: { ...model.footer, open: true } }, 60).map(strip);
  assert.ok(open.length > 1);
  assert.match(open[1], /^do {4}.*rerun all · o open/);
  assert.ok(open.some((l) => /^view {2}v flat list · w run workflow · R refresh/.test(l)));
  assert.ok(open.some((l) => /^go {4}j\/k move · q quit/.test(l)));
  for (const l of footerLines({ ...model, footer: { ...model.footer, open: true } }, 60)) assert.equal(w(l), 60);
});

test('footer wraps a band that does not fit and keeps the body at least 3 rows', async () => {
  const { footerLines, footerHeight } = await import('../lib/render.js');
  const many = Array.from({ length: 12 }, (_, i) => [`k${i}`, `label${i}`]);
  const model = { status: {}, footer: { actions: [], bands: [['go', many]], open: true } };
  const lines = footerLines(model, 40).map(strip);
  assert.ok(lines.length > 2);
  assert.match(lines[2], /^ {6}k/);
  assert.equal(footerHeight(model, 40, 8), 4);
});

test('long status is clipped, actions and ? stay', async () => {
  const { footerLines } = await import('../lib/render.js');
  const [row] = footerLines({ status: { message: 'x'.repeat(200) }, footer: { actions: [['o', 'open']], bands: [], open: false } }, 50);
  assert.equal(w(row), 50);
  assert.match(strip(row), /x…\s+o open {2}\?$/);
});

test('buildFlatItems: one row per run newest first, limited to the newest commits', async () => {
  const { buildFlatItems } = await import('../lib/render.js');
  const now = Date.parse('2026-10-03T12:10:00Z');
  const mk = (id, sha, t, over = {}) => ({ databaseId: id, status: 'completed', conclusion: 'success', headSha: sha, workflowName: `wf${id}`, displayTitle: `t${sha}`, event: 'push', createdAt: t, updatedAt: t, ...over });
  const runs = [mk(1, 'aaa', '2026-10-03T12:00:00Z'), mk(2, 'aaa', '2026-10-03T12:00:00Z'), mk(3, 'bbb', '2026-10-03T11:00:00Z'), mk(4, 'ccc', '2026-10-03T10:00:00Z')];
  const items = buildFlatItems({ runs, jobsByRun: new Map(), expandedRuns: new Set([3]), expandedJobs: new Set(), head: 'aaa', now, commitLimit: 2 });
  assert.deepEqual(items.map((i) => i.key), ['run:2', 'run:1', 'run:3', 'note:3']);
  assert.equal(items[0].label, 'wf2 · taaa');
  assert.equal(items[0].meta, 'push · aaa (HEAD) · 10m ago');
  assert.equal(items[3].depth, 1);
  assert.equal(items[2].commit.sha, 'bbb');
  const dispatched = [mk(5, 'ddd', '2026-10-03T12:00:00Z', { event: 'workflow_dispatch', workflowName: 'ci', displayTitle: 'ci' })];
  const [row] = buildFlatItems({ runs: dispatched, jobsByRun: new Map(), expandedRuns: new Set(), expandedJobs: new Set(), head: null, now, subjects: new Map([['ddd', 'chore: bump']]) });
  assert.equal(row.label, 'ci · chore: bump');
});

test('a more row closes both layouts only when there is something older', async () => {
  const { buildItems, buildFlatItems } = await import('../lib/render.js');
  const runs = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'a', workflowName: 'ci', displayTitle: 't', event: 'push', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:01:00Z' }];
  const base = { runs, jobsByRun: new Map(), expandedCommits: new Set(), expandedRuns: new Set(), expandedJobs: new Set(), head: null, now: Date.parse('2026-10-03T12:10:00Z') };
  assert.equal(buildItems(base).at(-1).key, 'commit:a');
  const grouped = buildItems({ ...base, more: '10 more commits' }).at(-1);
  assert.deepEqual([grouped.key, grouped.type, grouped.label], ['more', 'more', '10 more commits']);
  assert.equal(buildFlatItems({ ...base, more: 'more runs' }).at(-1).label, 'more runs');
});
