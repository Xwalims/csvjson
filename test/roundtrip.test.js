'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseCsv } = require('../src/parse.js');
const { toJson, fromJson } = require('../src/stringify.js');

/**
 * Round-trip property: for a table, parsing the CSV written from it yields the
 * same records. We exercise this over a table of deliberately nasty documents,
 * comparing with all-string typing so the comparison is about the DATA and not
 * about type inference.
 */
const STRINGY = { types: 'all-string', ragged: 'pad', indent: 0 };

/** Documents written as literal CSV, each already in its canonical form. */
const TRICKY_CSV = [
  ['plain', 'a,b\n1,2\n'],
  ['embedded comma', 'a,b\n"x,y",2\n'],
  ['embedded CRLF preserved', 'a,b\r\n"x\r\ny",2\r\n'],
  ['embedded bare CR preserved', 'a,b\n"x\ry",2\n'],
  ['doubled quote escape', 'a,b\n"say ""hi""",2\n'],
  ['lone quote field', 'a,b\n"""",2\n'],
  ['empty fields', 'a,b,c\n,,\n'],
  ['trailing delimiter', 'a,b,c\n1,2,\n'],
  ['blank line', 'a,b\n\n1,2\n'],
  ['no trailing newline', 'a,b\n1,2'],
  ['CRLF records', 'a,b\r\n1,2\r\n'],
  ['whitespace needing quotes', 'a,b\n" pad ",2\n'],
  ['unicode', 'a,b\n"héllo → wörld",2\n'],
  ['delimiter in every column', 'a,b,c\n"1,1","2,2","3,3"\n'],
  ['quotes and commas together', 'a,b\n"a,""b"",c",2\n'],
  ['quoted empty field', 'a,b\n"",2\n'],
  ['newline only', 'a,b\n"\n",2\n'],
  ['CRLF only', 'a,b\r\n"\r\n",2\r\n'],
  ['leading BOM', '﻿a,b\n1,2\n'],
  ['quote as first char', 'a,b\n"""quoted""",2\n'],
  ['long field with newlines', 'a,b\n"1\n2\n3\n4\n5",2\n'],
  ['digits that must stay strings', 'a,b\n007,2.50\n'],
  ['multi-row with embedded newlines', 'a,b\n"x\ny",2\n"p\nq",3\n'],
];

/**
 * Write a parsed table back to canonical CSV, header included as row 0.
 * Using the raw table (not the objects shape) keeps header-only documents
 * intact, which a JSON objects round trip cannot represent.
 */
function csvFromTable(table, options) {
  const matrix = table.header ? [table.header, ...table.rows] : table.rows.slice();
  return fromJson(matrix, {
    delimiter: ',',
    quote: '"',
    header: false,
    indent: 0,
    types: 'all-string',
    ...options,
  });
}

/** The same tables expressed as records, for table -> CSV -> table checks. */
const TRICKY_TABLES = [
  [['a', 'b'], [['1', '2']]],
  [['a', 'b'], [['x,y', '2']]],
  [['a', 'b'], [['x\r\ny', '2']]],
  [['a', 'b'], [['say "hi"', '2']]],
  [['a', 'b'], [['"', '2']]],
  [['a', 'b'], [[' pad ', '2']]],
  [['a', 'b'], [['héllo → wörld', '2']]],
  [['a', 'b'], [['a,"b",c', '2']]],
  [['a', 'b', 'c'], [['', '', '']]],
  [['a', 'b'], [['\n', '2']]],
];

test('roundtrip: literal tricky documents survive a parse->write cycle', () => {
  for (const [name, csv] of TRICKY_CSV) {
    const parsed = parseCsv(csv, STRINGY);
    const written = csvFromTable(parsed, STRINGY);
    const reparsed = parseCsv(written, STRINGY);
    assert.deepStrictEqual(
      reparsed.rows,
      parsed.rows,
      `${name}: rows changed after round trip`
    );
    assert.deepStrictEqual(reparsed.header, parsed.header, `${name}: header changed`);
    // And the canonical form is byte-stable: writing twice gives the same text.
    const rewritten = csvFromTable(reparsed, STRINGY);
    assert.strictEqual(rewritten, written, `${name}: CSV output is not byte-stable`);
  }
});

test('roundtrip: table -> CSV -> table deep-equals the original', () => {
  for (const [header, rows] of TRICKY_TABLES) {
    const csv = fromJson([header, ...rows].map((r) => r), { delimiter: ',', quote: '"', header: false });
    const back = parseCsv(csv, STRINGY);
    assert.deepStrictEqual(back.header, header);
    assert.deepStrictEqual(back.rows, rows);
  }
});

test('roundtrip: an embedded newline stays inside its field, not a record break', () => {
  const parsed = parseCsv('a,b\n1,"x\ny"', STRINGY);
  assert.strictEqual(parsed.rowCount, 1, 'the newline must not split the record');
  assert.strictEqual(parsed.rows[0][1], 'x\ny');
});

test('roundtrip: a CRLF inside a field keeps both bytes', () => {
  const parsed = parseCsv('a,b\r\n1,"x\r\ny"\r\n', STRINGY);
  const written = fromJson([parsed.header, ...parsed.rows], {
    delimiter: ',',
    quote: '"',
    eol: '\r\n',
    header: false,
  });
  assert.strictEqual(written, 'a,b\r\n1,"x\r\ny"\r\n');
});

test('roundtrip: stringified output reparses to identical JSON', () => {
  const cases = [
    [{ a: 'x,y' }, { a: 'p\nq' }],
    [{ a: 'say "hi"' }],
    [{ a: '' }],
  ];
  for (const objs of cases) {
    const csv = fromJson(objs, { delimiter: ',', quote: '"' });
    const parsed = parseCsv(csv, STRINGY);
    const again = fromJson([parsed.header, ...parsed.rows], {
      delimiter: ',',
      quote: '"',
      header: false,
    });
    assert.strictEqual(again, csv);
  }
});

test('roundtrip: JSON shapes all survive a CSV bounce', () => {
  const table = { header: ['a', 'b'], rows: [[1, 'x,y'], [2, 'p\nq']] };
  const write = { delimiter: ',', quote: '"' };

  // objects
  const objs = JSON.parse(toJson(table, { shape: 'objects', indent: 0 }));
  const csvFromObjects = fromJson(objs, write);
  assert.ok(csvFromObjects.includes('"x,y"'), 'objects: the comma cell survived');
  assert.ok(csvFromObjects.includes('"p\nq"'), 'objects: the newline cell survived');

  // ndjson: one object per line, so read it back line by line
  const lines = toJson(table, { shape: 'ndjson' }).split('\n');
  assert.strictEqual(lines.length, 2);
  const fromNd = fromJson(lines.map((l) => JSON.parse(l)), write);
  assert.ok(fromNd.includes('"x,y"'), 'ndjson: the comma cell survived');

  // columns
  const cols = JSON.parse(toJson(table, { shape: 'columns', indent: 0 }));
  assert.deepStrictEqual(cols.columns.a, [1, 2]);
  const csvFromCols = fromJson(cols, write);
  assert.ok(csvFromCols.includes('"x,y"'), 'columns: the comma cell survived');
});

test('roundtrip: quoting is minimal, not blanket', () => {
  const csv = fromJson([{ a: 'plain', b: 'has,comma' }], { delimiter: ',', quote: '"' });
  assert.strictEqual(csv, 'a,b\nplain,"has,comma"\n');
});