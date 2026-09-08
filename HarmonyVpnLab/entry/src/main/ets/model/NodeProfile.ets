import { ImportedNode, parseNode } from './NodeImport';
import { importManualNodes, readActiveNode, readNodeCatalog, SavedNode, selectCatalogNode, updateActiveNode } from './NodeCatalog';
import { assertNodeManagementAllowed } from './NodeEditGuard';

interface RemoteServer { address: string; port: number; }
interface RemoteSettings { vnext?: RemoteServer[]; servers?: RemoteServer[]; }
interface StreamSummary { network?: string; security?: string; }
interface RemoteOutbound { protocol: string; settings: RemoteSettings; streamSettings?: StreamSummary; }

export class NodeEndpoint {
  address: string;
  port: number;
  protocol: string;
  network: string;
  security: string;
  constructor(address: string, port: number, protocol: string, network: string, security: string) {
    this.address = address;
    this.port = port;
    this.protocol = protocol;
    this.network = network;
    this.security = security;
  }
}

export function nodeEndpoint(node: ImportedNode): NodeEndpoint {
  const outbound = JSON.parse(node.outboundJson) as RemoteOutbound;
  const servers = outbound.protocol === 'vless' || outbound.protocol === 'vmess'
    ? outbound.settings.vnext : outbound.settings.servers;
  if (!servers || servers.length !== 1) { throw new Error('无法定位节点端点'); }
  return new NodeEndpoint(servers[0].address, servers[0].port, outbound.protocol,
    outbound.streamSettings?.network ?? 'tcp', outbound.streamSettings?.security ?? 'none');
}

export function nodeServerAddress(node: ImportedNode): string {
  const outbound = JSON.parse(node.outboundJson) as RemoteOutbound;
  const servers = outbound.protocol === 'vless' || outbound.protocol === 'vmess'
    ? outbound.settings.vnext : outbound.settings.servers;
  if (!servers || servers.length !== 1 || typeof servers[0].address !== 'string') {
    throw new Error('无法定位单个节点的服务器地址');
  }
  return servers[0].address;
}

export function updateNodeServerAddress(filesDir: string, address: string): void {
  assertNodeManagementAllowed(filesDir);
  const node = readNodeProfile(filesDir);
  if (!node) { throw new Error('请先导入节点'); }
  const outbound = JSON.parse(node.outboundJson) as RemoteOutbound;
  const servers = outbound.protocol === 'vless' || outbound.protocol === 'vmess'
    ? outbound.settings.vnext : outbound.settings.servers;
  if (!servers || servers.length !== 1) { throw new Error('无法定位单个节点的服务器地址'); }
  servers[0].address = address.trim();
  const validated = parseNode(JSON.stringify(outbound));
  validated.name = node.name;
  updateActiveNode(filesDir, validated);
}

export function readNodeProfile(filesDir: string): ImportedNode | undefined {
  return readActiveNode(filesDir);
}

export function saveNodeProfile(filesDir: string, node: ImportedNode): void {
  assertNodeManagementAllowed(filesDir);
  importManualNodes(filesDir, [node]);
  const canonical = parseNode(node.outboundJson).outboundJson;
  const saved = readNodeCatalog(filesDir).nodes.find((entry: SavedNode) => entry.outboundJson === canonical);
  if (!saved) { throw new Error('未找到已导入节点，请刷新列表。'); }
  selectCatalogNode(filesDir, saved.id);
}
