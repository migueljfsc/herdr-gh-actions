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
  assert.equal(config.pane_layout, 'commit');
  assert.deepEqual(config.accounts, {});
  assert.equal(warnings.length, 4);
});

test('pane_layout accepts commit or flat only', () => {
  assert.equal(normalize({ pane_layout: 'flat' }).config.pane_layout, 'flat');
  const bad = normalize({ pane_layout: 'tree' });
  assert.equal(bad.config.pane_layout, 'commit');
  assert.match(bad.warnings[0], /pane_layout/);
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

test('artifact_dir: non-empty string, ~ expands to home', async () => {
  const { expandHome } = await import('../lib/config.js');
  assert.equal(normalize({}).config.artifact_dir, '~/Downloads');
  assert.equal(normalize({ artifact_dir: ' /tmp/a ' }).config.artifact_dir, '/tmp/a');
  const bad = normalize({ artifact_dir: '' });
  assert.equal(bad.config.artifact_dir, '~/Downloads');
  assert.match(bad.warnings[0], /artifact_dir/);
  assert.equal(expandHome('~/Downloads', '/h'), '/h/Downloads');
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('/abs/~x', '/h'), '/abs/~x');
});

test('excerpt limits: defaults and ranges', () => {
  const d = normalize({}).config;
  assert.deepEqual([d.excerpt_max_bytes, d.excerpt_ttl_days, d.excerpt_keep], [1048576, 7, 20]);
  const ok = normalize({ excerpt_max_bytes: 4096, excerpt_ttl_days: 1, excerpt_keep: 5 });
  assert.deepEqual([ok.config.excerpt_max_bytes, ok.config.excerpt_ttl_days, ok.config.excerpt_keep, ok.warnings.length], [4096, 1, 5, 0]);
  const bad = normalize({ excerpt_max_bytes: 10, excerpt_ttl_days: 0, excerpt_keep: 1.5 });
  assert.deepEqual([bad.config.excerpt_max_bytes, bad.config.excerpt_ttl_days, bad.config.excerpt_keep, bad.warnings.length], [1048576, 7, 20, 3]);
});
