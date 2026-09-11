import { fileIo as fs } from '@kit.CoreFileKit';
import { url as arkUrl, util } from '@kit.ArkTS';
import { ImportedNode, parseNode } from './NodeImport';
import { assertNodeManagementAllowed } from './NodeEditGuard';

const MAX_NODES: number = 500;
const MAX_SUBSCRIPTIONS: number = 20;
const MAX_OUTBOUND_BYTES: number = 65536;
const MAX_FILE_BYTES: number = 4 * 1024 * 1024;
const MAX_BACKUP_BYTES: number = 5 * 1024 * 1024;
const CATALOG_ERROR: string = '节点库损坏或无法读取，已停止操作，请保留原文件。';

export class SavedNode {
  id: string;
  name: string;
  protocol: string;
  outboundJson: string;
  sourceId: string;
  modifiedAt: number;
  favorite: boolean = false;
  constructor(id: string, node: ImportedNode, sourceId: string, modifiedAt: number = Date.now()) {
    this.id = id;
    this.name = node.name;
    this.protocol = node.protocol;
    this.outboundJson = node.outboundJson;
    this.sourceId = sourceId;
    this.modifiedAt = modifiedAt;
  }
}

export class SubscriptionSource {
  id: string;
  name: string;
  url: string;
  lastUpdatedAt: number;
  constructor(id: string, name: string, url: string, lastUpdatedAt: number = 0) {
    this.id = id;
    this.name = name;
    this.url = url;
    this.lastUpdatedAt = lastUpdatedAt;
  }
}

export class NodeCatalog {
  schemaVersion: number = 2;
  revision: number = 0;
  activeNodeId: string = '';
  nodes: SavedNode[] = [];
  subscriptions: SubscriptionSource[] = [];
}

export class NodeImportResult {
  added: number;
  duplicates: number;
  activeNodeId: string;
  constructor(added: number, duplicates: number, activeNodeId: string) {
    this.added = added;
    this.duplicates = duplicates;
    this.activeNodeId = activeNodeId;
  }
}

class NodeCatalogBackup {
  format: string = 'harmony-vpn-node-backup';
  schemaVersion: number = 2;
  exportedAt: number = Date.now();
  catalog: NodeCatalog;
  constructor(catalog: NodeCatalog) { this.catalog = catalog; }
}

function byteLength(text: string): number {
  return new util.TextEncoder().encodeInto(text).byteLength;
}

function nameOf(value: string, fallback: string): string {
  let name = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 64);
  if (name.length > 0 && /[\ud800-\udbff]/.test(name[name.length - 1])) { name = name.slice(0, -1); }
  return name.length > 0 ? name : fallback;
}

function validId(id: string): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(id);
}

function wholeNumber(value: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Object, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || Object.keys(value).some((key: string) => keys.indexOf(key) < 0)) {
    throw new Error(CATALOG_ERROR);
  }
}

function normalizeNode(node: ImportedNode): ImportedNode {
  try {
    if (!node || typeof node.name !== 'string' || typeof node.protocol !== 'string' ||
      typeof node.outboundJson !== 'string' || node.outboundJson.length > MAX_OUTBOUND_BYTES ||
      byteLength(node.outboundJson) > MAX_OUTBOUND_BYTES) { throw new Error('invalid'); }
    const parsed = parseNode(node.outboundJson);
    if (parsed.protocol !== node.protocol || byteLength(parsed.outboundJson) > MAX_OUTBOUND_BYTES) {
      throw new Error('invalid');
    }
    return new ImportedNode(nameOf(node.name, parsed.protocol), parsed.protocol, parsed.outboundJson);
  } catch (_) { throw new Error('节点内容无效或超过 64 KiB，未保存。'); }
}

function subscriptionUrl(value: string): string {
  const invalid = '订阅地址无效，请使用不含账号和片段的 HTTPS 链接（最多 4096 字符）';
  if (typeof value !== 'string' || value.length > 4096) { throw new Error(invalid); }
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed) || /[\u0000-\u0020\u007f\\#]/.test(trimmed) ||
    /%(?![0-9a-fA-F]{2})/.test(trimmed)) { throw new Error(invalid); }
  const authority = trimmed.slice(8).split(/[/?]/)[0];
  if (authority.length === 0 || authority.includes('@')) { throw new Error(invalid); }
  try {
    const parsed = arkUrl.URL.parseURL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.hostname.length === 0 || parsed.username.length > 0 ||
      parsed.password.length > 0 || parsed.hash.length > 0 || parsed.href.length > 4096) { throw new Error(invalid); }
    return parsed.href;
  } catch (_) { throw new Error(invalid); }
}

