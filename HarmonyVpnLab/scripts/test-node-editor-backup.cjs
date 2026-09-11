'use strict';
// Real ArkTS editor/catalog/parser with synthetic SDK and in-memory files.
// No device, node credentials, subscription requests or native core is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names = ['NodeImport', 'NodeCatalog', 'NodeEditor'];
const sources = new Map(names.map(name => [name, fs.readFileSync(path.join(root, `entry/src/main/ets/model/${name}.ets`), 'utf8')]));
const pageSource = fs.readFileSync(path.join(root, 'entry/src/main/ets/pages/NodeEditor.ets'), 'utf8');
let fieldValueBinding, fieldInputHandler;
const pageMethods = pageSource.split('  build() {')[0].replace(/@Entry\s*/g, '').replace(/@Component\s*/g, '')
  .replace(/@State\s*/g, '').replace(/@StorageProp\([^)]*\)\s*/g, '')
  .replace('struct NodeEditor', 'export class NodeEditor') + '\n}';
sources.set('NodeEditorPage', pageMethods);
const compiled = new Map([...sources].map(([name, source]) => {
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, name + ' SDK transpilation');
  return [name, result.outputText];
}));
const dir = '/synthetic-private', destination = `${dir}/node-catalog.json`;
const uuid = 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60';
const uuid2 = '15ecee7c-7b88-4911-adbd-252e3a57883d';
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const files = new Map(), handles = new Map(), cache = new Map();
  const state = { allowed: true, id: 0, fd: 0, renames: 0, failure: '', maxWrite: Infinity,
    dialogs: [], backs: 0, dialogFailure: false, failReadAfterRename: Infinity };
  function fail(name) { if (state.failure === name) throw Error('synthetic-secret-and-private-path'); }
  const io = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    accessSync: p => files.has(p), statSync: p => ({ size: files.get(p).length }),
    readTextSync: p => {
      if (state.renames >= state.failReadAfterRename) throw Error('synthetic-secret-readback');
      return files.get(p).toString('utf8');
    },
    openSync(p) { fail('open'); files.set(p, Buffer.alloc(0)); const file = { fd: ++state.fd }; handles.set(file.fd, p); return file; },
    writeSync(fd, input) { fail('write'); const data = Buffer.from(input).subarray(0, state.maxWrite); const p = handles.get(fd); files.set(p, Buffer.concat([files.get(p), data])); return data.length; },
    fsyncSync() { fail('fsync'); }, closeSync(file) { handles.delete(file.fd); },
    renameSync(from, to) { fail('rename'); files.set(to, files.get(from)); files.delete(from); state.renames++; },
    unlinkSync(p) { files.delete(p); }
  };
  const ark = { url: { URL: { parseURL: text => new URL(text) } }, util: {
    generateRandomUUID: () => `00000000-0000-4000-8000-${String(++state.id).padStart(12, '0')}`,
    TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } },
    TextDecoder: { create: (encoding, options) => ({ decodeToString: data => new TextDecoder(encoding, options).decode(data) }) },
    Base64Helper: class { decodeSync(text) { return Buffer.from(text, 'base64'); } }
  } };
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} }; cache.set(name, module.exports);
    const requireShim = spec => {
      if (spec === '@kit.ArkTS') return ark;
      if (spec === '@kit.AbilityKit') return {};
      if (spec === '@kit.CoreFileKit') return { fileIo: io };
      if (spec === './NodeEditGuard' || spec === '../model/NodeEditGuard') return {
        assertNodeManagementAllowed: checked => { assert.equal(checked, dir); if (!state.allowed) throw Error('请先断开连接。'); },
        isNodeManagementAllowed: checked => { assert.equal(checked, dir); return state.allowed; }
      };
      if (spec.startsWith('../model/')) return load(spec.slice('../model/'.length));
      if (spec.startsWith('./')) return load(spec.slice(2));
      throw Error('Unexpected dependency');
    };
    // All ArkTS modules share one Error identity in the application runtime.
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(name)}\n})`, { Error, $r: name => name }, { filename: name })(requireShim, module, module.exports);
    return module.exports;
  }
  const catalog = load('NodeCatalog'), parser = load('NodeImport'), editor = load('NodeEditor');
  function node(index = 1, protocol = 'vless', extra = {}) {
    const server = { address: `node-${index}.invalid`, port: 443 };
    let settings;
    if (protocol === 'vless' || protocol === 'vmess') {
      server.users = [{ id: uuid, ...(protocol === 'vless' ? { encryption: 'none' } : { alterId: 0, security: 'auto' }) }]; settings = { vnext: [server] };
    } else { server.password = 'synthetic-password'; if (protocol === 'shadowsocks') server.method = 'aes-128-gcm'; settings = { servers: [server] }; }
    const outbound = { protocol, settings, ...extra };
    if (protocol === 'trojan' && !outbound.streamSettings) outbound.streamSettings = { network: 'tcp', security: 'tls' };
    const parsed = parser.parseNode(JSON.stringify(outbound)); parsed.name = `Synthetic ${index}`; return parsed;
  }
  return { catalog, editor, parser, files, handles, state, node,
    page: nodeId => { const page = new (load('NodeEditorPage').NodeEditor)();
      page.getUIContext = () => ({ getHostContext: () => ({ filesDir: dir }),
        getRouter: () => ({ getParams: () => ({ nodeId }), back: () => { state.backs++; } }),
        getPromptAction: () => ({ showDialog: options => {
          if (state.dialogFailure) throw Error('synthetic-secret-dialog');
          return new Promise((resolve, reject) => { state.dialogs.push({ options, resolve, reject }); });
        } }) });
      return page; },
    read: () => catalog.readNodeCatalog(dir), bytes: () => files.get(destination)?.toString('utf8'),
    clean: () => { assert.equal(handles.size, 0); assert.equal([...files.keys()].filter(p => p.endsWith('.tmp')).length, 0); } };
}
const results = [];
function test(name, body) { body(); results.push({ name, passed: true }); }
function unchanged(f, operation) {
  const before = f.bytes(); assert.throws(operation, error => { assert(!error.message.includes('synthetic-secret')); assert(!error.message.includes('synthetic-password')); return true; });
  assert.equal(f.bytes(), before); f.clean();
}
function store(f) { f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]); return f.read(); }

test('Basic editor edits endpoint and credentials for each of the four protocols', () => {
  for (const protocol of ['vless', 'vmess', 'trojan', 'shadowsocks']) {
    const f = fixture(), original = f.node(1, protocol), draft = f.editor.nodeEditorDraft(original);
    draft.name = 'Edited'; draft.address = 'edited.invalid'; draft.port = '8443';
    draft.credential = ['vless', 'vmess'].includes(protocol) ? uuid2 : 'new-synthetic-password';
    if (protocol === 'shadowsocks') draft.method = 'chacha20-ietf-poly1305';
    const edited = f.editor.nodeFromEditorDraft(original, draft), after = f.editor.nodeEditorDraft(edited);
    assert.equal(after.address, 'edited.invalid'); assert.equal(after.port, '8443'); assert.equal(after.credential, draft.credential);
    assert.equal(edited.name, 'Edited'); assert.equal(f.editor.nodeEditorDraft(original).address, 'node-1.invalid');
  }
});
test('No-op form round trip preserves complete accepted outbound values and omissions', () => {
  const f = fixture(); const original = f.node(1, 'vless', { mux: { enabled: true, concurrency: 8 }, tag: 'keep-tag', sendThrough: '0.0.0.0' });
  const object = JSON.parse(original.outboundJson); object.settings.vnext[0].users[0].level = 7; object.settings.vnext[0].users[0].email = 'synthetic@example.invalid';
  original.outboundJson = JSON.stringify(object);
  assert.equal(f.editor.nodeFromEditorDraft(original, f.editor.nodeEditorDraft(original)).outboundJson, original.outboundJson);
});
test('TLS and WebSocket form updates retain extra accepted nested settings', () => {
  const f = fixture(); const original = f.node(1, 'vless', { streamSettings: { network: 'ws', security: 'tls',
    tlsSettings: { serverName: 'old.invalid', fingerprint: 'chrome', alpn: ['h2'], enableSessionResumption: true },
    wsSettings: { path: '/old', host: 'old.invalid', heartbeatPeriod: 25 }, sockopt: { tcpFastOpen: true } } });
  const draft = f.editor.nodeEditorDraft(original); draft.serverName = 'new.invalid'; draft.transportPath = '/new'; draft.transportHost = 'new.invalid'; draft.alpn = 'h2,http/1.1';
  const out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
  assert.equal(out.streamSettings.tlsSettings.enableSessionResumption, true); assert.equal(out.streamSettings.wsSettings.heartbeatPeriod, 25);
  assert.equal(out.streamSettings.sockopt.tcpFastOpen, true); assert.equal(out.streamSettings.wsSettings.path, '/new'); assert.deepEqual(out.streamSettings.tlsSettings.alpn, ['h2', 'http/1.1']);
});
test('REALITY and gRPC preserve parameters that the basic form does not expose', () => {
  const f = fixture(); const original = f.node(1, 'vless', { streamSettings: { network: 'grpc', security: 'reality',
    realitySettings: { serverName: 'sni.invalid', fingerprint: 'chrome', publicKey: 'a'.repeat(43), shortId: 'abcd', show: false },
    grpcSettings: { serviceName: 'old', authority: 'old.invalid', multiMode: true, idle_timeout: 60 } } });
  const draft = f.editor.nodeEditorDraft(original); draft.serverName = 'new.invalid'; draft.serviceName = 'new-service'; draft.authority = 'new-authority.invalid';
  const out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
  assert.equal(out.streamSettings.realitySettings.show, false); assert.equal(out.streamSettings.grpcSettings.multiMode, true);
  assert.equal(out.streamSettings.grpcSettings.idle_timeout, 60); assert.equal(out.streamSettings.grpcSettings.serviceName, 'new-service');
});
test('Advanced JSON preserves the full accepted object and supports an explicit protocol change', () => {
  const f = fixture(); const target = f.node(1, 'trojan', { streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'test.invalid' } }, mux: { enabled: false } });
  const edited = f.editor.nodeFromEditorJson('Chosen name', JSON.stringify(JSON.parse(target.outboundJson), null, 2));
  assert.equal(edited.outboundJson, target.outboundJson); assert.equal(edited.protocol, 'trojan'); assert.equal(edited.name, 'Chosen name');
});
test('String and array ALPN representations load and survive unrelated form edits exactly', () => {
  for (const alpn of ['h2', 'h2,http/1.1', ['h2', 'http/1.1']]) {
    const f = fixture();
    const original = f.node(1, 'vless', { streamSettings: { network: 'tcp', security: 'tls',
      tlsSettings: { serverName: 'sni.invalid', alpn, enableSessionResumption: true, minVersion: '1.2' },
      sockopt: { tcpFastOpen: true } } });
    const draft = f.editor.nodeEditorDraft(original);
    assert.equal(draft.alpn, typeof alpn === 'string' ? alpn : alpn.join(','));
    assert.equal(f.editor.nodeFromEditorDraft(original, draft).outboundJson, original.outboundJson);
    draft.port = '8443';
    const out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
    assert.deepEqual(out.streamSettings.tlsSettings.alpn, alpn);
    assert.equal(out.streamSettings.tlsSettings.enableSessionResumption, true);
    assert.equal(out.streamSettings.tlsSettings.minVersion, '1.2');
    assert.equal(out.streamSettings.sockopt.tcpFastOpen, true);
  }
});
test('Explicit ALPN edits and clearing keep other TLS fields and validate normally', () => {
  const f = fixture(), original = f.node(1, 'vless', { streamSettings: { network: 'tcp', security: 'tls',
    tlsSettings: { alpn: 'h2', serverName: 'sni.invalid', minVersion: '1.2' } } });
  const draft = f.editor.nodeEditorDraft(original); draft.alpn = 'http/1.1,h2';
  let out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
  assert.deepEqual(out.streamSettings.tlsSettings.alpn, ['http/1.1', 'h2']);
  draft.alpn = ''; out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
  assert.equal(out.streamSettings.tlsSettings.alpn, undefined); assert.equal(out.streamSettings.tlsSettings.minVersion, '1.2');
});
test('Legacy WebSocket Host is displayed while no-op and unrelated edits preserve headers', () => {
  for (const key of ['Host', 'host', 'hOsT']) {
    const f = fixture(), headers = { [key]: 'legacy.invalid', 'X-Preserve': 'synthetic-header-value' };
    const original = f.node(1, 'vless', { streamSettings: { network: 'ws', security: 'tls',
      tlsSettings: { serverName: 'sni.invalid' }, wsSettings: { path: '/path?ed=2048', headers, heartbeatPeriod: 25 } } });
    const draft = f.editor.nodeEditorDraft(original); assert.equal(draft.transportHost, 'legacy.invalid');
    assert.equal(f.editor.nodeFromEditorDraft(original, draft).outboundJson, original.outboundJson);
    draft.port = '8443'; const out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
    assert.deepEqual(out.streamSettings.wsSettings.headers, headers);
    assert.equal(out.streamSettings.wsSettings.host, undefined); assert.equal(out.streamSettings.wsSettings.heartbeatPeriod, 25);
  }
});
test('Changing or clearing a WebSocket Host removes its legacy fallback but retains unrelated headers', () => {
  for (const explicit of [undefined, '', 'explicit.invalid']) {
    for (const replacement of ['', 'replacement.invalid']) {
      const f = fixture(), original = f.node(1, 'vless', { streamSettings: { network: 'ws', security: 'tls',
        tlsSettings: { serverName: 'sni.invalid' }, wsSettings: { path: '/original', host: explicit,
          headers: { Host: 'legacy.invalid', 'X-Preserve': 'synthetic-header-value' } } } });
      const draft = f.editor.nodeEditorDraft(original);
      assert.equal(draft.transportHost, explicit || 'legacy.invalid'); draft.transportHost = replacement;
      const out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
      assert.equal(out.streamSettings.wsSettings.host, replacement || undefined);
      assert.deepEqual(out.streamSettings.wsSettings.headers, { 'X-Preserve': 'synthetic-header-value' });
      assert.equal(out.streamSettings.wsSettings.path, '/original');
      assert.equal(out.streamSettings.tlsSettings.serverName, 'sni.invalid');
    }
  }
});
test('Changing a legacy Host preserves unusual but valid literal header names', () => {
  const f = fixture(), headers = JSON.parse('{"Host":"legacy.invalid","__proto__":"preserved-literal","constructor":"preserved-constructor"}');
  const original = f.node(1, 'vless', { streamSettings: { network: 'ws', security: 'tls',
    tlsSettings: { serverName: 'sni.invalid' }, wsSettings: { path: '/ws', headers } } });
  const draft = f.editor.nodeEditorDraft(original); draft.transportHost = 'replacement.invalid';
  const out = JSON.parse(f.editor.nodeFromEditorDraft(original, draft).outboundJson);
  assert.equal(Object.hasOwn(out.streamSettings.wsSettings.headers, '__proto__'), true);
  assert.equal(out.streamSettings.wsSettings.headers.__proto__, 'preserved-literal');
  assert.equal(out.streamSettings.wsSettings.headers.constructor, 'preserved-constructor');
});
test('Complex supported nodes remain exact through catalog backup and restore', () => {
  const f = fixture();
  const nodes = [f.node(1, 'vless', { streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { alpn: 'h2', minVersion: '1.2' } } }),
    f.node(2, 'vless', { streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: 'sni.invalid' },
      wsSettings: { path: '/ws', headers: { Host: 'legacy.invalid', 'X-Preserve': 'synthetic-header-value' } } } })];
  f.catalog.importManualNodes(dir, nodes); const backup = f.catalog.exportNodeCatalogBackup(dir);
  const restored = fixture(); restored.catalog.restoreNodeCatalogBackup(dir, backup, 0);
  assert.deepEqual(restored.read().nodes.map(node => node.outboundJson).join('\n'), nodes.map(node => node.outboundJson).join('\n'));
  for (const saved of restored.read().nodes) assert.equal(restored.editor.nodeFromEditorDraft(saved, restored.editor.nodeEditorDraft(saved)).outboundJson, saved.outboundJson);
});
test('Unsupported structural transitions and invalid form values cannot mutate the original', () => {
  const f = fixture(), original = f.node(), before = original.outboundJson;
  for (const [key, value] of [['network', 'grpc'], ['protocol', 'trojan'], ['port', '0'], ['port', '1e3'], ['port', '65536'], ['credential', 'bad-uuid']]) {
    const draft = f.editor.nodeEditorDraft(original); draft[key] = value;
    assert.throws(() => f.editor.nodeFromEditorDraft(original, draft)); assert.equal(original.outboundJson, before);
  }
});
test('Advanced editor rejects malformed/full-config/oversized input without reflecting secrets', () => {
  const f = fixture();
  for (const input of ['{"synthetic-secret":', '{"outbounds":[]}', 'vless://synthetic-secret', ' '.repeat(65537)]) {
    assert.throws(() => f.editor.nodeFromEditorJson('name', input), error => !error.message.includes('synthetic-secret'));
  }
});
test('Update targets an explicit non-active ID and retains selection and subscription ownership', () => {
  const f = fixture(); const first = store(f);
  f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://subscription.invalid/list', [f.node(3)]);
  const catalog = f.read(), target = catalog.nodes[2], draft = f.editor.nodeEditorDraft(target); draft.address = 'changed.invalid';
  f.catalog.updateCatalogNode(dir, target.id, f.editor.nodeFromEditorDraft(target, draft), catalog.revision);
  const after = f.read(); assert.equal(after.activeNodeId, first.activeNodeId); assert.equal(after.nodes[2].sourceId, target.sourceId);
  assert.equal(after.nodes[2].id, target.id); assert.equal(after.revision, catalog.revision + 1); assert.equal(after.nodes.length, 3);
});
test('Duplicate edits and stale revisions preserve the original catalog', () => {
  const f = fixture(), catalog = store(f);
  unchanged(f, () => f.catalog.updateCatalogNode(dir, catalog.nodes[1].id, f.node(1), catalog.revision));
  f.catalog.renameCatalogNode(dir, catalog.nodes[0].id, 'Changed elsewhere');
  unchanged(f, () => f.catalog.updateCatalogNode(dir, catalog.nodes[1].id, f.node(3), catalog.revision));
});
test('Single outbound export is exact, re-importable and does not write', () => {
  const f = fixture(), catalog = store(f), count = f.state.renames;
  const text = f.catalog.exportCatalogNode(dir, catalog.nodes[1].id);
  assert.equal(text, catalog.nodes[1].outboundJson); assert.equal(f.parser.parseNode(text).outboundJson, text); assert.equal(f.state.renames, count);
});
test('Backup round trip contains names, subscription metadata, stable IDs and active choice', () => {
  const f = fixture(); store(f); f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://subscription.invalid/list?token=synthetic', [f.node(3)]);
  f.catalog.selectCatalogNode(dir, f.read().nodes[2].id); const before = f.read(), count = f.state.renames;
  const text = f.catalog.exportNodeCatalogBackup(dir), envelope = JSON.parse(text);
  assert.equal(envelope.format, 'harmony-vpn-node-backup'); assert.equal(envelope.schemaVersion, 2); assert.equal(typeof envelope.exportedAt, 'number');
  assert.deepEqual(plain(f.catalog.previewNodeCatalogBackup(text)), plain(before)); assert.equal(f.state.renames, count);
});
test('Restore atomically replaces nodes and subscriptions while incrementing the local revision', () => {
  const source = fixture(); store(source); source.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://subscription.invalid/list', [source.node(3)]);
  source.catalog.selectCatalogNode(dir, source.read().nodes[2].id); const snapshot = source.read(), text = source.catalog.exportNodeCatalogBackup(dir);
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(9)]); const revision = f.read().revision; f.state.maxWrite = 7;
  f.catalog.restoreNodeCatalogBackup(dir, text, revision); const after = f.read();
  assert.equal(after.revision, revision + 1); assert.deepEqual(plain(after.nodes), plain(snapshot.nodes)); assert.deepEqual(plain(after.subscriptions), plain(snapshot.subscriptions));
  assert.equal(after.activeNodeId, snapshot.activeNodeId); f.clean();
});
test('Preview rejects malformed schemas, dangling IDs, duplicates and invalid subscription URLs', () => {
  const f = fixture(); store(f); f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://subscription.invalid/list', [f.node(3)]);
  const text = f.catalog.exportNodeCatalogBackup(dir);
  const changes = [b => { b.schemaVersion = 3; }, b => { b.extra = 'private-value'; }, b => { b.catalog.extra = 1; },
    b => { b.catalog.activeNodeId = 'missing'; }, b => { b.catalog.nodes[0].sourceId = 'missing'; },
    b => { b.catalog.nodes[1].outboundJson = b.catalog.nodes[0].outboundJson; },
    b => { b.catalog.subscriptions[0].url = 'http://insecure.invalid'; }, b => { b.catalog.nodes[0].id = '../escape'; }];
  const before = f.bytes(), writes = f.state.renames;
  for (const change of changes) { const bad = JSON.parse(text); change(bad); assert.throws(() => f.catalog.previewNodeCatalogBackup(JSON.stringify(bad))); }
  assert.equal(f.bytes(), before); assert.equal(f.state.renames, writes);
});
test('Oversized backup text is rejected before storage mutation', () => {
  const f = fixture(); store(f); unchanged(f, () => f.catalog.restoreNodeCatalogBackup(dir, ' '.repeat(5 * 1024 * 1024 + 1), f.read().revision));
});
test('Busy connection blocks both editing and restore', () => {
  const f = fixture(), catalog = store(f), backup = f.catalog.exportNodeCatalogBackup(dir); f.state.allowed = false;
  unchanged(f, () => f.catalog.updateCatalogNode(dir, catalog.nodes[0].id, f.node(4), catalog.revision));
  unchanged(f, () => f.catalog.restoreNodeCatalogBackup(dir, backup, catalog.revision));
});
test('Changes after restore preview invalidate confirmation', () => {
  const f = fixture(), catalog = store(f), backup = f.catalog.exportNodeCatalogBackup(dir);
  f.catalog.renameCatalogNode(dir, catalog.nodes[0].id, 'Changed after preview');
  unchanged(f, () => f.catalog.restoreNodeCatalogBackup(dir, backup, catalog.revision));
});
test('Storage failures during edit or restore leave the previous bytes and close temporaries', () => {
  for (const failure of ['open', 'write', 'fsync', 'rename']) {
    const f = fixture(), catalog = store(f), backup = f.catalog.exportNodeCatalogBackup(dir); f.state.failure = failure;
    unchanged(f, () => f.catalog.updateCatalogNode(dir, catalog.nodes[0].id, f.node(8), catalog.revision));
    unchanged(f, () => f.catalog.restoreNodeCatalogBackup(dir, backup, catalog.revision));
  }
});
test('An explicitly confirmed valid empty backup restores an empty catalog', () => {
  const empty = fixture(), backup = empty.catalog.exportNodeCatalogBackup(dir); const f = fixture(), catalog = store(f);
  f.catalog.restoreNodeCatalogBackup(dir, backup, catalog.revision); assert.equal(f.read().nodes.length, 0); assert.equal(f.read().activeNodeId, '');
});
test('Editor page saves the requested node instead of the active node', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.nodes[1].id); page.aboutToAppear();
  assert.equal(page.loaded, true); page.draft.name = 'Edited in page'; page.draft.address = 'page-edit.invalid'; page.save();
  assert.equal(f.read().nodes[1].name, 'Edited in page'); assert.equal(f.read().activeNodeId, catalog.activeNodeId);
  assert.equal(f.editor.nodeEditorDraft(f.read().nodes[1]).address, 'page-edit.invalid'); assert.match(page.message, /已保存/);
});
test('Switching page editors retains unsaved basic changes and accepted raw-only fields', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  page.draft.address = 'unsaved.invalid'; page.switchEditor(); assert.equal(page.jsonMode, true);
  const raw = JSON.parse(page.jsonText); assert.equal(raw.settings.vnext[0].address, 'unsaved.invalid');
  raw.mux = { enabled: true, concurrency: 4 }; page.jsonText = JSON.stringify(raw); page.switchEditor();
  assert.equal(page.jsonMode, false); assert.equal(page.draft.address, 'unsaved.invalid');
  page.draft.port = '8443'; page.save(); const saved = JSON.parse(f.read().nodes[0].outboundJson);
  assert.deepEqual(saved.mux, { enabled: true, concurrency: 4 }); assert.equal(saved.settings.vnext[0].port, 8443);
});
test('Editor page loads string ALPN and legacy Host without dirtying the saved configuration', () => {
  const f = fixture(), original = f.node(1, 'vless', { streamSettings: { network: 'ws', security: 'tls',
    tlsSettings: { alpn: 'http/1.1', serverName: 'sni.invalid' },
    wsSettings: { path: '/ws', headers: { Host: 'legacy.invalid', 'X-Preserve': 'synthetic-header-value' } } } });
  f.catalog.importManualNodes(dir, [original]); const before = f.bytes(), catalog = f.read(), writes = f.state.renames;
  const page = f.page(catalog.activeNodeId); page.aboutToAppear();
  assert.equal(page.loaded, true); assert.equal(page.dirty, false); assert.equal(page.draft.transportHost, 'legacy.invalid');
  page.switchEditor(); page.switchEditor(); page.save(); assert.equal(f.state.renames, writes); assert.equal(f.bytes(), before);
  page.draft.name = 'Renamed complex node'; page.draftChanged(); page.save();
  assert.equal(page.dirty, false); assert.equal(f.read().nodes[0].outboundJson, original.outboundJson);
});
test('Invalid raw page edits remain available for correction and never write', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear(); page.switchEditor();
  const before = f.bytes(); page.jsonText = '{synthetic-secret'; page.switchEditor();
  assert.equal(page.jsonMode, true); assert.equal(page.jsonText, '{synthetic-secret'); page.save();
  assert.equal(f.bytes(), before); assert(!page.message.includes('synthetic-secret'));
});
test('Editor page rejects concurrent catalog updates and connection activation before save', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.nodes[1].id); page.aboutToAppear(); page.draft.address = 'must-not-save.invalid';
  f.catalog.renameCatalogNode(dir, catalog.activeNodeId, 'Updated elsewhere'); const before = f.bytes(); page.save();
  assert.equal(f.bytes(), before); assert.match(page.message, /发生变化/);
  f.state.allowed = false; page.save(); assert.equal(f.bytes(), before); assert.match(page.message, /断开连接/);
});
test('Editor rejects invalid route IDs and clears displayed credentials on disposal', () => {
  const f = fixture(), catalog = store(f), bad = f.page('../not-a-node'); bad.aboutToAppear(); assert.equal(bad.loaded, false);
  const page = f.page(catalog.activeNodeId); page.aboutToAppear(); page.switchEditor(); page.aboutToDisappear();
  assert.equal(page.original, undefined); assert.equal(page.jsonText, ''); assert.equal(page.draft.credential, '');
});
test('Unchanged and reverted editor values never commit a catalog revision', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  const before = f.bytes(), writes = f.state.renames;
  assert.equal(page.dirty, false); page.save(); assert.equal(f.state.renames, writes);
  const address = page.draft.address; page.draft.address = 'changed.invalid'; page.draftChanged(); assert.equal(page.dirty, true);
  page.draft.address = address; page.draftChanged(); assert.equal(page.dirty, false);
  page.switchEditor(); assert.equal(page.dirty, false); page.jsonText = JSON.stringify(JSON.parse(page.jsonText), null, 2);
  page.draftChanged(); assert.equal(page.dirty, false); page.save(); page.switchEditor();
  assert.equal(page.dirty, false); assert.equal(f.bytes(), before); assert.equal(f.state.renames, writes);
});

test('Invalid ports show fixed field feedback and retain the draft without writing', () => {
  for (const port of ['', '0', '65536', '-1', '4.5', 'oops']) {
    const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
    const before = f.bytes(); page.draft.port = port; page.draftChanged(); page.save();
    assert.equal(page.dirty, true); assert.equal(page.draft.port, port); assert.match(page.portError, /1–65535/);
    assert.equal(page.message, page.portError); assert.equal(f.bytes(), before);
  }
});

test('Failed save keeps credentials and dirty draft; successful retry establishes a fresh baseline', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  page.draft.address = 'retry.invalid'; page.draftChanged(); const before = f.bytes(), credential = page.draft.credential;
  f.state.failure = 'write'; page.save(); assert.equal(f.bytes(), before); assert.equal(page.dirty, true);
  assert.equal(page.draft.address, 'retry.invalid'); assert.equal(page.draft.credential, credential);
  assert(!page.message.includes('synthetic-secret')); assert(!page.message.includes(credential));
  f.state.failure = ''; page.save(); assert.equal(page.dirty, false); assert.match(page.message, /已保存/);
  const writes = f.state.renames; page.save(); assert.equal(f.state.renames, writes);
});

test('Committed save with failed readback retains the draft and reports commit uncertainty', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  page.draft.address = 'readback.invalid'; page.draftChanged(); f.state.failReadAfterRename = f.state.renames + 1;
  page.save(); assert.match(page.message, /保存已提交，但读回未确认/); assert.equal(page.dirty, true);
  assert.equal(page.draft.address, 'readback.invalid'); assert(!page.message.includes('synthetic-secret'));
});

test('Actual ArkUI bindings keep feedback beside save and preserve numeric/password input behavior', () => {
  const options = ts.readConfigFile(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/tsconfig.json'), ts.sys.readFile).config.compilerOptions;
  const ast = ts.createSourceFile('NodeEditor.ets', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, options);
  assert.equal(ast.parseDiagnostics.length, 0);
  const ids = new Map(); let typeBinding, input, inputEnabled;
  function walk(node) {
    if ((ts.isCallExpression(node) || ts.isEtsComponentExpression(node)) && node.expression?.getText(ast) === 'TextInput') input = node;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === 'id' && ts.isStringLiteral(node.arguments[0])) ids.set(node.arguments[0].text, node);
      if (node.expression.name.text === 'type' && node.arguments[0].getText(ast).includes('InputType.Number')) typeBinding = node.arguments[0];
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  const structure = ast.statements.find(node => node.kind === ts.SyntaxKind.StructDeclaration);
  const field = structure.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'field');
  assert.deepEqual(field.parameters.map(parameter => parameter.name.getText(ast)), ['label', 'id', 'sensitive', 'limit']);
  const text = input.arguments[0].properties.find(property => property.name.getText(ast) === 'text').initializer;
  assert.equal(text.getText(ast), 'this.fieldValue(id)');
  fieldValueBinding = new Function('id', 'return ' + text.getText(ast));
  let changed;
  for (let node = input.parent; node && !ts.isExpressionStatement(node); node = node.parent) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === 'onChange') changed = node.arguments[0];
      if (node.expression.name.text === 'enabled') inputEnabled = node.arguments[0];
    }
  }
  assert(changed && inputEnabled);
  const callback = ts.transpileModule('export function fieldInputHandler(id: string) { return ' + changed.getText(ast) + '; }', {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }
  });
  const callbackScope = { exports: {} }; vm.runInNewContext(callback.outputText, callbackScope);
  fieldInputHandler = callbackScope.exports.fieldInputHandler;
  const inputIsEnabled = new Function('return ' + inputEnabled.getText(ast));
  assert.equal(inputIsEnabled.call({ editable: true, leaving: false, confirmingLeave: false }), true);
  assert.equal(inputIsEnabled.call({ editable: true, leaving: false, confirmingLeave: true }), true);
  function owningComponent(node) {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isEtsComponentExpression(parent)) return parent;
  }
  const result = ids.get('nodeEditorResult'), save = ids.get('saveNodeEditor');
  assert(result && save); assert.equal(owningComponent(result), owningComponent(save));
  for (let node = result.parent; node; node = node.parent) {
    if (ts.isEtsComponentExpression(node)) assert.notEqual(node.expression.getText(ast), 'Scroll');
  }
  assert(ids.has('nodeEditorDirtyState')); assert(ids.has('editNodePortError')); assert(typeBinding);
  const evaluateType = new Function('sensitive', 'id', 'InputType', 'return ' + typeBinding.getText(ast));
  const types = { Password: 'password', Number: 'digits', Normal: 'normal' };
  assert.equal(evaluateType(false, 'editNodePort', types), 'digits');
  assert.equal(evaluateType(true, 'editNodeCredential', types), 'password');
  assert.equal(evaluateType(false, 'editNodeAddress', types), 'normal');
  let enabled;
  for (let node = save.parent; node && !ts.isExpressionStatement(node); node = node.parent) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'enabled') enabled = node.arguments[0];
  }
  assert(enabled);
  const evaluateEnabled = new Function('return ' + enabled.getText(ast));
  const ready = { loaded: true, editable: true, dirty: true, confirmingLeave: false, leaving: false };
  assert.equal(evaluateEnabled.call(ready), true);
  for (const denied of [{ dirty: false }, { editable: false }, { confirmingLeave: true }, { leaving: true }]) {
    assert.equal(evaluateEnabled.call({ ...ready, ...denied }), false);
  }
});

test('Keyed field updates replace observed draft state and preserve every other field', () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  const fields = { editNodeName: 'name', editNodeAddress: 'address', editNodePort: 'port', editNodeCredential: 'credential',
    editNodeMethod: 'method', editNodeFlow: 'flow', editNodeSni: 'serverName', editNodeFingerprint: 'fingerprint',
    editNodeAlpn: 'alpn', editNodePublicKey: 'publicKey', editNodeShortId: 'shortId', editNodeSpiderX: 'spiderX',
    editNodeWsHost: 'transportHost', editNodeWsPath: 'transportPath', editNodeGrpcService: 'serviceName', editNodeGrpcAuthority: 'authority' };
  for (const [id, key] of Object.entries(fields)) {
    const previous = page.draft, before = plain(previous), value = key === 'port' ? '70000' : 'synthetic-value';
    page.changeField(id, value); assert.notEqual(page.draft, previous); assert.deepEqual(plain(previous), before);
    assert.equal(page.fieldValue(id), value); assert.deepEqual(plain(page.draft), { ...before, [key]: value });
  }
  const current = page.draft; page.changeField('unknown-field', 'ignored'); assert.equal(page.draft, current);
  page.editable = false; page.changeField('editNodePort', '443'); assert.equal(page.draft.port, '70000');
});

async function asyncTest(name, body) {
  try { await body(); results.push({ name, passed: true }); }
  catch (_) { throw new Error(name); }
}
(async () => {
await asyncTest('Clean explicit return navigates without a dialog; clean system return is delegated to the platform', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  assert.equal(page.onBackPress(), false); assert.equal(f.state.backs, 0);
  await page.requestBack(); assert.equal(f.state.backs, 1); assert.equal(f.state.dialogs.length, 0);
  await page.requestBack(); assert.equal(page.onBackPress(), true); assert.equal(f.state.backs, 1);
});
await asyncTest('Continue editing after explicit return keeps unsaved content and catalog unchanged', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  const before = f.bytes(); page.draft.address = 'stay.invalid'; page.draftChanged();
  const pending = page.requestBack(); assert.equal(page.confirmingLeave, true); assert.equal(page.draft.address, 'stay.invalid');
  const dialog = f.state.dialogs[0];
  assert.deepEqual(dialog.options.buttons.map(button => button.text).join('|'), '继续编辑|放弃修改');
  assert(!JSON.stringify(dialog.options).includes(page.draft.credential)); assert(!JSON.stringify(dialog.options).includes('stay.invalid'));
  dialog.resolve({ index: 0 }); await pending;
  assert.equal(f.state.backs, 0); assert.equal(page.draft.address, 'stay.invalid'); assert.equal(page.dirty, true);
  assert.equal(page.confirmingLeave, false); assert.equal(f.bytes(), before);
});
await asyncTest('Actual keyed input binding retains 70000 through modal rerender, stale change and repeated appearance', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  const before = f.bytes(), initialDraft = page.draft;
  const onChange = fieldInputHandler.call(page, 'editNodePort');
  assert.equal(fieldValueBinding.call(page, 'editNodePort'), '443');
  onChange('70000'); assert.notEqual(page.draft, initialDraft); assert.equal(page.dirty, true);
  const pending = page.requestBack(); assert.equal(page.confirmingLeave, true);
  assert.equal(fieldValueBinding.call(page, 'editNodePort'), '70000');
  onChange('443'); page.aboutToAppear(); page.onPageShow();
  assert.equal(fieldValueBinding.call(page, 'editNodePort'), '70000'); assert.equal(page.dirty, true);
  f.state.dialogs[0].resolve({ index: 0 }); await pending;
  assert.equal(fieldValueBinding.call(page, 'editNodePort'), '70000'); assert.equal(page.dirty, true); assert.equal(f.state.backs, 0);
  page.save(); assert.match(page.message, /1–65535/); assert.equal(page.draft.port, '70000'); assert.equal(f.bytes(), before);
});
await asyncTest('JSON draft rejects stale text callbacks while return confirmation is open', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear(); page.switchEditor();
  const baseline = page.jsonText; page.changeJson('{invalid-synthetic-json'); assert.equal(page.dirty, true);
  const pending = page.requestBack(); page.changeJson(baseline); page.aboutToAppear();
  assert.equal(page.jsonText, '{invalid-synthetic-json'); f.state.dialogs[0].resolve({ index: 0 }); await pending;
  assert.equal(page.jsonText, '{invalid-synthetic-json'); assert.equal(page.dirty, true); assert.equal(f.state.backs, 0);
});
await asyncTest('Dirty system back is consumed and discard is the only dialog choice that leaves', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  const before = f.bytes(); page.draft.port = '8443'; page.draftChanged();
  assert.equal(page.onBackPress(), true); assert.equal(f.state.dialogs.length, 1);
  f.state.dialogs[0].resolve({ index: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.backs, 1); assert.equal(page.original, undefined); assert.equal(page.baseline, undefined);
  assert.equal(page.jsonText, ''); assert.equal(page.draft.credential, ''); assert.equal(page.dirty, false); assert.equal(f.bytes(), before);
  await page.requestBack(); assert.equal(page.onBackPress(), true); assert.equal(f.state.backs, 1);
});
await asyncTest('Repeated back/save/switch while a dialog is pending cannot duplicate prompts or commit', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  page.draft.address = 'pending.invalid'; page.draftChanged(); const before = f.bytes();
  const pending = page.requestBack(); await page.requestBack(); assert.equal(page.onBackPress(), true);
  page.save(); page.switchEditor(); assert.equal(page.jsonMode, false); assert.equal(f.bytes(), before);
  assert.equal(f.state.dialogs.length, 1); f.state.dialogs[0].resolve({ index: 0 }); await pending;
  assert.equal(f.state.backs, 0); assert.equal(page.draft.address, 'pending.invalid');
});
await asyncTest('Old dialog success cannot leave a new page or clear a newer pending dialog', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  page.draft.address = 'old.invalid'; page.draftChanged(); const old = page.requestBack();
  page.aboutToDisappear(); page.aboutToAppear(); page.draft.address = 'fresh.invalid'; page.draftChanged();
  const fresh = page.requestBack(); f.state.dialogs[0].resolve({ index: 1 }); await old;
  assert.equal(f.state.backs, 0); assert.equal(page.draft.address, 'fresh.invalid'); assert.equal(page.confirmingLeave, true);
  f.state.dialogs[1].resolve({ index: 0 }); await fresh; assert.equal(page.confirmingLeave, false);
});
await asyncTest('Late dialog failure and dialog API errors retain drafts without exposing errors', async () => {
  const f = fixture(), catalog = store(f), page = f.page(catalog.activeNodeId); page.aboutToAppear();
  page.draft.port = '8443'; page.draftChanged(); const pending = page.requestBack();
  page.aboutToDisappear(); page.aboutToAppear(); page.message = 'current-page-message';
  f.state.dialogs[0].reject(Error('synthetic-secret-dialog')); await pending; assert.equal(page.message, 'current-page-message');
  page.draft.port = '8443'; page.draftChanged(); f.state.dialogFailure = true; await page.requestBack();
  assert.equal(page.draft.port, '8443'); assert.equal(page.dirty, true); assert.equal(f.state.backs, 0);
  assert(!page.message.includes('synthetic-secret')); assert.equal(page.confirmingLeave, false);
});
const report = { suite: 'node-editor-backup', passed: results.length, failed: 0,
  scope: 'Actual ArkTS methods with synthetic SDK/files. No native core, phone or network test.',
  sourceSHA256: Object.fromEntries([...sources].map(([name, source]) => [name === 'NodeEditorPage' ? 'pages/NodeEditor.ets' : `model/${name}.ets`,
    crypto.createHash('sha256').update(name === 'NodeEditorPage' ? pageSource : source).digest('hex')])), results };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/node-editor-backup-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ suite: report.suite, passed: report.passed, failed: report.failed, scope: report.scope }));
})().catch(error => { console.error('Node editor interaction verification failed: ' + error.message); process.exitCode = 1; });
