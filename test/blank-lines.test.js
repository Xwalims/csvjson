'use strict';

/**
 * Blank lines.
 *
 * A blank line is an empty LINE, and that is not the same thing as a row of
 * empty cells. `a,b\n\n` holds two cells on line 1 and nothing on line 2, while
 * `a,b\n,\n` holds two cells on both. Both tokenize to records that look alike,
 * which is exactly why the distinction has to be made while reading.
 *
 * These tests pin the two properties that matter: a blank line survives a
 * parse->write cycle as a blank line, and it is never reported as a malformed
 * (ragged) row.
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseCsv } = require('../src/parse.js');
const { stringify, toJson } = require('../src/stringify.js');
const { Tokenizer, tokenize } = require('../src/tokenize.js');

const write = (t) => stringify(t.header, t.rows, { delimiter: t.delimiter, quote: t.quote });

test('blank line: survives a parse -> write cycle byte for byte', () => {
  const cases = [
    'a,b\n1,2\n\n3,4\n',
    'a,b\n\n1,2\n',
    'a,b\n1,2\n\n',
    'a,b\n\n',
    'a,b\n\n\n1,2\n',
    'a,b\n1,2\n\n\n3,4\n',
    'a,b\n\n\n',
    'a,b,c\n\n1,2,3\n',
  ];
  for (const src of cases) {
    for (const types of ['auto', 'all-string']) {
      const parsed = parseCsv(src, { types });
      assert.strictEqual(
        write(parsed),
        src,
        `${JSON.stringify(src)} (types=${types}) did not round-trip`
      );
    }
  }
});

test('blank line: is an empty line, not a row of empty cells', () => {
  // The padded-with-delimiters form is a real row and must NOT be touched.
  assert.strictEqual(write(parseCsv('a,b\n\n1,2\n')), 'a,b\n\n1,2\n');
  assert.strictEqual(write(parseCsv('a,b\n,\n1,2\n')), 'a,b\n,\n1,2\n');
  // These two differ in the input, and they must differ in the output too.
  assert.notStrictEqual(write(parseCsv('a,b\n\n1,2\n')), write(parseCsv('a,b\n,\n1,2\n')));
});

test('blank line: is not counted as a ragged row', () => {
  const parsed = parseCsv('a,b\n1,2\n\n3,4\n');
  assert.deepStrictEqual(parsed.ragged, [], 'a blank line is not a malformed row');
});

test('blank line: padding still applies to a real short row', () => {
  const parsed = parseCsv('a,b\n1\n\n2,3\n', { types: 'all-string' });
  assert.deepStrictEqual(parsed.rows, [['1', ''], [], ['2', '3']]);
  assert.strictEqual(parsed.ragged.length, 1, 'the short row is reported');
  assert.strictEqual(parsed.ragged[0].width, 1);
});

test('blank line: --ragged error does not reject a blank line', () => {
  const parsed = parseCsv('a,b\n1,2\n\n3,4\n', { ragged: 'error' });
  // Three records: the blank line is kept as a record, it is just not data.
  assert.strictEqual(parsed.rowCount, 3);
  assert.deepStrictEqual(parsed.rows[1], []);
});

test('blank line: the tokenizer marks blank records distinctly', () => {
  const rows = tokenize('a,b\n\nc,d', { delimiter: ',', quote: '"', positions: true });
  assert.strictEqual(rows[1].blank, true);
  assert.strictEqual(rows[0].blank, false);
  assert.strictEqual(rows[2].blank, false);
  // A row of empty cells is NOT blank: it holds cells.
  const cells = tokenize('a,b\n,', { delimiter: ',', quote: '"', positions: true });
  assert.strictEqual(cells[1].blank, false);
  // A quoted empty field is NOT blank either: `""` is a field.
  const quoted = tokenize('a,b\n""', { delimiter: ',', quote: '"', positions: true });
  assert.strictEqual(quoted[1].blank, false);
  // Literal data with no delimiter is NOT blank.
  const literal = tokenize('a;b\n1;2', { delimiter: ',', quote: '"', positions: true });
  assert.strictEqual(literal[1].blank, false);
});

test('blank line: a quoted empty field still pads as a row of empty cells', () => {
  // `""` is a field, so it is a short row and the pad policy applies.
  const parsed = parseCsv('a,b\n""\n', { types: 'all-string' });
  assert.strictEqual(parsed.ragged.length, 1);
  assert.deepStrictEqual(parsed.rows, [['', '']]);
});

test('blank line: a blank header row is still a header', () => {
  // The leading blank line is consumed as the header record, so it names one
  // (unnamed) column; the data row keeps its single cell.
  const parsed = parseCsv('\n1,2\n', { types: 'all-string' });
  assert.deepStrictEqual(parsed.header, ['']);
  assert.deepStrictEqual(parsed.rows, [['1']]);
});

test('blank line: CRLF blank lines behave like LF blank lines', () => {
  // `eol` is a writer option, so parse alone gives rows; the writer is told
  // which separator to use explicitly.
  const parsed = parseCsv('a,b\r\n1,2\r\n\r\n3,4\r\n', { types: 'all-string' });
  assert.deepStrictEqual(parsed.rows, [['1', '2'], [], ['3', '4']]);
  const back = stringify(parsed.header, parsed.rows, { eol: '\r\n' });
  assert.strictEqual(back, 'a,b\r\n1,2\r\n\r\n3,4\r\n');
});

test('blank line: type inference ignores blank rows without losing columns', () => {
  // The blank row must not drag the numeric column back to string, and the
  // surviving rows must keep their inferred types.
  const parsed = parseCsv('a,b\n1,2\n\n3,4\n', { types: 'auto' });
  assert.deepStrictEqual(parsed.types, ['number', 'number']);
  assert.deepStrictEqual(parsed.rows, [[1, 2], [], [3, 4]]);
});

test('blank line: --no-header treats blank lines the same way', () => {
  const parsed = parseCsv('1,2\n\n3,4\n', { header: false, types: 'all-string' });
  assert.deepStrictEqual(parsed.rows, [['1', '2'], [], ['3', '4']]);
  assert.strictEqual(parsed.ragged.length, 0);
});

test('blank line: a document of only blank lines keeps its line count', () => {
  const parsed = parseCsv('\n\n\n', { header: false, types: 'all-string' });
  assert.deepStrictEqual(parsed.rows, [[], [], []]);
});

test('blank line: the blank flag survives streaming in tiny chunks', () => {
  // The tokenizer promises chunked input equals one-shot input. `blank` is
  // per-record state, so it must be reset at the record boundary and not
  // carried across chunks: a blank line arriving one character per chunk has to
  // be marked blank, not inherit the previous row's content.
  const src = 'a,b\n\nc,d\n';
  const oneShot = tokenize(src, { delimiter: ',', quote: '"', positions: true });
  const tz = new Tokenizer({ delimiter: ',', quote: '"', positions: true });
  for (const ch of src) tz.push(ch);
  // push() returns the tokenizer's LIVE rows array, so read it only at the end.
  const streamed = tz.flush();
  assert.deepStrictEqual(streamed, oneShot, 'chunked tokenizing diverged from one-shot');
  assert.deepStrictEqual(streamed.map((r) => r.blank), [false, true, false]);
});

test('blank line: the JSON shapes cannot carry one, and that is documented', () => {
  // The README promises this is a known limit rather than a bug, so pin the
  // behaviour: a blank line crosses the JSON boundary as a row of nulls.
  const src = 'a,b\n1,2\n\n3,4\n';
  const parsed = parseCsv(src, { types: 'auto' });

  const objects = JSON.parse(toJson(parsed, { shape: 'objects', indent: 0 }));
  assert.deepStrictEqual(objects, [
    { a: 1, b: 2 },
    { a: null, b: null },
    { a: 3, b: 4 },
  ]);

  const columns = JSON.parse(toJson(parsed, { shape: 'columns', indent: 0 }));
  assert.deepStrictEqual(columns.columns.a, [1, null, 3]);

  // The table API is the lossless path, and the README points at it.
  assert.strictEqual(write(parsed), src);
});