#!/usr/bin/env python3
"""Extract Table I (expected loss rates + D-ratios) and Table II (primary
thresholds) from the California Experience Rating Plan PDF, using the PDF's
own text layer (pdftotext -layout). Writes JSON + CSV and validates shape.

Usage: extract_tables.py <plan.pdf> <outdir>
"""
import csv
import json
import re
import subprocess
import sys
from collections import OrderedDict

pdf, outdir = sys.argv[1], sys.argv[2]


def page_text(n):
    return subprocess.run(
        ["pdftotext", "-layout", "-f", str(n), "-l", str(n), pdf, "-"],
        capture_output=True, text=True, check=True,
    ).stdout


def num(tok):
    return int(tok.replace(",", ""))


# ---------- locate Table I / Table II pages ----------
first_t1 = last_t1 = t2_page = None
for p in range(1, 91):
    t = page_text(p)
    if "Table I – Expected Loss Rates and D-Ratios" in t:
        first_t1 = first_t1 or p
        last_t1 = p
    if "Table II - Primary Thresholds" in t:
        t2_page = p
assert first_t1 and last_t1 and t2_page, (first_t1, last_t1, t2_page)

# ---------- Table I ----------
elr = OrderedDict()      # class -> ELR (Decimal-safe string)
dratio = {}              # class -> {threshold:int -> "0.xxx"}
all_thresholds = []      # ordered, de-duplicated
pages_seen = 0
per_unit = set()        # classes whose ELR is per capita/race/etc (not per $100 payroll)

for p in range(first_t1, last_t1 + 1):
    lines = page_text(p).splitlines()
    header = None
    has_elr = False
    for ln in lines:
        toks = ln.split()
        if toks and toks[0] == "Code":
            rest = [t for t in toks[1:] if t != "Rate"]
            if rest and all(re.fullmatch(r"\d{1,2},\d{3}", t) for t in rest):
                header = [num(t) for t in rest]
                has_elr = "Rate" in toks
            continue
        if header and re.fullmatch(r"\d{4}", toks[0] if toks else ""):
            cls = toks[0]
            vals = [t for t in toks[1:] if t != "*"]
            if "*" in toks[1:3]:
                per_unit.add(cls)
            if has_elr:
                elr[cls] = vals[0]
                vals = vals[1:]
            assert len(vals) == len(header), (p, cls, len(vals), len(header))
            for th, v in zip(header, vals):
                dratio.setdefault(cls, {})[th] = v
    if header:
        pages_seen += 1
        for th in header:
            if th not in all_thresholds:
                all_thresholds.append(th)

# ---------- validate Table I ----------
classes = list(elr.keys())
assert len(classes) == len(set(classes)), "duplicate class codes"
missing = [c for c in classes if len(dratio[c]) != len(all_thresholds)]
assert not missing, f"classes with incomplete D-ratio rows: {missing[:5]}"
assert all_thresholds == sorted(all_thresholds), "thresholds out of order"
for c in classes:
    row = [float(dratio[c][t]) for t in all_thresholds]
    assert row == sorted(row), f"D-ratio not monotonic for class {c}"
    assert 0 < float(elr[c]) < (5000 if c in per_unit else 50), (c, elr[c])

# ---------- Table II ----------
bands = []
mlv = adv = None
for ln in page_text(t2_page).splitlines():
    m = re.search(r"Maximum Loss Value \$([\d,]+)", ln)
    if m:
        mlv = num(m.group(1))
    m = re.search(r"Average Death Value \$([\d,]+)", ln)
    if m:
        adv = num(m.group(1))
    # each physical line holds a left and a right half
    for m in re.finditer(
        r"(Below|[\d,]+)\s+-\s+([\d,]+|& Over)\s+([\d,]+)", ln
    ):
        lo = 0 if m.group(1) == "Below" else num(m.group(1))
        hi = None if m.group(2) == "& Over" else num(m.group(2))
        bands.append({"min_expected": lo, "max_expected": hi, "primary_threshold": num(m.group(3))})
bands.sort(key=lambda b: b["primary_threshold"])

# validate Table II
assert mlv and adv, (mlv, adv)
th2 = [b["primary_threshold"] for b in bands]
assert set(th2) == set(all_thresholds), (
    "Table II thresholds != Table I columns",
    sorted(set(th2) ^ set(all_thresholds)),
)
for a, b in zip(bands, bands[1:]):
    assert b["min_expected"] == a["max_expected"] + 1, ("gap/overlap", a, b)
assert bands[-1]["max_expected"] is None and bands[0]["min_expected"] == 0

# ---------- write ----------
meta = {
    "source": "California Workers' Compensation Experience Rating Plan—1995",
    "effective": "2025-09-01",
    "eligibility_threshold": 10800,
    "maximum_loss_value": mlv,
    "average_death_value": adv,
    "note": "Parsed from the PDF text layer; see tools/extract_tables.py",
}
with open(f"{outdir}/table1_elr_dratios.json", "w") as f:
    json.dump(
        {
            "meta": meta,
            "thresholds": all_thresholds,
            "classes": {c: {"elr": elr[c], "per_unit_basis": c in per_unit, "d_ratios": [dratio[c][t] for t in all_thresholds]} for c in classes},
        },
        f, indent=1,
    )
with open(f"{outdir}/table2_primary_thresholds.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["min_expected", "max_expected", "primary_threshold"])
    for b in bands:
        w.writerow([b["min_expected"], "" if b["max_expected"] is None else b["max_expected"], b["primary_threshold"]])
with open(f"{outdir}/plan_constants.json", "w") as f:
    json.dump(meta, f, indent=1)

print(f"Table I pages {first_t1}-{last_t1} ({pages_seen} pages with data)")
print("per-unit classes:", sorted(per_unit))
print(f"classes: {len(classes)}  thresholds/class: {len(all_thresholds)} ({all_thresholds[0]}..{all_thresholds[-1]})")
print(f"Table II page {t2_page}: {len(bands)} bands; MLV={mlv} ADV={adv}")
print("OK: all validations passed")
