'use strict';

// The coverage report said src/cli.js sat at 86.7% of lines and 69.1% of
// branches, with these paths untouched: every `--` end-of-options form, the
// `--json bogus` / `--eol bogus` / `--indent -1` validators, missing values,
// the missing-command and missing-input guards, "unexpected argument", the
// EACCES branch, and both `--stats` summaries.
//
// Everything here runs the real bin through spawnSync, so the exit codes under
// test are the ones a shell caller sees, not the ones a direct require() call
// returns.

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

function run(args, input) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    input: input === undefined ? '' : input,
    encoding: 'utf8',
    cwd: CWD,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvjson-clause-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- `--` ----

test('cli: `--` ends options and the command after it still runs', (t) => {
  const dir = tmpdir(t);
  const csvPath = path.join(dir, 'in.csv');
  fs.writeFileSync(csvPath, 'a,b\n1,2\n');
  const r = run(['--', 'to-json', csvPath]);
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 1, b: 2 }]);
});

test('cli: `--` keeps a leading-dash filename as the input', (t) => {
  const dir = tmpdir(t);
  const csvPath = path.join(dir, '-weird.csv');
  fs.writeFileSync(csvPath, 'a,b\n3,4\n');
  const r = run(['--', 'to-json', csvPath]);
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 3, b: 4 }]);
});

test('cli: `--` does not silently drop a third positional argument', () => {
  // The old parser took rest[0] and threw the rest away without a word.
  const r = run(['--', 'to-json', '-', 'second.csv', 'third.csv']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /unexpected argument: second\.csv; unexpected argument: third\.csv/);
});

test('cli: a bare `--` after the command is harmless', (t) => {
  const dir = tmpdir(t);
  const csvPath = path.join(dir, 'in.csv');
  fs.writeFileSync(csvPath, 'a,b\n5,6\n');
  const r = run(['to-json', '--', csvPath]);
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [{ a: 5, b: 6 }]);
});

// ------------------------------------------------------- value validators ----

test('cli: exit code 2 for an invalid --json shape', () => {
  const r = run(['to-json', '-', '--json', 'bogus']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--json must be one of objects\|ndjson\|columns/);
});

test('cli: exit code 2 for an invalid --eol value', () => {
  const r = run(['to-json', '-', '--eol', 'bogus']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--eol must be lf or crlf/);
});

test('cli: a negative --indent is rejected', () => {
  const r = run(['to-json', '-', '--indent', '-1']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--indent must be a non-negative integer/);
});

test('cli: a non-numeric --indent is rejected', () => {
  const r = run(['to-json', '-', '--indent', 'x']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--indent must be a non-negative integer/);
});

test('cli: --indent 0 equals --compact', () => {
  const a = run(['to-json', '-', '--compact'], 'a,b\n1,2\n');
  const b = run(['to-json', '-', '--indent', '0'], 'a,b\n1,2\n');
  assert.strictEqual(a.status, EXIT_OK);
  assert.strictEqual(a.stdout, b.stdout);
});

test('cli: exit code 2 for a multi-character --delimiter', () => {
  const r = run(['to-json', '-', '--delimiter', 'ab']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--delimiter must be a single character/);
});

test('cli: exit code 2 for a multi-character --quote', () => {
  const r = run(['to-json', '-', '--quote', '""']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--quote must be a single character/);
});

// -------------------------------------------------------- missing values ----

test('cli: a value-taking option with no value names the option', () => {
  for (const flag of ['--delimiter', '--quote', '--types', '--ragged',
    '--pad-value', '--json', '--indent', '--eol', '--output']) {
    const r = run(['to-json', '-', flag]);
    assert.strictEqual(r.status, EXIT_USAGE, `${flag} should exit 2`);
    assert.match(r.stderr, new RegExp(`option ${flag} requires a value`));
  }
});

// ---------------------------------------------------------- guards ----------

test('cli: exit code 2 when no command is given after `--`', () => {
  const r = run(['--']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /command is required/);
});

test('cli: exit code 2 when to-csv gets no input file', () => {
  const r = run(['to-csv']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /an input file \(or -\) is required/);
});

test('cli: exit code 2 for a third positional argument without `--`', () => {
  const r = run(['to-json', '-', 'extra.csv']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /unexpected argument: extra\.csv/);
});

