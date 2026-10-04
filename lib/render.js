import { groupByCommit, commitStatus, runStart } from './state.js';
import { matchSpans } from './search.js';

const ESC = '\x1b[';
const MAX_TOKEN = 80;

export function fmtDuration(ms, precise = false) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return precise ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

export function fmtSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[u]}`;
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
  if (status === 'waiting') return ['⏸', '35'];
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

// Each wrapped row keeps its source line index (src) and where in it the row starts (off).
const LEVEL = { failure: ['✗', '31'], warning: ['!', '33'] };

/**
 * Failure and warning annotations to put above a log: [{ job, list }] → [{ text, sgr }], empty when
 * there are none. Runner-level annotations (path ".github") have no file location worth showing.
 */
export function formatAnnotations(groups) {
  const out = [];
  for (const { job, list: all } of groups) {
    const list = all.filter((a) => LEVEL[a.annotation_level]);
    if (!list.length) continue;
    out.push({ text: `▸ annotations · ${job}`, sgr: '1' });
    for (const a of list) {
      const [mark, sgr] = LEVEL[a.annotation_level];
      const where = a.path && a.path !== '.github' ? `${a.path}:${a.start_line} ` : '';
      const [first, ...rest] = [a.title, a.message].filter(Boolean).join(': ').split('\n');
      out.push({ text: `${mark} ${where}${first}`, sgr });
      for (const l of rest) out.push({ text: `  ${l}`, sgr: sgr === '31' ? null : sgr });
    }
  }
  if (out.length) out.push({ text: '', sgr: null });
  return out;
}

export function wrapLines(lines, w) {
  const out = [];
  const cw = Math.max(1, w);
  lines.forEach(({ text, sgr }, src) => {
    const chars = [...text];
    if (!chars.length) {
      out.push({ text: '', sgr, src, off: 0 });
      return;
    }
    for (let i = 0; i < chars.length; i += cw) out.push({ text: chars.slice(i, i + cw).join(''), sgr, src, off: i });
  });
  return out;
}

const MATCH_SGR = '7';
const CURRENT_SGR = '1;30;43';

// A wrapped log row as segments, with the query's matches inside it highlighted.
export function logRowSegments(row, srcText, query, current) {
  const spans = matchSpans(srcText, query);
  if (!spans.length) return [[row.text, row.sgr]];
  const chars = [...row.text];
  const end = row.off + chars.length;
  const segs = [];
  let at = row.off;
  for (const [a, b] of spans) {
    if (b <= row.off || a >= end) continue;
    const s0 = Math.max(a, row.off);
    const s1 = Math.min(b, end);
    if (s0 > at) segs.push([chars.slice(at - row.off, s0 - row.off).join(''), row.sgr]);
    segs.push([chars.slice(s0 - row.off, s1 - row.off).join(''), current ? CURRENT_SGR : MATCH_SGR]);
    at = s1;
  }
  if (at < end) segs.push([chars.slice(at - row.off).join(''), row.sgr]);
  return segs;
}

const REVIEW = { APPROVED: ['approved', '32'], CHANGES_REQUESTED: ['changes requested', '31'], REVIEW_REQUIRED: ['review required', '33'] };
const MERGE = { DIRTY: ['conflicts', '31'], BEHIND: ['behind base', '33'], BLOCKED: ['blocked', '33'] };

// Header segments for the branch's PR (prSummary shape); [] without one.
export function prSegments(pr) {
  if (!pr) return [];
  const segs = [['  ', null], [`#${pr.number}`, '1;36']];
  const add = (text, sgr) => segs.push([' · ', '2'], [text, sgr]);
  if (pr.state === 'MERGED') add('merged', '35');
  else if (pr.state === 'CLOSED') add('closed', '2');
  else {
    if (pr.draft) add('draft', '2');
    if (REVIEW[pr.review]) add(...REVIEW[pr.review]);
    if (MERGE[pr.merge]) add(...MERGE[pr.merge]);
    if (pr.external.failing) add(`${pr.external.failing} external ✗`, '31');
    if (pr.external.pending) add(`${pr.external.pending} external ◌`, '33');
  }
  return segs;
}

