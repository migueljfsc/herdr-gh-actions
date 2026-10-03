const ESC = '\x1b[';
const MAX_TOKEN = 80;

export function fmtDuration(ms, precise = false) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return precise ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

// Sidebar token value; null means clear it.
export function tokenText(status, now = Date.now()) {
  let t;
  switch (status.kind) {
    case 'pushed':
      t = '↑ pushed';
      break;
    case 'running':
      t = `◌ CI ${fmtDuration(now - status.since)}`;
      break;
    case 'success':
      t = '✓ CI';
      break;
    case 'failure':
      t = '✗ CI';
      break;
    case 'error':
      t = '⚠ CI';
      break;
    default:
      return null;
  }
  if (status.authWarning) t += ' ⚠auth';
  return [...t].slice(0, MAX_TOKEN).join('');
}

// [glyph, sgr] for a run/job/step status.
export function glyph(status, conclusion) {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return ['✓', '32'];
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return ['✗', '31'];
      case 'cancelled':
        return ['⊘', '33'];
      case 'action_required':
        return ['!', '33'];
      default:
        return ['–', '2'];
    }
  }
  if (status === 'in_progress') return ['◌', '33'];
  return ['·', '36'];
}

export function width(s) {
  return [...s].length;
}

// segments: array of [text, sgr?]. Truncates to w columns with "…" and pads with spaces (in padSgr).
export function fit(segments, w, padSgr = null) {
  let out = '';
  let used = 0;
  for (let i = 0; i < segments.length; i++) {
    const [text, sgr] = segments[i];
    const chars = [...text];
    const room = w - used;
    if (room <= 0) break;
    let piece = chars;
    if (chars.length > room) piece = [...chars.slice(0, Math.max(0, room - 1)), '…'];
    const str = piece.join('');
    out += sgr ? `${ESC}${sgr}m${str}${ESC}0m` : str;
    used += piece.length;
  }
  const pad = ' '.repeat(Math.max(0, w - used));
  return out + (padSgr && pad ? `${ESC}${padSgr}m${pad}${ESC}0m` : pad);
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Actions logs echo shell commands with their colour codes in caret notation ("^[[36;1m").
const CARET_SGR_RE = /\^\[\[[0-9;]*m/g;
const PREFIX_RE = /^[^\t]*\t[^\t]*\t/;
const TS_RE = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

// gh --log lines are "job\tstep\t<BOM>timestamp text". → [{ text, sgr }]
export function formatLog(raw) {
  const out = [];
  for (let line of raw.split('\n')) {
    line = line.replace(PREFIX_RE, '').replace(TS_RE, '').replace(ANSI_RE, '').replace(CARET_SGR_RE, '');
    if (line.includes('\r')) line = line.split('\r').filter(Boolean).pop() ?? '';
    line = line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '  ');
    if (line.startsWith('##[endgroup]')) continue;
    let m;
    if ((m = /^##\[group\](.*)$/.exec(line))) out.push({ text: `▸ ${m[1]}`, sgr: '1' });
    else if ((m = /^##\[error\](.*)$/.exec(line))) out.push({ text: m[1], sgr: '31' });
    else if ((m = /^##\[warning\](.*)$/.exec(line))) out.push({ text: m[1], sgr: '33' });
    else if ((m = /^##\[(?:notice|debug|command)\](.*)$/.exec(line))) out.push({ text: m[1], sgr: '2' });
    else out.push({ text: line, sgr: null });
  }
  while (out.length && out[out.length - 1].text === '') out.pop();
  return out;
}

export function wrapLines(lines, w) {
  const out = [];
  const cw = Math.max(1, w);
  for (const { text, sgr } of lines) {
    const chars = [...text];
    if (!chars.length) {
      out.push({ text: '', sgr });
      continue;
    }
    for (let i = 0; i < chars.length; i += cw) out.push({ text: chars.slice(i, i + cw).join(''), sgr });
  }
  return out;
}

function headerLine(h, w) {
  if (!h) return fit([['GH Actions', '1']], w);
  const segs = [[`${h.owner}/${h.repo}`, '1'], [' · ', '2'], [h.branch ?? '(detached)', '35']];
  if (h.headShort) segs.push([' · ', '2'], [h.headShort, '2']);
  if (h.pushed) segs.push(['  ↑ pushed, waiting for run', '36']);
  else if (h.ahead) segs.push([`  ↑${h.ahead} unpushed`, '33']);
  return fit(segs, w);
}

const KEY_HINTS = {
  log: 'j/k g/G PgUp/PgDn · esc back · q quit',
  picker: 'j/k ↵ run · esc back',
  list: 'j/k ↵ l f o x X c w R q',
};

function statusLine(s, w, view, confirm) {
  if (confirm) return fit([[`${confirm} `, '1;33'], ['[y/n]', '33']], w);
  const keys = KEY_HINTS[view] ?? KEY_HINTS.list;
  const segs = [];
  if (s.stale) segs.push(['⚠ stale ', '33']);
  if (s.loading) segs.push(['… ', '2']);
  if (s.message) segs.push([`${s.message} `, s.messageSgr ?? '2']);
  else if (s.updatedAt) segs.push([`updated ${s.updatedAt} `, '2']);
  const left = segs.reduce((n, [t]) => n + width(t), 0);
  const pad = Math.max(1, w - left - width(keys));
  segs.push([' '.repeat(pad), null], [keys, '2']);
  return fit(segs, w);
}

function rowSegments(row, selected) {
  const indent = '  '.repeat(row.depth);
  const segs = [[indent, null]];
  if (row.expandable) segs.push([row.expanded ? '▾ ' : '▸ ', '2']);
  else segs.push(['  ', null]);
  if (row.glyph) segs.push([row.glyph[0], row.glyph[1]], [' ', null]);
  segs.push([row.label, selected ? '1' : row.dim ? '2' : null]);
  if (row.meta) segs.push(['  ', null], [row.meta, '2']);
  return segs;
}

/**
 * Full pane frame: exactly `rows` lines, each exactly `cols` wide.
 * model: { header, view: 'list'|'log'|'picker', items, selected, top, log: { title, lines, top },
 *          picker: { title, items, selected, top, empty }, status, empty, confirm }
 */
export function renderPane(model, cols, rows) {
  const w = Math.max(10, cols);
  const h = Math.max(3, rows);
  const lines = [headerLine(model.header, w)];
  const bodyH = h - 2;
  if (model.view === 'log' && model.log) {
    const title = fit([[model.log.title, '1;4']], w);
    const wrapped = wrapLines(model.log.lines, w);
    const top = clampTop(model.log.top, wrapped.length, bodyH - 1);
    lines.push(title);
    for (let i = 0; i < bodyH - 1; i++) {
      const l = wrapped[top + i];
      lines.push(l ? fit([[l.text, l.sgr]], w) : ' '.repeat(w));
    }
  } else if (model.view === 'picker' && model.picker) {
    const p = model.picker;
    lines.push(fit([[p.title, '1;4']], w));
    lines.push(...listLines(p.items, p.selected, p.top, p.empty, w, bodyH - 1));
  } else {
    lines.push(...listLines(model.items ?? [], model.selected, model.top, model.empty ?? 'no runs for this branch', w, bodyH));
  }
  lines.push(statusLine(model.status ?? {}, w, model.view, model.confirm));
  return lines;
}

function listLines(items, selected, top0, empty, w, viewH) {
  const lines = [];
  if (!items.length) {
    lines.push(fit([[empty ?? '', '2']], w));
    for (let i = 1; i < viewH; i++) lines.push(' '.repeat(w));
    return lines;
  }
  const top = clampTop(top0 ?? 0, items.length, viewH);
  for (let i = 0; i < viewH; i++) {
    const idx = top + i;
    const row = items[idx];
    if (!row) {
      lines.push(' '.repeat(w));
      continue;
    }
    const sel = idx === selected;
    let segs = rowSegments(row, sel);
    if (sel) segs = segs.map(([t, sgr]) => [t, sgr ? `7;${sgr}` : '7']);
    lines.push(fit(segs, w, sel ? '7' : null));
  }
  return lines;
}

export function clampTop(top, total, viewH) {
  return Math.max(0, Math.min(top, total - viewH));
}

// Smallest scroll offset that keeps `selected` visible.
export function followSelection(top, selected, viewH) {
  if (selected < top) return selected;
  if (selected >= top + viewH) return selected - viewH + 1;
  return top;
}

function span(start, end, now) {
  const a = Date.parse(start);
  if (!a) return null;
  const b = end ? Date.parse(end) : now;
  return b > a ? fmtDuration(b - a, true) : null;
}

/**
 * Flatten runs → jobs → steps into pane rows.
 * jobsByRun: Map runId → { jobs } | { error } ; expandedRuns/expandedJobs: Sets of ids.
 */
export function buildItems({ runs, jobsByRun, expandedRuns, expandedJobs, head, now = Date.now() }) {
  const items = [];
  for (const r of runs) {
    const open = expandedRuns.has(r.databaseId);
    const sha = (r.headSha ?? '').slice(0, 7) + (r.headSha === head ? ' (HEAD)' : '');
    const start = r.startedAt || r.createdAt;
    const timing = r.status === 'completed' ? span(start, r.updatedAt, now) : fmtDuration(now - Date.parse(start));
    const attempt = r.attempt > 1 ? `attempt ${r.attempt}` : null;
    const age = r.status === 'completed' ? `${fmtDuration(now - Date.parse(r.updatedAt))} ago` : null;
    items.push({
      key: `run:${r.databaseId}`,
      type: 'run',
      run: r,
      depth: 0,
      expandable: true,
      expanded: open,
      glyph: glyph(r.status, r.conclusion),
      label: `${r.workflowName} · ${r.displayTitle}`,
      meta: [r.event, sha, attempt, timing, age].filter(Boolean).join(' · '),
    });
    if (!open) continue;
    const entry = jobsByRun.get(r.databaseId);
    if (!entry) {
      items.push({ key: `note:${r.databaseId}`, type: 'note', run: r, depth: 1, label: 'loading jobs…', dim: true });
      continue;
    }
    if (entry.error) {
      items.push({ key: `note:${r.databaseId}`, type: 'note', run: r, depth: 1, label: `⚠ ${entry.error}`, dim: true });
      continue;
    }
    for (const j of entry.jobs) {
      const jopen = expandedJobs.has(j.databaseId);
      const steps = j.steps ?? [];
      items.push({
        key: `job:${j.databaseId}`,
        type: 'job',
        run: r,
        job: j,
        depth: 1,
        expandable: steps.length > 0,
        expanded: jopen,
        glyph: glyph(j.status, j.conclusion),
        label: j.name,
        meta: span(j.startedAt, j.completedAt, now),
      });
      if (!jopen) continue;
      for (const s of steps) {
        items.push({
          key: `step:${j.databaseId}:${s.number}`,
          type: 'step',
          run: r,
          job: j,
          step: s,
          depth: 2,
          glyph: glyph(s.status, s.conclusion),
          label: `${s.number}. ${s.name}`,
          meta: span(s.startedAt, s.completedAt, now),
          dim: s.conclusion === 'skipped',
        });
      }
    }
  }
  return items;
}
