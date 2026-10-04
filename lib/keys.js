import { runAction, commitAction } from './state.js';

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
  ['x', 'rerun-failed'],
  ['X', 'rerun-all'],
  ['c', 'cancel'],
  ['w', 'workflows'],
  ['v', 'layout'],
  ['m', 'more'],
  ['?', 'keys'],
  ['y', 'yes'],
  ['n', 'next'],
  ['N', 'prev'],
  ['/', 'search'],
  ['e', 'error-next'],
  ['E', 'error-prev'],
  ['\x04', 'pagedown'],
  ['\x15', 'pageup'],
]);

const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

const TEXT_SEQ = new Map([
  ['\x1b[C', 'right'],
  ['\x1bOC', 'right'],
  ['\x1b[D', 'left'],
  ['\x1bOD', 'left'],
]);
const TEXT_CHAR = new Map([
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['\x7f', 'backspace'],
  ['\b', 'backspace'],
  ['\x15', 'clear'],
  ['\x03', 'back'],
]);

/**
 * Lazily parse a raw stdin chunk into actions: { action, x?, y?, ch? }. Unknown input is dropped.
 * text(): whether the pane is reading a line of text right now; it's asked per key, so a key that
 * opens a text prompt sends the rest of the chunk to it. Text mode yields { action: 'char', ch }.
 */
export function* keyStream(chunk, text = () => false) {
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    const m = MOUSE_RE.exec(rest);
    if (m) {
      const [all, b, x, y, kind] = m;
      const btn = Number(b);
      i += all.length;
      if (kind !== 'M' || text()) continue;
      if (btn === 64) yield { action: 'up' };
      else if (btn === 65) yield { action: 'down' };
      else if (btn === 0) yield { action: 'click', x: Number(x), y: Number(y) };
      continue;
    }
    const typing = text();
    let matched = null;
    for (const [seq, action] of typing ? TEXT_SEQ : SEQ) {
      if (rest.startsWith(seq)) {
        matched = [seq, action];
        break;
      }
    }
    if (matched) {
      i += matched[0].length;
      yield { action: matched[1] };
      continue;
    }
    if (rest[0] === '\x1b' && rest.length > 1 && (rest[1] === '[' || rest[1] === 'O')) {
      const csi = /^\x1b[[O][0-9;?]*[ -/]*[@-~]/.exec(rest);
      i += csi ? csi[0].length : 2;
      continue;
    }
    if (typing) {
      const ch = String.fromCodePoint(rest.codePointAt(0));
      i += ch.length;
      if (ch === '\x1b') yield { action: 'back' };
      else if (TEXT_CHAR.has(ch)) yield { action: TEXT_CHAR.get(ch) };
      else if (ch >= ' ') yield { action: 'char', ch };
      continue;
    }
    const action = CHAR.get(rest[0]);
    i += 1;
    if (action) yield { action };
  }
}

export function parseKeys(chunk, text) {
  return [...keyStream(chunk, text)];
}

/**
 * Footer hints for the selected row: [key, label] pairs, only for actions that apply right now.
 * view: list | log | picker; item: the selected pane row (or null).
 */
export function hintsFor(view, item) {
  if (view === 'log') return [['/', 'search'], ...(item?.query ? [['n/N', 'next/prev']] : []), ['e/E', 'errors'], ['R', 'reload'], ['o', 'open'], ['esc', 'back']];
  if (view === 'picker') return [['↵', 'run'], ['esc', 'back']];
  if (!item) return [];
  const ok = (check) => check.ok;
  switch (item.type) {
    case 'commit':
      return [
        ['↵', item.expanded ? 'collapse' : 'expand'],
        ...(ok(commitAction('rerun-failed', item.commit)) ? [['x', 'rerun failed']] : []),
        ...(ok(commitAction('rerun-all', item.commit)) ? [['X', 'rerun all']] : []),
        ...(ok(commitAction('cancel', item.commit)) ? [['c', 'cancel']] : []),
        ['o', 'open commit'],
      ];
    case 'run':
      return [
        ['↵', item.expanded ? 'collapse' : 'jobs'],
        ['l', 'log'],
        ['f', 'failed steps'],
        ...(ok(runAction('rerun-failed', item.run)) ? [['x', 'rerun failed']] : []),
        ...(ok(runAction('rerun-all', item.run)) ? [['X', 'rerun all']] : []),
        ...(ok(runAction('cancel', item.run)) ? [['c', 'cancel']] : []),
        ['o', 'open'],
      ];
    case 'job':
      return [['↵', item.expandable ? (item.expanded ? 'collapse' : 'steps') : 'log'], ['l', 'log'], ['f', 'failed steps'], ['o', 'open']];
    case 'step':
      return [['↵', 'log'], ['o', 'open']];
    case 'more':
      return [['↵', 'load more']];
    default:
      return [];
  }
}

// The `?` panel's bands beyond `do`: [name, [[key, label]]].
export function bandsFor(view, layout) {
  const go = [['j/k', 'move'], ['g/G', 'top/bottom'], ['PgUp/PgDn', 'page'], ['q', 'quit']];
  if (view !== 'list') return [['go', go]];
  return [
    ['view', [['v', layout === 'commit' ? 'flat list' : 'group by commit'], ['m', 'more commits'], ['w', 'run workflow'], ['R', 'refresh']]],
    ['go', [...go.slice(0, 3), ['esc', 'close keys'], ['q', 'quit']]],
  ];
}
