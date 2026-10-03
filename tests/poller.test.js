import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../lib/poller.js';
import { normalize } from '../lib/config.js';

const T0 = Date.parse('2026-10-03T12:00:00Z');

function setup({ panes, runs = {}, branch = { oid: 'aaa', head: 'main', upstream: 'origin/main', ahead: 0 } }) {
  let clock = T0;
  const reports = [];
  const notes = [];
  const ghCalls = [];
  const herdr = {
    paneList: async () => panes,
    reportToken: async (ws, o) => reports.push({ ws, ...o }),
    notify: async (title, o) => notes.push({ title, ...o }),
  };
  const git = {
    toplevel: async (cwd) => (cwd.startsWith('/repo') ? '/repo' : null),
    githubRepo: async () => ({ owner: 'o', repo: 'r' }),
    branchState: async () => ({ ...branch }),
  };
  const gh = {
    runList: async (owner, repo, b) => {
      ghCalls.push(b);
      return { runs: runs.current ?? [], authWarning: false };
    },
  };
  const { config } = normalize({});
  const p = createPoller({ herdr, git, gh, config, now: () => clock });
  return { p, reports, notes, ghCalls, runs, branch, advance: (ms) => (clock += ms), now: () => clock };
}

const panes = [
  { workspace_id: 'w1', cwd: '/repo', foreground_cwd: '/repo' },
  { workspace_id: 'w1', cwd: '/repo', foreground_cwd: '/repo/sub' },
  { workspace_id: 'w2', cwd: '/tmp', foreground_cwd: '/tmp' },
];

const mkRun = (over) => ({ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'aaa', workflowName: 'CI', createdAt: new Date(T0 - 60000).toISOString(), ...over });

test('reports token for github workspaces only, idle interval when settled', async () => {
  const s = setup({ panes, runs: { current: [mkRun()] } });
  const { intervalMs, snapshot } = await s.p.tick();
  assert.equal(intervalMs, 60000);
  assert.deepEqual(s.reports.map((r) => [r.ws, r.value, r.ttlMs]), [['w1', '✓ CI', 180000]]);
  assert.deepEqual(Object.keys(snapshot.workspaces), ['w1']);
});

test('unchanged token not resent until close to TTL expiry', async () => {
  const s = setup({ panes, runs: { current: [mkRun()] } });
  await s.p.tick();
  s.advance(60000);
  await s.p.tick();
  assert.equal(s.reports.length, 1);
  s.advance(60000);
  await s.p.tick();
  assert.equal(s.reports.length, 2);
});

test('settled workspace with unchanged branch skips gh until idle interval passes', async () => {
  const s = setup({ panes, runs: { current: [mkRun()] } });
  await s.p.tick();
  s.advance(10000);
  await s.p.tick();
  assert.equal(s.ghCalls.length, 1);
  await s.p.tick({ force: true });
  assert.equal(s.ghCalls.length, 2);
});

test('running → failure: fast interval, then notification once', async () => {
  const s = setup({ panes, runs: { current: [mkRun({ status: 'in_progress', conclusion: null })] } });
  let r = await s.p.tick();
  assert.equal(r.intervalMs, 10000);
  assert.match(s.reports.at(-1).value, /^◌ CI /);
  s.runs.current = [mkRun({ conclusion: 'failure' })];
  s.advance(10000);
  r = await s.p.tick();
  assert.equal(s.reports.at(-1).value, '✗ CI');
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0].title, /CI failed · r@main/);
  s.advance(60000);
  await s.p.tick({ force: true });
  assert.equal(s.notes.length, 1);
});

test('already-completed runs at first sight do not notify', async () => {
  const s = setup({ panes, runs: { current: [mkRun({ conclusion: 'failure' })] } });
  await s.p.tick();
  assert.equal(s.notes.length, 0);
});

test('gh error → ⚠ CI and retried next tick', async () => {
  let fail = true;
  const { config } = normalize({});
  const reports = [];
  const p = createPoller({
    herdr: { paneList: async () => panes, reportToken: async (ws, o) => reports.push(o.value), notify: async () => {} },
    git: { toplevel: async () => '/repo', githubRepo: async () => ({ owner: 'o', repo: 'r' }), branchState: async () => ({ oid: 'aaa', head: 'main', upstream: 'origin/main', ahead: 0 }) },
    gh: {
      runList: async () => {
        if (fail) throw new Error('HTTP 502');
        return { runs: [mkRun()], authWarning: false };
      },
    },
    config,
    now: () => T0,
  });
  await p.tick();
  assert.deepEqual(reports, ['⚠ CI', '⚠ CI']);
  fail = false;
  await p.tick();
  assert.deepEqual(reports.slice(2), ['✓ CI', '✓ CI']);
});

