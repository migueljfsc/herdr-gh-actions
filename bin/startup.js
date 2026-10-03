import { sessionDir } from '../lib/session.js';
import { stopDaemon, startDaemon, linkLauncher } from '../lib/daemon-ctl.js';

linkLauncher(process.env.HERDR_PLUGIN_ROOT || undefined);

const dir = sessionDir();
const stopped = await stopDaemon(dir);
const pid = startDaemon(dir);
console.log(`gh-actions: daemon ${stopped ? 'restarted' : 'started'} (pid ${pid})`);