function validateCatalog(catalog: NodeCatalog): NodeCatalog {
  exactKeys(catalog, ['schemaVersion', 'revision', 'activeNodeId', 'nodes', 'subscriptions']);
  if ((catalog.schemaVersion !== 1 && catalog.schemaVersion !== 2) || !wholeNumber(catalog.revision) ||
    typeof catalog.activeNodeId !== 'string' || !Array.isArray(catalog.nodes) ||
    !Array.isArray(catalog.subscriptions) || catalog.nodes.length > MAX_NODES ||
    catalog.subscriptions.length > MAX_SUBSCRIPTIONS) { throw new Error(CATALOG_ERROR); }
  const sourceIds: Set<string> = new Set<string>();
  for (const source of catalog.subscriptions) {
    exactKeys(source, ['id', 'name', 'url', 'lastUpdatedAt']);
    if (!validId(source.id) || sourceIds.has(source.id) || typeof source.name !== 'string' ||
      source.name !== nameOf(source.name, '未命名订阅') || !wholeNumber(source.lastUpdatedAt)) {
      throw new Error(CATALOG_ERROR);
    }
    if (source.url !== subscriptionUrl(source.url)) { throw new Error(CATALOG_ERROR); }
    sourceIds.add(source.id);
  }
  const nodeIds: Set<string> = new Set<string>();
  const outbounds: Set<string> = new Set<string>();
  for (const node of catalog.nodes) {
    exactKeys(node, catalog.schemaVersion === 1 ?
      ['id', 'name', 'protocol', 'outboundJson', 'sourceId', 'modifiedAt'] :
      ['id', 'name', 'protocol', 'outboundJson', 'sourceId', 'modifiedAt', 'favorite']);
    if (!validId(node.id) || nodeIds.has(node.id) || typeof node.sourceId !== 'string' ||
      (node.sourceId !== '' && !sourceIds.has(node.sourceId)) || !wholeNumber(node.modifiedAt) ||
      (catalog.schemaVersion === 2 && typeof node.favorite !== 'boolean')) {
      throw new Error(CATALOG_ERROR);
    }
    const parsed = normalizeNode(new ImportedNode(node.name, node.protocol, node.outboundJson));
    if (node.name !== parsed.name || node.outboundJson !== parsed.outboundJson || outbounds.has(node.outboundJson)) {
      throw new Error(CATALOG_ERROR);
    }
    nodeIds.add(node.id);
    outbounds.add(node.outboundJson);
  }
  if ((catalog.activeNodeId === '' && catalog.nodes.length !== 0) ||
    (catalog.activeNodeId !== '' && !nodeIds.has(catalog.activeNodeId))) { throw new Error(CATALOG_ERROR); }
  // Validate the complete original schema before adding defaults. Reads and
  // backup previews migrate only this in-memory value, preserving disk bytes and
  // revision; the next actual mutation atomically commits the current schema.
  if (catalog.schemaVersion === 1) {
    for (const node of catalog.nodes) { node.favorite = false; }
    catalog.schemaVersion = 2;
  }
  return catalog;
}

function readBounded(path: string): string {
  const size = fs.statSync(path).size;
  if (size < 0 || size > MAX_FILE_BYTES) { throw new Error(CATALOG_ERROR); }
  const text = fs.readTextSync(path);
  if (text.length > MAX_FILE_BYTES || byteLength(text) > MAX_FILE_BYTES) { throw new Error(CATALOG_ERROR); }
  return text;
}

// A single synchronous UI writer commits a complete revision; callers fetching a
// subscription must invoke a mutation only after awaiting the response, so it
// reads the latest disk revision rather than saving a stale pre-fetch snapshot.
function writeCatalog(filesDir: string, catalog: NodeCatalog): void {
  validateCatalog(catalog);
  if (catalog.revision >= Number.MAX_SAFE_INTEGER) { throw new Error('节点库版本超出范围，未保存。'); }
  catalog.revision++;
  const bytes = new util.TextEncoder().encodeInto(JSON.stringify(catalog));
  if (bytes.byteLength > MAX_FILE_BYTES) { throw new Error('节点库超过 4 MiB，未保存。'); }
  const destination = `${filesDir}/node-catalog.json`;
  const temporary = `${destination}.${util.generateRandomUUID()}.tmp`;
  try {
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const part = bytes.slice(offset);
        const written = fs.writeSync(file.fd, part.buffer);
        if (!Number.isSafeInteger(written) || written <= 0 || written > part.byteLength) {
          throw new Error('write failed');
        }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, destination);
  } catch (_) { throw new Error('节点库保存失败，原有配置未替换。'); }
  finally {
    try { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } } catch (_) { /* best effort private temp cleanup */ }
  }
}

