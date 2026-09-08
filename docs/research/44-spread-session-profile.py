"""Intraday spread profile for the LSE ETN listing (doc 44 section 2.5a).

#1310's gate threshold was chosen from a single 07:35Z sample. A flat-by-close
strategy pays the spread at entry and again at exit, so the question is whether
the gate survives a whole session rather than just the open. It does not: the
2026-09-08 run put the universe median at 84.1 bp at 13:42Z and 35.2 bp ninety
minutes later. Rerun across several sessions before any figure here is treated
as a time-of-day rule.

Reads SAXO_OPENAPI_TOKEN from .env.local at the repo root; never prints it.
Writes one JSON record per sample to stdout and to $SPREAD_PROFILE_OUT.

    SAMPLES=6 INTERVAL_S=5400 python3 docs/research/44-spread-session-profile.py
"""
import datetime
import json
import os
import pathlib
import re
import statistics
import time
import urllib.parse
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[2]
BASE = os.environ.get('SAXO_GATEWAY', 'https://gateway.saxobank.com/sim/openapi/')
SAMPLES = int(os.environ.get('SAMPLES', '6'))
INTERVAL_S = int(os.environ.get('INTERVAL_S', '5400'))
OUT = pathlib.Path(os.environ.get('SPREAD_PROFILE_OUT', REPO / 'spread_profile.jsonl'))


def _env_file():
    # Worktrees under .claude/worktrees/ do not carry .env.local, so walk up to
    # the main checkout rather than assuming REPO holds it.
    override = os.environ.get('SAXO_ENV_FILE')
    if override:
        return pathlib.Path(override)
    for d in (REPO, *REPO.parents):
        if (d / '.env.local').exists():
            return d / '.env.local'
    raise SystemExit('.env.local not found; set SAXO_ENV_FILE')


token = re.search(
    r'^SAXO_OPENAPI_TOKEN=(.+)$', _env_file().read_text(), re.M
).group(1).strip()
HEADERS = {'Authorization': 'Bearer ' + token}


def get(path, query=None):
    url = BASE + path + ('?' + urllib.parse.urlencode(query) if query else '')
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS)))


def sample(uics):
    d = get('trade/v1/infoprices/list',
            {'Uics': ','.join(map(str, uics)), 'AssetType': 'Etn',
             'FieldGroups': 'Quote,PriceInfoDetails,InstrumentPriceDetails,DisplayAndFormat'})
    rows = []
    for r in d.get('Data', []):
        quote = r.get('Quote') or {}
        details = r.get('InstrumentPriceDetails') or {}
        bid, ask = quote.get('Bid'), quote.get('Ask')
        if not all(isinstance(x, (int, float)) and x > 0 for x in (bid, ask)) or ask < bid:
            continue
        rows.append({
            'sp': 1e4 * (ask - bid) / ((ask + bid) / 2),
            'rv': details.get('RelativeVolume'),
            'open': details.get('IsMarketOpen'),
            'sym': (r.get('DisplayAndFormat') or {}).get('Symbol'),
        })

    spreads = sorted(x['sp'] for x in rows)
    # RelativeVolume's definition is undocumented and looks cumulative, so the
    # mover COUNT drifts up through a session even when nothing is moving.
    # Only the median columns below are safe to compare across samples.
    movers = [x for x in rows if isinstance(x['rv'], (int, float)) and x['rv'] >= 1.5]
    return {
        'n': len(rows),
        'open': sorted({str(x['open']) for x in rows}),
        'median': round(statistics.median(spreads), 1) if spreads else None,
        'p25': round(spreads[len(spreads) // 4], 1) if spreads else None,
        'p75': round(spreads[3 * len(spreads) // 4], 1) if spreads else None,
        'movers': len(movers),
        'movers_median': round(statistics.median([x['sp'] for x in movers]), 1) if movers else None,
        'movers_le_30bp': sum(1 for x in movers if x['sp'] <= 30),
    }


uics = [r['Identifier'] for r in
        get('ref/v1/instruments',
            {'AssetTypes': 'Etn', 'ExchangeId': 'LSE_ETF', '$top': 300}).get('Data', [])
        if r.get('Identifier')]

for i in range(SAMPLES):
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%SZ')
    try:
        record = {'t': now, **sample(uics)}
    except Exception as exc:
        record = {'t': now, 'error': str(exc)[:120]}
    print(json.dumps(record), flush=True)
    with OUT.open('a') as f:
        f.write(json.dumps(record) + '\n')
    if i < SAMPLES - 1:
        time.sleep(INTERVAL_S)
