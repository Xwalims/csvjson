'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseCsv } = require('../src/parse.js');
const {
  setKey,
  ownValue,
  toJson,
  fromJson,
  transposeTable,
  columnsToRows,
  stringify,
} = require('../src/stringify.js');

const ND = { detect: false, delimiter: ',', quote: '"' };

// A header is whatever the first CSV record holds, and `__proto__` is a legal
// string in a CSV file. These tests pin the promise that the JSON layer keeps
// such a column as DATA.
//
// `__proto__` is not a property of the prototype; it is an ACCESSOR on
// `Object.prototype`. `obj[key] = value` therefore runs a setter that replaces
// the object's prototype instead of creating a key, and the value is gone --
// not hidden, gone: `Object.keys` skips it, `hasOwnProperty` says no, and
// `JSON.stringify` omits it. `Object.defineProperty` creates a real own data
// property, which is exactly what `JSON.parse` does for the same bytes.
// Ground truth for every assertion below is what native `JSON.parse` and
// `JSON.stringify` do with equivalent data, or `JSON.parse(json)` round-trips.

test('setKey writes __proto__ as an own data property', () => {
  const o = {};
  setKey(o, '__proto__', 1);
  assert.deepStrictEqual(Object.keys(o), ['__proto__']);
  assert.ok(Object.prototype.hasOwnProperty.call(o, '__proto__'));
  assert.strictEqual(o.__proto__, 1);
  // The prototype must be untouched: that is the whole difference.
  assert.strictEqual(Object.getPrototypeOf(o), Object.prototype);
  assert.strictEqual(JSON.stringify(o), '{"__proto__":1}');
});

test('setKey leaves the ordinary names alone', () => {
  // `constructor` and friends are plain data properties on the prototype, so a
  // plain assignment already creates an own property that shadows the inherited
  // one -- exactly as JSON.parse does. Escaping them would be a second bug.
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const o = {};
    setKey(o, key, 1);
    assert.deepStrictEqual(Object.keys(o), [key], key);
    assert.strictEqual(o[key], 1, key);
  }
});

test('toJson objects shape keeps a column named __proto__', () => {
  const table = parseCsv('__proto__,a\n1,2\n', ND);
  const text = toJson(table, { shape: 'objects', indent: 0 });
  // The data is present and the record has the same key count as the header.
  assert.strictEqual(text, '[{"__proto__":1,"a":2}]');
  assert.deepStrictEqual(Object.keys(JSON.parse(text)[0]), ['__proto__', 'a']);
});

test('toJson ndjson shape keeps a column named __proto__', () => {
  const table = parseCsv('__proto__,a\n1,2\n', ND);
  const text = toJson(table, { shape: 'ndjson' });
  assert.strictEqual(text, '{"__proto__":1,"a":2}');
});

test('toJson columns shape keeps a column named __proto__', () => {
  const table = parseCsv('__proto__,a\n1,2\n3,4\n', ND);
  const text = toJson(table, { shape: 'columns', indent: 0 });
  // In this shape the value is an ARRAY, so the broken assignment did not just
  // drop the column: it swapped the prototype of the `columns` object for that
  // array, making the returned object look like an array to anything inspecting
  // it in-process while the text stayed innocuous.
  const payload = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(payload.columns), ['__proto__', 'a']);
  assert.strictEqual(payload.rows, 2);
  assert.deepStrictEqual(payload.columns['__proto__'], [1, 3]);
  assert.strictEqual(text, '{"columns":{"__proto__":[1,3],"a":[2,4]},"rows":2}');
});

test('toJson columns shape does not hand back an array-prototyped object', () => {
  // Pinned directly, not through the text: the failure mode was a mutated
  // prototype on the in-process value, which JSON.stringify hides.
  const table = parseCsv('__proto__,a\n1,2\n', ND);
  const payload = JSON.parse(toJson(table, { shape: 'columns', indent: 0 }));
  assert.strictEqual(Object.getPrototypeOf(payload.columns), Object.prototype);
  assert.strictEqual(Array.isArray(Object.getPrototypeOf(payload.columns)), false);
});

test('a header that is ONLY __proto__ still yields one key per row', () => {
  // The narrowest form of the bug: one column in, and every record came back
  // with zero keys, i.e. a file of one column parsed to nothing at all.
  const table = parseCsv('__proto__\n1\n2\n', ND);
  const parsed = JSON.parse(toJson(table, { shape: 'objects', indent: 0 }));
  assert.strictEqual(parsed.length, 2);
  for (const row of parsed) assert.deepStrictEqual(Object.keys(row), ['__proto__']);
});

