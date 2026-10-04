import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { run, runToFile } from './exec.js';
import { accountFor } from './config.js';

export function runsApiPath(owner, repo, branch, perPage, page) {
  return `repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`;
}

// REST workflow run → the `gh run list --json` shape the rest of the plugin reads.
export function fromApiRun(r) {
  return {
    databaseId: r.id,
    status: r.status,
    conclusion: r.conclusion || '',
    headSha: r.head_sha,
    workflowName: r.name,
    displayTitle: r.display_title,
    event: r.event,
    createdAt: r.created_at,
    startedAt: r.run_started_at,
    updatedAt: r.updated_at,
    attempt: r.run_attempt,
    url: r.html_url,
  };
}

// `gh api -i` stdout: status line, headers, blank line, body. Header names are lowercased.
export function parseHttp(text) {
  const m = /\r?\n\r?\n/.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  const [statusLine = '', ...lines] = head.split(/\r?\n/);
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(statusLine)?.[1]) || null;
  const headers = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status, headers, body: m ? text.slice(m.index + m[0].length) : '' };
}

// When a rate limit lifts, from the response headers (ms epoch), or null when they don't say.
export function rateLimitReset(headers, now = Date.now()) {
  if (headers['retry-after']) return now + Number(headers['retry-after']) * 1000;
  if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset']) return Number(headers['x-ratelimit-reset']) * 1000;
  return null;
}

export function runJobsArgs(owner, repo, runId) {
  return ['run', 'view', String(runId), '-R', `${owner}/${repo}`, '--json', 'jobs'];
}

export function jobLogArgs(owner, repo, runId, jobId, failedOnly = false) {
  const job = jobId == null ? [] : ['--job', String(jobId)];
  return ['run', 'view', String(runId), '-R', `${owner}/${repo}`, ...job, failedOnly ? '--log-failed' : '--log'];
}

export function annotationsArgs(owner, repo, jobId) {
  return ['api', `repos/${owner}/${repo}/check-runs/${jobId}/annotations?per_page=100`];
}

export function artifactsArgs(owner, repo, runId) {
  return ['api', `repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`];
}

export function downloadArgs(owner, repo, runId, name, dir) {
  return ['run', 'download', String(runId), '-R', `${owner}/${repo}`, '-n', name, '-D', dir];
}

export function artifactFileArgs(owner, repo, artifactId) {
  return ['api', `repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`];
}

export function pendingDeploymentsArgs(owner, repo, runId) {
  return ['api', `repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`];
}

// state: approved | rejected. -F sends the environment ids as integers.
export function reviewDeploymentsArgs(owner, repo, runId, envIds, state, comment) {
  return [
    'api',
    '-X',
    'POST',
    `repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`,
    ...envIds.flatMap((id) => ['-F', `environment_ids[]=${id}`]),
    '-f',
    `state=${state}`,
    '-f',
    `comment=${comment}`,
  ];
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

const ETAG_MAX = 200;

function firstLine(s) {
  return (s || '').trim().split('\n')[0].slice(0, 200);
}

// Tokens live only in memory and in the gh child's env; never logged or written to disk.
export function createGh({ exec = run, execToFile = runToFile, accounts = {}, baseEnv = process.env } = {}) {
  const tokens = new Map();
  // path → { etag, data }: a 304 for a known ETag doesn't count against the rate limit.
  const etags = new Map();

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

  function failure(r, headers = {}) {
    const msg = firstLine(r.stderr) || `gh exited ${r.code}`;
    const kind = classifyError(msg);
    if (kind.auth) tokens.clear();
    return new GhError(msg, { ...kind, resetAt: kind.rateLimited ? rateLimitReset(headers) : null });
  }

  async function gh(owner, args, opts = {}) {
    const { env, authWarning } = await envFor(owner);
    const r = await exec('gh', args, { env, timeout: opts.timeout ?? 30000 });
    if (r.code !== 0) throw failure(r);
    return { stdout: r.stdout, authWarning };
  }

  // GET through `gh api` with If-None-Match; an unchanged resource comes back from memory.
  async function apiCached(owner, path) {
    const { env, authWarning } = await envFor(owner);
    const hit = etags.get(path);
    const args = ['api', '-i', path, ...(hit ? ['-H', `If-None-Match: ${hit.etag}`] : [])];
    const r = await exec('gh', args, { env, timeout: 30000 });
    const res = parseHttp(r.stdout);
    if (res.status === 304 && hit) return { data: hit.data, authWarning };
    if (r.code !== 0) throw failure(r, res.headers);
    const data = JSON.parse(res.body);
    etags.delete(path);
    if (res.headers.etag) etags.set(path, { etag: res.headers.etag, data });
    if (etags.size > ETAG_MAX) etags.delete(etags.keys().next().value);
    return { data, authWarning };
  }

  // Newest `limit` runs of a branch, 100 per page.
  async function runList(owner, repo, branch, limit) {
    const per = Math.min(limit, 100);
    const runs = [];
    let authWarning = false;
    for (let page = 1; runs.length < limit; page++) {
      const r = await apiCached(owner, runsApiPath(owner, repo, branch, per, page));
      authWarning ||= r.authWarning;
      const list = r.data.workflow_runs ?? [];
      runs.push(...list.map(fromApiRun));
      if (list.length < per) break;
    }
    return { runs: runs.slice(0, limit), authWarning };
  }

  async function runJobs(owner, repo, runId) {
    const { stdout } = await gh(owner, runJobsArgs(owner, repo, runId));
    return JSON.parse(stdout).jobs ?? [];
  }

  async function jobLog(owner, repo, runId, jobId, failedOnly) {
    const { stdout } = await gh(owner, jobLogArgs(owner, repo, runId, jobId, failedOnly), { timeout: 60000 });
    return stdout;
  }

  // A job's id is its check run's id.
  async function annotations(owner, repo, jobId) {
    const { stdout } = await gh(owner, annotationsArgs(owner, repo, jobId));
    return JSON.parse(stdout);
  }

  async function artifacts(owner, repo, runId) {
    const { stdout } = await gh(owner, artifactsArgs(owner, repo, runId));
    return JSON.parse(stdout).artifacts ?? [];
  }

  // Into `<dir>/<name>`: a zipped artifact extracted as a folder, an unarchived one (upload-artifact
  // `archive: false`) saved as the file itself. Returns the path written.
  async function download(owner, repo, runId, artifact, dir) {
    const name = basename(artifact.name);
    const to = join(dir, name);
    try {
      await gh(owner, downloadArgs(owner, repo, runId, artifact.name, to), { timeout: 600000 });
      return to;
    } catch (e) {
      if (!/not a valid zip/i.test(e.message)) throw e;
    }
    rmSync(to, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const { env } = await envFor(owner);
    const r = await execToFile('gh', artifactFileArgs(owner, repo, artifact.id), to, { env });
    if (r.code !== 0) {
      rmSync(to, { force: true });
      throw failure(r);
    }
    return to;
  }

  async function pendingDeployments(owner, repo, runId) {
    const { stdout } = await gh(owner, pendingDeploymentsArgs(owner, repo, runId));
    return JSON.parse(stdout);
  }

  async function reviewDeployments(owner, repo, runId, envIds, state, comment) {
    await gh(owner, reviewDeploymentsArgs(owner, repo, runId, envIds, state, comment));
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

  return { runList, runJobs, jobLog, annotations, artifacts, download, pendingDeployments, reviewDeployments, rerun, cancel, workflows, dispatch, envFor };
}

export function ghEnv(base) {
  return { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
}
