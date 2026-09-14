'use strict';
// Actual authored ArkTS store/profile/parser, transpiled with the installed SDK.
// Synthetic in-memory SDK/files only: no user configuration, HDC or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const filenames = ['NodeCatalog.ets', 'NodeProfile.ets', 'NodeImport.ets', 'NodeIssue.ets'];
const sources = new Map(filenames.map(name => [name,
  fs.readFileSync(path.join(root, 'entry/src/main/ets/model', name), 'utf8')]));
const compiled = new Map([...sources].map(([name, source]) => {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
  });
  assert.equal(result.diagnostics.length, 0, `${name} SDK transpilation`);
  return [name, result.outputText];
}));
const dir = '/synthetic-private';
const destination = `${dir}/node-catalog.json`;
const legacyPath = `${dir}/node-profile.json`;
function fixture() {
  const files = new Map(), handles = new Map();
  const state = { allowed: true, guardCalls: 0, nextFd: 1, nextUuid: 1,
    writeCalls: 0, renames: 0, partial: 0, maxWrite: Infinity, failWriteAfter: Infinity,
    zeroWrite: false, badWriteCount: false, failRename: false, failSync: false, failOpen: false };
  const io = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    accessSync: file => files.has(file),
    statSync: file => { if (!files.has(file)) throw Error('synthetic missing'); return { size: files.get(file).length }; },
    readTextSync: file => { if (!files.has(file)) throw Error('synthetic missing'); return files.get(file).toString('utf8'); },
    openSync(file) {
      if (state.failOpen) throw Error('fake-secret-in-filesystem-error');
      files.set(file, Buffer.alloc(0)); const fd = state.nextFd++;
      handles.set(fd, { path: file, position: 0 }); return { fd };
    },
    writeSync(fd, input) {
      state.writeCalls++;
      if (state.writeCalls > state.failWriteAfter) throw Error('fake-secret-in-filesystem-error');
      if (state.zeroWrite) return 0;
      const bytes = Buffer.from(input), handle = handles.get(fd);
      if (state.badWriteCount) return bytes.length + 1;
      const count = Math.min(bytes.length, state.maxWrite);
      if (count < bytes.length) state.partial++;
      const old = files.get(handle.path);
      const next = Buffer.alloc(Math.max(old.length, handle.position + count));
      old.copy(next); bytes.copy(next, handle.position, 0, count);
      handle.position += count; files.set(handle.path, next); return count;
    },
    fsyncSync(fd) { assert(handles.has(fd)); if (state.failSync) throw Error('fake-secret-in-filesystem-error'); },
    closeSync(file) { assert(handles.delete(file.fd)); },
    renameSync(from, to) {
      if (state.failRename) throw Error('fake-secret-in-filesystem-error');
      state.renames++; assert(files.has(from)); files.set(to, files.get(from)); files.delete(from);
    },
    unlinkSync(file) { assert(files.delete(file)); }
  };
  const cache = new Map();
  const ark = {
    url: { URL: { parseURL: input => new URL(input) } },
    util: {
      generateRandomUUID: () => `00000000-0000-4000-8000-${String(state.nextUuid++).padStart(12, '0')}`,
      TextEncoder: class { encodeInto(input) { return new TextEncoder().encode(input); } },
      TextDecoder: { create: (encoding, options) => ({ decodeToString: input => new TextDecoder(encoding, options).decode(input) }) },
      Base64Helper: class { decodeSync(input) { return Buffer.from(input, 'base64'); } }
    }
  };
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} }; cache.set(name, module.exports);
    const requireShim = spec => {
      if (spec === '@kit.ArkTS') return ark;
      if (spec === '@kit.CoreFileKit') return { fileIo: io };
      if (spec === './NodeEditGuard') return { assertNodeManagementAllowed: checkedDir => {
        assert.equal(checkedDir, dir); state.guardCalls++;
        if (!state.allowed) throw Error('synthetic active connection guard');
      } };
      if (spec.startsWith('./')) return load(`${spec.slice(2)}.ets`);
      throw Error('unexpected dependency');
    };
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(name)}\n})`, {}, { filename: name })(
      requireShim, module, module.exports);
    return module.exports;
  }
  const catalog = load('NodeCatalog.ets'), profile = load('NodeProfile.ets'), parser = load('NodeImport.ets');
  const node = (n, name = `fictional-${n}`) => parser.parseNode(
    `vless://d83b7e56-c9d8-4ce7-b8fb-90a784b40c60@node-${n}.invalid:443?type=tcp&security=none#${encodeURIComponent(name)}`);
  return { files, handles, state, catalog, profile, parser, node,
    read: () => catalog.readNodeCatalog(dir),
    bytes: () => files.get(destination)?.toString('utf8'),
    raw(value) { files.set(destination, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); },
    assertClean() { assert.equal(handles.size, 0); assert.equal([...files.keys()].filter(key => key.endsWith('.tmp')).length, 0); }
  };
}
const results = [];
function test(name, run) { run(); results.push(name); }
function unchanged(f, run) {
  const before = f.bytes();
  assert.throws(run, error => {
    assert(!error.message.includes('d83b7e56'));
    assert(!error.message.includes('.invalid'));
    assert(!error.message.includes('fake-secret'));
    return true;
  });
  assert.equal(f.bytes(), before); f.assertClean();
}
test('empty store has no active node and does not write', () => {
  const f = fixture(); assert.equal(f.read().nodes.length, 0); assert.equal(f.catalog.readActiveNode(dir), undefined);
  assert.equal(f.read().schemaVersion, 2); assert.equal(f.files.size, 0);
});

