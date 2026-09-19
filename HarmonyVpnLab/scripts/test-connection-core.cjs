/* Offline synthetic checks; SDK/native APIs are mocked. No real network or node file. */
const fs = require('fs'), path = require('path'), Module = require('module'), assert = require('assert'), crypto = require('crypto');
const project = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
function load(relative, imports = {}) {
  const filename = path.join(project, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(output.diagnostics.length, 0, relative);
  const module = new Module(filename);
  module.require = key => { if (Object.hasOwn(imports, key)) return imports[key]; throw new Error('Unexpected test import ' + key); };
  module._compile(output.outputText, filename);
  return module.exports;
}
const bootstrapModule = load('entry/src/main/ets/model/NodeBootstrap.ets');
const appsModule = load('entry/src/main/ets/model/AppRouting.ets');
const policyModule = load('entry/src/main/ets/model/NetworkPolicy.ets', { './NodeBootstrap': bootstrapModule, './AppRouting': appsModule });
const configModule = load('entry/src/main/ets/model/ConnectionConfig.ets', { './NodeBootstrap': bootstrapModule, './NetworkPolicy': policyModule });
const snapshotModule = load('entry/src/main/ets/model/ConnectionSnapshot.ets');
const failureModule = load('entry/src/main/ets/model/ConnectionFailure.ets');
const uuid = 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60';
const fixtures = [];
const hostnameFixtures = [];
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function uuidOutbound(protocol, streamSettings) {
  return { protocol, settings: { vnext: [{ address: '198.51.100.10', port: 443,
    users: [{ id: uuid, encryption: 'none', alterId: 0 }] }] }, streamSettings };
}
const samples = [
  ['vless tcp A-only', uuidOutbound('vless', { network: 'tcp', security: 'none' })],
  ['vless tls A-only', uuidOutbound('vless', { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'sni.invalid' } })],
  ['vless reality A-only', uuidOutbound('vless', { network: 'raw', security: 'reality', realitySettings: {
    serverName: 'sni.invalid', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', fingerprint: 'chrome', shortId: '0123', show: true } })],
  ['vmess AEAD A-only', uuidOutbound('vmess', { network: 'ws', security: 'tls', tlsSettings: { serverName: 'sni.invalid' }, wsSettings: { path: '/synthetic' } })],
  ['trojan tls A-only', { protocol: 'trojan', settings: { servers: [{ address: '198.51.100.11', port: 443, password: 'synthetic-password' }] },
    streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'sni.invalid' } } }],
  ['shadowsocks A-only', { protocol: 'shadowsocks', settings: { servers: [{ address: '198.51.100.12', port: 8388, method: 'aes-128-gcm', password: 'synthetic-password' }] } }]
];
for (const [name, outbound] of samples) {
  check(name, () => {
    const original = JSON.stringify(outbound);
    const configJSON = configModule.buildConnectionConfig(original, 18900, 18901, '/synthetic/xray-connection.log');
    const config = JSON.parse(configJSON);
    assert.equal(JSON.stringify(outbound), original);
    assert.equal(config.outbounds[0].tag, 'nodeProxy');
    assert.equal(config.dns.servers.length, 1);
    assert.equal(config.dns.servers[0].address, 'https://1.1.1.1/dns-query');
    assert.equal(config.dns.disableFallback, true);
    assert.equal(config.dns.useSystemHosts, false);
    assert.equal(config.dns.queryStrategy, 'UseIPv4');
    assert.equal(config.routing.domainStrategy, 'AsIs');
    assert.deepEqual(config.routing.rules[0], { type: 'field', ip: ['::/0'], outboundTag: 'block-ipv6' });
    assert.equal(config.outbounds.find(o => o.tag === 'block-ipv6').protocol, 'blackhole');
    assert(config.routing.rules.some(r => r.inboundTag?.includes('dns-via-node') && r.outboundTag === 'nodeProxy'));
    assert(config.routing.rules.some(r => r.port === '53' && r.outboundTag === 'dns-out' && r.network === 'tcp,udp'));
    const dns = config.outbounds.find(o => o.protocol === 'dns');
    assert.deepEqual(dns.settings.rules, [{ action: 'return', qType: '28', rCode: 0 }, { action: 'hijack', qType: '1' }, { action: 'return', rCode: 0 }]);
    assert(!config.outbounds.some(o => o.protocol === 'freedom'));
    assert(!configJSON.includes('+local') && !configJSON.includes('localhost'));
    if (outbound.streamSettings?.realitySettings) assert.equal(config.outbounds[0].streamSettings.realitySettings.show, false);
    fixtures.push({ name, configJSON });
  });
}
check('hostname missing bootstrap rejected without echoing endpoint', () => {
  const outbound = uuidOutbound('vless', { network: 'tcp', security: 'none' });
  outbound.settings.vnext[0].address = 'private-synthetic.invalid';
  assert.throws(() => configModule.buildConnectionConfig(JSON.stringify(outbound), 18900, 18901, '/synthetic/log'),
    e => e.message.includes('IPv4') && !e.message.includes(outbound.settings.vnext[0].address) && !e.message.includes(uuid));
});
check('bootstrap host normalization and endpoint binding', () => {
  assert.equal(bootstrapModule.normalizeBootstrapHost('Node.Example.Test.'), 'node.example.test');
  assert.equal(bootstrapModule.normalizeBootstrapHost('192.0.2.123'), '192.0.2.123');
  assert.equal(bootstrapModule.normalizeBootstrapHost('a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61)).length, 253);
  for (const host of ['', 'node..test', 'node.test..', '-node.test', 'node-.test', 'node_test', 'node:test',
    'node/test', 'node test', 'node\u0000test', 'éxample.test', '01.2.3.4', '256.2.3.4', '1.2.3', '1.2.3.4.',
    'a'.repeat(64) + '.test', 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(62)]) {
    assert.throws(() => bootstrapModule.normalizeBootstrapHost(host), e => !e.message.includes('node..test'));
  }
  const outbound = uuidOutbound('vless', { network: 'tcp', security: 'none' });
  outbound.settings.vnext[0].address = 'Node.Example.Test.';
  const pin = bootstrapModule.createNodeBootstrap(JSON.stringify(outbound), '192.0.2.123');
  assert.deepEqual({ ...pin }, { host: 'node.example.test', ipv4: '192.0.2.123' });
  const invalidOutbounds = [null, [], {}, { protocol: 'socks', settings: outbound.settings },
    { protocol: 'vless', settings: { vnext: [] } }, { protocol: 'vless', settings: { vnext: [null] } },
    { protocol: 'vless', settings: { vnext: [...outbound.settings.vnext, ...outbound.settings.vnext] } }];
  for (const invalid of invalidOutbounds) assert.throws(() => bootstrapModule.createNodeBootstrap(JSON.stringify(invalid), '192.0.2.123'));
  assert.throws(() => bootstrapModule.createNodeBootstrap('{bad-json', '192.0.2.123'));
  assert.throws(() => bootstrapModule.createNodeBootstrap(JSON.stringify(samples[0][1]), '192.0.2.123'));
});
check('wrong, mutated and invalid bootstrap rejected', () => {
  const outbound = uuidOutbound('vless', { network: 'tcp', security: 'none' });
  outbound.settings.vnext[0].address = 'node.example.test';
  for (const pin of [null, {}, { host: 'wrong.example.test', ipv4: '192.0.2.123' },
    { host: 'node.example.test', ipv4: '01.2.3.4' }, { host: 'node.example.test', ipv4: '2001:db8::1' }]) {
    assert.throws(() => configModule.buildConnectionConfig(JSON.stringify(outbound), 18900, 18901, '/synthetic/log', pin));
  }
  for (const invalidIp of ['', '1.2.3', '01.2.3.4', '300.2.3.4', '2001:db8::1', 'pin.example.test']) {
    assert.throws(() => new bootstrapModule.NodeBootstrap('node.example.test', invalidIp));
  }
  assert.throws(() => configModule.buildConnectionConfig(JSON.stringify(samples[0][1]), 18900, 18901, '/synthetic/log',
    { host: '198.51.100.10', ipv4: '192.0.2.123' }));
});
for (const [name, stream] of [
  ['hostname raw default SNI', { network: 'raw', security: 'tls', tlsSettings: { allowInsecure: false } }],
  ['hostname ws explicit Host SNI', { network: 'ws', security: 'tls', tlsSettings: { serverName: 'sni.example.test', alpn: ['http/1.1'] },
    wsSettings: { host: 'front.example.test', path: '/synthetic?ed=2560' }, sockopt: { tcpFastOpen: true, domainStrategy: 'UseIPv6' } }],
  ['hostname grpc explicit authority SNI', { network: 'grpc', security: 'tls', tlsSettings: { serverName: 'sni.example.test' },
    grpcSettings: { authority: 'authority.example.test', serviceName: 'synthetic', multiMode: false } }],
  ['hostname reality preserved', { network: 'raw', security: 'reality', realitySettings: {
    serverName: 'sni.example.test', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', fingerprint: 'chrome', shortId: '0123', show: false } }]
]) {
  check(name, () => {
    const outbound = uuidOutbound('vless', stream);
    outbound.settings.vnext[0].address = 'Node.Example.Test.';
    const original = JSON.stringify(outbound);
    const pin = bootstrapModule.createNodeBootstrap(original, '192.0.2.123');
    const configJSON = configModule.buildConnectionConfig(original, 18900, 18901, '/synthetic/log', pin);
    const config = JSON.parse(configJSON);
    assert.deepEqual(config.dns.hosts, { 'full:node.example.test': '192.0.2.123' });
    const expected = JSON.parse(original);
    expected.tag = 'nodeProxy';
    expected.streamSettings.sockopt = { ...expected.streamSettings.sockopt, domainStrategy: 'ForceIPv4' };
    assert.deepEqual(config.outbounds[0], expected, 'only session tag and dial strategy can change');
    assert.equal(JSON.stringify(outbound), original, 'saved outbound is untouched');
    hostnameFixtures.push({ name, configJSON });
  });
}
check('hostname pin supports missing stream and servers protocols', () => {
  for (const protocol of ['shadowsocks', 'trojan']) {
    const outbound = JSON.parse(JSON.stringify(samples.find(([, item]) => item.protocol === protocol)[1]));
    outbound.settings.servers[0].address = 'node.example.test';
    const source = JSON.stringify(outbound);
    const config = JSON.parse(configModule.buildConnectionConfig(source, 18900, 18901, '/synthetic/log',
      bootstrapModule.createNodeBootstrap(source, '192.0.2.123')));
    assert.equal(config.outbounds[0].settings.servers[0].address, 'node.example.test');
    assert.equal(config.outbounds[0].streamSettings.sockopt.domainStrategy, 'ForceIPv4');
  }
});
check('extra SRV TXT and ECH bootstrap paths rejected for IP and hostname nodes', () => {
  for (const address of ['198.51.100.10', 'node.example.test']) {
    const base = uuidOutbound('vless', { network: 'tcp', security: 'tls', tlsSettings: {} });
    base.settings.vnext[0].address = address;
    const pin = bootstrapModule.createNodeBootstrap(JSON.stringify(base), address.includes('example') ? '192.0.2.123' : address);
    for (const streamSettings of [
      { sockopt: { addressPortStrategy: 'SrvPortOnly' } }, { sockopt: { addressPortStrategy: 'TxtAddressOnly' } },
      { sockopt: { AddressPortStrategy: 'SrvPortOnly' } },
      { sockopt: { addressPortStrategy: 1 } }, { sockopt: null },
      { tlsSettings: { echConfigList: 'https://resolver.example.test/dns-query' } },
      { tlsSettings: { echConfigList: 'AQID' } }, { tlsSettings: { echConfigList: false } },
      { tlsSettings: { echSockopt: { domainStrategy: 'AsIs' } } },
      { tlsSettings: { ECHConfigList: 'https://resolver.example.test/dns-query' } },
      { tlsSettings: { ECHSockOpt: { domainStrategy: 'AsIs' } } }
    ]) {
      assert.throws(() => configModule.buildConnectionConfig(JSON.stringify({ ...base, streamSettings }), 18900, 18901, '/synthetic/log', pin));
    }
    const inert = { ...base, streamSettings: { ...base.streamSettings, sockopt: { addressPortStrategy: 'none' },
      tlsSettings: { echConfigList: '', echSockopt: {} } } };
    assert.doesNotThrow(() => configModule.buildConnectionConfig(JSON.stringify(inert), 18900, 18901, '/synthetic/log', pin));
  }
});
check('domain strategy aliases rejected in either JSON key order', () => {
  for (const address of ['198.51.100.10', 'node.example.test']) {
    const outbound = uuidOutbound('vless', { network: 'tcp', security: 'none' });
    outbound.settings.vnext[0].address = address;
    const pin = bootstrapModule.createNodeBootstrap(JSON.stringify(outbound), address.includes('example') ? '192.0.2.123' : address);
    for (const sockopt of [
      { domainStrategy: 'UseIPv4', DomainStrategy: 'UseIPv6' },
      { DomainStrategy: 'UseIPv6', domainStrategy: 'UseIPv4' },
      { DOMAINSTRATEGY: 'AsIs' }
    ]) {
      outbound.streamSettings.sockopt = sockopt;
      assert.throws(() => configModule.buildConnectionConfig(JSON.stringify(outbound), 18900, 18901, '/synthetic/log', pin),
        /域名解析选项需要使用受支持的字段格式/);
    }
  }
});
check('IPv6 node bootstrap rejected', () => {
  const outbound = uuidOutbound('vless', { network: 'tcp', security: 'none' });
  outbound.settings.vnext[0].address = '2001:db8::1';
  assert.throws(() => configModule.buildConnectionConfig(JSON.stringify(outbound), 18900, 18901, '/synthetic/log'));
});
check('ambiguous IPv4 and colliding listener ports rejected', () => {
  for (const ip of ['1.2.3', '01.2.3.4', '256.2.3.4', '1.2.3.4.example']) assert.equal(configModule.isConnectionIpv4Address(ip), false);
  assert.throws(() => configModule.buildConnectionConfig(JSON.stringify(samples[0][1]), 18900, 18900, '/synthetic/log'));
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const encodedReply = data => Buffer.from(JSON.stringify({ success: true, data })).toString('base64');
function harness(options = {}) {
  const state = { calls: [], logs: [], files: new Map(), counts: { uplink: 0, downlink: 0 },
    protection: { requests: 0, succeeded: 0, failed: 0, timedOut: 0, active: 0 },
    forwarding: { hevRunning: true, hevExit: 0 }, startGate: null, startEntered: deferred(), fd: 1,
    coreActive: false, httpRequests: 0, diagnosticTcpConnects: 0 };
  const outboundJson = JSON.stringify(samples[2][1]);
  const native = {
    getFreePorts: () => JSON.stringify({ socksPort: 18900, metricsPort: 18901 }),
    configureXrayCa: async () => { state.calls.push('ca'); if (options.failAt === 'ca') throw Error('private secret'); },
    installSocketProtector: () => { state.calls.push('protector'); },
    xrayCall: async (operation, request) => {
      state.calls.push(operation);
      if (options.failAt === operation) throw Error('private secret');
      if (operation === 'version') return encodedReply('26.6.1');
      if (operation === 'runtime') return encodedReply({ unixMillis: Date.now() + (options.clockSkew || 0), goVersion: 'go1.26.7', goos: 'linux', goarch: 'arm64' });
      if (operation === 'start') {
        const input = JSON.parse(Buffer.from(request, 'base64').toString());
        state.config = JSON.parse(input.configJSON);
        state.startEntered.resolve();
        if (state.startGate) await state.startGate.promise;
        state.coreActive = true;
      }
      if (operation === 'stop') state.coreActive = false;
      if (operation === 'stats') {
        assert.equal(request, '');
        if (!state.coreActive) return Buffer.from(JSON.stringify({ success: false, error: 'synthetic core inactive' })).toString('base64');
        return encodedReply(state.counts);
      }
      return encodedReply('');
    },
    startHev: async (fd, port, ipv6) => { state.calls.push(['hev-start', fd, port, ipv6]); if (options.failAt === 'hev-start') throw Error('private secret'); },
    stopHev: async () => { state.calls.push('hev-stop'); if (options.failAt === 'hev-stop') throw Error('private secret'); },
    socketProtectionStats: () => JSON.stringify(state.protection),
    forwardingStatus: () => JSON.stringify(state.forwarding)
  };
  const fileIo = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    openSync: name => { state.files.set(name, ''); return { fd: state.fd++ }; },
    closeSync: () => {}, accessSync: name => state.files.has(name),
    statSync: name => ({ size: Buffer.byteLength(state.files.get(name)) }),
    readTextSync: (name, options = {}) => Buffer.from(state.files.get(name)).subarray(options.offset || 0,
      options.length === undefined ? undefined : (options.offset || 0) + options.length).toString(),
    truncateSync: name => { state.files.set(name, ''); }
  };
  const imports = {
    '@kit.ArkTS': { util: {
      Base64Helper: class { decodeSync(s) { return Buffer.from(s, 'base64'); } encodeToStringSync(b) { return Buffer.from(b).toString('base64'); } },
      TextDecoder: class { decodeToString(b) { return Buffer.from(b).toString(); } },
      TextEncoder: class { encodeInto(s) { return Buffer.from(s); } }
    } },
    'libvpnbridge.so': { default: native },
    '@kit.PerformanceAnalysisKit': { hilog: { info: (...a) => state.logs.push(a), warn: (...a) => state.logs.push(a) } },
    '@kit.AbilityKit': {},
    '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => Number(process.hrtime.bigint() / 1000000n) } },
    '@kit.NetworkKit': { socket: { constructTCPSocketInstance: () => {
      if (!options.diagnosticNode) throw new Error('Unexpected direct node preflight');
      return { connect: async () => { state.diagnosticTcpConnects++; }, close: async () => {} };
    } }, http: { createHttp: () => { state.httpRequests++; throw new Error('Counters must not use HTTP metrics'); } } },
    './CaBundle': { prepareCaBundle: async () => '/synthetic/mozilla-ca.pem' },
    '../model/NodeProfile': { readNodeProfile: () => ({ outboundJson }), nodeEndpoint: () => {
      if (!options.diagnosticNode) throw new Error('Unexpected probe-only endpoint path');
      return { address: '198.51.100.10', port: 443, protocol: 'vless', network: 'raw', security: 'reality' };
    } },
    '../model/NodeImport': { parseNode: value => { if (options.failAt === 'configuration') throw Error('private secret'); return { outboundJson: value }; } },
    '../model/ErrorInfo': { describeError: () => 'synthetic error' },
    '../model/ConnectionConfig': configModule,
    '../model/NodeBootstrap': bootstrapModule,
    '../model/NetworkPolicy': policyModule,
    '../model/ConnectionSnapshot': snapshotModule,
    '../model/ConnectionFailure': failureModule,
    '@kit.CoreFileKit': { fileIo }
  };
  const { CoreProbe } = load('entry/src/main/ets/vpn/CoreProbe.ets', imports);
  return { state, core: new CoreProbe() };
}

async function main() {
  for (const [failAt, stage] of [['configuration','configuration'], ['ca','core-init'], ['version','core-init'],
    ['runtime','runtime-clock'], ['start','core-init'], ['stats','status'], ['hev-start','forwarding']]) {
    const { core, state } = harness({ failAt });
    await assert.rejects(core.startConnection(7, { filesDir: '/synthetic' }, async () => {}), error =>
      error instanceof failureModule.ConnectionFailureError && error.failure.stage === stage && !String(error).includes('secret'));
    assert.equal(state.diagnosticTcpConnects, 0); assert.equal(state.httpRequests, 0);
    passed++; console.log('PASS typed actual core operation failure: ' + failAt);
  }
  {
    const { core, state } = harness({ clockSkew: 20000 });
    await assert.rejects(core.startConnection(7, { filesDir: '/synthetic' }, async () => {}), error => error.failure?.stage === 'runtime-clock');
    assert(!state.calls.includes('start'));
    passed++; console.log('PASS runtime clock mismatch fails before starting the core');
  }
  {
    const { core } = harness({ failAt: 'hev-stop' });
    await core.startConnection(7, { filesDir: '/synthetic' }, async () => {});
    await assert.rejects(core.stop(), error => error.failure?.stage === 'cleanup' && !String(error).includes('secret'));
    passed++; console.log('PASS cleanup failure has a separate fixed classification');
  }
  {
    const { state, core } = harness();
    await core.startConnection(7, { filesDir: '/synthetic' }, async () => {});
    assert(state.calls.some(c => Array.isArray(c) && c.join(',') === 'hev-start,7,18900,true'));
    state.counts = { uplink: 300, downlink: 500 };
    state.protection = { requests: 1, succeeded: 1, failed: 0, timedOut: 0, active: 0 };
    state.files.set('/synthetic/xray-connection-diagnostic.log',
      '[Info] app/dispatcher: taking detour [dns-out] for [udp:198.18.0.1:53]\n' +
      '[Info] app/dispatcher: taking detour [block-ipv6] for [tcp:[2001:db8::2]:443]\n');
    const snapshot = await core.readConnectionSnapshot();
    assert.equal(snapshot.active, true); assert.equal(snapshot.uplink, 300); assert.equal(snapshot.downlink, 500);
    assert.equal(snapshot.dnsRequests, 1); assert.equal(snapshot.ipv6BlockedRequests, 1);
    assert.equal((await core.readConnectionSnapshot()).ipv6BlockedRequests, 1, 'do not recount consumed logs');
    assert(!JSON.stringify(snapshot).includes(uuid));
    assert(!JSON.stringify(snapshot).includes('198.51.100.10'));
    assert(!JSON.stringify(state.logs).includes(uuid));
    assert.equal(core.detectOutboundLoop(), false);
    const logPath = '/synthetic/xray-connection-diagnostic.log';
    state.files.set(logPath, state.files.get(logPath) + 'x'.repeat(1048576) + '\n' +
      '[Info] app/dispatcher: taking detour [block-ipv6] for [tcp:[2001:db8::3]:443]\n');
    const rotated = await core.readConnectionSnapshot();
    assert.equal(rotated.active, true);
    assert.equal(rotated.ipv6BlockedRequests, 2);
    assert.equal(rotated.dnsRequests, 1);
    assert.equal(state.files.get(logPath), '');
    assert(!state.calls.includes('hev-stop') && !state.calls.includes('stop'));
    passed++; console.log('PASS diagnostic size rotation keeps connection and cumulative counts');
    await core.stop();
    assert(state.calls.indexOf('hev-stop') < state.calls.lastIndexOf('stop'));
    await assert.rejects(core.readConnectionSnapshot());
    assert.equal(state.httpRequests, 0); assert(state.calls.includes('stats')); assert.equal(state.config.metrics, undefined);
    passed++; console.log('PASS persistent startup, safe snapshot, classified logs and ordered stop');
  }
  {
    const { state, core } = harness();
    await core.startConnection(7, { filesDir: '/synthetic' }, async () => {});
    state.forwarding = { hevRunning: false, hevExit: 1 };
    await assert.rejects(core.readConnectionSnapshot(), error => error.failure?.stage === 'forwarding');
    await core.stop();
    passed++; console.log('PASS stopped forwarding worker rejected by heartbeat snapshot');
  }
  {
    const { state, core } = harness();
    state.startGate = deferred();
    const starting = core.startConnection(7, { filesDir: '/synthetic' }, async () => {});
    const rejected = assert.rejects(starting, error => error instanceof failureModule.ConnectionFailureError);
    await state.startEntered.promise;
    const stopping = core.stop();
    await Promise.resolve();
    assert(!state.calls.includes('stop'), 'stop must drain an in-flight native start');
    state.startGate.resolve();
    await rejected; await stopping;
    assert(state.calls.includes('stop'));
    assert(!state.calls.some(c => Array.isArray(c) && c[0] === 'hev-start'));
    passed++; console.log('PASS cancellation drains late start before native cleanup');
  }
  {
    const { state, core } = harness({ diagnosticNode: true });
    await core.startNode(7, { filesDir: '/synthetic' }, async () => {});
    assert.equal(state.diagnosticTcpConnects, 1); assert.equal(state.config.metrics, undefined);
    state.counts = { uplink: 10, downlink: 20 };
    state.protection = { requests: 1, succeeded: 1, failed: 0, timedOut: 0, active: 0 };
    await core.verifyNodeTraffic(); await core.logNodeTraffic();
    assert.equal(state.httpRequests, 0); assert(state.calls.filter(x => x === 'stats').length >= 3);
    await core.stop(); const callsBefore = state.calls.length;
    await assert.rejects(core.readCounters()); assert.equal(state.calls.length, callsBefore, 'stopped core counters are never reused');
    passed++; console.log('PASS diagnostic node uses direct current-core stats with no metrics listener or HTTP');
  }
  {
    const { state, core } = harness();
    await core.startConnection(7, { filesDir: '/synthetic' }, async () => {});
    for (const invalid of [undefined, null, {}, { uplink: -1, downlink: 0 }, { uplink: 0, downlink: -1 },
      { uplink: '1', downlink: 2 }, { uplink: 1, downlink: '2' }, { uplink: NaN, downlink: 2 },
      { uplink: 1, downlink: Infinity }]) {
      state.counts = invalid; await assert.rejects(core.readCounters());
    }
    state.counts = { uplink: 0, downlink: 0 }; assert.equal((await core.readCounters()).uplink, 0);
    await core.stop(); assert.equal(state.httpRequests, 0);
    passed++; console.log('PASS native counter reply rejects missing negative nonnumeric and nonfinite values');
  }
  const build = path.join(project, 'build'); fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'connection-core-fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n');
  fs.writeFileSync(path.join(build, 'connection-hostname-fixtures.json'), JSON.stringify(hostnameFixtures, null, 2) + '\n');
  // Bypass the application builder only for real-loader negative controls.
  // Go's decoder is case-insensitive and processes duplicate aliases in order.
  for (const [label, sockopt] of [
    ['alias-last', { domainStrategy: 'ForceIPv4', DomainStrategy: 'UseIPv6' }],
    ['canonical-last', { DomainStrategy: 'UseIPv6', domainStrategy: 'ForceIPv4' }]
  ]) {
    const altered = JSON.parse(JSON.stringify(hostnameFixtures));
    const first = JSON.parse(altered[0].configJSON);
    first.outbounds[0].streamSettings.sockopt = sockopt;
    altered[0].configJSON = JSON.stringify(first);
    fs.writeFileSync(path.join(build, `connection-hostname-${label}-fixtures.json`), JSON.stringify(altered, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(build, 'connection-core-offline-tests.json'), JSON.stringify({
    passed, fixtures: fixtures.length, hostnameFixtures: hostnameFixtures.length, realNetworkUsed: false, privateNodeRead: false,
    scope: 'Pure config plus mocked SDK/native lifecycle; real ArkTS and device checks separate',
    dnsScope: 'A via routed DoH; AAAA and all other qtypes empty NOERROR, no raw forwarding',
    configSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'entry/src/main/ets/model/ConnectionConfig.ets'))).digest('hex'),
    bootstrapSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'entry/src/main/ets/model/NodeBootstrap.ets'))).digest('hex'),
    appRoutingSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'entry/src/main/ets/model/AppRouting.ets'))).digest('hex'),
    networkPolicySourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'entry/src/main/ets/model/NetworkPolicy.ets'))).digest('hex'),
    coreProbeSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'entry/src/main/ets/vpn/CoreProbe.ets'))).digest('hex'),
    connectionFailureSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'entry/src/main/ets/model/ConnectionFailure.ets'))).digest('hex')
  }, null, 2) + '\n');
  console.log(`Offline connection checks passed: ${passed}; synthetic core fixtures: ${fixtures.length}`);
}
main().catch(error => { console.error('FAIL offline connection check:', error.message); process.exitCode = 1; });
