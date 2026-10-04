'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseCsv,
  detectDelimiter,
  detectQuote,
  applyRagged,
  sniff,
  RAGGED_MODES,
} = require('../src/parse.js');
const { RaggedRowError, CsvError } = require('../src/tokenize.js');

test('parse: basic table with header', () => {
  const t = parseCsv('a,b,c\n1,2,3\n', { detect: false });
  assert.deepStrictEqual(t.header, ['a', 'b', 'c']);
  assert.deepStrictEqual(t.rows, [[1, 2, 3]]);
  assert.strictEqual(t.columnCount, 3);
  assert.strictEqual(t.rowCount, 1);
});

test('parse: embedded comma in a quoted field', () => {
  const t = parseCsv('name,note\nx,"a,b"', { detect: false });
  assert.deepStrictEqual(t.rows, [['x', 'a,b']]);
});

test('parse: embedded CRLF survives into the cell untouched', () => {
  const t = parseCsv('a,b\n1,"x\r\ny"', { detect: false });
  assert.strictEqual(t.rows[0][1], 'x\r\ny');
});

test('parse: BOM is stripped from the first header cell', () => {
  const t = parseCsv('﻿a,b\n1,2', { detect: false });
  assert.deepStrictEqual(t.header, ['a', 'b']);
});

test('parse: --no-header keeps the first record as data', () => {
  const t = parseCsv('1,2\n3,4', { detect: false, header: false });
  assert.strictEqual(t.header, null);
  assert.deepStrictEqual(t.rows, [[1, 2], [3, 4]]);
});

test('parse: unterminated quote throws with a line number', () => {
  assert.throws(() => parseCsv('a,b\nc,"open\nd,e', { detect: false }), (err) => {
    assert.strictEqual(err.code, 'E_UNTERMINATED_QUOTE');
    assert.strictEqual(err.line, 2);
    return true;
  });
});

