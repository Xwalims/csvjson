'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyCell,
  coerce,
  inferColumn,
  inferRows,
  toNumber,
  toBoolean,
  TYPES,
} = require('../src/infer.js');

test('infer: classifies individual cells', () => {
  assert.strictEqual(classifyCell(''), 'null');
  assert.strictEqual(classifyCell('  '), 'null');
  assert.strictEqual(classifyCell('42'), 'number');
  assert.strictEqual(classifyCell('-3.5'), 'number');
  assert.strictEqual(classifyCell('1e3'), 'number');
  assert.strictEqual(classifyCell('true'), 'boolean');
  assert.strictEqual(classifyCell('FALSE'), 'boolean');
  assert.strictEqual(classifyCell('hello'), 'string');
  assert.strictEqual(classifyCell('12abc'), 'string');
});

test('infer: toNumber handles grouped thousands and rejects junk', () => {
  assert.strictEqual(toNumber('1,234.5'), 1234.5);
  assert.strictEqual(toNumber('1,234'), 1234);
  assert.strictEqual(toNumber('12abc'), null);
  assert.strictEqual(toNumber(''), null);
  assert.strictEqual(toNumber(' 7 '), 7);
});

test('infer: toBoolean is strict about its literals', () => {
  assert.strictEqual(toBoolean('true'), true);
  assert.strictEqual(toBoolean('False'), false);
  assert.strictEqual(toBoolean('yes'), null);
});

test('infer: a numeric column is typed number', () => {
  assert.strictEqual(inferColumn(['1', '2', '3']), 'number');
});

test('infer: one non-numeric cell keeps the whole column string', () => {
  // This is the column-atomic rule: no "10" next to 10.
  assert.strictEqual(inferColumn(['1', 'high', '3']), 'string');
});

test('infer: blank cells do not veto a numeric column', () => {
  assert.strictEqual(inferColumn(['1', '', '3']), 'number');
});

test('infer: a boolean column is typed boolean', () => {
  assert.strictEqual(inferColumn(['true', 'false']), 'boolean');
});

test('infer: mixed booleans and numbers fall back to string', () => {
  assert.strictEqual(inferColumn(['true', '1']), 'string');
});

test('infer: an all-null column is typed null', () => {
  assert.strictEqual(inferColumn(['', '', '']), 'null');
});

test('infer: all-string mode overrides inference', () => {
  assert.strictEqual(inferColumn(['1', '2'], { types: 'all-string' }), 'string');
});

test('infer: forced modes override inference', () => {
  assert.strictEqual(inferColumn(['1', 'x'], { types: 'number' }), 'number');
  assert.strictEqual(inferColumn(['1', 'x'], { types: 'boolean' }), 'boolean');
  assert.strictEqual(inferColumn(['1', 'x'], { types: 'null' }), 'null');
});

test('infer: coerce respects the column type', () => {
  assert.strictEqual(coerce('42', 'number'), 42);
  assert.strictEqual(coerce('true', 'boolean'), true);
  assert.strictEqual(coerce('x', 'string'), 'x');
  assert.strictEqual(coerce('x', 'null'), null);
});

test('infer: auto mode nulls an unconvertible cell rather than leaking a string', () => {
  assert.strictEqual(coerce('high', 'number'), null);
  assert.strictEqual(coerce('maybe', 'boolean'), null);
});

test('infer: a forced mode preserves an unconvertible value verbatim', () => {
  assert.strictEqual(coerce('high', 'number', { force: true }), 'high');
});

test('infer: inferRows keeps a column internally consistent', () => {
  const { types, rows } = inferRows(
    [
      ['1', '10'],
      ['2', 'high'],
      ['3', '30'],
    ],
    2
  );
  assert.deepStrictEqual(types, ['number', 'string']);
  // score must be all strings, never the number 10 beside the string "high".
  for (const row of rows) assert.strictEqual(typeof row[1], 'string');
});

test('infer: inferRows pads short rows so every row has columnCount cells', () => {
  const { rows } = inferRows([['1'], ['2', '3']], 2);
  assert.strictEqual(rows.length, 2);
  for (const row of rows) assert.strictEqual(row.length, 2);
});

test('infer: all-string mode returns every cell as a string', () => {
  const { types, rows } = inferRows([['1', '2']], 2, { types: 'all-string' });
  assert.deepStrictEqual(types, ['string', 'string']);
  assert.deepStrictEqual(rows, [['1', '2']]);
});

test('infer: forced number mode keeps the raw string for junk cells', () => {
  const { rows } = inferRows([['1', 'x']], 2, { types: 'number' });
  assert.deepStrictEqual(rows, [[1, 'x']]);
});

test('infer: zero columns is handled', () => {
  const { types, rows } = inferRows([], 0);
  assert.deepStrictEqual(types, []);
  assert.deepStrictEqual(rows, []);
});

test('infer: TYPES lists every accepted mode', () => {
  assert.deepStrictEqual(TYPES, ['auto', 'all-string', 'number', 'boolean', 'null']);
});