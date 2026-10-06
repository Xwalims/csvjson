'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'csvjson.js');
const CWD = path.join(__dirname, '..');
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_DATA_ERROR = 3;

/** Run the real bin and capture stdout, stderr and the exit code. */
function run(args, input) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    input: input === undefined ? '' : input,
    encoding: 'utf8',
    cwd: CWD,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A scratch directory that cleans itself up. */
function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvjson-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cli: --help exits 0 and prints usage', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, EXIT_OK);
  assert.match(r.stdout, /csvjson to-json/);
});

test('cli: --version exits 0 and prints the package version', () => {
  const r = run(['--version']);
  assert.strictEqual(r.status, EXIT_OK);
  assert.strictEqual(r.stdout.trim(), require('../package.json').version);
});

test('cli: to-json reads stdin and writes JSON to stdout', () => {
  const r = run(['to-json', '-'], 'a,b\n1,2\n');
  assert.strictEqual(r.status, EXIT_OK);
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 1, b: 2 }]);
});

test('cli: to-json -o writes the file instead of stdout', (t) => {
  const dir = tmpdir(t);
  const out = path.join(dir, 'out.json');
  const r = run(['to-json', '-', '-o', out], 'a,b\n1,2\n');
  assert.strictEqual(r.status, EXIT_OK);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [{ a: 1, b: 2 }]);
});

test('cli: to-csv round-trips a file back to the original bytes', (t) => {
  const dir = tmpdir(t);
  const csvPath = path.join(dir, 'in.csv');
  const jsonPath = path.join(dir, 'out.json');
  const backPath = path.join(dir, 'back.csv');
  // An embedded newline and a comma inside quotes, plus a lone quote field.
  const original = 'name,qty,note\nwidget,3,"has, comma"\ngadget,5,"line1\nline2"\n';
  fs.writeFileSync(csvPath, original);

  assert.strictEqual(run(['to-json', csvPath, '-o', jsonPath]).status, EXIT_OK);
  assert.strictEqual(run(['to-csv', jsonPath, '-o', backPath]).status, EXIT_OK);
  assert.strictEqual(fs.readFileSync(backPath, 'utf8'), original, 'byte-for-byte round trip');
});

test('cli: to-json -o keeps an embedded newline intact in the JSON', (t) => {
  const dir = tmpdir(t);
  const csvPath = path.join(dir, 'in.csv');
  const jsonPath = path.join(dir, 'out.json');
  fs.writeFileSync(csvPath, 'a,b\n1,"x\ny"\n');
  run(['to-json', csvPath, '-o', jsonPath]);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(parsed[0].b, 'x\ny');
});

test('cli: exit code 3 on a file with an unterminated quote', (t) => {
  // Ground truth first, and it says these bytes are NOT malformed: python's
  // csv.reader with quotechar "'" reads them as a clean three-row table
  // ([['a','b'], ['c','"unterminated'], ['d','e']]), because a '"' that opens a
  // field is only an opener under a dialect whose quotechar it is. The previous
  // fixtures stranded an opener under BOTH candidates only by accident -- under
  // quotechar "'" they were ordinary text -- so detection picked the quote that
  // could read the file and the file is reported as the data it is.
  //
  // The exit-3 path still has to work, so the fixture here strands an opener
  // under BOTH candidates: one '"' and one "'", neither closed. csv.reader
  // errors on this under either quotechar (strict=True reports "unexpected end
  // of data" for both), so there is no legal reading left to fall back to.
  const dir = tmpdir(t);
  const bad = path.join(dir, 'bad.csv');
  fs.writeFileSync(bad, 'a,b\nc,"unterminated\nd,\'dangling\n');
  const r = run(['to-json', bad]);
  assert.strictEqual(r.status, EXIT_DATA_ERROR, 'malformed CSV must be distinguishable from a crash');
  assert.match(r.stderr, /unterminated quoted field/);
});

test('cli: exit code 3 on an unterminated quote with no trailing newline', (t) => {
  const dir = tmpdir(t);
  const bad = path.join(dir, 'bad2.csv');
  fs.writeFileSync(bad, 'a,b\nc,"unterminated\nd,\'dangling');
  const r = run(['to-json', bad]);
  assert.strictEqual(r.status, EXIT_DATA_ERROR);
  assert.match(r.stderr, /unterminated quoted field/);
});

test('cli: a stray quote is data, not malformed input', (t) => {
  // The same bytes as the fixture above with only the '"' opener, which is what
  // the old exit-3 test used. Under quotechar "'" python's csv.reader reports
  // [['a','b'], ['c','"unterminated'], ['d','e']] and under '"' it folds the
  // rest of the file into one field, so the file is legal CSV either way and
  // throwing on it would be reporting a bug in the reader as a bad file.
  // Detection picks the reading that terminates and keeps all three rows.
  const dir = tmpdir(t);
  const f = path.join(dir, 'stray.csv');
  fs.writeFileSync(f, 'a,b\nc,"unterminated\nd,e\n');
  const r = run(['to-json', f]);
  assert.strictEqual(r.status, EXIT_OK);
  const parsed = JSON.parse(r.stdout);
  assert.deepStrictEqual(parsed, [{ a: 'c', b: '"unterminated' }, { a: 'd', b: 'e' }]);
});

