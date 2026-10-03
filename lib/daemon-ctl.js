import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, statSync, renameSync, rmSync, lstatSync, readlinkSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPath } from './exec.js';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DAEMON_PATH = join(PLUGIN_ROOT, 'bin', 'daemon.js');
const LOG_MAX = 256 * 1024;

export const pidFile = (dir) => join(dir, 'daemon.pid');
export const logFile = (dir) => join(dir, 'daemon.log');
export const infoFile = (dir) => join(dir, 'daemon.json');

// The code a process runs: the plugin version and the (resolved) plugin root it was started from.
export function codeIdentity(root = PLUGIN_ROOT) {
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {}
  let resolved = root;
  try {
    resolved = realpathSync(root);
  } catch {}
  return { version, root: resolved };
}

// Written by the daemon at start, so entry points can tell which code the running poller is on.
export function writeDaemonInfo(dir, pid, identity = codeIdentity()) {
  writeFileSync(infoFile(dir), JSON.stringify({ pid, ...identity }));
}

export function readDaemonInfo(dir) {
  try {
    return JSON.parse(readFileSync(infoFile(dir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What to do with the session's poller: start (none running), restart (running other code: another
 * version or plugin root, or a poller from before daemon.json existed), or keep.
 */
export function planDaemon({ pid, recorded, current }) {
  if (!pid) return 'start';
  if (!recorded || recorded.pid !== pid || recorded.version !== current.version || recorded.root !== current.root) return 'restart';
  return 'keep';
}

export function readPid(dir) {
  try {
    const pid = Number(readFileSync(pidFile(dir), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Guards against pid reuse: only signal a live process that is running our daemon.js.
export function isDaemon(pid) {
  if (!pid) return false;
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', env: withPath() });
    return cmd.includes('daemon.js') && cmd.includes('node');
  } catch {
    return false;
  }
}

export function runningDaemon(dir) {
  const pid = readPid(dir);
  return isDaemon(pid) ? pid : null;
}

function rotateLog(dir) {
  try {
    if (statSync(logFile(dir)).size > LOG_MAX) renameSync(logFile(dir), `${logFile(dir)}.1`);
  } catch {}
}

export async function stopDaemon(dir, { waitMs = 3000 } = {}) {
  const pid = runningDaemon(dir);
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until && isAlive(pid)) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  return true;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startDaemon(dir, env = process.env) {
  rotateLog(dir);
  const fd = openSync(logFile(dir), 'a');
  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: withPath(env),
    cwd: dir,
  });
  closeSync(fd);
  writeFileSync(pidFile(dir), String(child.pid));
  child.unref();
  return child.pid;
}

export function clearPid(dir, pid) {
  if (readPid(dir) === pid) rmSync(pidFile(dir), { force: true });
}

/**
 * Make sure the session's poller runs this code: start it if missing, restart it if it runs other
 * code (after a plugin update) when `restart` is allowed, else keep it and optionally wake it for an
 * immediate tick. → { action: started | restarted | signalled | kept, pid, from?, to? }
 */
export async function ensureDaemon(dir, { env = process.env, signal = false, restart = true } = {}) {
  const pid = runningDaemon(dir);
  const recorded = readDaemonInfo(dir);
  const current = codeIdentity();
  let plan = planDaemon({ pid, recorded, current });
  if (plan === 'restart' && !restart) plan = 'keep';
  if (plan === 'start') return { action: 'started', pid: startDaemon(dir, env) };
  if (plan === 'restart') {
    await stopDaemon(dir);
    return { action: 'restarted', pid: startDaemon(dir, env), from: recorded?.version ?? 'unknown', to: current.version };
  }
  if (signal) process.kill(pid, 'SIGUSR1');
  return { action: signal ? 'signalled' : 'kept', pid };
}

// Keep ~/.local/bin/herdr-gh pointing at this plugin root's launcher. Best effort: only when the dir
// exists, and never replaces anything but a symlink.
export function linkLauncher(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const binDir = join(homedir(), '.local', 'bin');
  const link = join(binDir, 'herdr-gh');
  const target = join(root, 'bin', 'herdr-gh');
  try {
    if (!statSync(binDir).isDirectory()) return null;
    let st = null;
    try {
      st = lstatSync(link);
    } catch {}
    if (st && !st.isSymbolicLink()) return null;
    if (st && readlinkSync(link) === target) return link;
    if (st) unlinkSync(link);
    symlinkSync(target, link);
    return link;
  } catch {
    return null;
  }
}
