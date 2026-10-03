#!/usr/bin/env node
// Render an ANSI terminal snapshot (e.g. `herdr pane read <pane> --ansi`) as a terminal-window SVG
// for the README. Usage: node scripts/ansi-svg.js <in.ansi> <out.svg> [title]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// GitHub-dark-ish 16-colour palette; index = ANSI colour number.
const PALETTE = [
  '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
  '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
];
const FG = '#c9d1d9';
const BG = '#0d1117';
const CHROME = '#161b22';

function xterm256(n) {
  if (n < 16) return PALETTE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

function applySgr(style, params) {
  const p = params.length ? params : [0];
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) Object.assign(style, { fg: null, bg: null, bold: false, dim: false, inverse: false, underline: false });
    else if (n === 1) style.bold = true;
    else if (n === 2) style.dim = true;
    else if (n === 4) style.underline = true;
    else if (n === 7) style.inverse = true;
    else if (n === 22) style.bold = style.dim = false;
    else if (n === 24) style.underline = false;
    else if (n === 27) style.inverse = false;
    else if (n >= 30 && n <= 37) style.fg = PALETTE[n - 30];
    else if (n >= 90 && n <= 97) style.fg = PALETTE[n - 90 + 8];
    else if (n >= 40 && n <= 47) style.bg = PALETTE[n - 40];
    else if (n >= 100 && n <= 107) style.bg = PALETTE[n - 100 + 8];
    else if (n === 39) style.fg = null;
    else if (n === 49) style.bg = null;
    else if ((n === 38 || n === 48) && p[i + 1] === 5) {
      style[n === 38 ? 'fg' : 'bg'] = xterm256(p[i + 2]);
      i += 2;
    } else if ((n === 38 || n === 48) && p[i + 1] === 2) {
      style[n === 38 ? 'fg' : 'bg'] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
      i += 4;
    }
  }
}

/** ANSI text → lines of cells [{ ch, fg, bg, bold, dim, underline }]. Inverse is resolved here. */
export function parseAnsi(text) {
  const lines = [];
  let cells = [];
  const style = { fg: null, bg: null, bold: false, dim: false, inverse: false, underline: false };
  const re = /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r?\n|[^\x1b\r\n]/gu;
  for (const m of text.matchAll(re)) {
    const tok = m[0];
    if (m[2]) {
      if (m[2] === 'm') applySgr(style, m[1] ? m[1].split(';').map(Number) : []);
      continue;
    }
    if (tok.startsWith('\x1b')) continue;
    if (tok === '\n' || tok === '\r\n') {
      lines.push(cells);
      cells = [];
      continue;
    }
    const fg = style.inverse ? style.bg ?? BG : style.fg;
    const bg = style.inverse ? style.fg ?? FG : style.bg;
    cells.push({ ch: tok, fg, bg, bold: style.bold, dim: style.dim, underline: style.underline });
  }
  if (cells.length) lines.push(cells);
  return lines;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const same = (a, b) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.underline === b.underline;

/** lines (from parseAnsi) → SVG string, cropped to the widest non-blank column. */
export function toSvg(lines, { title = '', fontSize = 14 } = {}) {
  const cw = fontSize * 0.6;
  const lh = Math.round(fontSize * 1.45);
  const pad = 16;
  const bar = 32;
  const lastCol = (cells) => {
    for (let i = cells.length - 1; i >= 0; i--) if (cells[i].ch.trim() || cells[i].bg) return i + 1;
    return 0;
  };
  while (lines.length && lastCol(lines[lines.length - 1]) === 0) lines = lines.slice(0, -1);
  // A pane taller than its content leaves a gap above the status line; keep one blank row of it.
  let gap = lines.length - 1;
  while (gap > 0 && lastCol(lines[gap - 1]) === 0) gap--;
  if (lines.length - 1 - gap > 1) lines = [...lines.slice(0, gap + 1), lines[lines.length - 1]];
  const cols = Math.max(20, ...lines.map(lastCol));
  const width = Math.ceil(cols * cw + pad * 2);
  const height = bar + lines.length * lh + pad * 2;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  out.push(`<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>`);
  out.push(`<path d="M0 10a10 10 0 0 1 10-10h${width - 20}a10 10 0 0 1 10 10v${bar - 10}h-${width}z" fill="${CHROME}"/>`);
  ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((c, i) => out.push(`<circle cx="${18 + i * 20}" cy="16" r="6" fill="${c}"/>`));
  if (title) out.push(`<text x="${width / 2}" y="21" fill="#8b949e" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" text-anchor="middle">${esc(title)}</text>`);
  out.push(`<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${fontSize}">`);
  lines.forEach((cells, row) => {
    const y = bar + pad + row * lh;
    const end = Math.min(cells.length, cols);
    // Backgrounds first, merged per colour so a highlighted row has no seams between styled runs.
    for (let i = 0; i < end; ) {
      let j = i + 1;
      while (j < end && cells[j].bg === cells[i].bg) j++;
      if (cells[i].bg) out.push(`<rect x="${(pad + i * cw).toFixed(1)}" y="${y}" width="${((j - i) * cw + 0.5).toFixed(1)}" height="${lh}" fill="${cells[i].bg}"/>`);
      i = j;
    }
    let i = 0;
    while (i < end) {
      let j = i + 1;
      while (j < end && same(cells[j], cells[i])) j++;
      const c = cells[i];
      const x = pad + i * cw;
      const text = cells.slice(i, j).map((k) => k.ch).join('');
      if (text.trim()) {
        const attrs = [`x="${x.toFixed(1)}"`, `y="${y + Math.round(lh * 0.72)}"`, `fill="${c.fg ?? FG}"`];
        if (c.bold) attrs.push('font-weight="bold"');
        if (c.dim) attrs.push('opacity="0.6"');
        if (c.underline) attrs.push('text-decoration="underline"');
        out.push(`<text ${attrs.join(' ')} xml:space="preserve" textLength="${((j - i) * cw).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`);
      }
      i = j;
    }
  });
  out.push('</g></svg>');
  return out.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output, title = ''] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node scripts/ansi-svg.js <in.ansi> <out.svg> [title]');
    process.exit(2);
  }
  writeFileSync(output, toSvg(parseAnsi(readFileSync(input, 'utf8')), { title }));
}
