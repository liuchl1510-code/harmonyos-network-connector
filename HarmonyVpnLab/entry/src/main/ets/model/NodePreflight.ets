import { ImportedNode, parseNode } from './NodeImport';
import { normalizeBootstrapHost } from './NodeBootstrap';
import { NodeIssue, nodeIssue, nodeIssueFromError } from './NodeIssue';

interface CheckedServer { address: string; }
interface CheckedSettings { vnext?: CheckedServer[]; servers?: CheckedServer[]; }
interface CheckedOutbound { protocol: string; settings: CheckedSettings; }

// Pure local preflight. Parsing is validation only: never save the returned
// canonical object, resolve DNS, load a native core or claim connectivity.
export function checkNodeForConnection(node: ImportedNode): NodeIssue[] {
  if (!node || typeof node.outboundJson !== 'string' || typeof node.protocol !== 'string') {
    return [nodeIssue('node-missing')];
  }
  let parsed: ImportedNode;
  try {
    parsed = parseNode(node.outboundJson);
    if (parsed.protocol !== node.protocol) { return [nodeIssue('protocol-unsupported')]; }
  } catch (error) { return [nodeIssueFromError(error as Object) ?? nodeIssue('configuration-invalid')]; }
  try {
    const outbound = JSON.parse(parsed.outboundJson) as CheckedOutbound;
    const servers = ['vless', 'vmess'].includes(outbound.protocol) ? outbound.settings.vnext : outbound.settings.servers;
    if (!servers || servers.length !== 1 || typeof servers[0].address !== 'string') { return [nodeIssue('address-format')]; }
    if (servers[0].address.includes(':')) { return [nodeIssue('ipv4-entry-required')]; }
    normalizeBootstrapHost(servers[0].address);
    return [];
  } catch (_) { return [nodeIssue('bootstrap-host-format')]; }
}
