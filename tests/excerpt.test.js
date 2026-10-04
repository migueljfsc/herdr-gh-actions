import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedSteps, buildExcerpt, agentPrompt, agentTargets } from '../lib/excerpt.js';

const raw = [
  'test (22)\tRun npm test\t﻿2026-10-03T15:08:22.6182725Z ##[group]Run npm test',
  'test (22)\tRun npm test\t2026-10-03T15:08:22.6250968Z ##[endgroup]',
  'test (22)\tRun npm test\t2026-10-03T15:08:23.0000000Z not ok 1 - adds',
  'test (24)\tRun npm test\t2026-10-03T15:08:24.0000000Z ##[error]Process completed with exit code 1.',
  '',
].join('\n');

const ctx = { owner: 'o', repo: 'r', branch: 'feat/x', sha: 'abc123', workflow: 'ci', job: 'test (22)', url: 'https://github.com/o/r/actions/runs/1' };

test('failedSteps groups by job and step, formatted', () => {
  assert.deepEqual(failedSteps(raw), [
    { job: 'test (22)', step: 'Run npm test', lines: ['▸ Run npm test', 'not ok 1 - adds'] },
    { job: 'test (24)', step: 'Run npm test', lines: ['Process completed with exit code 1.'] },
  ]);
});

test('buildExcerpt: header, annotations, step tails', () => {
  const steps = [{ job: 'test (22)', step: 'Run npm test', lines: ['a', 'b', 'c'] }];
  const notes = [{ text: '▸ annotations · test (22)' }, { text: '✗ lib/a.js:3 boom' }, { text: '  at f()' }, { text: '' }];
  const md = buildExcerpt(ctx, steps, notes, { maxLines: 2 });
  assert.match(md, /^# CI failure: ci \/ test \(22\) on feat\/x\n/);
  assert.match(md, /- run: https:\/\/github.com\/o\/r\/actions\/runs\/1/);
  assert.match(md, /## Annotations\n\n- test \(22\)\n  - ✗ lib\/a.js:3 boom\n    at f\(\)\n/);
  assert.match(md, /## test \(22\) › Run npm test \(last 2 of 3 lines\)\n\n```text\nb\nc\n```/);
  assert.doesNotMatch(md, /▸/);
  assert.match(buildExcerpt(ctx, []), /No failed step logs/);
});

test('agentPrompt is one line', () => {
  const p = agentPrompt(ctx, '/s/x.md');
  assert.doesNotMatch(p, /\n/);
  assert.match(p, /ci \/ test \(22\) on feat\/x .*\/s\/x\.md/);
});

test('agentTargets: same checkout first, then same workspace, never itself', () => {
  const panes = [
    { pane_id: 'w1:p1', agent: 'claude', root: '/other', workspace_id: 'w1' },
    { pane_id: 'w2:p1', agent: 'codex', root: '/repo', workspace_id: 'w2' },
    { pane_id: 'w1:p2', root: '/repo', workspace_id: 'w1' },
    { pane_id: 'w1:p3', agent: 'claude', root: '/repo', workspace_id: 'w1' },
    { pane_id: 'w3:p1', agent: 'claude', root: '/elsewhere', workspace_id: 'w3' },
  ];
  assert.deepEqual(agentTargets(panes, { root: '/repo', workspaceId: 'w1', selfId: 'w1:p3' }).map((p) => p.pane_id), ['w2:p1', 'w1:p1']);
});

test('buildExcerpt: long lines cut to lineChars (500 by default, 0 keeps them whole)', () => {
  const steps = [{ job: 'j', step: 's', lines: ['x'.repeat(2000)] }];
  const md = buildExcerpt(ctx, steps);
  assert.ok(md.includes(`${'x'.repeat(499)}…`));
  assert.ok(!md.includes('x'.repeat(500)));
  assert.ok(buildExcerpt(ctx, steps, [], { lineChars: 10 }).includes(`${'x'.repeat(9)}…\n`));
  assert.ok(buildExcerpt(ctx, steps, [], { lineChars: 0 }).includes('x'.repeat(2000)));
});

test('buildExcerpt: maxBytes drops the oldest lines of the longest tails first', () => {
  const big = Array.from({ length: 80 }, (_, i) => `big ${i} ${'y'.repeat(400)}`);
  const small = ['small 1', 'small 2'];
  const md = buildExcerpt(ctx, [{ job: 'a', step: 'big', lines: big }, { job: 'b', step: 'small', lines: small }], [], { maxBytes: 8 * 1024 });
  assert.ok(Buffer.byteLength(md) <= 8 * 1024, String(Buffer.byteLength(md)));
  assert.match(md, /big 79 /);
  assert.doesNotMatch(md, /big 0 /);
  assert.match(md, /small 1\nsmall 2/);
  assert.match(md, /## a › big \(last \d+ of 80 lines\)/);
});

test('buildExcerpt: a budget below the header still holds', () => {
  const md = buildExcerpt(ctx, [{ job: 'a', step: 's', lines: ['z'] }], [], { maxBytes: 40 });
  assert.ok(Buffer.byteLength(md) <= 40);
});

test('pruneExcerpts: drops expired files and all but the newest `keep`', async () => {
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pruneExcerpts } = await import('../lib/excerpt.js');
  const dir = fs.mkdtempSync(`${tmpdir()}/excerpts-`);
  const now = Date.parse('2026-10-04T12:00:00Z');
  const day = 24 * 3600 * 1000;
  const files = { 'a.md': now - 1000, 'b.md': now - 2000, 'c.md': now - 3000, 'old.md': now - 8 * day, 'keep.txt': now - 9 * day };
  for (const [f, t] of Object.entries(files)) {
    fs.writeFileSync(`${dir}/${f}`, 'x');
    fs.utimesSync(`${dir}/${f}`, t / 1000, t / 1000);
  }
  assert.deepEqual(pruneExcerpts(dir, { ttlMs: 7 * day, keep: 2, now, fs }).sort(), ['c.md', 'old.md']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.md', 'b.md', 'keep.txt']);
  assert.deepEqual(pruneExcerpts(`${dir}/missing`, { ttlMs: day, keep: 1, now, fs }), []);
});
