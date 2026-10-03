import { run } from './exec.js';

export function parseStatusV2(text) {
  const out = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  for (const line of text.split('\n')) {
    if (!line.startsWith('# branch.')) continue;
    const [key, ...rest] = line.slice(2).split(' ');
    const val = rest.join(' ');
    if (key === 'branch.oid') out.oid = val === '(initial)' ? null : val;
    else if (key === 'branch.head') out.head = val === '(detached)' ? null : val;
    else if (key === 'branch.upstream') out.upstream = val;
    else if (key === 'branch.ab') {
      const m = /^\+(\d+) -(\d+)$/.exec(val);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    }
  }
  return out;
}

// Returns { host, owner, repo, scp } or null. scp marks scp-like/ssh URLs whose host may be an ssh alias.
export function parseRemote(url) {
  url = String(url).trim();
  let m = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (/^https?:\/\//.test(url)) {
    m = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    return m ? { host: m[1], owner: m[2], repo: m[3], scp: false } : null;
  }
  return m ? { host: m[1], owner: m[2], repo: m[3], scp: true } : null;
}

// GitHub's skip markers: a push whose head commit carries one starts no workflow run.
export function skipsCi(message) {
  return /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i.test(message);
}

export function isGithubHost(host) {
  return /(^|\.)github\.com$/i.test(host);
}

export function createGit({ exec = run } = {}) {
  const sshHosts = new Map();

  async function resolveSshHost(alias) {
    if (sshHosts.has(alias)) return sshHosts.get(alias);
    const r = await exec('ssh', ['-G', alias], { timeout: 5000 });
    const m = r.code === 0 ? /^hostname (\S+)$/m.exec(r.stdout) : null;
    const host = m ? m[1] : alias;
    sshHosts.set(alias, host);
    return host;
  }

  async function githubRepo(root) {
    const r = await exec('git', ['-C', root, 'remote', 'get-url', 'origin']);
    if (r.code !== 0) return null;
    const p = parseRemote(r.stdout);
    if (!p) return null;
    const host = isGithubHost(p.host) ? p.host : p.scp ? await resolveSshHost(p.host) : p.host;
    return isGithubHost(host) ? { owner: p.owner, repo: p.repo } : null;
  }

  async function toplevel(cwd) {
    const r = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  // --no-optional-locks: a background poller must never take index.lock from under the user.
  async function branchState(root) {
    const r = await exec('git', ['--no-optional-locks', '-C', root, 'status', '--porcelain=v2', '--branch', '-uno']);
    if (r.code !== 0) return null;
    const st = parseStatusV2(r.stdout);
    const t = st.oid ? await exec('git', ['-C', root, 'log', '-1', '--format=%ct%n%B', st.oid]) : null;
    const [time, ...message] = t?.code === 0 ? t.stdout.split('\n') : [];
    st.time = time?.trim() ? Number(time.trim()) * 1000 : null;
    st.skipCi = skipsCi(message.join('\n'));
    return st;
  }

  // Commit subject from the local clone; null when the commit isn't fetched here.
  async function subject(root, sha) {
    const r = await exec('git', ['-C', root, 'log', '-1', '--format=%s', sha]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  return { toplevel, githubRepo, branchState, resolveSshHost, subject };
}
