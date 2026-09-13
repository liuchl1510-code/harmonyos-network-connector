import { SavedNode } from './NodeCatalog';
import { NodeLatencyResult } from './NodeLatency';

export enum NodeLatencySortMode {
  Original = 'original',
  FirstHttps = 'first-https',
  Reused = 'reused'
}

export function nodeLatencySortLabel(mode: NodeLatencySortMode): string {
  if (mode === NodeLatencySortMode.FirstHttps) { return '首次 HTTPS'; }
  if (mode === NodeLatencySortMode.Reused) { return '复用延迟'; }
  return '原始顺序';
}

function validDuration(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60000;
}

// The page supplies fingerprint-matched records. Never substitute a first or
// merely repeated request for a system-confirmed reused connection.
export function nodeLatencySortRank(mode: NodeLatencySortMode, result?: NodeLatencyResult): number {
  if (!result || result.status !== 'passed' || result.reason !== '' || !validDuration(result.durationMs)) {
    return Number.POSITIVE_INFINITY;
  }
  if (mode === NodeLatencySortMode.FirstHttps) { return result.durationMs; }
  if (mode === NodeLatencySortMode.Reused && result.measurementVersion === 2 &&
    result.secondStatus === 'passed' && result.secondConnection === 'reused' &&
    result.secondReason === '' && validDuration(result.secondDurationMs)) {
    return result.secondDurationMs;
  }
  return Number.POSITIVE_INFINITY;
}

class RankedNode {
  node: SavedNode;
  rank: number;
  originalIndex: number;
  constructor(node: SavedNode, rank: number, originalIndex: number) {
    this.node = node; this.rank = rank; this.originalIndex = originalIndex;
  }
}

// Only return a reordered copy. Missing/failed/ineligible records form one
// stable trailing group; an explicit index also preserves successful ties.
export function sortCatalogNodes(nodes: SavedNode[], results: NodeLatencyResult[], mode: NodeLatencySortMode): SavedNode[] {
  if (mode !== NodeLatencySortMode.FirstHttps && mode !== NodeLatencySortMode.Reused) { return nodes.slice(); }
  const ranksById: Map<string, number> = new Map<string, number>();
  for (const result of results) {
    const id = result.nodeId;
    if (!ranksById.has(id)) { ranksById.set(id, nodeLatencySortRank(mode, result)); }
  }
  const ranked = nodes.map((node: SavedNode, index: number) =>
    new RankedNode(node, ranksById.get(node.id) ?? Number.POSITIVE_INFINITY, index));
  ranked.sort((left: RankedNode, right: RankedNode): number =>
    left.rank === right.rank ? left.originalIndex - right.originalIndex : left.rank < right.rank ? -1 : 1);
  return ranked.map((entry: RankedNode) => entry.node);
}
