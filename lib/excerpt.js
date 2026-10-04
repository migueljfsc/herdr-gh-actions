import { join } from 'node:path';
import { formatLog } from './render.js';

// `gh run view --log-failed` output → [{ job, step, lines }] in log order, lines formatted.
export function failedSteps(raw) {
  const groups = new Map();
  for (const line of raw.split('\n')) {
    const m = /^([^\t]*)\t([^\t]*)\t/.exec(line);
    if (!m) continue;
    const key = `${m[1]}\t${m[2]}`;
    if (!groups.has(key)) groups.set(key, { job: m[1], step: m[2], raw: [] });
    groups.get(key).raw.push(line);
  }
  return [...groups.values()].map(({ job, step, raw: lines }) => ({ job, step, lines: formatLog(lines.join('\n')).map((l) => l.text) }));
}

// Cuts a line to `max` characters, ending in "…"; 0 keeps it whole.
export function clipLine(t, max) {
  if (!max) return t;
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

const bytes = (s) => Buffer.byteLength(s);

/**
 * Markdown handed to an agent: where the failure is, the annotations, and the tail of each failed
 * step's log. Lines are cut to lineChars (0: whole); past maxBytes, the oldest lines of the longest
 * step tails go first, then trailing annotations.
 * ctx: { owner, repo, branch, sha, workflow, job?, url }; notes: annotation lines ({ text }).
 */
export function buildExcerpt(ctx, steps, notes = [], { maxLines = 80, maxBytes = Infinity, lineChars = 500 } = {}) {
  const clip = (t) => clipLine(t, lineChars);
  const head = [`# CI failure: ${ctx.workflow}${ctx.job ? ` / ${ctx.job}` : ''} on ${ctx.branch}`, '', `- repo: ${ctx.owner}/${ctx.repo}`, `- commit: ${ctx.sha}`, `- run: ${ctx.url}`, ''];
  const ann = notes
    .map((n) => n.text)
    .filter(Boolean)
    .map((t) => clip(t.startsWith('▸ annotations · ') ? `- ${t.slice('▸ annotations · '.length)}` : /^[✗!] /.test(t) ? `  - ${t}` : `    ${t.trim()}`));
  const tails = steps.map((s) => ({ ...s, total: s.lines.length, tail: s.lines.slice(-maxLines).map(clip) }));
  const render = () => {
    const out = [...head];
    if (ann.length) out.push('## Annotations', '', ...ann, '');
    for (const s of tails) {
      const cut = s.total > s.tail.length ? ` (last ${s.tail.length} of ${s.total} lines)` : '';
      out.push(`## ${s.job} › ${s.step}${cut}`, '', '```text', ...s.tail, '```', '');
    }
    if (!steps.length) out.push('_No failed step logs were available._', '');
    return out.join('\n');
  };
  let text = render();
  while (bytes(text) > maxBytes) {
    let over = bytes(text) - maxBytes;
    while (over > 0) {
      const longest = tails.reduce((a, s) => (s.tail.length > (a?.tail.length ?? 0) ? s : a), null);
      if (longest) over -= bytes(longest.tail.shift()) + 1;
      else if (ann.length) over -= bytes(ann.pop()) + 1;
      else break;
    }
    const next = render();
    if (next === text || bytes(next) >= bytes(text)) {
      text = new TextDecoder().decode(Buffer.from(next).subarray(0, maxBytes)).replace(/\uFFFD$/, '');
      break;
    }
    text = next;
  }
  return text;
}

/**
 * Removes excerpts past their age (ttlMs) and all but the `keep` newest. Returns the names removed.
 * fs: { readdirSync, statSync, rmSync }.
 */
export function pruneExcerpts(dir, { ttlMs, keep, now = Date.now(), fs }) {
  let entries;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, at: fs.statSync(join(dir, f)).mtimeMs }));
  } catch {
    return [];
  }
  entries.sort((a, b) => b.at - a.at);
  const gone = entries.filter((e, i) => i >= keep || now - e.at > ttlMs).map((e) => e.f);
  for (const f of gone) {
    try {
      fs.rmSync(join(dir, f), { force: true });
    } catch {}
  }
  return gone;
}

// The one line typed into the agent's prompt; the user reviews it and presses Enter.
export function agentPrompt(ctx, path) {
  const what = `${ctx.workflow}${ctx.job ? ` / ${ctx.job}` : ''}`;
  return `CI failed: ${what} on ${ctx.branch} (${ctx.url}). Failed steps and annotations: ${path}. Find the cause and fix it.`;
}

/**
 * Agent panes to offer, best first: agents whose checkout is this repo's, then agents in this
 * workspace. Never the pane itself. panes: herdr pane list rows with `root` (their checkout) added.
 */
export function agentTargets(panes, { root, workspaceId, selfId }) {
  const agents = panes.filter((p) => p.agent && p.pane_id !== selfId);
  const same = agents.filter((p) => p.root === root);
  const near = agents.filter((p) => p.root !== root && workspaceId && p.workspace_id === workspaceId);
  return [...same, ...near];
}
