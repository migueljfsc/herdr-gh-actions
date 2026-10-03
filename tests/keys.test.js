import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from '../lib/keys.js';

const acts = (s) => parseKeys(s).map((a) => a.action);

test('letters and control keys', () => {
  assert.deepEqual(acts('jkqlfoRrgG'), ['down', 'up', 'quit', 'log', 'failed', 'open', 'refresh', 'refresh', 'top', 'bottom']);
  assert.deepEqual(acts('\r\x03\x1b'), ['enter', 'quit', 'back']);
});

test('action keys', () => {
  assert.deepEqual(acts('xXcwyn'), ['rerun-failed', 'rerun-all', 'cancel', 'workflows', 'yes', 'no']);
});

test('arrows and paging in one chunk', () => {
  assert.deepEqual(acts('\x1b[A\x1b[B\x1b[5~\x1b[6~\x1bOB'), ['up', 'down', 'pageup', 'pagedown', 'down']);
});

test('unknown escape sequences are skipped whole', () => {
  assert.deepEqual(acts('\x1b[1;5Cj'), ['down']);
});

test('SGR mouse: click, wheel, release ignored', () => {
  assert.deepEqual(parseKeys('\x1b[<0;12;5M\x1b[<0;12;5m'), [{ action: 'click', x: 12, y: 5 }]);
  assert.deepEqual(acts('\x1b[<64;1;1M\x1b[<65;1;1M'), ['up', 'down']);
});
