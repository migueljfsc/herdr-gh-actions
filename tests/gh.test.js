import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, runsApiPath, runJobsArgs, jobLogArgs, parseHttp, fromApiRun, rateLimitReset } from '../lib/gh.js';

const http = (body, status = '200 OK', headers = '') => `HTTP/2.0 ${status}\n${headers}Content-Type: application/json\r\n\r\n${body}`;
const NO_RUNS = http('{"total_count":0,"workflow_runs":[]}');

test('argv builders', () => {
  assert.equal(runsApiPath('o', 'r', 'feat/x', 5, 2), 'repos/o/r/actions/runs?branch=feat%2Fx&per_page=5&page=2');
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
    return { code: 0, stdout: NO_RUNS, stderr: '' };
  };
}

test('GH_TOKEN chosen by owner mapping, cached per login', async () => {
  const calls = [];
  const gh = createGh({ exec: fakeExec({ work: 'T1', me: 'T2' }, calls), accounts: { Corp: 'work', '*': 'me' }, baseEnv: {} });
  await gh.runList('corp', 'r', 'main', 5);
  await gh.runList('corp', 'r', 'main', 5);
  await gh.runList('someone', 'r', 'main', 5);
  const runs = calls.filter((c) => c.args[0] === 'api');
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

test('classifyError: rate limits are not auth failures', async () => {
  const { classifyError } = await import('../lib/gh.js');
  assert.deepEqual(classifyError('HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/...)'), { rateLimited: true, auth: false });
  assert.deepEqual(classifyError('You have exceeded a secondary rate limit'), { rateLimited: true, auth: false });
  assert.deepEqual(classifyError('HTTP 429: Too Many Requests'), { rateLimited: true, auth: false });
  assert.deepEqual(classifyError('HTTP 401: Bad credentials'), { rateLimited: false, auth: true });
  assert.deepEqual(classifyError('To get started with GitHub CLI, please run:  gh auth login'), { rateLimited: false, auth: true });
  assert.deepEqual(classifyError('HTTP 403: Must have admin rights to Repository.'), { rateLimited: false, auth: false });
});

test('cached tokens survive a rate limit, drop on bad credentials', async () => {
  let fail = null;
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'auth') return { code: 0, stdout: 'T\n', stderr: '' };
    return fail ? { code: 1, stdout: '', stderr: fail } : { code: 0, stdout: NO_RUNS, stderr: '' };
  };
  const gh = createGh({ exec, accounts: { '*': 'me' }, baseEnv: {} });
  await gh.runList('o', 'r', 'b', 1);
  fail = 'HTTP 403: API rate limit exceeded';
  await assert.rejects(gh.runList('o', 'r', 'b', 1), (e) => e.rateLimited && !e.auth);
  fail = 'HTTP 401: Bad credentials';
  await assert.rejects(gh.runList('o', 'r', 'b', 1), (e) => e.auth);
  fail = null;
  await gh.runList('o', 'r', 'b', 1);
  assert.equal(calls.filter((c) => c === 'auth').length, 2);
});

test('parseHttp: status, lowercased headers, body; mixed line endings', () => {
  const r = parseHttp('HTTP/2.0 304 Not Modified\nEtag: "abc"\r\nX-Ratelimit-Remaining: 10\r\n\r\n');
  assert.equal(r.status, 304);
  assert.equal(r.headers.etag, '"abc"');
  assert.equal(r.headers['x-ratelimit-remaining'], '10');
  assert.equal(r.body, '');
  assert.equal(parseHttp(http('{"a":1}')).body, '{"a":1}');
  assert.equal(parseHttp('').status, null);
});

test('fromApiRun maps REST fields to the gh run list shape', () => {
  const run = fromApiRun({ id: 5, status: 'completed', conclusion: null, head_sha: 'abc', name: 'ci', display_title: 't', event: 'push', created_at: 'c', run_started_at: 's', updated_at: 'u', run_attempt: 2, html_url: 'h' });
  assert.deepEqual(run, { databaseId: 5, status: 'completed', conclusion: '', headSha: 'abc', workflowName: 'ci', displayTitle: 't', event: 'push', createdAt: 'c', startedAt: 's', updatedAt: 'u', attempt: 2, url: 'h' });
});

