'use strict';

/**
 * csvjson — dialect detection and CSV -> table parsing.
 *
 * Detection counts candidate delimiters (`,` `;` `\t` `|`) and quote characters
 * (`"` `'`) ONLY outside quoted regions, over a sample of leading rows. Pass an
 * explicit delimiter/quote, or set `detect: false`, to bypass sniffing entirely.
 */

const {
  DEFAULTS,
  DELIMITER_CANDIDATES,
  QUOTE_CANDIDATES,
  Tokenizer,
  CsvError,
  RaggedRowError,
} = require('./tokenize.js');
const { inferRows, TYPES } = require('./infer.js');

const RAGGED_MODES = Object.freeze(['pad', 'error', 'dump']);

/**
 * Scan a sample under ONE quote character and count candidate delimiters per
 * record, ignoring anything inside a quoted field.
 *
 * The walk follows the tokenizer's own rule exactly: a quote character opens a
 * quoted region only at the START of a field (the first character of the input,
 * or right after a delimiter or a record break). A quote in the middle of a
 * field is literal data.
 *
 * With the quote character fixed there is nothing to guess, which is what makes
 * this safe. The earlier version tried to infer it as it went and let a single
 * unclosed opener swallow the rest of the file, so a tab- or semicolon-separated
 * file whose first field merely BEGINS with the other quote character was read
 * as single-column and fell back to ','. `detectDelimiter` now scores the whole
 * scan under each candidate instead, so no guess is made mid-walk.
 *
 * `extend` is optional extra text scanned only when the base scan ends inside a
 * quoted region; see sniffExtension(). It is concatenated rather than walked as
 * a separate chunk because a `"` at the very end of one part and a `"` at the
 * start of the next are an ESCAPED PAIR in the real file, and scoring them apart
 * would turn `""` into two openers.
 *
 * Returns the per-candidate tally plus `unterminated`: true when the text ends
 * inside a quoted region, i.e. the scanned text is not valid CSV under this
 * quote character and the tally must not be trusted.
 */
function sniff(sample, quoteChar = '"', extend = null) {
  const text = extend === null || extend === undefined ? sample : sample + extend;
  const stats = new Map();
  for (const d of DELIMITER_CANDIDATES) stats.set(d, []);
  let recordCounts = new Map(); // delimiter -> counts for the current record
  let inQuotes = false;
  const quote = quoteChar;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) i += 1; // escaped quote
        else inQuotes = false;
      }
      continue;
    }
    // Not inside quotes: only a quote at a field start opens a quoted region.
    if (ch === quote) {
      const prev = i > 0 ? text[i - 1] : null;
      if (prev === null || DELIMITER_CANDIDATES.indexOf(prev) !== -1 || prev === '\n' || prev === '\r') {
        inQuotes = true;
      }
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      for (const d of DELIMITER_CANDIDATES) {
        if (recordCounts.has(d)) stats.get(d).push(recordCounts.get(d));
      }
      recordCounts = new Map();
      continue;
    }
    for (const d of DELIMITER_CANDIDATES) {
      if (ch === d) recordCounts.set(d, (recordCounts.get(d) || 0) + 1);
    }
  }
  // A scan that ends mid-field tells you the quote character is the wrong one,
  // so its counts describe a file that is not CSV under this assumption.
  if (!inQuotes) {
    // The trailing partial record counts as a sample row too.
    for (const d of DELIMITER_CANDIDATES) {
      if (recordCounts.has(d)) stats.get(d).push(recordCounts.get(d));
    }
  }
  return { stats, unterminated: inQuotes };
}

/**
 * The number of extra characters to scan when a truncated sample ends inside a
 * quoted field, and how to get them.
 *
 * THE SAMPLE IS A PREFIX OF THE FILE. `parseCsv` hands sniff() the first
 * `sampleSize` characters of the input, so a quoted field that straddles the
 * boundary leaves the sample still open -- and an open quote at the END of a
 * truncated sample says where the sample was CUT, not anything about the bytes.
 * Treating it as a malformed file is a category error with a data-losing cost:
 * the quote character gets disqualified on evidence that does not exist, the
 * rival candidate is used instead, and then nothing quotes anything. Every
 * delimiter inside the abandoned quoted field becomes a column break.
 *
 *   id<TAB>note<TAB>tag                     rowCount 3, noteLens [9, 0, 5]
 *   1<TAB>"line one\nyyyy...(70 KB)"<TAB>t   -> the '"' reading is thrown away,
 *   2<TAB>plain<TAB>u                        the 70 KB field splits on tabs and
 *   3<TAB>"tail4"<TAB>v        python says    on newlines, and one row becomes
 *                              rowCount 2,    three. 135 of 200 generated files
 *                              noteLens       were mis-parsed this way.
 *                              [4, 70009, 5]
 *
 * The quote character is the correct one; only the sample is short. So the
 * sample is EXTENDED and rescanned under the same quote character until either
 * the quoted region closes or a hard cap is reached. A cap still open means the
 * file really does strand an opener, and the old disqualification stands -- a
 * genuinely unterminated field must keep erroring, not silently parse.
 *
 * The extension is bounded and reused across candidates, so the worst case costs
 * one capped scan per candidate rather than per candidate per step.
 *
 * @param {string} input the FULL text the sample was cut from
 * @param {number} sampleSize
 * @returns {string} text to scan after the sample, '' when there is none
 */
