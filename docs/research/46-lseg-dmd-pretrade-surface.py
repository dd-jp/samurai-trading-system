"""Reproduces doc 46's DMD LSE Pre-Trade Documents pull and analysis.

Not a test: this is investigation, run by hand, per the doc-53/58 precedent — it
makes live unauthenticated HTTP calls to dmd.lseg.com and is not wired into any
test suite or CI gate. Pulled CSVs stay outside the repo (`/tmp/dmd_cache` by
default); only the aggregates in the doc are committed.

Usage:
    python3 46-lseg-dmd-pretrade-surface.py fetch   # pull the sampling window used in the doc
    python3 46-lseg-dmd-pretrade-surface.py si      # pull the latest file from each SI participant
    python3 46-lseg-dmd-pretrade-surface.py analyze # print coverage / spread / dispersion tables,
                                                     # including the intermediate evidence behind
                                                     # the doc's EMS/granularity/session-boundary/
                                                     # MST3-SI claims (not just the final aggregates)

DMD API (reverse-engineered from the Angular SPA's JS bundles, no registration,
no auth — see doc 46 for the discovery trail):
  GET  https://dmd.lseg.com/api/web/files                          -> full file listing, all markets
  GET  https://dmd.lseg.com/api/web/download?fileName=<fileKey>    -> JSON envelope with a 5-minute
                                                                       presigned S3 URL for the CSV
  GET  https://dmd.lseg.com/api/web/si/files                       -> full SI file listing, one key
                                                                       per participant (NMTRIAIR,
                                                                       NMOPVOF, BARCIE2DSEC)
  GET  https://dmd.lseg.com/api/web/si/download?fileName=<fileKey> -> JSON envelope, presigned URL at
                                                                       result.preSignedUrl directly
                                                                       (not nested, unlike /download)
Each `LSE Pre-Trade Documents` file is named `XLON-pre-<date>T<HH>_<MM>.csv`, filename time is UTC
(confirmed against the CSV's own `distributionTime` column and against the measured LSE continuous-
session row-count ramp/collapse at 07:00/15:30 UTC = 08:00/16:30 London, BST). SI files use a
different schema (`Isin` not `instrumentIdentificationCode`, no `distributionTime`/bid-offer pair —
each row is one order-side print) since they carry systematic-internaliser quotes, not a lit order
book.
"""
import csv
import glob
import json
import os
import re
import statistics as st
import subprocess
import sys
import time
import urllib.parse
from collections import defaultdict

CACHE_DIR = "/tmp/dmd_cache"
FETCH_LOG = f"{CACHE_DIR}/fetch_log.jsonl"
FILES_LISTING = "/tmp/dmd-files.json"

SI_CACHE_DIR = f"{CACHE_DIR}/si"
SI_FETCH_LOG = f"{SI_CACHE_DIR}/fetch_log.jsonl"
SI_FILES_LISTING = "/tmp/dmd-si-files.json"
SI_PARTICIPANTS = ("NMTRIAIR", "NMOPVOF", "BARCIE2DSEC")

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

# 3USL/3LUS share ISIN IE00B7Y34M31 (a GBX-pence line and a USD line on the same
# underlying). DMD itself distinguishes them via a numeric `instrumentId` on every
# row (confirmed stable: exactly 2 distinct instrumentId values seen for this ISIN
# across the full 108-file/2-date sample, see /tmp/instrumentid_scan.py in the PR
# discussion). The assignment below classifies each instrumentId ONCE, from the
# median two-sided price across every row carrying it — not per row — so a single
# auction print or an intraday move cannot flip an already-classified line. The tik
# named here is whichever one this ISIN's HIGHER-median-price instrumentId maps to.
SHARED_ISIN_HIGHER_PRICE_TIK = {"IE00B7Y34M31": "3USL"}

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


