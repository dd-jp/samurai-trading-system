import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

# Overridable so the ADR-0018 evidence reproduces off this machine:
# SAMURAI_ENV_FILE for the credentials, SAMURAI_DATA_DIR for the output root
# shared with 18-fetch-bars.py and 18-threshold-study.py (news lands directly in
# the root; bars go in <root>/bars/).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV = os.environ.get("SAMURAI_ENV_FILE", os.path.join(REPO_ROOT, ".env.local"))
OUT = os.environ.get("SAMURAI_DATA_DIR", os.getcwd())
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

# APPROXIMATE, and only for the printed preview below. The study does NOT use
# this: 18-threshold-study.py re-derives earnings dates with a stricter
# name-anchored matcher (company name prefix + quarter token + EPS), which is
# what produced ADR-0018's 46 reaction days. The two counts will not reconcile,
# and this one is the looser of the pair.
PAT = re.compile(
    r"(reports?\s+q[1-4])|(q[1-4]\s+(fy\s*)?\d{2,4}\s*(earnings|results|eps))"
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
            except urllib.error.HTTPError as exc:
                # Client errors (401 bad key, 400 bad params) are permanent;
                # retrying them just delays the message.
                if exc.code < 500:
                    raise
                if attempt == 4:
                    raise
                sys.stderr.write("retry %s\n" % exc)
                time.sleep(2 * (attempt + 1))
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
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "news_%s.jsonl" % sym), "w") as fh:
        for t, h in rows:
            fh.write(json.dumps({"t": t, "h": h}) + "\n")
    print(sym, "total", len(rows), "earnings-like (approx, preview only)", len(hits))
    for t, h in hits[:12]:
        print(" ", t, h[:110])
