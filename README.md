# csvjson

RFC 4180 CSV ⇄ JSON with dialect detection and strict round-tripping. Zero
dependencies, Node ≥ 20, CommonJS.

The point of this library is the round trip. A CSV file goes in, a JSON file
comes out, and converting back gives you **the same bytes you started with** —
embedded newlines, embedded delimiters, `""` escapes and all.

> **Two known exceptions**, both because JSON cannot express what the CSV file
> held:
>
> 1. A header cell that is a plain non-negative integer — `1`, `42`, `0` — does
>    not survive the round trip. JSON objects have no guaranteed key order and
>    JavaScript hoists array-index-like keys to the front, so `b,1,a` comes back
>    as `1,b,a`. The values are right; the column order is not. If your headers
>    might be numeric, read with `--columns`, or name the columns. See
>    [Numeric headers](#numeric-headers-break-the-round-trip).
> 2. A blank line does not survive the JSON hop: it returns as a row of nulls.
>    The table API keeps it exactly. See
>    [Ragged rows](#ragged-rows).

This package is **not published to npm** — there is an unrelated project of that
name already published there. Install it from a checkout:

```console
$ git clone https://github.com/Xwalims/csvjson.git
$ cd csvjson
$ node bin/csvjson.js --help
```

Or link it onto your `PATH`:

```console
$ npm link          # provides the `csvjson` command
```

<!-- hero -->

[![CI](https://github.com/Xwalims/csvjson/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwalims/csvjson/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [Quick start](#quick-start)
- [Output shapes](#output-shapes)
- [Numeric headers break the round trip](#numeric-headers-break-the-round-trip)
- [A column named `__proto__` is kept](#a-column-named-__proto__-is-kept)
- [Dialect detection](#dialect-detection)
- [Library API](#library-api)
- [License](#license)

<!-- /hero -->

## Quick start

```console
$ cat report.csv
name,qty,note
widget,3,"has, comma"
gadget,5,"line1
line2"

$ csvjson to-json report.csv
[
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
]
```

Note the third field of the last row: the CSV held a real newline inside a
quoted field, and the JSON holds that same newline. Nothing was normalised.

Converting back reproduces the original file byte for byte:

```console
$ csvjson to-json report.csv -o report.json && csvjson to-csv report.json -o back.csv
$ diff report.csv back.csv && echo IDENTICAL
IDENTICAL
```

Both commands read stdin and write stdout when the path is `-`, so they compose
in a pipeline:

```console
$ cat report.csv | csvjson to-json - --ndjson
{"name":"widget","qty":3,"note":"has, comma"}
{"name":"gadget","qty":5,"note":"line1\nline2"}
```

## Output shapes

`--json <shape>` (or the `--ndjson` / `--columns` shorthands) picks the JSON
layout. The default, `objects`, needs a header row.

```console
$ csvjson to-json report.csv --ndjson
{"name":"widget","qty":3,"note":"has, comma"}
{"name":"gadget","qty":5,"note":"line1\nline2"}

$ csvjson to-json report.csv --columns
{
  "columns": {
    "name": [
      "widget",
      "gadget"
    ],
    "qty": [
      3,
      5
    ],
    "note": [
      "has, comma",
      "line1\nline2"
    ]
  },
  "rows": 2
}
```

`columns` is the shape to reach for on wide data: it keeps each column as one
array instead of repeating the key on every row.

`--transpose` exchanges rows and columns. It is an involution — applying it
twice returns the original table:

```console
$ printf 'name,qty\nw,1\ng,2\n' > t.csv
$ csvjson to-json t.csv --transpose
[
  {
    "name": "qty",
    "w": 1,
    "g": 2
  }
]
```

Transposing twice really does return the original table, and the two ways to
get there agree:

```console
$ csvjson to-json t.csv --columns --compact | csvjson to-csv - --transpose
name,w,g
qty,1,2
```

## Numeric headers break the round trip

A header cell that is a plain non-negative integer does not come back in place.
JSON objects carry no guaranteed key order, and JavaScript moves keys that look
like array indices to the front of the object, so the column order changes:

```console
$ printf 'b,1,a\nx,2,y\n' > k.csv
$ csvjson to-json k.csv --compact
[{"1":2,"b":"x","a":"y"}]

$ csvjson to-csv - <<< '[{"1":2,"b":"x","a":"y"}]'
1,b,a
2,x,y
```

`b,1,a` became `1,b,a`. Every value survived; only the order did not. This is
inherent to representing a table as a JSON object of strings, and it applies
equally to `--ndjson` and `--columns`, because all three build the object the
same way.

`--no-header` is not affected, though not by design: it invents the keys `0`,
`1`, `2`, and the same hoisting rule sorts integer-like keys numerically, so
they land back in the original order.

Workaround: keep the original header row alongside the data, or name your
columns, so nothing depends on a numeric header surviving.

## A column named `__proto__` is kept

A header cell can legally be the text `__proto__`, and that column survives all
three shapes byte for byte:

```console
$ printf '__proto__,a\n1,2\n3,4\n' > p.csv
$ csvjson to-json p.csv --compact
[{"__proto__":1,"a":2},{"__proto__":3,"a":4}]

$ csvjson to-json p.csv --columns --compact
{"columns":{"__proto__":[1,3],"a":[2,4]},"rows":2}

$ csvjson to-json p.csv --compact | csvjson to-csv -
__proto__,a
1,2
3,4
```

This one needs a note, because `__proto__` is a trap for anyone writing the
obvious code. It is not a property of the prototype; it is an **accessor**
defined on `Object.prototype`, so `obj[key] = value` for that name runs a setter
that swaps the object's prototype instead of creating a key:

```console
$ node -e 'const o = {}; o.__proto__ = 1; console.log(Object.keys(o), JSON.stringify(o))'
[] {}
```

The value is not hidden, it is **gone** — `Object.keys` skips it and
`JSON.stringify` omits it. So the straightforward implementation of the JSON
shapes, `obj[header[i]] = row[i]`, silently deleted that column and reported
nothing: a one-column file came back as `{}`. `Object.defineProperty` creates a
real own property instead, which is exactly what `JSON.parse('{"__proto__":1}')`
does for the same bytes, and that is what the package does. See `setKey()` in
`src/stringify.js`.

Reading needed the mirror fix. `to-csv` unions the key names across every record,
so for `[{"__proto__":{"p":1},"a":1},{"a":2}]` the header contains `__proto__`
while the second record simply has no such cell. Reading `obj["__proto__"]` on
that record does not return `undefined` — it returns the inherited
`Object.prototype`, so the missing cell was written as `[object Object]`:

```console
$ csvjson to-csv - <<< '[{"__proto__":{"p":1},"a":1},{"a":2}]'
__proto__,a
[object Object],1
,2
```

Every other absent key renders as an empty field, and so does this one now.
`ownValue()` in `src/stringify.js` reads only own properties.

Names like `constructor`, `toString` and `hasOwnProperty` need no special
handling: those are plain data properties on the prototype, so assigning to them
creates an own property that shadows the inherited one, exactly as `JSON.parse`
does.

## Dialect detection

By default `csvjson` sniffs the delimiter and quote character from the first
64 KiB, counting candidates **only outside quoted regions** — so commas inside
a quoted field never fool it.

```console
$ printf 'a;b;c\n1;2;3\n' > s.csv
$ csvjson to-json s.csv --stats
rows: 1
columns: 3
delimiter: ";"
quote: "\""
types: number,number,number
header: a,b,c
```

Candidates are `,` `;` tab and `|`, with `"` and `'` for quoting. Override them
with `--delimiter` / `--quote`, or bypass detection entirely with `--no-detect`
(which assumes comma + `"`).

Detection runs as a pipeline, but it is **one decision, not two**. The quote
character and the delimiter cannot be picked independently: the delimiter is
counted outside quoted regions, so which quote character you assume decides
which delimiters are visible, and if that assumption strands an opening quote
every delimiter after it disappears. `detectDialect()` therefore returns both
halves of the reading it used, and the parser tokenizes under exactly that pair.

A reading in which the sample ends inside a quoted field is rejected outright —
such a sample is not CSV under that assumption, and scoring it highest is how a
tab-separated file used to be reported as a single column. The other candidate is
then tried, which is a linear cost; a guess made mid-scan would need look-ahead
to undo itself, which is quadratic in the sample size.

That pairing is not a detail. Detection used to call `detectQuote()` and
`detectDelimiter()` separately, and `detectDelimiter()` would sometimes score the
delimiter under the *other* quote character while returning only the separator —
so the parse kept a quote character that no reading had been scored against. On

```
col0',col1
,''
NULL,'
```

`detectQuote()` answered `'`, `detectDelimiter()` answered `,` (scored under
`"`), and the table was then tokenized under `'` with the first `'` still open:
`E_UNTERMINATED_QUOTE` at line 3, column 6, exit code 3. Those bytes are not
malformed. `csv.reader` with `quotechar='"'` reads them as three rows and six
fields, and under `quotechar="'"` the two apostrophes at field starts are
ordinary text. Over 4000 files written by Python's `csv.writer` with
`quotechar='"'`, the two-call split raised `E_UNTERMINATED_QUOTE` on **266** of
them and silently mangled another **943**; reading them as one decision fixes the
266 and leaves the rest ambiguous (see the limits below).

```console
$ printf "col0',col1\n,''\nNULL,'\n" > stray.csv
$ csvjson to-json stray.csv --compact
[{"col0'":null,"col1":"''"},{"col0'":null,"col1":"'"}]
```

(First column typed null: those cells are `''` and `'`, both recognised null
literals. `--types all-string` keeps them as text.)

One case deserves naming, because it is the easy mistake in the other direction:
a reading that reveals **no delimiter candidate at all** is not a rejected
reading, it is a single-column file, and the `,` fallback stands. Swapping the
quote character because the winner found no delimiter turns a three-row file
into three columns, because the comma was never quoting anything.

```console
$ printf 'col0'"'"'\n"a,b"\n'"'"'start\n' > one.csv
$ csvjson to-json one.csv --no-header --compact
[{"0":"col0'"},{"0":"a,b"},{"0":"'start"}]
```

Passing `--quote` pins the quote character: it is never swapped, so a file that
strands an opener under it still fails loudly instead of being read as something
you did not ask for. `--delimiter` likewise wins, while the quote character is
still detected — a stranded quote throws on the whole file.

Candidates are compared lexicographically, never summed. In order: **agreement**
(how many records share the candidate's modal count), **presence** (how many
records contain it at all), **width** (the modal count), **raw occurrences**, and
finally the candidate order as a documented tie-break.

Agreement leads because the delimiter separates every field of every record, so
those records agree on how many fields there are, while a stray `;` sits in the
one row that mentions it. Presence and agreement are indistinguishable on a
rectangular file — over 14 072 files whose dialect the bytes fully determine,
they never disagree — so the order between them is settled on ragged input.
Counting only the 2 762 cases out of 300 000 where they answer differently,
agreement-first is right on 1 638 and presence-first on 568.

Two limits are worth stating plainly. First, detection is a heuristic: for a
sample in which two dialects both terminate and both explain every byte, no
algorithm can recover the writer's intent, and `csvjson` will not guess between
them beyond its documented scoring order. That limit is why the key order itself
is tested against the ranking function rather than against sample strings — on
ragged input the samples do not carry the information. Second, the guard against
stranded quotes is a policy decision on input whose meaning the bytes do not
determine — over every sample whose dialect *is* determined, dropping it changes
nothing, and over random samples it changes 7.8% of answers. It is a safety net
for malformed files, not a correctness guarantee.

`--stats` prints the detected dialect and inferred types to **stderr**, leaving
stdout clean for piping.

## Types are column-atomic

`--types auto` (the default) gives every column exactly one type, decided by
looking at the whole column. If a single cell is not numeric, the entire column
stays a string:

```console
$ printf 'id,score\n1,10\n2,high\n3,30\n' | csvjson to-json - --compact
[{"id":1,"score":"10"},{"id":2,"score":"high"},{"id":3,"score":"30"}]
```

`score` is `"10"`, `"high"`, `"30"` — never the number `10` sitting next to the
string `"high"`. That mixed-type column would force every consumer to write
`typeof` checks, and it is far better to make the inconsistency visible at the
column level where the data is wrong.

Modes: `auto`, `all-string`, `number`, `boolean`, `null`. A forced mode is an
explicit override: unconvertible values are preserved verbatim rather than
dropped.

The whole column is read before a type is decided, so **empty cells are
neutral**: they never veto a type and never turn a value into a `null`. That
makes the verdict independent of row order, which is the point — moving a blank
cell up or down cannot re-type a column or discard a value that sat below it.
A column needs every non-blank cell to agree:

| column contains | type | why |
| --- | --- | --- |
| any non-numeric, non-boolean text | `string` | a column is atomic |
| booleans *and* numbers | `string` | a genuine conflict |
| numbers only | `number` | |
| booleans only | `boolean` | |
| nothing but blanks | `null` | |

So a `1` buried under a boolean column still keeps the column honest — it
makes it a `string` rather than silently becoming `null` next to `true`:

```console
$ printf 'name,ok\nalice,true\nbob,1\n' | csvjson to-json - --compact
[{"name":"alice","ok":"true"},{"name":"bob","ok":"1"}]
```

Note that `true` is *not* a boolean here either. Booleans and numbers cannot
share a column, and the tie resolves to text, which is the same rule that
keeps `10` from landing next to `"high"`. To keep the booleans as booleans and
still see the numbers, name the type yourself with `--types boolean` — a
forced mode preserves what it cannot convert:

```console
$ printf 'name,ok\nalice,true\nbob,1\n' | csvjson to-json - --compact --types boolean
[{"name":"alice","ok":true},{"name":"bob","ok":"1"}]
```

`--types all-string` gives the same JSON here, but a real `boolean` column is
worth keeping as one, so prefer the forced mode when the column genuinely is
boolean and the stray number is the anomaly.

## Ragged rows

Rows whose width disagrees with the header are reconciled by `--ragged`:

| mode | behaviour |
| --- | --- |
| `pad` (default) | fill missing trailing cells with `--pad-value`; truncate overflow |
| `error` | throw on the first width mismatch |
| `dump` | move overflow into an array cell in the last column |

A blank line is not a ragged row. It is an empty line, and `--ragged` never
touches it: padding it would invent cells the file did not contain, and the
writer would emit a delimiter for each one. The row survives the round trip as
an empty line.

> An empty line cannot cross the JSON boundary. Every JSON shape has to name
> its cells, so a blank line comes back out as a row of nulls — and `{"a":null,
> "b":null}` is indistinguishable from a row that really did hold nulls, which
> the writer turns back into `,`:
>
> ```console
> $ printf 'a,b\n1,2\n\n3,4\n' > g2.csv
> $ csvjson to-json g2.csv --compact
> [{"a":1,"b":2},{"a":null,"b":null},{"a":3,"b":4}]
> $ csvjson to-csv g2.json          # -> a,b / 1,2 / , / 3,4
> ```
>
> Blank lines round-trip losslessly through the table API
> (`parseCsv` → `stringify`), which is what keeps them out of the `--ragged`
> business in the first place. Note that `a,b\n,\n` is a different file: the
> comma makes it a row of two empty cells, which *is* padded and *is* reported
> as ragged.

```console
$ printf 'a,b,c\n1,2\n1,2,3,4\n' > g.csv
$ csvjson to-json g.csv --ragged dump
[
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
]
```

```console
$ csvjson to-json g.csv --ragged error; echo "exit=$?"
csvjson: ragged row 2 (line 2) has 2 fields, expected 3
exit=3
```

`pad` is the default because a missing trailing cell is usually a genuine gap
in the export rather than a corrupt file; use `error` when a wrong row count
should fail the build.

## Exit codes

| code | meaning |
| --- | --- |
| `0` | success |
| `2` | usage or I/O error (bad flag, missing file, invalid JSON) |
| `3` | malformed CSV — unterminated quote, or a ragged row under `--ragged error` |

Code `3` is deliberately distinct so CI can tell *bad data* apart from *the tool
falling over*. "Unterminated" here means a quote stranded under **every** quote
character `csvjson` sniffs for, so that no legal reading is left:

```console
$ printf 'a,b\nc,"unterminated\nd,%s\n' "'dangling" > bad.csv
$ csvjson to-json bad.csv; echo "exit=$?"
csvjson: unterminated quoted field starting at line 2, column 3
exit=3
```

A lone stray `"` is not that. Under `quotechar="'"` the bytes parse cleanly, so
detection uses that quote and the file is reported as the data it is — the same
file with the second line's `'` removed:

```console
$ printf 'a,b\nc,"unterminated\nd,e\n' > stray.csv
$ csvjson to-json stray.csv; echo "exit=$?"
[
  {
    "a": "c",
    "b": "\"unterminated"
  },
  {
    "a": "d",
    "b": "e"
  }
]
exit=0
```

Reporting that as a malformed file would be a bug in the reader dressed up as a
property of the input.

## Library API

```js
const csvjson = require('csvjson');

const table = csvjson.parseCsv('a,b\n1,2\n');
// table.header      -> ['a', 'b']
// table.rows        -> [[1, 2]]          (types inferred column-wise)
// table.types       -> ['number', 'number']
// table.columnCount -> 2

csvjson.toJson(table);                    // '[\n  {\n    "a": 1,\n    "b": 2\n  }\n]'
csvjson.fromJson([{ a: 1, b: 2 }]);       // 'a,b\n1,2\n'
```

Streaming, for files too large to hold in memory:

```js
const tz = new csvjson.Tokenizer({ delimiter: ';', quote: '"' });
const rows = [];
for await (const chunk of stream) rows.push(...tz.push(chunk));
rows.push(...tz.flush());
```

`tz.push()` returns the tokenizer's live record array, so copy it (`slice()`) if
you need a snapshot before the next chunk. An unterminated quote is reported by
`flush()` as an `UnterminatedQuoteError` carrying `.line` and `.column`.

## Hard cases handled

- **Embedded delimiters** — `a,"b,c",d`
- **Embedded newlines** — CR, LF and CRLF inside a quoted field, preserved
  byte-for-byte and never normalised
- **Escaped quotes** — `""` inside a quoted field becomes one `"`; a field
  holding exactly one quote is `"""`
- **UTF-8 BOM** — stripped at the start of input, and only there
- **Trailing newline** — present or absent, both handled
- **Chunk boundaries** — a `\r\n` pair, a `""` escape or a multi-character
  delimiter split across reads is still tokenized correctly, and the answer is
  the same at every chunking
- **Records appear when they complete** — a record is in `tz.rows` as soon as
  its terminating byte arrives, not one read later
- **Mixed line endings** — CRLF, LF and bare CR all terminate a record
- **Unterminated quotes** — reported with a line and column, never silently
  swallowed

## Options

| option | default | meaning |
| --- | --- | --- |
| `-h, --help` | — | print usage |
| `-V, --version` | — | print the version |
| `-o, --output` | stdout | output file, `-` for stdout |
| `-d, --delimiter` | detect | single character, or `\t` |
| `--delimiter` | detect | long form of `-d` |
| `-q, --quote` | detect | single character |
| `--quote` | detect | long form of `-q` |
| `--no-detect` | off | skip detection, use comma + `"` |
| `--no-header` | off | first record is data |
| `--types` | `auto` | `auto`, `all-string`, `number`, `boolean`, `null` |
| `--ragged` | `pad` | `pad`, `error`, `dump` |
| `--pad-value` | `""` | filler for `--ragged pad` |
| `--json` / `--ndjson` / `--columns` | `objects` | JSON output shape |
| `--transpose` | off | swap rows and columns |
| `--stats` | off | dialect + type summary on stderr |
| `--compact` | off | single-line JSON |
| `--indent` | `2` | JSON indent |
| `--quote-all` | off | quote every field on write |
| `--eol` | `lf` | `lf` or `crlf` record separator |
| `--no-trailing-nl` | off | omit the final record separator |
| `--` | — | end of options; everything after it is positional |

A file whose name begins with `-` is otherwise read as an unknown option, so
pass it after a bare `--`:

```console
$ csvjson -- to-json -2024-01.csv
```

## Tests

```console
$ npm test
```

The suite runs on Node alone, with no dependencies and no network. Beyond it,
four development-only harnesses check the implementation against ground truth
outside the repository. They need Python and are neither part of `npm test` nor of
CI, because the published package must stay build-free:

| harness | checks |
| --- | --- |
| `python3 scripts/crosscheck.py` | reader, writer and chunk-invariance against python's `csv` module, in both directions |
| `python3 scripts/detect-check.py` | dialect detection against the delimiter and quote character python's `csv.writer` was told to use |
| `bash scripts/mutation-test.sh` | that the tokenizer's mutants are caught by the suite and the cross-check |
| `bash scripts/mutation-detection.sh` | the same, for the detector — including one mutant documented as surviving by design, with the measurement that justifies it |

`crosscheck.py` covers only well-formed input, so neither harness is a total
oracle: malformed-input rejection, type inference, the output shapes and the
ragged policies are csvjson's own concepts with no counterpart in python's `csv`,
and those belong to the suite. Each harness's docstring states its own gaps.

## License

MIT © 2026 Xwalims
