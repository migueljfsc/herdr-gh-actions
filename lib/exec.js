import { execFile } from 'node:child_process';

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
