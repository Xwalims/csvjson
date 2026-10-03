'use strict';

/**
 * csvjson — streaming, character-level CSV tokenizer (RFC 4180 with sane
 * extensions). Zero dependencies, CommonJS.
 *
 * The tokenizer is a state machine that accepts input in arbitrarily small
 * chunks, including chunks that split a CRLF pair or a `""` escape. Field
 * contents are preserved byte-for-byte: CR and LF inside a quoted field are
 * NEVER normalised to \n, because normalising them breaks round-tripping.
 */

/**
 * The single frozen object holding every option default in the project.
 * Every module imports its defaults from here; nothing else defines them.
 */
const DEFAULTS = Object.freeze({
  /** Field delimiter. `null` means "detect from the sample". */
  delimiter: null,
  /** Quote character. `null` means "detect from the sample". */
  quote: null,
  /** Master switch for delimiter/quote detection (CLI: --no-detect). */
  detect: true,
  /** First record holds column names (CLI: --no-header). */
  header: true,
  /** Column type inference mode. */
  types: 'auto',
  /** Ragged-row policy. */
  ragged: 'pad',
  /** Filler value used by the `pad` policy for missing trailing cells. */
  padValue: '',
  /** JSON output shape: objects | ndjson | columns. */
  shape: 'objects',
  /** Swap rows and columns. */
  transpose: false,
  /** Print a parse/write summary to stderr. */
  stats: false,
  /** Record separator used by the CSV writer. */
  eol: '\n',
  /** Emit a final record separator. */
  trailingNewline: true,
  /** JSON pretty-print indent (0 = compact). */
  indent: 2,
  /** Quote every field on write. */
  quoteAll: false,
  /** Characters inspected when sniffing the dialect. */
  sampleSize: 65536,
  /** Strip a leading UTF-8 BOM. */
  stripBom: true,
  /** Yield {fields, line, rowIndex} records with source positions. */
  positions: false,
});

/** Candidate delimiters sniffed when no --delimiter is given. */
const DELIMITER_CANDIDATES = Object.freeze([',', ';', '\t', '|']);
/** Candidate quote characters sniffed when no --quote is given. */
const QUOTE_CANDIDATES = Object.freeze(['"', "'"]);
/** Exit code the CLI uses for malformed input (distinct from usage errors). */
const EXIT_DATA_ERROR = 3;

class CsvError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CsvError';
    this.code = details.code || 'E_CSV';
    this.line = details.line === undefined ? null : details.line;
    this.column = details.column === undefined ? null : details.column;
    this.rowIndex = details.rowIndex === undefined ? null : details.rowIndex;
    this.exitCode = EXIT_DATA_ERROR;
  }
}

/** Thrown when a quoted field is never closed before end of input. */
class UnterminatedQuoteError extends CsvError {
  constructor(details) {
    super(
      `unterminated quoted field starting at line ${details.line}` +
        (details.column === null ? '' : `, column ${details.column}`),
      Object.assign({ code: 'E_UNTERMINATED_QUOTE' }, details)
    );
    this.name = 'UnterminatedQuoteError';
  }
}

/** Thrown by --ragged error when record widths disagree. */
class RaggedRowError extends CsvError {
  constructor(details) {
    super(
      `ragged row ${details.rowIndex + 1} (line ${details.line}) has ` +
        `${details.width} fields, expected ${details.expected}`,
      Object.assign({ code: 'E_RAGGED_ROW' }, details)
    );
    this.name = 'RaggedRowError';
    // CsvError only forwards the shared fields; keep the ragged specifics too.
    this.width = details.width;
    this.expected = details.expected;
  }
}

const S = {
  FIELD_START: 0, // at the first character of a field
  UNQUOTED: 1, // inside a bare field
  QUOTED: 2, // inside a quoted field
  QUOTE_IN_QUOTED: 3, // just consumed a quote inside a quoted field
  AFTER_QUOTE: 4, // just consumed the closing quote of a quoted field
};

