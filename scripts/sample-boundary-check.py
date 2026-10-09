#!/usr/bin/env python3
"""Differential: a sample truncated MID-QUOTE must not look malformed.

Ground truth is python's csv.reader on the exact bytes. This is the one
condition csvjson cannot see: the sniff sample is the first `sampleSize`
characters of a LARGER file, so a quoted field that straddles the boundary ends
the sample while still open. That is where the sample was cut, not evidence
about the bytes -- yet sniff() reports it as `unterminated` and detectDialect()
disqualifies the quote character on it.

    python3 scripts/sample-boundary-check.py 400
    python3 scripts/sample-boundary-check.py 400 --seed 99
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
WORKER = os.path.join(HERE, "sample-boundary-worker.js")

DELIMS = (",", ";", "\t", "|")
QUOTES = ('"', "'")


def build(n, seed):
    """Files whose `sampleSize` boundary falls inside a quoted field."""
    rng = random.Random(seed)
    cases = []
    for _ in range(n):
        d = rng.choice(DELIMS)
        q = rng.choice(QUOTES)
        # Pad so the 65536-byte sample boundary lands at a different offset
        # inside the quoted field on every case.
        pad = rng.randint(60000, 76000)
        lead = rng.randint(0, 400)
        trailing = rng.randint(0, 40)
        body = "y" * pad
        rows = [
            ["id", "note", "tag"],
            ["1", q + "line one\n" + body + q, "t"],
            ["2", "plain", "u"],
            ["3", q + "tail" + str(trailing) + q, "v"],
        ]
        if lead:
            rows.insert(0, ["c" + str(lead), "d", "e"])
        buf = io.StringIO(newline="")
        csv.writer(buf, delimiter=d, quotechar=q, doublequote=True,
                   quoting=csv.QUOTE_MINIMAL, lineterminator="\n").writerows(rows)
        text = buf.getvalue()
        cases.append({"text": text, "delimiter": d, "quote": q})
    return cases


def truth(text, d, q):
    rows = [r for r in csv.reader(io.StringIO(text, newline=""), delimiter=d,
                                 quotechar=q)]
    return {"rowCount": len(rows) - 1, "width": len(rows[0]) if rows else 0,
            "noteLens": [len(r[1]) for r in rows[1:]]}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("total", nargs="?", type=int, default=400)
    ap.add_argument("--seed", type=int, default=2024)
    args = ap.parse_args()

    if not os.path.exists(WORKER):
        print(f"sample-boundary-check: worker not found at {WORKER}", file=sys.stderr)
        return 2

    cases = build(args.total, args.seed)
    proc = subprocess.run([os.environ.get("NODE", "node"), WORKER],
                          input=json.dumps(cases), capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        return 2
    got = json.loads(proc.stdout)

    bad = 0
    for i, c in enumerate(cases):
        want = truth(c["text"], c["delimiter"], c["quote"])
        have = got[i]
        if have.get("ok") and have.get("rowCount") == want["rowCount"] \
                and have.get("columnCount") == want["width"]:
            continue
        bad += 1
        if bad <= 3:
            print(f"\ncase {i}: delim={c['delimiter']!r} quote={c['quote']!r} "
                  f"len={len(c['text'])}", file=sys.stderr)
            print(f"  python  csv.reader: rows={want['rowCount']} width={want['width']} "
                  f"noteLens={want['noteLens']}", file=sys.stderr)
            print(f"  csvjson parseCsv  : {json.dumps(have)[:400]}", file=sys.stderr)

    print(f"seed={args.seed}: {len(cases) - bad}/{len(cases)} files parse "
          f"the way python's csv.reader does")
    if bad:
        print(f"sample-boundary-check: {bad} mismatches "
              f"(seed={args.seed})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())