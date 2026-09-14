const STAGES: string[] = ['configuration', 'authorization', 'start-request', 'vpn-init', 'vpn-create', 'endpoint-dns',
  'network', 'core-init', 'runtime-clock', 'forwarding', 'status', 'cleanup', 'proxy-dns', 'https', 'response'];
// Persisted diagnostic values use these stable indices. Never reorder them.
const REASONS: string[] = ['failed', 'timeout', 'connection', 'tls', 'invalid-response', 'unavailable'];
const DIAGNOSTIC_PREFIX = 'operation-failed-';

// This classification contains no input, endpoint, native message or credentials.
// A stage identifies the operation that failed, not a remote failure's root cause.
export class ConnectionFailure {
  stage: string;
  reason: string;
  at: number;
  constructor(stage: string, reason: string, at: number) { this.stage = stage; this.reason = reason; this.at = at; }
}

export function validConnectionFailure(value: ConnectionFailure): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const keys = Object.keys(value);
  return keys.length === 3 && keys.every((key: string) => ['stage', 'reason', 'at'].includes(key)) &&
    typeof value.stage === 'string' && STAGES.includes(value.stage) && typeof value.reason === 'string' && REASONS.includes(value.reason) &&
    Number.isSafeInteger(value.at) && value.at >= 0;
}

export function makeConnectionFailure(stage: string, reason: string = 'failed'): ConnectionFailure {
  if (!STAGES.includes(stage) || !REASONS.includes(reason)) { throw new Error('CONNECTION_FAILURE_INVALID_CLASSIFICATION'); }
  const now = Date.now();
  return new ConnectionFailure(stage, reason, Number.isSafeInteger(now) && now >= 0 ? now : 0);
}

export function failureDiagnosticCode(failure: ConnectionFailure): string {
  return validConnectionFailure(failure) ? DIAGNOSTIC_PREFIX + failure.stage : '';
}
export function failureDiagnosticValue(failure: ConnectionFailure): number {
  return validConnectionFailure(failure) ? REASONS.indexOf(failure.reason) : -1;
}
export function failureFromDiagnosticEvent(code: string, value: number, at: number): ConnectionFailure | undefined {
  if (typeof code !== 'string' || !code.startsWith(DIAGNOSTIC_PREFIX) || !Number.isSafeInteger(value) || value < 0 || value >= REASONS.length ||
    !Number.isSafeInteger(at) || at < 0) { return undefined; }
  const stage = code.substring(DIAGNOSTIC_PREFIX.length);
  return STAGES.includes(stage) ? new ConnectionFailure(stage, REASONS[value], at) : undefined;
}

// Only this authored error type carries an earlier operation's classification.
// Arbitrary errors that happen to contain stage/reason/message fields do not.
export class ConnectionFailureError extends Error {
  readonly failure: ConnectionFailure;
  constructor(stage: string, reason: string = 'failed') {
    super('CONNECTION_OPERATION_FAILED'); this.failure = makeConnectionFailure(stage, reason);
  }
}

interface ErrorCode { code?: number; }
export function connectionFailureFromError(error: Object, fallbackStage: string): ConnectionFailure {
  if (error instanceof ConnectionFailureError && validConnectionFailure(error.failure)) {
    return new ConnectionFailure(error.failure.stage, error.failure.reason, error.failure.at);
  }
  const stage = STAGES.includes(fallbackStage) ? fallbackStage : 'status';
  // These SDK codes classify the HTTP client operation only. They do not prove
  // that the node's transport handshake or authentication failed.
  if (stage === 'https' && error !== null && typeof error === 'object') {
    const code = (error as ErrorCode).code;
    if (code === 2300028) { return makeConnectionFailure(stage, 'timeout'); }
    if (code === 2300007) { return makeConnectionFailure(stage, 'connection'); }
    if (code === 2300060) { return makeConnectionFailure(stage, 'tls'); }
  }
  return makeConnectionFailure(stage);
}

export function failureStageLabel(stage: string): string {
  switch (stage) {
    case 'configuration': return '配置检查';
    case 'authorization': return 'VPN 授权';
    case 'start-request': return '请求启动 VPN';
    case 'vpn-init': return 'VPN 初始化';
    case 'vpn-create': return '创建 VPN 网卡';
    case 'endpoint-dns': return '节点服务器域名解析';
    case 'network': return '物理网络准备';
    case 'core-init': return '代理核心准备';
    case 'runtime-clock': return '核心时间检查';
    case 'forwarding': return '转发器检查';
    case 'status': return '运行状态检查';
    case 'cleanup': return '资源清理';
    case 'proxy-dns': return '代理 DNS 检查';
    case 'https': return '域名 HTTPS 检查';
    case 'response': return '测试站点响应检查';
    default: return '连接检查';
  }
}

export function failureProblem(failure: ConnectionFailure): string {
  if (!validConnectionFailure(failure)) { return '本次操作未完成，详细阶段不可用。'; }
  if (failure.stage === 'https') {
    if (failure.reason === 'timeout') { return '域名 HTTPS 请求超时，尚不能确定失败发生在节点或测试站点的哪一步。'; }
    if (failure.reason === 'connection') { return 'HTTP 客户端未能建立连接，不能据此确定节点认证参数是否有误。'; }
    if (failure.reason === 'tls') { return 'HTTPS 客户端证书验证未通过，不能据此确定节点握手的具体原因。'; }
  }
  if (failure.stage === 'proxy-dns') { return '代理 DNS 检查未通过；这只说明本次检查未完成，不等同于 DNS 配置错误。'; }
  if (failure.stage === 'response') { return '测试站点的响应不符合本次检查要求。'; }
  if (failure.stage === 'cleanup') { return '部分资源清理尚未确认，不能把这一结果当作已完成清理。'; }
  if (failure.stage === 'runtime-clock') { return '核心时间检查未通过，尚未开始本轮核心启动。'; }
  return failureStageLabel(failure.stage) + (failure.reason === 'timeout' ? '超时。' : '未完成。');
}

export function failureSuggestion(failure: ConnectionFailure): string {
  if (!validConnectionFailure(failure)) { return '查看当前连接状态，确认旧连接结束后再重试。'; }
  switch (failure.stage) {
    case 'configuration': return '核对本地节点与网络策略提示，使用原始有效配置重新导入；不要仅凭运行错误修改密钥。';
    case 'authorization': return '确认系统 VPN 授权结果，再重新请求连接。';
    case 'start-request': return '确认应用已获得 VPN 授权并可在前台运行，再重试。';
    case 'endpoint-dns': return '先检查当前网络和节点服务器域名；该步骤使用物理网络解析，不由应用内 DoH 设置控制。';
    case 'network': return '检查当前网络是否可用，等待网络稳定后重试。';
    case 'proxy-dns': return '先核对节点在当前网络能否连接，再检查 DoH 服务可用性。';
    case 'https': case 'response': return '确认同一节点和当前网络可用后重试；测试站点不可用也可能导致检查失败。';
    case 'runtime-clock': return '重新打开应用再试；若反复出现，请保留该阶段提示用于排查核心运行时。';
    case 'cleanup': return '等待服务结束或使用恢复清理；确认结束后再建立新连接。';
    default: return '确认旧连接已结束后重试；若反复出现，请查看连接诊断中的失败阶段。';
  }
}
