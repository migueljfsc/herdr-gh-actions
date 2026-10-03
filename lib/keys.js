const SEQ = new Map([
  ['\x1b[A', 'up'],
  ['\x1bOA', 'up'],
  ['\x1b[B', 'down'],
  ['\x1bOB', 'down'],
  ['\x1b[5~', 'pageup'],
  ['\x1b[6~', 'pagedown'],
  ['\x1b[H', 'top'],
  ['\x1b[1~', 'top'],
  ['\x1b[F', 'bottom'],
  ['\x1b[4~', 'bottom'],
  ['\x1b[C', 'enter'],
  ['\x1b[D', 'back'],
]);

const CHAR = new Map([
  ['j', 'down'],
  ['k', 'up'],
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['l', 'log'],
  ['f', 'failed'],
  ['o', 'open'],
  ['R', 'refresh'],
  ['r', 'refresh'],
  ['q', 'quit'],
  ['\x03', 'quit'],
  ['\x1b', 'back'],
  ['\x7f', 'back'],
  ['g', 'top'],
  ['G', 'bottom'],
  [' ', 'pagedown'],
  ['b', 'pageup'],
  ['\x04', 'pagedown'],
  ['\x15', 'pageup'],
]);

const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/** Parse a raw stdin chunk into actions: { action, x?, y? }. Unknown input is dropped. */
export function parseKeys(chunk) {
  const out = [];
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    const m = MOUSE_RE.exec(rest);
    if (m) {
      const [all, b, x, y, kind] = m;
      const btn = Number(b);
      if (kind === 'M') {
        if (btn === 64) out.push({ action: 'up' });
        else if (btn === 65) out.push({ action: 'down' });
        else if (btn === 0) out.push({ action: 'click', x: Number(x), y: Number(y) });
      }
      i += all.length;
      continue;
    }
    let matched = false;
    for (const [seq, action] of SEQ) {
      if (rest.startsWith(seq)) {
        out.push({ action });
        i += seq.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (rest[0] === '\x1b' && rest.length > 1 && (rest[1] === '[' || rest[1] === 'O')) {
      const csi = /^\x1b[[O][0-9;?]*[ -/]*[@-~]/.exec(rest);
      i += csi ? csi[0].length : 2;
      continue;
    }
    const action = CHAR.get(rest[0]);
    if (action) out.push({ action });
    i += 1;
  }
  return out;
}
