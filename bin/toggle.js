import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createHerdr } from '../lib/herdr.js';
import { createGit } from '../lib/git.js';
import { PLUGIN_ID, sessionDir } from '../lib/session.js';
import { ensureDaemon } from '../lib/daemon-ctl.js';

const herdr = createHerdr();
const git = createGit();

// Opening or closing the pane also moves a poller left on an older version (after an update) to this one.
if (process.env.HERDR_PLUGIN_ROOT) await ensureDaemon(sessionDir()).catch(() => {});
const pluginId = process.env.HERDR_PLUGIN_ID || PLUGIN_ID;

function fail(msg) {
  console.error(`gh-actions: ${msg}`);
  process.exit(1);
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

let ctx = {};
try {
  ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
} catch {}
const ws = ctx.workspace_id || process.env.HERDR_WORKSPACE_ID;
const tab = ctx.tab_id || process.env.HERDR_TAB_ID;
const focused = ctx.focused_pane_id || process.env.HERDR_PANE_ID;
if (!ws) fail('no workspace context (invoke from inside herdr)');

const panePath = real(join(process.env.HERDR_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'pane.js'));

// A GH Actions pane is any pane whose foreground process runs our pane.js; no state file needed.
async function isOurPane(id) {
  try {
    const info = await herdr.processInfo(id);
    return (info?.foreground_processes ?? []).some((p) => {
      const argv = p.argv ?? [];
      return !argv.includes('--inline') && argv.some((a) => a === panePath || real(a) === panePath);
    });
  } catch (e) {
    if (e.code === 'pane_not_found') return false;
    throw e;
  }
}

const panes = await herdr.paneList(ws).catch((e) => fail(`pane list failed: ${e.message}`));
const inTab = panes.filter((p) => !tab || p.tab_id === tab);
const ours = [];
await Promise.all(inTab.map(async (p) => (await isOurPane(p.pane_id)) && ours.push(p.pane_id)));

if (ours.length) {
  for (const id of ours) {
    await herdr.paneClose(id).catch((e) => {
      if (e.code !== 'pane_not_found') fail(`pane close ${id} failed: ${e.message}`);
    });
  }
  console.log(`gh-actions: closed ${ours.join(' ')}`);
  process.exit(0);
}

const target = inTab.find((p) => p.pane_id === focused) ?? inTab[0];
if (!target) fail(`no pane to attach to in ${ws}`);
const candidates = [target.foreground_cwd, target.cwd, ctx.focused_pane_cwd].filter(Boolean);
let cwd = null;
for (const c of candidates) {
  if ((cwd = await git.toplevel(c))) break;
}
if (!cwd) fail(`not a git repo: ${candidates[0] ?? '<no cwd>'}`);

const pane = await herdr
  .paneOpen({ plugin: pluginId, entrypoint: 'runs', targetPane: target.pane_id, cwd, focus: true })
  .catch((e) => fail(`pane open failed: ${e.message}`));
console.log(`gh-actions: opened ${pane?.pane_id ?? '?'} in ${ws}`);
