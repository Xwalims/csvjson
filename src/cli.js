'use strict';

/**
 * csvjson — command line interface.
 *
 *   csvjson to-json <in.csv>  [-o out.json]
 *   csvjson to-csv  <in.json> [-o out.csv]
 *
 * `-` means stdin/stdout. Exit codes:
 *   0  success
 *   2  usage or I/O error
 *   3  malformed CSV (e.g. an unterminated quote) — a data error, not a crash
 */

const fs = require('fs');

const { DEFAULTS, CsvError, EXIT_DATA_ERROR } = require('./tokenize.js');
const { parseCsv, RAGGED_MODES } = require('./parse.js');
const { TYPES } = require('./infer.js');
const { toJson, fromJson, SHAPES, columnsToRows, transposeTable } = require('./stringify.js');

const EXIT_OK = 0;
const EXIT_USAGE = 2;

const USAGE = `csvjson — RFC 4180 CSV to JSON and back, zero dependencies

Usage:
  csvjson to-json <in.csv> [-o out.json] [options]
  csvjson to-csv  <in.json> [-o out.csv]  [options]
  csvjson --help
  csvjson --version

  A bare "--" ends option parsing, so a filename that starts with "-" can be
  passed as the input: csvjson -- to-json -weird.csv

Options:
  -h, --help              Print this usage
  -V, --version           Print the version
  -o, --output <file>     Write to <file> ("-" means stdout, the default)
      --delimiter <char>  Field delimiter (default: detect , ; tab |)
  -d, --delimiter <char>  Short form of --delimiter
      --quote <char>      Quote character (default: detect " ')
  -q, --quote <char>      Short form of --quote
      --no-detect          Skip dialect detection; use the defaults
      --no-header          The first record is data, not column names
      --types <mode>      ${TYPES.join('|')} (default: auto)
      --ragged <mode>     ${RAGGED_MODES.join('|')} (default: pad)
      --pad-value <value> Filler for missing cells under --ragged pad
      --json <shape>       ${SHAPES.join('|')} (default: objects; to-json)
      --ndjson             Shorthand for --json ndjson
      --columns            Shorthand for --json columns
      --transpose          Swap rows and columns
      --stats              Print a summary to stderr
      --compact            Compact JSON (no indentation)
      --indent <n>         Indent JSON by n spaces (default: 2)
      --quote-all          Quote every field on write (to-csv)
      --eol <eol>          Record separator for to-csv: lf | crlf (default: lf)
      --no-trailing-nl     Do not emit a final record separator (to-csv)

Exit codes:
  0  ok
  2  usage or I/O error
  3  malformed CSV (unterminated quote, ragged row with --ragged error)
`;

/** Print to stderr so stdout stays clean for piping. */
function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`csvjson: ${message}\n`);
  return code;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    if (err && err.code === 'EAGAIN') return fs.readFileSync('/dev/stdin', 'utf8');
    throw err;
  }
}

function readInput(file) {
  if (file === '-' || file === undefined) return readStdin();
  return fs.readFileSync(file, 'utf8');
}

function writeOutput(file, text) {
  if (!file || file === '-') {
    process.stdout.write(text);
    return;
  }
  fs.writeFileSync(file, text);
}

/**
 * Parse argv into {command, input, options, errors, help, version}.
 * @param {string[]} argv arguments after the program name
 */
