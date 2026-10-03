'use strict';

/**
 * A delimiter prefix inside a quoted field is DATA and must never be lost.
 *
 * `_partialDelimiter()` returns false while inside a quoted field, so a prefix of
 * a multi-character delimiter appearing there is parsed immediately instead of
 * being withheld for the next read. Removing that guard is an *equivalent*
 * mutant for the final parse result -- the characters are parsed in the same
 * order, only later -- and `scripts/verify-regression.sh` records it as such
 * after measuring 423 comparisons with no behavioural difference.
 *
 * But "equivalent" holds only as long as the deferred tail is eventually
 * released. The property that guard genuinely protects is narrower and real: a
 * field that ENDS with a delimiter prefix, where the stream ends immediately
 * after it. There the tail is released by flush(), not by a following push, and
 * the two paths must agree.
 *
 * So this file pins the user-visible consequence -- quoted content that looks
 * like a delimiter survives, at any chunking, to end of input -- rather than the
 * internal decision about when to buffer.
 */

const test = require('node:test');
const assert = require('node:assert');

const { Tokenizer } = require('../src/tokenize.js');

function parseChunked(text, delimiter, chunks) {
  const tz = new Tokenizer({ delimiter, quote: '"', positions: true });
  for (const chunk of chunks) tz.push(chunk);
  return tz.flush().map((rec) => (rec.blank ? [] : rec.fields));
}

test('a quoted field ending in a delimiter prefix survives at end of input', () => {
  // The stream stops on the prefix, so flush() is the only thing that can
  // release it. If the quoted-content path ever lost the tail, these would read
  // back as truncated fields.
  assert.deepStrictEqual(parseChunked('"a:"', '::', ['"a:"']), [['a:']]);
  assert.deepStrictEqual(parseChunked('"a:"::b', '::', ['"a:"::b']), [['a:', 'b']]);
  assert.deepStrictEqual(parseChunked('"::"', '::', ['"::"']), [['::']]);
});

test('quoted delimiter prefixes survive one character at a time', () => {
  for (const [delimiter, text, expected] of [
    ['::', '"a:"', [['a:']]],
    ['::', '"a::b"', [['a::b']]],
    ['::', 'x::"p:"::y\n', [['x', 'p:', 'y']]],
    ['ab', '"xaby"', [['xaby']]],
    // The separator here really is '...' -- writing '::' while declaring '...'
    // made '::c' ordinary data, and the field legitimately held 'a...::c'.
    // A test case that contradicts its own delimiter proves nothing.
    ['...', '"a..."...c', [['a...', 'c']]],
  ]) {
    assert.deepStrictEqual(
      parseChunked(text, delimiter, text.split('')),
      expected,
      `per-character: ${JSON.stringify(text)} with delimiter ${JSON.stringify(delimiter)}`
    );
  }
});

test('quoted delimiter prefixes survive at every split point', () => {
  for (const [delimiter, text] of [
    ['::', '"a:"::"b:"'],
    ['::', 'q::"::"::r\n'],
    ['::', '"a::"\n'],
  ]) {
    const whole = parseChunked(text, delimiter, [text]);
    for (let k = 0; k <= text.length; k += 1) {
      assert.deepStrictEqual(
        parseChunked(text, delimiter, [text.slice(0, k), text.slice(k)]),
        whole,
        `split at ${k} of ${JSON.stringify(text)}`
      );
    }
  }
});

test('a real delimiter after a quoted prefix is still a delimiter', () => {
  // The quoted prefix must not "absorb" the delimiter that follows it: the
  // guard suppresses withholding inside quotes only, so the state machine still
  // has to see the delimiter once the quote closes.
  assert.deepStrictEqual(parseChunked('"a:"::b', '::', ['"a:', '"::b']), [['a:', 'b']]);
  assert.deepStrictEqual(parseChunked('a::"b:"::c', '::', ['a::"b', ':"::c']), [
    ['a', 'b:', 'c'],
  ]);
});

test('a single-character delimiter is never withheld, quoted or not', () => {
  // With one character there is no partial match possible, so the fast path must
  // stay in play; a regression here would buffer every stream.
  const tz = new Tokenizer({ delimiter: ',', quote: '"', positions: true });
  tz.push('"a,"::b');
  assert.strictEqual(tz.pending, '');
  assert.deepStrictEqual(tz.flush().map((r) => r.fields), [['a,::b']]);
});