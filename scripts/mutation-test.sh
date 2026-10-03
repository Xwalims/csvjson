#!/usr/bin/env bash
# Mutation harness: does the cross-check actually catch a broken tokenizer?
#
# Every mutation below is verified to have CHANGED the file on disk before the
# harness runs. An earlier version of this script trusted perl's exit status and
# reported "mutant survived" for four mutants whose substitution had never
# matched anything -- so a harness that could not fail looked like a clean run.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/tokenize.js
BAK=$(mktemp)
cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT

pass=0; fail=0

check_mutant() {
  local name="$1" old="$2" new="$3" expect="$4"
  cp "$BAK" "$SRC"
  # Apply the substitution with python, then REQUIRE that it changed the file.
  #
  # Two bugs lived here and both reported "the mutant survived" when the file had
  # in fact never been modified:
  #   - `python3 - "$SRC" "$old" "$new" <<'PY'` lost the argv entries, so
  #     sys.argv[2] raised and nothing was substituted;
  #   - the `[ $? -eq 3 ]` guard read the status of the *heredoc*, not of python,
  #     so a failed substitution never took the BROKEN MUTANT branch.
  # Both are now impossible: python exits 3 on a missing pattern, and the file
  # is compared against the pristine backup afterwards.
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
  # Both must fail. `node --test` covers what python's csv module cannot
  # express -- a multi-character delimiter is rejected outright by csv.reader --
  # and the cross-check covers the oracle-backed behaviour. Running only the
  # cross-check reported "SURVIVED" for three mutants that the Node suite kills
  # immediately, and running only the suite would report survivors for the
  # blank-line and BOM mutants that only the oracle can judge.
  # `out=$(...)` followed by `rc=$?` reads the ASSIGNMENT's status, which is
  # always 0 -- so the first version of this block reported every mutant as
  # SURVIVED, including ones the suite kills instantly. `if ! out=$(...)` puts
  # the command's own status on the condition, which is correct.
  suite_rc=0
  rc=0
  if ! out=$(node --test 2>&1); then suite_rc=1; fi
  if ! out2=$(timeout 300 python3 scripts/crosscheck.py 120 2>&1); then rc=1; fi
  # `combined` is 1 when EITHER gate reported a failure, i.e. the mutant was
# caught. This was written the wrong way round at first:
#   `[ $suite_rc -ne 0 ] || combined=1`
# sets combined when the gate PASSED (status 0), so a caught mutant -- both
# gates failing -- left combined=0 and was printed as SURVIVED. Every verdict in
# the run was inverted, which is exactly the kind of error this script exists to
# catch in the library. `&&` states the intent directly.
combined=0
  [ $suite_rc -ne 0 ] && combined=1
  [ $rc -ne 0 ] && combined=1
  if [ "$expect" = caught ]; then
    if [ $combined -ne 0 ]; then
      via=""
      [ $suite_rc -ne 0 ] && via="node --test"
      [ $rc -ne 0 ] && via="${via:+$via, }crosscheck"
      echo "  killed    $name  (by $via)"
      pass=$((pass+1))
    else
      echo "  SURVIVED  $name  <-- neither node --test nor the cross-check noticed"
      printf '%s\n' "$out" "$out2" | sed 's/^/            /' | head -6
      fail=$((fail+1))
    fi
  else
    if [ $suite_rc -eq 0 ] && [ $rc -eq 0 ]; then
      echo "  survived (by design)  $name"
      pass=$((pass+1))
    else
      echo "  OVERKILLED  $name  <-- a documented extension was reported as a bug"
      printf '%s\n' "$out" "$out2" | grep -E '^(✖|crosscheck)' | head -6 | sed 's/^/            /'
      fail=$((fail+1))
    fi
  fi
}

echo "mutating src/tokenize.js and requiring the harness to notice:"

# 1. CRLF: forget to swallow the LF half of a record break.
check_mutant "CRLF counted as two record breaks" \
  "this.skipLF = sawCR;" "this.skipLF = false;" caught

# 2. Embedded newline in a quoted field normalised to \n -- breaks round-tripping.
check_mutant "quoted CR normalised to LF" \
  "this.field.push(ch); // preserved verbatim, never normalised
          this.insideCR = true;" \
  "this.field.push('\n'); // normalised
          this.insideCR = true;" caught

# 3. A doubled quote inside a quoted field no longer unescapes.
check_mutant '"" escape dropped' \
  "// \`\"\"\` inside a quoted field is one literal quote character.
          this.field.push(ch);" \
  "// no unescape
          this.field.push('');" caught

# 4. The opening quote of a field is treated as data.
check_mutant "opening quote not recognised" \
  "if (ch === this.quote) {
          // An opening quote means the record holds a FIELD even when that field
          // is empty" \
  "if (false) {
          // An opening quote means the record holds a FIELD even when that field
          // is empty" caught

# 5. The blank-line flag dropped. The interop checks CAN see this, but only if a
#    blank line is generated -- and python's csv.writer quotes a lone empty cell,
#    so a blank record never appears in python-written input. build_write feeds
#    it through the writer instead. Without that generation this mutant survives,
#    which is exactly what an earlier version of this script reported as a silent
#    gap.
check_mutant "blank-line flag dropped" \
  "const blank = !this.recordTouched;" "const blank = false;" caught

