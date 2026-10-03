#!/usr/bin/env bash
# Do the new regression tests actually catch the bug they describe?
#
# A regression test that passes on the broken code is decoration. This reverts
# the fix in src/tokenize.js, runs ONLY the new test file, and requires it to
# fail. Then it restores the fix and requires the same file to pass.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/tokenize.js
TEST=test/multichar-delimiter.test.js
BAK=$(mktemp)
cp "$SRC" "$BAK"
restore() { cp "$BAK" "$SRC"; rm -f "$BAK"; }
trap restore EXIT

fail=0

revert() {
  cp "$BAK" "$SRC"
  python3 - "$SRC" "$1" "$2" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as fh:
    text = fh.read()
if old not in text:
    print("PATTERN NOT FOUND:", repr(old[:60]))
    sys.exit(3)
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(text.replace(old, new, 1))
PY
  [ $? -ne 3 ] || exit 3
}

expect() {
  local name="$1" want="$2"   # want: fail | pass
  local out rc
  out=$(node --test "$TEST" 2>&1); rc=$?
  if [ "$want" = fail ]; then
    if [ $rc -ne 0 ]; then
      echo "  ok    $name  (the suite catches the revert: $(printf '%s' "$out" | grep -c '^✖') failing test(s))"
    else
      echo "  FAIL  $name  <-- the tests pass on broken code"
      fail=$((fail+1))
    fi
  else
    if [ $rc -eq 0 ]; then
      echo "  ok    $name  (the suite is green on the fixed code)"
    else
      echo "  FAIL  $name  <-- the tests fail on FIXED code"
      printf '%s\n' "$out" | grep '^✖' | head -5
      fail=$((fail+1))
    fi
  fi
}

echo "verifying test/$TEST against the fix:"

# Full revert: no withholding at all, i.e. the code exactly as it was.
revert "if (this._partialDelimiter(str, i) && !this.draining) {" \
       "if (false) {" || exit 1
expect "full revert of the fix" fail

# Partial revert 1: withhold, but never drain at flush(). The end of the file
# is then silently dropped -- a second, independent data-loss bug.
revert "if (this.pending !== '') {
      const held = this.pending;
      this.pending = '';
      this.draining = true;
      try {
        this.push(held);
      } finally {
        this.draining = false;
      }
    }" "if (false) {}" || exit 1
expect "withhold but never drain at flush" fail

# Partial revert 2: drain, but allow the drain to re-withhold itself. The tail is
# released and immediately buffered again, so the data never surfaces.
revert "this.draining = true;
      try {
        this.push(held);
      } finally {
        this.draining = false;
      }" "this.push(held)" || exit 1
expect "drain re-withholds the tail" fail

# Partial revert 3: drop the guard that stops withholding inside a quoted field.
#
# This one is EXPECTED TO SURVIVE, and the harness says so rather than leaving
# the reader to wonder. It is an equivalent mutant: withholding only defers the
# tail to the next push, and the state machine is untouched meanwhile, so the
# same characters are parsed in the same order, just later. Probed directly over
# 423 comparisons (12 inputs x 3 delimiters x {one-shot, per-character, every
# split point}) it changed nothing. The only observable difference is the
# private `pending` field mid-stream, which no caller is documented to read --
# see test/quoting-suppression.test.js, which pins the property the guard really
# protects: a delimiter prefix inside a quoted field is data and must never be
# dropped if the stream ends there.
revert "if (this.state === S.QUOTED || this.state === S.QUOTE_IN_QUOTED) return false;" \
       "" || exit 1
expect "withholding not suppressed inside quotes (equivalent mutant)" pass

# The fixed code must be green.
cp "$BAK" "$SRC"
expect "the fixed code" pass

echo
if [ "$fail" -eq 0 ]; then
  echo "REGRESSION TESTS VERIFIED: they fail without the fix and pass with it"
else
  echo "REGRESSION TESTS BROKEN: $fail problem(s)"
  exit 1
fi