function sniffExtension(input, sampleSize) {
  const remaining = input.length - sampleSize;
  if (remaining <= 0) return '';
  // Cap the lookahead. A field can legitimately span more than the sample, but
  // scanning an unbounded tail to find its end would make detection O(file).
  return input.slice(sampleSize, sampleSize + Math.min(remaining, SNIFF_LOOKAHEAD));
}

/** How far past the sample a truncated scan may look for the closing quote. */
const SNIFF_LOOKAHEAD = 262144;

/**
 * Choose the delimiter AND the quote character as ONE decision.
 *
 * detectDialect() returns both halves of the reading it used, because the two
 * cannot be picked apart. detectDelimiter() below may have to score the
 * delimiter under the other quote character when the preferred one strands an
 * opener; a caller that kept the quote it had already chosen would then parse
 * under a quote the delimiter was never scored against. That split is not a
 * hypothetical -- see the note on the module's export below.
 *
 * `options.quote` pins the quote character: a pinned quote is never swapped for
 * the other candidate, even when it terminates no reading at all, because the
 * operator asked for that character. `options.preferQuote` only biases the
 * order -- it is still swapped when it strands an opener, which is what
 * detectDelimiter() below has always done. `options.delimiter` is not consulted
 * -- a caller may bring its own delimiter and still want a quote that reads the
 * whole file.
 *
 * A reading that reveals NO delimiter candidate is not a bad reading, it is a
 * single-column file, and the ',' fallback stands. Only a stranded opener
 * disqualifies a quote character, because only that one is evidence about the
 * bytes rather than about the data inside them: a comma in a single-column file
 * is text, while a quote that opens a field nobody closes is malformed. Falling
 * through to the other candidate when the winner simply had no delimiter cost
 * real reads -- see the commit message.
 *
 * From here down the delimiter is scored on the sample.
 *
 * The candidate that appears in EVERY record is the delimiter. A candidate that
 * shows up in one record only is a coincidence of the data, and the ranking has
 * to say so rather than reward it for the raw size of its count.
 *
 * Candidates are therefore compared lexicographically, strongest signal first:
 *
 *   1. agreement  -- how many records share the candidate's modal count. This
 *      is the signal that separates a real delimiter from a character embedded in
 *      data: the delimiter separates every field of every record, so those
 *      records all agree on how many of them there are, while a stray comma or
 *      pipe lands in the one or two records whose text happens to mention it.
 *   2. presence   -- how many records contain the candidate AT ALL.
 *   3. width      -- the modal count itself, i.e. how many columns it yields.
 *   4. total      -- raw occurrences.
 *   5. candidate order, the documented tie-break (comma first).
 *
 * Agreement must lead, and presence must not precede it. The two look
 * interchangeable -- on a rectangular file they NEVER disagree, so an aggregate
 * accuracy figure cannot tell the order apart at all. They come apart only on
 * RAGGED files, rows of unequal width, which are legal CSV and what hand-written
 * files and concatenated exports look like.
 *
 * Measured with python's csv.writer as the dialect oracle, over 300000 files
 * across five ragged rates and five seeds, counting ONLY the 2762 cases where
 * the two orders give different answers (at ragged rate 0 there are none):
 *
 *   agreement before presence   right on 1638
 *   presence before agreement   right on  568
 *
 * Winning 1638-568 is not a rounding error, and it points the same way at every
 * ragged rate tested: 0.15 (213-32), 0.25 (321-53), 0.4 (382-141), 0.5 (398-169),
 * 0.7 (324-173). On rectangular input both orders score identically, so this
 * costs nothing there.
 *
 * The shape where presence leads and loses: the rival is in MORE records than
 * the true delimiter, but spread unevenly, so it has no width the records agree
 * on while the delimiter's records all agree. That is what happens when a field
 * mentions ';' on some rows -- presence rewards the rival for being scattered
 * across rows while agreement rewards the delimiter for being systematic.
 *
 * Width is third, not first: it rewards a rival for occurring many times inside
 * ONE field, which is the coincidence the earlier keys exist to discount. The
 * order "width, then agreement, then presence" was measured too and is far worse
 * on every regime -- it scores 7446/40000 where this order scores 39464/40000 on
 * rectangular input, and averages 24.66% against 87.94% across the four regimes.
 * Likewise the old SUM (modal * modalCount + regularity * 0.5) averaged 64.25%,
 * and putting raw occurrences first averaged 65.37%.
 *
 * Detection is a PIPELINE, and the order matters: the quote character is chosen
 * first (detectQuote), and the delimiter is then scored under that quote
 * character only. Scanning under both and keeping the best score is wrong --
 * a reading in which the quote character never opens anything loses the very
 * protection quoted fields exist to provide, so plain commas inside a quoted
 * field get counted and can outscore the real delimiter.
 *
 * If the sample ends inside a quoted region, the quote character is wrong: it
 * stranded an opener and every delimiter after it is invisible. The other
 * candidate is then tried, and if neither terminates the sample simply has no
 * usable reading. That is exactly the failure that made a semicolon-separated
 * file beginning with a lone double quote come back as single-column and fall
 * back to ','. Trying one alternative is a linear cost; a guess made mid-scan
 * would need look-ahead to undo itself, which is quadratic in the sample size.
 *
 * A stranded opener is only evidence when the sample is the WHOLE file. A
 * truncated sample is a prefix, so an open quote at its end is where the sample
 * was cut: `detectDialect` takes the rest of the input as `full` and rescans the
 * sample together with a bounded extension (see sniffExtension) before
 * disqualifying anything. A cap still open IS evidence and still disqualifies.
 * Without this the sample boundary silently rewrites the dialect of any file
 * with a quoted field longer than `sampleSize`.
 *
 * @param {string} sample
 * @param {object} [options]
 * @param {string} [options.quote] pinned quote character, never swapped
 * @param {string} [options.preferQuote] preferred quote character, may swap
 * @param {string} [options.full] the whole input, when the sample is a prefix
 */
