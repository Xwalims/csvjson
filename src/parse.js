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
 * Scan a sample and count candidate delimiters per record, ignoring anything
 * inside a quoted field. Returns a per-candidate tally of
 * {rows: [{count, consistent}], total}.
 */
function sniff(sample, quoteCandidates) {
  const stats = new Map();
  for (const d of DELIMITER_CANDIDATES) stats.set(d, []);
  let recordCounts = new Map(); // delimiter -> counts for the current record
  let inQuotes = false;
  let quote = '"';

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
    if (ch === '"' || ch === "'") {
      const prev = i > 0 ? sample[i - 1] : null;
      if (prev === null || DELIMITER_CANDIDATES.indexOf(prev) !== -1 || prev === '\n' || prev === '\r') {
        inQuotes = true;
        quote = ch;
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
  // The trailing partial record counts as a sample row too.
  for (const d of DELIMITER_CANDIDATES) {
    if (recordCounts.has(d)) stats.get(d).push(recordCounts.get(d));
  }
  void quoteCandidates;
  return stats;
}

/**
 * Choose a delimiter by scoring each candidate on the sample.
 * Prefers the candidate with the highest count that is consistent across rows;
 * ties break by candidate order (comma first).
 */
function detectDelimiter(sample) {
  const stats = sniff(sample);
  let best = null;
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
    delimiter = opts.delimiter || detectDelimiter(sample);
    quote = opts.quote || detectQuote(sample);
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

  const ragged = [];
  const reconciled = applyRagged(body, expectedWidth, opts).map((fields, i) => {
    const rec = records[(opts.header !== false ? 1 : 0) + i];
    if (rec && rec.fields.length !== fields.length) {
      ragged.push({ rowIndex: rec.rowIndex, line: rec.line, width: rec.fields.length });
    }
    return fields;
  });

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