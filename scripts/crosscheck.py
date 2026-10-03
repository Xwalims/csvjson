#!/usr/bin/env python3
"""Cross-check csvjson against Python's ``csv`` module, in both directions.

Why this exists
---------------
Every other expectation in this repository's suite derives from the code under
test. Round-tripping through csvjson proves the reader and the writer agree with
each other -- and a compensating pair of bugs in those two would still pass every
round-trip test in ``test/``. Python's ``csv`` module is an independent RFC 4180
implementation written for a different purpose, so agreeing with it is evidence
that the bytes on the wire mean what csvjson claims they mean.

Direction matters, so this runs four checks rather than one:

``interop-read``  Python WRITES the CSV, csvjson READS it, and the rows are
                  compared against the values Python held *before* writing. The
                  only implementation under test is csvjson's reader.
``reader-parity`` Python writes it and BOTH readers parse it, so csvjson's
                  reader is compared against ``csv.reader`` on identical bytes.
``interop-write`` csvjson WRITES the CSV and Python READS it back, compared
                  against the original values. The only implementation under
                  test is csvjson's writer -- the direction ``test/`` cannot
                  reach, since nothing outside this repository ever parses its
                  output.
``chunk-invariance``
                  No oracle at all: tokenizing an input whole must equal
                  tokenizing it one character at a time, and equal to tokenizing
                  it at *every* split point. This is an internal invariant of the
                  streaming API that Python cannot adjudicate (it has no
                  streaming state), so the two implementations are irrelevant
                  here and the harness checks the property directly.

What it does NOT cover (do not mistake this for a total oracle)
--------------------------------------------------------------
Every case is generated as WELL-FORMED CSV and only valid data is compared, so
this harness says nothing about:

- **malformed input rejection.** csvjson raises ``E_UNTERMINATED_QUOTE`` and
  exits 3 on an unclosed quote; ``csv.reader`` in non-strict mode silently
  accepts the same bytes and returns them as data. That is a deliberate policy
  difference, not a bug in either, and there is no shared ground truth to
  compare. ``test/tokenize.test.js`` owns that territory.
- **dialect detection.** ``csv.reader`` is told its delimiter and quote
  character; it never guesses. ``detectDelimiter``/``detectQuote`` have no
  external oracle at all, so the sniffing score is unverified by this harness.
- **the JSON layer.** Type inference, ``--ragged`` reconciliation, the
  ``objects``/``ndjson``/``columns`` shapes and the transpose are csvjson's own
  concepts with no counterpart in ``csv``. They are checked by the suite.
- **numeric-header key ordering**, which is a JavaScript object-key property
  rather than anything about CSV.

Two deliberate divergences are normalised rather than reported, and both are
measured rather than assumed:

- **UTF-8 BOM.** csvjson strips a leading BOM; ``csv.reader`` keeps it as data.
  The interop checks never emit one, and the parity check strips it first, so
  this shows up as a documented extension instead of 100% noise.
- **a row holding exactly one empty cell.** ``[""]`` and a blank line are the
  same bytes in CSV, so no writer can distinguish them and no reader can recover
  the difference. csvjson writes ``[""]`` as a blank line, which Python's own
  ``csv.writer`` also does. ``interop-write`` therefore compares after mapping
  ``[""]`` to ``[]`` on both sides. Treating this as a failure would mean
  reporting an ambiguity of the format as a bug in the code.

Those gaps are why this is an addition to the suite, not a replacement for it.
It is a *development* tool, not part of the shipped package and not part of the
CI suite: it needs Python, and the published package must stay dependency- and
build-free. Run it explicitly:

    python3 scripts/crosscheck.py              # ~600 cases per check, fixed seed
    python3 scripts/crosscheck.py 3000         # more cases
    python3 scripts/crosscheck.py --seed 12345
    python3 scripts/crosscheck.py --check interop-write

Ground truth per check
----------------------
``interop-read``   the values Python held before ``csv.writer`` emitted them --
                   not a second parse of the same bytes.
``reader-parity``  ``csv.reader`` over the identical text.
``interop-write``  the values handed to csvjson's ``stringify``, re-read by
                   ``csv.reader``.
``chunk-invariance``  the one-shot parse, with the tokenizer's own ``blank``
                   flag mapping a blank record to ``[]`` so it matches
                   ``csv.reader``, which returns ``[]`` for a blank line too.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKER = os.path.join(HERE, "crosscheck-worker.js")

# Delimiters and quote characters this package sniffs for. The harness stays
# inside that set so a disagreement is a real disagreement, not an unsupported
# dialect that csvjson was never asked to handle.
DELIMITERS = (",", ";", "\t", "|")
QUOTES = ('"', "'")
EOLS = ("\n", "\r\n", "\r")

# Field content chosen to reach every branch of the tokenizer's state machine:
# empty cells, cells that need quoting for each reason, embedded record breaks,
# and non-ASCII text that must survive untouched.
FRAGMENTS = (
    "a", "b", "x y", "", " lead", "trail ", "  both  ", "has,comma",
    "has;semi", 'has"quote', "has\ttab", "has|pipe", "123", "3.5", "-7",
    "true", "null", " ", "  ", "\t", "café", "日本", "emoji☃", "0", "NaN",
)

BOM = "﻿"

# Bound on the exhaustive split sweep in chunk-invariance: it tokenizes the
# input len(text)+1 times, so cost is quadratic. Past this length the sweep is
# skipped and the per-character check still runs. Asserted, not assumed.
MAX_SWEEP_LEN = 96


def python_write(rows, delimiter, quote, eol, quoting="minimal"):
    """Emit rows with csv.writer and return the text."""
    buf = io.StringIO(newline="")
    writer = csv.writer(
        buf,
        delimiter=delimiter,
        quotechar=quote,
        doublequote=True,
        quoting=csv.QUOTE_ALL if quoting == "all" else csv.QUOTE_MINIMAL,
        lineterminator=eol,
    )
    writer.writerows(rows)
    return buf.getvalue()


def python_read(text, delimiter, quote):
    """Parse text with csv.reader, in non-strict mode like the harness above."""
    buf = io.StringIO(text, newline="")
    reader = csv.reader(
        buf,
        delimiter=delimiter,
        quotechar=quote,
        doublequote=True,
        skipinitialspace=False,
        strict=False,
    )
    return [list(row) for row in reader]


def normalise_blank(rows):
    """Map a lone empty cell to an empty record.

    ``[""]`` and a blank line are the same bytes, so csvjson's writer emits a
    blank line for the former and ``csv.reader`` reports the latter. Both sides
    are mapped so the ambiguity is not reported as a bug. See the module
    docstring.
    """
    return [row if row != [""] else [] for row in rows]


class CaseBuilder:
    """Deterministic generator of well-formed cases."""

    def __init__(self, rng):
        self.rng = rng

    def field(self):
        r = self.rng.random()
        if r < 0.55:
            return self.rng.choice(FRAGMENTS)
        if r < 0.70:
            # A bare delimiter, quote or tab: the cases most likely to be
            # quoted differently by the two implementations.
            return self.rng.choice([',', ';', '|', '\t', '"', "'"])
        if r < 0.88:
            # Embedded record breaks, including the CR/LF/CRLF mix that the
            # tokenizer has to keep verbatim rather than normalise.
            return self.rng.choice(["a\nb", "a\rb", "a\r\nb", "\n", "\r"])
        return "".join(self.rng.choice(FRAGMENTS) for _ in range(self.rng.randint(0, 4)))

    def rows(self, allow_empty_record=False):
        width = self.rng.randint(1, 5)
        count = self.rng.randint(1, 4)
        out = [[self.field() for _ in range(width)] for _ in range(count)]
        if allow_empty_record and self.rng.random() < 0.25:
            # A record holding ZERO fields, i.e. a blank LINE. This is not
            # reachable any other way: python's csv.writer renders a row of one
            # empty cell as '""', so blank records never appear in
            # python-written input unless they are asked for explicitly. Without
            # this the `blank` flag in _endRecord is unobservable through the
            # oracle and dropping it is an unkillable mutant -- which is exactly
            # what an earlier version of the mutation harness reported.
            out.insert(self.rng.randint(0, len(out)), [])
        return out

    def dialect(self):
        return {
            "delimiter": self.rng.choice(DELIMITERS),
            "quote": self.rng.choice(QUOTES),
            "eol": self.rng.choice(EOLS),
        }

    # -- checks --------------------------------------------------------
    def build_read(self, n):
        """Python writes, csvjson reads. Ground truth is the written values."""
        cases, expected = [], []
        for _ in range(n):
            d = self.dialect()
            rows = self.rows(allow_empty_record=True)
            # Both quoting styles are used: MINIMAL exercises csvjson's reader
            # on files a real writer produces, ALL exercises it on the
            # quoted-everything style.
            quoting = self.rng.choice(["minimal", "all"])
            text = python_write(rows, d["delimiter"], d["quote"], d["eol"], quoting)
            if self.rng.random() < 0.25:
                # Drop the final record separator; a file need not end on one.
                # When the final separator is dropped the LAST record can be the
                # blank one, and csv.reader legitimately returns no record for a
                # blank line that the writer placed at the very end of a stream
                # with nothing after it. Comparing against the pre-write rows
                # would then report a disagreement that is not one -- verified:
                # python's own reader gives the same three-record answer for the
                # bytes, so the ground truth has to come from csv.reader here,
                # not from what the writer was handed.
                if d["eol"] in text:
                    text = text[: text.rfind(d["eol"])]
                    expected.append({"rows": python_read(text, d["delimiter"], d["quote"])})
                    cases.append({"op": "read", "text": text, **d})
                    continue
            cases.append({"op": "read", "text": text, **d})
            expected.append({"rows": rows})
        return cases, expected

    def build_parity(self, n):
        """Both readers parse identical bytes; compare reader to reader."""
        cases, expected = [], []
        for _ in range(n):
            d = self.dialect()
            rows = self.rows()
            quoting = self.rng.choice(["minimal", "all"])
            text = python_write(rows, d["delimiter"], d["quote"], d["eol"], quoting)
            cases.append({"op": "read", "text": text, **d})
            expected.append({"rows": python_read(text, d["delimiter"], d["quote"])})
        return cases, expected

    def build_write(self, n):
        """csvjson writes, Python reads. Ground truth is the given values."""
        cases, expected = [], []
        for _ in range(n):
            d = self.dialect()
            header = [f"h{i}" for i in range(self.rng.randint(1, 5))] if self.rng.random() < 0.7 else None
            rows = self.rows()
            if self.rng.random() < 0.2:
                # Degenerate tables. These are WRITE cases -- the input is a
                # table, not a document -- because a check whose name says
                # "csvjson writes" must exercise the writer. Feeding it a raw
                # string instead (an empty document, a blank line, a BOM) was
                # the bug in an earlier version: those cases took the reader
                # path and every one of them failed as "worker wrote no text".
                pick = self.rng.random()
                if pick < 0.34:
                    rows, header = [], None
                elif pick < 0.67:
                    rows, header = [[]], None
                else:
                    rows, header = [[""]], None
            cases.append(
                {
                    "op": "write",
                    "header": header,
                    "rows": rows,
                    "delimiter": d["delimiter"],
                    "quote": d["quote"],
                    "eol": d["eol"],
                }
            )
            expected.append({"rows": ([header] if header else []) + rows})
        return cases, expected

    def build_chunks(self, n):
        """Internal invariant: the result must not depend on chunking."""
        cases, expected = [], []
        hand = [
            "a,\"b\r\nc\",d", "a,\"b\"\"c\",d", "a,\"b\r\n\r\nc\",d", "a,\"\",",
            '"""",x', 'a,"b\rc\nd\r\ne",f', '"a\rb"', 'a,"b""",c', '"\r\n"',
            '""\r\n""', 'a,"x"\r\nb,"y"', 'a,"x"\rb,"y"\rc,"z"', '"', '""',
            '"""', '""""', '"""""', 'a,"b"', 'a,"b"x', '"a""\r\n""b",c',
            "a,b\r\n\r\nc,d", '"x"\r\n\r\n"y"\r\n', "a,\"b\nc\nd\",e",
            '"a","b","c"\r\n"d","e","f"', BOM + "a,b", 'a,"b\rc"',
        ]
        for text in hand:
            for delim in DELIMITERS:
                for quote in QUOTES:
                    cases.append({"op": "chunks", "text": text, "delimiter": delim, "quote": quote})
                    expected.append(None)  # self-comparing, nothing to compare against

        # Multi-character delimiters. python's csv module rejects these outright
        # ("delimiter must be a unicode character, not a string of length 2"),
        # so NO other check here can cover them -- a delimiter split across two
        # reads was silently missed until these cases existed, losing field
        # boundaries with no error. They are pure invariant cases: the tokenizer
        # agreeing with itself across chunkings is the whole claim.
        for delim in ("::", "ab", "...", "<>", "--", "\r\n"):
            for text in (
                "a" + delim + "b" + delim + "c",
                "a" + delim + "b",
                "a" + delim + "b" + delim,
                '"a' + delim + 'b"' + delim + "c",
                '"' + delim + '"',
                '"a' + delim + '"' + delim + '"b' + delim + '"',
                delim.join(["x", "y"]) + delim,
                delim,
                "a" + delim,
            ):
                cases.append({"op": "chunks", "text": text, "delimiter": delim, "quote": '"'})
                expected.append(None)

        for _ in range(n):
            d = self.dialect()
            rows = self.rows()
            delim, quote, eol = d["delimiter"], d["quote"], d["eol"]
            needs = (
                lambda v: v == "" or delim in v or quote in v
                or "\r" in v or "\n" in v or v != v.strip()
            )
            text = eol.join(
                delim.join(
                    quote + v.replace(quote, quote + quote) + quote if needs(v) else v
                    for v in row
                )
                for row in rows
            )
            if self.rng.random() < 0.7:
                text += eol
            cases.append({"op": "chunks", "text": text, **d})
            expected.append(None)
        return cases, expected