function asV1(catalog) {
  const old = JSON.parse(JSON.stringify(catalog)); old.schemaVersion = 1;
  for (const node of old.nodes) delete node.favorite;
  return old;
}

test('strict v1 catalog migrates in memory without write guard or revision change', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]);
  const old = asV1(f.read()); old.revision = 37; f.raw(old);
  const before = f.bytes(), renames = f.state.renames, guards = f.state.guardCalls;
  f.state.allowed = false;
  const migrated = f.read();
  assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.revision, 37);
  assert(migrated.nodes.every(node => node.favorite === false));
  assert.equal(JSON.stringify(asV1(migrated)), JSON.stringify(old));
  assert.equal(f.catalog.readActiveNode(dir).outboundJson, old.nodes[0].outboundJson);
  const backup = JSON.parse(f.catalog.exportNodeCatalogBackup(dir));
  assert.equal(backup.schemaVersion, 2); assert.equal(backup.catalog.schemaVersion, 2);
  assert.equal(backup.catalog.revision, 37);
  assert.equal(f.bytes(), before); assert.equal(f.state.renames, renames);
  assert.equal(f.state.guardCalls, guards);
});

test('empty v1 catalog upgrades read-only and commits v2 on the next import', () => {
  const f = fixture(); const old = asV1(f.read()); old.revision = 5; f.raw(old);
  const before = f.bytes(); assert.equal(f.read().schemaVersion, 2); assert.equal(f.bytes(), before);
  f.catalog.importManualNodes(dir, [f.node(1)]);
  const disk = JSON.parse(f.bytes()); assert.equal(disk.schemaVersion, 2); assert.equal(disk.revision, 6);
  assert.equal(disk.nodes[0].favorite, false); assert.equal(f.state.renames, 1);
});

test('v1 no-op selection, import and favorite leave the original bytes untouched', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]); f.raw(asV1(f.read()));
  const before = f.bytes(), active = f.read().activeNodeId, renames = f.state.renames;
  f.catalog.selectCatalogNode(dir, active); f.catalog.importManualNodes(dir, [f.node(1)]);
  f.catalog.setCatalogNodeFavorite(dir, active, false);
  assert.equal(f.bytes(), before); assert.equal(f.state.renames, renames);
});

test('favorite commits v1 migration in one revision and is idempotent', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]); f.raw(asV1(f.read()));
  const old = f.read(), target = old.nodes[1], renames = f.state.renames;
  f.catalog.setCatalogNodeFavorite(dir, target.id, true);
  const disk = JSON.parse(f.bytes()); assert.equal(disk.schemaVersion, 2);
  assert.equal(disk.revision, old.revision + 1); assert.equal(disk.activeNodeId, old.activeNodeId);
  assert.equal(disk.nodes[1].favorite, true); assert.equal(disk.nodes[0].favorite, false);
  assert.equal(disk.nodes[1].modifiedAt, target.modifiedAt); assert.equal(f.state.renames, renames + 1);
  const before = f.bytes(); f.catalog.setCatalogNodeFavorite(dir, target.id, true); assert.equal(f.bytes(), before);
  f.catalog.setCatalogNodeFavorite(dir, target.id, false);
  assert.equal(f.read().nodes[1].favorite, false); assert.equal(f.read().revision, old.revision + 2);
});

