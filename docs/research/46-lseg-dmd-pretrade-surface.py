"""Reproduces doc 46's DMD LSE Pre-Trade Documents pull and analysis.

Not a test: this is investigation, run by hand, per the doc-53/58 precedent — it
makes live unauthenticated HTTP calls to dmd.lseg.com and is not wired into any
test suite or CI gate. Pulled CSVs stay outside the repo (`/tmp/dmd_cache` by
default); only the aggregates in the doc are committed.

Usage:
    python3 46-lseg-dmd-pretrade-surface.py fetch   # pull the sampling window used in the doc
    python3 46-lseg-dmd-pretrade-surface.py analyze # print coverage / spread / dispersion tables

DMD API (reverse-engineered from the Angular SPA's JS bundles, no registration,
no auth — see doc 46 for the discovery trail):
  GET  https://dmd.lseg.com/api/web/files                          -> full file listing, all markets
  GET  https://dmd.lseg.com/api/web/download?fileName=<fileKey>    -> JSON envelope with a 5-minute
                                                                       presigned S3 URL for the CSV
Each `LSE Pre-Trade Documents` file is named `XLON-pre-<date>T<HH>_<MM>.csv`, filename time is UTC
(confirmed against the CSV's own `distributionTime` column and against the measured LSE continuous-
session row-count ramp/collapse at 07:00/15:30 UTC = 08:00/16:30 London, BST).
"""
import csv
import glob
import json
import re
import statistics as st
import subprocess
import sys
import time
import urllib.parse
from collections import Counter

CACHE_DIR = "/tmp/dmd_cache"
FETCH_LOG = f"{CACHE_DIR}/fetch_log.jsonl"
FILES_LISTING = "/tmp/dmd-files.json"

# The 31-row pool (30 distinct ISINs — 3USL/3LUS share one ISIN and are
# disambiguated below by instrumentId / price scale) extracted from
# server/providers/universe-pool/lse-etp-pool.ts. The ticket's title says
# "30 pool TIDMs"; the pool has grown to 31 rows since #1032 was filed
# (#813's 2026-08-19 expansion, #1220's third SPY line) — reported as a
# premise correction in the doc, measured against 31/30 here, not the stale 30.
POOL = [
    ("3USL", "IE00B7Y34M31"), ("3LUS", "IE00B7Y34M31"), ("LQQ3", "IE00BLRPRL42"),
    ("NVD3", "XS2820604770"), ("3LNV", "XS2734938835"), ("3QQQ", "XS2472197065"),
    ("3LPA", "XS2856105833"), ("PLT3", "XS2663694680"), ("3LME", "XS2662640627"),
    ("3LNP", "XS2856106302"), ("3AMZ", "IE00BK5BZQ82"), ("3FB", "IE00BK5C1B80"),
    ("3KOR", "XS2472196257"), ("3XLE", "XS2399370555"), ("3SPY", "XS2472197149"),
    ("3LTS", "XS2656472193"), ("3AAP", "IE00BK5BZS07"), ("MST3", "XS2901882618"),
    ("LAM3", "XS3075487713"), ("3LAL", "XS2675292309"), ("LPP3", "XS2596087671"),
    ("LCO3", "XS2575914176"), ("LAA3", "XS2842095320"), ("3LMO", "XS3069877556"),
    ("3LIP", "XS3075487044"), ("3LSQ", "XS2596085972"), ("3UBR", "XS2337092550"),
    ("3RAC", "XS2595673190"), ("3ARM", "XS2691006303"), ("3VT", "XS2399364822"),
    ("3KWE", "XS2800709128"),
]
assert len(POOL) == 31
ISIN2TIKS = {}
for _tik, _isin in POOL:
    ISIN2TIKS.setdefault(_isin, []).append(_tik)

# Sampling window used in the doc: two available trading dates (2026-09-11,
# 2026-09-14 — retention observed at pull time), 15-min cadence 04:00-16:30
# UTC (covers pre-market through post-close), densified to 5-min inside the
# open (07:00-07:59) and close (15:00-15:29) buckets to reduce per-instrument
# noise. The very first continuous-trading file (T07:00) is excluded from the
# "open" bucket as an opening-auction print, matching doc 53's exclusion of
# the analogous US opening-bell artifact.
DATES = ("2026-09-11", "2026-09-14")
COARSE_MINUTES = [(h, m) for h in range(4, 17) for m in (0, 15, 30, 45) if not (h == 16 and m > 30)]
OPEN_DENSE_MINUTES = [5, 10, 20, 25, 35, 40, 50, 55]
CLOSE_DENSE_MINUTES = [5, 10, 20, 25]


def _find_url(o):
    if isinstance(o, str) and o.startswith("http"):
        return o
    if isinstance(o, dict):
        for v in o.values():
            u = _find_url(v)
            if u:
                return u
    if isinstance(o, list):
        for v in o:
            u = _find_url(v)
            if u:
                return u
    return None