export function readNodeCatalog(filesDir: string): NodeCatalog {
  const path = `${filesDir}/node-catalog.json`;
  try {
    if (fs.accessSync(path)) { return validateCatalog(JSON.parse(readBounded(path)) as NodeCatalog); }
    const legacyPath = `${filesDir}/node-profile.json`;
    const catalog = new NodeCatalog();
    if (!fs.accessSync(legacyPath)) { return catalog; }
    const legacy = JSON.parse(readBounded(legacyPath)) as ImportedNode;
    exactKeys(legacy, ['name', 'protocol', 'outboundJson']);
    const imported = normalizeNode(legacy);
    const saved = new SavedNode(`n-${util.generateRandomUUID()}`, imported, '');
    catalog.nodes.push(saved);
    catalog.activeNodeId = saved.id;
    assertNodeManagementAllowed(filesDir);
    writeCatalog(filesDir, catalog);
    return catalog;
  } catch (_) { throw new Error(CATALOG_ERROR); }
}

export function readActiveNode(filesDir: string): ImportedNode | undefined {
  const catalog = readNodeCatalog(filesDir);
  const node = catalog.nodes.find((entry: SavedNode) => entry.id === catalog.activeNodeId);
  return node ? new ImportedNode(node.name, node.protocol, node.outboundJson) : undefined;
}

function checkedBatch(nodes: ImportedNode[]): ImportedNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) {
    throw new Error('请导入 1 至 500 个有效节点，原有配置未改变。');
  }
  return nodes.map((node: ImportedNode) => normalizeNode(node));
}

function ensureActive(catalog: NodeCatalog): void {
  if (!catalog.nodes.some((node: SavedNode) => node.id === catalog.activeNodeId)) {
    catalog.activeNodeId = catalog.nodes.length > 0 ? catalog.nodes[0].id : '';
  }
}

function requireNode(catalog: NodeCatalog, id: string): SavedNode {
  const node = catalog.nodes.find((entry: SavedNode) => entry.id === id);
  if (!node) { throw new Error('节点已不存在，请刷新列表。'); }
  return node;
}

function requireSubscription(catalog: NodeCatalog, id: string): SubscriptionSource {
  const source = catalog.subscriptions.find((entry: SubscriptionSource) => entry.id === id);
  if (!source) { throw new Error('订阅已不存在，请刷新列表。'); }
  return source;
}

export function importManualNodes(filesDir: string, nodes: ImportedNode[]): NodeImportResult {
  assertNodeManagementAllowed(filesDir);
  const incoming = checkedBatch(nodes);
  const catalog = readNodeCatalog(filesDir);
  let added = 0;
  let duplicates = 0;
  for (const node of incoming) {
    if (catalog.nodes.some((entry: SavedNode) => entry.outboundJson === node.outboundJson)) { duplicates++; continue; }
    catalog.nodes.push(new SavedNode(`n-${util.generateRandomUUID()}`, node, ''));
    added++;
  }
  if (catalog.nodes.length > MAX_NODES) { throw new Error('节点数量超过 500，未保存。'); }
  ensureActive(catalog);
  if (added > 0) { writeCatalog(filesDir, catalog); }
  return new NodeImportResult(added, duplicates, catalog.activeNodeId);
}

export function selectCatalogNode(filesDir: string, id: string): void {
  assertNodeManagementAllowed(filesDir);
  const catalog = readNodeCatalog(filesDir);
  requireNode(catalog, id);
  if (catalog.activeNodeId === id) { return; }
  catalog.activeNodeId = id;
  writeCatalog(filesDir, catalog);
}

export function renameCatalogNode(filesDir: string, id: string, name: string): void {
  assertNodeManagementAllowed(filesDir);
  const catalog = readNodeCatalog(filesDir);
  const node = requireNode(catalog, id);
  if (typeof name !== 'string') { throw new Error('节点名称无效。'); }
  node.name = nameOf(name, node.protocol);
  node.modifiedAt = Date.now();
  writeCatalog(filesDir, catalog);
}

export function setCatalogNodeFavorite(filesDir: string, id: string, favorite: boolean): void {
  assertNodeManagementAllowed(filesDir);
  if (typeof favorite !== 'boolean') { throw new Error('收藏状态无效，未保存。'); }
  const catalog = readNodeCatalog(filesDir);
  const node = requireNode(catalog, id);
  if (node.favorite === favorite) { return; }
  node.favorite = favorite;
  writeCatalog(filesDir, catalog);
}

