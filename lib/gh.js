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
  'startedAt',
  'updatedAt',
  'attempt',
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

export function rerunArgs(owner, repo, runId, failedOnly) {
  return ['run', 'rerun', String(runId), '-R', `${owner}/${repo}`, ...(failedOnly ? ['--failed'] : [])];
}

export function cancelArgs(owner, repo, runId) {
  return ['run', 'cancel', String(runId), '-R', `${owner}/${repo}`];
}

export function workflowListArgs(owner, repo) {
  return ['workflow', 'list', '-R', `${owner}/${repo}`, '--json', 'id,name,path,state'];
}

export function workflowFileArgs(owner, repo, path, ref) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return ['api', `repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, '-H', 'Accept: application/vnd.github.raw'];
}

export function workflowRunArgs(owner, repo, workflowId, ref) {
  return ['workflow', 'run', String(workflowId), '-R', `${owner}/${repo}`, '--ref', ref];
}

// Text match, no YAML parser: a workflow_dispatch key or list entry outside a comment.
export function hasDispatchTrigger(text) {
  const code = String(text)
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  return /(^|[\s[,{])workflow_dispatch\s*(:|,|\]|}|$)/m.test(code);
}

export class GhError extends Error {
  constructor(message, { auth = false, rateLimited = false, resetAt = null } = {}) {
    super(message);
    this.auth = auth;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
  }
}

const RATE_RE = /rate limit|\b429\b|abuse detection/i;
const AUTH_RE = /\b401\b|bad credentials|authentication|auth login|not logged in|credentials/i;

// gh stderr → { auth, rateLimited }. A rate-limit 403 is not an auth failure.
export function classifyError(msg) {
  const rateLimited = RATE_RE.test(msg);
  return { rateLimited, auth: !rateLimited && AUTH_RE.test(msg) };
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
      const kind = classifyError(msg);
      if (kind.auth) tokens.clear();
      throw new GhError(msg, kind);
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

  async function rerun(owner, repo, runId, failedOnly) {
    await gh(owner, rerunArgs(owner, repo, runId, failedOnly));
  }

  async function cancel(owner, repo, runId) {
    await gh(owner, cancelArgs(owner, repo, runId));
  }

  // Active workflows on disk (dynamic ones like Dependabot excluded), each tagged with whether its
  // file at `ref` declares a workflow_dispatch trigger.
  async function workflows(owner, repo, ref) {
    const { stdout } = await gh(owner, workflowListArgs(owner, repo));
    const list = JSON.parse(stdout).filter((w) => w.state === 'active' && w.path.startsWith('.github/workflows/'));
    return Promise.all(
      list.map(async (w) => {
        try {
          const { stdout: text } = await gh(owner, workflowFileArgs(owner, repo, w.path, ref));
          return { ...w, dispatchable: hasDispatchTrigger(text) };
        } catch {
          return { ...w, dispatchable: false };
        }
      }),
    );
  }

  async function dispatch(owner, repo, workflowId, ref) {
    await gh(owner, workflowRunArgs(owner, repo, workflowId, ref));
  }

  return { runList, runJobs, jobLog, rerun, cancel, workflows, dispatch, envFor };
}

export function ghEnv(base) {
  return { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
}
