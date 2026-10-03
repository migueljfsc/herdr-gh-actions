import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, runListArgs, runJobsArgs, jobLogArgs, RUN_FIELDS } from '../lib/gh.js';

test('argv builders', () => {
  assert.deepEqual(runListArgs('o', 'r', 'feat/x', 5), ['run', 'list', '-R', 'o/r', '-b', 'feat/x', '-L', '5', '--json', RUN_FIELDS.join(',')]);
  assert.deepEqual(runJobsArgs('o', 'r', 42), ['run', 'view', '42', '-R', 'o/r', '--json', 'jobs']);
  assert.deepEqual(jobLogArgs('o', 'r', 42, 7), ['run', 'view', '42', '-R', 'o/r', '--job', '7', '--log']);
  assert.deepEqual(jobLogArgs('o', 'r', 42, 7, true).at(-1), '--log-failed');
  assert.deepEqual(jobLogArgs('o', 'r', 42, null, true), ['run', 'view', '42', '-R', 'o/r', '--log-failed']);
});

function fakeExec(tokens, calls) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, token: opts.env.GH_TOKEN });
    if (args[0] === 'auth') {
      const t = tokens[args[3]];
      return t ? { code: 0, stdout: `${t}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'no account' };
    }
    return { code: 0, stdout: '[]', stderr: '' };
  };
}

test('GH_TOKEN chosen by owner mapping, cached per login', async () => {
  const calls = [];
  const gh = createGh({ exec: fakeExec({ work: 'T1', me: 'T2' }, calls), accounts: { Corp: 'work', '*': 'me' }, baseEnv: {} });
  await gh.runList('corp', 'r', 'main', 5);
  await gh.runList('corp', 'r', 'main', 5);
  await gh.runList('someone', 'r', 'main', 5);
  const runs = calls.filter((c) => c.args[0] === 'run');
  assert.deepEqual(runs.map((c) => c.token), ['T1', 'T1', 'T2']);
  assert.equal(calls.filter((c) => c.args[0] === 'auth').length, 2);
});

test('missing token for mapped login → default identity + authWarning', async () => {
  const calls = [];
  const gh = createGh({ exec: fakeExec({}, calls), accounts: { '*': 'ghost' }, baseEnv: {} });
  const { authWarning } = await gh.runList('o', 'r', 'main', 5);
  assert.equal(authWarning, true);
  assert.equal(calls.at(-1).token, undefined);
});

test('no mapping → no GH_TOKEN, no warning', async () => {
  const calls = [];
  const gh = createGh({ exec: fakeExec({}, calls), accounts: {}, baseEnv: {} });
  const { authWarning } = await gh.runList('o', 'r', 'main', 5);
  assert.equal(authWarning, false);
  assert.equal(calls.length, 1);
});

test('gh failure throws GhError with first stderr line', async () => {
  const gh = createGh({ exec: async () => ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found\nmore' }), baseEnv: {} });
  await assert.rejects(gh.runList('o', 'r', 'b', 1), /HTTP 404: Not Found$/);
});

test('action argv builders', async () => {
  const { rerunArgs, cancelArgs, workflowListArgs, workflowFileArgs, workflowRunArgs } = await import('../lib/gh.js');
  assert.deepEqual(rerunArgs('o', 'r', 9, true), ['run', 'rerun', '9', '-R', 'o/r', '--failed']);
  assert.deepEqual(rerunArgs('o', 'r', 9, false), ['run', 'rerun', '9', '-R', 'o/r']);
  assert.deepEqual(cancelArgs('o', 'r', 9), ['run', 'cancel', '9', '-R', 'o/r']);
  assert.deepEqual(workflowListArgs('o', 'r'), ['workflow', 'list', '-R', 'o/r', '--json', 'id,name,path,state']);
  assert.deepEqual(workflowFileArgs('o', 'r', '.github/workflows/ci.yml', 'feat/x'), [
    'api',
    'repos/o/r/contents/.github/workflows/ci.yml?ref=feat%2Fx',
    '-H',
    'Accept: application/vnd.github.raw',
  ]);
  assert.deepEqual(workflowRunArgs('o', 'r', 123, 'main'), ['workflow', 'run', '123', '-R', 'o/r', '--ref', 'main']);
});

test('hasDispatchTrigger: block, flow, scalar, inputs; ignores comments and lookalikes', async () => {
  const { hasDispatchTrigger } = await import('../lib/gh.js');
  assert.equal(hasDispatchTrigger('on:\n  push:\n  workflow_dispatch:\n'), true);
  assert.equal(hasDispatchTrigger('on:\n  workflow_dispatch:\n    inputs:\n      x:\n'), true);
  assert.equal(hasDispatchTrigger('on: [push, workflow_dispatch]\n'), true);
  assert.equal(hasDispatchTrigger('on: workflow_dispatch\n'), true);
  assert.equal(hasDispatchTrigger('on: { workflow_dispatch: {} }\n'), true);
  assert.equal(hasDispatchTrigger('on:\n  push:\n  # workflow_dispatch:\n'), false);
  assert.equal(hasDispatchTrigger('on: push # add workflow_dispatch later\n'), false);
  assert.equal(hasDispatchTrigger('on:\n  repository_dispatch:\n'), false);
});

test('workflows(): active on-disk workflows only, tagged dispatchable from file text', async () => {
  const exec = async (cmd, args) => {
    if (args[0] === 'workflow') {
      return {
        code: 0,
        stdout: JSON.stringify([
          { id: 1, name: 'ci', path: '.github/workflows/ci.yml', state: 'active' },
          { id: 2, name: 'publish', path: '.github/workflows/publish.yml', state: 'active' },
          { id: 3, name: 'old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
          { id: 4, name: 'Dependabot Updates', path: 'dynamic/dependabot/dependabot-updates', state: 'active' },
        ]),
        stderr: '',
      };
    }
    if (args[1].includes('publish.yml')) return { code: 0, stdout: 'on:\n  workflow_dispatch:\n', stderr: '' };
    return { code: 0, stdout: 'on: [push]\n', stderr: '' };
  };
  const gh = createGh({ exec, baseEnv: {} });
  const list = await gh.workflows('o', 'r', 'main');
  assert.deepEqual(list.map((w) => [w.id, w.dispatchable]), [[1, false], [2, true]]);
});
