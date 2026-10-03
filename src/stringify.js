'use strict';

/**
 * csvjson — CSV writer and JSON shaping.
 *
 * The writer quotes a field only when it must: it contains the delimiter, the
 * quote character, a CR or an LF, or leading/trailing whitespace that would
 * otherwise be lost. Embedded quotes are escaped by doubling them, and embedded
 * newlines are preserved verbatim so that a CSV -> JSON -> CSV round trip is
 * byte-stable.
 */

const { DEFAULTS } = require('./tokenize.js');

/** JSON output shapes accepted by --json / `shape`. */
const SHAPES = Object.freeze(['objects', 'ndjson', 'columns']);

/** True when `value` must be wrapped in quotes to survive a CSV round trip. */
function needsQuoting(value, delimiter, quote) {
  if (value === '') return false;
  if (value.indexOf(delimiter) !== -1) return true;
  if (value.indexOf(quote) !== -1) return true;
  if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) return true;
  // Leading/trailing spaces and tabs are ambiguous for many readers.
  if (value !== value.trim()) return true;
  return false;
}

/**
 * Render a single field.
 * @param {string} value
 * @param {{delimiter?:string,quote?:string,quoteAll?:boolean,eol?:string}} [options]
 */
function stringifyField(value, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const delimiter = opts.delimiter || ',';
  const quote = opts.quote || '"';
  const v = value === null || value === undefined ? '' : String(value);
  if (opts.quoteAll || needsQuoting(v, delimiter, quote)) {
    const quoteRegex = new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    return quote + v.replace(quoteRegex, quote + quote) + quote;
  }
  return v;
}

/**
 * Render one record.
 * @param {any[]} fields
 * @param {object} [options]
 * @returns {string} no trailing record separator
 */
function stringifyRow(fields, options = {}) {
  return fields.map((f) => stringifyField(f, options)).join(options.delimiter || ',');
}

/**
 * Write a full CSV document.
 *
 * @param {string[]} [header] optional header record
 * @param {Iterable<any[]>} [rows]
 * @param {object} [options]
 * @returns {string}
 */
function stringify(header, rows, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const eol = opts.eol === undefined || opts.eol === null ? '\n' : opts.eol;
  const out = [];
  if (header && header.length) out.push(stringifyRow(header, opts));
  if (rows) {
    for (const row of rows) {
      if (Array.isArray(row)) out.push(stringifyRow(row, opts));
      else out.push(stringifyField(row, opts));
    }
  }
  let text = out.join(eol);
  if (out.length && opts.trailingNewline !== false) text += eol;
  return text;
}

/**
 * Build records from a column-oriented table.
 *
 * `rows` may be the row count (as emitted by the `columns` JSON shape) or an
 * array whose length is the row count.
 *
 * @param {Record<string, any[]>} columns
 * @param {number|any[]} rowsOrCount
 * @returns {any[][]}
 */
function columnsToRows(columns, rowsOrCount) {
  const names = Object.keys(columns);
  let height;
  if (typeof rowsOrCount === 'number') height = rowsOrCount;
  else if (Array.isArray(rowsOrCount)) {
    // No explicit count: the longest column wins.
    height = rowsOrCount.length;
    for (const n of names) {
      const col = columns[n];
      if (col && col.length > height) height = col.length;
    }
  } else height = 0;
  const out = [];
  for (let r = 0; r < height; r += 1) {
    const row = [];
    for (const n of names) {
      const col = columns[n];
      row.push(col && r < col.length ? col[r] : null);
    }
    out.push(row);
  }
  return out;
}

/**
 * Exchange the header record with the data records (a true matrix transpose).
 *
 * The header row becomes the first column and every original column becomes a
 * row. It is an involution: transposeTable(transposeTable(t)) deep-equals t.
 *
 * @param {{header:string[]|null, rows:any[][]}} table
 */
function transposeTable(table) {
  const header = table.header || null;
  const rows = table.rows || [];
  const matrix = header ? [header, ...rows] : rows.slice();
  if (matrix.length === 0) return { header: null, rows: [] };
  const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const out = [];
  for (let c = 0; c < width; c += 1) {
    const row = [];
    for (let r = 0; r < matrix.length; r += 1) {
      row.push(c < matrix[r].length ? matrix[r][c] : null);
    }
    out.push(row);
  }
  return { header: out[0], rows: out.slice(1) };
}

