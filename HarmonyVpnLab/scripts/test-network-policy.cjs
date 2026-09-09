'use strict';
// Execute the authored policy, config builder and atomic store with synthetic files.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
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
const bootstrap = load('NodeBootstrap'), policy = load('NetworkPolicy', { './NodeBootstrap': bootstrap });
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
fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ passed, scope: 'synthetic policy/config/store, no device or network' }, null, 2));
console.log(`PASS ${passed} network policy checks`);
