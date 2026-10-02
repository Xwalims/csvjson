'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  tokenize,
  Tokenizer,
  DEFAULTS,
  UnterminatedQuoteError,
  CsvError,
  EXIT_DATA_ERROR,
} = require('../src/tokenize.js');

const opts = (o) => Object.assign({ delimiter: ',', quote: '"' }, o);

test('tokenizer: splits plain records', () => {
  assert.deepStrictEqual(tokenize('a,b,c\nd,e,f', opts()), [
    ['a', 'b', 'c'],
    ['d', 'e', 'f'],
  ]);
});

test('tokenizer: empty input yields no records', () => {
  assert.deepStrictEqual(tokenize('', opts()), []);
});

test('tokenizer: preserves a delimiter inside a quoted field', () => {
  assert.deepStrictEqual(tokenize('a,"b,c",d', opts()), [['a', 'b,c', 'd']]);
});

test('tokenizer: preserves an embedded CRLF byte-for-byte', () => {
  const rows = tokenize('a,b\r\n1,"x\r\ny"\r\n', opts());
  assert.strictEqual(rows.length, 2);
  // Not normalised to \n, and not converted to two records.
  assert.strictEqual(rows[1][1], 'x\r\ny');
});

test('tokenizer: preserves a bare CR inside a quoted field', () => {
  const rows = tokenize('a,"x\ry",z', opts());
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][1], 'x\ry');
});

test('tokenizer: preserves a bare LF inside a quoted field', () => {
  const rows = tokenize('a,"x\ny",z', opts());
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][1], 'x\ny');
});

test('tokenizer: unescapes a doubled quote', () => {
  assert.deepStrictEqual(tokenize('a,"b""c"', opts()), [['a', 'b"c']]);
});

test('tokenizer: parses a quoted field holding exactly one quote character', () => {
  // """ is: open quote, escaped quote, close quote
  assert.deepStrictEqual(tokenize('a,"""",b', opts()), [['a', '"', 'b']]);
});

test('tokenizer: keeps a quote that is not at a field start as data', () => {
  assert.deepStrictEqual(tokenize('a,b"c,d', opts()), [['a', 'b"c', 'd']]);
});

test('tokenizer: empty fields and a trailing delimiter', () => {
  assert.deepStrictEqual(tokenize('a,b,', opts()), [['a', 'b', '']]);
  assert.deepStrictEqual(tokenize(',,', opts()), [['', '', '']]);
});

test('tokenizer: a blank line is a one-field record', () => {
  assert.deepStrictEqual(tokenize('a,b\n\nc,d', opts()), [
    ['a', 'b'],
    [''],
    ['c', 'd'],
  ]);
});