const BOM = '\uFEFF';

/**
 * Incremental CSV tokenizer.
 *
 *   const tz = new Tokenizer({ delimiter: ',', quote: '"' });
 *   const rows = [...tz.push(chunk1), ...tz.push(chunk2), ...tz.flush()];
 */
class Tokenizer {
  constructor(options = {}) {
    const opts = Object.assign({}, DEFAULTS, options);
    this.delimiter =
      typeof opts.delimiter === 'string' && opts.delimiter.length ? opts.delimiter : ',';
    this.quote = typeof opts.quote === 'string' && opts.quote.length ? opts.quote : '"';
    this.stripBom = opts.stripBom !== false;
    this.positions = opts.positions === true;

    this.state = S.FIELD_START;
    this.field = [];
    this.row = [];
    this.rows = [];
    this.line = 1;
    this.column = 1;
    this.rowIndex = 0;
    this.rowStartLine = 1;
    /** A CR was consumed outside quotes: a following LF belongs to that break. */
    this.skipLF = false;
    /** A CR was consumed inside quotes: a following LF belongs to the field. */
    this.insideCR = false;
    /** Position of the opening quote of the field being read. */
    this.quoteLine = null;
    this.quoteColumn = null;
    this.quoteRowIndex = null;
    /** True until the first input character has been seen (BOM guard). */
    this.atStart = true;
    /** True once the record in progress has consumed anything at all. */
    this.recordTouched = false;
    /**
     * Tail of the last chunk that could still turn out to be the start of a
     * delimiter. Empty unless a multi-character delimiter straddles a chunk
     * boundary; see push().
     */
    this.pending = '';
    /**
     * Set while flush() drains `pending`. Withholding is what makes a delimiter
     * split across reads work, but at end of input there is no next read, so the
     * tail must be parsed as ordinary characters. Without this flag the drain
     * below would re-withhold the very characters it is trying to release and
     * the end of the file would be silently dropped.
     */
    this.draining = false;
  }

