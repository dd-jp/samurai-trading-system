/**
 * Architecture viewer — `npm run arch:viewer`.
 *
 * Reads `graphify-out/graph.json` (and its `GRAPH_REPORT.md` import-cycle
 * list) and emits a standalone drill-down diagram: a module-level
 * dependency diagram as the root view, expanding into dir -> file -> symbol,
 * with a code snippet and import/call relations on every symbol leaf.
 *
 * Deliberately a *consumer* of graphify's output, not a patch to the
 * globally-shared `graphifyy` pip tool (used across every project, not
 * vendored here) and not a Rail v3 tab (client/ is the live-trading
 * dashboard, not a dev-tooling surface).
 *
 * Two static files, no server: `ARCH_VIEWER.html` (rendering shell) +
 * `arch-viewer-data.js`, a `<script src>`-loaded `const ARCH_DATA = {...}`
 * rather than a `fetch()`-loaded one, since `fetch()` of a local file is
 * blocked under `file://`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GraphNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  _callable?: boolean;
  _callable_class?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
  relation: string;
  weight?: number;
}

export interface GraphJson {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface RelationRef {
  id: string;
  label: string;
  relation: string;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symbol';
  totalCount: number;
  children?: TreeNode[];
  sourceFile?: string;
  sourceLocation?: string | undefined;
  fileType?: string | undefined;
  callable?: boolean | undefined;
  klass?: boolean | undefined;
  snippet?: string | undefined;
  relationsOut?: RelationRef[] | undefined;
  relationsIn?: RelationRef[] | undefined;
}

export interface ModuleEdge {
  from: string;
  to: string;
  weight: number;
  relations: Record<string, number>;
  cycle: boolean;
}

const MODULE_PARENTS = new Set(['server', 'client']);
const MAX_CHILDREN_PER_FILE = 200;
const MAX_RELATIONS_PER_NODE = 12;
const SNIPPET_LINES = 10;

export function moduleKeyForPath(sourceFile: string): string {
  const segments = sourceFile.split('/').filter(Boolean);
  const first = segments[0];
  if (first === undefined) return sourceFile;
  if (MODULE_PARENTS.has(first) && segments.length > 1) {
    return `${first}/${segments[1]}`;
  }
  return first;
}

export function parseSourceLocationLine(sourceLocation: string | undefined): number | undefined {
  if (!sourceLocation) return undefined;
  const match = /^L(\d+)/.exec(sourceLocation);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function sliceSnippet(lines: string[], startLine: number, count: number): string {
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.min(lines.length, startIdx + count);
  return lines.slice(startIdx, endIdx).join('\n');
}

export function parseImportCycles(reportText: string): string[][] {
  const section = reportText.split('## Import Cycles')[1];
  if (!section) return [];
  const cycles: string[][] = [];
  for (const line of section.split('\n')) {
    const match = /cycle:\s*`([^`]+)`/.exec(line);
    if (!match?.[1]) continue;
    cycles.push(match[1].split('->').map((part) => part.trim()));
  }
  return cycles;
}

export function cycleModuleEdgeKeys(cycles: string[][]): Set<string> {
  const keys = new Set<string>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.length - 1; i++) {
      const from = moduleKeyForPath(cycle[i]!);
      const to = moduleKeyForPath(cycle[i + 1]!);
      if (from !== to) keys.add(`${from}\u0000${to}`);
    }
  }
  return keys;
}

// A two-segment path under server/client is only a real module if some file
// nests further under it — otherwise it's a loose file (client/vite.config.ts)
// wearing a module's path shape, same trap as the root-level loose-file case
export function computeRealModules(nodes: GraphNode[], candidates: string[]): Set<string> {
  const sourceFiles = nodes.map((n) => n.source_file).filter((f): f is string => f !== undefined);
  const real = new Set<string>();
  for (const mod of candidates) {
    const prefix = `${mod}/`;
    if (sourceFiles.some((f) => f.startsWith(prefix))) real.add(mod);
  }
  return real;
}

// Root-level loose files (README.md, package.json, ...) aren't modules — only directories are
function resolveModulePair(
  srcFile: string | undefined,
  tgtFile: string | undefined,
  realModules: Set<string>,
): [string, string] | undefined {
  if (!srcFile?.includes('/') || !tgtFile?.includes('/')) return undefined;
  const from = moduleKeyForPath(srcFile);
  const to = moduleKeyForPath(tgtFile);
  if (from === to || !realModules.has(from) || !realModules.has(to)) return undefined;
  return [from, to];
}

export function buildModuleEdges(
  nodes: GraphNode[],
  links: GraphLink[],
  cycleKeys: Set<string>,
  realModules: Set<string>,
): ModuleEdge[] {
  const fileById = new Map<string, string>();
  for (const node of nodes) {
    if (node.source_file) fileById.set(node.id, node.source_file);
  }

  const agg = new Map<string, ModuleEdge>();
  for (const link of links) {
    const pair = resolveModulePair(
      fileById.get(link.source),
      fileById.get(link.target),
      realModules,
    );
    if (!pair) continue;
    const [from, to] = pair;

    const key = `${from}\u0000${to}`;
    const edge = agg.get(key) ?? { from, to, weight: 0, relations: {}, cycle: cycleKeys.has(key) };
    edge.weight += link.weight ?? 1;
    edge.relations[link.relation] = (edge.relations[link.relation] ?? 0) + 1;
    agg.set(key, edge);
  }

  return [...agg.values()].sort((a, b) => b.weight - a.weight);
}

function pushCapped(
  map: Map<string, RelationRef[]>,
  key: string,
  value: RelationRef,
  cap: number,
): void {
  const arr = map.get(key) ?? [];
  if (arr.length < cap) arr.push(value);
  map.set(key, arr);
}

interface RelationMaps {
  outgoing: Map<string, RelationRef[]>;
  incoming: Map<string, RelationRef[]>;
}

function buildRelationMaps(nodes: GraphNode[], links: GraphLink[]): RelationMaps {
  const labelById = new Map(nodes.map((n) => [n.id, n.label] as const));
  const outgoing = new Map<string, RelationRef[]>();
  const incoming = new Map<string, RelationRef[]>();
  for (const link of links) {
    pushCapped(
      outgoing,
      link.source,
      {
        id: link.target,
        label: labelById.get(link.target) ?? link.target,
        relation: link.relation,
      },
      MAX_RELATIONS_PER_NODE,
    );
    pushCapped(
      incoming,
      link.target,
      {
        id: link.source,
        label: labelById.get(link.source) ?? link.source,
        relation: link.relation,
      },
      MAX_RELATIONS_PER_NODE,
    );
  }
  return { outgoing, incoming };
}

function buildSymbolLeaf(
  node: GraphNode,
  sourceFile: string,
  relations: RelationMaps,
  readSourceLines: (sourceFile: string) => string[] | undefined,
): TreeNode {
  const line = parseSourceLocationLine(node.source_location);
  let snippet: string | undefined;
  if (node.file_type === 'code' && line !== undefined) {
    const sourceLines = readSourceLines(sourceFile);
    if (sourceLines) snippet = sliceSnippet(sourceLines, line, SNIPPET_LINES);
  }
  return {
    name: node.label,
    path: node.id,
    kind: 'symbol',
    totalCount: 1,
    sourceFile,
    sourceLocation: node.source_location,
    fileType: node.file_type,
    callable: node._callable,
    klass: node._callable_class,
    snippet,
    relationsOut: relations.outgoing.get(node.id),
    relationsIn: relations.incoming.get(node.id),
  };
}

function buildFileNode(
  sourceFile: string,
  symbolNodes: GraphNode[],
  relations: RelationMaps,
  readSourceLines: (sourceFile: string) => string[] | undefined,
): TreeNode {
  const dirPath = sourceFile.includes('/') ? sourceFile.slice(0, sourceFile.lastIndexOf('/')) : '';
  const fileName = sourceFile.slice(dirPath.length ? dirPath.length + 1 : 0);
  const fileNode: TreeNode = {
    name: fileName,
    path: sourceFile,
    kind: 'file',
    totalCount: 0,
    children: [],
  };

  const sorted = [...symbolNodes].sort(
    (a, b) =>
      (parseSourceLocationLine(a.source_location) ?? 0) -
      (parseSourceLocationLine(b.source_location) ?? 0),
  );
  const capped = sorted.slice(0, MAX_CHILDREN_PER_FILE);
  for (const node of capped) {
    fileNode.children?.push(buildSymbolLeaf(node, sourceFile, relations, readSourceLines));
  }
  if (sorted.length > capped.length) {
    fileNode.children?.push({
      name: `(+${sorted.length - capped.length} more)`,
      path: `${sourceFile}#more`,
      kind: 'symbol',
      totalCount: sorted.length - capped.length,
    });
  }
  fileNode.totalCount = symbolNodes.length;
  return fileNode;
}

export function buildTree(
  nodes: GraphNode[],
  links: GraphLink[],
  readSourceLines: (sourceFile: string) => string[] | undefined,
): TreeNode {
  const byFile = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (!node.source_file) continue;
    const arr = byFile.get(node.source_file) ?? [];
    arr.push(node);
    byFile.set(node.source_file, arr);
  }

  const relations = buildRelationMaps(nodes, links);

  const root: TreeNode = { name: '/', path: '', kind: 'dir', totalCount: 0, children: [] };
  const dirIndex = new Map<string, TreeNode>([['', root]]);

  function ensureDir(dirPath: string): TreeNode {
    const existing = dirIndex.get(dirPath);
    if (existing) return existing;
    const parentPath = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
    const parent = ensureDir(parentPath);
    const name = dirPath.slice(parentPath.length ? parentPath.length + 1 : 0);
    const node: TreeNode = { name, path: dirPath, kind: 'dir', totalCount: 0, children: [] };
    dirIndex.set(dirPath, node);
    parent.children?.push(node);
    return node;
  }

  for (const [sourceFile, symbolNodes] of [...byFile.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const dirPath = sourceFile.includes('/')
      ? sourceFile.slice(0, sourceFile.lastIndexOf('/'))
      : '';
    const dir = ensureDir(dirPath);
    dir.children?.push(buildFileNode(sourceFile, symbolNodes, relations, readSourceLines));
  }

  function totalOf(node: TreeNode): number {
    if (node.kind !== 'dir') return node.totalCount;
    const sum = (node.children ?? []).reduce((acc, child) => acc + totalOf(child), 0);
    node.totalCount = sum;
    return sum;
  }
  totalOf(root);

  return root;
}

export function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export interface ModuleStats {
  fileCount: number;
  externalDegree: number;
  internalSymbols: number;
}

export function computeModuleStats(
  nodes: GraphNode[],
  modules: string[],
  edges: ModuleEdge[],
): Map<string, ModuleStats> {
  const fileSets = new Map<string, Set<string>>();
  const symbolCounts = new Map<string, number>();
  for (const mod of modules) {
    fileSets.set(mod, new Set());
    symbolCounts.set(mod, 0);
  }
  for (const node of nodes) {
    if (!node.source_file?.includes('/')) continue;
    const mod = moduleKeyForPath(node.source_file);
    const files = fileSets.get(mod);
    if (!files) continue;
    files.add(node.source_file);
    symbolCounts.set(mod, (symbolCounts.get(mod) ?? 0) + 1);
  }

  const neighbors = new Map<string, Set<string>>();
  for (const mod of modules) neighbors.set(mod, new Set());
  for (const edge of edges) {
    neighbors.get(edge.from)?.add(edge.to);
    neighbors.get(edge.to)?.add(edge.from);
  }

  const stats = new Map<string, ModuleStats>();
  for (const mod of modules) {
    stats.set(mod, {
      fileCount: fileSets.get(mod)?.size ?? 0,
      externalDegree: neighbors.get(mod)?.size ?? 0,
      internalSymbols: symbolCounts.get(mod) ?? 0,
    });
  }
  return stats;
}

export type ComplexityBadge = 'simple' | 'moderate' | 'complex';

// Heuristic, not a claimed match to any other tool's methodology — bucketed on
// external fan-out/fan-in (distinct neighbor modules) and internal symbol count
export function badgeForStats(stats: ModuleStats): ComplexityBadge {
  if (stats.externalDegree >= 4 || stats.internalSymbols > 2000) return 'complex';
  if (stats.externalDegree <= 1 && stats.internalSymbols < 50) return 'simple';
  return 'moderate';
}

// Kahn's algorithm over non-cycle edges only — a module graph legitimately
// contains cycles (rendered red), so longest-path layering has no well-defined
// answer on the full edge set. A module never reached this way (every edge
// touching it is part of a cycle) lands together in one trailing layer
export function computeModuleLayers(modules: string[], edges: ModuleEdge[]): Map<string, number> {
  const nonCycleEdges = edges.filter((e) => !e.cycle);
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const mod of modules) {
    adjacency.set(mod, []);
    inDegree.set(mod, 0);
  }
  for (const edge of nonCycleEdges) {
    if (!adjacency.has(edge.from) || !inDegree.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const remaining = new Map(inDegree);
  const layer = new Map<string, number>();
  const visited = new Set<string>();
  let frontier = modules
    .filter((m) => (inDegree.get(m) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  let layerIndex = 0;
  while (frontier.length > 0) {
    for (const mod of frontier) {
      layer.set(mod, layerIndex);
      visited.add(mod);
    }
    const next = new Set<string>();
    for (const mod of frontier) {
      for (const to of adjacency.get(mod) ?? []) {
        if (visited.has(to)) continue;
        const d = (remaining.get(to) ?? 0) - 1;
        remaining.set(to, d);
        if (d <= 0) next.add(to);
      }
    }
    frontier = [...next].sort((a, b) => a.localeCompare(b));
    layerIndex++;
  }

  const unlayered = modules.filter((m) => !visited.has(m)).sort((a, b) => a.localeCompare(b));
  if (unlayered.length > 0) {
    for (const mod of unlayered) layer.set(mod, layerIndex);
  }
  return layer;
}

const ACCENT_PALETTE = [
  '#e0736b',
  '#e0a561',
  '#dfd06a',
  '#8fce7a',
  '#6fc2b4',
  '#6ba7db',
  '#a894e8',
  '#e08cc9',
];

export function accentColorForModule(mod: string): string {
  let hash = 0;
  for (let i = 0; i < mod.length; i++) hash = (hash * 31 + mod.charCodeAt(i)) >>> 0;
  return ACCENT_PALETTE[hash % ACCENT_PALETTE.length]!;
}

const CARD_W = 240;
const CARD_H = 136;
const GAP_X = 40;
const GAP_Y = 64;
const MARGIN = 40;

interface CardAnchor {
  x: number;
  y: number;
}

function bezierPoint(p0: CardAnchor, p1: CardAnchor, p2: CardAnchor, p3: CardAnchor): CardAnchor {
  return {
    x: 0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x,
    y: 0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y,
  };
}

// Fixed card geometry (never post-render DOM measurement) keeps this a pure,
// unit-tested function rather than pushing anchor math into client-side JS
function edgeAnchors(
  from: CardAnchor,
  to: CardAnchor,
): { start: CardAnchor; end: CardAnchor; c1: CardAnchor; c2: CardAnchor } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    const start =
      dy >= 0 ? { x: from.x, y: from.y + CARD_H / 2 } : { x: from.x, y: from.y - CARD_H / 2 };
    const end = dy >= 0 ? { x: to.x, y: to.y - CARD_H / 2 } : { x: to.x, y: to.y + CARD_H / 2 };
    const midY = (start.y + end.y) / 2;
    return { start, end, c1: { x: start.x, y: midY }, c2: { x: end.x, y: midY } };
  }
  const start =
    dx >= 0 ? { x: from.x + CARD_W / 2, y: from.y } : { x: from.x - CARD_W / 2, y: from.y };
  const end = dx >= 0 ? { x: to.x - CARD_W / 2, y: to.y } : { x: to.x + CARD_W / 2, y: to.y };
  const midX = (start.x + end.x) / 2;
  return { start, end, c1: { x: midX, y: start.y }, c2: { x: midX, y: end.y } };
}

interface DiagramLayout {
  diagramHtml: string;
  moduleAnchors: string[];
}

interface LayoutResult {
  centers: Map<string, CardAnchor>;
  width: number;
  height: number;
}

function layoutModules(modules: string[], edges: ModuleEdge[]): LayoutResult {
  const layerOf = computeModuleLayers(modules, edges);
  const byLayer = new Map<number, string[]>();
  for (const mod of modules) {
    const l = layerOf.get(mod) ?? 0;
    const arr = byLayer.get(l) ?? [];
    arr.push(mod);
    byLayer.set(l, arr);
  }
  const layerGroups = [...byLayer.entries()].sort(([a], [b]) => a - b);
  for (const [, arr] of layerGroups) arr.sort((a, b) => a.localeCompare(b));

  const maxCols = Math.max(1, ...layerGroups.map(([, arr]) => arr.length));
  const width = MARGIN * 2 + maxCols * CARD_W + (maxCols - 1) * GAP_X;
  const height =
    MARGIN * 2 + layerGroups.length * CARD_H + Math.max(0, layerGroups.length - 1) * GAP_Y;

  const centers = new Map<string, CardAnchor>();
  layerGroups.forEach(([, rowModules], rowIdx) => {
    const rowWidth = rowModules.length * CARD_W + (rowModules.length - 1) * GAP_X;
    const rowStartX = MARGIN + (width - MARGIN * 2 - rowWidth) / 2;
    rowModules.forEach((mod, colIdx) => {
      centers.set(mod, {
        x: rowStartX + colIdx * (CARD_W + GAP_X) + CARD_W / 2,
        y: MARGIN + rowIdx * (CARD_H + GAP_Y) + CARD_H / 2,
      });
    });
  });

  return { centers, width, height };
}

function renderEdge(edge: ModuleEdge, from: CardAnchor, to: CardAnchor): string {
  const { start, end, c1, c2 } = edgeAnchors(from, to);
  const strokeWidth = Math.min(6, Math.max(1, Math.round(Math.log2(edge.weight + 1))));
  const color = edge.cycle ? '#e0736b' : '#4fa3c8';
  const mid = bezierPoint(start, c1, c2, end);
  const relations = Object.entries(edge.relations)
    .map(([rel, count]) => `${rel}×${count}`)
    .join(', ');
  return (
    `<path d="M${start.x.toFixed(1)},${start.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}" ` +
    `fill="none" stroke="${color}" stroke-width="${strokeWidth}" marker-end="url(#arrow)" opacity="0.75">` +
    `<title>${escapeXml(edge.from)} -&gt; ${escapeXml(edge.to)} (weight ${edge.weight}${edge.cycle ? ', in an import cycle' : ''}): ${escapeXml(relations)}</title>` +
    `</path>` +
    `<text x="${mid.x.toFixed(1)}" y="${mid.y.toFixed(1)}" text-anchor="middle" class="edge-weight">${edge.weight}</text>`
  );
}

function renderCard(
  mod: string,
  center: CardAnchor,
  stats: ModuleStats,
  description: string | undefined,
): string {
  const anchorId = `tree-mod-${safeId(mod)}`;
  const badge = badgeForStats(stats);
  const accent = accentColorForModule(mod);
  const x0 = center.x - CARD_W / 2;
  const y0 = center.y - CARD_H / 2;
  return (
    `<div class="module-card" data-target="${anchorId}" data-module="${escapeXml(mod)}" ` +
    `style="left:${x0.toFixed(1)}px;top:${y0.toFixed(1)}px;width:${CARD_W}px;height:${CARD_H}px;--accent:${accent}">` +
    `<div class="card-title">${escapeXml(mod)}</div>` +
    (description ? `<div class="card-desc">${escapeXml(description)}</div>` : '') +
    `<div class="card-footer"><span class="file-count">${stats.fileCount} file${stats.fileCount === 1 ? '' : 's'}</span>` +
    `<span class="badge badge-${badge}">${badge}</span></div>` +
    `</div>`
  );
}

export function buildDiagram(
  modules: string[],
  edges: ModuleEdge[],
  stats: Map<string, ModuleStats>,
  descriptions: Record<string, string>,
): DiagramLayout {
  const { centers, width, height } = layoutModules(modules, edges);

  const edgeMarkup: string[] = [];
  for (const edge of edges) {
    const from = centers.get(edge.from);
    const to = centers.get(edge.to);
    if (!from || !to) continue;
    edgeMarkup.push(renderEdge(edge, from, to));
  }

  const cards: string[] = [];
  const moduleAnchors: string[] = [];
  const emptyStats: ModuleStats = { fileCount: 0, externalDegree: 0, internalSymbols: 0 };
  for (const mod of modules) {
    const c = centers.get(mod);
    if (!c) continue;
    moduleAnchors.push(mod);
    cards.push(renderCard(mod, c, stats.get(mod) ?? emptyStats, descriptions[mod]));
  }

  const svg =
    `<svg class="edges" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">` +
    `<path d="M0,0 L0,6 L9,3 z" fill="#4fa3c8"></path></marker></defs>` +
    `${edgeMarkup.join('')}</svg>`;

  const diagramHtml =
    `<div class="diagram-canvas" style="position:relative;width:${width}px;height:${height}px;">` +
    `${svg}${cards.join('')}</div>`;

  return { diagramHtml, moduleAnchors };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export interface ModuleDescriptionEntry {
  description: string;
  fileCountAtGeneration: number;
}

export interface ArchViewerData {
  builtAtCommit?: string;
  generatedAt: string;
  moduleEdges: ModuleEdge[];
  diagramHtml: string;
  moduleAnchors: string[];
  tree: TreeNode;
}

export function buildArchViewerData(
  graph: GraphJson,
  reportText: string,
  readSourceLines: (sourceFile: string) => string[] | undefined,
  descriptions: Record<string, ModuleDescriptionEntry> = {},
): ArchViewerData {
  const cycles = parseImportCycles(reportText);
  const cycleKeys = cycleModuleEdgeKeys(cycles);
  const candidates = [
    ...new Set(
      graph.nodes
        .filter((n) => n.source_file?.includes('/'))
        .map((n) => moduleKeyForPath(n.source_file!)),
    ),
  ];
  const realModules = computeRealModules(graph.nodes, candidates);
  const modules = candidates.filter((m) => realModules.has(m));
  const moduleEdges = buildModuleEdges(graph.nodes, graph.links, cycleKeys, realModules);
  const stats = computeModuleStats(graph.nodes, modules, moduleEdges);
  const descByModule: Record<string, string> = {};
  for (const mod of modules) {
    const entry = descriptions[mod];
    if (entry) descByModule[mod] = entry.description;
  }
  const { diagramHtml, moduleAnchors } = buildDiagram(modules, moduleEdges, stats, descByModule);
  const tree = buildTree(graph.nodes, graph.links, readSourceLines);

  return {
    generatedAt: new Date().toISOString(),
    moduleEdges,
    diagramHtml,
    moduleAnchors,
    tree,
  };
}

const HTML_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Samurai — Architecture Viewer</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #12161c; color: #d8dee6; display: flex; height: 100vh; }
  #main { flex: 1; overflow: auto; padding: 16px; }
  #panel { width: 420px; border-left: 1px solid #2a323d; padding: 16px; overflow: auto; background: #161b22; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b96a5; margin: 20px 0 8px; }
  #diagram { margin-bottom: 24px; overflow: auto; }
  .diagram-canvas { position: relative; }
  .edges { position: absolute; top: 0; left: 0; pointer-events: none; }
  .edge-weight { fill: #8a95a4; font-size: 10px; }
  .module-card { position: absolute; box-sizing: border-box; background: #1c2530; border: 1px solid #2a323d; border-left: 4px solid var(--accent, #4fa3c8); border-radius: 8px; padding: 10px 12px; cursor: pointer; overflow: hidden; }
  .module-card:hover { border-color: #4fa3c8; }
  .card-title { font-family: Georgia, ui-serif, serif; font-size: 14px; color: #d8dee6; margin: 0 0 6px; }
  .card-desc { font-size: 11px; line-height: 1.4; color: #8a95a4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 0 0 8px; }
  .card-footer { display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: #8a95a4; }
  .badge { padding: 2px 7px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.03em; font-size: 9px; }
  .badge-simple { background: #1e3a2a; color: #8fce7a; }
  .badge-moderate { background: #3a331e; color: #dfd06a; }
  .badge-complex { background: #3a1e1e; color: #e0736b; }
  details { margin-left: 14px; }
  summary { cursor: pointer; padding: 2px 0; }
  summary:hover { color: #4fa3c8; }
  .count { color: #6b7684; font-size: 11px; }
  .symbol { margin-left: 14px; padding: 1px 4px; cursor: pointer; border-radius: 3px; }
  .symbol:hover { background: #1c2530; color: #4fa3c8; }
  pre { background: #0d1117; padding: 10px; border-radius: 6px; overflow: auto; font-size: 12px; white-space: pre; }
  .relation { font-size: 12px; margin: 2px 0; }
  .relation .rel { color: #6b7684; }
  #empty { color: #6b7684; }
</style>
</head>
<body>
<div id="main">
  <h1>Samurai — Architecture Viewer</h1>
  <h2>Module dependency diagram</h2>
  <div id="diagram"></div>
  <h2>Drill down</h2>
  <div id="tree"></div>
</div>
<div id="panel"><div id="empty">Click a symbol to see its code and relations.</div></div>
<script src="arch-viewer-data.js"></script>
<script>
function safeId(value) { return value.replace(/[^a-zA-Z0-9_-]/g, '-'); }

function renderPanel(node) {
  const panel = document.getElementById('panel');
  if (node.kind !== 'symbol' || !node.sourceFile) {
    panel.innerHTML = '<div id="empty">Click a symbol to see its code and relations.</div>';
    return;
  }
  const parts = [];
  parts.push('<h2>' + escapeHtml(node.name) + '</h2>');
  parts.push('<div class="count">' + escapeHtml(node.sourceFile) + (node.sourceLocation ? ':' + escapeHtml(node.sourceLocation) : '') + '</div>');
  if (node.snippet) {
    parts.push('<h2>Source</h2><pre>' + escapeHtml(node.snippet) + '</pre>');
  }
  if (node.relationsOut && node.relationsOut.length) {
    parts.push('<h2>Depends on</h2>');
    for (const r of node.relationsOut) {
      parts.push('<div class="relation"><span class="rel">' + escapeHtml(r.relation) + '</span> ' + escapeHtml(r.label) + '</div>');
    }
  }
  if (node.relationsIn && node.relationsIn.length) {
    parts.push('<h2>Used by</h2>');
    for (const r of node.relationsIn) {
      parts.push('<div class="relation"><span class="rel">' + escapeHtml(r.relation) + '</span> ' + escapeHtml(r.label) + '</div>');
    }
  }
  panel.innerHTML = parts.join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function buildTreeDom(node, anchorSet) {
  if (node.kind === 'symbol') {
    const el = document.createElement('div');
    el.className = 'symbol';
    el.textContent = node.name;
    el.addEventListener('click', function () { renderPanel(node); });
    return el;
  }
  const details = document.createElement('details');
  if (anchorSet.has(node.path)) details.id = 'tree-mod-' + safeId(node.path);
  const summary = document.createElement('summary');
  summary.textContent = node.name + ' ' ;
  const countSpan = document.createElement('span');
  countSpan.className = 'count';
  countSpan.textContent = '(' + node.totalCount + ')';
  summary.appendChild(countSpan);
  details.appendChild(summary);
  for (const child of node.children || []) {
    details.appendChild(buildTreeDom(child, anchorSet));
  }
  return details;
}

document.getElementById('diagram').innerHTML = ARCH_DATA.diagramHtml;
document.getElementById('diagram').addEventListener('click', function (e) {
  const el = e.target.closest('[data-target]');
  if (!el) return;
  const target = document.getElementById(el.dataset.target);
  if (!target) return;
  for (let node = target; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS') node.open = true;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

const anchorSet = new Set(ARCH_DATA.moduleAnchors);
document.getElementById('tree').appendChild(buildTreeDom(ARCH_DATA.tree, anchorSet));
</script>
</body>
</html>
`;

function readGraph(graphPath: string): GraphJson {
  if (!existsSync(graphPath)) {
    throw new Error(`${graphPath} not found — run \`graphify update .\` first.`);
  }
  return JSON.parse(readFileSync(graphPath, 'utf8')) as GraphJson;
}

function makeSourceReader(repoRoot: string): (sourceFile: string) => string[] | undefined {
  const cache = new Map<string, string[] | undefined>();
  return (sourceFile: string) => {
    if (cache.has(sourceFile)) return cache.get(sourceFile);
    let lines: string[] | undefined;
    try {
      lines = readFileSync(join(repoRoot, sourceFile), 'utf8').split('\n');
    } catch {
      lines = undefined;
    }
    cache.set(sourceFile, lines);
    return lines;
  };
}

// Ships beside the script, not in repoRoot — it's static data authored once
// for this tool, not something that varies per checkout
function loadDescriptions(): Record<string, ModuleDescriptionEntry> {
  const descPath = fileURLToPath(new URL('./arch-viewer-descriptions.json', import.meta.url));
  if (!existsSync(descPath)) return {};
  return JSON.parse(readFileSync(descPath, 'utf8')) as Record<string, ModuleDescriptionEntry>;
}

function run(repoRoot: string): void {
  const graphPath = join(repoRoot, 'graphify-out', 'graph.json');
  const reportPath = join(repoRoot, 'graphify-out', 'GRAPH_REPORT.md');
  const outHtmlPath = join(repoRoot, 'graphify-out', 'ARCH_VIEWER.html');
  const outDataPath = join(repoRoot, 'graphify-out', 'arch-viewer-data.js');

  const graph = readGraph(graphPath);
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const data = buildArchViewerData(
    graph,
    reportText,
    makeSourceReader(repoRoot),
    loadDescriptions(),
  );

  writeFileSync(outDataPath, `const ARCH_DATA = ${JSON.stringify(data)};\n`);
  writeFileSync(outHtmlPath, HTML_SHELL);

  console.log(`Wrote ${outHtmlPath}`);
  console.log(`Wrote ${outDataPath}`);
  console.log(
    `${data.moduleAnchors.length} modules, ${data.moduleEdges.length} module-level edges.`,
  );
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  run(process.cwd());
}
