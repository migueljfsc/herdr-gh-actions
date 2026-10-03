import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PLUGIN_ID = 'migueljfsc.gh-actions';

// STATE_DIR is shared by every herdr session; per-session files live under a socket-path hash.
export function sessionKey(socketPath) {
  return createHash('sha1').update(String(socketPath || 'default')).digest('hex').slice(0, 10);
}

export function stateRoot(env = process.env) {
  return env.HERDR_PLUGIN_STATE_DIR || join(homedir(), '.local', 'state', 'herdr', 'plugins', env.HERDR_PLUGIN_ID || PLUGIN_ID);
}

export function sessionDir(env = process.env) {
  const dir = join(stateRoot(env), 'sessions', sessionKey(env.HERDR_SOCKET_PATH));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
