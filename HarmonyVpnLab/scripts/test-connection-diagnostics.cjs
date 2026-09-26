'use strict';
// Executes the authored DNS helper with synthetic UDP, uptime and timers.
// No VPN, device, network, private file or real DNS response is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names = ['entry/src/main/ets/model/ConnectionFailure.ets', 'entry/src/main/ets/model/ConnectionDiagnostics.ets'];
const sources = new Map(names.map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
function compile(name) {
  const result = ts.transpileModule(sources.get(name), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
  });
  assert.equal(result.diagnostics.length, 0, name);
  return result.outputText;
}
const failureCode = compile(names[0]), diagnosticCode = compile(names[1]);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function scenario(options = {}) {
  let uptime = 1000, nextTimer = 1, current = true;
  const timers = new Map(), sockets = [];
  const failure = { exports: {} }; vm.runInNewContext(failureCode, failure);
  const context = { exports: {}, require(name) {
    if (name === './ConnectionFailure') return failure.exports;
    if (name === '@kit.BasicServicesKit') return { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => uptime } };
    if (name === '@kit.NetworkKit') return { socket: { constructUDPSocketInstance() {
      if (options.constructThrows) throw Error('private address token');
      const item = { handlers: {}, sends: [], bind: deferred(), send: deferred(), close: deferred(),
        closeCalls: 0, offCalls: [], open: false };
      sockets.push(item);
      return {
        on(name, fn) { if (options.onThrows) throw Error('private callback token'); item.handlers[name] = fn; },
        off(name) { item.offCalls.push(name); delete item.handlers[name]; if (options.offThrows) throw Error('private close token'); },
        bind() { if (options.bindThrows) throw Error('private bind token'); return (options.hangBind ? item.bind.promise :
          options.bindFails ? Promise.reject(Error('private bind token')) : Promise.resolve()).then(() => { item.open = true; }); },
        send(value) { item.sends.push(value); return options.hangSend ? item.send.promise :
          options.sendFails ? Promise.reject(Error('private send token')) : Promise.resolve(); },
        close() { item.closeCalls++; if (options.closeThrows) throw Error('private cleanup token');
          return (options.hangClose ? item.close.promise : options.closeFails ? Promise.reject(Error('private cleanup token')) :
            Promise.resolve()).then(() => { item.open = false; }); }
      };
    } } };
    throw Error('Unexpected import ' + name);
  }, setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, due: uptime + ms, ms }); return id; },
  clearTimeout(id) { timers.delete(id); }, Uint8Array, Math };
  vm.runInNewContext(diagnosticCode, context);
  return { api: context.exports, failures: failure.exports, sockets, timers,
    current: () => current, cancel: () => { current = false; },
    async advance(ms) {
      const end = uptime + ms;
      while (true) {
        const next = [...timers].filter(([, item]) => item.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        uptime = next[1].due; timers.delete(next[0]); next[1].fn(); await flush();
      }
      uptime = end; await flush();
    }
  };
}
function packetQuestion(id, type, host) {
  const bytes = [id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of host.split('.')) bytes.push(label.length, ...Buffer.from(label));
  bytes.push(0, type >> 8, type & 255, 0, 1); return new Uint8Array(bytes);
}
function responseFor(query, patch = {}) {
  const type = (query[query.length - 4] << 8) | query[query.length - 3];
  const bytes = Array.from(query); bytes[2] = 0x81; bytes[3] = 0x80 | (patch.rcode || 0);
  const answer = type === 1 && !patch.empty && !patch.rcode;
  bytes[7] = answer ? 1 : 0;
  if (answer) bytes.push(0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1);
  return new Uint8Array(bytes);
}
function emit(s, index = s.sockets.length - 1, mutate, endpoint = {}) {
  const item = s.sockets[index]; assert(item.sends.length > 0);
  const query = new Uint8Array(item.sends[0].data), response = responseFor(query);
  if (mutate) mutate(response, query);
  item.handlers.message({ message: response.buffer, remoteInfo: { address: '198.18.0.1', port: 53, ...endpoint } });
}
function outcome(promise) { return promise.then(() => ({ passed: true }), error => ({ passed: false, error })); }
function failureOf(s, value, stage, reason) {
  assert.equal(value.passed, false); assert(value.error instanceof s.failures.ConnectionFailureError);
  assert.equal(value.error.failure.stage, stage); assert.equal(value.error.failure.reason, reason);
  assert(!JSON.stringify(value.error.failure).includes('private')); assert(!String(value.error).includes('private'));
}
function cleaned(s) {
  assert.equal(s.timers.size, 0);
  for (const item of s.sockets) { assert.equal(item.open, false); assert.equal(Object.keys(item.handlers).length, 0); }
}
const tests = [], test = (name, body) => tests.push({ name, body });
test('direct path queries only fixed Baidu A and closes owned socket', async () => {
  const s = scenario(), pending = outcome(s.api.checkDirectDns(s.current)); await flush();
  const query = new Uint8Array(s.sockets[0].sends[0].data);
  assert(Buffer.from(query).includes(Buffer.from('baidu'))); assert.equal(query.at(-3), 1);
  emit(s); assert.equal((await pending).passed, true); assert.equal(s.sockets.length, 1); cleaned(s);
});
test('proxy API default queries fixed Cloudflare A then empty AAAA', async () => {
  const s = scenario(), pending = outcome(s.api.checkProxyDns()); await flush();
  assert(Buffer.from(s.sockets[0].sends[0].data).includes(Buffer.from('cloudflare')));
  emit(s, 0); await flush(); assert.equal(s.sockets.length, 2);
  assert.equal(new Uint8Array(s.sockets[1].sends[0].data).at(-3), 28);
  emit(s, 1); assert.equal((await pending).passed, true); cleaned(s);
});
test('question hostname validation rejects matching ID with a different hostname', async () => {
  const s = scenario(), pending = outcome(s.api.checkDirectDns()); await flush();
  emit(s, 0, bytes => { bytes[17] = 'z'.charCodeAt(0); });
  failureOf(s, await pending, 'direct-dns', 'invalid-response'); cleaned(s);
});
for (const [name, mutate] of [
  ['wrong transaction ID', bytes => bytes[1] ^= 1], ['missing response bit', bytes => bytes[2] &= 127],
  ['truncated wire flag', bytes => bytes[2] |= 2], ['unexpected opcode', bytes => bytes[2] |= 8],
  ['question count mismatch', bytes => bytes[5] = 2], ['question type mismatch', (bytes, query) => bytes[query.length - 3] = 28],
  ['question class mismatch', (bytes, query) => bytes[query.length - 1] = 3],
  ['answer address length mismatch', (bytes, query) => bytes[query.length + 11] = 3],
  ['compression pointer cycle', (bytes, query) => { bytes[query.length] = 0xc0; bytes[query.length + 1] = query.length; }]
]) test('malformed DNS response is typed invalid-response: ' + name, async () => {
  const s = scenario(), pending = outcome(s.api.checkDirectDns()); await flush(); emit(s, 0, mutate);
  failureOf(s, await pending, 'direct-dns', 'invalid-response'); cleaned(s);
});
test('well-formed negative DNS response is query failed, not DoH TLS or node diagnosis', async () => {
  const s = scenario(), pending = outcome(s.api.checkDirectDns()); await flush();
  const item = s.sockets[0]; const bytes = responseFor(new Uint8Array(item.sends[0].data), { rcode: 2 });
  item.handlers.message({ message: bytes.buffer, remoteInfo: { address: '198.18.0.1', port: 53 } });
  failureOf(s, await pending, 'direct-dns', 'failed'); cleaned(s);
});
test('valid empty IPv4 answer is query failed', async () => {
  const s = scenario(), pending = outcome(s.api.checkDirectDns()); await flush();
  const item = s.sockets[0]; const bytes = responseFor(new Uint8Array(item.sends[0].data), { empty: true });
  item.handlers.message({ message: bytes.buffer, remoteInfo: { address: '198.18.0.1', port: 53 } });
  failureOf(s, await pending, 'direct-dns', 'failed'); cleaned(s);
});
test('wrong source is ignored and request stays bounded', async () => {
  const s = scenario(), pending = outcome(s.api.checkDirectDns()); await flush();
  emit(s, 0, undefined, { address: '192.0.2.1' }); emit(s, 0, undefined, { port: 54 });
  await s.advance(6000); failureOf(s, await pending, 'direct-dns', 'timeout'); cleaned(s);
});
test('reply timeout preserves proxy path and never starts AAAA', async () => {
  const s = scenario(), pending = outcome(s.api.checkProxyDns()); await flush(); await s.advance(6000);
  failureOf(s, await pending, 'proxy-dns', 'timeout'); assert.equal(s.sockets.length, 1); cleaned(s);
});
test('bind is included in six-second total and late bind closes again without sending', async () => {
  const s = scenario({ hangBind: true }), pending = outcome(s.api.checkDirectDns()); await flush();
  await s.advance(6000); failureOf(s, await pending, 'direct-dns', 'timeout'); assert.equal(s.sockets[0].closeCalls, 1);
  s.sockets[0].bind.resolve(); await flush(); assert.equal(s.sockets[0].sends.length, 0);
  assert.equal(s.sockets[0].closeCalls, 2); cleaned(s);
});
test('native send completion is required even when reply arrives first', async () => {
  const s = scenario({ hangSend: true }), pending = outcome(s.api.checkDirectDns()); await flush(); emit(s);
  await s.advance(6000); failureOf(s, await pending, 'direct-dns', 'timeout');
  s.sockets[0].send.resolve(); await flush(); cleaned(s);
});
test('cancel before construction allocates no socket', async () => {
  const s = scenario(); s.cancel(); const value = await outcome(s.api.checkDirectDns(s.current));
  failureOf(s, value, 'direct-dns', 'failed'); assert.equal(s.sockets.length, 0); cleaned(s);
});
test('cancel while awaiting reply closes socket and late callback is inert', async () => {
  const s = scenario(), pending = outcome(s.api.checkDirectDns(s.current)); await flush();
  const handler = s.sockets[0].handlers.message; s.cancel(); await s.advance(100);
  failureOf(s, await pending, 'direct-dns', 'failed');
  const bytes = responseFor(new Uint8Array(s.sockets[0].sends[0].data));
  handler({ message: bytes.buffer, remoteInfo: { address: '198.18.0.1', port: 53 } }); cleaned(s);
});
test('cancel pending bind retains owner until late bind cleanup confirms closure', async () => {
  const s = scenario({ hangBind: true }), pending = outcome(s.api.checkDirectDns(s.current)); await flush();
  s.cancel(); await s.advance(100); failureOf(s, await pending, 'direct-dns', 'failed');
  failureOf(s, await outcome(s.api.checkProxyDns()), 'proxy-dns', 'failed'); assert.equal(s.sockets.length, 1);
  s.sockets[0].bind.resolve(); await flush(); assert.equal(s.sockets[0].sends.length, 0); cleaned(s);
  const restored = outcome(s.api.checkDirectDns()); await flush(); assert.equal(s.sockets.length, 2);
  s.sockets[1].bind.resolve(); await flush(); emit(s, 1);
  assert.equal((await restored).passed, true); cleaned(s);
});
test('response success cannot be reported before bounded native close confirms cleanup', async () => {
  const s = scenario({ hangClose: true }), pending = outcome(s.api.checkDirectDns()); await flush(); emit(s);
  let settled = false; pending.then(() => { settled = true; }); await flush(); assert.equal(settled, false);
  await s.advance(1000); failureOf(s, await pending, 'direct-dns', 'failed');
  failureOf(s, await outcome(s.api.checkProxyDns()), 'proxy-dns', 'failed'); assert.equal(s.sockets.length, 1);
  s.sockets[0].close.resolve(); await flush(); cleaned(s);
});
test('cancel after reply while close is pending cannot report a passed check', async () => {
  const s = scenario({ hangClose: true }), pending = outcome(s.api.checkDirectDns(s.current)); await flush(); emit(s);
  await flush(); s.cancel(); s.sockets[0].close.resolve(); await flush();
  failureOf(s, await pending, 'direct-dns', 'failed'); cleaned(s);
});
test('late bind during pending close requires another close after first close settles', async () => {
  const s = scenario({ hangBind: true, hangClose: true }), pending = outcome(s.api.checkDirectDns()); await flush();
  await s.advance(6000); s.sockets[0].bind.resolve(); await flush(); assert.equal(s.sockets[0].sends.length, 0);
  s.sockets[0].close.resolve(); await flush(); failureOf(s, await pending, 'direct-dns', 'timeout');
  assert.equal(s.sockets[0].closeCalls, 2); cleaned(s);
});
for (const option of ['constructThrows', 'onThrows', 'bindThrows', 'bindFails', 'sendFails'])
  test('native error cannot leak input or invent cause: ' + option, async () => {
    const s = scenario({ [option]: true }), pending = outcome(s.api.checkDirectDns()); await flush();
    failureOf(s, await pending, 'direct-dns', 'failed'); cleaned(s);
  });
