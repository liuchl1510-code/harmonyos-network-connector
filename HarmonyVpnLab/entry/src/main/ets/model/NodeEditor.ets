import { util } from '@kit.ArkTS';
import { ImportedNode, parseNode } from './NodeImport';

interface EditorUser { id: string; flow?: string; }
interface EditorServer { address: string; port: number; users?: EditorUser[]; password?: string; method?: string; }
interface EditorSettings { vnext?: EditorServer[]; servers?: EditorServer[]; }
interface EditorTls { serverName?: string; fingerprint?: string; alpn?: string[]; }
interface EditorReality { serverName: string; fingerprint: string; publicKey: string; shortId: string; spiderX?: string; }
interface EditorWs { path?: string; host?: string; }
interface EditorGrpc { serviceName?: string; authority?: string; }
interface EditorStream {
  network?: string; security?: string; tlsSettings?: EditorTls; realitySettings?: EditorReality;
  wsSettings?: EditorWs; grpcSettings?: EditorGrpc;
}
interface EditorOutbound { protocol: string; settings: EditorSettings; streamSettings?: EditorStream; }

export class NodeEditorDraft {
  name: string = '';
  protocol: string = '';
  address: string = '';
  port: string = '';
  credential: string = '';
  method: string = '';
  flow: string = '';
  network: string = 'tcp';
  security: string = 'none';
  serverName: string = '';
  fingerprint: string = '';
  alpn: string = '';
  publicKey: string = '';
  shortId: string = '';
  spiderX: string = '';
  transportPath: string = '';
  transportHost: string = '';
  serviceName: string = '';
  authority: string = '';
}

function serverOf(outbound: EditorOutbound): EditorServer {
  const servers = ['vless', 'vmess'].includes(outbound.protocol) ? outbound.settings.vnext : outbound.settings.servers;
  if (!servers || servers.length !== 1) { throw new Error('节点结构不受支持。'); }
  return servers[0];
}

function parsedOutbound(node: ImportedNode): EditorOutbound {
  return JSON.parse(parseNode(node.outboundJson).outboundJson) as EditorOutbound;
}

export function nodeEditorDraft(node: ImportedNode): NodeEditorDraft {
  try {
    const outbound = parsedOutbound(node);
    const server = serverOf(outbound);
    const stream = outbound.streamSettings;
    const draft = new NodeEditorDraft();
    draft.name = node.name; draft.protocol = outbound.protocol;
    draft.address = server.address; draft.port = server.port.toString();
    draft.credential = ['vless', 'vmess'].includes(outbound.protocol) ? (server.users?.[0].id ?? '') : (server.password ?? '');
    draft.method = server.method ?? ''; draft.flow = server.users?.[0].flow ?? '';
    draft.network = stream?.network ?? 'tcp'; draft.security = stream?.security ?? 'none';
    draft.serverName = draft.security === 'reality' ? (stream?.realitySettings?.serverName ?? '') : (stream?.tlsSettings?.serverName ?? '');
    draft.fingerprint = draft.security === 'reality' ? (stream?.realitySettings?.fingerprint ?? '') : (stream?.tlsSettings?.fingerprint ?? '');
    draft.alpn = stream?.tlsSettings?.alpn?.join(',') ?? '';
    draft.publicKey = stream?.realitySettings?.publicKey ?? ''; draft.shortId = stream?.realitySettings?.shortId ?? '';
    draft.spiderX = stream?.realitySettings?.spiderX ?? '';
    draft.transportPath = stream?.wsSettings?.path ?? ''; draft.transportHost = stream?.wsSettings?.host ?? '';
    draft.serviceName = stream?.grpcSettings?.serviceName ?? ''; draft.authority = stream?.grpcSettings?.authority ?? '';
    return draft;
  } catch (_) { throw new Error('无法打开这个节点，请检查其配置是否受支持。'); }
}

