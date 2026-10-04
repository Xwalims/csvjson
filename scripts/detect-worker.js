'use strict';

/**
 * Detection cross-check worker: reads a JSON array of cases on stdin, writes one
 * result per case.
 *
 * Unlike crosscheck-worker.js this reports what the SNIFFER decided rather than
 * what the tokenizer produced, because detection happens before tokenizing: a
 * wrong dialect here is invisible to every reader/writer comparison, which is
 * exactly why crosscheck.py's docstring says this code path "has no external
 * oracle at all". detect-check.py supplies the oracle -- the dialect python's
 * csv.writer was told to use -- and this file is the only thing that touches the
 * code under test.
 *
 * Every op returns {ok: true, ...} or {ok: false, error} so a disagreement is
 * distinguishable from a crash.
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { detectDelimiter, detectQuote } = require(path.join(ROOT, 'src', 'parse.js'));

function run(c) {
  // detectDelimiter is asked for the quote character detect-check.py's ground
  // truth implies, and also left to derive one for itself, so the worker reports
  // the same pair parseCsv() would use.
  return {
    delimiter: detectDelimiter(c.text),
    quote: detectQuote(c.text),
    delimiterUnderQuote: detectDelimiter(c.text, c.quote),
  };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const cases = JSON.parse(raw);
  const results = cases.map((c) => {
    try {
      return Object.assign({ ok: true }, run(c));
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  process.stdout.write(JSON.stringify(results));
});