for (const option of ['offThrows', 'closeThrows', 'closeFails'])
  test('cleanup failure prevents a false passed result: ' + option, async () => {
    const s = scenario({ [option]: true }), pending = outcome(s.api.checkDirectDns()); await flush(); emit(s);
    failureOf(s, await pending, 'direct-dns', 'failed'); assert.equal(s.timers.size, 0);
  });
test('socket error is fixed path classification only', async () => {
  const s = scenario(), pending = outcome(s.api.checkProxyDns()); await flush();
  s.sockets[0].handlers.error({ code: 2300060, message: 'private endpoint token' });
  failureOf(s, await pending, 'proxy-dns', 'failed'); cleaned(s);
});
test('current callback exception is fixed failure without allocation', async () => {
  const s = scenario(); const value = await outcome(s.api.checkDirectDns(() => { throw Error('private owner token'); }));
  failureOf(s, value, 'direct-dns', 'failed'); assert.equal(s.sockets.length, 0); cleaned(s);
});
(async () => {
  const cases = [];
  for (const { name, body } of tests) { await body(); cases.push({ name, passed: true }); }
  const report = { passed: cases.length, failed: 0, scope: 'authored DNS helper; synthetic UDP, monotonic clock and timers only',
    sourceSHA256: Object.fromEntries([...sources].map(([name, source]) => [name, crypto.createHash('sha256').update(source).digest('hex')])), cases };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/connection-diagnostics-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: 0 }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