/**
 * Serialize a parsed table to JSON text in the requested shape.
 *
 * Shapes:
 *  - objects  (default) an array of objects keyed by header; needs headers
 *  - ndjson             one compact JSON object per line
 *  - columns            {columns:{name:[...]},rows:n} for wide data
 *
 * @param {{header:string[]|null, rows:any[][]}} table
 * @param {object} [options]
 */
function toJson(table, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const shape = opts.shape || 'objects';
  const indent = opts.indent === 0 ? 0 : opts.indent === undefined ? DEFAULTS.indent : opts.indent;
  const t = opts.transpose ? transposeTable(table) : table;
  const { header, rows } = t;

  if (shape === 'ndjson') {
    const keys = header && header.length ? header : rows.length ? rows[0].map((_, i) => String(i)) : [];
    const lines = rows.map((row) => {
      const obj = {};
      keys.forEach((k, i) => {
        obj[k] = i < row.length ? row[i] : null;
      });
      return JSON.stringify(obj);
    });
    return lines.join('\n');
  }

  if (shape === 'columns') {
    const keys = header && header.length ? header : rows.length ? rows[0].map((_, i) => String(i)) : [];
    const columns = {};
    keys.forEach((k, c) => {
      columns[k] = rows.map((row) => (c < row.length ? row[c] : null));
    });
    const payload = { columns, rows: rows.length };
    return indent ? JSON.stringify(payload, null, indent) : JSON.stringify(payload);
  }

  // shape === 'objects'
  const keys = header && header.length ? header : rows.length ? rows[0].map((_, i) => String(i)) : [];
  const arr = rows.map((row) => {
    const obj = {};
    keys.forEach((k, i) => {
      obj[k] = i < row.length ? row[i] : null;
    });
    return obj;
  });
  return indent ? JSON.stringify(arr, null, indent) : JSON.stringify(arr);
}

/**
 * Serialize a JSON value to CSV text.
 *
 * Accepts:
 *  - an array of objects            (uses Object.keys of the first object)
 *  - an array of arrays             (written as-is; header row when given)
 *  - {columns:{name:[...]}, rows:n} column-oriented input
 *
 * @param {any} data
 * @param {object} [options]
 * @returns {string}
 */
function fromJson(data, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const eol = opts.eol === undefined || opts.eol === null ? '\n' : opts.eol;
  const lines = [];

  const emit = (header, rows) => {
    const body = [];
    if (header && header.length) body.push(stringifyRow(header, opts));
    for (const row of rows) body.push(stringifyRow(row, opts));
    if (body.length) {
      lines.push(body.join(eol) + (opts.trailingNewline !== false ? eol : ''));
    }
  };

  if (Array.isArray(data)) {
    if (data.length && Array.isArray(data[0])) {
      const rows = data;
      if (opts.header === false) emit(null, rows);
      else emit(rows[0], rows.slice(1));
    } else if (data.length && data[0] && typeof data[0] === 'object') {
      const names = [];
      for (const obj of data) {
        for (const k of Object.keys(obj)) if (names.indexOf(k) === -1) names.push(k);
      }
      const rows = data.map((obj) => names.map((n) => (obj[n] === undefined ? '' : obj[n])));
      if (opts.header === false) emit(null, rows);
      else emit(names, rows);
    } else if (data.length) {
      const rows = data.map((v) => [v]);
      if (opts.header === false) emit(null, rows);
      else emit(['value'], rows);
    } else {
      // An empty array holds no records, so there is no column name to invent.
      // emit() would otherwise contradict its own `if (body.length)` guard and
      // turn "no rows" into a one-line CSV holding a fabricated header, which
      // then round-trips back to a non-empty table.
      return lines.join('');
    }
    return lines.join('');
  }

  if (data && typeof data === 'object' && data.columns) {
    const rows = columnsToRows(data.columns, data.rows);
    const header = opts.header === false ? null : Object.keys(data.columns);
    emit(header, rows);
    return lines.join('');
  }

  throw new TypeError('fromJson: expected an array or a {columns, rows} object');
}

module.exports = {
  SHAPES,
  needsQuoting,
  stringifyField,
  stringifyRow,
  stringify,
  columnsToRows,
  transposeTable,
  toJson,
  fromJson,
};