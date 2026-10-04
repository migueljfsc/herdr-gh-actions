// Log search over formatted log lines ({ text, sgr }). Positions are in code points, like wrapLines.

// Smart case: an uppercase letter in the query makes it case-sensitive.
function fold(query) {
  return query === query.toLowerCase() ? (s) => s.toLowerCase() : (s) => s;
}

// [[start, end)] of every non-overlapping match of `query` in `text`.
export function matchSpans(text, query) {
  if (!query) return [];
  const f = fold(query);
  const hay = [...f(text)];
  const needle = [...f(query)];
  const spans = [];
  for (let i = 0; i + needle.length <= hay.length; ) {
    let j = 0;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) {
      spans.push([i, i + needle.length]);
      i += needle.length;
    } else i++;
  }
  return spans;
}

export function matchLines(lines, query) {
  if (!query) return [];
  const out = [];
  lines.forEach((l, i) => matchSpans(l.text, query).length && out.push(i));
  return out;
}

// Lines formatLog marked as `##[error]`.
export function errorLines(lines) {
  const out = [];
  lines.forEach((l, i) => l.sgr === '31' && out.push(i));
  return out;
}

// The next index after `from` (dir 1) or before it (dir -1) in sorted `indices`, wrapping around.
export function stepIndex(indices, from, dir) {
  if (!indices.length) return null;
  if (dir > 0) return indices.find((i) => i > from) ?? indices[0];
  return indices.findLast((i) => i < from) ?? indices.at(-1);
}
