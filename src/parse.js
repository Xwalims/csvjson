'use strict';

/**
 * csvjson — dialect detection and CSV -> table parsing.
 *
 * Detection counts candidate delimiters (`,` `;` `\t` `|`) and quote characters
 * (`"` `'`) ONLY outside quoted regions, over a sample of leading rows. Pass an
 * explicit delimiter/quote, or set `detect: false`, to bypass sniffing entirely.
 */

const {
  DEFAULTS,
  DELIMITER_CANDIDATES,
  QUOTE_CANDIDATES,
  Tokenizer,
  CsvError,
  RaggedRowError,
} = require('./tokenize.js');
const { inferRows, TYPES } = require('./infer.js');

const RAGGED_MODES = Object.freeze(['pad', 'error', 'dump']);

/**
 * Scan a sample under ONE quote character and count candidate delimiters per
 * record, ignoring anything inside a quoted field.
 *
 * The walk follows the tokenizer's own rule exactly: a quote character opens a
 * quoted region only at the START of a field (the first character of the input,
 * or right after a delimiter or a record break). A quote in the middle of a
 * field is literal data.
 *
 * With the quote character fixed there is nothing to guess, which is what makes
 * this safe. The earlier version tried to infer it as it went and let a single
 * unclosed opener swallow the rest of the file, so a tab- or semicolon-separated
 * file whose first field merely BEGINS with the other quote character was read
 * as single-column and fell back to ','. `detectDelimiter` now scores the whole
 * scan under each candidate instead, so no guess is made mid-walk.
 *
 * Returns the per-candidate tally plus `unterminated`: true when the sample ends
 * inside a quoted region, i.e. the file is not valid CSV under this quote
 * character and the tally must not be trusted.
 */
function sniff(sample, quoteChar = '"') {
  const stats = new Map();
  for (const d of DELIMITER_CANDIDATES) stats.set(d, []);
  let recordCounts = new Map(); // delimiter -> counts for the current record
  let inQuotes = false;
  const quote = quoteChar;

  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i];
    if (inQuotes) {
      if (ch === quote) {
        if (sample[i + 1] === quote) i += 1; // escaped quote
        else inQuotes = false;
      }
      continue;
    }
    // Not inside quotes: only a quote at a field start opens a quoted region.
    if (ch === quote) {
      const prev = i > 0 ? sample[i - 1] : null;
      if (prev === null || DELIMITER_CANDIDATES.indexOf(prev) !== -1 || prev === '\n' || prev === '\r') {
        inQuotes = true;
      }
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && sample[i + 1] === '\n') i += 1;
      for (const d of DELIMITER_CANDIDATES) {
        if (recordCounts.has(d)) stats.get(d).push(recordCounts.get(d));
      }
      recordCounts = new Map();
      continue;
    }
    for (const d of DELIMITER_CANDIDATES) {
      if (ch === d) recordCounts.set(d, (recordCounts.get(d) || 0) + 1);
    }
  }
  // A scan that ends mid-field tells you the quote character is the wrong one,
  // so its counts describe a file that is not CSV under this assumption.
  if (!inQuotes) {
    // The trailing partial record counts as a sample row too.
    for (const d of DELIMITER_CANDIDATES) {
      if (recordCounts.has(d)) stats.get(d).push(recordCounts.get(d));
    }
  }
  return { stats, unterminated: inQuotes };
}

/**
 * Choose a delimiter by scoring each candidate on the sample.
 * Prefers the candidate with the highest count that is consistent across rows;
 * ties break by candidate order (comma first).
 *
 * Detection is a PIPELINE, and the order matters: the quote character is chosen
 * first (detectQuote), and the delimiter is then scored under that quote
 * character only. Scanning under both and keeping the best score is wrong --
 * a reading in which the quote character never opens anything loses the very
 * protection quoted fields exist to provide, so plain commas inside a quoted
 * field get counted and can outscore the real delimiter.
 *
 * If the sample ends inside a quoted region, the quote character is wrong: it
 * stranded an opener and every delimiter after it is invisible. The other
 * candidate is then tried, and if neither terminates the sample simply has no
 * usable reading. That is exactly the failure that made a semicolon-separated
 * file beginning with a lone double quote come back as single-column and fall
 * back to ','. Trying one alternative is a linear cost; a guess made mid-scan
 * would need look-ahead to undo itself, which is quadratic in the sample size.
 */
function detectDelimiter(sample, quoteChar) {
  const first = typeof quoteChar === 'string' && quoteChar.length ? quoteChar : detectQuote(sample);
  const order = [first].concat(QUOTE_CANDIDATES.filter((q) => q !== first));
  let best = null;
  for (const quote of order) {
    const { stats, unterminated } = sniff(sample, quote);
    if (unterminated) continue; // not a CSV file under this quote character
    for (const d of DELIMITER_CANDIDATES) {
      const counts = stats.get(d);
      if (!counts.length) continue;
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      // Consistency: how many records share the modal width.
      const freq = new Map();
      for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
      let modal = 0;
      let modalCount = 0;
      for (const [width, n] of freq) {
        if (n > modalCount || (n === modalCount && width > modal)) {
          modal = width;
          modalCount = n;
        }
      }
      const modalTotal = modal * modalCount;
      const score = modalTotal + (modal / counts.length) * 0.5;
      if (!best || score > best.score) best = { delimiter: d, score, width: modal, records: counts.length };
    }
    // The first quote character that yields a whole-file reading wins outright.
    // Its reading is the one the parser will actually use, so letting a rival
    // outscore it would optimise against the wrong parse.
    if (best) break;
  }
  return best ? best.delimiter : ',';
}

