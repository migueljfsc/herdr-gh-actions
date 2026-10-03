import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusV2, parseRemote, isGithubHost, createGit } from '../lib/git.js';

test('parseStatusV2 with upstream', () => {
  const s = parseStatusV2('# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -1\n1 .M N... x\n');
  assert.deepEqual(s, { oid: 'abc', head: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 1 });
});

test('parseStatusV2 detached / no upstream / initial', () => {
  assert.deepEqual(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n'), { oid: 'abc', head: null, upstream: null, ahead: null, behind: null });
  assert.equal(parseStatusV2('# branch.oid (initial)\n# branch.head main\n').oid, null);
});

test('parseRemote variants', () => {
  assert.deepEqual(parseRemote('git@github.com:o/r.git'), { host: 'github.com', owner: 'o', repo: 'r', scp: true });
  assert.deepEqual(parseRemote('git@github-personal:migueljfsc/pitchboard.git\n'), { host: 'github-personal', owner: 'migueljfsc', repo: 'pitchboard', scp: true });
  assert.deepEqual(parseRemote('ssh://git@ssh.github.com:443/o/r.git'), { host: 'ssh.github.com', owner: 'o', repo: 'r', scp: true });
  assert.deepEqual(parseRemote('https://github.com/o/r'), { host: 'github.com', owner: 'o', repo: 'r', scp: false });
  assert.deepEqual(parseRemote('https://user@github.com/o/r.git/'), { host: 'github.com', owner: 'o', repo: 'r', scp: false });
  assert.equal(parseRemote('/local/path'), null);
});

test('isGithubHost', () => {
  assert.equal(isGithubHost('github.com'), true);
  assert.equal(isGithubHost('ssh.github.com'), true);
  assert.equal(isGithubHost('gitlab.com'), false);
  assert.equal(isGithubHost('notgithub.com'), false);
});

test('githubRepo resolves ssh aliases via ssh -G, once per alias', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'git') return { code: 0, stdout: 'git@gh-alias:o/r.git\n', stderr: '' };
    return { code: 0, stdout: 'user git\nhostname ssh.github.com\nport 443\n', stderr: '' };
  };
  const git = createGit({ exec });
  assert.deepEqual(await git.githubRepo('/a'), { owner: 'o', repo: 'r' });
  assert.deepEqual(await git.githubRepo('/b'), { owner: 'o', repo: 'r' });
  assert.equal(calls.filter((c) => c === 'ssh').length, 1);
});

test('githubRepo rejects non-github hosts', async () => {
  const git = createGit({ exec: async (cmd) => (cmd === 'git' ? { code: 0, stdout: 'https://gitlab.com/o/r.git', stderr: '' } : { code: 1, stdout: '', stderr: '' }) });
  assert.equal(await git.githubRepo('/a'), null);
});

test('skipsCi markers', async () => {
  const { skipsCi } = await import('../lib/git.js');
  assert.equal(skipsCi('chore(release): bump 0.1.0 → 0.2.0 [skip ci]'), true);
  assert.equal(skipsCi('x\n\n[CI SKIP]'), true);
  assert.equal(skipsCi('[actions skip] y'), true);
  assert.equal(skipsCi('skip ci without brackets'), false);
});

test('branchState reads commit time and skip marker', async () => {
  const exec = async (cmd, args) =>
    args.includes('status')
      ? { code: 0, stdout: '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n', stderr: '' }
      : { code: 0, stdout: '1791000000\nchore: bump [skip ci]\n\n', stderr: '' };
  const st = await createGit({ exec }).branchState('/r');
  assert.equal(st.time, 1791000000000);
  assert.equal(st.skipCi, true);
});
