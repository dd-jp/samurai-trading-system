import {
  accentColorForModule,
  badgeForStats,
  buildArchViewerData,
  buildDiagram,
  buildModuleEdges,
  buildTree,
  computeModuleLayers,
  computeModuleStats,
  computeRealModules,
  cycleModuleEdgeKeys,
  type GraphLink,
  type GraphNode,
  type ModuleEdge,
  moduleKeyForPath,
  parseImportCycles,
  parseSourceLocationLine,
  safeId,
  sliceSnippet,
} from './arch-viewer.js';

describe('moduleKeyForPath', () => {
  it('collapses server/* to two segments', () => {
    expect(moduleKeyForPath('server/pipeline/execution/types.ts')).toBe('server/pipeline');
  });

  it('collapses client/* to two segments', () => {
    expect(moduleKeyForPath('client/src/App.tsx')).toBe('client/src');
  });

  it('keeps a single top-level segment for other roots', () => {
    expect(moduleKeyForPath('contracts/pipeline.ts')).toBe('contracts');
  });

  it('falls back to the whole string when there is no separator', () => {
    expect(moduleKeyForPath('README.md')).toBe('README.md');
  });
});

describe('parseSourceLocationLine', () => {
  it('extracts the line number from an L-prefixed location', () => {
    expect(parseSourceLocationLine('L42')).toBe(42);
  });

  it('returns undefined for missing or malformed input', () => {
    expect(parseSourceLocationLine(undefined)).toBeUndefined();
    expect(parseSourceLocationLine('not-a-location')).toBeUndefined();
  });
});

describe('sliceSnippet', () => {
  const lines = ['one', 'two', 'three', 'four', 'five'];

  it('slices forward from the start line, not centered', () => {
    expect(sliceSnippet(lines, 2, 2)).toBe('two\nthree');
  });

  it('clamps to the end of the file', () => {
    expect(sliceSnippet(lines, 4, 10)).toBe('four\nfive');
  });
});

describe('parseImportCycles', () => {
  it('extracts file lists from the GRAPH_REPORT.md cycle section', () => {
    const report = [
      '## Some Other Section',
      '- not a cycle line',
      '## Import Cycles',
      '- 2-file cycle: `a/x.ts -> a/y.ts -> a/x.ts`',
      '- 3-file cycle: `b/x.ts -> b/y.ts -> b/z.ts -> b/x.ts`',
    ].join('\n');

    expect(parseImportCycles(report)).toEqual([
      ['a/x.ts', 'a/y.ts', 'a/x.ts'],
      ['b/x.ts', 'b/y.ts', 'b/z.ts', 'b/x.ts'],
    ]);
  });

  it('returns an empty array when there is no cycle section', () => {
    expect(parseImportCycles('# report\nno cycles here')).toEqual([]);
  });
});

describe('cycleModuleEdgeKeys', () => {
  it('marks consecutive module pairs in a cycle, skipping self-edges', () => {
    const keys = cycleModuleEdgeKeys([
      [
        'server/pipeline/a.ts',
        'server/pipeline/b.ts',
        'server/shared/c.ts',
        'server/pipeline/a.ts',
      ],
    ]);
    expect(keys.has('server/pipeline\u0000server/shared')).toBe(true);
    expect(keys.has('server/shared\u0000server/pipeline')).toBe(true);
    expect(keys.has('server/pipeline\u0000server/pipeline')).toBe(false);
  });
});

describe('buildModuleEdges', () => {
  const nodes: GraphNode[] = [
    { id: 'a', label: 'a', source_file: 'server/pipeline/a.ts' },
    { id: 'b', label: 'b', source_file: 'server/shared/b.ts' },
    { id: 'c', label: 'c', source_file: 'server/pipeline/c.ts' },
  ];
  const realModules = new Set(['server/pipeline', 'server/shared']);

  it('aggregates cross-module links by module pair and drops same-module links', () => {
    const links: GraphLink[] = [
      { source: 'a', target: 'b', relation: 'imports' },
      { source: 'c', target: 'b', relation: 'imports' },
      { source: 'a', target: 'c', relation: 'calls' },
    ];
    const edges = buildModuleEdges(nodes, links, new Set(), realModules);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: 'server/pipeline', to: 'server/shared', weight: 2 });
    expect(edges[0]!.relations).toEqual({ imports: 2 });
  });

  it('flags an edge as a cycle when its key is in the cycle set', () => {
    const links: GraphLink[] = [{ source: 'a', target: 'b', relation: 'imports' }];
    const edges = buildModuleEdges(
      nodes,
      links,
      new Set(['server/pipeline\u0000server/shared']),
      realModules,
    );
    expect(edges[0]!.cycle).toBe(true);
  });

  it('ignores links touching nodes with no source_file', () => {
    const linksToDangling: GraphLink[] = [{ source: 'a', target: 'ghost', relation: 'imports' }];
    expect(buildModuleEdges(nodes, linksToDangling, new Set(), realModules)).toEqual([]);
  });

  it('drops edges touching a module key that has no real, further-nested module', () => {
    const pseudoNodes: GraphNode[] = [
      { id: 'a', label: 'a', source_file: 'server/pipeline/a.ts' },
      { id: 'x', label: 'x', source_file: 'client/vite.config.ts' },
    ];
    const links: GraphLink[] = [{ source: 'a', target: 'x', relation: 'imports' }];
    const edges = buildModuleEdges(pseudoNodes, links, new Set(), new Set(['server/pipeline']));
    expect(edges).toEqual([]);
  });
});

