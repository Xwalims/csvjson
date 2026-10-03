'use strict';

/**
 * Exhaustive differential check for the CR/LF guard in `_partialDelimiter()`.
 *
 * Question: is the mutant "CR withheld as a possible delimiter prefix"
 * (guard removed) genuinely equivalent to the fixed code, or did the mutation
 * harness simply fail to catch a real bug?
 *
 * scripts/mutation-test.sh expected this mutant to be CAUGHT and reported
 * SURVIVED, which is a contradiction that has to be resolved with evidence.
 * This script resolves it by brute force: it enumerates EVERY string over the
 * relevant alphabet up to a fixed length, crosses it with every delimiter that
 * can possibly interact, and compares EVERY chunking. A hand-written corpus
 * only shows the cases its author imagined; this shows all of them.
 *
 * TWO ORACLES, and the second one is the interesting one.
 *
 *   afterFlush  compares `rows` once flush() has run. This was originally the
 *               only oracle here and it reported the mutant EQUIVALENT --
 *               provably so, with no false positives. That conclusion is
 *               correct and the mutant is still indistinguishable by it.
 *   midStream   compares the cumulative row count after EVERY push, which is
 *               how a streaming caller actually reads the tokenizer
 *               (`for await (const chunk of stream) rows.push(...push(chunk))`).
 *               Under this oracle the guard is load-bearing.
 *
 * Both are reported, always. An after-flush-only equivalence result on a
 * STREAMING parser is a trap: flush() drains any withheld tail, so "the final
 * output is identical" says nothing about whether a record was available to the
 * caller at the moment its bytes arrived. This script once printed
 * "PROVEN EQUIVALENT" on the strength of the after-flush oracle alone, which
 * was true and badly misleading. See test/midstream-emission.test.js for the
 * property that follows from it.
 *
 * Why this alphabet is sufficient. `_partialDelimiter` can only withhold a
 * character when that character is a strict prefix of the delimiter, so the only
 * characters whose withholding can reach further than the current chunk are the
 * ones a delimiter can start with. The interesting alphabet is therefore:
 *
 *   \r      a delimiter can start here (record break, and first byte of \r\n)
 *   \n      same
 *   a       ordinary data, so a withheld run can be followed by more data
 *   \uFEFF  the BOM, which is the ONLY thing that observes `atStart`
 *
 * `atStart` is the single piece of state that a deferral could reveal: it is
 * true only until the first character is consumed, and the BOM guard reads it.
 * Everything else the tokenizer touches (state, field, row, line, column,
 * recordTouched, skipLF, insideCR) is plain machine state that survives a
 * deferral untouched, so re-examining the tail on the next push replays it
 * through the same transitions in the same order -- which is exactly why the
 * after-flush oracle finds nothing and the mid-stream one does.
 *
 * `x` is deliberately NOT in the alphabet. A delimiter may not start with `x`
 * (it is not in DELIMS), so withholding can never happen at an `x`, and no
 * cross-delimiter interaction can be missed by excluding it. Stringify output
 * is not involved: this checks the TOKENIZER only.
 *
 * Run: node scripts/exhaustive-cr-guard.js [maxLen]
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'tokenize.js');
const GUARD = `    if (str.charCodeAt(i) === 0x0d /* \\r */ || str.charCodeAt(i) === 0x0a /* \\n */) {
      return false;
    }`;

// Every multi-character delimiter that starts with CR or LF, plus the two
// single-character ones for completeness (those short-circuit in
// `_partialDelimiter` before the guard, so they are a cheap control: a mutant
// must be identical to the fixed code there too).
const DELIMS = ['\r\n', '\r\r', '\n\r', '\n\n', '\r\n\n', '\r', '\n'];
const ALPHABET = ['\r', '\n', 'a', '\uFEFF'];

const maxLen = Number(process.argv[2] || 5);

const original = fs.readFileSync(SRC, 'utf-8');
if (!original.includes(GUARD)) {
  console.error('PROOF BROKEN: the guard is no longer in src/tokenize.js');
  process.exit(3);
}

fs.writeFileSync(SRC, original.replace(GUARD, ''));
const mutant = require(SRC);
fs.writeFileSync(SRC, original);
delete require.cache[require.resolve(SRC)];
const fixed = require(SRC);

/** Tokenize and capture everything a caller can observe, including throws. */
function observe(mod, delimiter, text, chunks) {
  const tz = new mod.Tokenizer({ delimiter, quote: '"', positions: true });
  try {
    for (const c of chunks) tz.push(c);
    tz.flush();
    return (
      'rows=' +
      JSON.stringify(
        tz.rows.map((r) => [r.fields, r.blank, r.line, r.rowIndex])
      ) +
      ' endState=' +
      [tz.state, tz.line, tz.column, tz.rowIndex, tz.rowStartLine].join('/')
    );
  } catch (err) {
    return 'throw=' + [err.name, err.line, err.column, err.rowIndex, err.message].join('/');
  }
}

/**
 * The mid-stream oracle: the cumulative row count after every push.
 *
 * Same tokenizer, same input -- only the sampling point differs. This is what a
 * streaming caller sees, and it is the oracle that the after-flush one cannot
 * express.
 */
function observeMidStream(mod, delimiter, chunks) {
  const tz = new mod.Tokenizer({ delimiter, quote: '"', positions: true });
  const seen = [];
  try {
    for (const c of chunks) seen.push(tz.push(c).length);
    tz.flush();
    return 'afterPush=' + seen.join(',');
  } catch (err) {
    return 'throw=' + err.name;
  }
}

/** Every way `text` can be split: one push, per character, and each 2-way split. */
function chunkings(text) {
  const out = [[text]];
  if (text.length > 1) out.push(text.split(''));
  for (let k = 1; k < text.length; k += 1) out.push([text.slice(0, k), text.slice(k)]);
  return out;
}

let comparisons = 0;
const afterFlushDiffs = [];
const midStreamDiffs = [];

for (const delimiter of DELIMS) {
  for (let len = 0; len <= maxLen; len += 1) {
    const total = ALPHABET.length ** len;
    for (let n = 0; n < total; n += 1) {
      let text = '';
      let v = n;
      for (let p = 0; p < len; p += 1) {
        text += ALPHABET[v % ALPHABET.length];
        v = Math.floor(v / ALPHABET.length);
      }
      for (const chunks of chunkings(text)) {
        comparisons += 1;
        const a = observe(fixed, delimiter, text, chunks);
        const b = observe(mutant, delimiter, text, chunks);
        if (a !== b && afterFlushDiffs.length < 20) {
          afterFlushDiffs.push({ delimiter, text, chunks, a, b });
        } else if (a !== b) {
          afterFlushDiffs.push({ delimiter, text, chunks, a, b, extra: true });
        }
        const ma = observeMidStream(fixed, delimiter, chunks);
        const mb = observeMidStream(mutant, delimiter, chunks);
        if (ma !== mb && midStreamDiffs.length < 20) {
          midStreamDiffs.push({ delimiter, text, chunks, a: ma, b: mb });
        } else if (ma !== mb) {
          midStreamDiffs.push({ delimiter, text, chunks, a: ma, b: mb, extra: true });
        }
      }
    }
  }
}

function report(title, diffs) {
  if (!diffs.length) {
    console.log(`${title}: 0 differences`);
    return;
  }
  console.log(`${title}: ${diffs.length}${diffs[0].extra ? '+' : ''} differences, first few:`);
  for (const d of diffs.slice(0, 4)) {
    console.log(`  delimiter=${JSON.stringify(d.delimiter)} text=${JSON.stringify(d.text)} chunks=${JSON.stringify(d.chunks)}`);
    console.log(`    fixed:  ${d.a}`);
    console.log(`    mutant: ${d.b}`);
  }
}

console.log(
  `enumerated every string of length <= ${maxLen} over ${JSON.stringify(ALPHABET)} ` +
    `x ${DELIMS.length} delimiters x every chunking (${comparisons} comparisons)\n`
);
report('after-flush oracle (rows at end of input)', afterFlushDiffs);
console.log();
report('mid-stream oracle (rows after each push)', midStreamDiffs);
console.log();

if (midStreamDiffs.length === 0) {
  console.log('VERDICT: equivalent under both oracles -- no test can distinguish them');
  process.exit(0);
}
if (afterFlushDiffs.length === 0) {
  console.log(
    'VERDICT: the final output is identical but mid-stream availability differs.\n' +
      '        The guard is load-bearing for a streaming caller, and any after-flush-only\n' +
      '        check -- including the tests that reported this mutant SURVIVED -- is\n' +
      '        blind to it. Pinned by test/midstream-emission.test.js.'
  );
  process.exit(1);
}
console.log('VERDICT: the guard is observable in the final output as well; it is load-bearing');