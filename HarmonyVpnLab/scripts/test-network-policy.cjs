'use strict';
// Execute the authored policy, config builder and atomic store with synthetic files.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
function load(name, imports = {}) {
  const file = path.join(root, 'entry/src/main/ets/model', name + '.ets');
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0);
  const mod = new Module(file); mod.require = key => { assert(Object.hasOwn(imports, key), key); return imports[key]; };
  mod._compile(result.outputText, file); return mod.exports;
}
const bootstrap = load('NodeBootstrap'), apps = load('AppRouting');
const policy = load('NetworkPolicy', { './NodeBootstrap': bootstrap, './AppRouting': apps });
const config = load('ConnectionConfig', { './NodeBootstrap': bootstrap, './NetworkPolicy': policy });
const node = JSON.stringify({ protocol: 'vless', settings: { vnext: [{ address: '192.0.2.1', port: 443,
  users: [{ id: '00000000-0000-4000-8000-000000000001', encryption: 'none' }] }] } });
const build = p => JSON.parse(config.buildConnectionConfig(node, 18900, 18901, '/synthetic/log', undefined, p));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('missing preference retains global proxy without direct outbound', () => {
  const c = build(); assert(!c.outbounds.some(o => o.protocol === 'freedom')); assert(!c.inbounds[0].sniffing);
  assert.equal(c.dns.servers[0].address, 'https://1.1.1.1/dns-query');
});
test('canonical domain CIDR and duplicates', () => {
  assert.deepEqual(policy.parseRoutingEntries(' Example.COM\nexample.com,192.168.1.99/24\nfull:Api.Example.Com\n1.2.3.4'),
    ['domain:example.com', '192.168.1.0/24', 'full:api.example.com', '1.2.3.4']);
  assert.equal(policy.normalizeRoutingEntry('255.255.255.255/0'), '0.0.0.0/0');
});
for (const invalid of ['1.2.3', '01.2.3.4', '1.2.3.4/33', 'example..com', 'geosite:cn', 'regexp:.*', 'https://example.com', '::/0', '1.2.3.4/01']) {
  test('reject unsupported rule ' + invalid, () => assert.throws(() => policy.normalizeRoutingEntry(invalid)));
}
test('bounded schema and lists, no silent unknown fields', () => {
  for (const value of [null, [], {}, { ...new policy.NetworkPolicy(), ignored: true },
    { ...new policy.NetworkPolicy(), direct: [17] }, { ...new policy.NetworkPolicy(), mode: 'unknown' },
    { ...new policy.NetworkPolicy(), block: Array(301).fill('example.com') }]) assert.throws(() => policy.validateNetworkPolicy(value));
});
test('legacy policy migrates to schema two only in memory', () => {
  const legacy = { schemaVersion: 1, mode: 'rules', bypassLan: true, direct: ['example.com'], proxy: [], block: [],
    dnsUrl: 'https://8.8.8.8/dns-query' };
  const original = JSON.stringify(legacy), checked = policy.validateNetworkPolicy(legacy);
  assert.equal(checked.schemaVersion, 2); assert.equal(checked.appMode, 'all'); assert.deepEqual(checked.appBundles, []);
  assert.equal(checked.dnsUrl, legacy.dnsUrl); assert.deepEqual(checked.direct, ['domain:example.com']);
  assert.equal(JSON.stringify(legacy), original);
  assert.throws(() => policy.validateNetworkPolicy({ ...legacy, appMode: 'include' }));
  assert.throws(() => policy.validateNetworkPolicy({ ...legacy, schemaVersion: 2 }));
});
test('app identities preserve case and do not normalize whitespace', () => {
  for (const valid of ['com.Example.App', 'org_test.App2.x', 'a.bc.de', 'org.2app.3name', 'a'.repeat(124) + '.b.c']) {
    assert.equal(apps.normalizeAppBundle(valid), valid);
  }
  for (const invalid of [undefined, null, 123, '', 'sixsix', 'a'.repeat(129), ' com.test.app', 'com.test.app ',
    '1com.test.app', 'com/test/app', 'com.test.app\n', 'com.test.应用', 'com.test-application',
    'com.test', 'com..app', 'com.test.', 'com._test.app', 'com.test_.app', 'com.test.app_', 'a.b.c']) {
    assert.throws(() => apps.normalizeAppBundle(invalid), error => !error.message.includes(String(invalid)) || !invalid);
  }
});
test('app selections are bounded cloned and deduplicated without case folding', () => {
  const input = ['com.Example.App', 'com.example.app', 'com.Example.App'];
  const selected = apps.validateAppRouting('include', input);
  assert.deepEqual(selected.bundles, ['com.Example.App', 'com.example.app']);
  input.push('com.example.changed'); assert.equal(selected.bundles.length, 2);
  for (const value of [null, {}, 'com.example.app', Array(256).fill('com.example.app')]) {
    assert.throws(() => apps.validateAppRouting('include', value));
  }
  for (const mode of [undefined, null, '', 'other', 1]) assert.throws(() => apps.validateAppRouting(mode, []));
});
for (const mode of ['exclude', 'include']) test(mode + ' refuses empty or own-only scope', () => {
  assert.throws(() => apps.validateAppRouting(mode, []));
  assert.throws(() => apps.validateAppRouting(mode, [apps.OWN_VPN_BUNDLE]));
  const bad = new policy.NetworkPolicy(); bad.appMode = mode;
  assert.throws(() => policy.validateNetworkPolicy(bad));
  assert.throws(() => apps.appRoutingScope('connection', mode, []));
});
test('native app scope is exclusive and includes self only where intended', () => {
  const selected = ['com.example.browser', 'com.example.mail'];
  const included = apps.appRoutingScope('connection', 'include', selected);
  assert.deepEqual(included.trustedApplications, [apps.OWN_VPN_BUNDLE, ...selected]);
  assert.equal(included.blockedApplications, undefined);
  const excluded = apps.appRoutingScope('connection', 'exclude', selected);
  assert.deepEqual(excluded.blockedApplications, selected); assert.equal(excluded.trustedApplications, undefined);
  selected.push('com.example.other'); assert.equal(excluded.blockedApplications.length, 2);
  const all = apps.appRoutingScope('connection', 'all', selected);
  assert.equal(all.trustedApplications, undefined); assert.equal(all.blockedApplications, undefined);
});
test('API24 limit reserves the final trusted application slot for self', () => {
  const names = Array.from({ length: 255 }, (_, n) => 'com.example.app' + n);
  assert.equal(apps.appRoutingScope('connection', 'include', names).trustedApplications.length, 256);
  assert.equal(apps.appRoutingScope('connection', 'exclude', names).blockedApplications.length, 255);
  assert.throws(() => apps.appRoutingScope('connection', 'all', [...names, 'com.example.toomany']));
});
test('temporary tests ignore saved application selections and remain self-only', () => {
  for (const kind of ['connection-app-test', 'node-latency', 'node', 'xray', 'reject']) {
    const scope = apps.appRoutingScope(kind, 'invalid-saved-mode', null);
    assert.deepEqual(scope.trustedApplications, [apps.OWN_VPN_BUNDLE]); assert.equal(scope.blockedApplications, undefined);
  }
  for (const kind of ['lifecycle', 'hev']) {
    const scope = apps.appRoutingScope(kind, 'include', ['com.example.browser']);
    assert.equal(scope.trustedApplications, undefined); assert.equal(scope.blockedApplications, undefined);
  }
});
test('all apps retains selection without affecting domain IP DNS core configuration', () => {
  const p = new policy.NetworkPolicy(); p.mode = 'rules'; p.direct = ['example.com'];
  const before = build(p); p.appBundles = ['com.example.browser'];
  assert.deepEqual(policy.validateNetworkPolicy(p).appBundles, p.appBundles);
  for (const mode of ['all', 'include', 'exclude']) { p.appMode = mode; assert.deepEqual(build(p), before); }
});
test('application scope labels do not imply domain rules are disabled', () => {
  assert.equal(apps.appRoutingLabel('all', 2), '全部应用');
  assert.equal(apps.appRoutingLabel('include', 2), '仅代理所选应用（2）');
  assert.equal(apps.appRoutingLabel('exclude', 2), '绕过所选应用（2）');
});
test('global ignores retained rules and custom DNS remains proxied', () => {
  const p = new policy.NetworkPolicy(); p.bypassLan = true; p.direct = ['0.0.0.0/0']; p.dnsUrl = 'https://8.8.8.8/dns-query';
  const c = build(p); assert(!c.outbounds.some(o => o.tag === 'direct')); assert.equal(c.dns.servers[0].address, p.dnsUrl);
  assert.equal(c.routing.rules.find(r => r.inboundTag?.includes('dns-via-node')).outboundTag, 'nodeProxy');
});
test('safety rules precede custom block proxy direct LAN and fallback', () => {
  const p = new policy.NetworkPolicy(); p.mode = 'rules'; p.bypassLan = true;
  p.block = ['example.com', '192.0.2.0/24']; p.proxy = ['full:api.example.com']; p.direct = ['0.0.0.0/0'];
  const c = build(p), r = c.routing.rules;
  assert.deepEqual(r[0].ip, ['::/0']); assert.equal(r[1].outboundTag, 'nodeProxy');
  assert.equal(r[2].outboundTag, 'dns-out'); assert.equal(r[3].outboundTag, 'block-virtual');
  assert.deepEqual(r.slice(4).map(x => x.outboundTag), ['rule-block', 'rule-block', 'nodeProxy', 'direct', 'direct', 'nodeProxy']);
  assert(r[4].domain && !r[4].ip); assert(r[5].ip && !r[5].domain);
  assert.equal(c.inbounds[0].sniffing.routeOnly, true); assert.equal(c.dns.disableFallback, true);
  assert.equal(c.outbounds.find(x => x.tag === 'direct').settings.domainStrategy, 'ForceIPv4');
});
test('DNS URL hostname goes through node and does not conflict with node bootstrap', () => {
  const p = new policy.NetworkPolicy(); p.dnsUrl = 'https://dns.example.com:443/dns-query';
  const c = build(p); assert.equal(c.dns.servers[0].address, p.dnsUrl); assert.equal(c.dns.hosts, undefined);
  const endpoint = JSON.parse(node); endpoint.settings.vnext[0].address = 'dns.example.com';
  assert.doesNotThrow(() => config.buildConnectionConfig(JSON.stringify(endpoint), 18900, 18901, '/log',
    new bootstrap.NodeBootstrap('dns.example.com', '192.0.2.21'), p));
});
for (const url of ['http://1.1.1.1/dns-query', 'https://user:secret@1.1.1.1/dns-query', 'https://1.1.1.1/dns-query#part',
  'https://1.1.1.1:0/dns-query', 'https://1.1.1.1:65536/dns-query']) {
  test('reject invalid DNS URL', () => { const p = new policy.NetworkPolicy(); p.dnsUrl = url; assert.throws(() => build(p)); });
}
function storeFixture() {
  const files = new Map(), handles = new Map(), state = { next: 0, allowed: true, failure: '', partial: 5 };
  const io = { OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 }, accessSync: p => files.has(p),
    statSync: p => ({ size: Buffer.byteLength(files.get(p)) }), readTextSync: p => files.get(p),
    openSync(p) { if (state.failure === 'open') throw Error('synthetic private error'); const fd = ++state.next; handles.set(fd, p); files.set(p, ''); return { fd }; },
    writeSync(fd, data) { if (state.failure === 'write') throw Error('write'); if (state.failure === 'zero') return 0;
      const part = Buffer.from(data).subarray(0, state.partial); files.set(handles.get(fd), files.get(handles.get(fd)) + part.toString()); return part.length; },
    fsyncSync() { if (state.failure === 'sync') throw Error('sync'); }, closeSync(f) { handles.delete(f.fd); },
    renameSync(a,b) { if (state.failure === 'rename') throw Error('rename'); files.set(b, files.get(a)); files.delete(a); }, unlinkSync: p => files.delete(p) };
  const api = load('NetworkPolicyStore', { '@kit.CoreFileKit': { fileIo: io }, '@kit.ArkTS': { util: {
    generateRandomUUID: () => String(++state.next), TextEncoder: class { encodeInto(s) { return new TextEncoder().encode(s); } } } },
    './NetworkPolicy': policy, './NodeEditGuard': { assertNodeManagementAllowed() { if (!state.allowed) throw Error('active'); } } });
  return { api, files, state };
}
test('missing store defaults, valid atomic save and readback', () => {
  const f = storeFixture(); assert.equal(f.api.readNetworkPolicy('/test').mode, 'global');
  const p = new policy.NetworkPolicy(); p.mode = 'rules'; f.api.saveNetworkPolicy('/test', p);
  assert.equal(f.api.readNetworkPolicy('/test').mode, 'rules'); assert.equal(f.files.size, 1);
});
test('legacy store read never writes back and explicit save persists new app schema', () => {
  const f = storeFixture(), destination = '/test/network-policy.json';
  const legacy = JSON.stringify({ schemaVersion: 1, mode: 'rules', bypassLan: false, direct: ['example.com'],
    proxy: [], block: [], dnsUrl: 'https://1.1.1.1/dns-query' });
  f.files.set(destination, legacy); const p = f.api.readNetworkPolicy('/test');
  assert.equal(p.schemaVersion, 2); assert.equal(f.files.get(destination), legacy); assert.equal(f.state.next, 0);
  p.appMode = 'include'; p.appBundles = ['com.example.browser']; f.api.saveNetworkPolicy('/test', p);
  const saved = JSON.parse(f.files.get(destination)); assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.appMode, 'include'); assert.deepEqual(saved.appBundles, ['com.example.browser']);
  assert.deepEqual(f.api.readNetworkPolicy('/test').appBundles, saved.appBundles);
});
test('invalid app settings cannot write or replace previously saved policy', () => {
  const f = storeFixture(); f.api.saveNetworkPolicy('/test', new policy.NetworkPolicy());
  const before = f.files.get('/test/network-policy.json');
  for (const mode of ['include', 'exclude']) {
    const p = new policy.NetworkPolicy(); p.appMode = mode;
    assert.throws(() => f.api.saveNetworkPolicy('/test', p)); assert.equal(f.files.get('/test/network-policy.json'), before);
  }
});
test('corruption is fail closed without overwriting file', () => {
  const f = storeFixture(); f.files.set('/test/network-policy.json', '{broken');
  assert.throws(() => f.api.readNetworkPolicy('/test')); assert.equal(f.files.get('/test/network-policy.json'), '{broken');
});
for (const failure of ['open','write','zero','sync','rename']) test('atomic store preserves previous on ' + failure, () => {
  const f = storeFixture(); f.api.saveNetworkPolicy('/test', new policy.NetworkPolicy()); const before = f.files.get('/test/network-policy.json');
  f.state.failure = failure; const p = new policy.NetworkPolicy(); p.mode = 'rules'; assert.throws(() => f.api.saveNetworkPolicy('/test', p));
  assert.equal(f.files.get('/test/network-policy.json'), before); assert.equal(f.files.size, 1);
});
test('active connection prevents preference mutation', () => {
  const f = storeFixture(); f.state.allowed = false; assert.throws(() => f.api.saveNetworkPolicy('/test', new policy.NetworkPolicy())); assert.equal(f.files.size, 0);
});
const fixturePolicy = new policy.NetworkPolicy(); fixturePolicy.mode = 'rules'; fixturePolicy.bypassLan = true;
fixturePolicy.block = ['full:blocked.example.com']; fixturePolicy.direct = ['192.0.2.0/24', 'direct.example.com'];
const outputDir = path.join(root, 'build/network-policy-tests'); fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'synthetic-core-config.json'), JSON.stringify(build(fixturePolicy), null, 2));
const sourceHashes = Object.fromEntries(['AppRouting', 'NetworkPolicy', 'NetworkPolicyStore', 'NodeBootstrap', 'ConnectionConfig'].map(name =>
  [name + '.ets', crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'entry/src/main/ets/model', name + '.ets'))).digest('hex')]));
fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ passed, sourceHashes,
  scope: 'synthetic policy/config/store, no device or network' }, null, 2));
console.log(`PASS ${passed} network policy checks`);
