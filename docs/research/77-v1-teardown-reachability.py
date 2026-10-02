"""Doc 77: v1 teardown reachability from the v2 roots, by fallow and by graphify.

Run from the repo root after `npm ci`, with `graphify` (pip graphifyy) on PATH:

    python3 docs/research/77-v1-teardown-reachability.py OUT_DIR

Both methods analyse the same tree: an archive of HEAD extracted to OUT_DIR/copy, with package.json
scripts cut to the v2 set and .fallowrc.json entries replaced by V2_ROOTS. graphify is rebuilt inside
that copy, so a stale or dirty working-tree graph cannot leak in. OUT_DIR/reach.json holds every list
doc 77 prints.
"""
import collections
import concurrent.futures as cf
import json
import os
import re
import shutil
import tarfile
import subprocess
import sys

V2_ROOTS = [
    'server/apps/v2/index.ts', 'server/apps/v2/set-capital.ts', 'server/apps/v2/report-entry-offsets.ts',
    'server/apps/v2/report-cost-fidelity.ts', 'server/apps/v2/replay-cli.ts', 'server/apps/v2/backup-cli.ts',
    'server/apps/v2/api/main.ts', 'server/apps/v2/api/telegram-main.ts', 'server/apps/v2/signals/main.ts',
    'server/apps/v2/trial-ledger.ts', 'server/apps/v2/backtest-cli.ts',
    'server/apps/v2/execution/sim-cfd-stop-drill-cli.ts', 'server/apps/v2/cfd-catalogue-cli.ts',
    'server/apps/v2/smoke.ts', 'server/apps/v2/api/fixture-server.ts',
    'server/tools/saxo-keepalive.ts', 'server/tools/saxo-login.ts', 'server/tools/check-live-money-gates.ts',
    'server/tools/check-path-citations.ts', 'server/tools/crap-gate.ts', 'server/tools/mutation-local.ts',
    'client/src/main.tsx', 'e2e/playwright.config.ts', 'e2e/support/port.ts', 'e2e/support/servers.ts',
    'e2e/support/test.ts', 'e2e/support/token.ts',
]
KEEP_CONFIG = ['vitest.setup.ts', 'vitest.global-setup.ts', 'client/vite.config.ts']
KEEP_TEST_SUPPORT = [
    'client/src/test-wire.ts', 'server/shared/recording-logger.ts', 'server/shared/strip-comments.ts',
    'server/pipeline/debate-engine/llm/mock-client.ts',
]
KEEP_G18 = [
    'server/providers/market-intelligence/grok/grok-agent.ts',
    'server/providers/market-intelligence/grok/nous-sentiment-client.ts',
    'server/providers/market-intelligence/grok/x-search-client.ts',
]
HOLD = {
    'Q3 CGT matcher (#1947)': [
        'server/pipeline/cgt/index.ts', 'server/pipeline/cgt/cgt-disposal-matching.ts',
        'server/pipeline/cgt/open-readonly-cgt-store.ts', 'server/pipeline/cgt/sqlite-cgt-fill-source.ts',
    ],
    'Q2 Saxo bracket adapter': ['server/pipeline/execution/adapters/saxo-adapter.ts'],
}
HOLD_CUTS = {
    ('server/pipeline/execution/adapters/saxo-adapter.ts', 'server/tools/backtest/cost-model.ts'): 'SAXO_COMMISSION_RATE',
}
WAVE_CUTS = {
    ('server/tools/backtest/types.ts', 'server/apps/orchestrator/'): 'TickOutcome',
}
KEEP_TESTS = {
    'server/pipeline/debate-engine/llm/prompt-caching.test.ts',
    'server/pipeline/execution/broker-state-persistence.test.ts',
}
HOLD_TESTS = {'server/pipeline/execution/adapters/saxo-per-request-pacing.test.ts': 'Q2 Saxo bracket adapter'}
V2_SCRIPTS = {
    'dev:web', 'build:web', 'typecheck', 'test', 'test:coverage', 'test:local', 'test:watch', 'mutation:local',
    'crap', 'crap:report', 'e2e', 'check:citations', 'check:live-gates', 'lint:oxlint', 'lint:oxlint:fix',
    'lint:biome', 'lint:biome:fix', 'lint', 'lint:fix', 'bars:snapshot', 'saxo:login', 'saxo:keepalive',
}
WAVES = [
    (1, ('server/tools/',)),
    (2, ('server/apps/orchestrator/', 'server/apps/service-api/', 'server/apps/supervisor/')),
    (3, ('server/pipeline/',)),
    (4, ('server/providers/',)),
    (5, ('server/shared/', 'contracts/')),
]
TEST = re.compile(r'\.(test|spec)\.tsx?$')
IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*|vi\.(?:mock|doMock|importActual)\(\s*|import\s+)['"](\.[^'"]+)['"]""")
URL_READ = re.compile(r"""new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url""")
BARE = re.compile(r'(?<![\w/.-])(?:dist/)?((?:server|contracts|client|e2e)/[\w./@*-]+)')
QUOTED = re.compile(r"""['"`]((?:\.{1,2}/|server/|contracts/|client/|e2e/)[\w./@*-]+)['"`]""")
SCAN_EXT = ('.ts', '.tsx', '.mjs', '.json', '.yml', '.yaml', '.plist', '.sh', '.py')
NODE = shutil.which('node')


