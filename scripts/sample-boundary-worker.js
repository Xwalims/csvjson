'use strict';

/**
 * Sample-boundary cross-check worker: reads a JSON array of cases on stdin,
 * writes one parse result per case.
 *
 * This file is the only thing that touches the code under test. It reports the
 * table parseCsv() actually produced -- row count and column count -- because
 * that is where a sample cut mid-quote shows: the quote character gets swapped,
 * the quoted field stops protecting its delimiters, and the shape of the table
 * changes under it.
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { parseCsv } = require(path.join(ROOT, 'src', 'parse.js'));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const cases = JSON.parse(raw);
  const results = cases.map((c) => {
    try {
      const t = parseCsv(c.text);
      return {
        ok: true,
        quote: t.quote,
        delimiter: t.delimiter,
        rowCount: t.rowCount,
        columnCount: t.columnCount,
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  process.stdout.write(JSON.stringify(results));
});