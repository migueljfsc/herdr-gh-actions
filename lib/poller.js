import { deriveStatus, isActive, newlyCompleted, shouldNotify, notification, sortRuns } from './state.js';
import { tokenText } from './render.js';
import { PLUGIN_ID } from './session.js';

const CACHE_MS = 5 * 60 * 1000;
const NOTIFIED_MAX = 500;
const RATE_LIMIT_PAUSE_MS = 60 * 1000;

const paneCwd = (p) => p.foreground_cwd || p.cwd;

function paneCwds(panes) {
  const byWs = new Map();
  for (const p of panes) {
    const cwd = paneCwd(p);
    if (!p.workspace_id || !cwd) continue;
    if (!byWs.has(p.workspace_id)) byWs.set(p.workspace_id, []);
    const list = byWs.get(p.workspace_id);
    if (!list.includes(cwd)) list.push(cwd);
  }
  return byWs;
}

const newToken = () => ({ lastToken: null, lastSentAt: 0, lastTtl: 0 });

/**
 * Status is tracked per checkout (git toplevel). Each workspace maps to the first checkout among its
 * panes' cwds; each agent pane maps to the checkout of its own cwd, so an agent in a worktree on
 * another branch gets that branch's status. Tokens: `ci` on workspaces and on agent panes.
 */
