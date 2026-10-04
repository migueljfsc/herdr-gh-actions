import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from '../lib/keys.js';

const acts = (s) => parseKeys(s).map((a) => a.action);

test('letters and control keys', () => {
  assert.deepEqual(acts('jkqlfoRrgG'), ['down', 'up', 'quit', 'log', 'failed', 'open', 'refresh', 'refresh', 'top', 'bottom']);
  assert.deepEqual(acts('\r\x03\x1b'), ['enter', 'quit', 'back']);
});

test('action keys', () => {
  assert.deepEqual(acts('xXcwyn'), ['rerun-failed', 'rerun-all', 'cancel', 'workflows', 'yes', 'next']);
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

test('log search keys', () => {
  assert.deepEqual(acts('/nNeE'), ['search', 'next', 'prev', 'error-next', 'error-prev']);
});

test('text mode: characters, editing keys, arrows; normal keys again once it ends', async () => {
  const { keyStream } = await import('../lib/keys.js');
  let typing = false;
  const out = [];
  for (const k of keyStream('/ab\x7fé\x1b[D\x15\rq', () => typing)) {
    out.push(k.ch ?? k.action);
    if (k.action === 'search') typing = true;
    if (k.action === 'enter') typing = false;
  }
  assert.deepEqual(out, ['search', 'a', 'b', 'backspace', 'é', 'left', 'clear', 'enter', 'quit']);
  assert.deepEqual(parseKeys('\x1bq', () => true).map((k) => k.action), ['back', 'char']);
});

test('? and v keys', () => {
  assert.deepEqual(acts('?vm'), ['keys', 'layout', 'more']);
});

test('hintsFor offers only the actions that apply to the selected row', async () => {
  const { hintsFor, bandsFor } = await import('../lib/keys.js');
  const keys = (h) => h.map(([k]) => k).join(' ');
  const done = { databaseId: 1, status: 'completed', conclusion: 'failure', workflowName: 'ci', displayTitle: 't', headSha: 'a' };
  const busy = { ...done, status: 'in_progress', conclusion: null };
  assert.equal(keys(hintsFor('list', { type: 'run', run: done, expanded: false })), '↵ l f x X s o');
  assert.equal(keys(hintsFor('list', { type: 'run', run: busy, expanded: true })), '↵ l f c s o');
  assert.equal(keys(hintsFor('list', { type: 'commit', commit: { sha: 'abcdef1', runs: [done] }, expanded: true })), '↵ x X o');
  assert.equal(keys(hintsFor('list', { type: 'step' })), '↵ o');
  assert.deepEqual(hintsFor('list', null), []);
  assert.equal(keys(hintsFor('picker', null)), '↵ esc');
  assert.deepEqual(bandsFor('list', 'flat')[0], ['view', [['v', 'group by commit'], ['m', 'more commits'], ['w', 'run workflow'], ['R', 'refresh']]]);
  assert.equal(keys(hintsFor('list', { type: 'more' })), '↵');
  assert.deepEqual(bandsFor('log', 'commit').map(([n]) => n), ['go']);
});
