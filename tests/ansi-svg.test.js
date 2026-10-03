import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnsi, toSvg } from '../scripts/ansi-svg.js';

test('parseAnsi: 16 and 256 colours, bold, dim, inverse, resets, CRLF lines', () => {
  const lines = parseAnsi('\x1b[1mA\x1b[0m\x1b[38;5;2m✓\x1b[0m\x1b[2;31mx\x1b[0m\r\n\x1b[7mS\x1b[0mz');
  assert.equal(lines.length, 2);
  const [a, check, x] = lines[0];
  assert.deepEqual([a.ch, a.bold, a.fg], ['A', true, null]);
  assert.deepEqual([check.ch, check.fg], ['✓', '#3fb950']);
  assert.deepEqual([x.ch, x.dim, x.fg], ['x', true, '#ff7b72']);
  const [s, z] = lines[1];
  assert.equal(s.bg, '#c9d1d9');
  assert.equal(s.fg, '#0d1117');
  assert.equal(z.bg, null);
});

test('toSvg: collapses blank bands to one blank row', () => {
  const svg = toSvg(parseAnsi('top\n\n\n\n\nstatus\n'));
  const ys = [...svg.matchAll(/<text x="[\d.]+" y="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(ys.length, 2);
  assert.equal(ys[1] - ys[0], 2 * Math.round(14 * 1.45));
});

test('toSvg: escapes text, crops trailing blank columns and rows', () => {
  const svg = toSvg(parseAnsi('a <b> & c      \n   \n'), { title: 'T' });
  assert.match(svg, /a &lt;b&gt; &amp; c/);
  assert.match(svg, />T</);
  assert.equal((svg.match(/xml:space/g) ?? []).length, 1);
});
