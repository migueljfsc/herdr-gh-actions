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
  assert.deepEqual(s.reports.at(-1), { ws: 'w1', source: 'plugin:migueljfsc.gh-actions', name: 'ci', value: null, seq: s.reports.at(-1).seq });
});

test('seq strictly increases', async () => {
  const s = setup({ panes, runs: { current: [mkRun()] } });
  await s.p.tick();
  await s.p.clearAll();
  assert.ok(s.reports[1].seq > s.reports[0].seq);
  assert.equal(s.reports[1].value, null);
});
