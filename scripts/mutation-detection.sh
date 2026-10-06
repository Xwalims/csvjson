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
#    USED TO SURVIVE BY DESIGN, and the file used to claim that as a measured
#    fact: over every case detect-check.py scores -- every sample whose dialect
#    the bytes genuinely determine -- the guard changed nothing, so no gate could
#    see it go. That was true, and it was also a hole. Once detection became ONE
#    decision, dropping the guard no longer only picks a different dialect on
#    undetermined input: it puts the stranded quote character back into the parse,
#    and E_UNTERMINATED_QUOTE returns on files that are not malformed. Three tests
#    now notice -- the joint-decision test, "a single-column file keeps the quote
#    that reads it", and the CLI test that a stray quote is data.
#
#    The 7.8% figure below is kept because it still says the guard is live code
#    rather than an unexercised branch, but it is no longer an argument that the
#    guard is untested.
check_mutant "stranded quoted region scored anyway" \
  "if (unterminated) continue; // not a CSV file under this quote character" \
  "if (unterminated) { /* mutant */ }" "caught"

# 3. Detection must commit to the quote character the parser will really use.
#    Scoring every reading and keeping the best score lets a reading in which
#    quoting is switched off count delimiters that live inside quoted fields,
#    which is the exact protection quoting provides.
#    The anchor is the whole return-and-fall-through block: dropping the early
#    return lets the loop carry on and try the rival quote character, which is
#    the mutant. It used to end at `if (best) break;`, before the joint decision
#    became two returns -- keep the pattern in step with detectDialect().
check_mutant "both readings scored, best wins" \
  "    if (best) return { delimiter: best.delimiter, quote };
    return { delimiter: ',', quote };" "" caught

# 3b. The bug this tick fixed, in mutation form. Returning both halves of the
#     reading is what keeps the parser from tokenizing under a quote character
#     the delimiter was never scored against; making parseCsv take the quote from
#     detectQuote() again while the delimiter comes from the joint decision
#     reproduces the old split exactly, and E_UNTERMINATED_QUOTE comes back on
#     files that are not malformed.
check_mutant "parse takes the quote from detectQuote again" \
  "    const dialect = detectDialect(sample, { quote: opts.quote || undefined });
    quote = dialect.quote;
    delimiter = opts.delimiter || dialect.delimiter;" \
  "    const dialect = detectDialect(sample, { quote: opts.quote || undefined });
    quote = opts.quote || detectQuote(sample);
    delimiter = opts.delimiter || dialect.delimiter;" caught

# 3c. The counterpart rule: a reading with no delimiter candidate is a
#     single-column file, not a rejected reading. Swapping the quote character
#     because the winner found no delimiter splits a one-column file on a comma
#     that was never quoting anything.
check_mutant "no delimiter means try the other quote" \
  "    if (best) return { delimiter: best.delimiter, quote };
    return { delimiter: ',', quote };" \
  "    if (best) return { delimiter: best.delimiter, quote };" caught

# 4. The key ORDER, not the set of keys. Swapping the first two keys back
#    (presence before agreement) is a silent change: every structural key is
#    still computed and every tie-break still applies, so nothing about the
#    function's shape gives the swap away. On files the bytes fully determine
#    the two orders answer identically -- measured over 14072 determined files,
#    0 disagreements -- so neither crosscheck.py nor detect-check.py can see
#    it either. The direct assertions on better() in test/parse.test.js are
#    what kill it, which is the whole reason that export exists.
#
#    Ground truth for the direction of the fix, from python's csv.writer over
#    300000 files counting only the 2762 that discriminate:
#    agreement-first right on 1638, presence-first on 568.
check_mutant "presence ranked before agreement" \
  "  if (a.regular !== b.regular) return a.regular > b.regular;
  if (a.present !== b.present) return a.present > b.present;" \
  "  if (a.present !== b.present) return a.present > b.present;
  if (a.regular !== b.regular) return a.regular > b.regular;" caught

# 5. Width ahead of both structural keys: rewards a rival for occurring many
#    times inside ONE field, which is the coincidence the leading keys exist to
#    discount. Same silent shape as #4 and same reason the test can only kill it
#    through better() directly.
check_mutant "width ranked before presence and agreement" \
  "  if (a.regular !== b.regular) return a.regular > b.regular;
  if (a.present !== b.present) return a.present > b.present;
  if (a.wide !== b.wide) return a.wide > b.wide;" \
  "  if (a.wide !== b.wide) return a.wide > b.wide;
  if (a.regular !== b.regular) return a.regular > b.regular;
  if (a.present !== b.present) return a.present > b.present;" caught

echo
if [ "$fail" -eq 0 ]; then
  echo "DETECTION MUTATION HARNESS OK: $pass/$pass as expected"
else
  echo "DETECTION MUTATION HARNESS BROKEN: $fail problem(s)"
  exit 1
fi