function parseArgs(argv) {
  const options = Object.assign({}, DEFAULTS);
  const errors = [];
  let command = null;
  let input = null;
  let output = null;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        errors.push(`option ${arg} requires a value`);
        return null;
      }
      i += 1;
      return v;
    };

    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-V') {
      version = true;
    } else if (arg === '-o' || arg === '--output') {
      const v = next();
      if (v !== null) output = v;
    } else if (arg === '--delimiter' || arg === '-d') {
      const v = next();
      if (v === null) continue;
      if (v === '\\t') options.delimiter = '\t';
      else if (Array.from(v).length !== 1) errors.push('--delimiter must be a single character');
      else options.delimiter = v;
    } else if (arg === '--quote' || arg === '-q') {
      const v = next();
      if (v === null) continue;
      if (Array.from(v).length !== 1) errors.push('--quote must be a single character');
      else options.quote = v;
    } else if (arg === '--no-detect') {
      options.detect = false;
    } else if (arg === '--no-header') {
      options.header = false;
    } else if (arg === '--types') {
      const v = next();
      if (v === null) continue;
      if (!TYPES.includes(v)) errors.push(`--types must be one of ${TYPES.join('|')}`);
      else options.types = v;
    } else if (arg === '--ragged') {
      const v = next();
      if (v === null) continue;
      if (!RAGGED_MODES.includes(v)) errors.push(`--ragged must be one of ${RAGGED_MODES.join('|')}`);
      else options.ragged = v;
    } else if (arg === '--pad-value') {
      const v = next();
      if (v === null) continue;
      options.padValue = v;
    } else if (arg === '--json') {
      const v = next();
      if (v === null) continue;
      if (!SHAPES.includes(v)) errors.push(`--json must be one of ${SHAPES.join('|')}`);
      else options.shape = v;
    } else if (arg === '--ndjson') {
      options.shape = 'ndjson';
    } else if (arg === '--columns') {
      options.shape = 'columns';
    } else if (arg === '--transpose') {
      options.transpose = true;
    } else if (arg === '--stats') {
      options.stats = true;
    } else if (arg === '--compact') {
      options.indent = 0;
    } else if (arg === '--indent') {
      const v = next();
      if (v === null) continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) errors.push('--indent must be a non-negative integer');
      else options.indent = n;
    } else if (arg === '--quote-all') {
      options.quoteAll = true;
    } else if (arg === '--eol') {
      const v = next();
      if (v === null) continue;
      if (v === 'lf' || v === '\n') options.eol = '\n';
      else if (v === 'crlf' || v === '\r\n') options.eol = '\r\n';
      else errors.push('--eol must be lf or crlf');
    } else if (arg === '--no-trailing-nl') {
      options.trailingNewline = false;
    } else if (arg === '--') {
      // POSIX end-of-options: every remaining argument is positional, including
      // one that starts with '-'. The old code swallowed only the first one and
      // discarded the rest, so `csvjson -- to-json in.csv` reported "a command
      // is required" and a second path vanished without a word.
      const rest = argv.slice(i + 1);
      i = argv.length;
      for (const positional of rest) {
        if (command === null) command = positional;
        else if (input === null) input = positional;
        else errors.push(`unexpected argument: ${positional}`);
      }
    } else if (arg.charAt(0) === '-' && arg !== '-') {
      errors.push(`unknown option: ${arg}`);
    } else if (command === null) {
      command = arg;
    } else if (input === null) {
      input = arg;
    } else {
      errors.push(`unexpected argument: ${arg}`);
    }
  }

  return { command, input, output, options, errors, help, version };
}

function statsFor(table, inputFile) {
  const lines = [
    `rows: ${table.rowCount}`,
    `columns: ${table.columnCount}`,
    `delimiter: ${JSON.stringify(table.delimiter)}`,
    `quote: ${JSON.stringify(table.quote)}`,
  ];
  if (table.types && table.types.length) {
    lines.push(`types: ${table.types.join(',')}`);
  }
  if (table.header) lines.push(`header: ${table.header.join(',')}`);
  if (table.ragged.length) {
    lines.push(`ragged: ${table.ragged.length} row(s) reconciled as ${DEFAULTS.ragged}`);
  }
  void inputFile;
  return lines.join('\n');
}

function cmdToJson(ctx) {
  const { input, output, options } = ctx;
  const source = readInput(input);
  const table = parseCsv(source, options);
  const text = toJson(table, options);
  writeOutput(output, text + '\n');
  if (options.stats) process.stderr.write(statsFor(table, input) + '\n');
  return EXIT_OK;
}

