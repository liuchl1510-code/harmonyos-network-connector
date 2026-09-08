'use strict';
// Execute the authored navigation model with an in-memory route stack. This is
// a routing contract test, not an ArkUI rendering or on-device lifecycle result.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const relative = 'model/MainNavigation.ets';
const original = fs.readFileSync(path.join(project, 'entry/src/main/ets', relative), 'utf8');
const compiled = ts.transpileModule(original, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(compiled.diagnostics.length, 0, 'SDK transpilation failed: ' + relative);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function scenario(initial = ['pages/Home'], options = {}) {
  let nextRoute = 1;
  const stack = initial.map(url => ({ url, instance: nextRoute++ }));
  const home = stack[0];
  assert.equal(home.url, 'pages/Home');
  const calls = { push: [], replace: [], back: 0, toast: [], getRouter: 0 };
  const router = {
    async pushUrl(request) {
      calls.push.push({ ...request });
      if (options.push) await options.push(request);
      stack.push({ url: request.url, instance: nextRoute++ });
    },
    async replaceUrl(request) {
      calls.replace.push({ ...request });
      assert(stack.length > 1, 'Replacing the Home root would dispose its authorization subscription');
      if (options.replace) await options.replace(request);
      stack[stack.length - 1] = { url: request.url, instance: nextRoute++ };
    },
    back() {
      calls.back++;
      if (options.back) options.back();
      if (stack.length > 1) stack.pop();
    }
  };
  const context = {
    getRouter() { calls.getRouter++; if (options.getRouter) options.getRouter(); return router; },
    getPromptAction() {
      return { showToast(message) { calls.toast.push({ ...message }); if (options.toast) options.toast(message); } };
    }
  };
  const exported = {};
  vm.runInNewContext(compiled.outputText, {
    exports: exported, module: { exports: exported }, setTimeout, clearTimeout,
    require(name) { assert.equal(name, '@kit.ArkUI'); return {}; }
  }, { filename: relative });
  return {
    stack, home, calls, options,
    open: (current, target) => exported.openMainTab(context, current, target),
    assertStack(expected) {
      assert.deepEqual(stack.map(route => route.url), expected);
      assert.equal(stack[0], home, 'The same Home instance must remain at the route root');
    }
  };
}

const tests = [];
function test(name, body) { tests.push({ name, body }); }

for (const [tab, page] of [['nodes', 'pages/Nodes'], ['settings', 'pages/Settings']]) {
  test('Home to ' + tab + ' pushes one page and retains the original Home instance', async () => {
    const s = scenario(); await s.open('home', tab);
    s.assertStack(['pages/Home', page]); assert.deepEqual(s.calls.push, [{ url: page }]);
    assert.equal(s.calls.replace.length, 0); assert.equal(s.calls.back, 0); assert.equal(s.calls.toast.length, 0);
  });
  test(tab + ' to Home returns by back without pushing or replacing the root', async () => {
    const s = scenario(['pages/Home', page]); await s.open(tab, 'home');
    s.assertStack(['pages/Home']); assert.equal(s.calls.back, 1);
    assert.equal(s.calls.push.length, 0); assert.equal(s.calls.replace.length, 0); assert.equal(s.calls.toast.length, 0);
  });
}

test('Nodes and Settings replace one another without growing the stack or replacing Home', async () => {
  const s = scenario(); await s.open('home', 'nodes');
  for (let i = 0; i < 20; i++) {
    await s.open('nodes', 'settings'); s.assertStack(['pages/Home', 'pages/Settings']);
    await s.open('settings', 'nodes'); s.assertStack(['pages/Home', 'pages/Nodes']);
  }
  assert.equal(s.calls.push.length, 1); assert.equal(s.calls.replace.length, 40); assert.equal(s.calls.back, 0);
  await s.open('nodes', 'home'); s.assertStack(['pages/Home']); assert.equal(s.calls.back, 1);
});

test('selected and invalid tabs perform no routing and do not block the next valid request', async () => {
  const s = scenario();
  for (const tab of ['home', 'nodes', 'settings']) await s.open(tab, tab);
  for (const [current, target] of [['home', 'missing'], ['missing', 'nodes'], ['', 'home'], ['nodes', '']]) {
    await s.open(current, target);
  }
  assert.equal(s.calls.getRouter, 0); assert.equal(s.calls.toast.length, 0); s.assertStack(['pages/Home']);
  await s.open('home', 'nodes'); s.assertStack(['pages/Home', 'pages/Nodes']);
});

test('pending push ignores duplicate and competing clicks, then allows the next tab switch', async () => {
  const gate = deferred(), s = scenario(['pages/Home'], { push: () => gate.promise });
  const first = s.open('home', 'nodes');
  await Promise.all([s.open('home', 'nodes'), s.open('home', 'settings')]);
  assert.equal(s.calls.push.length, 1); assert.equal(s.calls.replace.length, 0); s.assertStack(['pages/Home']);
  gate.resolve(); await first; s.assertStack(['pages/Home', 'pages/Nodes']);
  await s.open('nodes', 'settings'); s.assertStack(['pages/Home', 'pages/Settings']);
  assert.equal(s.calls.replace.length, 1); assert.equal(s.calls.toast.length, 0);
});

test('pending replace ignores duplicate and competing back clicks, then allows returning Home', async () => {
  const gate = deferred(), s = scenario(['pages/Home', 'pages/Nodes'], { replace: () => gate.promise });
  const first = s.open('nodes', 'settings');
  await Promise.all([s.open('nodes', 'settings'), s.open('nodes', 'home')]);
  assert.equal(s.calls.replace.length, 1); assert.equal(s.calls.back, 0); s.assertStack(['pages/Home', 'pages/Nodes']);
  gate.resolve(); await first; s.assertStack(['pages/Home', 'pages/Settings']);
  await s.open('settings', 'home'); s.assertStack(['pages/Home']); assert.equal(s.calls.back, 1);
});

test('concurrent returns to Home issue only one back operation', async () => {
  const s = scenario(['pages/Home', 'pages/Nodes']);
  await Promise.all([s.open('nodes', 'home'), s.open('nodes', 'home')]);
  assert.equal(s.calls.back, 1, 'A repeated back must not reach the retained Home root');
  s.assertStack(['pages/Home']); assert.equal(s.calls.push.length, 0); assert.equal(s.calls.replace.length, 0);
});

test('a fast second click from the departing tab cannot back again and the guard later releases', async () => {
  const s = scenario(['pages/Home', 'pages/Nodes']);
  const first = s.open('nodes', 'home');
  await new Promise(resolve => setTimeout(resolve, 20));
  await s.open('nodes', 'home'); assert.equal(s.calls.back, 1);
  await first; s.assertStack(['pages/Home']);
  await s.open('home', 'settings'); s.assertStack(['pages/Home', 'pages/Settings']);
  assert.equal(s.calls.push.length, 1); assert.equal(s.calls.back, 1); assert.equal(s.calls.toast.length, 0);
});

for (const [operation, current, target, initial, expected] of [
  ['push', 'home', 'nodes', ['pages/Home'], ['pages/Home', 'pages/Nodes']],
  ['replace', 'nodes', 'settings', ['pages/Home', 'pages/Nodes'], ['pages/Home', 'pages/Settings']]
]) {
  test(operation + ' failure releases the pending guard and permits an identical retry', async () => {
    const gate = deferred(), options = { [operation]: () => gate.promise }, s = scenario(initial, options);
    const first = s.open(current, target); await s.open(current, target);
    assert.equal(s.calls[operation].length, 1);
    gate.reject(new Error('synthetic private route failure')); await first;
    s.assertStack(initial); assert.deepEqual(s.calls.toast, [{ message: '页面暂未打开，请重试。' }]);
    options[operation] = undefined; await s.open(current, target);
    s.assertStack(expected); assert.equal(s.calls[operation].length, 2); assert.equal(s.calls.toast.length, 1);
  });
}

test('back failure preserves Home and permits retry', async () => {
  const options = { back: () => { throw new Error('synthetic back failure'); } };
  const s = scenario(['pages/Home', 'pages/Settings'], options); await s.open('settings', 'home');
  s.assertStack(['pages/Home', 'pages/Settings']); assert.equal(s.calls.back, 1); assert.equal(s.calls.toast.length, 1);
  options.back = undefined; await s.open('settings', 'home'); s.assertStack(['pages/Home']); assert.equal(s.calls.back, 2);
});

test('router acquisition failure permits retry and cannot expose exception details', async () => {
  const options = { getRouter: () => { throw new Error('synthetic-private-route'); } };
  const s = scenario(['pages/Home'], options); await s.open('home', 'settings');
  s.assertStack(['pages/Home']); assert.equal(s.calls.push.length, 0);
  assert.deepEqual(s.calls.toast, [{ message: '页面暂未打开，请重试。' }]);
  options.getRouter = undefined; await s.open('home', 'settings'); s.assertStack(['pages/Home', 'pages/Settings']);
});

test('a failing failure notification cannot leave navigation locked', async () => {
  const options = {
    push: () => { throw new Error('synthetic route failure'); },
    toast: () => { throw new Error('synthetic prompt failure'); }
  };
  const s = scenario(['pages/Home'], options); await s.open('home', 'nodes');
  s.assertStack(['pages/Home']); assert.equal(s.calls.toast.length, 1);
  options.push = undefined; await s.open('home', 'nodes');
  s.assertStack(['pages/Home', 'pages/Nodes']); assert.equal(s.calls.push.length, 2);
});

(async () => {
  const results = [];
  for (const item of tests) {
    let watchdog;
    try {
      await Promise.race([Promise.resolve().then(item.body), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('SYNTHETIC_NAVIGATION_DEADLOCK')), 2000);
      })]);
      results.push({ name: item.name, passed: true });
    } catch (error) { results.push({ name: item.name, passed: false, detail: error.message }); }
    finally { clearTimeout(watchdog); }
  }
  const passed = results.filter(result => result.passed).length;
  const report = {
    generatedAt: new Date().toISOString(), passed, failed: results.length - passed, total: results.length,
    sourceSHA256: { [relative]: crypto.createHash('sha256').update(original).digest('hex') },
    scope: 'Actual MainNavigation.ets with SDK TypeScript transpilation and a synthetic route stack; no ArkUI, phone, VPN or network execution.',
    limitations: ['The synthetic stack checks routing operations and preserved root identity; native Router page lifecycle and transition timing require device verification.'],
    results
  };
  const output = path.join(project, 'build/main-navigation-verification.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, failed: report.failed, total: report.total,
    failures: results.filter(result => !result.passed), record: output }));
  if (report.failed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