test('cli: exit code 3 when --ragged error rejects a short row', () => {
  const r = run(['to-json', '-', '--ragged', 'error'], 'a,b,c\n1,2\n');
  assert.strictEqual(r.status, EXIT_DATA_ERROR);
  assert.match(r.stderr, /ragged row/);
});

test('cli: exit code 2 for a missing input file', (t) => {
  const dir = tmpdir(t);
  const r = run(['to-json', path.join(dir, 'nope.csv')]);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /no such file/);
});

test('cli: exit code 2 for an unknown command', () => {
  const r = run(['frobnicate', '-']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /unknown command/);
});

test('cli: exit code 2 for an unknown option', () => {
  const r = run(['to-json', '-', '--bogus']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /unknown option/);
});

test('cli: exit code 2 for an invalid --types value', () => {
  const r = run(['to-json', '-', '--types', 'bogus']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--types/);
});

test('cli: exit code 2 for invalid JSON on to-csv', () => {
  const r = run(['to-csv', '-'], '{not json');
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /not valid JSON/);
});

test('cli: exit code 2 when no command is given', () => {
  const r = run([]);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /command is required/);
});

test('cli: --delimiter overrides detection', () => {
  const r = run(['to-json', '-', '--delimiter', ';', '--compact'], 'a;b\n1;2\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 1, b: 2 }]);
});

test('cli: --delimiter accepts the \\t escape', () => {
  const r = run(['to-json', '-', '--delimiter', '\\t', '--compact'], 'a\tb\n1\t2\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 1, b: 2 }]);
});

test('cli: --quote selects an alternate quote character', () => {
  const r = run(['to-json', '-', '--quote', "'", '--compact'], "a,b\n'x,y',2\n");
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 'x,y', b: 2 }]);
});

test('cli: --no-header treats the first row as data', () => {
  const r = run(['to-json', '-', '--no-header', '--compact'], '1,2\n3,4\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [
    { 0: 1, 1: 2 },
    { 0: 3, 1: 4 },
  ]);
});

test('cli: --types all-string keeps every value a string', () => {
  const r = run(['to-json', '-', '--types', 'all-string', '--compact'], 'a,b\n1,2\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: '1', b: '2' }]);
});

test('cli: --ndjson emits one object per line', () => {
  const r = run(['to-json', '-', '--ndjson'], 'a,b\n1,2\n3,4\n');
  const lines = r.stdout.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map((l) => JSON.parse(l)), [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ]);
});

test('cli: --columns emits a column-oriented document', () => {
  const r = run(['to-json', '-', '--columns', '--compact'], 'a,b\n1,2\n3,4\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), {
    columns: { a: [1, 3], b: [2, 4] },
    rows: 2,
  });
});

test('cli: --transpose swaps rows and columns', () => {
  const r = run(['to-json', '-', '--transpose', '--compact'], 'name,qty\nw,1\ng,2\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ name: 'qty', w: 1, g: 2 }]);
});

test('cli: --ragged pad and --pad-value fill short rows', () => {
  const r = run(['to-json', '-', '--ragged', 'pad', '--pad-value', 'NA', '--compact'], 'a,b,c\n1,2\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 1, b: 2, c: 'NA' }]);
});

test('cli: --ragged dump moves overflow into an array', () => {
  const r = run(['to-json', '-', '--ragged', 'dump', '--compact'], 'a,b\n1,2,3,4\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 1, b: ['2', '3', '4'] }]);
});

test('cli: --stats writes a summary to stderr and keeps stdout clean', () => {
  const r = run(['to-json', '-', '--stats'], 'a,b\n1,2\n');
  assert.strictEqual(r.status, EXIT_OK);
  JSON.parse(r.stdout);
  assert.match(r.stderr, /rows: 1/);
  assert.match(r.stderr, /columns: 2/);
});

test('cli: --compact produces single-line JSON', () => {
  const r = run(['to-json', '-', '--compact'], 'a,b\n1,2\n');
  assert.strictEqual(r.stdout.trim().includes('\n'), false);
});

test('cli: to-csv --no-header omits the header record', () => {
  const r = run(['to-csv', '-', '--no-header'], '[{"a":1,"b":2}]');
  assert.strictEqual(r.stdout, '1,2\n');
});

test('cli: to-csv --eol crlf emits CRLF records', () => {
  const r = run(['to-csv', '-', '--eol', 'crlf'], '[{"a":1,"b":2}]');
  assert.strictEqual(r.stdout, 'a,b\r\n1,2\r\n');
});

test('cli: to-csv --delimiter writes the requested separator', () => {
  const r = run(['to-csv', '-', '--delimiter', ';'], '[{"a":1,"b":2}]');
  assert.strictEqual(r.stdout, 'a;b\n1;2\n');
});

test('cli: a BOM is stripped on input', () => {
  const r = run(['to-json', '-', '--compact'], '﻿a,b\n1,2\n');
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 1, b: 2 }]);
});

test('cli: a full stdin pipeline preserves an embedded newline byte-for-byte', () => {
  const r = run(['to-json', '-'], 'a,b\n1,"p\nq"\n');
  assert.strictEqual(r.status, EXIT_OK);
  assert.ok(r.stdout.includes('\\n'), 'the newline is encoded as an escape in JSON');
  assert.strictEqual(JSON.parse(r.stdout)[0].b, 'p\nq');
});