  /** Feed a chunk of input; returns the same array every record is appended to. */
  push(chunk) {
    // A delimiter split across two reads must be recognised, so the withheld
    // tail is prepended before anything is parsed. `str` is rebuilt rather than
    // the loop being re-entered, because the tokenizer state must stay untouched
    // across the boundary.
    let str = String(chunk);
    if (this.pending !== '') {
      str = this.pending + str;
      this.pending = '';
    }
    const n = str.length;
    let i = 0;
    while (i < n) {
      // A delimiter may begin here but be cut short by the end of this chunk.
      // Nothing can be decided yet, so the rest of the chunk is withheld and
      // re-examined with the next one. Without this a multi-character delimiter
      // is silently missed whenever a read boundary falls inside it, and the
      // field boundary it should have produced simply disappears from the
      // output -- the worst kind of failure, because the data still looks valid.
      if (this._partialDelimiter(str, i) && !this.draining) {
        this.pending = str.slice(i);
        break;
      }

      const ch = str[i];
      // atStart describes the very first character only; capture it before the
      // first character is consumed so a BOM later in the same chunk survives.
      const atStart = this.atStart;
      this.atStart = false;

      if (this.skipLF) {
        this.skipLF = false;
        if (ch === '\n') {
          i += 1;
          continue;
        }
      }

      if (this.state === S.QUOTE_IN_QUOTED) {
        if (ch === this.quote) {
          // `""` inside a quoted field is one literal quote character.
          this.field.push(ch);
          this.insideCR = false;
          this.state = S.QUOTED;
          this.column += 1;
          i += 1;
          continue;
        }
        // The previous quote closed the field: re-dispatch as AFTER_QUOTE.
        this.state = S.AFTER_QUOTE;
      }

      if (this.state === S.AFTER_QUOTE) {
        // A record break outranks the delimiter here, and it has to: below, the
        // plain UNQUOTED path checks for a record break FIRST, so keeping the
        // delimiter check first would make the same bytes parse one way after a
        // quoted field and the other way after a bare one. That is not a
        // cosmetic difference -- it made `"ab"\r\nc` two records in one push and
        // three when streamed a character at a time, with a `\r\n` delimiter.
        //
        // The cases that matter are a delimiter that IS a record separator
        // (`\r\n`, `\r\r`, `\n\n`) and a delimiter beginning with `\r` or `\n`.
        // No real dialect uses those as a delimiter, but the tokenizer must not
        // return a chunk-dependent answer for bytes that are otherwise ordinary.
        if (ch === '\r' || ch === '\n') {
          i += this._endRecord(ch === '\r');
          continue;
        }
        if (this._isDelimiter(str, i)) {
          i += this.delimiter.length;
          this._endField();
          this.state = S.FIELD_START;
          this.column += 1;
          continue;
        }
        // Lenient: stray characters after a closing quote are literal data.
        this.state = S.UNQUOTED;
        continue;
      }

      if (this.state === S.QUOTED) {
        if (ch === this.quote) {
          this.state = S.QUOTE_IN_QUOTED;
          this.column += 1;
          i += 1;
          continue;
        }
        if (ch === '\r') {
          this.field.push(ch); // preserved verbatim, never normalised
          this.insideCR = true;
          this._nextLine();
          i += 1;
          continue;
        }
        if (ch === '\n') {
          this.field.push(ch); // preserved verbatim, never normalised
          if (this.insideCR) this.insideCR = false; // LF half of a CRLF pair
          else this._nextLine();
          i += 1;
          continue;
        }
        this.field.push(ch);
        this.insideCR = false;
        this.column += 1;
        i += 1;
        continue;
      }

      // FIELD_START or UNQUOTED
      if (ch === '\r' || ch === '\n') {
        i += this._endRecord(ch === '\r');
        continue;
      }
      if (this._isDelimiter(str, i)) {
        i += this.delimiter.length;
        this._endField();
        this.state = S.FIELD_START;
        this.column += 1;
        continue;
      }
      if (this.state === S.FIELD_START) {
        if (atStart && this.stripBom && ch === BOM) {
          i += 1;
          continue;
        }
        if (ch === this.quote) {
          // An opening quote means the record holds a FIELD even when that field
          // is empty: `""` is one empty cell, not an empty line.
          this.recordTouched = true;
          this.state = S.QUOTED;
          this.insideCR = false;
          this.quoteLine = this.line;
          this.quoteColumn = this.column;
          this.quoteRowIndex = this.rowIndex;
          i += 1;
          continue;
        }
      }
      this.state = S.UNQUOTED;
      // Literal data is the common case and must count as content: a record
      // like `1;2` holds a field even though no delimiter ever appears in it.
      this.recordTouched = true;
      this.field.push(ch);
      this.column += 1;
      i += 1;
    }
    return this.rows;
  }

  /** Signal end of input. Throws UnterminatedQuoteError on an open quote. */
  flush() {
    // Anything still withheld from the last push() is real data, not a partial
    // delimiter: no more input is coming, so the tail cannot turn into a match
    // and must be parsed as ordinary characters. Dropping it would lose the end
    // of the file -- a record ending in a lone ':' would vanish silently.
    if (this.pending !== '') {
      const held = this.pending;
      this.pending = '';
      this.draining = true;
      try {
        this.push(held);
      } finally {
        this.draining = false;
      }
    }
    if (this.state === S.QUOTED) {
      throw new UnterminatedQuoteError({
        line: this.quoteLine,
        column: this.quoteColumn,
        rowIndex: this.quoteRowIndex,
      });
    }
    if (this.state !== S.FIELD_START || this.field.length > 0 || this.row.length > 0) {
      this._endRecord(false);
    }
    return this.rows;
  }