def prepare_copy(out):
    copy = os.path.join(out, 'copy')
    shutil.rmtree(copy, ignore_errors=True)
    os.makedirs(copy)
    tar = os.path.join(out, 'head.tar')
    subprocess.run(['git', 'archive', 'HEAD', '-o', tar], check=True)
    subprocess.run(['tar', '-xf', tar, '-C', copy], check=True)
    tracked = subprocess.run(['tar', '-tf', tar], capture_output=True, text=True, check=True).stdout.split()
    os.symlink(os.path.abspath('node_modules'), os.path.join(copy, 'node_modules'))
    pkg = json.load(open(os.path.join(copy, 'package.json')))
    scripts = {k: v for k, v in pkg['scripts'].items() if k.startswith('v2:') or k in V2_SCRIPTS}
    scripts['build'] = 'tsc -p tsconfig.build.json && npm run build:web'
    scripts['smoke'] = 'npm run build && node dist/server/apps/v2/smoke.js'
    pkg['scripts'] = scripts
    json.dump(pkg, open(os.path.join(copy, 'package.json'), 'w'), indent=2)
    rc = json.load(open(os.path.join(copy, '.fallowrc.json')))
    rc['entry'] = V2_ROOTS
    json.dump(rc, open(os.path.join(copy, '.fallowrc.json'), 'w'), indent=2)
    return copy, [t for t in tracked if not t.endswith('/')]


def fallow(copy, *args):
    r = subprocess.run([NODE, 'node_modules/.bin/fallow', *args, '--format', 'json', '-q'],
                       cwd=copy, capture_output=True, text=True)
    return json.loads(r.stdout)


def fallow_traces(copy):
    files = [f for f in fallow(copy, 'list', '--files', '--production')['files'] if f.endswith(('.ts', '.tsx'))]
    with cf.ThreadPoolExecutor(4) as ex:
        return dict(ex.map(lambda f: (f, fallow(copy, 'dead-code', '--production', '--trace-file', f)), files))


def graphify_graph(copy):
    subprocess.run(['graphify', 'update', '.', '--no-cluster'], cwd=copy, check=True, capture_output=True)
    return json.load(open(os.path.join(copy, 'graphify-out', 'graph.json')))


def fallow_reach(traces, roots, cuts=()):
    refs_from = collections.defaultdict(set)
    for g, d in traces.items():
        for e in d['exports']:
            for r in e['referenced_by']:
                if r['kind'] == 'named import':
                    refs_from[r['from_file']].add((g, e['name']))
    reexp = {(b, r['exported_name']): (r['source_file'], r['imported_name'])
             for b, d in traces.items() for r in d.get('re_exports', [])}
    side_effect = collections.defaultdict(set)
    for f, d in traces.items():
        reexp_src = {r['source_file'] for r in d.get('re_exports', [])}
        used = {g for g, _ in refs_from[f]}
        side_effect[f] = {g for g in d.get('imports_from', []) if g in traces and g not in reexp_src | used}
    live = {r for r in roots if r in traces}
    why = {r: 'root' for r in live}
    live_exports = set()
    frontier = list(live)

    def mark(g, name, src):
        importer = src
        while (g, name) not in live_exports and (importer, g) not in cuts:
            live_exports.add((g, name))
            if g not in live:
                live.add(g)
                why[g] = src
                frontier.append(g)
            nxt = reexp.get((g, name))
            if not nxt:
                return
            src, (g, name) = g, nxt

    while frontier:
        f = frontier.pop()
        for g, name in refs_from[f]:
            mark(g, name, f)
        for g in side_effect[f]:
            if g not in live:
                live.add(g)
                why[g] = f + ' (side-effect import)'
                frontier.append(g)
    return live, why


