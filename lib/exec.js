import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

// herdr runs plugin commands with a minimal PATH; make git/gh/ssh resolvable.
export function withPath(env = process.env) {
  const parts = (env.PATH || '').split(':').filter(Boolean);
  for (const p of EXTRA_PATH) if (!parts.includes(p)) parts.push(p);
  return { ...env, PATH: parts.join(':') };
}

// Never rejects: resolves { code, stdout, stderr }. code is null when the process could not start.
export function run(cmd, args, { env, cwd, timeout = 30000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { env: withPath(env ?? process.env), cwd, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === null ? err.message : '') });
      },
    );
    if (input != null) child.stdin.end(input);
  });
}

// Like run(), with stdout streamed into `file` (binary-safe) instead of returned.
export function runToFile(cmd, args, file, { env, timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    const out = createWriteStream(file);
    const child = spawn(cmd, args, { env: withPath(env ?? process.env), stdio: ['ignore', 'pipe', 'pipe'], timeout });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.pipe(out);
    child.on('error', (e) => resolve({ code: null, stdout: '', stderr: e.message }));
    child.on('close', (code) => out.end(() => resolve({ code, stdout: '', stderr })));
  });
}