test('parse: detects comma, semicolon, tab and pipe', () => {
  assert.strictEqual(detectDelimiter('a,b,c\n1,2,3\n4,5,6'), ',');
  assert.strictEqual(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.strictEqual(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.strictEqual(detectDelimiter('a|b\n1|2'), '|');
});

test('parse: detection ignores delimiters inside quoted regions', () => {
  // Semicolon is the real delimiter; the commas live inside a quoted field.
  assert.strictEqual(detectDelimiter('a;b\n"x,y,z";2'), ';');
});

test('parse: detection falls back to comma for single-column data', () => {
  assert.strictEqual(detectDelimiter('alpha\nbeta\ngamma'), ',');
});

test('parse: detects double and single quotes', () => {
  assert.strictEqual(detectQuote('a,"b,c"'), '"');
  assert.strictEqual(detectQuote("a,'b,c'"), "'");
  assert.strictEqual(detectQuote('a,b,c'), '"');
});

test('parse: an unclosed quote does not hide the real delimiter', () => {
  // Regression: the sniffer inferred the quote character as it walked, so a
  // single unclosed opener latched "inside quotes" for the rest of the sample
  // and every delimiter after it became invisible. Detection answered the ','
  // fallback for files that were plainly tab- or semicolon-separated.
  //
  // Ground truth is python's csv.reader. On '"\t\'x\r\ny\'\t\'x\ry\'\t\r' it
  // reports [["'", 'x\r\ny', 'x\ry', '']] -- three tab delimiters and no closing
  // quote at all, because a '"' at the head of the first field is plain data
  // under a dialect whose quotechar is "'".
  assert.strictEqual(detectDelimiter('"\t\'x\r\ny\'\t\'x\ry\'\t\r'), '\t');
  assert.strictEqual(detectDelimiter('";emoji☃\r'), ';');
  assert.strictEqual(detectDelimiter("\r';日本;NaN;;a\r"), ';');

  // The commit-to-one-reading rule, on the shortest inputs that separate it from
  // "score every reading and keep the best". In each, detectQuote picks the quote
  // character that strands an opener, so the '"' reading ends inside a quoted
  // field and its tally is empty; the other reading terminates and sees the real
  // delimiter. Ground truth (python's csv.reader, quotechar "'") on '"a|' gives
  // [['"a', '']] -- two columns split on the pipe -- while under quotechar '"' the
  // same bytes are a single unterminated field with no delimiter visible at all.
  // Score the stranded reading anyway and detection answers the ',' fallback, so
  // the pipe that python finds is silently lost.
  assert.strictEqual(detectQuote('"a|'), '"');
  assert.strictEqual(sniff('"a|', '"').unterminated, true);
  assert.strictEqual(sniff('"a|', "'").unterminated, false);
  assert.strictEqual(detectDelimiter('"a|'), '|');
  assert.strictEqual(detectDelimiter('"|'), '|');
  assert.strictEqual(detectDelimiter("';;"), ';');

  // A genuinely single-column file, where no candidate delimiter appears at all
  // and every reading terminates cleanly: there is nothing to detect, so the ','
  // fallback stands. ('|"\n' is NOT such a case -- under quotechar "'" the pipe is
  // plainly visible, so '|' is the right answer and the guard still applies.)
  assert.strictEqual(detectDelimiter('alpha\nbeta\ngamma'), ',');
  assert.strictEqual(detectDelimiter('alpha\nbeta\ngamma', '"'), ',');
});

test('parse: detectDelimiter honours an explicit quote character', () => {
  // With the quote character fixed there is no guessing, so the delimiter is
  // scored under exactly the reading the parser will use.
  assert.strictEqual(detectDelimiter('a;b\n"x,y";2', '"'), ';');
  assert.strictEqual(detectDelimiter('a;b\n"x,y";2', "'"), ';');
});

test('parse: sniff reports an unterminated quote rather than inventing tallies', () => {
  // The returned shape carries enough information for detectDelimiter to reject
  // a reading in which the file is not CSV, which is the whole fix.
  const stuck = sniff('"unterminated\tfield', '"');
  assert.strictEqual(stuck.unterminated, true);
  const clean = sniff('a\tb\n1\t2', '"');
  assert.strictEqual(clean.unterminated, false);
  assert.deepStrictEqual(clean.stats.get('\t'), [1, 1]);
});

test('parse: detection scores the delimiter under the quote character it will use', () => {
  // 'a;b\n"x,y,z";2' read with quotechar '"' has its commas inside a quoted field,
  // so the semicolon is the only delimiter visible and wins. Read with quotechar
  // "'" the file is also perfectly valid CSV -- the double quotes are then just
  // data, so the comma really does separate two fields -- and ',' outscores ';'.
  // Both answers are correct for the dialect they assume, which is why detection
  // has to pick a reading and commit to it instead of blending two scores.
  //
  // Earlier this function scored both readings and kept the best, so the
  // quote-disabled reading could outvote the real one; and before that it guessed
  // the quote character mid-walk, which lost the delimiter outright.
  assert.strictEqual(detectDelimiter('a;b\n"x,y,z";2', '"'), ';');
  assert.strictEqual(detectDelimiter('a;b\n"x,y,z";2', "'"), ',');

  // End to end the parse uses detectQuote's answer, and the quoted field
  // survives as one cell -- 'a;b' is the header, so the data row is column 0.
  const t = parseCsv('a;b\n"x,y,z";2');
  assert.strictEqual(t.delimiter, ';');
  assert.strictEqual(t.quote, '"');
  assert.deepStrictEqual(t.header, ['a', 'b']);
  assert.strictEqual(t.rows[0][0], 'x,y,z');
  assert.strictEqual(t.rows[0][1], 2);
});

test('parse: end-to-end dialect detection picks the right separator and quote', () => {
  const t = parseCsv("a;b;c\n'x,y';2;3");
  assert.strictEqual(t.delimiter, ';');
  assert.strictEqual(t.quote, "'");
  assert.strictEqual(t.rows[0][0], 'x,y');
});

test('parse: explicit --delimiter wins over detection', () => {
  const t = parseCsv('a|b\n1|2', { delimiter: '|' });
  assert.strictEqual(t.delimiter, '|');
  assert.deepStrictEqual(t.rows, [[1, 2]]);
});

test('parse: --no-detect uses the plain comma default', () => {
  // Semicolons are literal data once detection is off, so this is one column.
  const t = parseCsv('a;b\n1;2', { detect: false });
  assert.strictEqual(t.delimiter, ',');
  assert.strictEqual(t.columnCount, 1);
  assert.deepStrictEqual(t.rows, [['1;2']]);
});

test('parse: ragged pad fills short rows', () => {
  const t = parseCsv('a,b,c\n1,2\n4,5,6', {
    detect: false,
    ragged: 'pad',
    types: 'all-string',
  });
  assert.strictEqual(t.rows.length, 2);
  assert.strictEqual(t.rows[0].length, 3);
  assert.strictEqual(t.rows[0][2], '');
  assert.strictEqual(t.ragged.length, 1);
});

test('parse: ragged pad honours --pad-value', () => {
  const t = parseCsv('a,b,c\n1,2\n', {
    detect: false,
    ragged: 'pad',
    padValue: 'NA',
    types: 'all-string',
  });
  assert.deepStrictEqual(t.rows, [['1', '2', 'NA']]);
});

test('parse: ragged pad truncates overflow to keep a rectangular table', () => {
  const t = parseCsv('a,b\n1,2,3,4', { detect: false, ragged: 'pad' });
  assert.strictEqual(t.rows.length, 1);
  assert.strictEqual(t.rows[0].length, 2);
});

test('parse: ragged error throws on the first width mismatch', () => {
  assert.throws(
    () => parseCsv('a,b,c\n1,2\n1,2,3', { detect: false, ragged: 'error' }),
    (err) => {
      assert.ok(err instanceof RaggedRowError);
      assert.strictEqual(err.code, 'E_RAGGED_ROW');
      assert.strictEqual(err.expected, 3);
      assert.strictEqual(err.width, 2);
      return true;
    }
  );
});

test('parse: ragged dump moves overflow into an array cell', () => {
  const t = parseCsv('a,b,c\n1,2,3,4', { detect: false, ragged: 'dump' });
  assert.deepStrictEqual(t.rows[0][0], 1);
  assert.deepStrictEqual(t.rows[0][2], ['3', '4']);
});

test('parse: ragged dump still pads short rows', () => {
  const t = parseCsv('a,b,c\n1,2\n', {
    detect: false,
    ragged: 'dump',
    types: 'all-string',
  });
  assert.strictEqual(t.rows[0].length, 3);
  assert.strictEqual(t.rows[0][2], '');
});

test('parse: applyRagged is usable directly', () => {
  const recs = [
    { fields: ['1', '2'], line: 1, rowIndex: 0 },
    { fields: ['3'], line: 2, rowIndex: 1 },
  ];
  assert.deepStrictEqual(applyRagged(recs, 2, { ragged: 'pad', padValue: '' }), [
    ['1', '2'],
    ['3', ''],
  ]);
});

test('parse: an unknown ragged mode is rejected', () => {
  assert.throws(() => applyRagged([['1']], 1, { ragged: 'nope' }), CsvError);
});

test('parse: an unknown types mode is rejected', () => {
  assert.throws(() => parseCsv('a\n1', { types: 'weird' }), CsvError);
});

test('parse: empty input produces an empty table', () => {
  const t = parseCsv('', { detect: false });
  assert.deepStrictEqual(t.header, null);
  assert.deepStrictEqual(t.rows, []);
  assert.strictEqual(t.columnCount, 0);
});

test('parse: a header-only document has no data rows', () => {
  const t = parseCsv('a,b,c\n', { detect: false });
  assert.deepStrictEqual(t.header, ['a', 'b', 'c']);
  assert.deepStrictEqual(t.rows, []);
});

test('parse: rejects a non-string input', () => {
  assert.throws(() => parseCsv(null), TypeError);
});

test('parse: RAGGED_MODES lists the three policies', () => {
  assert.deepStrictEqual(RAGGED_MODES, ['pad', 'error', 'dump']);
});