test('tokenizer: accepts input with no trailing newline', () => {
  assert.deepStrictEqual(tokenize('a,b\nc,d', opts()), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('tokenizer: CRLF record breaks do not create phantom records', () => {
  assert.deepStrictEqual(tokenize('a,b\r\nc,d\r\n', opts()), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('tokenizer: CR-only record breaks', () => {
  assert.deepStrictEqual(tokenize('a,b\rc,d\r', opts()), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('tokenizer: strips a leading UTF-8 BOM', () => {
  assert.deepStrictEqual(tokenize('﻿a,b\nc,d', opts()), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('tokenizer: BOM is only stripped at the very start', () => {
  const rows = tokenize('a,b\n\uFEFFc,d', opts());
  assert.strictEqual(rows[1][0], '\uFEFFc');
});

test('tokenizer: reports an unterminated quote with a line number', () => {
  assert.throws(
    () => tokenize('a,b\nc,"unclosed\nmore,data', opts()),
    (err) => {
      assert.ok(err instanceof UnterminatedQuoteError);
      assert.ok(err instanceof CsvError);
      assert.strictEqual(err.code, 'E_UNTERMINATED_QUOTE');
      assert.strictEqual(err.line, 2, 'opening quote is on line 2');
      assert.strictEqual(err.exitCode, EXIT_DATA_ERROR);
      return true;
    }
  );
});

test('tokenizer: an unterminated quote does not hang or swallow input', () => {
  // push() must not throw for an open quote; the error surfaces at flush().
  const tz = new Tokenizer(opts());
  tz.push('a,"open');
  assert.strictEqual(tz.rows.length, 0);
  assert.throws(() => tz.flush(), UnterminatedQuoteError);
});

test('tokenizer: unterminated quote on the first line reports line 1', () => {
  assert.throws(() => tokenize('a,"b', opts()), (err) => {
    assert.strictEqual(err.line, 1);
    return true;
  });
});

test('tokenizer: the reported column is relative to the record, not the file', () => {
  // Regression: column used to keep counting across record boundaries, so the
  // opening quote on line 2 was reported at column 6 instead of 3.
  assert.throws(() => tokenize('a,b\nc,"unterminated\nd,e\n', opts()), (err) => {
    assert.strictEqual(err.line, 2);
    assert.strictEqual(err.column, 3);
    return true;
  });
  // The same quote at the start of a longer document.
  assert.throws(() => tokenize('x,y,z\n1,2,3\n4,"open', opts()), (err) => {
    assert.strictEqual(err.line, 3);
    assert.strictEqual(err.column, 3);
    return true;
  });
});

test('tokenizer: streaming in single-char chunks equals one-shot', () => {
  const input = 'a,"b\r\nc",d\r\n"e""f",g,"h\n\n i"\r\n,';
  const oneShot = tokenize(input, opts());
  const tz = new Tokenizer(opts());
  for (const ch of input) tz.push(ch);
  tz.flush();
  // rows is the tokenizer's live array, so copy it only after the final flush.
  assert.deepStrictEqual(tz.rows.slice(), oneShot);
  assert.deepStrictEqual(oneShot[0], ['a', 'b\r\nc', 'd']);
  assert.deepStrictEqual(oneShot[1], ['e"f', 'g', 'h\n\n i']);
});

test('tokenizer: chunk boundary splitting a CRLF pair is handled', () => {
  const tz = new Tokenizer(opts());
  tz.push('a,b\r');
  const early = tz.rows.length;
  tz.push('\nc,d');
  const rows = tz.flush();
  assert.strictEqual(early, 1, 'the CR already closed the first record');
  assert.deepStrictEqual(rows, [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('tokenizer: chunk boundary splitting a doubled quote is handled', () => {
  const input = 'a,"b""c",d';
  const tz = new Tokenizer(opts());
  tz.push('a,"b"');
  tz.push('"c",d');
  assert.deepStrictEqual(tz.flush(), [['a', 'b"c', 'd']]);
});

test('tokenizer: positions mode reports line and rowIndex', () => {
  const rows = tokenize('a,b\n"x\ny",c\nd,e', opts({ positions: true }));
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].line, 1);
  assert.strictEqual(rows[0].rowIndex, 0);
  // Row 2 starts on line 2 but its field spans a newline.
  assert.strictEqual(rows[1].line, 2);
  assert.strictEqual(rows[2].line, 4);
});

test('tokenizer: honours an alternate delimiter', () => {
  assert.deepStrictEqual(tokenize('a;b;c', opts({ delimiter: ';' })), [['a', 'b', 'c']]);
});

test('tokenizer: honours an alternate quote character', () => {
  assert.deepStrictEqual(tokenize("a,'b,c',d", opts({ quote: "'" })), [['a', 'b,c', 'd']]);
});

test('tokenizer: tab delimiter', () => {
  assert.deepStrictEqual(tokenize('a\tb\n1\t2', opts({ delimiter: '\t' })), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('tokenizer: rejects a non-string input', () => {
  assert.throws(() => tokenize(123, opts()), TypeError);
});

test('tokenizer: DEFAULTS is frozen and shared', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.strictEqual(DEFAULTS.delimiter, null);
  assert.strictEqual(DEFAULTS.quote, null);
  assert.strictEqual(EXIT_DATA_ERROR, 3);
});