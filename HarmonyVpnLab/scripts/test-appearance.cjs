'use strict';
// Executes the authored preference and Settings methods with synthetic SDK/file
// adapters. Does not build a HAP, access the phone or change any device setting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const appearanceSource = fs.readFileSync(path.join(root, 'entry/src/main/ets/model/Appearance.ets'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'entry/src/main/ets/pages/Settings.ets'), 'utf8')
  .split('  build() {')[0].replace(/@Entry\s*/g, '').replace(/@Component\s*/g, '')
  .replace(/@State\s*/g, '').replace('struct Settings', 'export class Settings') + '\n}';
function compile(source) {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
  });
  assert.equal(result.diagnostics.length, 0, 'SDK transpilation');
  return result.outputText;
}
const appearanceCode = compile(appearanceSource);
const settingsCode = compile(settingsSource);
const dir = '/synthetic-private';
const destination = `${dir}/appearance.json`;
const colors = { COLOR_MODE_NOT_SET: -1, COLOR_MODE_DARK: 0, COLOR_MODE_LIGHT: 1 };
const saveError = '外观设置未保存，请重试。';
const applyError = '外观暂时无法切换，请重试。';
function fixture() {
  const files = new Map();
  const handles = new Map();
  const state = { fd: 0, fail: '', shortWrite: Infinity, forcedWrite: undefined, statSize: undefined,
    isFile: true, readLength: undefined, colorFail: false, colors: [], events: [] };
  function fail(operation) { if (state.fail === operation) throw Error('/private/sensitive/path'); }
  const fileIo = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    accessSync: p => { fail('access'); return files.has(p); },
    statSync: p => { fail('stat'); return { size: state.statSize ?? files.get(p).length, isFile: () => state.isFile }; },
    readTextSync: (p, options) => { fail('read'); state.readLength = options.length; return files.get(p).subarray(0, options.length).toString('utf8'); },
    openSync: p => { fail('open'); const file = { fd: ++state.fd }; files.set(p, Buffer.alloc(0)); handles.set(file.fd, p); return file; },
    writeSync: (fd, input) => {
      fail('write');
      if (state.forcedWrite !== undefined) return state.forcedWrite;
      const part = Buffer.from(input).subarray(0, state.shortWrite);
      const p = handles.get(fd); files.set(p, Buffer.concat([files.get(p), part]));
      state.events.push('write'); return part.length;
    },
    fsyncSync: () => { fail('fsync'); state.events.push('fsync'); },
    closeSync: file => { handles.delete(file.fd); state.events.push('close'); },
    renameSync: (from, to) => { fail('rename'); files.set(to, files.get(from)); files.delete(from); state.events.push('rename'); },
    unlinkSync: p => files.delete(p)
  };
  const context = { filesDir: dir, getApplicationContext: () => ({
    setColorMode: value => { state.colors.push(value); if (state.colorFail) throw Error('/private/sensitive/context'); }
  }) };
  const api = {};
  const imports = name => {
    if (name === '@kit.CoreFileKit') return { fileIo };
    if (name === '@kit.AbilityKit') return { ConfigurationConstant: { ColorMode: colors } };
    if (name === '@kit.ArkTS') return { util: { generateRandomUUID: crypto.randomUUID,
      TextEncoder: class { encodeInto(value) { return new Uint8Array(Buffer.from(value, 'utf8')); } } } };
    if (name === '../model/Appearance') return api;
    if (name === '../components/AppTabBar') return {};
    throw Error(`Unexpected import ${name}`);
  };
  vm.runInNewContext(appearanceCode, { exports: api, require: imports, Uint8Array });
  const pages = {};
  const appStorage = new Map();
  let backCount = 0;
  vm.runInNewContext(settingsCode, { exports: pages, require: imports,
    AppStorage: { setOrCreate: (key, value) => appStorage.set(key, value) } });
  const page = new pages.Settings();
  page.getUIContext = () => ({ getHostContext: () => context,
    getRouter: () => ({ back: () => { backCount++; }, pushUrl: () => Promise.resolve() }) });
  return { api, files, handles, state, context, page, appStorage, backs: () => backCount,
    seed: value => files.set(destination, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))) };
}
const cases = [];
function test(name, body) { body(); cases.push({ name, passed: true }); }
function onlyDestination(f) { assert.deepEqual([...f.files.keys()], [destination]); assert.equal(f.handles.size, 0); }