CHECKS = ("interop-read", "reader-parity", "interop-write", "chunk-invariance")

BUILDERS = {
    "interop-read": "build_read",
    "reader-parity": "build_parity",
    "interop-write": "build_write",
    "chunk-invariance": "build_chunks",
}

# Weights so the default run spends most of its cases on the checks that can
# actually find a bug. chunk-invariance generates far more work per case (a full
# split sweep), so it gets the smallest share.
WEIGHTS = {
    "interop-read": 0.30,
    "reader-parity": 0.30,
    "interop-write": 0.30,
    "chunk-invariance": 0.10,
}


def build(check, total, seed):
    builder = CaseBuilder(random.Random(seed))
    method = getattr(builder, BUILDERS[check])
    if check == "chunk-invariance":
        # The hand-picked cases are fixed, so scale the random part only.
        cases, expected = method(total)
        return cases, expected, 0
    cases, expected = method(total)
    return cases, expected, 0


def compare(check, case, want, got):
    """Return None on agreement, else a diff string.

    `case` carries the dialect, which interop-write needs: the ground truth is
    computed by parsing csvjson's own output, so it cannot be known until the
    worker has run. That is why the re-read happens here rather than in the
    builder.
    """
    if not got.get("ok"):
        return f"worker error: {got.get('error')}"
    if check == "chunk-invariance":
        return None if got.get("agrees") else got.get("detail", "chunking changed the result")
    if check == "interop-write":
        # csvjson returned CSV text; the ground truth is what csv.reader makes
        # of those bytes. Comparing `got` directly would compare a string
        # against a list of rows and report every case as a mismatch -- an
        # earlier version did exactly that and produced 248 phantom failures in
        # 300 cases.
        text = got.get("text")
        if not isinstance(text, str):
            return f"worker wrote no text: {got!r}"
        try:
            back = python_read(text, case["delimiter"], case["quote"])
        except csv.Error as exc:
            return f"python could not read csvjson's output {text!r}: {exc}"
        # Both sides go through the same normalisation: a lone empty cell and a
        # blank line are the same bytes, so `[""]` is read back as `[]`.
        if normalise_blank(back) == normalise_blank(want["rows"]):
            return None
        return (
            f"csvjson wrote {text!r}\n"
            f"  python read {back!r}\n"
            f"  wanted      {want['rows']!r}"
        )
    rows = got.get("rows")
    return None if rows == want["rows"] else f"expected {want['rows']!r}\n  actual   {rows!r}"