  /** Convenience: tokenize a whole string in one go. */
  static run(input, options = {}) {
    const tz = new Tokenizer(options);
    tz.push(input);
    return tz.flush();
  }

  _isDelimiter(str, i) {
    const d = this.delimiter;
    if (d.length === 1) return str.charCodeAt(i) === d.charCodeAt(0);
    return str.startsWith(d, i);
  }

  /**
   * True when the text from `i` is a strict, incomplete prefix of the
   * delimiter -- i.e. the chunk ends in the first half of a multi-character
   * delimiter, so the match cannot be decided until more input arrives.
   *
   * Only consulted outside a quoted field: inside quotes a delimiter is ordinary
   * data, and there is nothing to decide. For a single-character delimiter this
   * is always false, so the common path is unaffected.
   *
   * A record break always outranks the delimiter. A lone `\r` at the end of a
   * chunk terminates the record no matter what follows it -- the `skipLF` flag
   * exists precisely so the LF half of a CRLF is swallowed as part of that same
   * break. So withholding a trailing `\r` because it might begin a `\r\n`
   * DELIMITER would make the same bytes parse as one record one way and two the
   * other. `\r\n` is not a sensible delimiter anyway (it is the record
   * separator), but the tokenizer must not corrupt data because of it.
   */
  _partialDelimiter(str, i) {
    const d = this.delimiter;
    if (d.length === 1) return false;
    if (this.state === S.QUOTED || this.state === S.QUOTE_IN_QUOTED) return false;
    if (str.charCodeAt(i) === 0x0d /* \r */ || str.charCodeAt(i) === 0x0a /* \n */) {
      return false;
    }
    const rest = str.length - i;
    if (rest >= d.length) return false;
    return d.startsWith(str.slice(i));
  }

  _nextLine() {
    this.line += 1;
    this.column = 1;
  }

  _endField() {
    // A completed field means the record has content, even if that field is
    // the empty string (a bare empty cell or a quoted `""`).
    this.recordTouched = true;
    const f = this.field;
    this.field = [];
    this.row.push(f.length === 1 ? f[0] : f.join(''));
  }

  /** Close the current record; returns the input chars it consumed. */
  _endRecord(sawCR) {
    // A record is blank when the line held nothing at all: no delimiter, no
    // data, no quotes. It must be told apart from a record of one empty field
    // (`""` or an empty cell), because only the first is an empty LINE. Once
    // the record is a plain string[] that distinction is gone for good, so it
    // is captured here where the input is still being read.
    const blank = !this.recordTouched;
    this._endField();
    const fields = this.row;
    this.row = [];
    const rowIndex = this.rowIndex;
    const line = this.rowStartLine;
    this.rowIndex += 1;
    this.rows.push(
      this.positions ? { fields, line, rowIndex, blank } : fields
    );
    // A record break consumes exactly one line: a bare CR ends the line here and
    // the LF of a CRLF pair is swallowed by skipLF without counting again.
    // Column restarts at 1 so positions stay relative to the record start.
    this.line += 1;
    this.column = 1;
    this.rowStartLine = this.line;
    this.state = S.FIELD_START;
    this.insideCR = false;
    this.recordTouched = false;
    // Outside quotes a CRLF is one record break; the LF must be swallowed.
    this.skipLF = sawCR;
    return 1;
  }
}

/**
 * Tokenize a complete string into records.
 * @returns {string[][]|Array<{fields:string[],line:number,rowIndex:number}>}
 */
function tokenize(input, options = {}) {
  if (typeof input !== 'string') {
    throw new TypeError('tokenize: input must be a string');
  }
  return Tokenizer.run(input, options);
}

module.exports = {
  DEFAULTS,
  DELIMITER_CANDIDATES,
  QUOTE_CANDIDATES,
  EXIT_DATA_ERROR,
  CsvError,
  UnterminatedQuoteError,
  RaggedRowError,
  Tokenizer,
  tokenize,
};