// When the header doesn't fit, the commit sha goes first, then the repo owner if that makes it fit.
function headerLine(h, w) {
  if (!h) return fit([['GH Actions', '1']], w);
  const build = (sha, owner) => {
    const segs = [[owner ? `${h.owner}/${h.repo}` : h.repo, '1'], [' · ', '2'], [h.branch ?? '(detached)', '35']];
    if (sha && h.headShort) segs.push([' · ', '2'], [h.headShort, '2']);
    if (h.pushed) segs.push(['  ↑ pushed, waiting for run', '36']);
    else if (h.ahead) segs.push([`  ↑${h.ahead} unpushed`, '33']);
    segs.push(...prSegments(h.pr));
    if (h.base) segs.push(['  ', null], [h.base.name, '2'], [' ', null], COMMIT_GLYPH[h.base.status] ?? ['?', '2']);
    return segs;
  };
  const fits = (segs) => segs.reduce((n, [t]) => n + width(t), 0) <= w;
  const segs = [build(true, true), build(false, true), build(false, false)].find(fits) ?? build(false, true);
  return fit(segs, w);
}

const SEP = ' · ';
const BAND_GUTTER = 6;

const entryWidth = ([k, l]) => width(k) + 1 + width(l);

// Segments cut to at most n columns (last one ends in "…" when cut), unpadded.
function clip(segs, n) {
  const out = [];
  let used = 0;
  for (const [t, sgr] of segs) {
    const chars = [...t];
    if (used + chars.length <= n) {
      out.push([t, sgr]);
      used += chars.length;
      continue;
    }
    if (n - used > 0) out.push([[...chars.slice(0, Math.max(0, n - used - 1)), '…'].join(''), sgr]);
    break;
  }
  return out;
}
const entrySegs = ([k, l]) => [[k, '1'], [` ${l}`, '2']];

function joinEntries(entries) {
  const segs = [];
  entries.forEach((e, i) => {
    if (i) segs.push([SEP, '2']);
    segs.push(...entrySegs(e));
  });
  return segs;
}

function statusSegs(s) {
  const segs = [];
  if (s.stale) segs.push(['⚠ stale ', '33']);
  if (s.loading) segs.push(['… ', '2']);
  if (s.message) segs.push([s.message, s.messageSgr ?? '2']);
  else if (s.updatedAt) segs.push([`updated ${s.updatedAt}`, '2']);
  return segs;
}

/**
 * Footer rows. Row 1: status on the left, the selected row's actions on the right (as many as fit)
 * and a `?`. With `?` open, labeled bands follow: `do` (actions row 1 had no room for), then the
 * view's own bands, each wrapped to the width under a dim gutter label.
 * model: { status, confirm, footer: { actions: [[key, label]], bands: [[name, [[key, label]]]], open } }
 */
export function footerLines(model, w) {
  if (model.confirm) return [fit([[`${model.confirm} `, '1;33'], ['[y/n]', '33']], w)];
  if (model.input) return [fit([[model.input.prompt, '1;36'], [model.input.value, null], [' ', '7']], w)];
  const f = model.footer ?? { actions: [], bands: [], open: false };
  const status = statusSegs(model.status ?? {});
  const statusW = status.reduce((n, [t]) => n + width(t), 0);
  const help = '  ?';
  const budget = w - width(help) - Math.min(statusW, 24) - 2;
  const shown = [];
  let used = 0;
  let i = 0;
  for (; i < f.actions.length; i++) {
    const add = (shown.length ? SEP.length : 0) + entryWidth(f.actions[i]);
    if (used + add > budget) break;
    shown.push(f.actions[i]);
    used += add;
  }
  const overflow = f.actions.slice(i);
  const statusRoom = Math.max(0, w - used - width(help) - 1);
  const row1 = clip(status, statusRoom);
  const leftW = row1.reduce((n, [t]) => n + width(t), 0);
  row1.push([' '.repeat(Math.max(1, w - leftW - used - width(help))), null], ...joinEntries(shown), [help, f.open ? '1;7;36' : '1;36']);
  const lines = [fit(row1, w)];
  if (!f.open) return lines;
  const bands = [['do', overflow], ...(f.bands ?? [])].filter(([, entries]) => entries.length);
  for (const [name, entries] of bands) {
    let row = [];
    let rowW = 0;
    let gutter = name;
    const flush = () => {
      lines.push(fit([[gutter.padEnd(BAND_GUTTER), '2'], ...joinEntries(row)], w));
      gutter = '';
      row = [];
      rowW = 0;
    };
    for (const e of entries) {
      const add = (row.length ? SEP.length : 0) + entryWidth(e);
      if (row.length && BAND_GUTTER + rowW + add > w) flush();
      rowW += (row.length ? SEP.length : 0) + entryWidth(e);
      row.push(e);
    }
    if (row.length) flush();
  }
  return lines;
}

