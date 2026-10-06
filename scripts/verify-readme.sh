#!/usr/bin/env bash
# Verify every command shown in README.md produces exactly the documented output.
set -uo pipefail
cd "$(dirname "$0")/.."
BIN="node bin/csvjson.js"
fail=0
ok(){ printf '  ok  %s\n' "$1"; }
bad(){ printf '  FAIL %s\n     got: %s\n' "$1" "$2"; fail=1; }
eq(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$(printf '%s' "$2" | head -20)"; fi; }

D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
# Guard for the guard: eq() must be able to fail, or "ALL README EXAMPLES
# VERIFIED" would print no matter what the tool did. Deliberately mismatch and
# require eq() to report it; if eq() ever passes a bad comparison, bail out.
eq "__selfcheck (expected to FAIL)" "$(printf 'x')" "y"
if [ "$fail" -eq 0 ]; then
  echo "eq() cannot fail — every check below would be vacuous" >&2
  exit 1
fi
fail=0
printf 'name,qty,note\nwidget,3,"has, comma"\ngadget,5,"line1\nline2"\n' > "$D/report.csv"
printf 'a;b;c\n1;2;3\n' > "$D/s.csv"
printf 'name,qty\nw,1\ng,2\n' > "$D/t.csv"
printf 'a,b,c\n1,2\n1,2,3,4\n' > "$D/g.csv"
printf 'a,b\nc,"unterminated\nd,e\n' > "$D/stray.csv"
# A quote stranded under BOTH candidates: one '"' and one "'", neither closed,
# so no legal reading exists. A single stray '"' is NOT malformed -- python's
# csv.reader reads the bytes above as three rows under quotechar "'" -- and the
# example above the exit-3 one is checked separately for exactly that reason.
printf 'a,b\nc,"unterminated\nd,\x27dangling\n' > "$D/bad.csv"

out=$($BIN to-json "$D/report.csv"); want='[
  {
    "name": "widget",
    "qty": 3,
    "note": "has, comma"
  },
  {
    "name": "gadget",
    "qty": 5,
    "note": "line1\nline2"
  }
]'
eq "to-json report.csv" "$out" "$want"

$BIN to-json "$D/report.csv" -o "$D/report.json" && $BIN to-csv "$D/report.json" -o "$D/back.csv"
eq "round trip is byte-identical" "$(diff "$D/report.csv" "$D/back.csv" >/dev/null && echo IDENTICAL)" "IDENTICAL"

eq "ndjson" "$(cat "$D/report.csv" | $BIN to-json - --ndjson)" '{"name":"widget","qty":3,"note":"has, comma"}
{"name":"gadget","qty":5,"note":"line1\nline2"}'

eq "semicolon detection --stats" "$($BIN to-json "$D/s.csv" --stats 2>&1 >/dev/null)" 'rows: 1
columns: 3
delimiter: ";"
quote: "\""
types: number,number,number
header: a,b,c'

eq "column-atomic types" "$(printf 'id,score\n1,10\n2,high\n3,30\n' | $BIN to-json - --compact)" '[{"id":1,"score":"10"},{"id":2,"score":"high"},{"id":3,"score":"30"}]'

eq "ragged dump" "$($BIN to-json "$D/g.csv" --ragged dump)" '[
  {
    "a": 1,
    "b": 2,
    "c": ""
  },
  {
    "a": 1,
    "b": 2,
    "c": [
      "3",
      "4"
    ]
  }
]'

$BIN to-json "$D/g.csv" --ragged error >/dev/null 2>"$D/err.txt"; ec=$?
eq "ragged error exit code" "$ec" "3"
eq "ragged error message" "$(cat "$D/err.txt")" 'csvjson: ragged row 2 (line 2) has 2 fields, expected 3'

$BIN to-json "$D/bad.csv" >/dev/null 2>"$D/err2.txt"; ec=$?
eq "unterminated quote exit code" "$ec" "3"
eq "unterminated quote message" "$(cat "$D/err2.txt")" 'csvjson: unterminated quoted field starting at line 2, column 3'

# The same bytes minus the "'" opener. Detection picks the quote character that
# reads the whole file and every row survives, so the tool reports data rather
# than a failure it invented.
eq "stray quote is data" "$($BIN to-json "$D/stray.csv" --compact)" '[{"a":"c","b":"\"unterminated"},{"a":"d","b":"e"}]'

# The dialect-detection section: one decision, not two. On the stray fixture the
# old code called detectQuote() -> "'" and detectDelimiter() -> "," (scored under
# '"') and then tokenized under the stranded quote, throwing. These lines check
# what that README paragraph claims the tool now does. The expected strings are
# built with the apostrophe spliced in by hand: nothing here should depend on a
# three-level quote nest to express one apostrophe.
APOS="'"
COL0_APOS="col0${APOS}"
printf 'col0%s\n"a,b"\n%sstart\n' "$APOS" "$APOS" > "$D/one.csv"
eq "single column keeps the quote that reads it" \
  "$($BIN to-json "$D/one.csv" --no-header --compact)" \
  "[{\"0\":\"${COL0_APOS}\"},{\"0\":\"a,b\"},{\"0\":\"${APOS}start\"}]"