def fetch(file_key, dest_name, endpoint="download", cache_dir=CACHE_DIR, fetch_log=FETCH_LOG):
    os.makedirs(cache_dir, exist_ok=True)
    dest = f"{cache_dir}/{dest_name}"
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    api_url = f"https://dmd.lseg.com/api/web/{endpoint}?fileName=" + file_key
    req_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # -f: curl itself fails (nonzero exit) on an HTTP error response instead of
    # writing the error body and exiting 0 — without it a 403/404 envelope would
    # get silently logged as a success below.
    r = subprocess.run(["curl", "-sf", api_url], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(
            f"envelope fetch failed (curl exit {r.returncode}) for {file_key}: {r.stderr[:300]}")
    env = json.loads(r.stdout)
    s3url = _find_url(env)
    if not s3url:
        raise RuntimeError(f"no presigned URL in envelope for {file_key}: {r.stdout[:300]}")
    fetch_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    dl = subprocess.run(["curl", "-sf", "-o", dest, s3url], timeout=30)
    if dl.returncode != 0:
        raise RuntimeError(f"CSV download failed (curl exit {dl.returncode}) for {file_key}")
    with open(fetch_log, "a") as f:
        f.write(json.dumps({
            "fileKey": file_key, "api_url": api_url,
            "s3url_host": s3url.split("?")[0],
            "req_ts": req_ts, "fetch_ts": fetch_ts,
        }) + "\n")
    return dest


def cmd_fetch():
    subprocess.run(["curl", "-sf", "https://dmd.lseg.com/api/web/files", "-o", FILES_LISTING], check=True)
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


def cmd_si():
    """Pulls the latest file from each of the 3 SI (systematic-internaliser)
    participant feeds and checks each for MST3's ISIN — the residual check
    behind doc 46's Q1 negative result for MST3. Reproducible and logged
    (SI_FETCH_LOG), unlike the original ad hoc pull this reproduces."""
    subprocess.run(["curl", "-sf", "https://dmd.lseg.com/api/web/si/files", "-o", SI_FILES_LISTING],
                    check=True)
    d = json.load(open(SI_FILES_LISTING))
    fd = d["result"]["initialPayloadResponse"]["fileDetails"]
    mst3_isins = {isin for tik, isin in POOL if tik == "MST3"}
    results = {}
    for participant in SI_PARTICIPANTS:
        rows = fd.get(participant, [])
        if not rows:
            print(f"{participant}: no files listed")
            results[participant] = None
            continue
        latest = sorted(rows, key=lambda r: (r["fileDate"], r["fileName"]))[-1]
        dest = fetch(latest["fileKey"], dest_name=f"{participant}-{latest['fileName']}",
                      endpoint="si/download", cache_dir=SI_CACHE_DIR, fetch_log=SI_FETCH_LOG)
        found = False
        with open(dest, newline="") as f:
            for row in csv.DictReader(f, delimiter=";"):
                if row.get("Isin") in mst3_isins:
                    found = True
                    break
        results[participant] = dict(file=latest["fileName"], mst3_present=found)
        print(f"{participant}: {latest['fileName']} -> MST3 present: {found}")
    return results


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


def _classify_shared_isin_instrument_ids(files):
    """Pass 1: for every ISIN that maps to >1 tik, group two-sided rows by
    instrumentId and classify each instrumentId ONCE from its median price —
    not per row. Returns {(isin, instrumentId): tik}. Raises if an ISIN doesn't
    resolve to exactly as many distinct instrumentIds as it has tiks — that
    would mean DMD's own disambiguation broke down and the fallback price
    heuristic (kept below, for this failure mode only) would be misleading to
    apply silently."""
    shared_isins = {isin for isin, tiks in ISIN2TIKS.items() if len(tiks) > 1}
    if not shared_isins:
        return {}
    prices_by_key = defaultdict(list)
    for path in files:
        with open(path, newline="") as f:
            for row in csv.DictReader(f, delimiter=";"):
                isin = row["instrumentIdentificationCode"]
                if isin not in shared_isins:
                    continue
                try:
                    bid, off = float(row["bidLimitPrice"]), float(row["offerLimitPrice"])
                except ValueError:
                    continue
                if bid > 0 and off > 0:
                    prices_by_key[(isin, row["instrumentId"])].append(bid)

    instid_to_tik = {}
    for isin in shared_isins:
        tiks = ISIN2TIKS[isin]
        keys = [k for k in prices_by_key if k[0] == isin]
        if len(keys) != len(tiks):
            raise RuntimeError(
                f"{isin} has {len(tiks)} pool tiks ({tiks}) but {len(keys)} distinct "
                f"instrumentId values with two-sided quotes in the sample — cannot "
                f"classify by instrumentId; re-check the pool or widen the sample.")
        ranked = sorted(keys, key=lambda k: -st.median(prices_by_key[k]))
        higher_tik = SHARED_ISIN_HIGHER_PRICE_TIK.get(isin)
        if higher_tik not in tiks:
            raise RuntimeError(f"SHARED_ISIN_HIGHER_PRICE_TIK has no entry for {isin} in {tiks}")
        remaining = [t for t in tiks if t != higher_tik]
        instid_to_tik[ranked[0]] = higher_tik
        for key, tik in zip(ranked[1:], remaining):
            instid_to_tik[key] = tik
    return instid_to_tik


def load_observations():
    files = sorted(glob.glob(f"{CACHE_DIR}/XLON-pre-*.csv"))
    obs = {tik: [] for tik, _ in POOL}
    orderbooktypes, sourcevenues = set(), set()
    ems_nonzero, ems_total, yield_nonzero = 0, 0, 0
    instid_to_tik = _classify_shared_isin_instrument_ids(files)
    unclassified_fallback, price_scale_anomalies = 0, 0
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
                instid = row["instrumentId"]
                if len(tiks) == 1:
                    tik = tiks[0]
                else:
                    key = (isin, instid)
                    if key in instid_to_tik:
                        tik = instid_to_tik[key]
                    else:
                        # An instrumentId this ISIN never carried a two-sided quote
                        # under (pass 1 only sees two-sided rows) — e.g. a zero/zero
                        # post-close row. Not two-sided, so it never reaches the
                        # per-instrument statistics tables either way; fall back to
                        # the price-scale heuristic only to keep coverage counts
                        # sane, and count it so it's visible in `analyze` output.
                        unclassified_fallback += 1
                        higher_tik = SHARED_ISIN_HIGHER_PRICE_TIK[isin]
                        remaining = [t for t in tiks if t != higher_tik][0]
                        tik = higher_tik if bid > 1000 else remaining
                    # Sanity check, independent of assignment: does this row's own
                    # price scale still match the ~1000 GBX-pence-vs-USD boundary
                    # for the tik it was assigned? A stable mismatch across many
                    # rows would mean the instrumentId->tik classification itself
                    # went wrong, not just one noisy print.
                    if bid > 0 and off > 0:
                        higher_tik = SHARED_ISIN_HIGHER_PRICE_TIK[isin]
                        expect_high = tik == higher_tik
                        if expect_high != (bid > 1000):
                            price_scale_anomalies += 1
                obs[tik].append(dict(bucket=b, file=fn, bid=bid, offer=off, instrumentId=instid))
    return obs, files, dict(
        orderbooktypes=orderbooktypes, sourcevenues=sourcevenues,
        ems_nonzero=ems_nonzero, ems_total=ems_total, yield_nonzero=yield_nonzero,
        unclassified_fallback=unclassified_fallback, price_scale_anomalies=price_scale_anomalies,
    )


def _ems_minute_breakdown(files):
    """Intermediate evidence behind the doc's EMS-fires-only-at-auctions claim
    (Q2): which distributionTime minute each EMS-nonzero row actually falls in,
    not just the final 119-row count."""
    minutes = defaultdict(int)
    total_nonzero = 0
    for path in files:
        with open(path, newline="") as f:
            for row in csv.DictReader(f, delimiter=";"):
                if row["instrumentIdentificationCode"] not in ISIN2TIKS:
                    continue
                bms = float(row["bidMarketSize"] or 0)
                oms = float(row["offerMarketSize"] or 0)
                if bms or oms:
                    total_nonzero += 1
                    minutes[row["distributionTime"][:16]] += 1
    return dict(sorted(minutes.items())), total_nonzero


def _granularity_evidence(files, isin="IE00B7Y34M31", target_substr="2026-09-14T11_00"):
    """Intermediate evidence behind the doc's headline Q3 finding (event stream,
    not snapshot): the raw distributionTime list for one ISIN in one file."""
    target = next((p for p in files if target_substr in p), None)
    if not target:
        return None
    rows = []
    with open(target, newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            if row["instrumentIdentificationCode"] == isin:
                rows.append((row["instrumentId"], row["distributionTime"]))
    return target.split("/")[-1], rows


def _session_boundary_counts(files):
    """Intermediate evidence behind the doc's Method claim that total/two-sided
    row counts step at T07:00 and collapse at T15:45 (the basis for the session
    bucket boundaries) — the raw per-file row counts around both edges."""
    boundary_minutes = {"06_45", "07_00", "07_15", "15_15", "15_30", "15_45", "16_00"}
    out = []
    for path in files:
        fn = path.split("/")[-1]
        m = re.search(r"T(\d\d_\d\d)\.csv", fn)
        if not m or m.group(1) not in boundary_minutes:
            continue
        with open(path, newline="") as f:
            n = sum(1 for _ in f) - 1  # minus header
        out.append((fn, n))
    return sorted(out)


def _si_results():
    """Intermediate evidence behind the doc's MST3-absent-from-SI negative
    result (Q1): which SI files were actually checked and what each contained,
    not just the final "absent from all 3" summary. Returns None if `si` was
    never run — the SI cache is separate from the lit-book cache pulled by
    `fetch`."""
    files = sorted(glob.glob(f"{SI_CACHE_DIR}/*.csv"))
    if not files:
        return None
    mst3_isins = {isin for tik, isin in POOL if tik == "MST3"}
    out = []
    for path in files:
        found = False
        with open(path, newline="") as f:
            for row in csv.DictReader(f, delimiter=";"):
                if row.get("Isin") in mst3_isins:
                    found = True
                    break
        out.append((path.split("/")[-1], found))
    return out


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
    print(f"3USL/3LUS instrumentId classification: {meta['unclassified_fallback']} rows fell back "
          f"to the price-scale heuristic (no two-sided quote seen for their instrumentId in pass 1); "
          f"{meta['price_scale_anomalies']} two-sided rows had a price scale that disagreed with "
          f"their instrumentId-based assignment (0 expected if the classification is sound)")
    print()

    print("=== intermediate evidence (not just final aggregates — re-verifiable without a live "
          "DMD window) ===")
    ems_minutes, ems_total_check = _ems_minute_breakdown(files)
    print(f"EMS-nonzero rows by distributionTime minute ({ems_total_check} total, "
          f"should equal {meta['ems_nonzero']} above):")
    for minute, n in ems_minutes.items():
        print(f"  {minute}  {n}")

    gran = _granularity_evidence(files)
    if gran:
        fn, rows = gran
        print(f"granularity evidence — {fn}, ISIN IE00B7Y34M31 (3USL/3LUS pair): {len(rows)} rows")
        for instid, dt in rows:
            print(f"  instrumentId={instid}  distributionTime={dt}")
    else:
        print("granularity evidence — target file not in cache, run `fetch` first")

    print("session-boundary row counts (basis for the open=07:00 / close=15:30 bucket edges):")
    for fn, n in _session_boundary_counts(files):
        print(f"  {fn}  rows={n}")

    si = _si_results()
    if si is None:
        print("MST3 SI check — no SI files cached; run `python3 46-lseg-dmd-pretrade-surface.py si`")
    else:
        print("MST3 SI check (one file per participant, from `si`):")
        for fn, found in si:
            print(f"  {fn}  MST3 present={found}")
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
              f"max/min={max(vals)/min(vals):.2f}x  "
              f"p90/median={st.quantiles(vals, n=100)[89]/med:.2f}x")
        print(f"  widest 5 (half-spread bps): {ordered[:5]}")
        print(f"  tightest 5 (half-spread bps): {ordered[-5:]}")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("fetch", "si", "analyze"):
        print(__doc__)
        sys.exit(1)
    {"fetch": cmd_fetch, "si": cmd_si, "analyze": cmd_analyze}[sys.argv[1]]()