export function deleteCatalogNode(filesDir: string, id: string): void {
  assertNodeManagementAllowed(filesDir);
  const catalog = readNodeCatalog(filesDir);
  requireNode(catalog, id);
  const index = catalog.nodes.findIndex((node: SavedNode) => node.id === id);
  catalog.nodes.splice(index, 1);
  if (catalog.activeNodeId === id) {
    catalog.activeNodeId = catalog.nodes.length > 0 ? catalog.nodes[Math.min(index, catalog.nodes.length - 1)].id : '';
  }
  writeCatalog(filesDir, catalog);
}

export function updateActiveNode(filesDir: string, node: ImportedNode): void {
  assertNodeManagementAllowed(filesDir);
  const normalized = normalizeNode(node);
  const catalog = readNodeCatalog(filesDir);
  const saved = requireNode(catalog, catalog.activeNodeId);
  if (catalog.nodes.some((entry: SavedNode) => entry.id !== saved.id && entry.outboundJson === normalized.outboundJson)) {
    throw new Error('相同配置的节点已存在，请直接选择该节点。');
  }
  saved.name = normalized.name;
  saved.protocol = normalized.protocol;
  saved.outboundJson = normalized.outboundJson;
  saved.modifiedAt = Date.now();
  writeCatalog(filesDir, catalog);
}

// The editor writes one selected identity, never whichever node became active
// while the form was open. A changed catalog requires a fresh review of the form.
export function updateCatalogNode(filesDir: string, id: string, node: ImportedNode,
  expectedRevision: number): void {
  assertNodeManagementAllowed(filesDir);
  const normalized = normalizeNode(node);
  const catalog = readNodeCatalog(filesDir);
  if (!wholeNumber(expectedRevision) || catalog.revision !== expectedRevision) {
    throw new Error('节点库已发生变化，请返回列表后重新打开编辑。');
  }
  const saved = requireNode(catalog, id);
  if (catalog.nodes.some((entry: SavedNode) => entry.id !== id && entry.outboundJson === normalized.outboundJson)) {
    throw new Error('相同配置的节点已存在，请直接选择该节点。');
  }
  saved.name = normalized.name;
  saved.protocol = normalized.protocol;
  saved.outboundJson = normalized.outboundJson;
  saved.modifiedAt = Date.now();
  writeCatalog(filesDir, catalog);
}

// Export is read-only and retains the entire validated outbound, including
// supported nested fields which the basic editor does not display.
export function exportCatalogNode(filesDir: string, id: string): string {
  const catalog = readNodeCatalog(filesDir);
  return requireNode(catalog, id).outboundJson;
}

export function exportNodeCatalogBackup(filesDir: string): string {
  const text = JSON.stringify(new NodeCatalogBackup(readNodeCatalog(filesDir)));
  if (byteLength(text) > MAX_BACKUP_BYTES) { throw new Error('节点备份超过 5 MiB，未导出。'); }
  return text;
}

// Pure validation for a preview. Never write a catalog or start a subscription
// request while inspecting an imported file, and do not recover partial content.
export function previewNodeCatalogBackup(text: string): NodeCatalog {
  try {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_BACKUP_BYTES ||
      byteLength(text) > MAX_BACKUP_BYTES) { throw new Error('invalid'); }
    const backup = JSON.parse(text) as NodeCatalogBackup;
    exactKeys(backup, ['format', 'schemaVersion', 'exportedAt', 'catalog']);
    if (backup.format !== 'harmony-vpn-node-backup' ||
      (backup.schemaVersion !== 1 && backup.schemaVersion !== 2) ||
      !wholeNumber(backup.exportedAt) || !backup.catalog ||
      backup.catalog.schemaVersion !== backup.schemaVersion) { throw new Error('invalid'); }
    const catalog = validateCatalog(backup.catalog);
    if (byteLength(JSON.stringify(catalog)) > MAX_FILE_BYTES) { throw new Error('invalid'); }
    return catalog;
  } catch (_) { throw new Error('备份格式无效、节点不受支持或文件超过限制，原有配置未改变。'); }
}

