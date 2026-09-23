'use strict';
// Execute authored RoutingAssets with packaged public bytes and real SHA-256.
// Only the SDK filesystem is an in-memory descriptor model; no device, network,
// private node, actual sandbox directory or native library is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'entry/src/main/ets/vpn/RoutingAssets.ets');
const source = fs.readFileSync(filename, 'utf8');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0);
const assets = [
  ['geoip.dat', 139274, 'a47866f5ea506b7b7f816c7f62e352567e4188fd276c1800dac2ab653415a43e'],
  ['geosite.dat', 1994637, '269d13cde1a524973d43395c180452f1f0258be372105b28dde37c1fb8f161ae']
];
const bundled = new Map();
for (const [name, length, sha256] of assets) {
  const bytes = fs.readFileSync(path.join(root, 'entry/src/main/resources/rawfile', name));
  assert.equal(bytes.byteLength, length, name + ' package length');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256, name + ' package hash');
  bundled.set(name, bytes);
}
const sandbox = '/synthetic-routing-assets';
function harness(options = {}) {
  const s = { files: new Map(), handles: new Map(), calls: [], reads: 0, writes: 0, hashes: 0, sequence: 0,
    fd: 0, resourceReads: [], nativeStarts: 0, networkRequests: 0 };
  const openMode = { READ_ONLY: 1, CREATE: 2, WRITE_ONLY: 4, TRUNC: 8 };
  function scoped(file) { assert(file.startsWith(sandbox + '/')); return file; }
  function descriptor(fd) { const result = s.handles.get(fd); assert(result, 'Unknown/opened fd'); return result; }
  function phase(file) { return file.endsWith('.tmp') ? 'temporary' : 'destination'; }
  function fail(stage, file) {
    if (options.failAt === stage && (!options.failPhase || options.failPhase === phase(file))) {
      throw new Error('synthetic filesystem failure');
    }
  }
  function createFile(file, bytes) { s.files.set(scoped(file), Buffer.from(bytes)); }
  function prefill(mode = 'valid') {
    for (const [name, bytes] of bundled) {
      const cached = Buffer.from(bytes);
      if (mode === 'corrupt') cached[Math.floor(cached.length / 2)] ^= 1;
      createFile(sandbox + '/' + name, mode === 'truncated' ? cached.subarray(0, cached.length - 1) : cached);
    }
  }
  const fileIo = {
    OpenMode: openMode,
    accessSync(file) { scoped(file); fail('access', file); return s.files.has(file); },
    openSync(file, mode) {
      scoped(file); fail('open', file);
      if ((mode & openMode.CREATE) !== 0 && !s.files.has(file)) createFile(file, []);
      assert(s.files.has(file), 'Opening missing file');
      if ((mode & openMode.TRUNC) !== 0) createFile(file, []);
      const fd = ++s.fd; s.handles.set(fd, { file, mode, cursor: 0, stats: 0 });
      s.calls.push(['open', file, mode]); return { fd };
    },
    closeSync(file) { const fd = typeof file === 'number' ? file : file.fd; descriptor(fd); s.handles.delete(fd); },
    statSync(fd) {
      const handle = descriptor(fd); fail('stat', handle.file); handle.stats++;
      const size = s.files.get(handle.file).length;
      if (options.finalStatGrowth && phase(handle.file) === 'temporary' && handle.stats > 1) return { size: size + 1 };
      return { size };
    },
    readSync(fd, buffer) {
      const handle = descriptor(fd); assert.equal(handle.mode, openMode.READ_ONLY); fail('read', handle.file); s.reads++;
      const data = s.files.get(handle.file);
      if (phase(handle.file) === 'temporary' && options.readReturn !== undefined) return options.readReturn;
      if (handle.cursor === data.length && phase(handle.file) === 'temporary' && options.extraAtEof) return 1;
      const count = Math.min(data.length - handle.cursor, buffer.byteLength, options.readChunk || Infinity);
      const output = new Uint8Array(buffer); output.set(data.subarray(handle.cursor, handle.cursor + count));
      if (options.corruptReadback && phase(handle.file) === 'temporary' && handle.cursor === 0 && count > 0) output[0] ^= 1;
      handle.cursor += count; return count;
    },
    writeSync(fd, buffer, writeOptions) {
      const handle = descriptor(fd); assert(handle.mode & openMode.WRITE_ONLY); fail('write', handle.file); s.writes++;
      if (options.writeReturn !== undefined) return options.writeReturn;
      const count = Math.min(buffer.byteLength, options.writeChunk || Infinity), offset = writeOptions.offset;
      assert(Number.isSafeInteger(offset) && offset >= 0); const before = s.files.get(handle.file);
      const next = Buffer.alloc(Math.max(before.length, offset + count)); before.copy(next);
      next.set(new Uint8Array(buffer, 0, count), offset); s.files.set(handle.file, next); return count;
    },
    fsyncSync(fd) { const handle = descriptor(fd); fail('fsync', handle.file); s.calls.push(['fsync', handle.file]); },
    renameSync(from, to) {
      scoped(from); scoped(to); fail('rename', from); assert(s.files.has(from));
      assert(![...s.handles.values()].some(handle => handle.file === from), 'Rename must follow closed verified temp file');
      const bytes = Buffer.from(s.files.get(from)); if (options.corruptCommit) bytes[0] ^= 1;
      s.files.set(to, bytes); s.files.delete(from); s.calls.push(['rename', from, to]);
    },
    unlinkSync(file) { scoped(file); assert(file.endsWith('.tmp')); assert(s.files.has(file)); s.files.delete(file); }
  };
  const dependencies = {
    '@kit.AbilityKit': {}, '@kit.CoreFileKit': { fileIo },
    '@kit.ArkTS': { util: { generateRandomUUID: () => 'synthetic-' + (++s.sequence) } },
    '@kit.CryptoArchitectureKit': { cryptoFramework: { createMd(algorithm) {
      assert.equal(algorithm, 'SHA256'); const hash = crypto.createHash('sha256'); s.hashes++;
      return { async update({ data }) { if (options.digestFailure) throw new Error('synthetic digest failure'); hash.update(data); },
        async digest() { const bytes = hash.digest(); return { data: options.shortDigest ? bytes.subarray(0, 31) : bytes }; } };
    } } }
  };
  const exported = {};
  vm.runInNewContext(compiled.outputText, { exports: exported, module: { exports: exported },
    require(name) { assert(Object.hasOwn(dependencies, name), 'Unexpected SDK/network dependency ' + name); return dependencies[name]; }
  }, { filename });
  s.prepare = () => exported.prepareRoutingAssets({ filesDir: sandbox, resourceManager: {
    async getRawFileContent(name) {
      assert(bundled.has(name)); s.resourceReads.push(name);
      if (options.missingResource === name) throw new Error('synthetic missing rawfile');
      const bytes = Uint8Array.from(bundled.get(name));
      if (options.corruptResource === name) bytes[0] ^= 1;
      return options.shortResource === name ? bytes.slice(0, -1) : bytes;
    }
  } });
  s.prefill = prefill;
  s.assertClosed = () => {
    assert.equal(s.handles.size, 0); assert(![...s.files.keys()].some(file => file.endsWith('.tmp')));
  };
  s.assertValid = () => {
    s.assertClosed(); for (const [name, bytes] of bundled) assert.deepEqual(s.files.get(sandbox + '/' + name), bytes);
  };
  return s;
}
const tests = [], test = (name, run) => tests.push({ name, run });
test('fresh verified assets install through synced closed temporaries and exact readback', async () => {
  const s = harness(); await s.prepare(); s.assertValid(); assert.equal(s.hashes, 2);
  assert.deepEqual(s.resourceReads, assets.map(([name]) => name));
  assert.equal(s.calls.filter(([op]) => op === 'rename').length, 2);
  for (const [op, from] of s.calls.filter(([op]) => op === 'rename')) {
    assert(s.calls.findIndex(call => call[0] === 'fsync' && call[1] === from) < s.calls.findIndex(call => call[0] === op && call[1] === from));
  }
});
test('exact existing cache is reused without creating writing syncing or renaming', async () => {
  const s = harness(); s.prefill(); await s.prepare(); s.assertValid();
  assert.equal(s.writes, 0); assert.equal(s.sequence, 0); assert.equal(s.hashes, 2);
  assert(s.calls.every(([op, , mode]) => op === 'open' && mode === 1));
});
test('a second preparation revalidates bundle and cache without rewriting either', async () => {
  const s = harness(); await s.prepare(); const writes = s.writes, files = s.sequence;
  await s.prepare(); s.assertValid(); assert.equal(s.writes, writes); assert.equal(s.sequence, files); assert.equal(s.hashes, 4);
});
test('partial reads and writes advance offsets until every actual asset byte is verified', async () => {
  const s = harness({ writeChunk: 4093, readChunk: 2039 }); await s.prepare(); s.assertValid();
  assert(s.writes > 500); assert(s.reads > 2000);
});
for (const damage of ['corrupt', 'truncated']) test(damage + ' cached files are replaced with verified packaged bytes', async () => {
  const s = harness(); s.prefill(damage); await s.prepare(); s.assertValid(); assert.equal(s.sequence, 2);
});
for (const name of assets.map(([name]) => name)) {
  for (const issue of ['corruptResource', 'shortResource', 'missingResource']) test(name + ' ' + issue + ' aborts without changing a valid existing cache', async () => {
    const s = harness({ [issue]: name }); s.prefill();
    await assert.rejects(s.prepare()); s.assertValid(); assert.equal(s.writes, 0); assert.equal(s.sequence, 0);
  });
}
for (const setting of ['shortDigest', 'digestFailure']) test(setting + ' aborts before cached or temporary files are opened', async () => {
  const s = harness({ [setting]: true }); await assert.rejects(s.prepare()); s.assertClosed(); assert.equal(s.calls.length, 0);
});
for (const count of [0, -1, NaN, 0.5, 65537]) test('invalid write count ' + count + ' cannot replace old cache', async () => {
  const s = harness({ writeReturn: count }); s.prefill('corrupt'); const old = Buffer.from(s.files.get(sandbox + '/geoip.dat'));
  await assert.rejects(s.prepare()); s.assertClosed(); assert.deepEqual(s.files.get(sandbox + '/geoip.dat'), old);
  assert(!s.calls.some(([op]) => op === 'rename'));
});
for (const count of [0, -1, NaN, 0.5, 65537]) test('invalid temporary read count ' + count + ' refuses commit', async () => {
  const s = harness({ readReturn: count }); await assert.rejects(s.prepare()); s.assertClosed();
  assert(!s.calls.some(([op]) => op === 'rename')); assert.equal(s.files.size, 0);
});
for (const setting of ['corruptReadback', 'extraAtEof', 'finalStatGrowth']) test(setting + ' detects a temporary file that cannot be committed', async () => {
  const s = harness({ [setting]: true }); await assert.rejects(s.prepare()); s.assertClosed();
  assert(!s.calls.some(([op]) => op === 'rename')); assert.equal(s.files.size, 0);
});
for (const failAt of ['open', 'write', 'fsync', 'read', 'stat', 'rename']) test(failAt + ' failure closes descriptors removes temporary bytes and preserves old cache', async () => {
  const s = harness({ failAt, failPhase: 'temporary' }); s.prefill('corrupt');
  const old = Buffer.from(s.files.get(sandbox + '/geoip.dat')); await assert.rejects(s.prepare()); s.assertClosed();
  assert.deepEqual(s.files.get(sandbox + '/geoip.dat'), old); assert(!s.calls.some(([op]) => op === 'rename'));
});
test('corruption after atomic rename rejects preparation and is repaired by the next verified attempt', async () => {
  const s = harness({ corruptCommit: true }); await assert.rejects(s.prepare()); s.assertClosed();
  assert.equal(s.calls.filter(([op]) => op === 'rename').length, 1);
  assert.notDeepEqual(s.files.get(sandbox + '/geoip.dat'), bundled.get('geoip.dat'));
  const retry = harness(); for (const [file, bytes] of s.files) retry.files.set(file, Buffer.from(bytes));
  await retry.prepare(); retry.assertValid();
});
(async () => {
  const passed = [], failed = [];
  for (const item of tests) {
    try { await item.run(); passed.push(item.name); }
    catch (error) { failed.push({ name: item.name, message: error.message }); }
  }
  const record = { generatedAt: new Date().toISOString(), passed: passed.length, failed: failed.length,
    tests: passed, failures: failed, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    testSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    assets: assets.map(([name, bytes, sha256]) => ({ name, bytes, sha256 })),
    scope: 'Actual RoutingAssets; real packaged bytes and SHA-256; synthetic resource manager and in-memory SDK filesystem. Core lifecycle failure/cancellation tested separately.',
    realNetwork: false, realDevice: false, privateFilesRead: false, nativeLibrariesLoaded: false };
  const output = path.join(root, 'build/routing-assets-verification.json'); fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed, record: output }));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