test('favorite rejects a missing identity and every non-boolean without changing bytes', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  unchanged(f, () => f.catalog.setCatalogNodeFavorite(dir, 'missing', true));
  for (const value of [undefined, null, 0, 1, '', 'false', [], {}, NaN]) {
    unchanged(f, () => f.catalog.setCatalogNodeFavorite(dir, f.read().activeNodeId, value));
  }
});

test('favorite survives duplicate import, rename, identity edit and active profile edit', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]);
  const id = f.read().activeNodeId; f.catalog.setCatalogNodeFavorite(dir, id, true);
  const before = f.bytes(); f.catalog.importManualNodes(dir, [f.node(1)]); assert.equal(f.bytes(), before);
  f.catalog.renameCatalogNode(dir, id, 'Favorite renamed'); assert.equal(f.read().nodes[0].favorite, true);
  f.catalog.updateCatalogNode(dir, id, f.node(3), f.read().revision);
  assert.equal(f.read().nodes[0].favorite, true); assert.equal(f.read().nodes[0].id, id);
  f.profile.updateNodeServerAddress(dir, '192.0.2.10'); assert.equal(f.read().nodes[0].favorite, true);
  assert.equal(f.read().nodes[1].favorite, false);
});

test('v1 editor revision stays valid until a genuine mutation commits migration', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]); f.raw(asV1(f.read()));
  const old = f.read(); f.catalog.updateCatalogNode(dir, old.activeNodeId, f.node(2), old.revision);
  assert.equal(f.read().revision, old.revision + 1); assert.equal(f.read().nodes[0].favorite, false);
  unchanged(f, () => f.catalog.updateCatalogNode(dir, old.activeNodeId, f.node(3), old.revision));
});

test('subscription refresh preserves favorites only for matching retained configurations', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const manual = f.read().activeNodeId; f.catalog.setCatalogNodeFavorite(dir, manual, true);
  f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', [f.node(2), f.node(3)]);
  const source = f.read().subscriptions[0].id;
  const old = f.read().nodes.find(node => node.sourceId === source && node.outboundJson === f.node(2).outboundJson);
  f.catalog.setCatalogNodeFavorite(dir, old.id, true);
  f.catalog.replaceSubscriptionNodes(dir, source, [f.node(2), f.node(4), f.node(1)]);
  assert.equal(f.read().nodes.find(node => node.id === old.id).favorite, true);
  assert.equal(f.read().nodes.find(node => node.id === manual).favorite, true);
  assert.equal(f.read().nodes.find(node => node.outboundJson === f.node(4).outboundJson).favorite, false);
  f.catalog.saveSubscriptionWithNodes(dir, source, 'Source renamed', 'https://feed.invalid/token', [f.node(2), f.node(5)]);
  assert.equal(f.read().nodes.find(node => node.id === old.id).favorite, true);
  f.catalog.replaceSubscriptionNodes(dir, source, [f.node(3)]);
  assert(!f.read().nodes.some(node => node.id === old.id));
  assert.equal(f.read().nodes.find(node => node.sourceId === source).favorite, false);
});

for (const version of [1, 2]) {
  test(`v${version} backup preview is pure and restore preserves the correct favorites`, () => {
    const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]);
    f.catalog.setCatalogNodeFavorite(dir, f.read().nodes[1].id, true);
    const backup = JSON.parse(f.catalog.exportNodeCatalogBackup(dir));
    if (version === 1) { backup.schemaVersion = 1; backup.catalog = asV1(backup.catalog); }
    const text = JSON.stringify(backup), before = f.bytes(), renames = f.state.renames;
    const preview = f.catalog.previewNodeCatalogBackup(text);
    assert.equal(preview.schemaVersion, 2); assert.equal(preview.revision, backup.catalog.revision);
    assert.equal(preview.nodes[0].favorite, false); assert.equal(preview.nodes[1].favorite, version === 2);
    assert.equal(f.bytes(), before); assert.equal(f.state.renames, renames);
    f.catalog.deleteCatalogNode(dir, f.read().nodes[0].id); const revision = f.read().revision;
    f.catalog.restoreNodeCatalogBackup(dir, text, revision);
    assert.equal(f.read().revision, revision + 1); assert.equal(f.read().nodes.length, 2);
    assert.equal(f.read().nodes[1].favorite, version === 2);
    assert.equal(f.read().activeNodeId, backup.catalog.activeNodeId);
  });
}