function cmdToCsv(ctx) {
  const { input, output, options } = ctx;
  const source = readInput(input);
  let data;
  try {
    data = JSON.parse(source);
  } catch (err) {
    return fail(`input is not valid JSON: ${err.message}`, EXIT_USAGE);
  }
  if (options.transpose && data && !Array.isArray(data) && data.columns) {
    // Rebuild a real table and hand it to the same transposeTable() that
    // `to-json --transpose` uses, so the two documented routes cannot drift.
    //
    // The old loop walked `data.rows`, which in the {columns, rows} shape is a
    // ROW COUNT and not a record count, and named each output record with
    // `names[i]`. So it built one output column per data row rather than one
    // per original column, and past names.length the first column silently
    // became undefined. On a square table those two mistakes cancelled and the
    // input came back unchanged; on anything non-square it emitted empty
    // trailing columns and disagreed with `to-json --transpose`.
    //
    // `rows` is a row COUNT and only a hint. `to-json --columns` always writes
    // the true height, but a hand-written document can lie about it, and the old
    // loop used the lie as its bound — the 2x2 case grew to 99 output rows.
    // Honouring a larger lie would pad with phantom empty columns, so take the
    // height from the column arrays themselves, which are the authority.
    const names = Object.keys(data.columns);
    const height = names.reduce((m, n) => Math.max(m, data.columns[n].length), 0);
    const table = transposeTable({
      header: options.header === false ? null : names,
      rows: columnsToRows(data.columns, height),
    });
    // fromJson writes element 0 as the header record, which is exactly the
    // shape transposeTable returns.
    data = table.header ? [table.header, ...table.rows] : table.rows;
  }
  const text = fromJson(data, options);
  writeOutput(output, text);
  if (options.stats) {
    process.stderr.write(
      ['records: ' + (Array.isArray(data) ? data.length : data.rows), 'delimiter: ' + JSON.stringify(options.delimiter || ',')].join('\n') + '\n'
    );
  }
  return EXIT_OK;
}

/**
 * CLI entry point.
 * @param {string[]} argv arguments after the program name
 * @param {{stdout?:(s:string)=>void}} [io]
 * @returns {number} process exit code
 */
function main(argv, io = {}) {
  const write = io.stdout || ((s) => process.stdout.write(s));
  const ctx = parseArgs(argv);

  if (ctx.help) {
    write(USAGE);
    return EXIT_OK;
  }
  if (ctx.version) {
    write(require('../package.json').version + '\n');
    return EXIT_OK;
  }
  if (ctx.errors.length) {
    return fail(ctx.errors.join('; ') + '\n\n' + USAGE, EXIT_USAGE);
  }
  if (ctx.command === null) {
    return fail('a command is required\n\n' + USAGE, EXIT_USAGE);
  }
  if (ctx.command !== 'to-json' && ctx.command !== 'to-csv') {
    return fail(`unknown command: ${ctx.command}\n\n${USAGE}`, EXIT_USAGE);
  }
  if (ctx.input === null && ctx.command !== 'to-json') {
    return fail('an input file (or -) is required', EXIT_USAGE);
  }

  try {
    return ctx.command === 'to-json' ? cmdToJson(ctx) : cmdToCsv(ctx);
  } catch (err) {
    if (err instanceof CsvError) {
      process.stderr.write(`csvjson: ${err.message}\n`);
      return EXIT_DATA_ERROR;
    }
    if (err && err.code === 'ENOENT') {
      return fail(`no such file: ${ctx.input}`, EXIT_USAGE);
    }
    if (err && err.code === 'EACCES') {
      return fail(`permission denied: ${ctx.input}`, EXIT_USAGE);
    }
    return fail(err && err.message ? err.message : String(err), EXIT_USAGE);
  }
}

module.exports = { main, parseArgs, USAGE, EXIT_OK, EXIT_USAGE, EXIT_DATA_ERROR };