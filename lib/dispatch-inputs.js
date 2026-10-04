// workflow_dispatch inputs from a workflow file, through a parser for the block-YAML subset workflow
// files use: maps, lists, flow lists/maps of scalars, quoted scalars and block scalars (| and >).
// Anchors, aliases and multi-document files are not supported; parse failures yield null.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitFlow(body) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (const c of body) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Splits "key: value" at the first ": " (or trailing ":") outside quotes; null when it isn't a pair.
function splitPair(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return [scalar(text.slice(0, i).trim()), text.slice(i + 1).trim()];
  }
  return null;
}

export function scalar(text) {
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1).replace(/''/g, "'");
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^(null|Null|NULL|~)?$/.test(t)) return null;
  return t;
}

function inlineValue(text) {
  if (text.startsWith('[') && text.endsWith(']')) return splitFlow(text.slice(1, -1)).map(scalar);
  if (text.startsWith('{') && text.endsWith('}')) {
    const obj = {};
    for (const part of splitFlow(text.slice(1, -1))) {
      const kv = splitPair(part) ?? [scalar(part), ''];
      obj[kv[0]] = kv[1] === '' ? null : scalar(kv[1]);
    }
    return obj;
  }
  return scalar(text);
}

export function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).replace(/\t/g, '  ').split('\n')) {
    const clean = stripComment(raw).replace(/\s+$/, '');
    lines.push({ raw, indent: raw.length - raw.trimStart().length, text: clean.trim() });
  }
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && (!lines[i].text || lines[i].text === '---')) i++;
  };

  function blockScalar(parentIndent, style) {
    const out = [];
    let indent = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.raw.trim() && l.indent <= parentIndent) break;
      if (l.raw.trim()) indent ??= l.indent;
      out.push(l.raw.trim() ? l.raw.slice(indent) : '');
      i++;
    }
    while (out.length && !out.at(-1)) out.pop();
    return style.startsWith('>') ? out.join(' ').replace(/\s+/g, ' ').trim() : out.join('\n');
  }

  function value(rest, indent) {
    if (/^[|>][+-]?\d*$/.test(rest)) return blockScalar(indent, rest);
    if (rest !== '') {
      // A plain scalar may continue on more-indented lines.
      const more = [];
      while (i < lines.length && lines[i].text && lines[i].indent > indent && !/^["'[{]/.test(rest)) more.push(lines[i++].text);
      return more.length ? [rest, ...more].join(' ') : inlineValue(rest);
    }
    skipBlank();
    if (i < lines.length && lines[i].indent > indent) return node(lines[i].indent);
    if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) return node(indent);
    return null;
  }

  function node(indent) {
    skipBlank();
    if (i >= lines.length) return null;
    return lines[i].text === '-' || lines[i].text.startsWith('- ') ? list(indent) : map(indent);
  }

  function map(indent) {
    const obj = {};
    for (skipBlank(); i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- '); skipBlank()) {
      const pair = splitPair(lines[i].text);
      if (!pair) throw new Error(`line ${i + 1}: expected key: value`);
      i++;
      obj[pair[0]] = value(pair[1], indent);
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${i + 1}: unexpected indent`);
    return obj;
  }

  function list(indent) {
    const arr = [];
    for (skipBlank(); i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- ')); skipBlank()) {
      const l = lines[i];
      const rest = l.text.slice(1).trim();
      if (rest && splitPair(rest) && !/^["'[{]/.test(rest)) {
        // "- key: v" opens a map whose keys sit two columns in.
        const itemIndent = l.indent + (l.raw.trimStart().length - l.raw.trimStart().slice(1).trimStart().length);
        lines[i] = { ...l, indent: itemIndent, text: rest };
        arr.push(map(itemIndent));
      } else {
        i++;
        arr.push(value(rest, indent));
      }
    }
    return arr;
  }

  const doc = node(0);
  skipBlank();
  if (i < lines.length) throw new Error(`line ${i + 1}: unexpected content`);
  return doc;
}

// The top-level `on:` block alone: jobs hold the YAML this parser doesn't cover, and inputs never
// live there.
export function onBlock(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^(on|"on"|'on'|true)\s*:/.test(l));
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

const TYPES = new Set(['string', 'boolean', 'choice', 'number', 'environment']);

/**
 * [{ name, description, required, type, options, default }] for a workflow's dispatch inputs; []
 * when it has none, null when the file can't be read.
 */
export function dispatchInputs(text) {
  let doc;
  try {
    doc = parseYaml(onBlock(text));
  } catch {
    return null;
  }
  const on = doc?.on ?? doc?.true;
  const inputs = on && typeof on === 'object' && !Array.isArray(on) ? on.workflow_dispatch?.inputs : null;
  if (!inputs || typeof inputs !== 'object') return [];
  return Object.entries(inputs).map(([name, spec]) => {
    const s = spec && typeof spec === 'object' ? spec : {};
    const type = TYPES.has(s.type) ? s.type : 'string';
    return {
      name,
      description: s.description == null ? '' : String(s.description),
      required: s.required === true,
      type,
      options: Array.isArray(s.options) ? s.options.map(String) : [],
      default: s.default ?? null,
    };
  });
}

// Starting value of an input in the dispatch form.
export function initialValue(input) {
  if (input.type === 'boolean') return input.default === true || input.default === 'true';
  if (input.default != null) return String(input.default);
  if (input.type === 'choice') return input.options[0] ?? '';
  return '';
}

// Required inputs left empty, by name.
export function missingInputs(inputs, values) {
  return inputs.filter((inp) => inp.required && inp.type !== 'boolean' && String(values[inp.name] ?? '') === '').map((inp) => inp.name);
}

// `-f name=value` pairs for gh workflow run; empty strings are left to the workflow's defaults.
export function inputFlags(inputs, values) {
  return inputs.flatMap((inp) => {
    const v = values[inp.name];
    if (v == null || v === '') return [];
    return ['-f', `${inp.name}=${typeof v === 'boolean' ? String(v) : v}`];
  });
}