class Graph:
    def __init__(self, g):
        self.nodes = {n['id']: n for n in g['nodes']}
        self.file_of = {i: n.get('source_file', '') for i, n in self.nodes.items()}
        self.out = collections.defaultdict(list)
        contained = set()
        for e in g['links']:
            self.out[e['source']].append(e)
            if e['relation'] == 'contains' and self.file_of.get(e['source']) == self.file_of.get(e['target']):
                contained.add(e['target'])
        self.file_node, self.by_file = {}, collections.defaultdict(set)
        for i, f in self.file_of.items():
            if f:
                self.by_file[f].add(i)
                if i not in contained:
                    self.file_node.setdefault(f, i)

    def symbol_imports(self, f):
        fn = self.file_node.get(f)
        return {self.file_of.get(e['target'], '') for e in self.out.get(fn, []) if e['relation'] == 'imports'} - {''}

    def reach(self, roots, cuts=()):
        follow = {'calls', 'references', 'implements', 'inherits', 'method', 'contains', 'indirect_call'}
        nodes, file_of, out = self.nodes, self.file_of, self.out
        live_files, live_nodes, why, stack = set(), set(), {}, []

        def live_file(f, src):
            if f and f not in live_files and not TEST.search(f):
                live_files.add(f)
                why[f] = src
                if f in self.file_node:
                    stack.append(('file', self.file_node[f], f))

        def live_node(i, src):
            if i in nodes and i not in live_nodes and not TEST.search(file_of[i] or ''):
                live_nodes.add(i)
                stack.append(('sym', i, file_of[i]))
                live_file(file_of[i], src)

        for r in roots:
            live_file(r, 'root')
            for i in self.by_file.get(r, ()):
                live_node(i, 'root')
        while stack:
            kind, i, f = stack.pop()
            if kind == 'sym':
                for e in out[i]:
                    if e['relation'] in follow:
                        live_node(e['target'], f)
                continue
            imported, reexported = set(), set()
            for e in out[i]:
                tf = file_of.get(e['target'], '')
                if e['relation'] == 'imports' and (f, tf) not in cuts:
                    live_node(e['target'], f)
                    imported.add(tf)
                elif e['relation'] == 'imports':
                    imported.add(tf)
                elif e['relation'] == 're_exports':
                    reexported.add(tf)
                elif e['relation'] == 'dynamic_import':
                    live_file(tf, f + ' (dynamic)')
                    for j in self.by_file.get(tf, ()):
                        live_node(j, f)
            for e in out[i]:
                tf = file_of.get(e['target'], '')
                if e['relation'] == 'imports_from' and tf and tf not in imported | reexported:
                    barrel = any(x['relation'] == 're_exports' for x in out[e['target']])
                    live_file(tf, f + (' (barrel on import path)' if barrel else ' (side-effect import)'))
        return live_files, why


def both_dead(prod, traces, graph, roots, cuts=()):
    f_live, f_why = fallow_reach(traces, roots, cuts)
    g_live, g_why = graph.reach(roots, cuts)
    f_dead = {p for p in prod if p not in f_live}
    g_dead = {p for p in prod if p not in g_live}
    return f_dead & g_dead, f_dead, g_dead, f_why, g_why


def wave_of(path):
    for w, prefixes in WAVES:
        if path.startswith(prefixes):
            return w
    return None


def resolve(frm, spec, files):
    p = os.path.normpath(os.path.join(os.path.dirname(frm), spec))
    for c in (p, re.sub(r'\.js$', '.ts', p), re.sub(r'\.js$', '.tsx', p), p + '.ts', p + '.tsx', p + '/index.ts'):
        if c in files:
            return c
    return None


def test_deps(copy, t, files, graph):
    src = open(os.path.join(copy, t), errors='ignore').read()
    direct = {r for r in (resolve(t, s, files) for s in IMPORT.findall(src)) if r}
    reads = {r for r in (resolve(t, s, files) for s in URL_READ.findall(src)) if r}
    return direct | graph.symbol_imports(t), reads


