import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, loadConfig, accountFor, DEFAULTS } from '../lib/config.js';

test('defaults when absent', () => {
  const { config, warnings } = loadConfig('/nope', () => {
    throw new Error('ENOENT');
  });
  assert.deepEqual(config, { ...DEFAULTS, accounts: {} });
  assert.deepEqual(warnings, []);
});

test('invalid JSON → defaults + warning', () => {
  const { config, warnings } = loadConfig('/x', () => '{nope');
  assert.equal(config.poll_seconds, 10);
  assert.match(warnings[0], /invalid JSON/);
});

test('valid values are taken', () => {
  const { config, warnings } = normalize({ poll_seconds: 5, idle_poll_seconds: 120, notify: 'all', runs_per_branch: 3, accounts: { A: 'a' } });
  assert.deepEqual(warnings, []);
  assert.equal(config.poll_seconds, 5);
  assert.equal(config.idle_poll_seconds, 120);
  assert.equal(config.notify, 'all');
  assert.equal(config.runs_per_branch, 3);
  assert.deepEqual(config.accounts, { A: 'a' });
});

test('invalid values fall back with warnings', () => {
  const { config, warnings } = normalize({ poll_seconds: 1, notify: 'loud', runs_per_branch: 'x', accounts: [] });
  assert.equal(config.poll_seconds, 10);
  assert.equal(config.notify, 'fail');
  assert.equal(config.runs_per_branch, 20);
  assert.equal(config.commits_per_branch, 10);
  assert.deepEqual(config.accounts, {});
  assert.equal(warnings.length, 4);
});

test('idle interval never below poll interval', () => {
  assert.equal(normalize({ poll_seconds: 30, idle_poll_seconds: 10 }).config.idle_poll_seconds, 30);
});

test('accountFor: exact (case-insensitive) beats *, null without match', () => {
  const acc = { WorkOrg: 'work', '*': 'me' };
  assert.equal(accountFor(acc, 'workorg'), 'work');
  assert.equal(accountFor(acc, 'other'), 'me');
  assert.equal(accountFor({ X: 'x' }, 'other'), null);
});
