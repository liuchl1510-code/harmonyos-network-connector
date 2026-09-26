'use strict';
// Run the authored pure model and its policy dependencies with synthetic data.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const root = path.resolve(__dirname, '..'), model = path.join(root, 'entry/src/main/ets/model');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
function load(name, imports = {}) {
  const file = path.join(model, name + '.ets');
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0);
  const mod = new Module(file);
  mod.require = key => { assert(Object.hasOwn(imports, key), 'unexpected import ' + key); return imports[key]; };
  mod._compile(result.outputText, file); return mod.exports;
}
const bootstrap = load('NodeBootstrap'), apps = load('AppRouting');
const policy = load('NetworkPolicy', { './NodeBootstrap': bootstrap, './AppRouting': apps });
const fault = load('DnsFaultTest', { './NetworkPolicy': policy });
let passed = 0;
function test(name, action) { action(); passed++; console.log('PASS ' + name); }
const request = (changes = {}) => ({ kind: 'baseline', token: 'Abcd1234', createdAt: 100000, ...changes });

test('only the three fixed kinds are accepted', () => {
  for (const kind of ['baseline', 'http404', 'timeout']) assert.equal(fault.isDnsFaultKind(kind), true);
  for (const kind of ['', 'other', 'HTTP404', 'https://223.5.5.5/dns-query', 1, null, undefined, {}]) {
    assert.equal(fault.isDnsFaultKind(kind), false);
  }
});
test('request constructor preserves explicit fields with exactly three own keys', () => {
  const value = new fault.DnsFaultRequest('timeout', 'Aa123456', 0);
  assert.deepEqual({ ...value }, { kind: 'timeout', token: 'Aa123456', createdAt: 0 });
  assert.equal(fault.validDnsFaultRequestShape(value), true);
});
test('constructor default timestamp is an integer sampled at construction', () => {
  const before = Date.now(), value = new fault.DnsFaultRequest('baseline', 'Abcd1234'), after = Date.now();
  assert(Number.isSafeInteger(value.createdAt)); assert(value.createdAt >= before && value.createdAt <= after);
});
test('shape accepts fixed kinds and token length endpoints', () => {
  for (const kind of ['baseline', 'http404', 'timeout']) {
    for (const token of ['a'.repeat(8), 'Z9'.repeat(20)]) {
      assert.equal(fault.validDnsFaultRequestShape(request({ kind, token })), true);
    }
  }
});
test('shape rejects nonobjects and arrays', () => {
  for (const value of [undefined, null, 1, true, 'baseline', [], ['baseline', 'Abcd1234', 100000]]) {
    assert.equal(fault.validDnsFaultRequestShape(value), false);
  }
});
test('all three fields are mandatory own enumerable keys', () => {
  for (const key of ['kind', 'token', 'createdAt']) {
    const value = request(); delete value[key]; assert.equal(fault.validDnsFaultRequestShape(value), false);
  }
  assert.equal(fault.validDnsFaultRequestShape(Object.create(request())), false);
});
test('extra URL port config or credential fields cannot be admitted', () => {
  for (const extra of [{ url: 'https://example.test/query' }, { port: 8443 }, { configJSON: '{}' },
    { key: 'synthetic-key' }, { node: '{}' }, { ownerEpoch: 'other' }]) {
    const value = request(extra);
    assert.equal(fault.validDnsFaultRequestShape(value), false);
    assert.equal(fault.validDnsFaultAdmission(value, 100000), false);
  }
});
test('shape rejects unknown and nonstring kinds', () => {
  for (const kind of ['HTTP404', 'http404 ', 'https://example.test/', undefined, null, 404, {}, []]) {
    assert.equal(fault.validDnsFaultRequestShape(request({ kind })), false);
  }
});
test('tokens reject whitespace nonascii URL syntax and boundary lengths', () => {
  for (const token of ['', 'a'.repeat(7), 'a'.repeat(41), 'Abcd1234\n', 'Abcd1234\r', 'Abcd1234 ',
    ' Abcd1234', 'Abcd_1234', 'Abcd-1234', 'Abcd/1234', 'Abcd%1234', 'Abcd１２３４', 'Abcd1234\u0000',
    'https://example.test/', undefined, null, 12345678, {}, []]) {
    assert.equal(fault.validDnsFaultRequestShape(request({ token })), false);
  }
});
test('timestamp shape accepts zero and safe integer maximum independently of age', () => {
  for (const createdAt of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(fault.validDnsFaultRequestShape(request({ createdAt })), true);
  }
  assert.equal(fault.validDnsFaultRequestShape(request({ createdAt: 0 })), true);
  assert.equal(fault.validDnsFaultAdmission(request({ createdAt: 0 }), 30001), false);
});
test('timestamp shape rejects fractions negative unsafe and nonnumeric values', () => {
  for (const createdAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN, '100000', null, undefined]) {
    assert.equal(fault.validDnsFaultRequestShape(request({ createdAt })), false);
  }
});
test('admission window is inclusive from zero through thirty seconds', () => {
  for (const now of [100000, 100001, 129999, 130000]) assert.equal(fault.validDnsFaultAdmission(request(), now), true);
  for (const now of [99999, 130001, 999999]) assert.equal(fault.validDnsFaultAdmission(request(), now), false);
  assert.equal(fault.validDnsFaultAdmission(request({ createdAt: 0 }), 0), true);
  assert.equal(fault.validDnsFaultAdmission(request({ createdAt: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER), true);
});
test('admission rejects invalid clock values', () => {
  for (const now of [-1, 100000.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '100000', null]) {
    assert.equal(fault.validDnsFaultAdmission(request(), now), false);
  }
});
test('shape and admission never mutate the descriptor', () => {
  const value = Object.freeze(request()), before = JSON.stringify(value);
  assert.equal(fault.validDnsFaultRequestShape(value), true);
  assert.equal(fault.validDnsFaultAdmission(value, 110000), true);
  assert.equal(JSON.stringify(value), before);
});
test('URLs and admission budget are fixed constants', () => {
  assert.equal(fault.DNS_FAULT_NORMAL_URL, 'https://223.5.5.5/dns-query');
  assert.equal(fault.DNS_FAULT_HTTP404_URL, 'https://223.5.5.5/harmony-vpn-dns-invalid-path');
  assert.equal(fault.DNS_FAULT_ADMISSION_MS, 30000);
});
function originalPolicy() {
  const value = new policy.NetworkPolicy();
  Object.assign(value, { mode: 'rules', bypassLan: true, direct: ['domain:example.test'], proxy: ['full:api.example.test'],
    block: ['192.0.2.0/24'], dnsUrl: 'https://dns.example.test:8443/query', appMode: 'exclude',
    appBundles: ['com.Example.Reader'], dnsMode: 'proxy', directDnsUrl: 'https://9.9.9.9:8443/custom' });
  return value;
}
for (const kind of ['baseline', 'http404', 'timeout']) test(kind + ' returns an independent valid split policy and preserves all other preferences', () => {
  const original = originalPolicy(), before = JSON.stringify(original);
  for (const list of [original.direct, original.proxy, original.block, original.appBundles]) Object.freeze(list);
  Object.freeze(original);
  const result = fault.createDnsFaultPolicy(original, kind);
  assert.equal(JSON.stringify(original), before); assert.notEqual(result, original);
  const expected = JSON.parse(before);
  Object.assign(expected, { mode: 'whitelist', dnsMode: 'split', directDnsUrl: kind === 'http404'
    ? 'https://223.5.5.5/harmony-vpn-dns-invalid-path' : 'https://223.5.5.5/dns-query' });
  assert.deepEqual({ ...result }, expected);
  assert.doesNotThrow(() => policy.validateNetworkPolicy(result));
  for (const key of ['direct', 'proxy', 'block', 'appBundles']) {
    assert.notEqual(result[key], original[key]); result[key].push(key === 'appBundles' ? 'com.example.Other' : 'domain:other.test');
    assert.equal(JSON.stringify(original), before);
  }
});
test('legacy policy migration stays in returned memory and retains original bytes', () => {
  const original = { schemaVersion: 1, mode: 'global', bypassLan: true, direct: ['Example.Test'], proxy: [], block: [],
    dnsUrl: 'https://8.8.8.8/dns-query' }, before = JSON.stringify(original);
  const result = fault.createDnsFaultPolicy(original, 'baseline');
  assert.equal(JSON.stringify(original), before); assert.equal(result.schemaVersion, 3);
  assert.equal(result.mode, 'whitelist'); assert.equal(result.dnsMode, 'split');
  assert.equal(result.dnsUrl, original.dnsUrl); assert.deepEqual(result.direct, ['domain:example.test']);
});
test('policy creation rejects arbitrary kind URL and invalid preference schema', () => {
  for (const kind of ['https://example.test/query', 'http404?url=other', 'other', '', null, 404]) {
    assert.throws(() => fault.createDnsFaultPolicy(originalPolicy(), kind), /DNS 故障测试类型无效/);
  }
  for (const value of [null, {}, { ...originalPolicy(), arbitraryURL: 'https://example.test/query' }]) {
    assert.throws(() => fault.createDnsFaultPolicy(value, 'baseline'));
  }
});
console.log(JSON.stringify({ passed, realNetworkUsed: false, preferencesSaved: false }));
