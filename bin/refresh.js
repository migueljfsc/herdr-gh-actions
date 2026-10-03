import { sessionDir } from '../lib/session.js';
import { refreshDaemon, linkLauncher } from '../lib/daemon-ctl.js';

linkLauncher(process.env.HERDR_PLUGIN_ROOT || undefined);

const quiet = process.argv.includes('--quiet');
const { pid, started } = refreshDaemon(sessionDir());
if (!quiet) console.log(`gh-actions: ${started ? 'started daemon' : 'refresh sent to daemon'} (pid ${pid})`);
