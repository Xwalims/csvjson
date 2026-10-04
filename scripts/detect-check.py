#!/usr/bin/env python3
"""Differential for csvjson's DIALECT DETECTION -- the gap crosscheck.py admits.

crosscheck.py compares the reader, the writer and the chunking invariant against
python's csv module, and its docstring states plainly that dialect detection "has
no external oracle at all". That is not quite true. For detection the ground
truth is not a second parser but a fact about the GENERATOR: it knows which
delimiter and quote character it wrote the file with, and that fact is recoverable
from a sample whenever the sample determines it.

So a case is scored only when the property is actually determined by the bytes:

  DELIM observable  the chosen delimiter is visible outside quotes under BOTH
                    quote characters, and NO rival candidate is visible outside
                    quotes under EITHER. Checking both matters: '"q"\t\'\'\'a;b\'\'\'
                    is 2 columns split on a tab when read with quotechar "'" and
                    2 columns split on ';' when read with quotechar '"'. Both
                    readings terminate and both yield exactly one delimiter, so
                    nothing in the bytes reveals which quote character was meant.
                    Scoring that as a mismatch would report an ambiguity of the
                    FORMAT as a bug in the sniffer.
  QUOTE observable  the chosen quote character opens at least one quoted field,
                    and the rival never sits at a field start.

Ground truth remains the dialect python's csv.writer was told to use.
csv.Sniffer is reported alongside as a third opinion only: it has heuristics of
its own and can decline to answer, so it never decides pass/fail.

This is a development tool, like crosscheck.py: it needs Python and is not part
of the shipped package or the CI suite.

    python3 scripts/detect-check.py 3000
    python3 scripts/detect-check.py 3000 --seed 4242
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
WORKER = os.path.join(HERE, "detect-worker.js")

DELIMS = (",", ";", "\t", "|")
QUOTES = ('"', "'")
EOLS = ("\n", "\r\n", "\r")

# Content chosen to reach every branch of the sniffer: the chosen delimiter, the
# other candidates and both quote characters, inside and outside quoted fields.
NASTY = ('a', 'b', 'x y', '', ' lead', 'trail ', ',', ';', '|', '\t', '"', "'",
         '"q"', "'q'", '"a,b"', "'a;b'", '""', "''", 'a"b', "a'b", '1', '3.5',
         'café', '日本', 'x\r\ny', 'x\ny', 'x\ry', ' lead,lead', 'z|z', 'q;q')

FRAG = ('a', 'b', 'x y', '', ' lead', 'trail ', '  both  ', '123', '3.5', '-7',
        'true', 'null', ' ', 'café', '日本', 'emoji☃', '0', 'NaN')

BOM = "﻿"


def write(rows, d, q, eol, quoting):
    buf = io.StringIO(newline="")
    csv.writer(buf, delimiter=d, quotechar=q, doublequote=True,
               quoting=csv.QUOTE_ALL if quoting == "all" else csv.QUOTE_MINIMAL,
               lineterminator=eol).writerows(rows)
    return buf.getvalue()


def scan(text, d, q):
    """Walk `text` under dialect (d, q).

    Returns (outside_counts, quoted_fields, rival_at_field_start, unterminated).
    """
    outside = {}
    quoted = 0
    rival_start = 0
    rival = '"' if q == "'" else "'"
    i, n = 0, len(text)
    inq = False
    at_start = True
    while i < n:
        ch = text[i]
        if inq:
            if ch == q:
                if text[i + 1:i + 2] == q:
                    i += 1
                else:
                    inq = False
            i += 1
            continue
        if ch == q and at_start:
            inq = True
            quoted += 1
            at_start = False
            i += 1
            continue
        if ch == rival and at_start:
            rival_start += 1
        if ch in DELIMS:
            outside[ch] = outside.get(ch, 0) + 1
            at_start = True
        elif ch == "\n" or ch == "\r":
            at_start = True
            if ch == "\r" and text[i + 1:i + 2] == "\n":
                i += 1
        else:
            at_start = False
        i += 1
    return outside, quoted, rival_start, inq


def sniffer_says(text):
    try:
        d = csv.Sniffer().sniff(text, delimiters="".join(DELIMS))
        return {"delimiter": d.delimiter, "quotechar": d.quotechar}
    except Exception:
        return None


def build(n, seed):
    rng = random.Random(seed)
    cases, meta = [], []
    sk = {"ambiguous_delim": 0, "unobservable_delim": 0,
          "unobservable_quote": 0, "no_quote": 0}

    def field():
        r = rng.random()
        if r < 0.62:
            return rng.choice(NASTY)
        if r < 0.85:
            return rng.choice(FRAG)
        return "".join(rng.choice(FRAG) for _ in range(rng.randint(0, 3)))

    for _ in range(n):
        d, q, eol = rng.choice(DELIMS), rng.choice(QUOTES), rng.choice(EOLS)
        quoting = rng.choice(["minimal", "all"])
        width, nrows = rng.randint(1, 5), rng.randint(1, 5)
        rows = [[field() for _ in range(width)] for _ in range(nrows)]
        if rng.random() < 0.2:
            rows.insert(rng.randint(0, len(rows)), [])
        text = write(rows, d, q, eol, quoting)
        if rng.random() < 0.25 and eol in text:
            text = text[: text.rfind(eol)]

        outside, quoted, rival_start, _ = scan(text, d, q)
        alt = "'" if q == '"' else '"'
        alt_outside, _, _, _ = scan(text, d, alt)

        rivals = (set(outside) | set(alt_outside)) - {d}
        if outside.get(d, 0) > 0 and alt_outside.get(d, 0) > 0 and not rivals:
            d_scored = True
        else:
            d_scored = False
            sk["ambiguous_delim" if rivals else "unobservable_delim"] += 1

        q_scored = quoted > 0 and rival_start == 0
        if not q_scored:
            sk["unobservable_quote" if quoted == 0 else "no_quote"] += 1

        if not (d_scored or q_scored):
            continue
        cases.append({"text": text, "delimiter": d, "quote": q})
        meta.append({"d": d_scored, "q": q_scored,
                     "want_delim": d, "want_quote": q})
    return cases, meta, sk


def main():
    ap = argparse.ArgumentParser(
        description="Cross-check csvjson's dialect detection against python csv.writer.")
    ap.add_argument("total", nargs="?", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=777)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(WORKER):
        print(f"detect-check: worker not found at {WORKER}", file=sys.stderr)
        return 2

    cases, meta, sk = build(args.total, args.seed)
    proc = subprocess.run([os.environ.get("NODE", "node"), WORKER],
                          input=json.dumps(cases), capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        return 2
    got = json.loads(proc.stdout)
    if len(got) != len(cases):
        print(f"detect-check: worker returned {len(got)} for {len(cases)} cases",
              file=sys.stderr)
        return 2

    d_idx = [i for i, m in enumerate(meta) if m["d"]]
    q_idx = [i for i, m in enumerate(meta) if m["q"]]
    dfail = [(i, got[i].get("delimiter")) for i in d_idx
             if not got[i].get("ok") or got[i].get("delimiter") != meta[i]["want_delim"]]
    qfail = [(i, got[i].get("quote")) for i in q_idx
             if not got[i].get("ok") or got[i].get("quote") != meta[i]["want_quote"]]

    if not args.quiet:
        print(f"seed={args.seed}: generated {args.total}, scored {len(cases)} "
              f"(delim {len(d_idx)}, quote {len(q_idx)})")
        print(f"  excluded as undetermined: {sk}")
        print(f"detectDelimiter: {len(d_idx) - len(dfail)}/{len(d_idx)} match the writer's delimiter")
        print(f"detectQuote:     {len(q_idx) - len(qfail)}/{len(q_idx)} match the writer's quotechar")
        agree = 0
        seen = 0
        for i, m in enumerate(meta):
            if not (m["d"] or m["q"]):
                continue
            s = sniffer_says(cases[i]["text"])
            if s is None:
                continue
            seen += 1
            ok = ((not m["d"]) or s["delimiter"] == m["want_delim"]) and \
                 ((not m["q"]) or s["quotechar"] == m["want_quote"])
            agree += 1 if ok else 0
        print(f"csv.Sniffer (third opinion only): agrees on {agree}/{seen} it answered")
        for tag, fails in (("DELIM", dfail), ("QUOTE", qfail)):
            for i, got_val in fails[:5]:
                print(f"\n{tag}: got {got_val!r}, writer used delim="
                      f"{meta[i]['want_delim']!r} quote={meta[i]['want_quote']!r}")
                print(f"  text={cases[i]['text']!r}", file=sys.stderr)

    if dfail or qfail:
        print(f"detect-check: {len(dfail)} delimiter and {len(qfail)} quote "
              f"disagreements with python csv.writer (seed={args.seed})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())