test('Missing preference follows system without creating a file', () => {
  const f = fixture(); assert.equal(f.api.readAppearance(dir), 'system'); assert.equal(f.files.size, 0);
});
test('Three strict modes round-trip with a fixed schema', () => {
  const f = fixture();
  for (const mode of ['system', 'light', 'dark']) {
    f.api.saveAppearance(dir, mode); assert.equal(f.api.readAppearance(dir), mode); onlyDestination(f);
    assert.deepEqual(JSON.parse(f.files.get(destination)), { schemaVersion: 1, mode });
  }
  assert.equal(f.state.readLength, 513);
});
test('Malformed, unknown-schema and extra-field preferences fall back without rewriting', () => {
  const f = fixture();
  for (const value of ['{', 'null', '[]', '{}', { schemaVersion: 2, mode: 'dark' },
    { schemaVersion: 1, mode: 'DARK' }, { schemaVersion: 1, mode: null },
    { schemaVersion: 1, mode: 'dark', secret: 'do-not-copy' }]) {
    f.seed(value); const original = f.files.get(destination);
    assert.equal(f.api.readAppearance(dir), 'system'); assert.equal(f.files.get(destination), original);
  }
});
test('Read rejects oversized, invalid stat and non-file targets before content parsing', () => {
  const f = fixture(); f.seed({ schemaVersion: 1, mode: 'dark' });
  for (const size of [-1, 0, 513, Infinity, NaN, 1.5]) {
    f.state.statSize = size; assert.equal(f.api.readAppearance(dir), 'system');
  }
  f.state.statSize = undefined; f.state.isFile = false; assert.equal(f.api.readAppearance(dir), 'system');
  f.state.isFile = true; f.seed(' '.repeat(513)); assert.equal(f.api.readAppearance(dir), 'system');
});
test('Read failure falls back without revealing paths', () => {
  const f = fixture(); f.seed({ schemaVersion: 1, mode: 'dark' });
  for (const operation of ['access', 'stat', 'read']) { f.state.fail = operation; assert.equal(f.api.readAppearance(dir), 'system'); }
});
test('Invalid saved modes never mutate files', () => {
  const f = fixture(); f.api.saveAppearance(dir, 'light'); const original = f.files.get(destination);
  for (const value of ['auto', 'Dark', '', null, undefined, 0, {}, ['dark']]) {
    assert.throws(() => f.api.saveAppearance(dir, value), e => e.message === saveError);
    assert.equal(f.files.get(destination), original); onlyDestination(f);
  }
});
test('Partial writes complete before fsync, close and atomic rename', () => {
  const f = fixture(); f.state.shortWrite = 3; f.api.saveAppearance(dir, 'dark');
  assert.equal(f.api.readAppearance(dir), 'dark'); onlyDestination(f);
  assert.deepEqual(f.state.events.slice(-3), ['fsync', 'close', 'rename']);
  assert(f.state.events.filter(event => event === 'write').length > 1);
});
test('Write, flush or rename failure preserves the old preference and closes handles', () => {
  for (const operation of ['open', 'write', 'fsync', 'rename']) {
    const f = fixture(); f.api.saveAppearance(dir, 'light'); const original = f.files.get(destination);
    f.state.fail = operation;
    assert.throws(() => f.api.saveAppearance(dir, 'dark'), e => e.message === saveError);
    assert.equal(f.files.get(destination), original); onlyDestination(f);
  }
});
test('Invalid write counts abort without replacing the old preference', () => {
  for (const count of [0, -1, 10000, 1.5, NaN]) {
    const f = fixture(); f.api.saveAppearance(dir, 'light'); const original = f.files.get(destination);
    f.state.forcedWrite = count; assert.throws(() => f.api.saveAppearance(dir, 'dark'), e => e.message === saveError);
    assert.equal(f.files.get(destination), original); onlyDestination(f);
  }
});
test('Application color API receives exact SDK enums without persistence side effects', () => {
  const f = fixture();
  for (const mode of ['system', 'light', 'dark']) f.api.applyAppearance(f.context, mode);
  assert.deepEqual(f.state.colors, [-1, 1, 0]); assert.equal(f.files.size, 0);
});
test('Invalid modes and SDK failures expose only the fixed application error', () => {
  const f = fixture();
  for (const value of ['auto', '', null, undefined, 0, {}]) {
    assert.throws(() => f.api.applyAppearance(f.context, value), e => e.message === applyError);
  }
  assert.equal(f.state.colors.length, 0); f.state.colorFail = true;
  assert.throws(() => f.api.applyAppearance(f.context, 'dark'), e => e.message === applyError);
});
test('Settings applies and persists the selection, which survives page re-entry', () => {
  const f = fixture(); f.page.aboutToAppear(); f.page.chooseAppearance('dark');
  assert.equal(f.page.appearance, 'dark'); assert.equal(f.api.readAppearance(dir), 'dark');
  f.page.appearance = 'system'; f.page.onPageShow(); assert.equal(f.page.appearance, 'dark');
});
test('Settings rolls back the active color mode if preference saving fails', () => {
  const f = fixture(); f.api.saveAppearance(dir, 'light'); f.page.aboutToAppear();
  f.state.fail = 'rename'; f.page.chooseAppearance('dark');
  assert.deepEqual(f.state.colors, [0, 1]); assert.equal(f.page.appearance, 'light');
  assert.equal(f.api.readAppearance(dir), 'light'); assert.match(f.page.message, /已恢复原外观/); onlyDestination(f);
});
test('Settings does not save a mode when the SDK cannot apply it', () => {
  const f = fixture(); f.state.colorFail = true; f.page.chooseAppearance('dark');
  assert.equal(f.page.appearance, 'system'); assert.equal(f.files.size, 0); assert.equal(f.page.message, applyError);
});
test('Developer tools request uses the agreed storage signal and returns to Home', () => {
  const f = fixture(); f.page.openDeveloperTools();
  assert.equal(f.appStorage.get('openDeveloperTools'), true); assert.equal(f.backs(), 1);
});
console.log(JSON.stringify({ suite: 'appearance', passed: cases.length, cases }, null, 2));
