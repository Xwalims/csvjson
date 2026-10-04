#!/usr/bin/env bash
# Do the __proto__ regression tests actually catch the bug they describe?
#
# A regression test that passes on the broken code is decoration. This reverts
# each half of the fix in src/stringify.js, runs ONLY the new test file, and
# requires it to fail. Then it restores the fix and requires the file to pass.
#
# There are two independent bugs here, so both are reverted separately:
#   1. writing a header named __proto__  -> setKey() was a plain assignment
#   2. reading a name a record does not carry -> ownValue() was `obj[key]`
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/stringify.js
TEST=test/proto-keys.test.js
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
    print("PATTERN NOT FOUND:", repr(old[:70]))
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
      echo "  ok    $name  (catches the revert: $(printf '%s' "$out" | grep -c '^✖') failing test(s))"
    else
      echo "  FAIL  $name  <-- the tests pass on broken code"
      fail=$((fail+1))
    fi
  else
    if [ $rc -eq 0 ]; then
      echo "  ok    $name  (green on the fixed code)"
    else
      echo "  FAIL  $name  <-- the tests fail on FIXED code"
      printf '%s\n' "$out" | grep '^✖' | head -5
      fail=$((fail+1))
    fi
  fi
}

echo "verifying $TEST against the fix:"

# Full revert of the writer: every JSON shape assigns straight through.
revert "function setKey(target, key, value) {
  if (key === PROTO) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return target;
  }
  target[key] = value;
  return target;
}" "function setKey(target, key, value) {
  target[key] = value;
  return target;
}" || exit 1
expect "full revert of setKey (plain assignment)" fail

# Full revert of the reader: the missing __proto__ cell comes back invented.
revert "  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;" \
       "  return source[key];" || exit 1
expect "full revert of ownValue (obj[key])" fail

# Partial revert 1: fix the objects shape only. The ndjson and columns shapes
# are separate call sites, so a one-shape fix must still fail -- this is what
# stops a future edit from repairing one shape and leaving the other two.
revert "      setKey(obj, k, i < row.length ? row[i] : null);
    });
    return obj;
  });
  return indent ? JSON.stringify(arr, null, indent) : JSON.stringify(arr);" \
       "      obj[k] = i < row.length ? row[i] : null;
    });
    return obj;
  });
  return indent ? JSON.stringify(arr, null, indent) : JSON.stringify(arr);" || exit 1
expect "only the objects shape repaired" fail

# Partial revert 2: revert ONLY the reader, leaving setKey in place. Must fail:
# the missing-cell bug is independent of the write bug, and the reader fix is not
# a consequence of the writer fix.
#
# One revert() call per scenario, deliberately. revert() restores from $BAK
# before patching, so chaining two calls in a scenario silently discards the
# first one -- the harness would then report "the tests pass on broken code"
# while actually running the fixed code. The same trap is guarded in
# scripts/verify-regression.sh; a leftover no-op patch is exactly the shape that
# causes it, so there is none here.
revert "  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;" \
       "  return source[key];" || exit 1
expect "write half still fixed, read half reverted" fail

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