def settle_waves(copy, tracked, graph, traces, delete_prod):
    files = set(tracked)
    fallow_deps = collections.defaultdict(set)
    for g, d in traces.items():
        for e in d['exports']:
            for r in e['referenced_by']:
                fallow_deps[r['from_file']].add(g)
    wave = {f: wave_of(f) for f in delete_prod}
    deps = {}
    for f in delete_prod:
        direct, reads = test_deps(copy, f, files, graph)
        cut = [prefix for (importer, prefix) in WAVE_CUTS if importer == f]
        deps[f] = {d for d in (direct | reads | fallow_deps[f]) & set(wave) if not d.startswith(tuple(cut))}
    changed = True
    while changed:
        changed = False
        for f, ds in deps.items():
            for d in ds:
                if wave[d] < wave[f]:
                    wave[d] = wave[f]
                    changed = True
    return wave


def classify_tests(copy, tracked, graph, delete_wave, held):
    files = set(tracked)
    tests = sorted(f for f in tracked if TEST.search(f) and f.startswith(('server/', 'contracts/', 'client/', 'e2e/')))
    prod = [f for f in tracked if f.endswith(('.ts', '.tsx')) and not TEST.search(f)]
    result, review, rewrites = {}, [], {}
    for t in tests:
        deps, reads = test_deps(copy, t, files, graph)
        local = {d for d in deps if not TEST.search(d)}
        hits = (local | reads) & set(delete_wave)
        earliest = min((delete_wave[h] for h in hits), default=None)
        sib = next((s for s in (TEST.sub('.ts', t), TEST.sub('.tsx', t)) if s in files), None)
        if t in HOLD_TESTS:
            kind = 'held'
        elif t in KEEP_TESTS:
            kind = 'keep'
        elif sib is not None:
            kind = 'delete' if sib in delete_wave else 'held' if sib in held else 'keep'
        elif not local or not hits:
            kind = 'keep'
        elif local <= set(delete_wave):
            kind = 'delete'
        else:
            siblings = [p for p in prod if os.path.dirname(p) == os.path.dirname(t)]
            other = local - set(delete_wave)
            if siblings and all(p in delete_wave for p in siblings):
                kind = 'delete'
            elif all(o.startswith(('server/shared/', 'contracts/')) for o in other):
                kind = 'delete'
            else:
                kind = 'delete'
                review.append(t)
        if kind == 'delete':
            own = delete_wave.get(sib) if sib else max(delete_wave[h] for h in hits) if hits else wave_of(t)
            result[t] = ('delete', min(w for w in (own, earliest) if w is not None))
        else:
            result[t] = (kind, None)
            if hits:
                rewrites[t] = {'by_wave': earliest, 'deps': sorted(hits)}
    return result, review, rewrites


def pristine(out):
    tar = tarfile.open(os.path.join(out, 'head.tar'))
    return lambda path: tar.extractfile(path).read().decode('utf8', 'ignore')


def config_refs(read, tracked, candidates):
    cand = set(candidates)
    ts_under = collections.defaultdict(set)
    for f in tracked:
        if f.endswith(('.ts', '.tsx')):
            parts = f.split('/')
            for i in range(1, len(parts)):
                ts_under['/'.join(parts[:i])].add(f)
    hits = collections.defaultdict(set)
    for f in tracked:
        if f in cand or f.startswith('docs/') or not f.endswith(SCAN_EXT):
            continue
        pattern = QUOTED if f.endswith(('.ts', '.tsx')) else BARE
        for n, line in enumerate(read(f).splitlines(), 1):
            for s in pattern.findall(line):
                s = re.sub(r'/?\*\*.*$', '', s)
                p = os.path.normpath(os.path.join(os.path.dirname(f), s)) if s.startswith('.') else os.path.normpath(s)
                for q in (p, re.sub(r'\.js$', '.ts', p)):
                    if q in cand:
                        hits[f].add((n, q))
                    elif q in ts_under and ts_under[q] <= cand:
                        hits[f].add((n, q + '/'))
    return {f: sorted(v) for f, v in hits.items()}


