import { sessionDir } from '../lib/session.js';
import { ensureDaemon, linkLauncher } from '../lib/daemon-ctl.js';

linkLauncher(process.env.HERDR_PLUGIN_ROOT || undefined);

const quiet = process.argv.includes('--quiet');
// Only a herdr-invoked refresh (the installed plugin) may replace a poller running other code.
const r = await ensureDaemon(sessionDir(), { signal: true, restart: Boolean(process.env.HERDR_PLUGIN_ROOT) });
const what = {
  started: 'started daemon',
  restarted: `restarted daemon on ${r.to} (was ${r.from})`,
  signalled: 'refresh sent to daemon',
}[r.action];
if (!quiet) console.log(`gh-actions: ${what} (pid ${r.pid})`);
