/*
 * Offline stream checks with fictional input, mocked HTTP, monotonic time and timers.
 * No network, private files, npm installs or emitted artifacts. SDK declarations
 * were checked separately; these Node shims do not replace ArkTS/device validation.
 * Usage: node scripts/test-subscription-fetch.cjs
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const project = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const filename = path.join(project, 'entry/src/main/ets/model/SubscriptionFetch.ets');
const source = fs.readFileSync(filename, 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(output.diagnostics.length, 0);
const LIMIT = 1024 * 1024;
const LINK = 'https://subscription.invalid/list?token=synthetic-sensitive-token';
const SECRET = 'synthetic-sensitive-token';
const RAW_ERROR = new Error(LINK + ' native-body=synthetic-sensitive-body');

function harness(options = {}) {
  const state = { now: 1000, timers: new Map(), nextTimer: 1, created: 0, destroyed: 0,
    requested: 0, handlers: new Map(), allHandlers: new Map(), off: [], logs: [], calls: [] };
  let resolveStatus, rejectStatus;
  const status = new Promise((resolve, reject) => { resolveStatus = resolve; rejectStatus = reject; });
  const request = {
    on(event, callback) {
      state.handlers.set(event, callback);
      state.allHandlers.set(event, callback);
      if (options.onThrow === event) throw RAW_ERROR;
    },
    off(event) {
      state.off.push(event);
      if (options.offThrow) throw RAW_ERROR;
      state.handlers.delete(event);
    },
    destroy() {
      state.destroyed++;
      state.calls.push('destroy');
      if (options.destroyThrow) throw RAW_ERROR;
      state.handlers.clear();
    },
    requestInStream(address, requestOptions) {
      state.requested++;
      state.address = address;
      state.options = requestOptions;
      assert(state.handlers.has('dataReceive') && state.handlers.has('dataEnd'));
      if (options.requestThrow) throw RAW_ERROR;
      return status;
    }
  };
  const imports = {
    '@kit.NetworkKit': { http: { RequestMethod: { GET: 'GET' }, createHttp() {
      if (options.createThrow) throw RAW_ERROR;
      state.created++;
      state.now += options.createDelay || 0;
      return request;
    } } },
    '@kit.ArkTS': {
      url: { URL: { parseURL: value => {
        if (options.urlThrow) throw RAW_ERROR;
        return new URL(value);
      } } },
      util: { TextDecoder: { create: (encoding, decoderOptions) => ({ decodeToString: bytes => {
        assert.equal(encoding, 'utf-8');
        assert.equal(decoderOptions.fatal, true);
        state.now += options.decodeDelay || 0;
        return new TextDecoder(encoding, decoderOptions).decode(bytes);
      } }) } }
    },
    '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime(kind, nanos) {
      assert.equal(kind, 0);
      assert.equal(nanos, false);
      if (options.clockThrow) throw RAW_ERROR;
      return state.now;
    } } }
  };
  const context = { exports: {}, require(name) {
    assert(Object.hasOwn(imports, name), 'Unexpected test import');
    return imports[name];
  }, setTimeout(callback, delay) {
    const id = state.nextTimer++;
    state.timers.set(id, { at: state.now + delay, callback });
    return id;
  }, clearTimeout(id) { state.timers.delete(id); }, console: {} };
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    context.console[method] = (...args) => state.logs.push(args);
  }
  vm.runInNewContext(output.outputText, context, { filename });
  function observe(input = LINK) {
    const result = { settled: false, value: undefined, error: undefined };
    result.done = context.exports.fetchSubscription(input).then(value => {
      result.settled = true; result.value = value;
    }, error => { result.settled = true; result.error = error; });
    return result;
  }
  return { api: context.exports, state, observe, resolveStatus, rejectStatus,
    receive(bytes, late = false) {
      const copy = Uint8Array.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
      (late ? state.allHandlers : state.handlers).get('dataReceive')?.(copy.buffer);
      return copy;
    }, end(late = false) { (late ? state.allHandlers : state.handlers).get('dataEnd')?.(); },
    advance(ms, fireTimers = true) {
      state.now += ms;
      if (fireTimers) {
        for (const [id, timer] of [...state.timers]) {
          if (timer.at <= state.now) { state.timers.delete(id); timer.callback(); }
        }
      }
    }
  };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clean(h, created = 1) {
  assert.equal(h.state.created, created);
  assert.equal(h.state.destroyed, created);
  assert.equal(h.state.timers.size, 0);
  assert.equal(h.state.logs.length, 0, 'Fetcher must not log request or response data');
  if (created) assert.deepEqual(h.state.off, ['dataReceive', 'dataEnd']);
}
function privateFailure(result, pattern) {
  assert(result.error, 'Expected a sanitized failure');
  assert.match(result.error.message, pattern);
  const details = String(result.error.stack);
  for (const secret of [LINK, SECRET, 'subscription.invalid', 'synthetic-sensitive-body', 'native-body']) {
    assert(!details.includes(secret), 'Failure leaked synthetic private data');
  }
  assert.equal(result.error.cause, undefined);
}
let passed = 0;
async function check(name, test) { await test(); passed++; console.log('PASS ' + name); }

async function main() {
  await check('normalize HTTPS, preserve query, reject unsafe URL forms', async () => {
    const h = harness();
    assert.equal(h.api.normalizeSubscriptionUrl('  HTTPS://EXAMPLE.INVALID:443/list?a=1%23x  '),
      'https://example.invalid/list?a=1%23x');
    assert.equal(h.api.normalizeSubscriptionUrl('https://[2001:db8::1]/list'), 'https://[2001:db8::1]/list');
    const validAtLimit = 'https://example.invalid/?q=' + 'a'.repeat(4096 - 'https://example.invalid/?q='.length);
    assert.equal(h.api.normalizeSubscriptionUrl(validAtLimit).length, 4096);
    const invalid = ['', 'http://example.invalid/', 'file:///tmp/list', '//example.invalid/',
      'https:/example.invalid/', 'https:////example.invalid/', 'https://',
      'https://user:password@example.invalid/', 'https://@example.invalid/',
      'https://example.invalid/#', 'https://example.invalid/#fragment',
      'https://example.invalid/line\nbreak', 'https://example.invalid/with space',
      'https://example.invalid\\@other.invalid/', 'https://example.invalid/%zz',
      'https://example.invalid:65536/', validAtLimit + 'a', ' ' + validAtLimit];
    for (const value of invalid) {
      const r = h.observe(value); await r.done;
      privateFailure(r, /订阅地址无效/);
    }
    clean(h, 0);
    const brokenParser = harness({ urlThrow: true });
    const r = brokenParser.observe(); await r.done;
    privateFailure(r, /订阅地址无效/); clean(brokenParser, 0);
  });
  await check('stream success waits for both status and end; secure request options', async () => {
    const h = harness(), r = h.observe();
    h.resolveStatus(200); await flush(); assert.equal(r.settled, false);
    h.receive('https text\n'); h.receive('中文');
    assert.equal(r.settled, false);
    h.end(); await r.done;
    assert.equal(r.error, undefined); assert.equal(r.value, 'https text\n中文');
    assert.equal(h.state.address, LINK);
    assert.equal(h.state.requested, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.state.options)), {
      method: 'GET', header: { Accept: 'text/plain, application/json' }, usingCache: false,
      maxRedirects: 0, maxLimit: LIMIT, connectTimeout: 12000, readTimeout: 12000
    });
    clean(h);
  });
  await check('end before status and multibyte UTF-8 split across chunks', async () => {
    const h = harness(), r = h.observe(), bytes = Buffer.from('\ufeff中文😀\n');
    for (const byte of bytes) h.receive([byte]);
    h.end(); await flush(); assert.equal(r.settled, false);
    h.resolveStatus(200); await r.done;
    assert.equal(r.value, '中文😀\n'); clean(h);
  });
  await check('exact 1 MiB succeeds; chunk memory is copied', async () => {
    const h = harness(), r = h.observe();
    const chunk = h.receive(Buffer.alloc(LIMIT, 65));
    chunk.fill(66); // A reused native event buffer must not change accepted bytes.
    h.end(); h.resolveStatus(200); await r.done;
    assert.equal(r.value.length, LIMIT); assert.equal(r.value, 'A'.repeat(LIMIT)); clean(h);
  });
  await check('first oversized chunk aborts immediately', async () => {
    const h = harness(), r = h.observe();
    h.receive(Buffer.alloc(LIMIT + 1, 65)); await r.done;
    privateFailure(r, /1 MiB/); clean(h);
    h.receive('late', true); h.end(true); h.resolveStatus(200); await flush(); clean(h);
  });
  await check('cumulative byte cap cannot be bypassed with chunks', async () => {
    const h = harness(), r = h.observe();
    h.receive(Buffer.alloc(LIMIT - 1, 65)); h.receive([65]); h.receive([65]); await r.done;
    privateFailure(r, /1 MiB/); clean(h);
  });
  await check('all non-200 statuses reject including redirects, even after dataEnd', async () => {
    for (const status of [0, 201, 204, 206, 301, 302, 303, 307, 308, 400, 401, 500]) {
      const h = harness(), r = h.observe();
      h.receive('synthetic-sensitive-body'); h.end(); h.resolveStatus(status); await r.done;
      privateFailure(r, /HTTP 200/); assert.equal(h.state.requested, 1); clean(h);
    }
  });
  await check('invalid UTF-8 and binary control characters reject privately', async () => {
    for (const bytes of [[0xc3], [0xc3, 0x28], [0xc0, 0xaf], [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80], [0], [65, 27, 66]]) {
      const h = harness(), r = h.observe();
      h.receive(bytes); h.end(); h.resolveStatus(200); await r.done;
      privateFailure(r, /UTF-8/); clean(h);
    }
  });
  await check('total deadline aborts a hanging stream and includes creation time', async () => {
    const h = harness({ createDelay: 2000 }), r = h.observe();
    assert.equal([...h.state.timers.values()][0].at, 13000);
    h.advance(9999); await flush(); assert.equal(r.settled, false);
    h.advance(1); await r.done;
    privateFailure(r, /12 秒/); clean(h);
  });
  await check('continuous small chunks cannot reset total deadline', async () => {
    const h = harness(), r = h.observe();
    for (let i = 0; i < 11; i++) { h.advance(1000); h.receive('a'); }
    h.advance(1000); await r.done;
    privateFailure(r, /12 秒/); clean(h);
  });
  await check('deadline still holds when timer callback is delayed', async () => {
    for (const event of ['receive', 'end', 'status', 'error']) {
      const h = harness(), r = h.observe();
      h.receive('body'); h.advance(12000, false);
      if (event === 'receive') h.receive('late');
      if (event === 'end') h.end();
      if (event === 'status') h.resolveStatus(200);
      if (event === 'error') h.rejectStatus(RAW_ERROR);
      await r.done; privateFailure(r, /12 秒/); clean(h);
    }
  });
  await check('decode time and expired setup count against total deadline', async () => {
    const h = harness({ decodeDelay: 12000 }), r = h.observe();
    h.receive('body'); h.end(); h.resolveStatus(200); await r.done;
    privateFailure(r, /12 秒/); clean(h);
    const setup = harness({ createDelay: 12000 }), setupResult = setup.observe();
    await setupResult.done; privateFailure(setupResult, /12 秒/);
    assert.equal(setup.state.requested, 0); clean(setup);
  });
  await check('status without end, and end without status, both time out', async () => {
    for (const event of ['status', 'end']) {
      const h = harness(), r = h.observe();
      if (event === 'status') h.resolveStatus(200); else h.end();
      await flush(); assert.equal(r.settled, false);
      h.advance(12000); await r.done; privateFailure(r, /12 秒/); clean(h);
    }
  });
  await check('native synchronous and asynchronous errors stay private with cleanup', async () => {
    for (const option of [{}, { requestThrow: true }, { onThrow: 'dataReceive' },
      { onThrow: 'dataEnd' }, { createThrow: true }, { clockThrow: true }]) {
      const h = harness(option), r = h.observe();
      if (Object.keys(option).length === 0) h.rejectStatus(RAW_ERROR);
      await r.done; privateFailure(r, /订阅请求失败/);
      clean(h, option.createThrow || option.clockThrow ? 0 : 1);
    }
  });
  await check('off failure cannot skip destroy; destroy failure cannot leak error', async () => {
    for (const option of [{ offThrow: true }, { destroyThrow: true }, { offThrow: true, destroyThrow: true }]) {
      const h = harness(option), r = h.observe();
      h.receive('body'); h.end(); h.resolveStatus(200); await r.done;
      if (option.destroyThrow) privateFailure(r, /订阅请求失败/);
      else assert.equal(r.value, 'body');
      clean(h);
    }
  });
  await check('late callbacks after success cannot settle or destroy twice', async () => {
    const h = harness(), r = h.observe();
    h.receive('body'); h.end(); h.resolveStatus(200); await r.done;
    h.receive(Buffer.alloc(LIMIT + 1), true); h.end(true); h.advance(12000); await flush();
    assert.equal(r.value, 'body'); assert.equal(r.error, undefined); clean(h);
  });
  console.log(`PASS ${passed} offline subscription-fetch checks; no network requests made`);
}
main().catch(() => { console.error('FAIL offline subscription-fetch checks'); process.exitCode = 1; });
