'use strict';

/**
 * Regression tests for a multi-character delimiter split across a chunk
 * boundary.
 *
 * The bug: `Tokenizer._isDelimiter` supports a multi-character delimiter, and so
 * does `stringify` (the writer joins with `options.delimiter` verbatim). But the
 * tokenizer consumed input strictly one character at a time, so a delimiter that
 * straddled two `push()` calls was never matched. Reading `a::b::c` one
 * character at a time with `delimiter: '::'` returned a single field
 * `a::b::c` instead of three fields -- silently. Nothing raised, nothing looked
 * wrong, the field boundaries had simply vanished.
 *
 * That is the worst shape of bug for a streaming parser, and it sat directly
 * under a documented feature: the README lists "chunk boundaries -- a `\r\n`
 * pair or a `""` escape split across reads is still tokenized correctly" as a
 * headline guarantee. It held for CRLF and `""` and nothing else.
 *
 * Reachability: the CLI rejects a multi-character delimiter (`--delimiter must
 * be a single character`), so no command-line user could hit this. The library
 * API could and still can -- `new Tokenizer({delimiter: '::'})` and
 * `stringify(..., {delimiter: '::'})` are both public and documented, so a
 * library user writing `::`-separated CSV could not read it back.
 */

const test = require('node:test');
const assert = require('node:assert');

const { Tokenizer } = require('../src/tokenize.js');
const { stringify } = require('../src/stringify.js');

/**
 * Parse `text` fed as `chunks`, returning records as plain arrays.
 *
 * `positions: true` is required: without it the tokenizer returns bare string[]
 * records and `.fields` is undefined. Every assertion below therefore fails
 * loudly (`undefined !== expected`) rather than silently passing.
 */
function parseChunked(text, delimiter, chunks) {
  const tz = new Tokenizer({ delimiter, quote: '"', positions: true });
  for (const chunk of chunks) tz.push(chunk);
  return tz.flush().map((rec) => (rec.blank ? [] : rec.fields));
}

/** Assert that every split point of `text` parses the same as one whole push. */
function assertChunkInvariant(text, delimiter) {
  const whole = parseChunked(text, delimiter, [text]);
  for (let k = 0; k <= text.length; k += 1) {
    assert.deepStrictEqual(
      parseChunked(text, delimiter, [text.slice(0, k), text.slice(k)]),
      whole,
      `split at ${k} of ${JSON.stringify(text)} with delimiter ${JSON.stringify(delimiter)}`
    );
  }
  assert.deepStrictEqual(
    parseChunked(text, delimiter, text.split('')),
    whole,
    `one character at a time: ${JSON.stringify(text)} with delimiter ${JSON.stringify(delimiter)}`
  );
  return whole;
}

test('a multi-character delimiter split across chunks is still a delimiter', () => {
  // The bug, verbatim: one character at a time this returned [["a::b::c"]].
  assert.deepStrictEqual(parseChunked('a::b::c', '::', 'a::b::c'.split('')), [
    ['a', 'b', 'c'],
  ]);
});

test('a multi-character delimiter split in two is matched', () => {
  assert.deepStrictEqual(parseChunked('a::b', '::', ['a:', ':b']), [['a', 'b']]);
});

test('every split point of a multi-character delimiter agrees with one push', () => {
  for (const [delimiter, text] of [
    ['::', 'a::b::c'],
    ['::', 'a::b'],
    ['::', 'a::b::'],
    ['ab', 'xabyabz'],
    ['<>', 'a<>b<>c'],
    ['--', 'a--b--c'],
    ['...', 'a...b'],
    ['\r\n', 'a\r\nb'],
  ]) {
    assertChunkInvariant(text, delimiter);
  }
});

test('a trailing partial delimiter is data, not dropped', () => {
  // The drain in flush() releases the withheld tail. Getting this wrong is a
  // second, independent data-loss bug: the first draft of the fix re-withheld
  // the characters it was trying to release, so `a::b:` came back as `a, b`
  // with the trailing colon gone.
  assert.deepStrictEqual(parseChunked('a::b:', '::', ['a::b:']), [['a', 'b:']]);
  assert.deepStrictEqual(parseChunked('a:', '::', ['a:']), [['a:']]);
  assert.deepStrictEqual(parseChunked('::', '::', ['::']), [['', '']]);
});

test('a partial delimiter inside a quoted field is never withheld', () => {
  // Inside quotes a delimiter is ordinary data, so there is nothing to decide
  // and the tail must not be held back.
  assert.deepStrictEqual(parseChunked('"a:"::b', '::', ['"a', ':"', '::b']), [
    ['a:', 'b'],
  ]);
  assert.deepStrictEqual(parseChunked('"a::b"\n', '::', ['"a::', 'b"\n']), [['a::b']]);
});

test('a one-character delimiter is unaffected by the withholding path', () => {
  // _partialDelimiter() must return false for a single character, or the common
  // path would start buffering and records would appear late.
  //
  // Note that `rows` stays empty until a record BREAK arrives: the tokenizer
  // emits a record when it sees the newline, not at the end of a field. Asserting
  // otherwise would be testing an eagerness this implementation never claimed.
  const tz = new Tokenizer({ delimiter: ',', quote: '"', positions: true });
  tz.push('a,b');
  assert.strictEqual(tz.rows.length, 0, 'no record break yet, so no record');
  assert.strictEqual(tz.pending, '', 'a single-character delimiter must never buffer');
  tz.push('\nc,d\n');
  assert.deepStrictEqual(tz.flush().map((r) => r.fields), [['a', 'b'], ['c', 'd']]);
  assert.strictEqual(tz.pending, '');
});

