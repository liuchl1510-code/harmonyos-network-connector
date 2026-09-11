import { SavedNode } from './NodeCatalog';

export class NodeListFilter {
  query: string = '';
  sourceId: string = '$all';
  favoritesOnly: boolean = false;
  importedOnly: boolean = false;
  importedNodeIds: string[] = [];
}

// A filter changes the visible list only, never catalog ordering or selection.
export function filterCatalogNodes(nodes: SavedNode[], filter: NodeListFilter): SavedNode[] {
  const query = filter.query.trim().toLowerCase();
  const imported: Set<string> = new Set<string>(filter.importedNodeIds);
  return nodes.filter((node: SavedNode): boolean =>
    (node.name.toLowerCase().includes(query) || node.protocol.toLowerCase().includes(query)) &&
    (filter.sourceId === '$all' || (filter.sourceId === '$manual' ? node.sourceId === '' : node.sourceId === filter.sourceId)) &&
    (!filter.favoritesOnly || node.favorite) && (!filter.importedOnly || imported.has(node.id)));
}