def assets(read, tracked, candidates):
    cand = set(candidates)
    text = {f: read(f) for f in tracked if f.endswith(SCAN_EXT) and not f.startswith('docs/')}
    out = {}
    for a in tracked:
        if not a.startswith('server/') or a.endswith(('.ts', '.tsx')) or '/migrations/' in a:
            continue
        users = [f for f, t in text.items() if f != a and os.path.basename(a) in t]
        if any(u in cand for u in users) and all(u in cand or not u.endswith(('.ts', '.tsx')) for u in users):
            out[a] = users
    return out


def main(out):
    os.makedirs(out, exist_ok=True)
    copy, tracked = prepare_copy(out)
    traces = fallow_traces(copy)
    json.dump(traces, open(os.path.join(out, 'fallow-traces.json'), 'w'))
    graph = Graph(graphify_graph(copy))
    prod = sorted(traces)
    held_files = [f for fs in HOLD.values() for f in fs]
    keep_roots = V2_ROOTS + KEEP_CONFIG + KEEP_TEST_SUPPORT + KEEP_G18

    v2_dead, f_dead, g_dead, f_why, g_why = both_dead(prod, traces, graph, V2_ROOTS)
    keep_dead = both_dead(prod, traces, graph, keep_roots)[0]
    uncut_held = len(keep_dead - both_dead(prod, traces, graph, keep_roots + held_files)[0])
    hold_dead = both_dead(prod, traces, graph, keep_roots + held_files, HOLD_CUTS)[0]
    released_by = {}
    for name, files in HOLD.items():
        other = [f for n, fs in HOLD.items() if n != name for f in fs]
        alone = both_dead(prod, traces, graph, keep_roots + other, HOLD_CUTS)[0]
        for f in (keep_dead - hold_dead) & alone:
            released_by.setdefault(f, []).append(name)

    delete_prod = sorted(hold_dead)
    delete_wave = settle_waves(copy, tracked, graph, traces, delete_prod)
    held = {f: released_by.get(f, ['all holds']) for f in sorted(keep_dead - hold_dead)}
    tests, review, rewrites = classify_tests(copy, tracked, graph, delete_wave, held)
    for t, (kind, w) in tests.items():
        if kind == 'delete':
            delete_wave[t] = w
    candidates = sorted(delete_wave)
    lines = {f: sum(1 for _ in open(os.path.join(copy, f), errors='ignore')) for f in candidates + list(held)}
    result = {
        'base': subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip(),
        'production_files': len(prod),
        'unreachable_from_v2': {'fallow': len(f_dead), 'graphify': len(g_dead), 'both': len(v2_dead)},
        'fallow_only_unreachable': {p: g_why.get(p) for p in sorted(f_dead - g_dead)},
        'graphify_only_unreachable': {p: f_why.get(p) for p in sorted(g_dead - f_dead)},
        'kept_by_ruling_closure': sorted(v2_dead - keep_dead - set(keep_roots)),
        'held': held,
        'held_without_cuts': uncut_held,
        'hold_cuts': {f'{a} -> {b}': sym for (a, b), sym in HOLD_CUTS.items()},
        'wave_cuts': {f'{a} -> {b}': sym for (a, b), sym in WAVE_CUTS.items()},
        'waves': {w: sorted(f for f in candidates if delete_wave[f] == w) for w, _ in WAVES},
        'lines': lines,
        'tests': {k: sorted(t for t, (kind, _) in tests.items() if kind == k) for k in ('delete', 'keep', 'held')},
        'tests_reviewed_by_rule': sorted(review),
        'rewrites': rewrites,
        'config_refs': config_refs(pristine(out), tracked, candidates),
        'assets': assets(pristine(out), tracked, candidates),
        'reachable_outside_v2': {p: f_why.get(p) for p in prod if p not in f_dead
                                 and not p.startswith(('server/apps/v2/', 'client/', 'e2e/', 'contracts/'))},
    }
    json.dump(result, open(os.path.join(out, 'reach.json'), 'w'), indent=1)
    for w, fs in result['waves'].items():
        p = [f for f in fs if not TEST.search(f)]
        t = [f for f in fs if TEST.search(f)]
        print(f'wave {w}: {len(p)} prod / {sum(lines[f] for f in p)} lines, {len(t)} tests / {sum(lines[f] for f in t)} lines')
    print(f"base {result['base']}: {len(prod)} production files; unreachable from v2 roots "
          f"{result['unreachable_from_v2']}; held {len(held)}; ruled-keep closure {result['kept_by_ruling_closure']}")


if __name__ == '__main__':
    main(sys.argv[1])
