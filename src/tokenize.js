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
  }

  /** Feed a chunk of input; returns the same array every record is appended to. */
  push(chunk) {
    const str = String(chunk);
    const n = str.length;
    let i = 0;
    while (i < n) {
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
        if (this._isDelimiter(str, i)) {
          i += this.delimiter.length;
          this._endField();
          this.state = S.FIELD_START;
          this.column += 1;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          i += this._endRecord(ch === '\r');
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
      this.field.push(ch);
      this.column += 1;
      i += 1;
    }
    return this.rows;
  }

  /** Signal end of input. Throws UnterminatedQuoteError on an open quote. */
  flush() {
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

  _nextLine() {
    this.line += 1;
    this.column = 1;
  }

  _endField() {
    const f = this.field;
    this.field = [];
    this.row.push(f.length === 1 ? f[0] : f.join(''));
  }

  /** Close the current record; returns the input chars it consumed. */
  _endRecord(sawCR) {
    this._endField();
    const fields = this.row;
    this.row = [];
    const rowIndex = this.rowIndex;
    const line = this.rowStartLine;
    this.rowIndex += 1;
    this.rows.push(this.positions ? { fields, line, rowIndex } : fields);
    // A record break consumes exactly one line: a bare CR ends the line here and
    // the LF of a CRLF pair is swallowed by skipLF without counting again.
    // Column restarts at 1 so positions stay relative to the record start.
    this.line += 1;
    this.column = 1;
    this.rowStartLine = this.line;
    this.state = S.FIELD_START;
    this.insideCR = false;
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