// Work on a fresh parse of the complete original object. Only fields displayed
// by this form are patched; nested fields absent from the form survive verbatim
// as JSON values. Changing protocol/transport is an explicit advanced JSON edit.
export function nodeFromEditorDraft(original: ImportedNode, draft: NodeEditorDraft): ImportedNode {
  try {
    const before = nodeEditorDraft(original);
    if (draft.protocol !== before.protocol || draft.network !== before.network || draft.security !== before.security) {
      throw new Error('unsupported transition');
    }
    if (!/^[0-9]{1,5}$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535) {
      throw new Error('invalid port');
    }
    const outbound = parsedOutbound(original);
    const server = serverOf(outbound);
    server.address = draft.address.trim(); server.port = Number(draft.port);
    if (['vless', 'vmess'].includes(outbound.protocol)) {
      if (!server.users || server.users.length !== 1) { throw new Error('missing user'); }
      server.users[0].id = draft.credential.trim();
      if (outbound.protocol === 'vless' && draft.flow !== before.flow) { server.users[0].flow = draft.flow.trim() || undefined; }
    } else {
      server.password = draft.credential;
      if (outbound.protocol === 'shadowsocks') { server.method = draft.method.trim(); }
    }
    const stream = outbound.streamSettings;
    if (stream && draft.security === 'tls' &&
      (draft.serverName !== before.serverName || draft.fingerprint !== before.fingerprint || draft.alpn !== before.alpn)) {
      if (!stream.tlsSettings) { stream.tlsSettings = {}; }
      if (draft.serverName !== before.serverName) { stream.tlsSettings.serverName = draft.serverName.trim() || undefined; }
      if (draft.fingerprint !== before.fingerprint) { stream.tlsSettings.fingerprint = draft.fingerprint.trim() || undefined; }
      if (draft.alpn !== before.alpn) {
        stream.tlsSettings.alpn = draft.alpn.trim().length > 0 ? draft.alpn.split(',').map((item: string) => item.trim()) : undefined;
      }
    }
    if (stream?.realitySettings && draft.security === 'reality') {
      const reality = stream.realitySettings;
      if (draft.serverName !== before.serverName) { reality.serverName = draft.serverName.trim(); }
      if (draft.fingerprint !== before.fingerprint) { reality.fingerprint = draft.fingerprint.trim(); }
      if (draft.publicKey !== before.publicKey) { reality.publicKey = draft.publicKey.trim(); }
      if (draft.shortId !== before.shortId) { reality.shortId = draft.shortId.trim(); }
      if (draft.spiderX !== before.spiderX) { reality.spiderX = draft.spiderX || undefined; }
    }
    if (stream && draft.network === 'ws' &&
      (draft.transportPath !== before.transportPath || draft.transportHost !== before.transportHost)) {
      if (!stream.wsSettings) { stream.wsSettings = {}; }
      if (draft.transportPath !== before.transportPath) { stream.wsSettings.path = draft.transportPath; }
      if (draft.transportHost !== before.transportHost) { stream.wsSettings.host = draft.transportHost.trim() || undefined; }
    }
    if (stream && draft.network === 'grpc' &&
      (draft.serviceName !== before.serviceName || draft.authority !== before.authority)) {
      if (!stream.grpcSettings) { stream.grpcSettings = {}; }
      if (draft.serviceName !== before.serviceName) { stream.grpcSettings.serviceName = draft.serviceName; }
      if (draft.authority !== before.authority) { stream.grpcSettings.authority = draft.authority.trim() || undefined; }
    }
    return nodeFromEditorJson(draft.name, JSON.stringify(outbound));
  } catch (_) { throw new Error('节点参数未通过校验，请检查地址、端口、认证和传输参数。'); }
}

export function nodeFromEditorJson(name: string, text: string): ImportedNode {
  try {
    if (typeof name !== 'string' || typeof text !== 'string' || text.length > 65536 ||
      new util.TextEncoder().encodeInto(text).byteLength > 65536 || !text.trim().startsWith('{')) {
      throw new Error('invalid');
    }
    const node = parseNode(text);
    node.name = name;
    return node;
  } catch (_) { throw new Error('JSON 未通过校验，请使用不超过 64 KiB 的受支持单个 outbound。'); }
}
