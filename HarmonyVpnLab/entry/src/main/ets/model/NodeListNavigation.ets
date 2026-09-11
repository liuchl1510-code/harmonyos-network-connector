// Route parameters identify a confirmed import; node contents remain in the
// private catalog. The receiving page must intersect IDs with its current read.
export class ImportedNodesNavigation {
  importedNodeIds: string[];
  requestId: string;
  constructor(importedNodeIds: string[], requestId: string) {
    this.importedNodeIds = importedNodeIds.slice();
    this.requestId = requestId;
  }
}

function validImportedNavigation(params: Object): boolean {
  if (!params || typeof params !== 'object' || Array.isArray(params) ||
    Object.keys(params).length !== 2 ||
    Object.keys(params).some((key: string) => key !== 'importedNodeIds' && key !== 'requestId')) { return false; }
  const navigation = params as ImportedNodesNavigation;
  if (typeof navigation.requestId !== 'string' ||
    !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(navigation.requestId)) { return false; }
  const ids = navigation.importedNodeIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) { return false; }
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(id) || unique.has(id)) { return false; }
    unique.add(id);
  }
  return true;
}

export function readImportedNodeIds(params: Object): string[] {
  return validImportedNavigation(params) ? (params as ImportedNodesNavigation).importedNodeIds.slice() : [];
}

export function readImportedNavigationRequestId(params: Object): string {
  return validImportedNavigation(params) ? (params as ImportedNodesNavigation).requestId : '';
}
