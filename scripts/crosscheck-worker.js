'use strict';

/**
 * Cross-check worker: reads a JSON array of cases on stdin, writes JSON results.
 *
 * Spawned once per check by scripts/crosscheck.py with every case in a single
 * batch -- one process per case would dominate the runtime and make the harness
 * slower than the code it verifies.
 *
 * Four operations, one per check:
 *
 *   read    tokenize `text`. Used by interop-read (against the values Python
 *           held before writing) and reader-parity (against csv.reader).
 *   write   stringify `header` + `rows`. Used by interop-write, where Python
 *           reads the result back.
 *   chunks  the streaming invariant: parse whole, parse one character at a
 *           time, and parse at every split point k in 0..len. Reports the first
 *           k that disagrees. This is the one check with no external oracle --
 *           Python has no streaming state to compare against, so the property
 *           is asserted directly.
 *
 * Every op returns `{ok: true, ...}` or `{ok: false, error}` so the harness can
 * distinguish a disagreement from a crash in the code under test.
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { Tokenizer } = require(path.join(ROOT, 'src', 'tokenize.js'));
const { stringify } = require(path.join(ROOT, 'src', 'stringify.js'));

/**
 * Parse `text` and return records as plain string arrays.
 *
 * The tokenizer's `blank` flag marks a record that consumed nothing at all --
 * an empty LINE -- which is distinct from a record of one empty field. The flag
 * only exists in `positions` mode, so it is requested here; mapping it to `[]`
 * makes a blank line come back as an empty record, which is exactly what
 * `csv.reader` returns for one, so the two can be compared.
 */
function readRows(text, delimiter, quote) {
  const tz = new Tokenizer({ delimiter, quote, positions: true });
  tz.push(text);
  const records = tz.flush();
  return records.map((rec) => (rec.blank ? [] : rec.fields));
}

/**
 * The full outcome of parsing `text`: either the rows, or the error raised.
 *
 * Comparing outcomes rather than just rows matters because some hand-picked
 * inputs (`"`, `"""`) are malformed on purpose. There, raising
 * UnterminatedQuoteError is the CORRECT result, and the streaming invariant is
 * "the chunking must not change the outcome" -- including changing whether it
 * throws. An earlier version of this file compared rows only and reported those
 * twelve cases as failures, i.e. it called correct error reporting a bug.
 */
function outcome(text, delimiter, quote, chunks) {
  const tz = new Tokenizer({ delimiter, quote, positions: true });
  try {
    for (const chunk of chunks) tz.push(chunk);
    const records = tz.flush();
    return JSON.stringify({ rows: records.map((rec) => (rec.blank ? [] : rec.fields)) });
  } catch (err) {
    // The position is part of what must stay stable across chunkings, so it is
    // part of the canonical outcome rather than discarded with the message.
    return JSON.stringify({
      error: err && err.name ? err.name : 'Error',
      line: err && err.line === undefined ? null : err.line,
      column: err && err.column === undefined ? null : err.column,
    });
  }
}

/**
 * The streaming invariant, asserted directly.
 *
 * Splitting at every position is quadratic in the input length, so long inputs
 * are swept at a coarser stride rather than skipped. The stride is reported, so
 * a coarser run cannot be mistaken for an exhaustive one; at stride 1 every split
 * point in 0..len is tested.
 */
function chunkCheck(text, delimiter, quote) {
  const whole = outcome(text, delimiter, quote, [text]);

  const perChar = outcome(text, delimiter, quote, text.split(''));
  if (perChar !== whole) {
    return {
      agrees: false,
      detail: 'one character at a time differs from one push',
      whole: JSON.parse(whole),
      chunked: JSON.parse(perChar),
    };
  }

  const stride = text.length > 96 ? 3 : 1;
  for (let k = 0; k <= text.length; k += stride) {
    const got = outcome(text, delimiter, quote, [text.slice(0, k), text.slice(k)]);
    if (got !== whole) {
      return {
        agrees: false,
        detail: `split at ${k} (left=${JSON.stringify(text.slice(0, k))} ` +
          `right=${JSON.stringify(text.slice(k))}) differs from one push`,
        whole: JSON.parse(whole),
        chunked: JSON.parse(got),
        splitAt: k,
        stride,
      };
    }
  }
  return { agrees: true, splitsTested: Math.floor(text.length / stride) + 1, stride };
}

function run(c) {
  switch (c.op) {
    case 'read':
      return { rows: readRows(c.text, c.delimiter, c.quote) };
    case 'write':
      return {
        text: stringify(c.header, c.rows, {
          delimiter: c.delimiter,
          quote: c.quote,
          eol: c.eol,
        }),
      };
    case 'chunks':
      return chunkCheck(c.text, c.delimiter, c.quote);
    default:
      throw new Error(`unknown op ${JSON.stringify(c.op)}`);
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const cases = JSON.parse(raw);
  const results = cases.map((c) => {
    try {
      return Object.assign({ ok: true }, run(c));
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  process.stdout.write(JSON.stringify(results));
});