/**
 * Choose a quote character: the candidate that actually opens a quoted field in
 * the sample. A quote only counts when it sits at a field start — the first
 * character of the input, right after a delimiter, or right after a record
 * break. A quote in the middle of a field is literal data.
 */
function detectQuote(sample) {
  const counts = new Map();
  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i];
    if (ch !== '"' && ch !== "'") continue;
    const prev = i > 0 ? sample[i - 1] : null;
    const atFieldStart =
      prev === null || prev === '\n' || prev === '\r' || DELIMITER_CANDIDATES.indexOf(prev) !== -1;
    if (atFieldStart) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let best = '"';
  let bestCount = 0;
  for (const q of QUOTE_CANDIDATES) {
    const n = counts.get(q) || 0;
    if (n > bestCount) {
      best = q;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Reconcile record widths according to the ragged policy.
 *
 *  - pad   fill missing trailing cells with options.padValue
 *  - error throw RaggedRowError on the first width mismatch
 *  - dump  move overflowing cells into an array in the last column
 */
function applyRagged(records, expectedWidth, options) {
  const mode = options.ragged || DEFAULTS.ragged;
  if (!RAGGED_MODES.includes(mode)) {
    throw new CsvError(`unknown --ragged mode: ${mode}`, { code: 'E_BAD_OPTION' });
  }
  const out = [];
  for (const rec of records) {
    const fields = rec.fields ? rec.fields : rec;
    const line = rec.line === undefined ? null : rec.line;
    const rowIndex = rec.rowIndex === undefined ? out.length : rec.rowIndex;
    if (fields.length === expectedWidth) {
      out.push(fields);
    } else if (fields.length < expectedWidth) {
      if (mode === 'error') {
        throw new RaggedRowError({ width: fields.length, expected: expectedWidth, line, rowIndex });
      }
      const padded = fields.slice();
      while (padded.length < expectedWidth) padded.push(options.padValue === undefined ? DEFAULTS.padValue : options.padValue);
      out.push(padded);
    } else {
      if (mode === 'error') {
        throw new RaggedRowError({ width: fields.length, expected: expectedWidth, line, rowIndex });
      }
      if (mode === 'dump') {
        const head = fields.slice(0, expectedWidth - 1);
        head.push(fields.slice(expectedWidth - 1));
        out.push(head);
      } else {
        // pad: overflow is truncated to keep every row the same width.
        out.push(fields.slice(0, expectedWidth));
      }
    }
  }
  return out;
}

/**
 * Parse CSV text into a table.
 *
 * @param {string} input
 * @param {object} [options] see DEFAULTS
 * @returns {{header:string[]|null, rows:any[][], types:string[], delimiter:string,
 *            quote:string, columnCount:number, ragged:Array, rowCount:number}}
 */
function parseCsv(input, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  if (typeof input !== 'string') {
    throw new TypeError('parseCsv: input must be a string');
  }
  if (opts.types && !TYPES.includes(opts.types)) {
    throw new CsvError(`unknown --types mode: ${opts.types}`, { code: 'E_BAD_OPTION' });
  }

  const sample = opts.detect === false ? '' : input.slice(0, opts.sampleSize);
  let delimiter;
  let quote;
  if (opts.detect === false) {
    delimiter = opts.delimiter || ',';
    quote = opts.quote || '"';
  } else {
    // Quote first, then delimiter: the delimiter is scored under the quote
    // character the parse will really use. See detectDelimiter.
    quote = opts.quote || detectQuote(sample);
    delimiter = opts.delimiter || detectDelimiter(sample, quote);
  }

  const tok = new Tokenizer(Object.assign({}, opts, { delimiter, quote, positions: true }));
  tok.push(input);
  const records = tok.flush().slice();

  if (records.length === 0) {
    return {
      header: null,
      rows: [],
      types: [],
      delimiter,
      quote,
      columnCount: 0,
      ragged: [],
      rowCount: 0,
    };
  }

  // The header record, when present, is excluded from ragged reconciliation
  // unless it is itself the odd one out; header width defines the column count.
  let header = null;
  let body = records;
  if (opts.header !== false) {
    header = records[0].fields.slice();
    body = records.slice(1);
  }

  const expectedWidth = opts.header !== false
    ? header.length
    : body.reduce((m, r) => Math.max(m, r.fields.length), 0);

  // A blank line is not a short row. It is an empty LINE, and it must not be
  // padded: padding invents cells that were never in the file and the writer
  // then emits a stray delimiter for each one, so `\n\n` comes back as `\n,\n`.
  // Blank records are therefore held out of the ragged machinery — which would
  // both pad them and count them as malformed — and re-inserted in place as
  // zero-field rows, which the writer renders as an empty line. `[]` is exactly
  // what a blank record means, so the cycle closes.
  const kept = [];
  const blanks = new Set();
  body.forEach((rec, i) => {
    if (rec.blank) blanks.add(i);
    else kept.push(rec);
  });
  const keptRows = applyRagged(kept, expectedWidth, opts);

  const ragged = [];
  const reconciled = [];
  let k = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (blanks.has(i)) {
      reconciled.push([]);
      continue;
    }
    const rec = kept[k];
    const fields = keptRows[k];
    k += 1;
    if (rec && rec.fields.length !== fields.length) {
      ragged.push({ rowIndex: rec.rowIndex, line: rec.line, width: rec.fields.length });
    }
    reconciled.push(fields);
  }

  const { types, rows } = inferRows(reconciled, expectedWidth, opts);

  return {
    header,
    rows,
    types,
    delimiter,
    quote,
    columnCount: expectedWidth,
    ragged,
    rowCount: rows.length,
  };
}

module.exports = {
  RAGGED_MODES,
  sniff,
  detectDelimiter,
  detectQuote,
  applyRagged,
  parseCsv,
};