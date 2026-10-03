import { deriveStatus, isActive, newlyCompleted, shouldNotify, notification, sortRuns } from './state.js';
import { tokenText } from './render.js';
import { PLUGIN_ID } from './session.js';

const CACHE_MS = 5 * 60 * 1000;
const NOTIFIED_MAX = 500;

function paneCwds(panes) {
  const byWs = new Map();
  for (const p of panes) {
    const cwd = p.foreground_cwd || p.cwd;
    if (!p.workspace_id || !cwd) continue;
    if (!byWs.has(p.workspace_id)) byWs.set(p.workspace_id, []);
    const list = byWs.get(p.workspace_id);
    if (!list.includes(cwd)) list.push(cwd);
  }
  return byWs;
}

export function createPoller({ herdr, git, gh, config, now = Date.now, source = `plugin:${PLUGIN_ID}`, log = () => {} }) {
  const ws = new Map();
  const rootCache = new Map();
  const repoCache = new Map();
  const notified = new Set();
  let seq = 0;

  function nextSeq() {
    seq = Math.max(seq + 1, now());
    return seq;
  }

  async function cached(cache, key, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await fn();
    cache.set(key, { value, at: now() });
    return value;
  }

  async function resolveRepo(cwds) {
    for (const cwd of cwds) {
      const root = await cached(rootCache, cwd, () => git.toplevel(cwd));
      if (!root) continue;
      const repo = await cached(repoCache, root, () => git.githubRepo(root));
      if (repo) return { root, ...repo };
    }
    return null;
  }

  function markNotified(id) {
    notified.add(id);
    if (notified.size > NOTIFIED_MAX) notified.delete(notified.values().next().value);
  }

  async function observe(id, cwds, force, fetches) {
    const t = now();
    const prev = ws.get(id) ?? { since: t, known: new Map(), lastToken: null, lastSentAt: 0, lastTtl: 0 };
    const repo = await resolveRepo(cwds);
    const bs = repo ? await git.branchState(repo.root) : null;
    if (!repo || !bs?.head) {
      ws.set(id, { ...prev, repo: null, status: { kind: 'none' }, runs: [], key: null });
      return;
    }
    const key = [repo.root, bs.head, bs.oid, bs.upstream, bs.ahead, bs.behind].join('|');
    const headSeenAt = prev.repo && prev.oid === bs.oid && prev.branch === bs.head ? prev.headSeenAt : t;
    const stale = t - (prev.lastFetch ?? 0) >= config.idle_poll_seconds * 1000;
    const due = force || prev.key !== key || !prev.status || isActive(prev.status) || prev.status.kind === 'error' || stale;
    const next = { ...prev, repo, key, branch: bs.head, oid: bs.oid, upstream: bs.upstream, ahead: bs.ahead, behind: bs.behind, headTime: bs.time, headSeenAt };
    if (prev.branch !== bs.head || prev.repo?.root !== repo.root) {
      next.known = new Map();
      next.since = t;
    }
    if (!due) {
      ws.set(id, next);
      return;
    }
    const fkey = `${repo.owner}/${repo.repo}@${bs.head}`;
    if (!fetches.has(fkey)) fetches.set(fkey, gh.runList(repo.owner, repo.repo, bs.head, config.runs_per_branch));
    try {
      const { runs, authWarning } = await fetches.get(fkey);
      next.runs = sortRuns(runs);
      next.lastFetch = t;
      next.status = deriveStatus({
        runs: next.runs,
        head: bs.oid,
        headTime: bs.time,
        ahead: bs.ahead,
        behind: bs.behind,
        upstream: bs.upstream,
        headSeenAt,
        now: t,
        pushedGraceMs: config.pushed_grace_seconds * 1000,
      });
      next.status.authWarning = authWarning;
      next.error = null;
      const { done, known } = newlyCompleted(next.runs, next.known, next.since);
      next.known = known;
      const fresh = done.filter((r) => !notified.has(r.databaseId));
      fresh.forEach((r) => markNotified(r.databaseId));
      const send = fresh.filter((r) => shouldNotify(config.notify, r));
      if (send.length) {
        const n = notification(send, { repo: repo.repo, branch: bs.head });
        herdr.notify(n.title, { body: n.body, sound: n.sound }).catch((e) => log(`notify failed: ${e.message}`));
      }
    } catch (e) {
      next.status = { kind: 'error', message: e.message };
      next.error = e.message;
      next.lastFetch = t;
      log(`${id} ${fkey}: ${e.message}`);
    }
    ws.set(id, next);
  }

  async function report(id, s, intervalMs) {
    const t = now();
    const text = s.status ? tokenText(s.status, t) : null;
    const ttl = intervalMs * 3;
    if (text == null) {
      if (s.lastToken == null) return;
      await herdr.reportToken(id, { source, name: 'ci', value: null, seq: nextSeq() });
      s.lastToken = null;
      return;
    }
    const expiring = s.lastSentAt + s.lastTtl < t + intervalMs * 2;
    if (text === s.lastToken && !expiring) return;
    await herdr.reportToken(id, { source, name: 'ci', value: text, ttlMs: ttl, seq: nextSeq() });
    s.lastToken = text;
    s.lastSentAt = t;
    s.lastTtl = ttl;
  }

  async function tick({ force = false } = {}) {
    const panes = await herdr.paneList();
    const byWs = paneCwds(panes);
    for (const id of ws.keys()) if (!byWs.has(id)) ws.delete(id);
    const fetches = new Map();
    await Promise.all([...byWs].map(([id, cwds]) => observe(id, cwds, force, fetches).catch((e) => log(`${id}: ${e.message}`))));
    const active = [...ws.values()].some((s) => s.status && isActive(s.status));
    const intervalMs = (active ? config.poll_seconds : config.idle_poll_seconds) * 1000;
    for (const [id, s] of ws) {
      try {
        await report(id, s, intervalMs);
      } catch (e) {
        log(`${id}: report failed: ${e.message}`);
      }
    }
    return { intervalMs, snapshot: snapshot(intervalMs) };
  }

  function snapshot(intervalMs) {
    const out = {};
    for (const [id, s] of ws) {
      if (!s.repo) continue;
      out[id] = {
        root: s.repo.root,
        owner: s.repo.owner,
        repo: s.repo.repo,
        branch: s.branch,
        head: s.oid,
        ahead: s.ahead,
        upstream: s.upstream,
        status: s.status,
        error: s.error ?? null,
        token: s.lastToken,
        runs: s.runs ?? [],
        lastFetch: s.lastFetch ?? null,
      };
    }
    return { updatedAt: now(), intervalMs, workspaces: out };
  }

  async function clearAll() {
    for (const [id, s] of ws) {
      if (s.lastToken == null) continue;
      try {
        await herdr.reportToken(id, { source, name: 'ci', value: null, seq: nextSeq() });
        s.lastToken = null;
      } catch {}
    }
  }

  return { tick, clearAll, state: ws };
}
