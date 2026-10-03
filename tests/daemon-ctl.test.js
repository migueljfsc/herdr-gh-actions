import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDaemon, codeIdentity, writeDaemonInfo, readDaemonInfo } from '../lib/daemon-ctl.js';

const current = { version: '1.1.0', root: '/plugins/gh' };

test('planDaemon: start when none runs', () => {
  assert.equal(planDaemon({ pid: null, recorded: null, current }), 'start');
  assert.equal(planDaemon({ pid: null, recorded: { pid: 5, ...current }, current }), 'start');
});

test('planDaemon: keep a poller running this code', () => {
  assert.equal(planDaemon({ pid: 5, recorded: { pid: 5, ...current }, current }), 'keep');
});

test('planDaemon: restart a poller on another version, another root, or with no record', () => {
  assert.equal(planDaemon({ pid: 5, recorded: { pid: 5, version: '1.0.0', root: current.root }, current }), 'restart');
  assert.equal(planDaemon({ pid: 5, recorded: { pid: 5, version: current.version, root: '/dev/checkout' }, current }), 'restart');
  assert.equal(planDaemon({ pid: 5, recorded: null, current }), 'restart');
  assert.equal(planDaemon({ pid: 5, recorded: { pid: 4, ...current }, current }), 'restart');
});

test('codeIdentity reads the version and resolves the root; daemon info round-trips', () => {
  const base = mkdtempSync(join(tmpdir(), 'gha-'));
  try {
    const root = join(base, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.3.4' }));
    symlinkSync(root, join(base, 'link'));
    const id = codeIdentity(join(base, 'link'));
    assert.equal(id.version, '2.3.4');
    assert.equal(id.root, codeIdentity(root).root);
    assert.deepEqual(codeIdentity(join(base, 'missing')).version, null);
    writeDaemonInfo(base, 42, id);
    assert.deepEqual(readDaemonInfo(base), { pid: 42, ...id });
    assert.equal(readDaemonInfo(join(base, 'nope')), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
