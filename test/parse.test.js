'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseCsv,
  detectDelimiter,
  detectQuote,
  applyRagged,
  sniff,
  better,
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

test('parse: detection prefers a delimiter present in EVERY record', () => {
  // Regression: the score used to be `modal * modalCount + (modal / len) * 0.5`,
  // a sum dominated by the raw size of a count. A character appearing three
  // times in ONE record then outscored a character appearing twice in EVERY
  // record, and the comma-first tie-break handed it the file.
  //
  // Ground truth is python's csv.writer/csv.reader with delimiter='\t': the tab
  // separates every field of every record, while the commas are literal text
  // inside a single data record.
  const text = 'c0\tc1\tc2\r\nhas,comma\thas,comma\thas,comma\r\n';
  assert.strictEqual(detectDelimiter(text), '\t');
  // And the damage it caused, since detecting wrong is only half the story:
  // under ',' this file came back as ONE column with the header cells welded
  // into a single string, so two thirds of the table vanished with no error.
  const t = parseCsv(text, { types: 'all-string' });
  assert.deepStrictEqual(t.header, ['c0', 'c1', 'c2']);
  assert.deepStrictEqual(t.rows, [['has,comma', 'has,comma', 'has,comma']]);

  // Same shape, different rival characters and row widths. In each the true
  // delimiter is present in every record and the rival only in one, so
  // presence alone decides it.
  assert.strictEqual(detectDelimiter('c0\tc1\rhas;semi\thas;semi\r'), '\t');
  assert.strictEqual(detectDelimiter('has|pipe;has|pipe\r\nbb;x y\r\n'), ';');
});

test('parse: the ranking is agreement first, then presence, then width', () => {
  // The order between the top two keys cannot be pinned by any CSV string, and
  // the reason is worth stating rather than papering over.
  //
  // Over 4000 generated files where the answer is FULLY determined -- exactly
  // one of the four readings is rectangular, so no reader could differ -- the
  // two orders disagreed on NONE of them. On files where they do disagree, the
  // rival delimiter reproduces the same bytes under csv.writer in the large
  // majority of cases, so the file does not carry the information either.
  //
  // So the order is pinned on the ranking function itself, which is what
  // actually implements the policy, and the end-to-end tests above pin the
  // OUTCOME. Splitting them that way keeps each assertion honest instead of
  // attaching a key order to a sample whose reading was a coin flip.
  //
  // These vectors are the real disagreement shape: the rival is in MORE records
  // than the delimiter but spread unevenly, so it has no count its records
  // agree on, while the delimiter's records all agree.
  const rival = { regular: 1, present: 3, wide: 5, total: 7, order: 0 };
  const truth = { regular: 2, present: 2, wide: 2, total: 4, order: 1 };
  assert.strictEqual(better(rival, truth), false, 'agreement outranks presence');
  assert.strictEqual(better(truth, rival), true, 'and it is not a tie');

  // Presence decides when agreement ties: 2 records against 1.
  assert.strictEqual(
    better({ regular: 1, present: 2, wide: 1, total: 3, order: 1 },
           { regular: 1, present: 1, wide: 9, total: 9, order: 0 }),
    true,
    'presence outranks width');

  // Width decides next, then raw occurrences, then the documented candidate
  // order -- and that last one is a stable tie-break, not a coin toss.
  assert.strictEqual(
    better({ regular: 1, present: 1, wide: 3, total: 3, order: 1 },
           { regular: 1, present: 1, wide: 2, total: 8, order: 0 }),
    true,
    'width outranks total');
  assert.strictEqual(
    better({ regular: 1, present: 1, wide: 2, total: 5, order: 0 },
           { regular: 1, present: 1, wide: 2, total: 4, order: 1 }),
    true,
    'total breaks a tie on everything above it');
  assert.strictEqual(
    better({ regular: 1, present: 1, wide: 2, total: 4, order: 1 },
           { regular: 1, present: 1, wide: 2, total: 4, order: 0 }),
    false,
    'equal on every key, so the earlier candidate keeps the file');

  // Measured against python's csv.writer over 300000 files across five ragged
  // rates and five seeds, counting only the 2762 cases where the two orders
  // answer differently: agreement-first right on 1638, presence-first on 568.
  // The order is a real policy choice, and this pins which one was chosen.
  //
  // The shape it fixes, and the shape the old expectation used to pin: with the
  // tab real and ';' inside fields, 'c0;c1\nhas\ttab\na;has\ttab;1\n' is 2, 1
  // then 3 fields under ';' and 1, 2, 2 under the tab. Neither reading is
  // rectangular, so the bytes do not settle it -- which is why this test no
  // longer claims a delimiter for that string.
  assert.strictEqual(detectDelimiter('c0\tc1\tc2\r\nhas,comma\thas,comma\thas,comma\r\n'), '\t');
  const t = parseCsv('c0\tc1\tc2\r\nhas,comma\thas,comma\thas,comma\r\n',
                     { types: 'all-string' });
  assert.deepStrictEqual(t.header, ['c0', 'c1', 'c2']);
});

test('parse: detection prefers the rectangular reading over the ragged one', () => {
  // The real delimiter is the one present in EVERY record. A character that
  // shows up in one record only yields a table of inconsistent width, which no
  // CSV writer would have produced and which the reader then has to pad.
  //
  // Under ',' these two records are 1 field and 3 fields wide; under ';' both
  // are 2 wide (verified with python's csv.reader on the same bytes).
  assert.strictEqual(detectDelimiter('a;b\tc\rd;e\tf\n'), ';');
  // Here the rival is present in the FIRST record only and the true delimiter
  // in both, so ';' wins even though '|' is the wider read.
  assert.strictEqual(detectDelimiter('a|b|c\r\nx;y;z\r\n1;2;3\r\n'), ';');
});