function detectDialect(sample, options = {}) {
  const pinned = typeof options.quote === 'string' && options.quote.length ? options.quote : null;
  const preferred =
    typeof options.preferQuote === 'string' && options.preferQuote.length ? options.preferQuote : null;
  const first = pinned || preferred || detectQuote(sample);
  const order = pinned ? [first] : [first].concat(QUOTE_CANDIDATES.filter((q) => q !== first));
  // Bounded once and reused for every candidate, so a sample that strands an
  // opener under both quotes costs two capped scans, not a rescan per step.
  const extend =
    typeof options.full === 'string' && options.full.length > sample.length
      ? sniffExtension(options.full, sample.length)
      : null;
  for (const quote of order) {
    let { stats, unterminated } = sniff(sample, quote);
    if (unterminated && extend) {
      // The sample is a prefix of a longer file and stops inside a quoted
      // field. That is where the sample ended, not a malformed file, so rescan
      // the sample together with the tail of the real input before judging.
      ({ stats, unterminated } = sniff(sample, quote, extend));
    }
    if (unterminated) continue; // not a CSV file under this quote character
    let best = null;
    for (const d of DELIMITER_CANDIDATES) {
      const counts = stats.get(d);
      if (!counts.length) continue;
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const freq = new Map();
      for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
      let modal = 0;
      let modalCount = 0;
      for (const [width, n] of freq) {
        if (n > modalCount || (n === modalCount && width > modal)) {
          modal = width;
          modalCount = n;
        }
      }
      const score = {
        present: counts.length,
        wide: modal,
        regular: modalCount,
        total,
        order: DELIMITER_CANDIDATES.indexOf(d),
      };
      if (!best || better(score, best.score)) best = { delimiter: d, score, width: modal, records: counts.length };
    }
    // The first quote character that yields a whole-file reading wins outright.
    // Its reading is the one the parser will actually use, so letting a rival
    // outscore it would optimise against the wrong parse.
    //
    // No delimiter candidate at all is a single-column file, not a rejected
    // reading: the answer is the ',' fallback, under the quote that was used.
    // Falling through to the other quote character here would swap a working
    // reading for a worse one -- on `'col0'\n"a,b"\n'start\n' the correct table
    // comes back as ["col0'"], ["a,b"], ["'start"], and a quote swap splits
    // "a,b" into two columns because the comma was never quoting anything.
    if (best) return { delimiter: best.delimiter, quote };
    return { delimiter: ',', quote };
  }
  return { delimiter: ',', quote: first };
}

