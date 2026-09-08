/* Offline checks of the authored ArkTS module, with SDK mocks and monotonic time.
 * No network or device calls; no private files. Run: node scripts/test-physical-network.cjs
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const project = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const filename = path.join(project, 'entry/src/main/ets/model/PhysicalNetwork.ets');
const source = fs.readFileSync(filename, 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(output.diagnostics.length, 0);
const HOST = 'private-node.synthetic.invalid', IP = '192.0.2.8';
const RAW = new Error(`https://${HOST}/?token=synthetic-secret address=${IP}`);
const EVENTS = ['netAvailable', 'netLost', 'netUnavailable', 'netCapabilitiesChange',
  'netConnectionPropertiesChange', 'netBlockStatusChange'];
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject }; }
function observe(promise) {
  const result = { settled: false };
  result.done = promise.then(value => { result.settled = true; result.value = value; },
    error => { result.settled = true; result.error = error; });
  return result;
}
function harness(options = {}) {
  const state = { now: 1000, nextTimer: 1, timers: new Map(), netId: 100, bearer: 1, caps: [12, 15],
    defaults: 0, capabilities: 0, propertyCalls: 0, dns: [], created: [], calls: [], logs: [], current: true,
    properties: { interfaceName: 'synthetic-wlan0', domains: '', mtu: 1500,
      linkAddresses: [{ address: { address: '192.0.2.20', family: 1 }, prefixLength: 24 }],
      dnses: [{ address: '192.0.2.53', family: 1 }], routes: [{ interface: 'synthetic-wlan0',
        destination: { address: { address: '0.0.0.0', family: 1 }, prefixLength: 0 },
        gateway: { address: '192.0.2.1', family: 1 }, hasGateway: true, isDefaultRoute: true }] } };
  const connection = {
    NetCap: { NET_CAPABILITY_INTERNET: 12, NET_CAPABILITY_NOT_VPN: 15 },
    NetBearType: { BEARER_CELLULAR: 0, BEARER_WIFI: 1, BEARER_ETHERNET: 3, BEARER_VPN: 4 },
    FamilyType: { FAMILY_TYPE_IPV4: 1 },
    getDefaultNet() {
      state.defaults++;
      if (options.defaultThrow) throw RAW;
      if (options.defaultCall) return options.defaultCall(state.defaults, state);
      return Promise.resolve(handle(state.netId));
    },
    getNetCapabilities(net) {
      state.capabilities++;
      assert(net.netId >= 0);
      if (options.capsThrow) throw RAW;
      if (options.capsCall) return options.capsCall(state.capabilities, state);
      return Promise.resolve({ bearerTypes: [state.bearer], networkCap: state.caps });
    },
    getConnectionProperties(net) {
      assert(net.netId >= 0); state.propertyCalls++;
      if (options.propertiesThrow) throw RAW;
      if (options.propertiesCall) return options.propertiesCall(state.propertyCalls, state);
      return Promise.resolve(state.properties);
    },
    getAddressesByName() { throw new Error('Forbidden global DNS'); },
    getAddressesByNameWithOptions() { throw new Error('Forbidden global DNS'); },
    createNetConnection(...args) {
      assert.equal(args.length, 0, 'Use the physical default network request');
      if (options.createThrow) throw RAW;
      const obj = { handlers: new Map(), registerCalls: 0, unregisterCalls: 0,
        on(event, fn) {
          state.calls.push('on:' + event);
          if (options.onThrow === event) throw RAW;
          obj.handlers.set(event, fn);
        },
        register(callback) {
          obj.registerCalls++; state.calls.push('register'); obj.registerCallback = callback;
          for (const event of EVENTS) assert(obj.handlers.has(event), 'on() must precede register()');
          if (options.registerThrow) throw RAW;
          if (!options.deferRegister) callback(options.registerError ? { code: 2100003, message: RAW.message } : undefined);
        },
        unregister(callback) {
          obj.unregisterCalls++; state.calls.push('unregister'); obj.unregisterCallback = callback;
          if (options.unregisterThrow) throw RAW;
          if (!options.deferUnregister) callback(options.unregisterError);
        }
      };
      state.created.push(obj); return obj;
    }
  };
  function handle(netId) {
    return { netId, getAddressesByNameWithOptions(host, queryOptions) {
      state.dns.push({ netId, host, options: queryOptions });
      if (options.dnsThrow) throw RAW;
      if (options.dnsCall) return options.dnsCall(state);
      return Promise.resolve(options.addresses || [{ address: IP, family: 1, port: 0 }]);
    } };
  }
  const imports = { '@kit.NetworkKit': { connection }, '@kit.BasicServicesKit': { systemDateTime: {
    TimeType: { STARTUP: 0 }, getUptime(kind, nanos) {
      assert.equal(kind, 0); assert.equal(nanos, false);
      if (options.clockThrow) throw RAW;
      return state.now;
    }
  } } };
  const context = { exports: {}, require(name) { assert(Object.hasOwn(imports, name)); return imports[name]; },
    setTimeout(callback, ms) { const id = state.nextTimer++; state.timers.set(id, { at: state.now + ms, callback }); return id; },
    clearTimeout(id) { state.timers.delete(id); }, console: {} };
  for (const name of ['log', 'warn', 'error', 'debug', 'info']) context.console[name] = (...x) => state.logs.push(x);
  // Introspection only: tests assert retention of the actual production owner list.
  vm.runInNewContext(output.outputText + '\nexports.__retainedCount = () => retainedRegistrations.length;' +
    '\nexports.__networkFromProperties = networkFromProperties;', context,
    { filename });
  return { state, api: context.exports, handle, options,
    resolve() { return observe(context.exports.resolvePhysicalIpv4(HOST,
      context.exports.__networkFromProperties(100, { bearerTypes: [1], networkCap: [12, 15] }, state.properties),
      () => state.current)); },
    emit(event = 'netAvailable') { for (const obj of state.created) obj.handlers.get(event)?.({ secret: RAW.message }); },
    async advance(ms, fire = true) {
      const end = state.now + ms;
      if (fire) for (;;) {
        const due = [...state.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        state.now = Math.max(state.now, due[1].at); state.timers.delete(due[0]); due[1].callback(); await flush();
      }
      state.now = end; await flush();
    }
  };
}
function sanitized(result, pattern) {
  assert(result.error, 'Expected failure'); assert.match(result.error.message, pattern);
  for (const secret of [HOST, IP, 'synthetic-secret', 'https://']) assert(!String(result.error.stack).includes(secret));
  assert.equal(result.error.cause, undefined);
}
function clean(h, retained = 0) {
  assert.equal(h.state.timers.size, 0); assert.equal(h.state.logs.length, 0);
  assert.equal(h.api.__retainedCount(), retained);
}
let passed = 0;
async function check(name, test) { await test(); passed++; console.log('PASS ' + name); }
async function main() {
  await check('snapshot identifies physical bearers without requiring VALIDATED', async () => {
    for (const [bearer, kind] of [[1, 'wifi'], [0, 'cellular'], [3, 'ethernet'], [2, 'other']]) {
      const h = harness(); h.state.bearer = bearer;
      const value = await h.api.readPhysicalNetwork();
      assert.equal(value.netId, 100); assert.equal(value.kind, kind); assert.equal(h.state.defaults, 2); clean(h);
    }
  });
  await check('snapshot rejects no network, VPN and non-INTERNET capability', async () => {
    for (const change of [{ netId: 0 }, { netId: 99 }, { bearer: 4 }, { caps: [] }]) {
      const h = harness(); Object.assign(h.state, change);
      assert.equal(await h.api.readPhysicalNetwork(), undefined); clean(h);
    }
  });
  await check('snapshot rejects a changed default and sanitizes API failures', async () => {
    for (const options of [{ defaultThrow: true }, { capsThrow: true }, { propertiesThrow: true }, { clockThrow: true },
      { defaultCall: count => Promise.resolve({ netId: count === 1 ? 100 : 101 }) },
      { capsCall: () => Promise.reject(RAW) }]) {
      const h = harness(options); assert.equal(await h.api.readPhysicalNetwork(), undefined); clean(h);
    }
  });
  await check('snapshot has one five-second total deadline and ignores late completion', async () => {
    const d = deferred(), h = harness({ capsCall: () => d.promise });
    const r = observe(h.api.readPhysicalNetwork()); await flush();
    await h.advance(4999); assert(!r.settled); await h.advance(1); await r.done;
    assert.equal(r.value, undefined); d.resolve({ bearerTypes: [1], networkCap: [12] }); await flush();
    assert.equal(h.state.defaults, 1); clean(h);
  });
  await check('watcher registers all handlers first and exposes only no-argument changes', async () => {
    const h = harness(), w = new h.api.PhysicalNetworkWatcher(); let calls = 0;
    await w.start((...args) => { assert.equal(args.length, 0); calls++; });
    for (const event of EVENTS) h.emit(event);
    assert.equal(calls, EVENTS.length); assert.equal(h.api.__retainedCount(), 1);
    await w.stop(); h.emit(); assert.equal(calls, EVENTS.length); assert.equal(h.state.created[0].unregisterCalls, 1);
    await w.stop(); clean(h);
  });
  await check('watcher stops during registration and cleans up late registration success', async () => {
    const h = harness({ deferRegister: true }), w = new h.api.PhysicalNetworkWatcher(); let calls = 0;
    const start = observe(w.start(() => calls++)); await flush(); const stop = observe(w.stop());
    h.emit(); assert.equal(calls, 0); assert.equal(h.api.__retainedCount(), 1);
    h.state.created[0].registerCallback(); await start.done; await stop.done;
    sanitized(start, /监听启动失败/); assert.equal(stop.error, undefined);
    assert.equal(h.state.created[0].unregisterCalls, 1); clean(h);
  });
  await check('registration timeout retains callback owner and late success unregisters', async () => {
    const h = harness({ deferRegister: true }), w = new h.api.PhysicalNetworkWatcher(); let calls = 0;
    const r = observe(w.start(() => calls++)); await h.advance(5000); await r.done;
    sanitized(r, /监听启动失败/); clean(h, 1); h.emit(); assert.equal(calls, 0);
    h.state.created[0].registerCallback(); await flush(); clean(h);
  });
  await check('stop timeout remains bounded and holds owner until unregister confirmation', async () => {
    const h = harness({ deferUnregister: true }), w = new h.api.PhysicalNetworkWatcher();
    await w.start(() => {}); const r = observe(w.stop()); await h.advance(5000); await r.done;
    sanitized(r, /尚未确认注销/); clean(h, 1);
    h.state.created[0].unregisterCallback(); await flush(); clean(h); await w.stop();
  });
  await check('stop-during-register has bounded wait even if native never calls back', async () => {
    const h = harness({ deferRegister: true }), w = new h.api.PhysicalNetworkWatcher();
    const start = observe(w.start(() => {})), stop = observe(w.stop()); await h.advance(5000);
    await start.done; await stop.done; sanitized(start, /监听启动失败/); sanitized(stop, /尚未确认注销/); clean(h, 1);
    h.state.created[0].registerCallback(); await flush(); clean(h);
  });
  await check('late registration failure releases owner after timeout without unregister', async () => {
    const h = harness({ deferRegister: true }), w = new h.api.PhysicalNetworkWatcher();
    const r = observe(w.start(() => {})); await h.advance(5000); await r.done;
    h.state.created[0].registerCallback({ code: 2100003, message: RAW.message }); await flush();
    assert.equal(h.state.created[0].unregisterCalls, 0); clean(h);
  });
  await check('watcher failures sanitize details; uncertain registration confirms absence', async () => {
    for (const options of [{ clockThrow: true }, { createThrow: true }, { onThrow: 'netLost' },
      { registerError: true }, { registerThrow: true, unregisterError: { code: 2101007 } }]) {
      const h = harness(options), w = new h.api.PhysicalNetworkWatcher();
      const r = observe(w.start(() => {})); await r.done; sanitized(r, /监听启动失败/); clean(h);
    }
  });
  await check('unregister failure retains owner and a later stop retries', async () => {
    for (const options of [{ unregisterThrow: true }, { unregisterError: { code: 2100003, message: RAW.message } }]) {
      const h = harness(options), w = new h.api.PhysicalNetworkWatcher(); await w.start(() => {});
      const r = observe(w.stop()); await h.advance(5000); await r.done; sanitized(r, /尚未确认注销/); clean(h, 1);
      options.unregisterThrow = false; options.unregisterError = undefined;
      await w.stop(); assert.equal(h.state.created[0].unregisterCalls, 2); clean(h);
    }
  });
  await check('duplicate start cannot allocate another watcher; restart follows confirmed cleanup', async () => {
    const h = harness(), w = new h.api.PhysicalNetworkWatcher(); await w.start(() => { throw RAW; });
    h.emit(); const duplicate = observe(w.start(() => {})); await duplicate.done; sanitized(duplicate, /监听启动失败/);
    assert.equal(h.state.created.length, 1); await w.stop(); await w.start(() => {}); await w.stop(); clean(h);
  });
  await check('resolver uses only explicit physical handle A lookup and verifies final physical identity', async () => {
    const h = harness(), r = h.resolve(); await r.done;
    assert.equal(r.value, IP); assert.equal(r.error, undefined); assert.equal(h.state.defaults, 3);
    assert.equal(h.state.dns.length, 1); assert.equal(h.state.dns[0].netId, 100);
    assert.equal(h.state.dns[0].options.family, 1); clean(h);
  });
  await check('resolver rejects noncanonical results and selects a canonical IPv4 candidate', async () => {
    const invalid = ['192.000.2.8', '1.2.3', '256.1.2.3', '1.2.3.4 ', '1.2.3.04', '0x7f.0.0.1',
      '1e2.1.2.3', '::ffff:192.0.2.8', '2001:db8::1', '1.2.3.-1'];
    for (const address of invalid) {
      const h = harness({ addresses: [{ address, family: 1 }] }), r = h.resolve(); await r.done;
      sanitized(r, /解析失败/); clean(h);
    }
    const h = harness({ addresses: [{ address: IP, family: 2 }, { address: '001.2.3.4', family: 1 },
      { address: IP, family: 1 }] }), r = h.resolve(); await r.done; assert.equal(r.value, IP); clean(h);
  });
  await check('resolver rejects default change before DNS and after DNS', async () => {
    const before = harness(); before.state.netId = 101; const r = before.resolve(); await r.done;
    sanitized(r, /物理网络已变化/); assert.equal(before.state.dns.length, 0); clean(before);
    const d = deferred(), h = harness({ dnsCall: () => d.promise }), later = h.resolve(); await flush();
    h.state.netId = 101; d.resolve([{ address: IP, family: 1 }]); await later.done;
    sanitized(later, /物理网络已变化/); clean(h);
  });
  await check('physical identity is stable under ordering and capability-validation changes', async () => {
    const h = harness();
    h.state.properties.linkAddresses.push({ address: { address: '192.0.2.21', family: 1 }, prefixLength: 24 });
    h.state.properties.dnses.push({ address: '2001:db8::53', family: 2 });
    const initial = await h.api.readPhysicalNetwork();
    h.state.properties.linkAddresses.reverse(); h.state.properties.dnses.reverse();
    h.state.properties.dnses.push({ ...h.state.properties.dnses[0] });
    h.state.caps.push(16); h.state.properties.isIPv4LinkValid = true;
    assert.equal((await h.api.readPhysicalNetwork()).key, initial.key);
    assert.equal(new h.api.PhysicalNetwork(100, 'wifi').key, '100/wifi'); clean(h);
  });
  await check('same netId DHCP, prefix, DNS, gateway and interface changes alter identity', async () => {
    for (const change of [p => { p.linkAddresses[0].address.address = '192.0.2.21'; },
      p => { p.linkAddresses[0].prefixLength = 25; }, p => { p.dnses[0].address = '192.0.2.54'; },
      p => { p.routes[0].gateway.address = '192.0.2.2'; }, p => { p.interfaceName = 'synthetic-wlan1'; },
      p => { p.routes[0].interface = 'synthetic-wlan1'; }, p => { p.routes = []; }]) {
      const h = harness(), before = await h.api.readPhysicalNetwork(); change(h.state.properties);
      const after = await h.api.readPhysicalNetwork(); assert.notEqual(after.key, before.key); clean(h);
    }
  });
  await check('empty optional property arrays are handled and explicit IPv4 invalidity is unavailable', async () => {
    const h = harness(); h.state.properties = { interfaceName: 'synthetic-wlan0' };
    assert.equal((await h.api.readPhysicalNetwork()).kind, 'wifi');
    h.state.properties.isIPv4LinkValid = false; assert.equal(await h.api.readPhysicalNetwork(), undefined); clean(h);
  });
  await check('resolver rejects same-netId property changes while DNS was in flight', async () => {
    const d = deferred(), h = harness({ dnsCall: () => d.promise }), r = h.resolve(); await flush();
    h.state.properties.dnses[0].address = '192.0.2.54';
    d.resolve([{ address: IP, family: 1 }]); await r.done; sanitized(r, /物理网络已变化/); clean(h);
  });
  await check('resolver cancellation polls at 200ms and discards late DNS success', async () => {
    const d = deferred(), h = harness({ dnsCall: () => d.promise }), r = h.resolve(); await flush();
    h.state.current = false; await h.advance(199); assert(!r.settled);
    await h.advance(1); await r.done; sanitized(r, /已取消/);
    d.resolve([{ address: IP, family: 1 }]); await flush(); assert.equal(h.state.defaults, 1); clean(h);
  });
  await check('cancellation also bounds the final property recheck without leaving extra timers', async () => {
    const d = deferred(), h = harness({ propertiesCall: (count, state) =>
      count === 1 ? Promise.resolve(state.properties) : d.promise }), r = h.resolve(); await flush();
    assert.equal(h.state.propertyCalls, 2); h.state.current = false; await h.advance(200); await r.done;
    sanitized(r, /已取消/); clean(h); d.resolve(h.state.properties); await flush(); clean(h);
  });
  await check('resolver checks cancellation before making calls and before accepting fast results', async () => {
    const h = harness(); h.state.current = false; const r = h.resolve(); await r.done;
    sanitized(r, /已取消/); assert.equal(h.state.defaults, 0); clean(h);
    const d = deferred(), h2 = harness({ dnsCall: () => d.promise }), r2 = h2.resolve(); await flush();
    h2.state.current = false; d.resolve([{ address: IP, family: 1 }]); await r2.done;
    sanitized(r2, /已取消/); clean(h2);
  });
  await check('resolver total deadline includes earlier API waits and ignores late rejection', async () => {
    const caps = deferred(), dns = deferred(), h = harness({ capsCall: () => caps.promise, dnsCall: () => dns.promise });
    const r = h.resolve(); await flush(); await h.advance(6000);
    caps.resolve({ bearerTypes: [1], networkCap: [12] }); await flush(); await h.advance(3999); assert(!r.settled);
    await h.advance(1); await r.done; sanitized(r, /总时限 10 秒/); dns.reject(RAW); await flush(); clean(h);
  });
  await check('monotonic deadline rejects a late callback even when the timer was suspended', async () => {
    const d = deferred(), h = harness({ dnsCall: () => d.promise }), r = h.resolve(); await flush();
    await h.advance(10001, false); d.resolve([{ address: IP, family: 1 }]); await r.done;
    sanitized(r, /总时限 10 秒/); clean(h);
  });
  await check('all native resolver failures are sanitized with no global fallback', async () => {
    for (const options of [{ defaultThrow: true }, { capsThrow: true }, { dnsThrow: true }, { clockThrow: true },
      { dnsCall: () => Promise.reject(RAW) }, { addresses: [] }]) {
      const h = harness(options), r = h.resolve(); await r.done; sanitized(r, /解析失败|物理网络已变化/); clean(h);
    }
  });
  await check('invalid host, netId and a throwing cancellation callback do not leak input', async () => {
    for (const host of ['', 'https://' + HOST, HOST + '\n', 'x'.repeat(254)]) {
      const h = harness(), r = observe(h.api.resolvePhysicalIpv4(host,
        new h.api.PhysicalNetwork(100, 'wifi'), () => true)); await r.done;
      sanitized(r, /解析失败/); assert.equal(h.state.defaults, 0); clean(h);
    }
    const h = harness(), r = observe(h.api.resolvePhysicalIpv4(HOST,
      new h.api.PhysicalNetwork(100, 'wifi'), () => { throw RAW; })); await r.done;
    sanitized(r, /物理网络已变化/); clean(h);
    for (const netId of [0, 99, NaN, 100.5]) {
      const invalid = harness(), result = observe(invalid.api.resolvePhysicalIpv4(HOST,
        new invalid.api.PhysicalNetwork(netId, 'wifi'), () => true)); await result.done;
      sanitized(result, /物理网络已变化/); assert.equal(invalid.state.defaults, 0); clean(invalid);
    }
  });
  console.log(`PASS ${passed} physical-network offline checks; no network or device calls made`);
}
main().catch(error => { console.error('FAIL physical-network offline checks:', error.stack); process.exitCode = 1; });
