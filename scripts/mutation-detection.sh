#!/usr/bin/env bash
# Mutation harness for the DIALECT DETECTOR in src/parse.js.
#
# Separate from scripts/mutation-test.sh, which mutates src/tokenize.js. The two
# files have different failure modes: the tokenizer's bugs show up as wrong rows,
# while the detector's bugs show up as a wrong --delimiter, which silently turns a
# well-formed file into a single column. Nothing in test/ used to notice, because
# every detection test fed it input where the answer was obvious.
#
# The mutation is applied to the real file on disk and restored from a backup, and
# the substitution is verified to have changed the file before the suite runs --
# the same discipline as mutation-test.sh, for the same reason: a substitution that
# matches nothing makes a broken harness look clean.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/parse.js
BAK=$(mktemp)
cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT

pass=0; fail=0

check_mutant() {
  local name="$1" old="$2" new="$3" expect="$4"
  cp "$BAK" "$SRC"
  if ! python3 - "$SRC" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as fh:
    text = fh.read()
if old not in text:
    sys.stderr.write(f'pattern not found: {old[:70]!r}\n')
    sys.exit(3)
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(text.replace(old, new, 1))
PY
  then
    echo "  BROKEN MUTANT  $name (substitution failed -- source unchanged)"
    fail=$((fail+1)); return
  fi
  if cmp -s "$SRC" "$BAK"; then
    echo "  BROKEN MUTANT  $name (file identical after substitution)"
    fail=$((fail+1)); return
  fi
  suite_rc=0
  rc=0
  det_rc=0
  if ! out=$(node --test 2>&1); then suite_rc=1; fi
  if ! out2=$(timeout 300 python3 scripts/crosscheck.py 120 2>&1); then rc=1; fi
  if ! out3=$(timeout 300 python3 scripts/detect-check.py 1200 2>&1); then det_rc=1; fi
  combined=0
  [ $suite_rc -ne 0 ] && combined=1
  [ $rc -ne 0 ] && combined=1
  [ $det_rc -ne 0 ] && combined=1
  if [ "$expect" = caught ]; then
    if [ $combined -ne 0 ]; then
      via=""
      [ $suite_rc -ne 0 ] && via="node --test"
      [ $rc -ne 0 ] && via="${via:+$via, }crosscheck"
      [ $det_rc -ne 0 ] && via="${via:+$via, }detect-check"
      echo "  killed    $name  (by $via)"
      pass=$((pass+1))
    else
      echo "  SURVIVED  $name  <-- nothing noticed"
      printf '%s\n' "$out" "$out2" "$out3" | sed 's/^/            /' | head -6
      fail=$((fail+1))
    fi
  else
    if [ $suite_rc -eq 0 ] && [ $rc -eq 0 ] && [ $det_rc -eq 0 ]; then
      echo "  survived (by design)  $name"
      pass=$((pass+1))
    else
      echo "  OVERKILLED  $name"
      printf '%s\n' "$out" "$out2" "$out3" | grep -E '^(✖|crosscheck|detect-check)' | head -6 | sed 's/^/            /'
      fail=$((fail+1))
    fi
  fi
}

echo "mutating src/parse.js (dialect detection) and requiring the harness to notice:"

# 1. THE BUG THIS FILE WAS WRITTEN FOR. sniff() used to infer the quote character
#    as it walked, so one unclosed opener latched "inside quotes" for the rest of
#    the sample and every delimiter after it became invisible. Detection answered
#    the ',' fallback for tab- and semicolon-separated files whose first field
#    merely BEGINS with the other quote character. Ground truth is python's
#    csv.reader, which finds three tab delimiters on exactly these bytes.
#
#    Reproduced here by restoring the old "opens unconditionally" rule. The
#    killing inputs were confirmed with both modules loaded side by side: six of
#    the regression assertions in test/parse.test.js fail against this mutant and
#    pass against the shipped code.
check_mutant "sniff guesses the quote character as it walks" \
  "    // Not inside quotes: only a quote at a field start opens a quoted region.
    if (ch === quote) {
      const prev = i > 0 ? sample[i - 1] : null;
      if (prev === null || DELIMITER_CANDIDATES.indexOf(prev) !== -1 || prev === '\\n' || prev === '\\r') {
        inQuotes = true;
      }
      continue;
    }" \
  "    // Not inside quotes: only a quote at a field start opens a quoted region.
    if (ch === '\"' || ch === \"'\") {
      const prev = i > 0 ? sample[i - 1] : null;
      if (prev === null || DELIMITER_CANDIDATES.indexOf(prev) !== -1 || prev === '\\n' || prev === '\\r') {
        inQuotes = true;
        quote = ch;
      }
      continue;
    }" caught

# 2. The guard removed: a reading that ends inside a quoted region is not CSV, so
#    its tally -- every delimiter after the stranded opener invisible -- must not
#    compete. Scoring it anyway makes detection commit to a broken parse and split
#    a tab-separated file into single characters.
#
#    SURVIVES BY DESIGN, and that is a measured claim rather than a hope. Two
#    numbers justify it. The guard changes the answer on 7.8% of random samples
#    (31016 of 400000), so it is not dead code. But over every case
#    detect-check.py actually scores -- that is, every sample whose dialect the
#    bytes genuinely determine -- the number of disagreements is ZERO. Every input
#    it moves is one whose meaning the bytes do not determine: on
#    '\t\rb;\t|\r,,," \n' python's csv.reader accepts four dialects and returns
#    four different tables, because csv.reader in non-strict mode never raises
#    while csvjson refuses a dialect whose quoted field never closes. There is no
#    ground truth to assert, so there is nothing for any gate to check.
#
#    Consequence worth stating plainly: the guard is a POLICY decision on
#    undetermined input, not a correctness fix, and it is only reachable from
#    malformed or ambiguous files. If it were dropped, no test here would object
#    and the suite would stay green -- which is the honest cost of keeping it.
check_mutant "stranded quoted region scored anyway" \
  "if (unterminated) continue; // not a CSV file under this quote character" \
  "if (unterminated) { /* mutant */ }" "survived"

# 3. Detection must commit to the quote character the parser will really use.
#    Scoring every reading and keeping the best score lets a reading in which
#    quoting is switched off count delimiters that live inside quoted fields,
#    which is the exact protection quoting provides.
check_mutant "both readings scored, best wins" \
  "    // The first quote character that yields a whole-file reading wins outright.
    // Its reading is the one the parser will actually use, so letting a rival
    // outscore it would optimise against the wrong parse.
    if (best) break;" "" caught

echo
if [ "$fail" -eq 0 ]; then
  echo "DETECTION MUTATION HARNESS OK: $pass/$pass as expected"
else
  echo "DETECTION MUTATION HARNESS BROKEN: $fail problem(s)"
  exit 1
fi