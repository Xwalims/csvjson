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
printf 'name,qty,note\nwidget,3,"has, comma"\ngadget,5,"line1\nline2"\n' > "$D/report.csv"
printf 'a;b;c\n1;2;3\n' > "$D/s.csv"
printf 'name,qty\nw,1\ng,2\n' > "$D/t.csv"
printf 'a,b,c\n1,2\n1,2,3,4\n' > "$D/g.csv"
printf 'a,b\nc,"unterminated\nd,e\n' > "$D/bad.csv"

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

eq "transpose" "$($BIN to-json "$D/t.csv" --transpose)" '[
  {
    "name": "qty",
    "w": 1,
    "g": 2
  }
]'

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

if [ "$fail" -eq 0 ]; then echo "ALL README EXAMPLES VERIFIED"; else echo "README MISMATCH"; exit 1; fi