test('workspace losing its repo clears the token', async () => {
  const list = [...panes];
  const s = setup({ panes: list, runs: { current: [mkRun()] } });
  await s.p.tick();
  list[0] = { workspace_id: 'w1', cwd: '/tmp', foreground_cwd: '/tmp' };
  list[1] = { workspace_id: 'w1', cwd: '/tmp', foreground_cwd: '/tmp' };
  await s.p.tick();
  const last = s.reports.at(-1);
  assert.deepEqual([last.ws, last.source, last.name, last.value], ['w1', 'plugin:migueljfsc.gh-actions', 'ci', null]);
});

test('seq strictly increases', async () => {
  const s = setup({ panes, runs: { current: [mkRun()] } });
  await s.p.tick();
  await s.p.clearAll();
  assert.ok(s.reports[1].seq > s.reports[0].seq);
  assert.equal(s.reports[1].value, null);
});

test('agent panes get their own checkout status; plain panes get none', async () => {
  const paneReports = [];
  const wsReports = [];
  const { config } = normalize({});
  const runsFor = { main: [mkRun()], 'feat/x': [mkRun({ databaseId: 9, headSha: 'bbb', status: 'in_progress', conclusion: null })] };
  const p = createPoller({
    herdr: {
      paneList: async () => [
        { pane_id: 'w1:p1', workspace_id: 'w1', cwd: '/repo', foreground_cwd: '/repo', agent: null },
        { pane_id: 'w1:p2', workspace_id: 'w1', cwd: '/repo', foreground_cwd: '/wt/feat', agent: 'claude' },
        { pane_id: 'w1:p3', workspace_id: 'w1', cwd: '/repo', foreground_cwd: '/repo', agent: 'codex' },
      ],
      reportToken: async (ws, o) => wsReports.push([ws, o.value]),
      reportPaneToken: async (pane, o) => paneReports.push([pane, o.value]),
      notify: async () => {},
    },
    git: {
      toplevel: async (cwd) => (cwd.startsWith('/wt/feat') ? '/wt/feat' : '/repo'),
      githubRepo: async () => ({ owner: 'o', repo: 'r' }),
      branchState: async (root) =>
        root === '/wt/feat' ? { oid: 'bbb', head: 'feat/x', upstream: 'origin/feat/x', ahead: 0 } : { oid: 'aaa', head: 'main', upstream: 'origin/main', ahead: 0 },
    },
    gh: { runList: async (o, r, branch) => ({ runs: runsFor[branch], authWarning: false }) },
    config,
    now: () => T0,
  });
  const { intervalMs, snapshot } = await p.tick();
  assert.deepEqual(wsReports, [['w1', '✓ CI']]);
  assert.deepEqual(paneReports.sort(), [['w1:p2', '◌ CI 1m'], ['w1:p3', '✓ CI']]);
  assert.equal(intervalMs, 10000);
  assert.deepEqual(Object.keys(snapshot.panes).sort(), ['w1:p2', 'w1:p3']);
  await p.clearAll();
  assert.deepEqual(paneReports.slice(2).sort(), [['w1:p2', null], ['w1:p3', null]]);
});

test('metadataArgs for workspace and pane', async () => {
  const { metadataArgs } = await import('../lib/herdr.js');
  assert.deepEqual(metadataArgs('pane', 'w1:p2', { source: 's', name: 'ci', value: '✓ CI', ttlMs: 30000, seq: 5 }), [
    'pane', 'report-metadata', 'w1:p2', '--source', 's', '--token', 'ci=✓ CI', '--ttl-ms', '30000', '--seq', '5',
  ]);
  assert.deepEqual(metadataArgs('workspace', 'w1', { source: 's', name: 'ci', value: null, ttlMs: 30000, seq: 6 }), [
    'workspace', 'report-metadata', 'w1', '--source', 's', '--clear-token', 'ci', '--seq', '6',
  ]);
});