eq "single column is one column" \
  "$($BIN to-json "$D/one.csv" --stats 2>&1 >/dev/null | sed -n '2p')" "columns: 1"
eq "stray keeps all three rows" \
  "$($BIN to-json "$D/stray.csv" --compact)" \
  "[{\"a\":\"c\",\"b\":\"\\\"unterminated\"},{\"a\":\"d\",\"b\":\"e\"}]"
# --quote pins: a file stranded under the pinned character still errors rather
# than being silently read as something the caller did not ask for. $D/pin.csv
# is the parse-level fixture, an apostrophe opening a field at a field start.
printf 'col0%s,col1\n%s%s\nNULL,%s\n' "$APOS" "$APOS" "$APOS" "$APOS" > "$D/pin.csv"
$BIN to-json "$D/pin.csv" --quote "$APOS" >/dev/null 2>&1; ec=$?
eq "pinned quote is never swapped" "$ec" "3"
# And the same file WITHOUT the pin reads cleanly, which is the whole point: the
# pinned quote is honoured even when it is the one that strands an opener.
$BIN to-json "$D/pin.csv" --compact >/dev/null 2>&1; ec=$?
eq "unpinned quote reads the same file" "$ec" "0"

eq "transpose" "$($BIN to-json "$D/t.csv" --transpose)" '[
  {
    "name": "qty",
    "w": 1,
    "g": 2
  }
]'

# The README claims transposing twice returns the original table, and shows the
# --columns route. Both were broken together until the CLI delegate to
# transposeTable(); keep them verified here.
$BIN to-json "$D/t.csv" --columns --compact -o "$D/tc.json"
eq "transpose via --columns" "$($BIN to-csv "$D/tc.json" --transpose)" 'name,w,g
qty,1,2'
$BIN to-csv "$D/tc.json" --transpose -o "$D/once.csv"
$BIN to-json "$D/once.csv" --columns --compact -o "$D/once.json"
eq "transpose is an involution" "$($BIN to-csv "$D/once.json" --transpose)" 'name,qty
w,1
g,2'

# Numeric headers: JS hoists array-index-like keys, so the column order changes.
printf 'b,1,a\nx,2,y\n' > "$D/k.csv"
eq "numeric header key order" "$($BIN to-json "$D/k.csv" --compact)" '[{"1":2,"b":"x","a":"y"}]'
printf '%s' '[{"1":2,"b":"x","a":"y"}]' > "$D/k.json"
eq "numeric header round trip reorders" "$($BIN to-csv "$D/k.json")" '1,b,a
2,x,y'
# --no-header invents 0,1,2 and the same numeric key order puts them back.
eq "no-header is unaffected" "$($BIN to-json "$D/k.csv" --no-header --compact)" '[{"0":"b","1":1,"2":"a"},{"0":"x","1":2,"2":"y"}]'

got=$(node -e "
const csvjson=require('./src/index.js');
const t=csvjson.parseCsv('a,b\n1,2\n');
console.log(csvjson.toJson(t));
console.log('---');
console.log(JSON.stringify(csvjson.fromJson([{a:1,b:2}])));
")
want='[
  {
    "a": 1,
    "b": 2
  }
]
---
"a,b\n1,2\n"'
eq "library API" "$got" "$want"

# A column named __proto__. The README claims all three shapes keep it and that
# the csv -> json -> csv cycle is byte-identical, so all of that is checked here
# rather than trusted.
printf '__proto__,a\n1,2\n3,4\n' > "$D/p.csv"
eq "to-json __proto__ column" "$($BIN to-json "$D/p.csv" --compact)" '[{"__proto__":1,"a":2},{"__proto__":3,"a":4}]'
eq "to-json __proto__ ndjson" "$($BIN to-json "$D/p.csv" --ndjson)" '{"__proto__":1,"a":2}
{"__proto__":3,"a":4}'
eq "to-json __proto__ columns" "$($BIN to-json "$D/p.csv" --columns --compact)" '{"columns":{"__proto__":[1,3],"a":[2,4]},"rows":2}'

$BIN to-json "$D/p.csv" --compact -o "$D/p.json"
eq "__proto__ round trip is byte-identical" "$(diff "$D/p.csv" <($BIN to-csv "$D/p.json") >/dev/null && echo IDENTICAL)" "IDENTICAL"
$BIN to-json "$D/p.csv" --columns --compact -o "$D/pc.json"
eq "__proto__ columns round trip" "$($BIN to-csv "$D/pc.json")" '__proto__,a
1,2
3,4'

# The README shows this document coming back with an EMPTY cell, not
# [object Object]: to-csv unions the key names across records, and the second
# record has no __proto__ of its own.
printf '%s' '[{"__proto__":{"p":1},"a":1},{"a":2}]' > "$D/m.json"
eq "to-csv absent __proto__ cell is empty" "$($BIN to-csv "$D/m.json")" '__proto__,a
[object Object],1
,2'

if [ "$fail" -eq 0 ]; then echo "ALL README EXAMPLES VERIFIED"; else echo "README MISMATCH"; exit 1; fi