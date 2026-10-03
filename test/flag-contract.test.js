'use strict';

// Flag contract, both directions. Neither existed for csvjson, which is how
// `-V` shipped as a working alias present in no help text and no README — a
// feature you could only find by reading src/cli.js.
//
// Direction 3 (source -> help) is the important one: a flag that parses and
// works but is documented in zero places is a shipped feature nobody can reach.
// The oracle is the parser's own switch, not this file's hand-kept list, so a
// new flag cannot be added without either showing up in help or failing here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'csvjson.js');
const SRC = path.join(ROOT, 'src', 'cli.js');
const README = path.join(ROOT, 'README.md');

const EXIT_OK = 0;

/** Every flag literal the argument parser actually compares against. */
function sourceFlags() {
  const source = fs.readFileSync(SRC, 'utf8');
  const flags = new Set();
  // `arg === '--x'`, `arg === "-x"` and `arg === '--x' || arg === '-y'`.
  for (const m of source.matchAll(/arg === ['"](--?[a-zA-Z][\w-]*)['"]/g)) {
    flags.add(m[1]);
  }
  // The POSIX end-of-options separator, which is a real token in the chain.
  for (const m of source.matchAll(/arg === ['"](--)['"]/g)) {
    flags.add(m[1]);
  }
  return [...flags].sort();
}

/** Flags that need a value, taken from the same comparison chain. */
const VALUED = ['-o', '--output', '--delimiter', '-d', '--quote', '-q',
  '--types', '--ragged', '--pad-value', '--json', '--indent', '--eol'];

function helpText() {
  const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.strictEqual(res.status, EXIT_OK, '--help must exit 0');
  return res.stdout;
}

function readme() {
  return fs.readFileSync(README, 'utf8');
}

/** Run the real bin with one flag and report why it stopped, if it did. */
function probe(flag) {
  const res = spawnSync(process.execPath, [BIN, 'to-json', flag], {
    input: '',
    encoding: 'utf8',
    cwd: ROOT,
  });
  return `${res.stderr}\n${res.stdout}`;
}

/**
 * Is `flag` present in `text` as a WHOLE token?
 *
 * A plain substring test is vacuous for short flags: help contains `--delimiter`,
 * so `help.includes('-d')` is true whether or not `-d` was ever documented, and
 * the same trap holds for -q inside --quote, -h inside --help, -o inside
 * --output. The lookarounds reject a longer dash run and a longer word, so only
 * a real occurrence counts.
 */
function mentions(text, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
  return re.test(text);
}

test('flag contract: the parser source yields a non-empty flag set', () => {
  // Guard for the guard: a regex that silently matches nothing makes every
  // other assertion in this file vacuous.
  const flags = sourceFlags();
  assert.ok(flags.length >= 20, `only found ${flags.length}: ${flags.join(' ')}`);
  assert.ok(flags.includes('--transpose'));
  assert.ok(flags.includes('-d'), 'the short delimiter alias must be in the oracle');
  assert.ok(flags.includes('-V'));
});

test('flag contract: mentions() is not fooled by a substring', () => {
  // The guard for the guard: without this, `mentions('--delimiter', '-d')`
  // passing would prove nothing.
  assert.strictEqual(mentions('--delimiter <char>', '-d'), false);
  assert.strictEqual(mentions('--delimiter <char>', '--delimiter'), true);
  assert.strictEqual(mentions('-d, --delimiter <char>', '-d'), true);
  assert.strictEqual(mentions('--quote <char>', '-q'), false);
  assert.strictEqual(mentions('--no-color', '--color'), false);
  assert.strictEqual(mentions('trailing-dash-', '-'), false);
  assert.strictEqual(mentions('a -- b', '--'), true);
});

test('flag contract: every flag the parser accepts appears in --help', () => {
  const help = helpText();
  const hidden = sourceFlags().filter((f) => !mentions(help, f));
  assert.deepStrictEqual(hidden, [], `undocumented in --help: ${hidden.join(' ')}`);
});

test('flag contract: every flag the parser accepts appears in the README', () => {
  const doc = readme();
  const missing = sourceFlags().filter((f) => !mentions(doc, f));
  assert.deepStrictEqual(missing, [], `undocumented in README: ${missing.join(' ')}`);
});

test('flag contract: no phantom flag — everything in --help really parses', () => {
  const help = helpText();
  const usage = help.slice(help.indexOf('Usage:'));
  const named = [...new Set((usage.match(/(?<!-)(--[a-z][a-z0-9-]*)/g) || []))];
  assert.ok(named.length >= 10, `only found ${named.length} flags in the usage block`);
  for (const flag of named) {
    assert.doesNotMatch(
      probe(flag),
      /unknown option/,
      `${flag} is in --help but the parser rejects it`
    );
  }
});

test('flag contract: every valued flag reports "requires a value" when bare', () => {
  for (const flag of VALUED) {
    assert.match(
      probe(flag),
      /requires a value/,
      `${flag} should demand a value instead of silently using the default`
    );
  }
});

test('flag contract: every boolean flag is accepted without a value', () => {
  const valued = new Set(VALUED);
  for (const flag of sourceFlags()) {
    if (valued.has(flag) || flag === '--') continue;
    assert.doesNotMatch(
      probe(flag),
      /requires a value/,
      `${flag} is boolean and must not demand a value`
    );
  }
});

test('flag contract: the README option table lists the same valued flags', () => {
  const doc = readme();
  const table = doc.slice(doc.indexOf('## Options'));
  for (const flag of VALUED) {
    if (flag.startsWith('-') && !flag.startsWith('--')) continue; // short aliases are grouped
    assert.ok(table.includes(flag), `the option table omits ${flag}`);
  }
});
