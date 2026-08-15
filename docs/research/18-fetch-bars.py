import json, os, sys, time, urllib.error, urllib.parse, urllib.request

# Both paths are overridable so the ADR-0018 evidence can be reproduced on any
# machine: SAMURAI_ENV_FILE for the credentials, SAMURAI_DATA_DIR for the output.
#
# SAMURAI_DATA_DIR is the ROOT the three 18-* scripts share, not this script's
# own output directory. The layout underneath it is fixed, because
# 18-threshold-study.py reads it: bars go in <root>/bars/, news in <root>/. An
# earlier revision pointed this script at the root directly, which silently
# broke the hand-off whenever the variable was actually set.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV = os.environ.get("SAMURAI_ENV_FILE", os.path.join(REPO_ROOT, ".env.local"))
env = {}
for line in open(ENV):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

HDR = {
    "APCA-API-KEY-ID": env["ALPACA_API_KEY"],
    "APCA-API-SECRET-KEY": env["ALPACA_API_SECRET"],
}
DATA_DIR = os.environ.get("SAMURAI_DATA_DIR", os.getcwd())
OUT = os.path.join(DATA_DIR, "bars")
os.makedirs(OUT, exist_ok=True)


# A stuck or repeated page token would otherwise loop forever against a paid
# API. 10k bars per page over a decade of 1-minute bars needs a few hundred
# pages, so this bounds the run without bounding the data.
MAX_PAGES = 2000


def fetch(symbol, start, end, timeframe="5Min"):
    rows = []
    token = None
    seen_tokens = set()
    pages = 0
    base = "https://data.alpaca.markets/v2/stocks/bars"
    while True:
        q = {
            "symbols": symbol,
            "start": start,
            "end": end,
            "timeframe": timeframe,
            "limit": "10000",
            "adjustment": "all",
            "feed": "sip",
            "sort": "asc",
        }
        if token:
            q["page_token"] = token
        req = urllib.request.Request(base + "?" + urllib.parse.urlencode(q), headers=HDR)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    d = json.load(r)
                break
            except urllib.error.HTTPError as exc:
                # A 4xx is a bad key, symbol or timeframe: retrying it five
                # times over ~30s only delays the error it already reported.
                if exc.code < 500:
                    raise
                if attempt == 4:
                    raise
                sys.stderr.write("retry %s %s\n" % (symbol, exc))
                time.sleep(2 * (attempt + 1))
            except Exception as exc:
                if attempt == 4:
                    raise
                sys.stderr.write("retry %s %s\n" % (symbol, exc))
                time.sleep(2 * (attempt + 1))
        bars = (d.get("bars") or {}).get(symbol) or []
        rows.extend(bars)
        token = d.get("next_page_token")
        if not token:
            break
        if token in seen_tokens:
            raise RuntimeError("%s: next_page_token repeated (%s) - refusing to loop" % (symbol, token))
        seen_tokens.add(token)
        pages += 1
        if pages >= MAX_PAGES:
            raise RuntimeError("%s: exceeded %d pages - widen MAX_PAGES or narrow the window" % (symbol, MAX_PAGES))
    return rows


if __name__ == "__main__":
    symbol = sys.argv[1]
    start = sys.argv[2]
    end = sys.argv[3]
    tf = sys.argv[4] if len(sys.argv) > 4 else "5Min"
    rows = fetch(symbol, start, end, tf)
    path = os.path.join(OUT, "%s_%s.jsonl" % (symbol, tf))
    with open(path, "w") as fh:
        for b in rows:
            fh.write(json.dumps({"t": b["t"], "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"]}) + "\n")
    print(symbol, tf, len(rows), rows[0]["t"] if rows else "-", rows[-1]["t"] if rows else "-")
