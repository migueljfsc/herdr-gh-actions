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

/**
 * Markdown handed to an agent: where the failure is, the annotations, and the tail of each failed
 * step's log (maxLines per step).
 * ctx: { owner, repo, branch, sha, workflow, job?, url }; notes: annotation lines ({ text }).
 */
export function buildExcerpt(ctx, steps, notes = [], maxLines = 80) {
  const out = [`# CI failure: ${ctx.workflow}${ctx.job ? ` / ${ctx.job}` : ''} on ${ctx.branch}`, ''];
  out.push(`- repo: ${ctx.owner}/${ctx.repo}`, `- commit: ${ctx.sha}`, `- run: ${ctx.url}`, '');
  const ann = notes
    .map((n) => n.text)
    .filter(Boolean)
    .map((t) => (t.startsWith('▸ annotations · ') ? `- ${t.slice('▸ annotations · '.length)}` : /^[✗!] /.test(t) ? `  - ${t}` : `    ${t.trim()}`));
  if (ann.length) out.push('## Annotations', '', ...ann, '');
  for (const s of steps) {
    const tail = s.lines.slice(-maxLines);
    const cut = s.lines.length > tail.length ? ` (last ${tail.length} of ${s.lines.length} lines)` : '';
    out.push(`## ${s.job} › ${s.step}${cut}`, '', '```text', ...tail, '```', '');
  }
  if (!steps.length) out.push('_No failed step logs were available._', '');
  return out.join('\n');
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
