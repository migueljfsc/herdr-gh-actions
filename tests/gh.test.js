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
