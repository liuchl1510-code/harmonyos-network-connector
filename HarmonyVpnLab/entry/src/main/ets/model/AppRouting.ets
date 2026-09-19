export const OWN_VPN_BUNDLE: string = 'com.example.harmonyvpnlab';
// API 24 accepts up to 256 application names. Reserve one for this app's checks.
export const MAX_ROUTED_APPS: number = 255;

export class AppRoutingSelection {
  mode: string;
  bundles: string[];
  constructor(mode: string, bundles: string[]) { this.mode = mode; this.bundles = bundles; }
}

export class AppRoutingScope {
  trustedApplications?: string[];
  blockedApplications?: string[];
}

export function normalizeAppBundle(value: string): string {
  if (typeof value !== 'string' || value.length < 7 || value.length > 128 ||
    !/^[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_]*[A-Za-z0-9])?){2,}$/.test(value)) {
    throw new Error('应用包名格式无效；需为 7 至 128 位且至少三段，以字母开头，各段以字母或数字结尾。');
  }
  // Bundle names are identities. Never trim or lowercase a stored selection.
  return value;
}

export function validateAppRouting(mode: string, bundles: string[]): AppRoutingSelection {
  if (!['all', 'exclude', 'include'].includes(mode)) { throw new Error('应用代理范围无效。'); }
  if (!Array.isArray(bundles) || bundles.length > MAX_ROUTED_APPS) {
    throw new Error('应用列表格式无效或超过 255 项。');
  }
  const result: string[] = [];
  for (const item of bundles) {
    const bundle = normalizeAppBundle(item);
    if (bundle === OWN_VPN_BUNDLE) { throw new Error('本应用自动参与连接检查，无需加入应用选择列表。'); }
    if (!result.includes(bundle)) { result.push(bundle); }
  }
  if (mode !== 'all' && result.length === 0) { throw new Error('请至少选择一个应用，或切换到全部应用。'); }
  return new AppRoutingSelection(mode, result);
}

export function appRoutingScope(testKind: string, mode: string, bundles: string[]): AppRoutingScope {
  const scope = new AppRoutingScope();
  if (testKind === 'connection') {
    const checked = validateAppRouting(mode, bundles);
    if (checked.mode === 'include') { scope.trustedApplications = [OWN_VPN_BUNDLE, ...checked.bundles]; }
    else if (checked.mode === 'exclude') { scope.blockedApplications = checked.bundles; }
  } else if (['connection-app-test', 'node-latency', 'node', 'xray', 'reject'].includes(testKind)) {
    // Temporary diagnostics never expand to another app's traffic or read the saved scope.
    scope.trustedApplications = [OWN_VPN_BUNDLE];
  }
  return scope;
}

export function appRoutingLabel(mode: string, count: number): string {
  if (mode === 'exclude') { return `绕过所选应用（${count}）`; }
  if (mode === 'include') { return `仅代理所选应用（${count}）`; }
  return '全部应用';
}
