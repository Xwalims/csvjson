'use strict';

/**
 * A record must be visible to the caller at the push that completes it.
 *
 * This file exists because a mutant of `src/tokenize.js` was wrongly reported
 * as SURVIVED: "CR withheld as a possible delimiter prefix" removes
 *
 *     if (str.charCodeAt(i) === 0x0d || str.charCodeAt(i) === 0x0a) return false;
 *
 * from `_partialDelimiter()`. Every existing check still passed with that guard
 * deleted, because every one of them reads `tz.rows` only *after* `flush()` --
 * and at flush the withheld tail is drained, so the final output is identical.
 * An exhaustive sweep (scripts/exhaustive-cr-guard.js: 54k comparisons over
 * {CR, LF, data, BOM} x 7 delimiters x every chunking) found zero differences
 * and appeared to prove the guard was dead weight.
 *
 * That proof was blind, and the blind spot is the entire point of a streaming
 * parser. The documented way to consume this tokenizer is
 *
 *     for await (const chunk of stream) rows.push(...tz.push(chunk));
 *
 * so `rows` is read after EVERY push. With the guard gone, a trailing CR --
 * which ends a record immediately -- is withheld as a possible prefix of a
 * '\r\n' delimiter, and the record does not appear until the next chunk
 * arrives. Nothing is lost by end of input; the record is merely late, and a
 * record that has already been fully read staying invisible is a real defect.
 *
 * Final-output equality is therefore the WRONG oracle for a streaming
 * tokenizer. Mid-stream availability is a separate property and needs its own
 * assertions. These pin it.
 *
 * Note on measurement: `push()` returns the same array instance on every call,
 * so `tz.rows.length` after a push is a CUMULATIVE count, not a per-push delta.
 * Comparing raw lengths between two different chunkings compares nothing
 * meaningful. Everything here therefore records [charsConsumed, rowsSoFar] and
 * compares those pairs against the per-character reading of the same input,
 * which is the only chunking with an unambiguous "when did this record complete"
 * answer.
 */

const test = require('node:test');
const assert = require('node:assert');

const { Tokenizer } = require('../src/tokenize.js');

/**
 * Feed `chunks`, recording [totalCharsPushed, cumulativeRows] after each push.
 * @returns {[number, number][]}
 */
function timeline(delimiter, chunks) {
  const tz = new Tokenizer({ delimiter, quote: '"', positions: true });
  const out = [];
  let consumed = 0;
  for (const chunk of chunks) {
    tz.push(chunk);
    consumed += chunk.length;
    out.push([consumed, tz.rows.length]);
  }
  return out;
}

/** Assert `observed` is a subsequence of `canonical` (same counts, may skip points). */
function assertFollowsCanonical(canonical, observed, what) {
  let k = 0;
  for (const [consumed, rows] of observed) {
    while (k < canonical.length && canonical[k][0] < consumed) k += 1;
    assert.ok(k < canonical.length, `${what}: offset ${consumed} is past the end of the input`);
    assert.strictEqual(
      rows,
      canonical[k][1],
      `${what}: after ${consumed} character(s) the per-character reading has ` +
        `${canonical[k][1]} record(s) available, this chunking had ${rows}`
    );
  }
}

/** Delimiters whose FIRST character is also a record separator. */
const SEPARATOR_PREFIX_DELIMITERS = ['\r\n', '\r\r', '\n\r', '\n\n'];

test('a record ended by a bare CR is available at the push that completed it', () => {
  // The counterexample to the after-flush proof, stated directly. With the guard
  // removed, pushing 'a\r' leaves 0 records; the record appears only on the
  // next push or at flush.
  const tz = new Tokenizer({ delimiter: '\r\n', quote: '"', positions: true });
  tz.push('a\r');
  assert.strictEqual(tz.rows.length, 1, 'the CR completed a record, so it must be visible now');
  assert.deepStrictEqual(tz.rows[0].fields, ['a']);

  for (const delimiter of SEPARATOR_PREFIX_DELIMITERS) {
    assert.strictEqual(
      new Tokenizer({ delimiter, quote: '"', positions: true }).push('a\r').length,
      1,
      `delimiter ${JSON.stringify(delimiter)}: a record break must not wait for more input`
    );
  }
});

