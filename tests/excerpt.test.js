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
  const md = buildExcerpt(ctx, steps, notes, 2);
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