test('an unterminated quote still reports its position after a drain', () => {
  // flush() drains the pending tail before checking for an open quote, so the
  // reported line and column have to survive that. `a::"b:` puts the opening
  // quote at column 3 -- `a::` occupies three characters, so the column counts
  // characters, not delimiter units -- and it must be the same whether the input
  // arrived in one piece or in three.
  const report = (chunks) => {
    const tz = new Tokenizer({ delimiter: '::', quote: '"', positions: true });
    for (const chunk of chunks) tz.push(chunk);
    try {
      tz.flush();
      return { name: null, line: null, column: null };
    } catch (err) {
      return { name: err.name, line: err.line, column: err.column };
    }
  };
  const oneShot = report(['a::"b:']);
  const streamed = report(['a::"b', ':']);
  assert.deepStrictEqual(streamed, oneShot);
  assert.strictEqual(streamed.name, 'UnterminatedQuoteError');
  assert.strictEqual(streamed.line, 1);
  assert.strictEqual(streamed.column, 3);
});

test('csv the writer produces with a multi-character delimiter reads back', () => {
  // stringify already supported a multi-character delimiter, so the writer was
  // never the broken half -- which is exactly why this pair of calls could
  // disagree with each other rather than fail loudly.
  const text = stringify(null, [['a', 'b'], ['c', 'd']], { delimiter: '::' });
  assert.strictEqual(text, 'a::b\nc::d\n');
  assert.deepStrictEqual(parseChunked(text, '::', text.split('')), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('a round trip through a multi-character delimiter is chunk-stable', () => {
  const rows = [['x', 'y'], ['has::inside', 'plain'], ['a::b', 'c::d']];
  const text = stringify(['h1', 'h2'], rows, { delimiter: '::' });
  const whole = parseChunked(text, '::', [text]);
  assert.deepStrictEqual(whole, [['h1', 'h2'], ['x', 'y'], ['has::inside', 'plain'], ['a::b', 'c::d']]);
  for (let k = 0; k <= text.length; k += 1) {
    assert.deepStrictEqual(
      parseChunked(text, '::', [text.slice(0, k), text.slice(k)]),
      whole,
      `split at ${k} of ${JSON.stringify(text)}`
    );
  }
});

/**
 * The second bug the cross-check found: precedence between a record break and a
 * delimiter that is itself a record separator.
 *
 * In the AFTER_QUOTE state the tokenizer tested the delimiter BEFORE the record
 * break, while the plain UNQUOTED path tests the record break first. With
 * `delimiter: '\r\n'` -- the same string as a CRLF record separator -- the same
 * bytes therefore parsed as two records in one push and three when streamed one
 * character at a time. The disagreement appeared only after a quoted field,
 * which is why it hid behind the narrower delimiter tests.
 *
 * No real dialect uses `\r\n` as a delimiter; the point is that the tokenizer
 * must not return a chunk-dependent answer for bytes it can plainly parse.
 */
test('a delimiter that is a record separator parses the same at any chunking', () => {
  for (const [delimiter, text] of [
    ['\r\n', '"a\r\nb"\r\nc'],
    ['\r\n', '"ab"\r\nc'],
    ['\r\n', 'a\r\nb'],
    ['\r\n', '"a\rb"\r\nc'],
    ['\r\r', '"a"\r\rb'],
    ['\n\n', '"a"\n\nb'],
    ['\n\r', '"a"\n\rb'],
  ]) {
    const whole = parseChunked(text, delimiter, [text]);
    assert.deepStrictEqual(
      parseChunked(text, delimiter, text.split('')),
      whole,
      `per-character: ${JSON.stringify(text)} with delimiter ${JSON.stringify(delimiter)}`
    );
    for (let k = 0; k <= text.length; k += 1) {
      assert.deepStrictEqual(
        parseChunked(text, delimiter, [text.slice(0, k), text.slice(k)]),
        whole,
        `split at ${k} of ${JSON.stringify(text)} with delimiter ${JSON.stringify(delimiter)}`
      );
    }
  }
});

test('a record break outranks a delimiter that starts with CR or LF', () => {
  // Pinned explicitly: a quoted field followed by such a delimiter must end the
  // record, not be read as a field separator. Both orderings agree on this.
  assert.deepStrictEqual(parseChunked('"ab"\r\nc', '\r\n', ['"ab"\r\nc']), [['ab'], ['c']]);
  assert.deepStrictEqual(parseChunked('"ab"\r\nc', '\r\n', '"ab"\r\nc'.split('')), [['ab'], ['c']]);
});

test('a delimiter containing CR or LF in the middle still works', () => {
  // The suppression above must only apply at the START of a candidate match, or
  // a legitimate delimiter with a newline inside it would stop being recognised.
  for (const [delimiter, text, expected] of [
    ['x\r\nx', 'px\r\nxq', [['p', 'q']]],
    ['a\nb', 'pa\nbq', [['p', 'q']]],
  ]) {
    assert.deepStrictEqual(parseChunked(text, delimiter, [text]), expected);
    assert.deepStrictEqual(parseChunked(text, delimiter, text.split('')), expected);
  }
});