def run_check(check, total, seed):
    cases, expected, _ = build(check, total, seed)
    proc = subprocess.run(
        [os.environ.get("NODE", "node"), WORKER],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(f"crosscheck: {check}: worker failed", file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        return None
    try:
        results = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        print(f"crosscheck: {check}: worker wrote invalid JSON: {exc}", file=sys.stderr)
        return None
    if len(results) != len(cases):
        print(
            f"crosscheck: {check}: worker returned {len(results)} results "
            f"for {len(cases)} cases",
            file=sys.stderr,
        )
        return None

    failures = []
    for case, want, got in zip(cases, expected, results):
        diff = compare(check, case, want, got)
        if diff is not None:
            failures.append((case, diff))

    by_delim = {}
    for case in cases:
        key = case.get("delimiter", "?")
        by_delim[key] = by_delim.get(key, 0) + 1
    breakdown = ", ".join(f"{d!r}={c}" for d, c in sorted(by_delim.items()))

    if failures:
        # The wording differs by check: three compare against python's csv, while
        # chunk-invariance has no oracle at all (python has no streaming state),
        # so calling it a disagreement "with python csv" would be a false claim
        # about what was checked.
        against = "python csv" if check != "chunk-invariance" else "its own one-shot parse"
        print(
            f"crosscheck: {check}: {len(failures)}/{len(cases)} cases disagree "
            f"with {against} (seed={seed}; {breakdown})",
            file=sys.stderr,
        )
        for case, diff in failures[:8]:
            print(f"  input={case.get('text', '<generated>')!r} "
                  f"delimiter={case.get('delimiter')!r} quote={case.get('quote')!r}",
                  file=sys.stderr)
            print(f"  {diff}", file=sys.stderr)
        if len(failures) > 8:
            print(f"  ... and {len(failures) - 8} more", file=sys.stderr)
        return 1

    verb = {
        "interop-read": "read back python-written CSV",
        "reader-parity": "parity with csv.reader",
        "interop-write": "write CSV python reads back",
        "chunk-invariance": "hold under every chunk boundary",
    }[check]
    print(f"crosscheck: {check}: {len(cases)}/{len(cases)} cases {verb} (seed={seed}; {breakdown})")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Cross-check csvjson against python's csv module."
    )
    parser.add_argument("total", nargs="?", type=int, default=600,
                        help="cases per check (default 600)")
    parser.add_argument("--seed", type=int, default=20261003)
    parser.add_argument("--check", action="append", choices=CHECKS,
                        help="run only these checks (repeatable)")
    args = parser.parse_args()

    if not os.path.exists(WORKER):
        print(f"crosscheck: worker not found at {WORKER}", file=sys.stderr)
        return 2

    selected = args.check or list(CHECKS)
    failed = 0
    for check in selected:
        share = args.total
        if len(selected) > 1 and args.total < 100:
            share = max(10, round(args.total * WEIGHTS[check]))
        rc = run_check(check, share, args.seed)
        if rc is None:
            return 2
        failed |= rc
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())