test('mixed backup envelope and catalog versions are rejected without recovery', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  for (const [envelope, catalog] of [[1, 2], [2, 1]]) {
    const backup = JSON.parse(f.catalog.exportNodeCatalogBackup(dir)); backup.schemaVersion = envelope;
    if (catalog === 1) backup.catalog = asV1(backup.catalog);
    const text = JSON.stringify(backup);
    unchanged(f, () => f.catalog.previewNodeCatalogBackup(text));
    unchanged(f, () => f.catalog.restoreNodeCatalogBackup(dir, text, f.read().revision));
  }
});

for (const [name, mutate] of [
  ['v1 with false favorite', c => { c.schemaVersion = 1; }],
  ['v1 with true favorite', c => { c.schemaVersion = 1; c.nodes[0].favorite = true; }],
  ['v2 missing favorite', c => { delete c.nodes[0].favorite; }],
  ...[null, 0, 1, 'true', [], {}].map((value, index) => [`v2 favorite type ${index}`, c => { c.nodes[0].favorite = value; }])
]) {
  test(`catalog and backup fail closed for ${name}`, () => {
    const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
    const raw = JSON.parse(f.bytes()); mutate(raw); f.raw(raw);
    unchanged(f, () => f.read()); unchanged(f, () => f.catalog.setCatalogNodeFavorite(dir, raw.activeNodeId, true));
    const text = JSON.stringify({ format: 'harmony-vpn-node-backup', schemaVersion: raw.schemaVersion,
      exportedAt: 1, catalog: raw });
    unchanged(f, () => f.catalog.previewNodeCatalogBackup(text));
  });
}