test('per-character reading agrees with every other chunking, mid-stream', () => {
  // The real invariant: the moment a record becomes available must not depend
  // on where the chunk boundaries fall.
  for (const delimiter of [...SEPARATOR_PREFIX_DELIMITERS, ',', '::']) {
    for (const text of ['a\rb\rc', 'a\nb\nc', 'a,b\rc,d\r', 'a::b\nc::d\n', 'a\r\nb\r\nc']) {
      const canonical = timeline(delimiter, text.split(''));
      assertFollowsCanonical(canonical, timeline(delimiter, [text]), `delimiter ${JSON.stringify(delimiter)} one-shot on ${JSON.stringify(text)}`);
      for (let k = 1; k <= text.length; k += 1) {
        assertFollowsCanonical(
          canonical,
          timeline(delimiter, [text.slice(0, k), text.slice(k)]),
          `delimiter ${JSON.stringify(delimiter)} split at ${k} of ${JSON.stringify(text)}`
        );
      }
    }
  }
});

test('a record is never published before its terminating bytes arrive', () => {
  // The other half of the contract: withholding must not invent a record early,
  // or a per-push reader would see a truncated record.
  // The delimiter here is '\r\n', so ',' is ordinary data and the single field
  // 'a,b' is correct. Using a comma delimiter would have been clearer but this
  // is the delimiter whose CR/LF prefix is under test.
  const tz = new Tokenizer({ delimiter: '\r\n', quote: '"', positions: true });
  tz.push('a');
  assert.strictEqual(tz.rows.length, 0, 'no terminator yet, so no record');
  tz.push(',b');
  assert.strictEqual(tz.rows.length, 0, 'still no terminator');
  tz.push('\r');
  assert.strictEqual(tz.rows.length, 1, 'the CR ends the record and it is available now');
  assert.deepStrictEqual(tz.rows[0].fields, ['a,b']);
});

test('the common single-character delimiter emits at the record break', () => {
  // Control: none of this may have slowed the ordinary path down. `,` is what
  // every real caller uses; the pathological delimiters are above.
  assert.deepStrictEqual(timeline(',', ['a,b\r\nc,d\r\n']), [[10, 2]]);
  // Splitting the CRLF must not cost a record or delay one: the CR already ends
  // the record, and the LF is swallowed as its second half.
  assert.deepStrictEqual(timeline(',', ['a,b\r', '\nc,d']), [[4, 1], [8, 1]]);
  // One push, one timeline entry: both records complete inside the single
  // chunk, so both are available as soon as it returns.
  assert.deepStrictEqual(timeline('::', ['a::b\nc::d\n']), [[10, 2]]);
  // Split between the records: still two, still available when each arrives.
  assert.deepStrictEqual(timeline('::', ['a::b\n', 'c::d\n']), [[5, 1], [10, 2]]);
});

test('a quoted record is published when its closing quote and break land', () => {
  // Quoting does not license deferral: a record with a terminator must appear.
  const tz = new Tokenizer({ delimiter: '\r\n', quote: '"', positions: true });
  tz.push('"a');
  assert.strictEqual(tz.rows.length, 0);
  tz.push('b"');
  assert.strictEqual(tz.rows.length, 0);
  tz.push('\r');
  assert.strictEqual(tz.rows.length, 1, 'record complete at the CR');
  assert.deepStrictEqual(tz.rows[0].fields, ['ab']);
  // ...and the LF of that CRLF must not produce a second, empty record.
  tz.push('\nc');
  assert.strictEqual(tz.rows.length, 1);
  assert.strictEqual(tz.flush().length, 2);
  assert.deepStrictEqual(tz.rows.map((r) => r.fields), [['ab'], ['c']]);
});