# 6. Delimiter length ignored, so a multi-byte delimiter half-matches.
#    CAUGHT, not tolerated. This expectation was wrong for a week: the harness
#    kept reporting it "survived (by design)" on the grounds that python's csv
#    refuses a multi-character delimiter so the oracle is blind to it. The
#    cross-check is not the only gate -- node --test is too, and it kills this
#    mutant in four tests. Running the harness again confirmed it: the mutation
#    makes node --test exit 1 with "a trailing partial delimiter is data, not
#    dropped", "a round trip through a multi-character delimiter is chunk-stable"
#    and both "quoted delimiter prefixes survive ..." cases failing.
#    Being unable to judge something through an oracle is not a reason to expect
#    no failure; it is a reason to check whether some OTHER gate can judge it.
check_mutant "delimiter matched by char code only" \
  "return str.startsWith(d, i);" "return str.charCodeAt(i) === d.charCodeAt(0);" caught

# 6b. The two survivors above are unkillable THROUGH python's csv module, which
# rejects a multi-character delimiter outright ("delimiter must be a unicode
# character"). That limit is why the multi-character cases are generated here as
# a pure invariant check instead. Reverting the withholding entirely is the real
# regression, and this must catch it.
check_mutant "withholding reverted (multi-char delimiter lost)" \
  "if (this._partialDelimiter(str, i) && !this.draining) {" "if (false) {" caught

# 6c. Withholding kept, but flush() never drains the tail, so the end of a file
#     is silently dropped.
check_mutant "pending never drained at flush" \
  "if (this.pending !== '') {
      const held = this.pending;
      this.pending = '';
      this.draining = true;
      try {
        this.push(held);
      } finally {
        this.draining = false;
      }
    }" "if (false) {}" caught

# 6d. Withholding kept, but the drain may not set `draining`, so it re-withholds
#     the very characters it is releasing and the tail is never seen.
check_mutant "drain re-withholds the tail" \
  "this.draining = true;
      try {
        this.push(held);
      } finally {
        this.draining = false;
      }" "this.push(held)" caught

# 6e. The precedence fix: in AFTER_QUOTE, a record break must outrank the
#     delimiter. Reordering them again makes a quoted field followed by a
#     record separator parse differently depending on chunking.
check_mutant "AFTER_QUOTE tests the delimiter before the record break" \
  "if (ch === '\\r' || ch === '\\n') {
          i += this._endRecord(ch === '\\r');
          continue;
        }
        if (this._isDelimiter(str, i)) {
          i += this.delimiter.length;
          this._endField();
          this.state = S.FIELD_START;
          this.column += 1;
          continue;
        }
        // Lenient: stray characters after a closing quote are literal data." \
  "if (this._isDelimiter(str, i)) {
          i += this.delimiter.length;
          this._endField();
          this.state = S.FIELD_START;
          this.column += 1;
          continue;
        }
        if (ch === '\\r' || ch === '\\n') {
          i += this._endRecord(ch === '\\r');
          continue;
        }
        // Lenient: stray characters after a closing quote are literal data." caught

# 6f. Withholding a trailing CR even though it ends a record. `\r\n` is not a
#     sensible delimiter, but the chunking must still not change the answer --
#     and, more to the point, the record must not become UNAVAILABLE.
#     This was mislabelled SURVIVED for a week, which was wrong in a much more
#     interesting way than "the harness is broken".
#
#     Deleting the CR/LF guard does not change the final parsed output AT ALL.
#     scripts/exhaustive-cr-guard.js proved that: every string of length <= 5
#     over {CR, LF, 'a', BOM} x 7 delimiters x every chunking, 54131
#     comparisons, zero differences. Because every existing test compares rows
#     after flush() -- where the withheld tail is drained anyway -- the mutant
#     looked perfectly equivalent and the harness reported it survived.
#
#     The oracle was wrong, not the mutant. A streaming tokenizer is consumed
#     per push (`for await (const chunk of stream) rows.push(...tz.push(chunk))`),
#     so *when* a record becomes visible is observable even though the final
#     row list is not. With the guard gone, push('a\r') yields 0 rows and the
#     record only appears on the next read: a fully-read record stays invisible
#     to the caller. test/midstream-emission.test.js pins that, and kills it.
check_mutant "CR withheld as a possible delimiter prefix" \
  "if (str.charCodeAt(i) === 0x0d /* \\r */ || str.charCodeAt(i) === 0x0a /* \\n */) {
      return false;
    }" "" caught

# 7. The BOM IS caught, by `node --test` -- it has explicit BOM tests at three
#    levels. The cross-check alone does not notice, because the interop checks
#    never emit a BOM and the docstring says so. This mutant is therefore a
#    demonstration of why both gates run: it would have been mislabelled
#    "survived by design" if only the oracle were consulted.
check_mutant "BOM no longer stripped" \
  "if (atStart && this.stripBom && ch === BOM) {" \
  "if (atStart && this.stripBom && false && ch === BOM) {" caught

echo
if [ "$fail" -eq 0 ]; then
  echo "MUTATION HARNESS OK: $pass/$pass as expected"
else
  echo "MUTATION HARNESS BROKEN: $fail problem(s)"
  exit 1
fi