export function createPoller({ herdr, git, gh, config, now = Date.now, source = `plugin:${PLUGIN_ID}`, log = () => {} }) {
  const checkouts = new Map();
  const workspaces = new Map();
  const agentPanes = new Map();
  const rootCache = new Map();
  const repoCache = new Map();
  const notified = new Set();
  let seq = 0;
  // While GitHub rate-limits us, checkouts keep their last status and no run list is fetched.
  let pausedUntil = 0;

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

  async function observe(repo, force, fetches) {
    const t = now();
    const prev = checkouts.get(repo.root) ?? { since: t, known: new Map() };
    const bs = await git.branchState(repo.root);
    if (!bs?.head) {
      checkouts.set(repo.root, { ...prev, repo, status: { kind: 'none' }, runs: [], key: null, branch: null });
      return;
    }
    const key = [bs.head, bs.oid, bs.upstream, bs.ahead, bs.behind].join('|');
    const headSeenAt = prev.oid === bs.oid && prev.branch === bs.head ? prev.headSeenAt : t;
    const stale = t - (prev.lastFetch ?? 0) >= config.idle_poll_seconds * 1000;
    const due = t >= pausedUntil && (force || prev.key !== key || !prev.status || isActive(prev.status) || prev.status.kind === 'error' || stale);
    const next = { ...prev, repo, key, branch: bs.head, oid: bs.oid, upstream: bs.upstream, ahead: bs.ahead, behind: bs.behind, headTime: bs.time, headSeenAt };
    if (prev.branch !== bs.head) {
      next.known = new Map();
      next.since = t;
    }
    if (!due) {
      checkouts.set(repo.root, next);
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
        skipCi: bs.skipCi,
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
      if (e.rateLimited) {
        if (t >= pausedUntil) log(`rate limited; pausing until ${new Date(e.resetAt ?? t + RATE_LIMIT_PAUSE_MS).toISOString()}`);
        pausedUntil = Math.max(pausedUntil, e.resetAt ?? t + RATE_LIMIT_PAUSE_MS);
        next.status = prev.status ?? { kind: 'error', message: e.message };
        checkouts.set(repo.root, next);
        return;
      }
      next.status = { kind: 'error', message: e.message };
      next.error = e.message;
      next.lastFetch = t;
      log(`${repo.root} ${fkey}: ${e.message}`);
    }
    checkouts.set(repo.root, next);
  }

  // target: { root, tok }. send(value, ttlMs, seq) reports or clears (value null) the token.
  async function report(target, intervalMs, send) {
    const t = now();
    const status = target.root ? checkouts.get(target.root)?.status : null;
    const text = status ? tokenText(status, t) : null;
    const tok = target.tok;
    const ttl = intervalMs * 3;
    if (text == null) {
      if (tok.lastToken == null) return;
      await send(null, null, nextSeq());
      tok.lastToken = null;
      return;
    }
    const expiring = tok.lastSentAt + tok.lastTtl < t + intervalMs * 2;
    if (text === tok.lastToken && !expiring) return;
    await send(text, ttl, nextSeq());
    tok.lastToken = text;
    tok.lastSentAt = t;
    tok.lastTtl = ttl;
  }

  const sendWorkspace = (id) => (value, ttlMs, s) => herdr.reportToken(id, { source, name: 'ci', value, ttlMs, seq: s });
  const sendPane = (id) => (value, ttlMs, s) => herdr.reportPaneToken(id, { source, name: 'ci', value, ttlMs, seq: s });

  async function tick({ force = false } = {}) {
    const panes = await herdr.paneList();
    const byWs = paneCwds(panes);
    const agents = panes.filter((p) => p.agent && paneCwd(p));

    for (const id of workspaces.keys()) if (!byWs.has(id)) workspaces.delete(id);
    const agentIds = new Set(agents.map((p) => p.pane_id));
    for (const id of agentPanes.keys()) if (!agentIds.has(id)) agentPanes.delete(id);

    const repos = new Map();
    const resolve = async (cwds) => {
      try {
        const repo = await resolveRepo(cwds);
        if (repo) repos.set(repo.root, repo);
        return repo?.root ?? null;
      } catch (e) {
        log(`resolve ${cwds[0]}: ${e.message}`);
        return null;
      }
    };
    await Promise.all([
      ...[...byWs].map(async ([id, cwds]) => {
        const root = await resolve(cwds);
        const t = workspaces.get(id) ?? { tok: newToken() };
        workspaces.set(id, { ...t, root });
      }),
      ...agents.map(async (p) => {
        const root = await resolve([paneCwd(p)]);
        const t = agentPanes.get(p.pane_id) ?? { tok: newToken() };
        agentPanes.set(p.pane_id, { ...t, root });
      }),
    ]);

    for (const root of checkouts.keys()) if (!repos.has(root)) checkouts.delete(root);
    const fetches = new Map();
    await Promise.all([...repos.values()].map((repo) => observe(repo, force, fetches).catch((e) => log(`${repo.root}: ${e.message}`))));

    const active = [...checkouts.values()].some((c) => c.status && isActive(c.status));
    const intervalMs = (active ? config.poll_seconds : config.idle_poll_seconds) * 1000;
    for (const [id, target] of workspaces) {
      await report(target, intervalMs, sendWorkspace(id)).catch((e) => log(`${id}: report failed: ${e.message}`));
    }
    for (const [id, target] of agentPanes) {
      await report(target, intervalMs, sendPane(id)).catch((e) => log(`${id}: pane report failed: ${e.message}`));
    }
    return { intervalMs, snapshot: snapshot(intervalMs) };
  }

  function snapshot(intervalMs) {
    const describe = (target) => {
      const c = target.root ? checkouts.get(target.root) : null;
      if (!c) return null;
      return {
        root: c.repo.root,
        owner: c.repo.owner,
        repo: c.repo.repo,
        branch: c.branch,
        head: c.oid,
        ahead: c.ahead,
        upstream: c.upstream,
        status: c.status,
        error: c.error ?? null,
        token: target.tok.lastToken,
        runs: c.runs ?? [],
        lastFetch: c.lastFetch ?? null,
      };
    };
    const collect = (map) => Object.fromEntries([...map].map(([id, t]) => [id, describe(t)]).filter(([, v]) => v));
    return { updatedAt: now(), intervalMs, workspaces: collect(workspaces), panes: collect(agentPanes) };
  }

  async function clearAll() {
    const all = [
      ...[...workspaces].map(([id, t]) => [t, sendWorkspace(id)]),
      ...[...agentPanes].map(([id, t]) => [t, sendPane(id)]),
    ];
    for (const [t, send] of all) {
      if (t.tok.lastToken == null) continue;
      try {
        await send(null, null, nextSeq());
        t.tok.lastToken = null;
      } catch {}
    }
  }

  return { tick, clearAll };
}
