import json, re, sys, time, urllib.parse, urllib.request

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

PAT = re.compile(
    r"(reports?\s+q[1-4])|(q[1-4]\s+(fy\s*)?\d{2,4}?\s*(earnings|results|eps))"
    r"|(earnings\s+(call|results|report)\b)|(\bbeats?\b.*\bestimate)|(\bmisses?\b.*\bestimate)",
    re.I,
)


def news(symbol, start, end):
    out = []
    token = None
    base = "https://data.alpaca.markets/v1beta1/news"
    while True:
        q = {"symbols": symbol, "start": start, "end": end, "limit": "50", "sort": "asc"}
        if token:
            q["page_token"] = token
        req = urllib.request.Request(base + "?" + urllib.parse.urlencode(q), headers=HDR)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.load(r)
                break
            except Exception as exc:
                if attempt == 4:
                    raise
                sys.stderr.write("retry %s\n" % exc)
                time.sleep(2 * (attempt + 1))
        for n in d.get("news") or []:
            out.append((n["created_at"], n["headline"]))
        token = d.get("next_page_token")
        if not token:
            break
        time.sleep(0.35)
        if len(out) % 2000 < 50:
            sys.stderr.write("  ...%d headlines\n" % len(out))
    return out


if __name__ == "__main__":
    sym = sys.argv[1]
    rows = news(sym, sys.argv[2], sys.argv[3])
    hits = [(t, h) for t, h in rows if PAT.search(h)]
    with open("/Users/ddjp/.claude/jobs/21207c2c/tmp/news_%s.jsonl" % sym, "w") as fh:
        for t, h in rows:
            fh.write(json.dumps({"t": t, "h": h}) + "\n")
    print(sym, "total", len(rows), "earnings-like", len(hits))
    for t, h in hits[:12]:
        print(" ", t, h[:110])