test('cli: exit code 2 for an unreadable input file', (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root ignores file permissions, so EACCES cannot be provoked here');
    return;
  }
  const dir = tmpdir(t);
  const locked = path.join(dir, 'locked.csv');
  fs.writeFileSync(locked, 'a,b\n1,2\n');
  fs.chmodSync(locked, 0o000);
  t.after(() => {
    try {
      fs.chmodSync(locked, 0o644);
    } catch {
      /* the temp dir may already be gone */
    }
  });
  const r = run(['to-json', locked]);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /permission denied/);
});

// -------------------------------------------------------------- to-csv -----

test('cli: to-csv --quote-all quotes every field', () => {
  const r = run(['to-csv', '-', '--quote-all'], '[{"a":1,"b":"x"}]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, '"a","b"\n"1","x"\n');
});

test('cli: --stats reports the ragged-row count and the reconciled mode', () => {
  const r = run(['to-json', '-', '--ragged', 'pad', '--pad-value', 'NA', '--stats'],
    'a,b,c\n1,2\n');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.match(r.stderr, /rows: 1/);
  assert.match(r.stderr, /header: a,b,c/);
  assert.match(r.stderr, /ragged: 1 row\(s\) reconciled as pad/);
});

test('cli: --stats omits the ragged line when every row is rectangular', () => {
  const r = run(['to-json', '-', '--stats'], 'a,b\n1,2\n3,4\n');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.doesNotMatch(r.stderr, /ragged:/);
});

test('cli: --stats reports the detected dialect on stderr', () => {
  const r = run(['to-json', '-', '--stats'], 'a;b\n1;2\n');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.match(r.stderr, /delimiter: ";"/);
});

test('cli: to-csv --quote-all is applied to every cell, not just risky ones', () => {
  const r = run(['to-csv', '-', '--quote-all'], '[{"plain":"x","risky":"a,b"}]');
  assert.strictEqual(r.stdout, '"plain","risky"\n"x","a,b"\n');
});

test('cli: to-csv on an array of scalars invents a "value" column', () => {
  const r = run(['to-csv', '-'], '[1,"two",null]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, 'value\n1\ntwo\n\n');
});

test('cli: to-csv --no-header on an array of scalars writes no header', () => {
  const r = run(['to-csv', '-', '--no-header'], '[1,2]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, '1\n2\n');
});

test('cli: to-csv on an empty array writes nothing', () => {
  const r = run(['to-csv', '-'], '[]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, '');
});

test('cli: to-csv rejects a JSON scalar, which is not a table', () => {
  const r = run(['to-csv', '-'], '42');
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /expected an array or a \{columns, rows\} object/);
});

test('cli: to-csv --transpose is a no-op on an array input', () => {
  // --transpose only rewrites the {columns, rows} shape; fromJson sees an array
  // and never sees options.transpose.
  const r = run(['to-csv', '-', '--transpose'], '[{"a":1,"b":2}]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, 'a,b\n1,2\n');
});

test('cli: to-csv --no-trailing-nl omits the final separator', () => {
  const r = run(['to-csv', '-', '--no-trailing-nl'], '[{"a":1},{"a":2}]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, 'a\n1\n2');
});

test('cli: to-csv --transpose on a {columns, rows} document swaps them', () => {
  const r = run(['to-csv', '-', '--transpose'],
    '{"columns":{"a":[1,2],"b":["x","y"]},"rows":2}');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, 'a,b\n1,2\nx,y\n');
});

test('cli: to-csv --stats reports the record count on stderr', () => {
  const r = run(['to-csv', '-', '--stats'], '[{"a":1},{"a":2},{"a":3}]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, 'a\n1\n2\n3\n', 'stdout stays clean');
  assert.match(r.stderr, /records: 3/);
  assert.match(r.stderr, /delimiter: ","/);
});

test('cli: to-csv --eol crlf records end with CRLF', () => {
  const r = run(['to-csv', '-', '--eol', 'crlf'], '[{"a":1}]');
  assert.strictEqual(r.stdout, 'a\r\n1\r\n');
});

test('cli: to-csv --no-detect is accepted', () => {
  const r = run(['to-csv', '-', '--no-detect'], '[{"a":1}]');
  assert.strictEqual(r.status, EXIT_OK, r.stderr);
  assert.strictEqual(r.stdout, 'a\n1\n');
});
