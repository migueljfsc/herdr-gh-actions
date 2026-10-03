import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, statSync, renameSync, rmSync, lstatSync, readlinkSync, unlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPath } from './exec.js';

export const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'daemon.js');
const LOG_MAX = 256 * 1024;

export const pidFile = (dir) => join(dir, 'daemon.pid');
export const logFile = (dir) => join(dir, 'daemon.log');

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

// Wake the daemon for an immediate forced tick; start one if none is running.
export function refreshDaemon(dir, env = process.env) {
  const pid = runningDaemon(dir);
  if (pid) {
    process.kill(pid, 'SIGUSR1');
    return { pid, started: false };
  }
  return { pid: startDaemon(dir, env), started: true };
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
