import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSpans, matchLines, errorLines, stepIndex } from '../lib/search.js';

test('matchSpans: smart case, non-overlapping, code points', () => {
  assert.deepEqual(matchSpans('Error: error ERROR', 'error'), [[0, 5], [7, 12], [13, 18]]);
  assert.deepEqual(matchSpans('Error: error ERROR', 'Error'), [[0, 5]]);
  assert.deepEqual(matchSpans('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(matchSpans('✗ fail', 'fail'), [[2, 6]]);
  assert.deepEqual(matchSpans('x', ''), []);
});

test('matchLines and errorLines give source line indices', () => {
  const lines = [{ text: 'ok', sgr: null }, { text: 'boom', sgr: '31' }, { text: 'Boom again', sgr: null }];
  assert.deepEqual(matchLines(lines, 'boom'), [1, 2]);
  assert.deepEqual(errorLines(lines), [1]);
});

test('stepIndex wraps both ways', () => {
  assert.equal(stepIndex([2, 5, 9], -1, 1), 2);
  assert.equal(stepIndex([2, 5, 9], 5, 1), 9);
  assert.equal(stepIndex([2, 5, 9], 9, 1), 2);
  assert.equal(stepIndex([2, 5, 9], 5, -1), 2);
  assert.equal(stepIndex([2, 5, 9], 2, -1), 9);
  assert.equal(stepIndex([], 0, 1), null);
});