test('rateLimitReset: retry-after, exhausted primary limit, or unknown', () => {
  assert.equal(rateLimitReset({ 'retry-after': '30' }, 1000), 31000);
  assert.equal(rateLimitReset({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700' }), 1700000);
  assert.equal(rateLimitReset({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '1700' }), null);
});

test('runList: sends the cached ETag and serves a 304 from memory', async () => {
  const calls = [];
  const body = JSON.stringify({ workflow_runs: [{ id: 1, name: 'ci', head_sha: 'a', status: 'completed', conclusion: 'success' }] });
  const exec = async (cmd, args) => {
    calls.push(args);
    if (args.includes('If-None-Match: "e1"')) return { code: 1, stdout: http('', '304 Not Modified', 'Etag: "e1"\r\n'), stderr: 'gh: HTTP 304' };
    return { code: 0, stdout: http(body, '200 OK', 'Etag: "e1"\r\n'), stderr: '' };
  };
  const gh = createGh({ exec, baseEnv: {} });
  const a = await gh.runList('o', 'r', 'main', 20);
  const b = await gh.runList('o', 'r', 'main', 20);
  assert.deepEqual(calls[0], ['api', '-i', 'repos/o/r/actions/runs?branch=main&per_page=20&page=1']);
  assert.deepEqual(calls[1].slice(-2), ['-H', 'If-None-Match: "e1"']);
  assert.deepEqual(b.runs, a.runs);
  assert.equal(a.runs[0].databaseId, 1);
});

test('runList: pages of 100 until a short page or the limit', async () => {
  const pages = [];
  const exec = async (cmd, args) => {
    const page = Number(/page=(\d+)$/.exec(args[2])[1]);
    pages.push(page);
    const n = page < 3 ? 100 : 7;
    const runs = Array.from({ length: n }, (_, i) => ({ id: page * 1000 + i }));
    return { code: 0, stdout: http(JSON.stringify({ workflow_runs: runs })), stderr: '' };
  };
  const gh = createGh({ exec, baseEnv: {} });
  assert.equal((await gh.runList('o', 'r', 'b', 500)).runs.length, 207);
  assert.deepEqual(pages, [1, 2, 3]);
  pages.length = 0;
  assert.equal((await gh.runList('o', 'r', 'b', 150)).runs.length, 150);
  assert.deepEqual(pages, [1, 2]);
});

test('runList: a rate-limited response carries when it resets', async () => {
  const exec = async () => ({ code: 1, stdout: http('{}', '403 Forbidden', 'X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1700\r\n'), stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' });
  const gh = createGh({ exec, baseEnv: {} });
  await assert.rejects(gh.runList('o', 'r', 'b', 1), (e) => e.rateLimited && e.resetAt === 1700000);
});

test('artifact argv builders', async () => {
  const { artifactsArgs, downloadArgs, annotationsArgs } = await import('../lib/gh.js');
  assert.deepEqual(artifactsArgs('o', 'r', 9), ['api', 'repos/o/r/actions/runs/9/artifacts?per_page=100']);
  assert.deepEqual(downloadArgs('o', 'r', 9, 'dist', '/d/r-9/dist'), ['run', 'download', '9', '-R', 'o/r', '-n', 'dist', '-D', '/d/r-9/dist']);
  assert.deepEqual(annotationsArgs('o', 'r', 7), ['api', 'repos/o/r/check-runs/7/annotations?per_page=100']);
});

test('download: unarchived artifact falls back to the raw file', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/gh-dl-`);
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args.slice(0, 2).join(' '));
    return { code: 1, stdout: '', stderr: 'error downloading report.html: error extracting zip archive: zip: not a valid zip file' };
  };
  const execToFile = async (cmd, args, file) => {
    calls.push(`${args[1]} > ${file.slice(dir.length)}`);
    return { code: 0, stdout: '', stderr: '' };
  };
  const gh = createGh({ exec, execToFile, baseEnv: {} });
  const to = await gh.download('o', 'r', 9, { id: 77, name: 'report.html' }, `${dir}/r-9`);
  assert.equal(to, `${dir}/r-9/report.html`);
  assert.deepEqual(calls, ['run download', 'repos/o/r/actions/artifacts/77/zip > /r-9/report.html']);
  assert.ok(existsSync(`${dir}/r-9`));
});

test('download: other failures are not retried', async () => {
  const gh = createGh({ exec: async () => ({ code: 1, stdout: '', stderr: 'HTTP 410: Artifact has expired' }), execToFile: async () => assert.fail('no fallback'), baseEnv: {} });
  await assert.rejects(gh.download('o', 'r', 9, { id: 1, name: 'x' }, '/nonexistent/x'), /expired/);
});
