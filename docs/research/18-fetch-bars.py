import json, os, sys, time, urllib.parse, urllib.request

ENV = "/Users/ddjp/Documents/projects/samurai-trading-system/.env.local"
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
OUT = "/Users/ddjp/.claude/jobs/21207c2c/tmp/bars"
os.makedirs(OUT, exist_ok=True)


def fetch(symbol, start, end, timeframe="5Min"):
    rows = []
    token = None
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
