# csvjson

RFC 4180 CSV ⇄ JSON with dialect detection and strict round-tripping. Zero
dependencies, Node ≥ 20, CommonJS.

The point of this library is the round trip. A CSV file goes in, a JSON file
comes out, and converting back gives you **the same bytes you started with** —
embedded newlines, embedded delimiters, `""` escapes and all.

```
$ npm install -g csvjson
```

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

## Ragged rows

Rows whose width disagrees with the header are reconciled by `--ragged`:

| mode | behaviour |
| --- | --- |
| `pad` (default) | fill missing trailing cells with `--pad-value`; truncate overflow |
| `error` | throw on the first width mismatch |
| `dump` | move overflow into an array cell in the last column |

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
falling over*:

```console
$ printf 'a,b\nc,"unterminated\nd,e\n' > bad.csv
$ csvjson to-json bad.csv; echo "exit=$?"
csvjson: unterminated quoted field starting at line 2, column 3
exit=3
```

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
- **Chunk boundaries** — a `\r\n` pair or a `""` escape split across reads is
  still tokenized correctly
- **Mixed line endings** — CRLF, LF and bare CR all terminate a record
- **Unterminated quotes** — reported with a line and column, never silently
  swallowed

## Options

| option | default | meaning |
| --- | --- | --- |
| `-o, --output` | stdout | output file, `-` for stdout |
| `--delimiter` | detect | single character, or `\t` |
| `--quote` | detect | single character |
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

## Tests

```console
$ npm test
```

## License

MIT © 2026 Xwalims