'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  needsQuoting,
  stringifyField,
  stringifyRow,
  stringify,
  toJson,
  fromJson,
  transposeTable,
  columnsToRows,
} = require('../src/stringify.js');

const W = { delimiter: ',', quote: '"' };

test('stringify: quotes only when necessary', () => {
  // Plain values must be emitted bare — no gratuitous quoting.
  assert.strictEqual(stringifyField('plain', W), 'plain');
  assert.strictEqual(stringifyField('with space', W), 'with space');
  assert.strictEqual(stringifyField('a-b_c.d', W), 'a-b_c.d');
  assert.strictEqual(stringifyField('', W), '');
});

test('stringify: quotes when the field contains the delimiter', () => {
  assert.strictEqual(stringifyField('a,b', W), '"a,b"');
  assert.strictEqual(needsQuoting('a,b', ',', '"'), true);
});

test('stringify: quotes when the field contains the quote character', () => {
  assert.strictEqual(stringifyField('say "hi"', W), '"say ""hi"""');
});

test('stringify: quotes when the field contains a newline', () => {
  assert.strictEqual(stringifyField('a\nb', W), '"a\nb"');
  assert.strictEqual(stringifyField('a\r\nb', W), '"a\r\nb"');
});

test('stringify: quotes when the field has leading or trailing spaces', () => {
  assert.strictEqual(stringifyField(' pad ', W), '" pad "');
});

test('stringify: quoteAll quotes every field', () => {
  assert.strictEqual(stringifyField('plain', { delimiter: ',', quote: '"', quoteAll: true }), '"plain"');
});

test('stringify: a row joins fields with the delimiter', () => {
  assert.strictEqual(stringifyRow(['a', 'b,c'], W), 'a,"b,c"');
});

test('stringify: writes a header, rows and a trailing newline', () => {
  assert.strictEqual(stringify(['a', 'b'], [['1', '2']], W), 'a,b\n1,2\n');
});

test('stringify: crlf record separator', () => {
  assert.strictEqual(stringify(['a'], [['1']], { delimiter: ',', quote: '"', eol: '\r\n' }), 'a\r\n1\r\n');
});

test('stringify: a row that is not an array is written as one field', () => {
  // stringify() accepts any Iterable of rows, so a bare scalar row is a legal
  // input and must not be treated as a list of cells. No CLI path reaches this
  // branch -- rows always arrive as arrays -- so it is pinned here.
  assert.strictEqual(stringify(['a', 'b'], [1], W), 'a,b\n1\n');
  assert.strictEqual(stringify(['a'], ['plain', 'has,comma'], W), 'a\nplain\n"has,comma"\n');
});

test('stringify: omitting rows writes just the header record', () => {
  assert.strictEqual(stringify(['a', 'b'], undefined, W), 'a,b\n');
  assert.strictEqual(stringify(['a', 'b'], null, W), 'a,b\n');
});

test('stringify: toJson emits an array of objects', () => {
  const text = toJson({ header: ['a', 'b'], rows: [[1, 2]] }, { indent: 0 });
  assert.deepStrictEqual(JSON.parse(text), [{ a: 1, b: 2 }]);
});

test('stringify: toJson honours the indent option', () => {
  const pretty = toJson({ header: ['a'], rows: [[1]] }, { indent: 2 });
  assert.ok(pretty.includes('\n  '), 'pretty output is indented');
  const compact = toJson({ header: ['a'], rows: [[1]] }, { indent: 0 });
  assert.strictEqual(compact, '[{"a":1}]');
});

test('stringify: toJson ndjson shape is one object per line', () => {
  const text = toJson({ header: ['a', 'b'], rows: [[1, 2], [3, 4]] }, { shape: 'ndjson' });
  assert.strictEqual(text.split('\n').length, 2);
  assert.deepStrictEqual(text.split('\n').map((l) => JSON.parse(l)), [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ]);
});

test('stringify: toJson columns shape is column-oriented', () => {
  const text = toJson({ header: ['a', 'b'], rows: [[1, 2], [3, 4]] }, { shape: 'columns', indent: 0 });
  assert.deepStrictEqual(JSON.parse(text), {
    columns: { a: [1, 3], b: [2, 4] },
    rows: 2,
  });
});

test('stringify: toJson without a header falls back to positional keys', () => {
  const text = toJson({ header: null, rows: [['x', 'y']] }, { indent: 0 });
  assert.deepStrictEqual(JSON.parse(text), [{ 0: 'x', 1: 'y' }]);
});

test('stringify: transpose is an involution', () => {
  const t = { header: ['a', 'b'], rows: [[1, 2], [3, 4]] };
  const once = transposeTable(t);
  assert.deepStrictEqual(once.header, ['a', 1, 3]);
  assert.deepStrictEqual(once.rows, [['b', 2, 4]]);
  assert.deepStrictEqual(transposeTable(once), t);
});

test('stringify: --transpose routes through the JSON writer', () => {
  // A 2x2 table transposes to its own transpose: the header row becomes the
  // first column and the data row becomes the second.
  const text = toJson({ header: ['a', 'b'], rows: [[1, 2]] }, { indent: 0, transpose: true });
  assert.deepStrictEqual(JSON.parse(text), [{ a: 'b', 1: 2 }]);

  // A taller table: the header row and the 1/3 column become rows, keyed by the
  // transposed header ['a', 1, 3].
  const rect = toJson({ header: ['a', 'b'], rows: [[1, 2], [3, 4]] }, { indent: 0, transpose: true });
  assert.deepStrictEqual(JSON.parse(rect), [{ a: 'b', 1: 2, 3: 4 }]);
});

test('stringify: fromJson writes an array of objects with a header', () => {
  const csv = fromJson([{ a: 1, b: 'x,y' }], W);
  assert.strictEqual(csv, 'a,b\n1,"x,y"\n');
});

test('stringify: fromJson unions keys across objects in first-seen order', () => {
  const csv = fromJson([{ a: 1 }, { b: 2 }], W);
  assert.strictEqual(csv, 'a,b\n1,\n,2\n');
});

test('stringify: fromJson handles an array of arrays', () => {
  assert.strictEqual(fromJson([['a', 'b'], ['1', '2']], W), 'a,b\n1,2\n');
});

test('stringify: fromJson handles the columns shape', () => {
  const csv = fromJson({ columns: { a: [1, 2], b: [3, 4] }, rows: 2 }, W);
  assert.strictEqual(csv, 'a,b\n1,3\n2,4\n');
});

test('stringify: fromJson accepts the columns shape with a rows array', () => {
  const csv = fromJson({ columns: { a: [1, 2] }, rows: [] }, W);
  assert.strictEqual(csv, 'a\n1\n2\n');
});

test('stringify: fromJson --no-header omits the header record', () => {
  const csv = fromJson([{ a: 1, b: 2 }], Object.assign({}, W, { header: false }));
  assert.strictEqual(csv, '1,2\n');
});

test('stringify: fromJson rejects a scalar', () => {
  assert.throws(() => fromJson(42, W), TypeError);
});

test('stringify: null and undefined become empty fields', () => {
  assert.strictEqual(stringifyRow([null, undefined, 'x'], W), ',,x');
});

test('stringify: columnsToRows builds records from columns', () => {
  assert.deepStrictEqual(columnsToRows({ a: [1, 2], b: [3, 4] }, 2), [
    [1, 3],
    [2, 4],
  ]);
});

test('stringify: embedded newlines survive a write', () => {
  const csv = stringify(['a'], [['x\ny']], W);
  assert.strictEqual(csv, 'a\n"x\ny"\n');
});