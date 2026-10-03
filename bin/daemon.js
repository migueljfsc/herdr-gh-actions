import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir, writeJsonAtomic } from '../lib/session.js';
import { pidFile, readPid, clearPid, writeDaemonInfo } from '../lib/daemon-ctl.js';
import { loadConfig, configDir } from '../lib/config.js';
import { createHerdr } from '../lib/herdr.js';
import { createGit } from '../lib/git.js';
import { createGh } from '../lib/gh.js';
import { createPoller } from '../lib/poller.js';

const MAX_HERDR_FAILURES = 5;

const dir = sessionDir();
const socket = process.env.HERDR_SOCKET_PATH;
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

writeFileSync(pidFile(dir), String(process.pid));
writeDaemonInfo(dir, process.pid);

const { config, warnings } = loadConfig(configDir());
warnings.forEach((w) => log(w));

const herdr = createHerdr();
const poller = createPoller({ herdr, git: createGit(), gh: createGh({ accounts: config.accounts }), config, log });

let wake = null;
let force = true;
let stopping = false;

process.on('SIGUSR1', () => {
  force = true;
  wake?.();
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${signal})`);
  await poller.clearAll();
  clearPid(dir, process.pid);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });
}

log(`started pid=${process.pid} socket=${socket}`);
let failures = 0;
while (!stopping) {
  if (readPid(dir) !== process.pid) {
    log('pid file taken over by another daemon; exiting');
    process.exit(0);
  }
  if (socket && !existsSync(socket)) {
    log('herdr socket gone; exiting');
    clearPid(dir, process.pid);
    process.exit(0);
  }
  let intervalMs = config.poll_seconds * 1000;
  const f = force;
  force = false;
  try {
    const r = await poller.tick({ force: f });
    intervalMs = r.intervalMs;
    failures = 0;
    writeJsonAtomic(join(dir, 'status.json'), r.snapshot);
  } catch (e) {
    failures += 1;
    log(`tick failed (${failures}/${MAX_HERDR_FAILURES}): ${e.message}`);
    if (failures >= MAX_HERDR_FAILURES) {
      log('herdr unreachable; exiting');
      clearPid(dir, process.pid);
      process.exit(1);
    }
  }
  if (!force) await sleep(intervalMs);
}