/**
 * Choose a delimiter by scoring each candidate on the sample.
 *
 * The quote character the winning delimiter was scored under is deliberately
 * NOT returned: a caller that parses afterwards must use detectDialect(), or it
 * will tokenize under a quote this function never scored against. parseCsv()
 * returning `quote` from detectQuote() while taking `delimiter` from here was
 * exactly that mistake, and it threw E_UNTERMINATED_QUOTE on 266 of 4000 files
 * written by python's csv.writer with quotechar '"' (see the commit message).
 *
 * `quoteChar` only PREFERS a candidate: it may still be swapped out, as it
 * always was, so this stays a delimiter answer and not a dialect answer.
 *
 * @param {string} sample
 * @param {string} [quoteChar] preferred quote character, may be swapped out
 * @returns {string}
 */
function detectDelimiter(sample, quoteChar) {
  return detectDialect(sample, { preferQuote: quoteChar }).delimiter;
}

/**
 * True when candidate `a` is a better reading than `b`.
 *
 * Ordered by signal strength: agreement, then presence, then width, then raw
 * occurrences, then the candidate list order. Never a sum of the terms --
 * summing is what let a large count in one record outweigh a consistent count
 * in all of them.
 *
 * Agreement first, presence second. These two are indistinguishable on
 * rectangular input -- they never disagree at all -- so the order between them
 * is decided on ragged input, where they part company. Over 300000 generated
 * files, counting only the 2762 that discriminate:
 *
 *   agreement before presence   right on 1638
 *   presence before agreement   right on  568
 *
 * so agreement leads. Width ranks after both: it rewards a rival for occurring
 * many times inside ONE field, which is precisely the coincidence the leading
 * keys discount. Measured across four regimes, agreement-first averages 87.94%
 * against 24.66% for width-first and 64.25% for the old weighted sum.
 */
function better(a, b) {
  if (a.regular !== b.regular) return a.regular > b.regular;
  if (a.present !== b.present) return a.present > b.present;
  if (a.wide !== b.wide) return a.wide > b.wide;
  if (a.total !== b.total) return a.total > b.total;
  return a.order < b.order;
}

/**
 * Choose a quote character: the candidate that actually opens a quoted field in
 * the sample. A quote only counts when it sits at a field start — the first
 * character of the input, right after a delimiter, or right after a record
 * break. A quote in the middle of a field is literal data.
 */