test('toJson --transpose keeps a row named __proto__', () => {
  // Transpose puts the first column's name into the header of the result, so a
  // `__proto__` header travels through transposeTable() and out the other side.
  //
  // The key ORDER here is V8's, not ours: `1` is an array-index-like key and
  // `__proto__` is not, so the integer is hoisted ahead of the string. That is
  // the same property README documents for numeric headers, so the assertion
  // checks the data and the key set rather than a sequence.
  const table = parseCsv('__proto__,a\n1,2\n', ND);
  const text = toJson(table, { shape: 'objects', indent: 0, transpose: true });
  const parsed = JSON.parse(text)[0];
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['1', '__proto__']);
  assert.strictEqual(parsed['__proto__'], 'a');
  assert.strictEqual(parsed[1], 2);
});

test('fromJson keeps a literal __proto__ key and does not invent one', () => {
  // ownValue() is the mirror of setKey() and matters in the other direction.
  // `fromJson` unions the key names across every record, so `__proto__` enters
  // the header even though only the FIRST record has that cell. Reading
  // `obj['__proto__']` on the second record goes through the inherited accessor
  // and returns Object.prototype, so the missing cell was written as
  // `[object Object]` -- data invented for a cell the record never had.
  const data = JSON.parse('[{"__proto__":{"p":1},"a":1},{"a":2}]');
  assert.deepStrictEqual(Object.keys(data[0]), ['__proto__', 'a']);
  assert.deepStrictEqual(Object.keys(data[1]), ['a']);
  assert.strictEqual(String(data[1]['__proto__']), '[object Object]'); // the trap
  assert.strictEqual(ownValue(data[1], '__proto__'), undefined); // the fix
  assert.strictEqual(fromJson(data, { delimiter: ',' }), '__proto__,a\n[object Object],1\n,2\n');
});

test('ownValue returns undefined for a name the record does not carry', () => {
  assert.strictEqual(ownValue({ a: 1 }, 'b'), undefined);
  // A present-but-undefined value is still present; it is not the same as
  // absent, and both render as an empty field, but only one is a cell.
  assert.strictEqual(ownValue({ a: undefined }, 'a'), undefined);
  assert.ok(Object.prototype.hasOwnProperty.call({ a: undefined }, 'a'));
  assert.strictEqual(ownValue({ a: null }, 'a'), null);
  assert.strictEqual(ownValue({ a: 0 }, 'a'), 0);
});

test('csv -> json -> csv is byte-identical with a __proto__ column', () => {
  // The end-to-end promise: no column is lost, so the bytes survive the cycle.
  const csv = '__proto__,a\n1,2\n3,4\n';
  const table = parseCsv(csv, ND);
  const back = fromJson(JSON.parse(toJson(table, { shape: 'objects', indent: 0 })), {
    delimiter: ',',
    quote: '"',
  });
  assert.strictEqual(back, csv);
});

test('a __proto__ column survives the columns shape round trip', () => {
  const table = parseCsv('__proto__,a\n1,2\n3,4\n', ND);
  const payload = JSON.parse(toJson(table, { shape: 'columns', indent: 0 }));
  const back = fromJson(payload, { delimiter: ',', quote: '"' });
  assert.strictEqual(back, '__proto__,a\n1,2\n3,4\n');
});

test('stringify and columnsToRows write a __proto__ header as text', () => {
  // These two build CSV text from a header array directly, so they never go
  // through an object at all -- pinned to prove the bug is confined to the JSON
  // layer and that the fix did not have to widen.
  assert.strictEqual(stringify(['__proto__', 'a'], [['1', '2']], { delimiter: ',' }), '__proto__,a\n1,2\n');
  const columns = {};
  setKey(columns, '__proto__', [1, 3]);
  setKey(columns, 'a', [2, 4]);
  assert.deepStrictEqual(columnsToRows(columns, 2), [[1, 2], [3, 4]]);
  assert.strictEqual(fromJson({ columns, rows: 2 }, { delimiter: ',' }), '__proto__,a\n1,2\n3,4\n');
});

test('transposeTable round-trips a table whose header holds __proto__', () => {
  const t = { header: ['__proto__', 'a'], rows: [[1, 2], [3, 4]] };
  const once = transposeTable(t);
  assert.deepStrictEqual(once.header, ['__proto__', 1, 3]);
  assert.deepStrictEqual(transposeTable(once).header, ['__proto__', 'a']);
});

test('the emitted JSON re-parses with JSON.parse and keeps the key', () => {
  // The strongest available oracle: JSON.parse is the reference implementation
  // for "a key named __proto__ in a document", and it disagrees with nothing
  // here. Compare against what JSON.parse itself yields for the same values.
  const table = parseCsv('__proto__,a\n1,2\n', ND);
  const ours = JSON.parse(toJson(table, { shape: 'objects', indent: 0 }));
  const theirs = JSON.parse('[{"__proto__":1,"a":2}]');
  assert.deepStrictEqual(Object.keys(ours[0]), Object.keys(theirs[0]));
  assert.strictEqual(ours[0]['__proto__'], theirs[0]['__proto__']);
});