describe('computeRealModules', () => {
  it('keeps a module key only when some file nests further under it', () => {
    const nodes: GraphNode[] = [
      { id: 'a', label: 'a', source_file: 'server/pipeline/a.ts' },
      { id: 'b', label: 'b', source_file: 'client/vite.config.ts' },
    ];
    const real = computeRealModules(nodes, ['server/pipeline', 'client/vite.config.ts']);
    expect(real.has('server/pipeline')).toBe(true);
    expect(real.has('client/vite.config.ts')).toBe(false);
  });
});

describe('buildTree', () => {
  const nodes: GraphNode[] = [
    {
      id: 'fn1',
      label: 'doThing',
      file_type: 'code',
      source_file: 'server/pipeline/a.ts',
      source_location: 'L10',
      _callable: true,
    },
    {
      id: 'fn2',
      label: 'helper',
      file_type: 'code',
      source_file: 'server/pipeline/a.ts',
      source_location: 'L1',
      _callable: true,
    },
    {
      id: 'doc1',
      label: 'notes',
      file_type: 'document',
      source_file: 'docs/notes.md',
      source_location: 'L1',
    },
  ];
  const links: GraphLink[] = [{ source: 'fn1', target: 'fn2', relation: 'calls' }];

  it('groups symbols under their file and directory, sorted by line number', () => {
    const tree = buildTree(nodes, links, () => ['line1', 'line2', 'line3']);
    const serverDir = tree.children!.find((c) => c.name === 'server')!;
    const pipelineDir = serverDir.children!.find((c) => c.name === 'pipeline')!;
    const fileNode = pipelineDir.children!.find((c) => c.name === 'a.ts')!;
    expect(fileNode.children!.map((c) => c.name)).toEqual(['helper', 'doThing']);
  });

  it('embeds a forward snippet only for code nodes with a resolvable source', () => {
    const aFileLines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`);
    const tree = buildTree(nodes, links, (file) =>
      file === 'server/pipeline/a.ts' ? aFileLines : undefined,
    );
    const symbol = findByPath(tree, 'fn1');
    expect(symbol?.snippet).toBe('line10\nline11\nline12');

    const docSymbol = findByPath(tree, 'doc1');
    expect(docSymbol?.snippet).toBeUndefined();
  });

  it('attaches outgoing/incoming relations to the right leaf', () => {
    const tree = buildTree(nodes, links, () => undefined);
    const fn1 = findByPath(tree, 'fn1');
    const fn2 = findByPath(tree, 'fn2');
    expect(fn1?.relationsOut).toEqual([{ id: 'fn2', label: 'helper', relation: 'calls' }]);
    expect(fn2?.relationsIn).toEqual([{ id: 'fn1', label: 'doThing', relation: 'calls' }]);
  });

  it('propagates total counts up to the root', () => {
    const tree = buildTree(nodes, links, () => undefined);
    expect(tree.totalCount).toBe(3);
  });
});

function findByPath(
  node: ReturnType<typeof buildTree>,
  path: string,
): ReturnType<typeof buildTree> | undefined {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findByPath(child, path);
    if (found) return found;
  }
  return undefined;
}

describe('safeId', () => {
  it('replaces every non-alphanumeric character', () => {
    expect(safeId('server/pipeline')).toBe('server-pipeline');
  });
});

describe('computeModuleStats', () => {
  it('counts distinct files, symbols and external-neighbor degree per module', () => {
    const nodes: GraphNode[] = [
      { id: 'a', label: 'a', source_file: 'server/pipeline/a.ts' },
      { id: 'b', label: 'b', source_file: 'server/pipeline/b.ts' },
      { id: 'c', label: 'c', source_file: 'server/shared/c.ts' },
    ];
    const edges: ModuleEdge[] = [
      { from: 'server/pipeline', to: 'server/shared', weight: 1, relations: {}, cycle: false },
    ];
    const stats = computeModuleStats(nodes, ['server/pipeline', 'server/shared'], edges);
    expect(stats.get('server/pipeline')).toEqual({
      fileCount: 2,
      externalDegree: 1,
      internalSymbols: 2,
    });
    expect(stats.get('server/shared')).toEqual({
      fileCount: 1,
      externalDegree: 1,
      internalSymbols: 1,
    });
  });
});

describe('badgeForStats', () => {
  it('rates high external degree or a huge symbol count as complex', () => {
    expect(badgeForStats({ fileCount: 2, externalDegree: 4, internalSymbols: 10 })).toBe('complex');
    expect(badgeForStats({ fileCount: 2, externalDegree: 0, internalSymbols: 2001 })).toBe(
      'complex',
    );
  });

  it('rates low degree and few symbols as simple', () => {
    expect(badgeForStats({ fileCount: 2, externalDegree: 1, internalSymbols: 10 })).toBe('simple');
  });

  it('falls back to moderate otherwise', () => {
    expect(badgeForStats({ fileCount: 5, externalDegree: 2, internalSymbols: 500 })).toBe(
      'moderate',
    );
  });
});

describe('computeModuleLayers', () => {
  it('layers a DAG by longest dependency chain via Kahn on non-cycle edges', () => {
    const modules = ['app', 'pipeline', 'shared'];
    const edges: ModuleEdge[] = [
      { from: 'app', to: 'pipeline', weight: 1, relations: {}, cycle: false },
      { from: 'pipeline', to: 'shared', weight: 1, relations: {}, cycle: false },
    ];
    const layers = computeModuleLayers(modules, edges);
    expect(layers.get('app')).toBe(0);
    expect(layers.get('pipeline')).toBe(1);
    expect(layers.get('shared')).toBe(2);
  });

  it('places modules stuck in a residual cycle among non-cycle-marked edges into one trailing layer', () => {
    // Not flagged `cycle: true` (that set comes from parseImportCycles, and
    // isn't guaranteed to catch every module-level cyclic pair) — this is the
    // case Kahn's algorithm itself can't resolve: in-degree never reaches 0
    const modules = ['app', 'a', 'b'];
    const edges: ModuleEdge[] = [
      { from: 'a', to: 'b', weight: 1, relations: {}, cycle: false },
      { from: 'b', to: 'a', weight: 1, relations: {}, cycle: false },
    ];
    const layers = computeModuleLayers(modules, edges);
    expect(layers.get('app')).toBe(0);
    expect(layers.get('a')).toBe(1);
    expect(layers.get('b')).toBe(1);
  });
});

describe('accentColorForModule', () => {
  it('is deterministic for the same module key', () => {
    expect(accentColorForModule('server/pipeline')).toBe(accentColorForModule('server/pipeline'));
  });

  it('returns a color from the fixed palette', () => {
    expect(accentColorForModule('server/pipeline')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('buildDiagram', () => {
  it('places every module and draws an edge with a card and a bezier path', () => {
    const modules = ['server/pipeline', 'server/shared'];
    const edges: ModuleEdge[] = [
      {
        from: 'server/pipeline',
        to: 'server/shared',
        weight: 3,
        relations: { imports: 3 },
        cycle: false,
      },
    ];
    const stats = computeModuleStats(
      [
        { id: 'a', label: 'a', source_file: 'server/pipeline/a.ts' },
        { id: 'b', label: 'b', source_file: 'server/shared/b.ts' },
      ],
      modules,
      edges,
    );
    const { diagramHtml, moduleAnchors } = buildDiagram(modules, edges, stats, {
      'server/pipeline': 'The trading pipeline.',
    });
    expect(moduleAnchors.sort()).toEqual(['server/pipeline', 'server/shared']);
    expect(diagramHtml).toContain('data-module="server/pipeline"');
    expect(diagramHtml).toContain('class="card-desc">The trading pipeline.');
    expect(diagramHtml).toContain('<title>server/pipeline -&gt; server/shared');
    // No entry for server/shared: no fabricated description line, not even an empty one
    const sharedIdx = diagramHtml.indexOf('data-module="server/shared"');
    expect(diagramHtml.slice(sharedIdx, sharedIdx + 400)).not.toContain('card-desc');
  });

  it('skips edges whose endpoint module is missing from the layout', () => {
    const stats = computeModuleStats(
      [{ id: 'a', label: 'a', source_file: 'server/pipeline/a.ts' }],
      ['server/pipeline'],
      [],
    );
    const { diagramHtml } = buildDiagram(
      ['server/pipeline'],
      [{ from: 'server/pipeline', to: 'ghost-module', weight: 1, relations: {}, cycle: false }],
      stats,
      {},
    );
    expect(diagramHtml).not.toContain('<title>');
  });
});

describe('buildArchViewerData', () => {
  it('wires the graph, report and source reader into one data object', () => {
    const graph = {
      nodes: [
        {
          id: 'a',
          label: 'a',
          file_type: 'code',
          source_file: 'server/pipeline/a.ts',
          source_location: 'L1',
          _callable: true,
        },
        {
          id: 'b',
          label: 'b',
          file_type: 'code',
          source_file: 'server/shared/b.ts',
          source_location: 'L1',
          _callable: true,
        },
      ],
      links: [{ source: 'a', target: 'b', relation: 'imports' }],
    };
    const report =
      '## Import Cycles\n- 2-file cycle: `server/pipeline/a.ts -> server/shared/b.ts -> server/pipeline/a.ts`';

    const data = buildArchViewerData(graph, report, () => ['const x = 1;']);

    expect(data.moduleEdges).toHaveLength(1);
    expect(data.moduleEdges[0]).toMatchObject({
      from: 'server/pipeline',
      to: 'server/shared',
      cycle: true,
    });
    expect(data.moduleAnchors.sort()).toEqual(['server/pipeline', 'server/shared']);
    expect(data.tree.totalCount).toBe(2);
  });
});