export function restoreNodeCatalogBackup(filesDir: string, text: string, expectedRevision: number): void {
  assertNodeManagementAllowed(filesDir);
  const incoming = previewNodeCatalogBackup(text);
  const current = readNodeCatalog(filesDir);
  if (!wholeNumber(expectedRevision) || current.revision !== expectedRevision) {
    throw new Error('预览后节点库已发生变化，请重新选择备份并确认。');
  }
  // Keep local revision ordering while restoring IDs, names, subscriptions and
  // active selection from the accepted backup. writeCatalog atomically replaces.
  incoming.revision = current.revision;
  writeCatalog(filesDir, incoming);
}

function saveSubscriptionOnCatalog(catalog: NodeCatalog, id: string, name: string, url: string): string {
  if (id === '') {
    if (catalog.subscriptions.length >= MAX_SUBSCRIPTIONS) { throw new Error('订阅数量不能超过 20。'); }
    id = `s-${util.generateRandomUUID()}`;
    catalog.subscriptions.push(new SubscriptionSource(id, nameOf(name, '未命名订阅'), url));
  } else {
    const source = requireSubscription(catalog, id);
    source.name = nameOf(name, '未命名订阅');
    if (source.url !== url) { source.lastUpdatedAt = 0; }
    source.url = url;
  }
  return id;
}

export function saveSubscription(filesDir: string, id: string, name: string, url: string): string {
  assertNodeManagementAllowed(filesDir);
  if (typeof name !== 'string') { throw new Error('订阅名称无效。'); }
  url = subscriptionUrl(url);
  const catalog = readNodeCatalog(filesDir);
  id = saveSubscriptionOnCatalog(catalog, id, name, url);
  writeCatalog(filesDir, catalog);
  return id;
}

function replaceOnCatalog(catalog: NodeCatalog, id: string, incoming: ImportedNode[]): NodeImportResult {
  const source = requireSubscription(catalog, id);
  const previous = catalog.nodes.filter((node: SavedNode) => node.sourceId === id);
  const retained = catalog.nodes.filter((node: SavedNode) => node.sourceId !== id);
  const replacement: SavedNode[] = [];
  let added = 0;
  let duplicates = 0;
  for (const node of incoming) {
    if (retained.some((entry: SavedNode) => entry.outboundJson === node.outboundJson) ||
      replacement.some((entry: SavedNode) => entry.outboundJson === node.outboundJson)) { duplicates++; continue; }
    const old = previous.find((entry: SavedNode) => entry.outboundJson === node.outboundJson);
    if (old) { replacement.push(old); }
    else { replacement.push(new SavedNode(`n-${util.generateRandomUUID()}`, node, id)); added++; }
  }
  // An empty/all-invalid batch was already rejected before touching the catalog.
  // An all-duplicate batch is valid: it may remove obsolete source-owned entries,
  // while the identical manual/other-source configurations remain untouched.
  catalog.nodes = retained.concat(replacement);
  if (catalog.nodes.length > MAX_NODES) { throw new Error('节点数量超过 500，未保存。'); }
  ensureActive(catalog);
  source.lastUpdatedAt = Date.now();
  return new NodeImportResult(added, duplicates, catalog.activeNodeId);
}

export function replaceSubscriptionNodes(filesDir: string, id: string, nodes: ImportedNode[]): NodeImportResult {
  assertNodeManagementAllowed(filesDir);
  const incoming = checkedBatch(nodes);
  const catalog = readNodeCatalog(filesDir);
  const result = replaceOnCatalog(catalog, id, incoming);
  writeCatalog(filesDir, catalog);
  return result;
}

// Metadata and previewed nodes share one disk commit. A failed capacity check or
// write therefore cannot leave a new empty source behind and duplicate it on retry.
export function saveSubscriptionWithNodes(filesDir: string, id: string, name: string, url: string,
  nodes: ImportedNode[]): NodeImportResult {
  assertNodeManagementAllowed(filesDir);
  if (typeof name !== 'string') { throw new Error('订阅名称无效。'); }
  url = subscriptionUrl(url);
  const incoming = checkedBatch(nodes);
  const catalog = readNodeCatalog(filesDir);
  id = saveSubscriptionOnCatalog(catalog, id, name, url);
  const result = replaceOnCatalog(catalog, id, incoming);
  writeCatalog(filesDir, catalog);
  return result;
}

export function deleteSubscription(filesDir: string, id: string): void {
  assertNodeManagementAllowed(filesDir);
  const catalog = readNodeCatalog(filesDir);
  requireSubscription(catalog, id);
  catalog.subscriptions = catalog.subscriptions.filter((source: SubscriptionSource) => source.id !== id);
  catalog.nodes = catalog.nodes.filter((node: SavedNode) => node.sourceId !== id);
  ensureActive(catalog);
  writeCatalog(filesDir, catalog);
}
