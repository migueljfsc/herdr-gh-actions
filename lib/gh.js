import { run } from './exec.js';
import { accountFor } from './config.js';

export const RUN_FIELDS = [
  'databaseId',
  'status',
  'conclusion',
  'headSha',
  'workflowName',
  'displayTitle',
  'event',
  'createdAt',
  'updatedAt',
  'url',
];

export function runListArgs(owner, repo, branch, limit) {
  return ['run', 'list', '-R', `${owner}/${repo}`, '-b', branch, '-L', String(limit), '--json', RUN_FIELDS.join(',')];
}

export function runJobsArgs(owner, repo, runId) {
  return ['run', 'view', String(runId), '-R', `${owner}/${repo}`, '--json', 'jobs'];
}

export function jobLogArgs(owner, repo, runId, jobId, failedOnly = false) {
  const job = jobId == null ? [] : ['--job', String(jobId)];
  return ['run', 'view', String(runId), '-R', `${owner}/${repo}`, ...job, failedOnly ? '--log-failed' : '--log'];
}

export class GhError extends Error {
  constructor(message, { auth = false } = {}) {
    super(message);
    this.auth = auth;
  }
}

function firstLine(s) {
  return (s || '').trim().split('\n')[0].slice(0, 200);
}

// Tokens live only in memory and in the gh child's env; never logged or written to disk.
export function createGh({ exec = run, accounts = {}, baseEnv = process.env } = {}) {
  const tokens = new Map();

  async function tokenFor(login) {
    if (tokens.has(login)) return tokens.get(login);
    const r = await exec('gh', ['auth', 'token', '--user', login], { env: ghEnv(baseEnv), timeout: 10000 });
    const t = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    if (t) tokens.set(login, t);
    return t;
  }

  // → { env, authWarning }. Falls back to gh's default identity when the mapped login has no token.
  async function envFor(owner) {
    const login = accountFor(accounts, owner);
    const env = ghEnv(baseEnv);
    if (!login) return { env, authWarning: false };
    const token = await tokenFor(login);
    if (!token) return { env, authWarning: true };
    return { env: { ...env, GH_TOKEN: token }, authWarning: false };
  }

  async function gh(owner, args, opts = {}) {
    const { env, authWarning } = await envFor(owner);
    const r = await exec('gh', args, { env, timeout: opts.timeout ?? 30000 });
    if (r.code !== 0) {
      const msg = firstLine(r.stderr) || `gh exited ${r.code}`;
      if (/auth|401|403|credentials|token/i.test(msg)) tokens.clear();
      throw new GhError(msg, { auth: /auth|401|credentials/i.test(msg) });
    }
    return { stdout: r.stdout, authWarning };
  }

  async function runList(owner, repo, branch, limit) {
    const { stdout, authWarning } = await gh(owner, runListArgs(owner, repo, branch, limit));
    return { runs: JSON.parse(stdout), authWarning };
  }

  async function runJobs(owner, repo, runId) {
    const { stdout } = await gh(owner, runJobsArgs(owner, repo, runId));
    return JSON.parse(stdout).jobs ?? [];
  }

  async function jobLog(owner, repo, runId, jobId, failedOnly) {
    const { stdout } = await gh(owner, jobLogArgs(owner, repo, runId, jobId, failedOnly), { timeout: 60000 });
    return stdout;
  }

  return { runList, runJobs, jobLog, envFor };
}

export function ghEnv(base) {
  return { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
}