for (const version of [1, 2]) {
  for (const [name, setup] of [['partial write', s => { s.maxWrite = 5; s.failWriteAfter = s.writeCalls + 3; }],
    ['sync', s => { s.failSync = true; }], ['rename', s => { s.failRename = true; }]]) {
    test(`v${version} favorite ${name} failure preserves the original catalog`, () => {
      const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
      if (version === 1) f.raw(asV1(f.read()));
      const id = f.read().activeNodeId; setup(f.state);
      unchanged(f, () => f.catalog.setCatalogNodeFavorite(dir, id, true));
      assert.equal(f.read().nodes[0].favorite, false); assert.equal(JSON.parse(f.bytes()).schemaVersion, version);
    });
  }
}
test('legacy migration is atomic and preserves original bytes', () => {
  const f = fixture(), node = f.node(1, '  legacy\u0000名  ');
  f.files.set(legacyPath, Buffer.from(JSON.stringify(node))); const original = f.files.get(legacyPath);
  f.state.maxWrite = 7; const catalog = f.read();
  assert.equal(catalog.nodes.length, 1); assert.equal(catalog.nodes[0].name, 'legacy名');
  assert.equal(catalog.activeNodeId, catalog.nodes[0].id); assert.equal(catalog.revision, 1);
  assert.equal(f.files.get(legacyPath), original); assert(f.state.partial > 0);
  assert.equal(f.read().revision, 1); f.assertClean();
});
test('existing malformed store cannot fall back to valid legacy', () => {
  const f = fixture(); f.files.set(legacyPath, Buffer.from(JSON.stringify(f.node(1)))); f.raw('{bad secret');
  unchanged(f, () => f.read()); assert.equal(f.state.renames, 0);
});
test('invalid legacy remains unchanged without creating catalog', () => {
  const f = fixture(); f.files.set(legacyPath, Buffer.from('{broken'));
  unchanged(f, () => f.read()); assert(!f.files.has(destination));
});
test('deleted final migrated node is never resurrected from legacy', () => {
  const f = fixture(); f.files.set(legacyPath, Buffer.from(JSON.stringify(f.node(1))));
  f.catalog.deleteCatalogNode(dir, f.read().activeNodeId);
  assert.equal(f.read().nodes.length, 0); assert.equal(f.read().activeNodeId, '');
  assert(f.files.has(legacyPath)); assert.equal(f.profile.readNodeProfile(dir), undefined);
});
test('manual dedupe canonicalizes JSON and preserves active choice', () => {
  const f = fixture(); const result = f.catalog.importManualNodes(dir, [f.node(1), f.node(1), f.node(2)]);
  assert.equal(result.added, 2); assert.equal(result.duplicates, 1);
  const selected = f.read().nodes[1].id; f.catalog.selectCatalogNode(dir, selected);
  const formatted = f.node(1); formatted.outboundJson = JSON.stringify(JSON.parse(formatted.outboundJson), null, 2);
  const before = f.read().revision;
  assert.equal(f.catalog.importManualNodes(dir, [formatted]).duplicates, 1);
  assert.equal(f.read().revision, before); assert.equal(f.read().activeNodeId, selected);
});
test('rename removes controls and limits names without splitting surrogate', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const id = f.read().activeNodeId;
  f.catalog.renameCatalogNode(dir, id, '\u0000' + 'a'.repeat(63) + '😀tail\n');
  assert.equal(f.read().nodes[0].name, 'a'.repeat(63));
  f.catalog.renameCatalogNode(dir, id, '\u0000\n'); assert.equal(f.read().nodes[0].name, 'vless');
});
test('deleting active selects next row then previous or empty', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2), f.node(3)]);
  const ids = f.read().nodes.map(node => node.id); f.catalog.selectCatalogNode(dir, ids[1]);
  f.catalog.deleteCatalogNode(dir, ids[1]); assert.equal(f.read().activeNodeId, ids[2]);
  f.catalog.deleteCatalogNode(dir, ids[2]); assert.equal(f.read().activeNodeId, ids[0]);
  f.catalog.deleteCatalogNode(dir, ids[0]); assert.equal(f.read().activeNodeId, '');
});
test('profile compatibility import selects existing or newly imported node', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]);
  f.profile.saveNodeProfile(dir, f.node(2)); assert.equal(f.profile.readNodeProfile(dir).outboundJson, f.node(2).outboundJson);
  assert.equal(f.read().nodes.length, 2); f.profile.saveNodeProfile(dir, f.node(3));
  assert.equal(f.read().nodes.length, 3); assert.equal(f.profile.readNodeProfile(dir).outboundJson, f.node(3).outboundJson);
});
test('server edit updates active identity without creating another entry', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]);
  const id = f.read().activeNodeId; f.profile.updateNodeServerAddress(dir, '192.0.2.10');
  assert.equal(f.read().nodes.length, 2); assert.equal(f.read().activeNodeId, id);
  assert.equal(f.profile.nodeServerAddress(f.profile.readNodeProfile(dir)), '192.0.2.10');
});
test('active edit rejects duplicate outbound without overwriting', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1), f.node(2)]);
  unchanged(f, () => f.catalog.updateActiveNode(dir, f.node(2)));
});
test('subscription replace preserves manual and other source nodes', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const a = f.catalog.saveSubscription(dir, '', 'Source A', 'https://feed-a.invalid/token');
  const b = f.catalog.saveSubscription(dir, '', 'Source B', 'https://feed-b.invalid/token');
  f.catalog.replaceSubscriptionNodes(dir, a, [f.node(2), f.node(3)]);
  f.catalog.replaceSubscriptionNodes(dir, b, [f.node(4)]);
  const before = f.read(), untouched = before.nodes.filter(node => node.sourceId !== a);
  const kept = before.nodes.find(node => node.sourceId === a && node.outboundJson === f.node(3).outboundJson);
  f.catalog.renameCatalogNode(dir, kept.id, 'My renamed source node'); f.catalog.selectCatalogNode(dir, kept.id);
  const result = f.catalog.replaceSubscriptionNodes(dir, a, [f.node(3, 'Provider new name'), f.node(5), f.node(1), f.node(5)]);
  assert.equal(result.added, 1); assert.equal(result.duplicates, 2);
  const after = f.read(); assert.equal(after.nodes.length, 4); assert.equal(after.activeNodeId, kept.id);
  assert.equal(after.nodes.find(node => node.id === kept.id).name, 'My renamed source node');
  assert.equal(JSON.stringify(after.nodes.filter(node => node.sourceId !== a)), JSON.stringify(untouched));
  assert(after.subscriptions.find(source => source.id === a).lastUpdatedAt > 0);
});
test('lost subscription active falls back to another source or manual node', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const manualId = f.read().activeNodeId;
  const id = f.catalog.saveSubscription(dir, '', 'Source', 'https://feed.invalid/token');
  f.catalog.replaceSubscriptionNodes(dir, id, [f.node(2)]);
  f.catalog.selectCatalogNode(dir, f.read().nodes.find(node => node.sourceId === id).id);
  f.catalog.replaceSubscriptionNodes(dir, id, [f.node(3)]);
  assert.equal(f.read().activeNodeId, manualId);
});
test('empty or invalid subscription batch leaves all prior data intact', () => {
  const f = fixture(); const id = f.catalog.saveSubscription(dir, '', 'Source', 'https://feed.invalid/token');
  f.catalog.replaceSubscriptionNodes(dir, id, [f.node(1)]);
  unchanged(f, () => f.catalog.replaceSubscriptionNodes(dir, id, []));
  const invalid = f.node(2); invalid.outboundJson = '{bad';
  unchanged(f, () => f.catalog.replaceSubscriptionNodes(dir, id, [invalid]));
  unchanged(f, () => f.catalog.replaceSubscriptionNodes(dir, id, [f.node(3), invalid]));
});
test('subscription response commits against latest store after other edits', () => {
  const f = fixture(); const id = f.catalog.saveSubscription(dir, '', 'Source', 'https://feed.invalid/token');
  const pendingResponse = [f.node(1)];
  f.catalog.importManualNodes(dir, [f.node(2)]); const manualId = f.read().activeNodeId;
  f.catalog.renameCatalogNode(dir, manualId, 'edited during request');
  f.catalog.replaceSubscriptionNodes(dir, id, pendingResponse);
  assert.equal(f.read().nodes.find(node => node.id === manualId).name, 'edited during request');
  assert.equal(f.read().activeNodeId, manualId);
  f.catalog.deleteSubscription(dir, id);
  unchanged(f, () => f.catalog.replaceSubscriptionNodes(dir, id, pendingResponse));
});
test('subscription metadata edit preserves nodes and resets update time on URL change', () => {
  const f = fixture(); const id = f.catalog.saveSubscription(dir, '', 'Source', 'https://feed.invalid/token');
  f.catalog.replaceSubscriptionNodes(dir, id, [f.node(1)]); const before = f.read().nodes;
  assert.equal(f.catalog.saveSubscription(dir, id, '  New\u0000 name  ', 'https://new.invalid/token'), id);
  assert.equal(JSON.stringify(f.read().nodes), JSON.stringify(before));
  assert.equal(f.read().subscriptions[0].name, 'New name'); assert.equal(f.read().subscriptions[0].lastUpdatedAt, 0);
});
test('delete subscription removes only its own nodes and updates active', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]); const manual = f.read().activeNodeId;
  const id = f.catalog.saveSubscription(dir, '', 'Source', 'https://feed.invalid/token');
  f.catalog.replaceSubscriptionNodes(dir, id, [f.node(2)]);
  f.catalog.selectCatalogNode(dir, f.read().nodes.find(node => node.sourceId === id).id);
  f.catalog.deleteSubscription(dir, id); assert.equal(f.read().nodes.length, 1);
  assert.equal(f.read().activeNodeId, manual); assert.equal(f.read().subscriptions.length, 0);
});
test('all explicit mutators reject active connection before any write', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const id = f.catalog.saveSubscription(dir, '', 'Source', 'https://feed.invalid/token');
  const active = f.read().activeNodeId; f.state.allowed = false;
  const calls = [() => f.catalog.importManualNodes(dir, [f.node(2)]),
    () => f.catalog.selectCatalogNode(dir, active), () => f.catalog.renameCatalogNode(dir, active, 'other'),
    () => f.catalog.setCatalogNodeFavorite(dir, active, true),
    () => f.catalog.setCatalogNodeFavorite(dir, active, false),
    () => f.catalog.deleteCatalogNode(dir, active), () => f.catalog.updateActiveNode(dir, f.node(2)),
    () => f.catalog.saveSubscription(dir, id, 'other', 'https://other.invalid/token'),
    () => f.catalog.saveSubscriptionWithNodes(dir, id, 'other', 'https://other.invalid/token', [f.node(2)]),
    () => f.catalog.replaceSubscriptionNodes(dir, id, [f.node(2)]), () => f.catalog.deleteSubscription(dir, id),
    () => f.profile.saveNodeProfile(dir, f.node(2)), () => f.profile.updateNodeServerAddress(dir, '192.0.2.1')];
  for (const run of calls) { const guards = f.state.guardCalls; unchanged(f, run); assert.equal(f.state.guardCalls, guards + 1); }
});
for (const [name, mutate] of [
  ['schema version', value => value.schemaVersion = 3], ['extra field', value => value.extra = 'secret'],
  ['revision', value => value.revision = -1], ['missing active', value => value.activeNodeId = 'missing'],
  ['empty active with nodes', value => value.activeNodeId = ''], ['duplicate ID', value => value.nodes.push(value.nodes[0])],
  ['dangling source', value => value.nodes[0].sourceId = 'missing'],
  ['protocol mismatch', value => value.nodes[0].protocol = 'vmess'],
  ['invalid outbound', value => value.nodes[0].outboundJson = '{}'],
  ['unbounded name', value => value.nodes[0].name = 'n'.repeat(65)],
  ['control in name', value => value.nodes[0].name = 'name\u0000'],
  ['timestamp', value => value.nodes[0].modifiedAt = -1], ['null node', value => value.nodes[0] = null],
  ['non-array nodes', value => value.nodes = {}]
]) {
  test(`strict read fails closed for ${name}`, () => {
    const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]); const value = JSON.parse(f.bytes()); mutate(value); f.raw(value);
    unchanged(f, () => f.read()); unchanged(f, () => f.catalog.importManualNodes(dir, [f.node(2)]));
  });
}
test('outbound size is bounded by UTF-8 bytes not only characters', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const node = f.node(2), outbound = JSON.parse(node.outboundJson); outbound.tag = '界'.repeat(23000);
  node.outboundJson = JSON.stringify(outbound); assert(node.outboundJson.length < 65536);
  unchanged(f, () => f.catalog.importManualNodes(dir, [node]));
});
test('500-node capacity rejects overflow transactionally', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, Array.from({ length: 500 }, (_, index) => f.node(index)));
  assert.equal(f.read().nodes.length, 500); unchanged(f, () => f.catalog.importManualNodes(dir, [f.node(501)]));
  assert.equal(f.catalog.importManualNodes(dir, [f.node(0)]).duplicates, 1);
});
test('20-subscription capacity rejects overflow transactionally', () => {
  const f = fixture(); for (let index = 0; index < 20; index++) f.catalog.saveSubscription(dir, '', 'Source', `https://f${index}.invalid/token`);
  unchanged(f, () => f.catalog.saveSubscription(dir, '', 'Extra', 'https://extra.invalid/token'));
});
test('4 MiB read cap rejects over-limit bytes before JSON parsing', () => {
  const f = fixture(); f.files.set(destination, Buffer.alloc(4 * 1024 * 1024 + 1, 32)); unchanged(f, () => f.read());
});
test('4 MiB write cap leaves previous valid store untouched', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const batch = Array.from({ length: 100 }, (_, index) => {
    const node = f.node(index + 100), raw = JSON.parse(node.outboundJson); raw.tag = 'x'.repeat(44000);
    node.outboundJson = JSON.stringify(raw); return node;
  });
  unchanged(f, () => f.catalog.importManualNodes(dir, batch));
});
for (const [name, setup] of [
  ['partial write then exception', state => { state.maxWrite = 7; state.failWriteAfter = state.writeCalls + 3; }],
  ['zero-byte write', state => state.zeroWrite = true], ['impossible write count', state => state.badWriteCount = true],
  ['fsync exception', state => state.failSync = true], ['rename exception', state => state.failRename = true],
  ['open exception', state => state.failOpen = true]
]) {
  test(`atomic save preserves old bytes after ${name}`, () => {
    const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]); setup(f.state);
    unchanged(f, () => f.catalog.importManualNodes(dir, [f.node(2)]));
  });
}
test('migration rename failure preserves legacy and retries cleanly', () => {
  const f = fixture(); f.files.set(legacyPath, Buffer.from(JSON.stringify(f.node(1))));
  const original = f.files.get(legacyPath); f.state.failRename = true; unchanged(f, () => f.read());
  assert.equal(f.files.get(legacyPath), original); assert(!f.files.has(destination));
  f.state.failRename = false; assert.equal(f.read().nodes.length, 1); f.assertClean();
});
test('changing subscription URL and metadata cannot inject control or arbitrary schemes', () => {
  const f = fixture(); const id = f.catalog.saveSubscription(dir, '', 'Source', 'https://feed.invalid/token');
  for (const url of ['file:///private/token', 'http://feed.invalid/token', 'https://feed.invalid/\nsecret',
    'https://user:secret@feed.invalid/token', 'https://feed.invalid/#secret', 'https://feed.invalid/%GG',
    'https://', 'https://feed.invalid/' + '界'.repeat(3000)]) {
    unchanged(f, () => f.catalog.saveSubscription(dir, id, 'Source', url));
  }
});
test('subscription metadata plus nodes creates a single complete revision', () => {
  const f = fixture();
  const result = f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', [f.node(1), f.node(2)]);
  const saved = f.read(); assert.equal(saved.revision, 1); assert.equal(f.state.renames, 1);
  assert.equal(saved.subscriptions.length, 1); assert.equal(saved.nodes.length, 2);
  assert(saved.nodes.every(node => node.sourceId === saved.subscriptions[0].id));
  assert.equal(result.added, 2); assert.equal(result.activeNodeId, saved.nodes[0].id);
  assert(saved.subscriptions[0].lastUpdatedAt > 0);
});
test('subscription transaction updates metadata and nodes while retaining identity and other edits', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', [f.node(2), f.node(3)]);
  const before = f.read(), sourceId = before.subscriptions[0].id;
  const preserved = before.nodes.find(node => node.outboundJson === f.node(3).outboundJson);
  f.catalog.renameCatalogNode(dir, preserved.id, 'custom name'); f.catalog.selectCatalogNode(dir, preserved.id);
  const revision = f.read().revision;
  const result = f.catalog.saveSubscriptionWithNodes(dir, sourceId, 'New source name', 'https://new.invalid/token', [f.node(3), f.node(4)]);
  const saved = f.read(); assert.equal(saved.revision, revision + 1);
  assert.equal(saved.subscriptions.length, 1); assert.equal(saved.subscriptions[0].id, sourceId);
  assert.equal(saved.subscriptions[0].url, 'https://new.invalid/token');
  assert.equal(saved.subscriptions[0].name, 'New source name'); assert.equal(saved.nodes.length, 3);
  assert.equal(saved.nodes.find(node => node.id === preserved.id).name, 'custom name');
  assert.equal(result.activeNodeId, preserved.id); assert.equal(result.added, 1);
});
test('subscription transaction rejects empty or invalid batch without creating metadata', () => {
  const f = fixture(); const invalid = f.node(2); invalid.outboundJson = '{bad';
  for (const nodes of [[], [invalid], [f.node(1), invalid]]) {
    unchanged(f, () => f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', nodes));
  }
  assert(!f.files.has(destination)); assert.equal(f.read().subscriptions.length, 0);
});
test('subscription transaction node capacity failure leaves no new source behind', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, Array.from({ length: 500 }, (_, index) => f.node(index)));
  unchanged(f, () => f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', [f.node(501)]));
  assert.equal(f.read().subscriptions.length, 0); assert.equal(f.read().nodes.length, 500);
});
test('subscription transaction source capacity failure leaves previous catalog unchanged', () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) f.catalog.saveSubscription(dir, '', 'Source', `https://f${index}.invalid/token`);
  unchanged(f, () => f.catalog.saveSubscriptionWithNodes(dir, '', 'Extra', 'https://extra.invalid/token', [f.node(1)]));
});
test('subscription transaction file capacity failure does not save an empty source', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  const batch = Array.from({ length: 100 }, (_, index) => {
    const node = f.node(index + 100), raw = JSON.parse(node.outboundJson); raw.tag = 'x'.repeat(44000);
    node.outboundJson = JSON.stringify(raw); return node;
  });
  unchanged(f, () => f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', batch));
  assert.equal(f.read().subscriptions.length, 0);
});
test('new subscription transaction rename failure retries without duplicate empty sources', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]); f.state.failRename = true;
  for (let retry = 0; retry < 2; retry++) {
    unchanged(f, () => f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', [f.node(2)]));
  }
  assert.equal(f.read().subscriptions.length, 0); f.state.failRename = false;
  f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', [f.node(2)]);
  assert.equal(f.read().subscriptions.length, 1); assert.equal(f.read().nodes.length, 2);
});
test('existing subscription transaction rename failure preserves metadata and nodes together', () => {
  const f = fixture(); f.catalog.saveSubscriptionWithNodes(dir, '', 'Source', 'https://feed.invalid/token', [f.node(1)]);
  const id = f.read().subscriptions[0].id; f.state.failRename = true;
  unchanged(f, () => f.catalog.saveSubscriptionWithNodes(dir, id, 'Changed', 'https://changed.invalid/token', [f.node(2)]));
});
test('subscription transaction rejects nonexistent source without recreating it', () => {
  const f = fixture(); f.catalog.importManualNodes(dir, [f.node(1)]);
  unchanged(f, () => f.catalog.saveSubscriptionWithNodes(dir, 'missing', 'Source', 'https://feed.invalid/token', [f.node(2)]));
});
const report = { generatedAt: new Date().toISOString(), platform: 'desktop SDK transpilation with synthetic adapters',
  fixtures: 'fictional only; no private files or network', testsPassed: results.length, tests: results,
  sources: Object.fromEntries([...sources].map(([name, content]) => [name, crypto.createHash('sha256').update(content).digest('hex')])) };
const output = path.join(root, 'build/node-catalog-verification.json'); fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ testsPassed: results.length, sourceFiles: filenames, report: 'build/node-catalog-verification.json' }));