test('parse: raw count breaks a tie on presence, width and agreement', () => {
  // The last substantive key. Two candidates can agree on every structural
  // measure -- same records, same modal width, same agreement -- and still
  // differ in raw occurrences, because one candidate's occurrences are spread
  // unevenly across records while the other's are not.
  //
  // Here the semicolon's per-record counts are [1,3] and the pipes' are [3,2]:
  // both present in both records, both modal width 3, both agreement 1, and
  // only the totals differ (4 against 5). Ground truth is python's csv.writer
  // with delimiter='|'; csv.reader gives widths [4,3,1] and shows the
  // semicolons living inside fields.
  const text = 'c0|c1|c2|c3\nb|has;semi|b\nhas;semi;has;semi\n';
  const semi = sniff(text, '"').stats.get(';');
  const pipe = sniff(text, '"').stats.get('|');
  assert.strictEqual(semi.join(), '1,3', 'semicolon raw counts');
  assert.strictEqual(pipe.join(), '3,2', 'pipe raw counts');
  assert.strictEqual(detectDelimiter(text), '|');
  assert.deepStrictEqual(parseCsv(text, { types: 'all-string' }).header,
    ['c0', 'c1', 'c2', 'c3']);
});

test('parse: a genuine tie between equally regular candidates keeps the documented order', () => {
  // Both candidates appear exactly once in every record, so the bytes do not
  // determine the answer and the candidate order (comma first) decides. Pinned
  // so the tie-break cannot drift into something arbitrary.
  assert.strictEqual(detectDelimiter('a;b\tc\r\nd;e\tf\r\n'), ';');
  assert.strictEqual(detectDelimiter('a,b;c\r\nd,e;f\r\n'), ',');

  // The degenerate form of the same thing: each candidate occurs in exactly ONE
  // record, once, so every key ties. python's csv.writer can produce exactly
  // these bytes with either delimiter, and csv.reader reads them back
  // differently under each, so no reader can do better than the documented
  // order. csv.reader under ';' gives widths [2,1,1], under '\t' [1,2,1].
  //
  // The winner is whichever candidate comes first in the candidate list, which
  // is [',', ';', '\t', '|'] -- so a ';' against '\t' tie is always ';', whichever
  // way round the bytes present them. Pinned in both directions because the
  // order, not the bytes, is what decides.
  assert.strictEqual(detectDelimiter('c0;c1\rhas\ttab\r1\r'), ';');
  assert.strictEqual(detectDelimiter('c0\tc1\rhas;semi\r1\r'), ';');
  // A '\t' against '|' tie likewise goes to the tab, the earlier candidate.
  assert.strictEqual(detectDelimiter('c0|c1\rhas\ttab\r1\r'), '\t');
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
  // "'" the double quotes are then plain data, so the commas DO become visible.
  //
  // Both answers are correct for the dialect they assume, which is why detection
  // has to pick a reading and commit to it instead of blending two scores.
  //
  // Earlier this function scored both readings and kept the best, so the
  // quote-disabled reading could outvote the real one; and before that it guessed
  // the quote character mid-walk, which lost the delimiter outright.
  assert.strictEqual(detectDelimiter('a;b\n"x,y,z";2', '"'), ';');
  assert.strictEqual(detectDelimiter('a;b\n"x,y,z";2', "'"), ';');

  // Under quotechar "'" the comma is absent from the FIRST record and appears
  // twice in the second, so sniff() tallies it as [2] -- one record, two
  // occurrences. The semicolon appears once in each record and tallies as
  // [1,1], i.e. two records that agree with each other. Both verified against
  // python's csv.reader on these bytes, which gives widths [1,3] under ',' and
  // [2,2] under ';'. Ranking by regularity first therefore keeps ';' even
  // though the comma reading is the wider one.
  //
  // This expectation used to be ','. That was the old score talking: the comma
  // reading has the bigger raw count, and the 0.5-weighted tie-break could not
  // make up for it. The bytes did not favour ',', so the old answer was an
  // artefact of the weighting rather than a property of the file. Confining the
  // claim to what survives is what keeps the test worth having.
  assert.strictEqual(sniff('a;b\n"x,y,z";2', "'").stats.get(',').join(), '2');
  assert.strictEqual(sniff('a;b\n"x,y,z";2', "'").stats.get(';').join(), '1,1');

  // The input that pins "commit to the first whole-file reading", as opposed to
  // "score both readings and keep the best". This one has to be chosen
  // carefully: the example above cannot, because under quotechar "'" it is also
  // valid CSV with ',' as the delimiter, so it settles nothing.
  //
  // Here the answer IS determined. csv.writer with delimiter='|' and
  // QUOTE_ALL emitted exactly these bytes, and only '|' reads back as a
  // rectangular 2-column table -- ',' gives 1 field per record, ';' and '\t'
  // give ragged pairs. With quotechar '"' the tabs live inside quoted fields,
  // so the tab reading sees one delimiter in the first record and two in the
  // second, which is the wider score the mutant prefers.
  //
  // Removing the `if (best) break;` answers '\t' here and fails this assertion,
  // which is what keeps that line from rotting into dead code.
  const quoted = '"\t"|"x y"\r"lead "|"\t"\r';
  assert.strictEqual(detectQuote(quoted), '"', 'quote character');
  assert.strictEqual(detectDelimiter(quoted), '|', 'commit to the first whole-file reading');
  const q = parseCsv(quoted, { types: 'all-string' });
  assert.strictEqual(q.delimiter, '|');
  assert.deepStrictEqual(q.header, ['\t', 'x y']);
  assert.deepStrictEqual(q.rows, [['lead ', '\t']]);
  assert.deepStrictEqual(q.ragged, [], 'the rectangular reading, no padding needed');

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