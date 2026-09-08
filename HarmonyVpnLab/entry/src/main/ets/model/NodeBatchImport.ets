import { util } from '@kit.ArkTS';
import { ImportedNode, parseNode } from './NodeImport';

// Parsing only: callers must review rejected entries before committing a batch.
// No exception includes input, decoded subscription contents, or node credentials.
export class BatchImportResult {
  nodes: ImportedNode[];
  rejected: number;
  duplicates: number;
  total: number;

  constructor(nodes: ImportedNode[], rejected: number, duplicates: number, total: number) {
    this.nodes = nodes;
    this.rejected = rejected;
    this.duplicates = duplicates;
    this.total = total;
  }
}

const MAX_BATCH_BYTES: number = 1024 * 1024;
const MAX_NODE_BYTES: number = 64 * 1024;
const MAX_LINES: number = 500;
const SHARE_START: RegExp = /^(vless|vmess|trojan|ss):\/\//;
const NO_NODES: string = '未找到可导入的受支持节点。请使用分享链接列表或单个 Xray outbound JSON。';
const INVALID_BASE64: string = '订阅内容的 Base64 编码或 UTF-8 文本无效。';
const INVALID_TEXT: string = '订阅内容包含二进制或不受支持的控制字符，无法导入。';

function fail(message: string): never {
  throw new Error(message);
}

// Count real UTF-8 bytes without allocating a second copy of a large document.
// Unpaired UTF-16 surrogates cannot represent valid UTF-8 text.
function utf8Bytes(text: string): number {
  let size = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) {
      size++;
    } else if (code <= 0x7ff) {
      size += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const following = text.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        return fail(INVALID_TEXT);
      }
      index++;
      size += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return fail(INVALID_TEXT);
    } else {
      size += 3;
    }
  }
  return size;
}

function checkPlainText(text: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
    fail(INVALID_TEXT);
  }
  if (/(^|[\r\n])[ \t]*</.test(text)) {
    fail('收到 HTML / XML 页面，无法作为节点订阅导入。请检查订阅地址或登录状态。');
  }
  if (/(^|[\r\n])[ \t]*(---(?:\s|$)|(proxies|proxy-groups|proxy-providers|rules|rule-providers|mixed-port|socks-port|redir-port|tproxy-port|allow-lan|external-controller|mode|dns|port|log-level|ipv6|tun|profile|bind-address|hosts)[ \t]*:)/.test(text)) {
    fail('暂不支持 YAML / Clash 订阅，请使用纯文本或 Base64 编码的分享链接列表。');
  }
}

function decodeSubscription(text: string): string {
  // Only ASCII layout whitespace may separate Base64 blocks; Unicode whitespace
  // and mixed standard/URL-safe alphabets are rejected instead of normalized.
  const compact = text.replace(/[ \t\r\n]/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length % 4 === 1 ||
    (/[+/]/.test(compact) && /[-_]/.test(compact)) ||
    (compact.indexOf('=') >= 0 && compact.length % 4 !== 0)) {
    return fail(INVALID_BASE64);
  }
  const unpadded = compact.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = unpadded.length % 4;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(unpadded.charAt(unpadded.length - 1));
  // Reject noncanonical trailing bits; permissive decoders silently discard them.
  if (remainder === 1 || (remainder === 2 && (last & 15) !== 0) ||
    (remainder === 3 && (last & 3) !== 0)) {
    return fail(INVALID_BASE64);
  }
  let padded = unpadded;
  while (padded.length % 4 !== 0) {
    padded += '=';
  }
  try {
    const bytes = new util.Base64Helper().decodeSync(padded);
    return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes);
  } catch (err) {
    return fail(INVALID_BASE64);
  }
}

function parseLines(text: string): BatchImportResult {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > MAX_LINES) {
    return fail('一次最多导入 500 行节点，请拆分后重试。');
  }
  const nodes: ImportedNode[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let duplicates = 0;
  let total = 0;
  for (const line of lines) {
    const candidate = line.trim();
    if (candidate.length === 0) {
      continue;
    }
    total++;
    if (!SHARE_START.test(candidate) || utf8Bytes(candidate) > MAX_NODE_BYTES) {
      rejected++;
      continue;
    }
    try {
      const node = parseNode(candidate);
      if (seen.has(node.outboundJson)) {
        duplicates++;
      } else {
        seen.add(node.outboundJson);
        nodes.push(node);
      }
    } catch (err) {
      rejected++;
    }
  }
  if (nodes.length === 0) {
    return fail(NO_NODES);
  }
  return new BatchImportResult(nodes, rejected, duplicates, total);
}

export function parseNodeBatch(input: string): BatchImportResult {
  if (input.length > MAX_BATCH_BYTES || utf8Bytes(input) > MAX_BATCH_BYTES) {
    return fail('一次导入的内容不能超过 1 MiB。');
  }
  let text = input.trim();
  if (text.length === 0) {
    return fail(NO_NODES);
  }
  checkPlainText(text);
  // JSON is an indivisible document. Never recover link-looking lines from a
  // malformed JSON object/array or import only part of a complete configuration.
  if (text.startsWith('{') || text.startsWith('[')) {
    if (utf8Bytes(text) > MAX_NODE_BYTES) {
      return fail('单个节点 JSON 不能超过 64 KiB。');
    }
    try {
      const node = parseNode(text);
      return new BatchImportResult([node], 0, 0, 1);
    } catch (err) {
      return fail('JSON 不能作为受支持的单个 Xray outbound 节点导入。');
    }
  }
  if (!/(^|[\r\n])[ \t]*(vless|vmess|trojan|ss):\/\//.test(text)) {
    text = decodeSubscription(text).trim();
    if (text.length === 0) {
      return fail(NO_NODES);
    }
    checkPlainText(text);
    if (text.startsWith('{') || text.startsWith('[')) {
      return fail('Base64 订阅需要包含分享链接列表；JSON 请直接导入单个 Xray outbound 对象。');
    }
  }
  return parseLines(text);
}