// Footer rows that fit: at least 3 body rows stay under the header.
function footerFor(model, w, h) {
  return footerLines(model, w).slice(0, Math.max(1, h - 4));
}

export function footerHeight(model, cols, rows) {
  return footerFor(model, Math.max(10, cols), Math.max(3, rows)).length;
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
 * model: { header, view: 'list'|'log'|'picker', items, selected, top, log: { title, lines, top, query?, cursor? },
 *          picker: { title, items, selected, top, empty }, status, empty, confirm, footer }
 */
export function renderPane(model, cols, rows) {
  const w = Math.max(10, cols);
  const h = Math.max(3, rows);
  const lines = [headerLine(model.header, w)];
  const footer = footerFor(model, w, h);
  const bodyH = h - 1 - footer.length;
  if (model.view === 'log' && model.log) {
    const title = fit([[model.log.title, '1;4']], w);
    const wrapped = wrapLines(model.log.lines, w);
    const top = clampTop(model.log.top, wrapped.length, bodyH - 1);
    lines.push(title);
    const { query, cursor } = model.log;
    for (let i = 0; i < bodyH - 1; i++) {
      const l = wrapped[top + i];
      if (!l) lines.push(' '.repeat(w));
      else if (query) lines.push(fit(logRowSegments(l, model.log.lines[l.src].text, query, l.src === cursor), w));
      else lines.push(fit([[l.text, l.src === cursor ? '1;7;31' : l.sgr]], w));
    }
  } else if (model.view === 'picker' && model.picker) {
    const p = model.picker;
    lines.push(fit([[p.title, '1;4']], w));
    lines.push(...listLines(p.items, p.selected, p.top, p.empty, w, bodyH - 1));
  } else {
    lines.push(...listLines(model.items ?? [], model.selected, model.top, model.empty ?? 'no runs for this branch', w, bodyH));
  }
  lines.push(...footer);
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

const COMMIT_GLYPH = { running: ['◌', '33'], failure: ['✗', '31'], success: ['✓', '32'] };

function runTiming(r, now) {
  const start = r.startedAt || r.createdAt;
  return r.status === 'completed' ? span(start, r.updatedAt, now) : fmtDuration(now - Date.parse(start));
}

// Last row when older commits exist; `more` is its label.
const moreRow = (label) => ({ key: 'more', type: 'more', depth: 0, glyph: ['▾', '36'], label, dim: true });

// Job and step rows under a run, starting at `depth`.
function jobRows(items, { run: r, commit, depth, jobsByRun, expandedJobs, now }) {
  const entry = jobsByRun.get(r.databaseId);
  if (!entry || entry.error) {
    const label = entry ? `⚠ ${entry.error}` : 'loading jobs…';
    items.push({ key: `note:${r.databaseId}`, type: 'note', commit, run: r, depth, label, dim: true });
    return;
  }
  for (const j of entry.jobs) {
    const jopen = expandedJobs.has(j.databaseId);
    const steps = j.steps ?? [];
    items.push({
      key: `job:${j.databaseId}`,
      type: 'job',
      commit,
      run: r,
      job: j,
      depth,
      expandable: steps.length > 0,
      expanded: jopen,
      glyph: glyph(j.status, j.conclusion),
      label: j.name,
      meta: span(j.startedAt, j.completedAt, now),
    });
    if (!jopen) continue;
    for (const st of steps) {
      items.push({
        key: `step:${j.databaseId}:${st.number}`,
        type: 'step',
        commit,
        run: r,
        job: j,
        step: st,
        depth: depth + 1,
        glyph: glyph(st.status, st.conclusion),
        label: `${st.number}. ${st.name}`,
        meta: span(st.startedAt, st.completedAt, now),
        dim: st.conclusion === 'skipped',
      });
    }
  }
}

/**
 * Flat layout: one row per run (newest first) → jobs → steps, for the runs of the newest
 * `commitLimit` commits, so both layouts cover the same runs.
 */
export function buildFlatItems({ runs, jobsByRun, expandedRuns, expandedJobs, head, now = Date.now(), commitLimit = Infinity, subjects = new Map(), more = null }) {
  const items = [];
  const commits = groupByCommit(runs).slice(0, commitLimit);
  const shown = commits.flatMap((c) => c.runs.map((r) => ({ r, commit: c })));
  shown.sort((a, b) => runStart(b.r) - runStart(a.r) || b.r.databaseId - a.r.databaseId);
  for (const { r, commit } of shown) {
    const open = expandedRuns.has(r.databaseId);
    const sha = (r.headSha ?? '').slice(0, 7) + (r.headSha === head ? ' (HEAD)' : '');
    const age = r.status === 'completed' ? `${fmtDuration(now - Date.parse(r.updatedAt))} ago` : null;
    items.push({
      key: `run:${r.databaseId}`,
      type: 'run',
      commit,
      run: r,
      depth: 0,
      expandable: true,
      expanded: open,
      glyph: glyph(r.status, r.conclusion),
      label: `${r.workflowName} · ${r.event === 'push' ? r.displayTitle : (subjects.get(r.headSha) ?? r.displayTitle)}`,
      meta: [r.event, sha, r.attempt > 1 ? `attempt ${r.attempt}` : null, runTiming(r, now), age].filter(Boolean).join(' · '),
    });
    if (open) jobRows(items, { run: r, commit, depth: 1, jobsByRun, expandedJobs, now });
  }
  if (more) items.push(moreRow(more));
  return items;
}

/**
 * Flatten commits → runs → jobs → steps into pane rows, newest `commitLimit` commits.
 * jobsByRun: Map runId → { jobs } | { error }; expandedCommits: Set of shas; expandedRuns/expandedJobs: Sets of ids.
 * subjects: Map sha → commit subject from the local clone, preferred over the runs' titles.
 * more: label of a trailing "load more" row, or null when there is nothing older.
 */
export function buildItems({ runs, jobsByRun, expandedCommits, expandedRuns, expandedJobs, head, now = Date.now(), commitLimit = Infinity, subjects = new Map(), more = null }) {
  const items = [];
  for (const commit of groupByCommit(runs).slice(0, commitLimit)) {
    const copen = expandedCommits.has(commit.sha);
    const status = commitStatus(commit.runs);
    const newest = commit.runs[0];
    const when =
      status === 'running'
        ? fmtDuration(now - Math.min(...commit.runs.filter((r) => r.status !== 'completed').map(runStart)))
        : `${fmtDuration(now - Math.max(...commit.runs.map((r) => Date.parse(r.updatedAt || r.createdAt))))} ago`;
    items.push({
      key: `commit:${commit.sha}`,
      type: 'commit',
      commit,
      depth: 0,
      expandable: true,
      expanded: copen,
      glyph: COMMIT_GLYPH[status],
      label: `${commit.sha.slice(0, 7)}${commit.sha === head ? ' (HEAD)' : ''} · ${subjects.get(commit.sha) ?? commit.title}`,
      meta: [newest.event, when].join(' · '),
    });
    if (!copen) continue;
    for (const r of commit.runs) {
      const open = expandedRuns.has(r.databaseId);
      items.push({
        key: `run:${r.databaseId}`,
        type: 'run',
        commit,
        run: r,
        depth: 1,
        expandable: true,
        expanded: open,
        glyph: glyph(r.status, r.conclusion),
        label: r.workflowName,
        meta: [r.event === 'push' ? null : r.event, r.attempt > 1 ? `attempt ${r.attempt}` : null, runTiming(r, now)].filter(Boolean).join(' · '),
      });
      if (open) jobRows(items, { run: r, commit, depth: 2, jobsByRun, expandedJobs, now });
    }
  }
  if (more) items.push(moreRow(more));
  return items;
}
