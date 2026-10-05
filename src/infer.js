'use strict';

/**
 * csvjson — column-wise type inference.
 *
 * COLUMNS ARE ATOMIC. A column gets exactly one type, decided by looking at
 * every cell in that column. If a single cell in a column is not numeric, the
 * whole column stays a string. We never emit `"1"` in one row and `1` in
 * another within the same column — mixed types in a column are a data problem,
 * not something to paper over per-row.
 *
 * The inference order is: null, boolean, number, string. Empty cells are
 * neutral: they never veto a type and never become a value on their own
 * (see `emptyIsNull`).
 */

const { DEFAULTS } = require('./tokenize.js');

const TYPES = Object.freeze(['auto', 'all-string', 'number', 'boolean', 'null']);

/** Values recognised as booleans (lowercased before comparison). */
const TRUE_LITERALS = Object.freeze(['true']);
const FALSE_LITERALS = Object.freeze(['false']);
/** Values recognised as null. */
// Deliberately conservative: 'NA'/'N/A' are left as strings because a user who
// passes --pad-value NA means the literal text, not a null.
const NULL_LITERALS = Object.freeze(['', 'null', 'nil', 'none', 'nan']);
/** A number: optional sign, digits, optional fraction, optional exponent. */
const NUMBER_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
/** Thousands separators we are willing to strip before testing a number. */
const GROUPED_NUMBER_RE = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;

function isBlank(value) {
  return value === '' || value === null || value === undefined;
}

function isNullLiteral(value) {
  return NULL_LITERALS.indexOf(String(value).trim().toLowerCase()) !== -1;
}

/**
 * Convert a cell to a number, or return null when it is not numeric.
 * Handles grouped thousands separators and a bare leading "." decimal.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  if (s === '') return null;
  if (GROUPED_NUMBER_RE.test(s)) s = s.replace(/,/g, '');
  if (!NUMBER_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (TRUE_LITERALS.indexOf(s) !== -1) return true;
  if (FALSE_LITERALS.indexOf(s) !== -1) return false;
  return null;
}

/** Classify one cell. Returns 'null' | 'boolean' | 'number' | 'string'. */
function classifyCell(value) {
  if (isBlank(value)) return 'null';
  if (isNullLiteral(value)) return 'null';
  if (toBoolean(value) !== null) return 'boolean';
  if (toNumber(value) !== null) return 'number';
  return 'string';
}

/**
 * Coerce one cell to the given column type.
 *
 * In `auto` mode a cell that will not convert becomes null rather than leaking
 * its raw string into a number or boolean column — that would produce exactly
 * the mixed-type column (`"10"` next to `10`) this module exists to prevent.
 * A forced mode (`--types number`) is an explicit override, so there an
 * unconvertible value is preserved verbatim instead of being dropped.
 *
 * @param {*} value
 * @param {'null'|'boolean'|'number'|'string'} type
 * @param {{force?:boolean}} [options]
 */
function coerce(value, type, options = {}) {
  const force = options.force === true;
  switch (type) {
    case 'null':
      return null;
    case 'boolean': {
      const b = toBoolean(value);
      if (b !== null) return b;
      if (force) return isBlank(value) ? null : value;
      return null;
    }
    case 'number': {
      const n = toNumber(value);
      if (n !== null) return n;
      if (force) return isBlank(value) ? null : value;
      return null;
    }
    default:
      return isBlank(value) ? '' : value;
  }
}

/**
 * Decide one type for a whole column of raw string cells.
 * @param {string[]} cells
 * @returns {'null'|'boolean'|'number'|'string'}
 */
function inferColumn(cells, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const mode = opts.types === undefined || opts.types === null ? 'auto' : opts.types;
  if (mode === 'all-string') return 'string';
  if (mode === 'number' || mode === 'boolean' || mode === 'null') return mode;

  // Collect the kinds of EVERY cell, then decide once. Deciding inside the loop
  // cannot work: an empty cell is neutral, so the moment one appears next to a
  // boolean the old code settled on 'boolean' and returned, never looking at
  // the cells after it. So `true,'',1` typed boolean (blank in row 2) and
  // `true,1,''` typed string (blank in row 3) -- one column, one rule, two
  // answers decided by where a blank happened to sit in the file.
  //
  // The early return also DESTROYED data. A boolean verdict makes auto-mode
  // coercion null out anything that is not a boolean literal, so the number
  // that was never examined came out as `null`:
  //
  //   name,ok        name,ok            [{"name":"alice","ok":true},
  //   alice,true     alice,true    -->   {"name":"bob","ok":null},
  //   bob,           bob,1             {"name":"carol","ok":null}]   <- "1" lost
  //   carol,1        carol,
  //
  // The cost is not limited to the cells that follow the blank either. A
  // boolean column typed off the first two rows keeps nulling every numeric
  // cell in the rest of the file, so the column's type depends on row order
  // AND the early rows are trusted over the late ones.
  const kinds = new Set();
  for (const cell of cells) kinds.add(classifyCell(cell));

  if (kinds.size === 0) return 'null';
  // One string is enough to sink the column: a column is atomic, so a single
  // non-numeric cell keeps the whole thing text.
  if (kinds.has('string')) return 'string';
  // Numbers mixed with booleans is the one genuine conflict left once strings
  // and blanks are out of the way, and it resolves to string as well.
  if (kinds.has('number') && kinds.has('boolean')) return 'string';
  if (kinds.has('number')) return 'number';
  if (kinds.has('boolean')) return 'boolean';
  return 'null';
}

/**
 * Infer a type for every column and coerce every cell.
 *
 * @param {string[][]} rows raw string cells, header row already separated
 * @param {number} columnCount
 * @param {object} [options]
 * @returns {{types: string[], rows: any[][]}}
 */
function inferRows(rows, columnCount, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const mode = opts.types === undefined || opts.types === null ? 'auto' : opts.types;
  if (mode === 'all-string') {
    return {
      types: new Array(columnCount).fill('string'),
      rows: rows.map((r) => r.map((c) => (isBlank(c) ? '' : c))),
    };
  }
  // A forced mode overrides inference, so an unconvertible cell must survive.
  const force = mode !== 'auto';

  // Gather the cells of each column.
  const columns = [];
  for (let c = 0; c < columnCount; c += 1) columns.push([]);
  for (const row of rows) {
    // A zero-field row is a blank LINE, not a row of empty cells: it has no
    // columns to infer. Widening it here would turn an empty line back into
    // empty cells, and the writer would then emit a delimiter for each one it
    // invented. Such rows are carried through untouched.
    if (row.length === 0) continue;
    for (let c = 0; c < columnCount; c += 1) {
      columns[c].push(c < row.length ? row[c] : '');
    }
  }

  const types = columns.map((cells) => inferColumn(cells, opts));
  const coerced = rows.map((row) => {
    if (row.length === 0) return [];
    const out = new Array(columnCount);
    for (let c = 0; c < columnCount; c += 1) {
      out[c] = coerce(c < row.length ? row[c] : '', types[c], { force });
    }
    return out;
  });
  return { types, rows: coerced };
}

module.exports = {
  TYPES,
  NULL_LITERALS,
  NUMBER_RE,
  isBlank,
  isNullLiteral,
  toNumber,
  toBoolean,
  classifyCell,
  coerce,
  inferColumn,
  inferRows,
};