def fetch(file_key, dest_name):
    import os
    os.makedirs(CACHE_DIR, exist_ok=True)
    dest = f"{CACHE_DIR}/{dest_name}"
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    api_url = "https://dmd.lseg.com/api/web/download?fileName=" + file_key
    req_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    r = subprocess.run(["curl", "-s", api_url], capture_output=True, text=True, timeout=30)
    env = json.loads(r.stdout)
    s3url = _find_url(env)
    if not s3url:
        raise RuntimeError(f"no presigned URL in envelope for {file_key}: {r.stdout[:300]}")
    fetch_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    subprocess.run(["curl", "-s", "-o", dest, s3url], timeout=30)
    with open(FETCH_LOG, "a") as f:
        f.write(json.dumps({
            "fileKey": file_key, "api_url": api_url,
            "s3url_host": s3url.split("?")[0],
            "req_ts": req_ts, "fetch_ts": fetch_ts,
        }) + "\n")
    return dest


def cmd_fetch():
    subprocess.run(["curl", "-s", "https://dmd.lseg.com/api/web/files", "-o", FILES_LISTING], check=True)
    d = json.load(open(FILES_LISTING))
    lse = d["result"]["initialPayloadResponse"]["fileDetails"]["LSE Pre-Trade Documents"]
    by_date = {}
    for x in lse:
        by_date.setdefault(x["fileDate"], {})[x["fileName"]] = x["fileKey"]

    targets = []
    for date in DATES:
        for h, m in COARSE_MINUTES:
            targets.append((date, h, m))
        for m in OPEN_DENSE_MINUTES:
            targets.append((date, 7, m))
        for m in CLOSE_DENSE_MINUTES:
            targets.append((date, 15, m))

    got = 0
    for date, h, m in targets:
        fn = f"XLON-pre-{date}T{h:02d}_{m:02d}.csv"
        idx = by_date.get(date, {})
        if fn not in idx:
            print("ABSENT", fn)
            continue
        fetch(idx[fn], dest_name=fn)
        got += 1
        time.sleep(0.3)  # sequential, no load generator — 8GB box, live soak running
    print(f"fetched {got} files into {CACHE_DIR}")


def bucket_of(fn):
    m = re.search(r"T(\d\d)_(\d\d)\.csv", fn)
    hh, mm = int(m.group(1)), int(m.group(2))
    mins = hh * 60 + mm
    if mins < 7 * 60:
        return "pre-market"
    if mins == 7 * 60:
        return "opening-auction-excluded"
    if mins < 8 * 60:
        return "open"
    if mins < 15 * 60:
        return "midday"
    if mins <= 15 * 60 + 30:
        return "close"
    return "post-close"


def round_trip_bps(bid, offer):
    mid = (bid + offer) / 2.0
    return (offer - bid) / mid * 1e4 if mid > 0 else None


def half_spread_bps(bid, offer):
    rt = round_trip_bps(bid, offer)
    return rt / 2.0 if rt is not None else None


def load_observations():
    files = sorted(glob.glob(f"{CACHE_DIR}/XLON-pre-*.csv"))
    obs = {tik: [] for tik, _ in POOL}
    orderbooktypes, sourcevenues = set(), set()
    ems_nonzero, ems_total, yield_nonzero = 0, 0, 0
    for path in files:
        fn = path.split("/")[-1]
        b = bucket_of(fn)
        with open(path, newline="") as f:
            for row in csv.DictReader(f, delimiter=";"):
                isin = row["instrumentIdentificationCode"]
                if isin not in ISIN2TIKS:
                    continue
                try:
                    bid = float(row["bidLimitPrice"])
                    off = float(row["offerLimitPrice"])
                except ValueError:
                    continue
                ems_total += 1
                bms, oms = float(row["bidMarketSize"] or 0), float(row["offerMarketSize"] or 0)
                if bms or oms:
                    ems_nonzero += 1
                by_, oy_ = float(row["bidYield"] or 0), float(row["offerYield"] or 0)
                if by_ or oy_:
                    yield_nonzero += 1
                orderbooktypes.add(row["orderBookType"])
                sourcevenues.add(row["sourceVenue"])
                tiks = ISIN2TIKS[isin]
                tik = tiks[0] if len(tiks) == 1 else ("3USL" if bid > 1000 else "3LUS")
                obs[tik].append(dict(bucket=b, file=fn, bid=bid, offer=off,
                                      instrumentId=row["instrumentId"]))
    return obs, files, dict(orderbooktypes=orderbooktypes, sourcevenues=sourcevenues,
                             ems_nonzero=ems_nonzero, ems_total=ems_total, yield_nonzero=yield_nonzero)


