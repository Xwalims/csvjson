#!/usr/bin/env bash
# Does the new sample-boundary test actually catch a revert of the fix?
# Reverting means: parseCsv stops handing detectDialect the full input.
set -uo pipefail
cd "$(dirname "$0")/.."

SRC=src/parse.js
BAK=/home/user/.hermes/cache/scratch/parse.js.keep
cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"' EXIT

echo "--- baseline (fixed code) ---"
node --test 2>&1 | grep -E '^. (pass|fail)' | sed 's/^/  /'

echo "--- mutant: full input withheld again ---"
python3 - "$SRC" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p).read()
old = """    const dialect = detectDialect(sample, {
      quote: opts.quote || undefined,
      full: input,
    });"""
new = """    const dialect = detectDialect(sample, { quote: opts.quote || undefined });"""
assert old in s, "anchor not found"
open(p, "w").write(s.replace(old, new))
print("  mutated")
PY

node --test 2>&1 | grep -E '^. (pass|fail)' | sed 's/^/  /'
echo "--- failing test names ---"
node --test 2>&1 | grep -E '^✖|not ok' | sed 's/^/  /' | head -5

echo "--- mutant: lookahead unbounded (rescue everything) ---"
cp "$BAK" "$SRC"
python3 - "$SRC" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "return input.slice(sampleSize, sampleSize + Math.min(remaining, SNIFF_LOOKAHEAD));"
new = "return input.slice(sampleSize);"
assert old in s, "anchor not found"
open(p, "w").write(s.replace(old, new))
print("  mutated")
PY
node --test 2>&1 | grep -E '^. (pass|fail)' | sed 's/^/  /'

echo "--- restored ---"
cp "$BAK" "$SRC"
node --test 2>&1 | grep -E '^. (pass|fail)' | sed 's/^/  /'