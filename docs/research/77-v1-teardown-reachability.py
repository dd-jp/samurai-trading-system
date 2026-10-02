"""Doc 77: v1 teardown reachability from the v2 roots, by fallow and by graphify.

Run from the repo root after `npm ci` and `graphify update . --no-cluster`:

    python3 docs/research/77-v1-teardown-reachability.py OUT_DIR

OUT_DIR receives an analysis copy of HEAD (package.json scripts cut to the v2 set, .fallowrc.json
entries replaced by ROOTS), the raw fallow traces, both reachability results and reach.json.
"""
import collections
import concurrent.futures as cf
import json
import os
import re
import shutil
import subprocess
import sys

ROOTS = [
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
V2_SCRIPTS = {
    'dev:web', 'build:web', 'typecheck', 'test', 'test:coverage', 'test:local', 'test:watch', 'mutation:local',
    'crap', 'crap:report', 'e2e', 'check:citations', 'check:live-gates', 'lint:oxlint', 'lint:oxlint:fix',
    'lint:biome', 'lint:biome:fix', 'lint', 'lint:fix', 'bars:snapshot', 'saxo:login', 'saxo:keepalive',
}
TEST = re.compile(r'\.(test|spec)\.tsx?$')
NODE = shutil.which('node')


def prepare_copy(out):
    copy = os.path.join(out, 'copy')
    shutil.rmtree(copy, ignore_errors=True)
    os.makedirs(copy)
    tar = os.path.join(out, 'head.tar')
    subprocess.run(['git', 'archive', 'HEAD', '-o', tar], check=True)
    subprocess.run(['tar', '-xf', tar, '-C', copy], check=True)
    os.symlink(os.path.abspath('node_modules'), os.path.join(copy, 'node_modules'))
    pkg = json.load(open(os.path.join(copy, 'package.json')))
    scripts = {k: v for k, v in pkg['scripts'].items() if k.startswith('v2:') or k in V2_SCRIPTS}
    scripts['build'] = 'tsc -p tsconfig.build.json && npm run build:web'
    scripts['smoke'] = 'npm run build && node dist/server/apps/v2/smoke.js'
    pkg['scripts'] = scripts
    json.dump(pkg, open(os.path.join(copy, 'package.json'), 'w'), indent=2)
    rc = json.load(open(os.path.join(copy, '.fallowrc.json')))
    rc['entry'] = ROOTS
    json.dump(rc, open(os.path.join(copy, '.fallowrc.json'), 'w'), indent=2)
    return copy


def fallow(copy, *args):
    r = subprocess.run([NODE, 'node_modules/.bin/fallow', *args, '--format', 'json', '-q'],
                       cwd=copy, capture_output=True, text=True)
    return json.loads(r.stdout)


def fallow_traces(copy):
    files = [f for f in fallow(copy, 'list', '--files', '--production')['files'] if f.endswith(('.ts', '.tsx'))]
    with cf.ThreadPoolExecutor(4) as ex:
        return dict(ex.map(lambda f: (f, fallow(copy, 'dead-code', '--production', '--trace-file', f)), files))


def fallow_reach(traces):
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
    live = {r for r in ROOTS if r in traces}
    why = {r: 'root' for r in live}
    live_exports = set()
    frontier = list(live)

    def mark(g, name, src):
        while (g, name) not in live_exports:
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


def graphify_reach(graph_path):
    g = json.load(open(graph_path))
    nodes = {n['id']: n for n in g['nodes']}
    file_of = {i: n.get('source_file', '') for i, n in nodes.items()}
    out = collections.defaultdict(list)
    contained = set()
    for e in g['links']:
        out[e['source']].append(e)
        if e['relation'] == 'contains' and file_of.get(e['source']) == file_of.get(e['target']):
            contained.add(e['target'])
    file_node, by_file = {}, collections.defaultdict(set)
    for i, f in file_of.items():
        if f:
            by_file[f].add(i)
            if i not in contained:
                file_node.setdefault(f, i)
    follow = {'calls', 'references', 'implements', 'inherits', 'method', 'contains', 'indirect_call'}
    live_files, live_nodes, why, stack = set(), set(), {}, []

    def live_file(f, src):
        if f and f not in live_files and not TEST.search(f):
            live_files.add(f)
            why[f] = src
            if f in file_node:
                stack.append(('file', file_node[f], f))

    def live_node(i, src):
        if i in nodes and i not in live_nodes and not TEST.search(file_of[i] or ''):
            live_nodes.add(i)
            stack.append(('sym', i, file_of[i]))
            live_file(file_of[i], src)

    for r in ROOTS:
        live_file(r, 'root')
        for i in by_file.get(r, ()):
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
            if e['relation'] == 'imports':
                live_node(e['target'], f)
                imported.add(tf)
            elif e['relation'] == 're_exports':
                reexported.add(tf)
            elif e['relation'] == 'dynamic_import':
                live_file(tf, f + ' (dynamic)')
                for j in by_file.get(tf, ()):
                    live_node(j, f)
        for e in out[i]:
            tf = file_of.get(e['target'], '')
            if e['relation'] == 'imports_from' and tf and tf not in imported | reexported:
                barrel = any(x['relation'] == 're_exports' for x in out[e['target']])
                live_file(tf, f + (' (barrel on import path)' if barrel else ' (side-effect import)'))
    return live_files, why


def main(out):
    os.makedirs(out, exist_ok=True)
    copy = prepare_copy(out)
    traces = fallow_traces(copy)
    json.dump(traces, open(os.path.join(out, 'fallow-traces.json'), 'w'))
    f_live, f_why = fallow_reach(traces)
    g_live, g_why = graphify_reach('graphify-out/graph.json')
    prod = sorted(traces)
    f_dead = {p for p in prod if p not in f_live}
    g_dead = {p for p in prod if p not in g_live}
    result = {
        'base': subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip(),
        'production_files': len(prod),
        'both_unreachable': sorted(f_dead & g_dead),
        'fallow_only_unreachable': {p: g_why.get(p) for p in sorted(f_dead - g_dead)},
        'graphify_only_unreachable': {p: f_why.get(p) for p in sorted(g_dead - f_dead)},
        'reachable_outside_v2': {p: f_why.get(p) for p in sorted(f_live)
                                 if not p.startswith(('server/apps/v2/', 'client/', 'e2e/', 'contracts/'))},
    }
    json.dump(result, open(os.path.join(out, 'reach.json'), 'w'), indent=1)
    print(f"base {result['base']}: {len(prod)} production files; unreachable by both "
          f"{len(result['both_unreachable'])}, fallow only {len(result['fallow_only_unreachable'])}, "
          f"graphify only {len(result['graphify_only_unreachable'])}")


if __name__ == '__main__':
    main(sys.argv[1])