function detectQuote(sample) {
  const counts = new Map();
  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i];
    if (ch !== '"' && ch !== "'") continue;
    const prev = i > 0 ? sample[i - 1] : null;
    const atFieldStart =
      prev === null || prev === '\n' || prev === '\r' || DELIMITER_CANDIDATES.indexOf(prev) !== -1;
    if (atFieldStart) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let best = '"';
  let bestCount = 0;
  for (const q of QUOTE_CANDIDATES) {
    const n = counts.get(q) || 0;
    if (n > bestCount) {
      best = q;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Reconcile record widths according to the ragged policy.
 *
 *  - pad   fill missing trailing cells with options.padValue
 *  - error throw RaggedRowError on the first width mismatch
 *  - dump  move overflowing cells into an array in the last column
 */
function applyRagged(records, expectedWidth, options) {
  const mode = options.ragged || DEFAULTS.ragged;
  if (!RAGGED_MODES.includes(mode)) {
    throw new CsvError(`unknown --ragged mode: ${mode}`, { code: 'E_BAD_OPTION' });
  }
  const out = [];
  for (const rec of records) {
    const fields = rec.fields ? rec.fields : rec;
    const line = rec.line === undefined ? null : rec.line;
    const rowIndex = rec.rowIndex === undefined ? out.length : rec.rowIndex;
    if (fields.length === expectedWidth) {
      out.push(fields);
    } else if (fields.length < expectedWidth) {
      if (mode === 'error') {
        throw new RaggedRowError({ width: fields.length, expected: expectedWidth, line, rowIndex });
      }
      const padded = fields.slice();
      while (padded.length < expectedWidth) padded.push(options.padValue === undefined ? DEFAULTS.padValue : options.padValue);
      out.push(padded);
    } else {
      if (mode === 'error') {
        throw new RaggedRowError({ width: fields.length, expected: expectedWidth, line, rowIndex });
      }
      if (mode === 'dump') {
        const head = fields.slice(0, expectedWidth - 1);
        head.push(fields.slice(expectedWidth - 1));
        out.push(head);
      } else {
        // pad: overflow is truncated to keep every row the same width.
        out.push(fields.slice(0, expectedWidth));
      }
    }
  }
  return out;
}

/**
 * Parse CSV text into a table.
 *
 * @param {string} input
 * @param {object} [options] see DEFAULTS
 * @returns {{header:string[]|null, rows:any[][], types:string[], delimiter:string,
 *            quote:string, columnCount:number, ragged:Array, rowCount:number}}
 */
function parseCsv(input, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  if (typeof input !== 'string') {
    throw new TypeError('parseCsv: input must be a string');
  }
  if (opts.types && !TYPES.includes(opts.types)) {
    throw new CsvError(`unknown --types mode: ${opts.types}`, { code: 'E_BAD_OPTION' });
  }

  const sample = opts.detect === false ? '' : input.slice(0, opts.sampleSize);
  let delimiter;
  let quote;
  if (opts.detect === false) {
    delimiter = opts.delimiter || ',';
    quote = opts.quote || '"';
  } else {
    // One decision, not two. detectQuote() alone can pick a quote character that
    // strands an opener, while detectDelimiter() then quietly scores the
    // delimiter under the OTHER candidate and returns that reading's separator.
    // Keeping the first answer and taking the second half is how one file ended
    // up tokenized under a quote nothing was scored against -- it threw
    // E_UNTERMINATED_QUOTE on a file python's csv.reader reads without trouble.
    // detectDialect() returns both halves of the reading it actually used.
    //
    // An explicit --quote pins the quote character and is never swapped, even if
    // it terminates nothing: the operator asked for it. An explicit --delimiter
    // is likewise kept, but the quote is still detected under the remaining
    // candidate set, because a stranded quote throws on the whole file.
    // `full` is the whole input, so a sample that stops inside a quoted field
    // is read as a sample boundary rather than as a malformed file.
    const dialect = detectDialect(sample, {
      quote: opts.quote || undefined,
      full: input,
    });
    quote = dialect.quote;
    delimiter = opts.delimiter || dialect.delimiter;
  }

  const tok = new Tokenizer(Object.assign({}, opts, { delimiter, quote, positions: true }));
  tok.push(input);
  const records = tok.flush().slice();

  if (records.length === 0) {
    return {
      header: null,
      rows: [],
      types: [],
      delimiter,
      quote,
      columnCount: 0,
      ragged: [],
      rowCount: 0,
    };
  }

  // The header record, when present, is excluded from ragged reconciliation
  // unless it is itself the odd one out; header width defines the column count.
  let header = null;
  let body = records;
  if (opts.header !== false) {
    header = records[0].fields.slice();
    body = records.slice(1);
  }

  const expectedWidth = opts.header !== false
    ? header.length
    : body.reduce((m, r) => Math.max(m, r.fields.length), 0);

  // A blank line is not a short row. It is an empty LINE, and it must not be
  // padded: padding invents cells that were never in the file and the writer
  // then emits a stray delimiter for each one, so `\n\n` comes back as `\n,\n`.
  // Blank records are therefore held out of the ragged machinery — which would
  // both pad them and count them as malformed — and re-inserted in place as
  // zero-field rows, which the writer renders as an empty line. `[]` is exactly
  // what a blank record means, so the cycle closes.
  const kept = [];
  const blanks = new Set();
  body.forEach((rec, i) => {
    if (rec.blank) blanks.add(i);
    else kept.push(rec);
  });
  const keptRows = applyRagged(kept, expectedWidth, opts);

  const ragged = [];
  const reconciled = [];
  let k = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (blanks.has(i)) {
      reconciled.push([]);
      continue;
    }
    const rec = kept[k];
    const fields = keptRows[k];
    k += 1;
    if (rec && rec.fields.length !== fields.length) {
      ragged.push({ rowIndex: rec.rowIndex, line: rec.line, width: rec.fields.length });
    }
    reconciled.push(fields);
  }

  const { types, rows } = inferRows(reconciled, expectedWidth, opts);

  return {
    header,
    rows,
    types,
    delimiter,
    quote,
    columnCount: expectedWidth,
    ragged,
    rowCount: rows.length,
  };
}

module.exports = {
  RAGGED_MODES,
  sniff,
  sniffExtension,
  detectDialect,
  detectDelimiter,
  detectQuote,
  better,
  applyRagged,
  parseCsv,
};