def cmd_analyze():
    obs, files, meta = load_observations()
    in_session = sum(1 for f in files if bucket_of(f.split("/")[-1])
                      not in ("pre-market", "post-close"))
    print(f"files sampled: {len(files)} ({in_session} in the 07:00-15:30 UTC continuous-session "
          f"window; the rest are pre-market/post-close, structurally near-empty)")
    print(f"orderBookType values seen: {meta['orderbooktypes']}")
    print(f"sourceVenue values seen: {meta['sourcevenues']}")
    print(f"EMS (bidMarketSize/offerMarketSize) nonzero: {meta['ems_nonzero']}/{meta['ems_total']} "
          f"({100*meta['ems_nonzero']/meta['ems_total']:.2f}%)")
    print(f"bidYield/offerYield nonzero: {meta['yield_nonzero']}/{meta['ems_total']}")
    print()

    print("=== coverage (union across all sampled files) ===")
    covered = 0
    for tik, _ in POOL:
        n = len(obs[tik])
        two = sum(1 for o in obs[tik] if o["bid"] > 0 and o["offer"] > 0)
        files_present = len(set(o["file"] for o in obs[tik]))
        if n:
            covered += 1
        print(f"{tik:6s} rows={n:5d} two-sided={two:5d} files_present={files_present}/{len(files)}")
    print(f"covered: {covered}/{len(POOL)} rows ({len(set(i for t,i in POOL if obs[t]))}/"
          f"{len(set(i for _,i in POOL))} distinct ISINs)")
    print()

    print("=== per-instrument round-trip / half-spread, open vs midday vs close bucket (median, bps) ===")
    BUCKETS = ["open", "midday", "close"]
    per_tik = {tik: {b: [] for b in BUCKETS} for tik, _ in POOL}
    for tik, _ in POOL:
        for o in obs[tik]:
            if o["bucket"] not in BUCKETS or o["bid"] <= 0 or o["offer"] <= 0:
                continue
            rt = round_trip_bps(o["bid"], o["offer"])
            if rt and rt > 0:
                per_tik[tik][o["bucket"]].append(rt)
    ratios = []
    for tik, _ in POOL:
        d = per_tik[tik]
        meds = {b: (st.median(d[b]) if d[b] else None) for b in BUCKETS}
        if meds["open"] and meds["close"]:
            ratios.append((tik, meds["open"] / meds["close"]))
        o, mid, c = meds["open"], meds["midday"], meds["close"]
        print(f"{tik:6s} open_rt={f'{o:.1f}' if o else '-':>7s} open_hs={f'{o/2:.1f}' if o else '-':>7s} "
              f"mid_rt={f'{mid:.1f}' if mid else '-':>7s} mid_hs={f'{mid/2:.1f}' if mid else '-':>7s} "
              f"close_rt={f'{c:.1f}' if c else '-':>7s} close_hs={f'{c/2:.1f}' if c else '-':>7s} "
              f"n_open={len(d['open']):4d} n_mid={len(d['midday']):4d} n_close={len(d['close']):4d}")
    print()
    if ratios:
        rs = [r for _, r in ratios]
        print(f"open/close ratio: n={len(rs)} median={st.median(rs):.2f}x min={min(rs):.2f}x max={max(rs):.2f}x")
        print(f"widen into close (>1x): {sum(1 for r in rs if r > 1)}/{len(rs)}")
        print("narrow into close (<1x):", [tik for tik, r in ratios if r < 1])

    print()
    print("=== cross-sectional half-spread dispersion (restates #875, permissibly collected) ===")
    for label, bset in [("open bucket only (matches #875's pre-open capture)", {"open"}),
                         ("full session (open+midday+close)", {"open", "midday", "close"})]:
        meds = {}
        for tik, _ in POOL:
            vals = [half_spread_bps(o["bid"], o["offer"]) for o in obs[tik]
                    if o["bucket"] in bset and o["bid"] > 0 and o["offer"] > 0]
            vals = [v for v in vals if v and v > 0]
            if vals:
                meds[tik] = st.median(vals)
        vals = sorted(meds.values())
        med = st.median(vals)
        ordered = sorted(meds.items(), key=lambda kv: -kv[1])
        print(f"--- {label} --- n_instruments={len(vals)}")
        print(f"  median-of-medians={med:.2f}bps  max/median={max(vals)/med:.2f}x  "
              f"min/median: max/min={max(vals)/min(vals):.2f}x  "
              f"p90/median={st.quantiles(vals, n=100)[89]/med:.2f}x")
        print(f"  widest 5 (half-spread bps): {ordered[:5]}")
        print(f"  tightest 5 (half-spread bps): {ordered[-5:]}")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("fetch", "analyze"):
        print(__doc__)
        sys.exit(1)
    {"fetch": cmd_fetch, "analyze": cmd_analyze}[sys.argv[1]]()
