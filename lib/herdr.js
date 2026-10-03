import { run } from './exec.js';

export class HerdrError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Failing herdr calls write {"error":{"code","message"}} to stderr.
function errorOf(r) {
  try {
    const e = JSON.parse(r.stderr).error;
    if (e) return new HerdrError(e.message ?? e.code, e.code);
  } catch {}
  return new HerdrError((r.stderr || r.stdout).trim().split('\n')[0] || `herdr exited ${r.code}`, null);
}

// `herdr <workspace|pane> report-metadata <id>`: set the token, or clear it when value is null.
export function metadataArgs(kind, id, { source, name, value, ttlMs, seq }) {
  const args = [kind, 'report-metadata', id, '--source', source];
  if (value == null) args.push('--clear-token', name);
  else args.push('--token', `${name}=${value}`);
  if (ttlMs != null && value != null) args.push('--ttl-ms', String(ttlMs));
  if (seq != null) args.push('--seq', String(seq));
  return args;
}

export function createHerdr({ exec = run, bin = process.env.HERDR_BIN_PATH || 'herdr', env } = {}) {
  async function call(args) {
    const r = await exec(bin, args, { env, timeout: 10000 });
    if (r.code !== 0) throw errorOf(r);
    const text = r.stdout.trim();
    if (!text) return null;
    try {
      return JSON.parse(text).result ?? null;
    } catch {
      return null;
    }
  }

  return {
    call,
    async workspaceList() {
      return (await call(['workspace', 'list']))?.workspaces ?? [];
    },
    async paneList(workspaceId) {
      return (await call(['pane', 'list', ...(workspaceId ? ['--workspace', workspaceId] : [])]))?.panes ?? [];
    },
    async processInfo(paneId) {
      return (await call(['pane', 'process-info', '--pane', paneId]))?.process_info ?? null;
    },
    reportToken(workspaceId, opts) {
      return call(metadataArgs('workspace', workspaceId, opts));
    },
    reportPaneToken(paneId, opts) {
      return call(metadataArgs('pane', paneId, opts));
    },
    notify(title, { body, sound = 'none' } = {}) {
      const args = ['notification', 'show', title, '--sound', sound];
      if (body) args.push('--body', body);
      return call(args);
    },
    async paneOpen({ plugin, entrypoint, targetPane, direction = 'right', cwd, focus = true }) {
      const args = ['plugin', 'pane', 'open', '--plugin', plugin, '--entrypoint', entrypoint, '--placement', 'split'];
      args.push('--target-pane', targetPane, '--direction', direction);
      if (cwd) args.push('--cwd', cwd);
      args.push(focus ? '--focus' : '--no-focus');
      return (await call(args))?.plugin_pane?.pane ?? null;
    },
    paneClose(paneId) {
      return call(['pane', 'close', paneId]);
    },
  };
}
