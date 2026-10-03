import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULTS = Object.freeze({
  poll_seconds: 10,
  idle_poll_seconds: 60,
  notify: 'fail',
  accounts: Object.freeze({}),
  runs_per_branch: 20,
  commits_per_branch: 10,
  pushed_grace_seconds: 300,
});

const NOTIFY = new Set(['fail', 'all', 'off']);

function intIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

export function normalize(raw) {
  const warnings = [];
  const cfg = { ...DEFAULTS, accounts: {} };
  if (raw == null) return { config: cfg, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('config.json: top level must be an object');
    return { config: cfg, warnings };
  }
  const ints = {
    poll_seconds: [3, 3600],
    idle_poll_seconds: [3, 86400],
    runs_per_branch: [1, 100],
    commits_per_branch: [1, 50],
    pushed_grace_seconds: [0, 86400],
  };
  for (const [k, [min, max]] of Object.entries(ints)) {
    if (!(k in raw)) continue;
    if (intIn(raw[k], min, max)) cfg[k] = raw[k];
    else warnings.push(`config.json: ${k} must be an integer in [${min}, ${max}]`);
  }
  if ('notify' in raw) {
    if (NOTIFY.has(raw.notify)) cfg.notify = raw.notify;
    else warnings.push('config.json: notify must be "fail", "all" or "off"');
  }
  if ('accounts' in raw) {
    const a = raw.accounts;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      for (const [owner, login] of Object.entries(a)) {
        if (typeof login === 'string' && login) cfg.accounts[owner] = login;
        else warnings.push(`config.json: accounts.${owner} must be a non-empty string`);
      }
    } else {
      warnings.push('config.json: accounts must be an object');
    }
  }
  if (cfg.idle_poll_seconds < cfg.poll_seconds) cfg.idle_poll_seconds = cfg.poll_seconds;
  return { config: cfg, warnings };
}

// Outside herdr's plugin env (e.g. the inline `herdr-gh` launcher) fall back to herdr's default location.
export function configDir(env = process.env) {
  return env.HERDR_PLUGIN_CONFIG_DIR || join(homedir(), '.config', 'herdr', 'plugins', 'config', env.HERDR_PLUGIN_ID || 'migueljfsc.gh-actions');
}

export function loadConfig(dir, read = readFileSync) {
  if (!dir) return normalize(null);
  let text;
  try {
    text = read(join(dir, 'config.json'), 'utf8');
  } catch {
    return normalize(null);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const r = normalize(null);
    r.warnings.push(`config.json: invalid JSON (${e.message})`);
    return r;
  }
  return normalize(raw);
}

// Repo owner → gh login. Owner match is case-insensitive; "*" is the fallback.
export function accountFor(accounts, owner) {
  const lc = String(owner).toLowerCase();
  for (const [k, v] of Object.entries(accounts)) if (k !== '*' && k.toLowerCase() === lc) return v;
  return accounts['*'] ?? null;
}
