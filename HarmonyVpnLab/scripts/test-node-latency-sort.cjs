'use strict';
// Real pure ArkTS sorting model; synthetic records only, without SDK or device IO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const relative = 'entry/src/main/ets/model/NodeLatencySort.ets';
const source = fs.readFileSync(path.join(root, relative), 'utf8');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0);
const context = { exports: {}, require(name) { throw new Error('Unexpected dependency: ' + name); } };
vm.runInNewContext(compiled.outputText, context, { filename: relative });
const { NodeLatencySortMode: Mode, nodeLatencySortRank: rank, sortCatalogNodes: sort } = context.exports;
const cases = [];
const test = (name, run) => { run(); cases.push({ name, passed: true }); };
const record = (id = 'a', change = {}) => ({ nodeId: id, outboundFingerprint: 'a'.repeat(64), runId: 'synthetic-run',
  checkedAt: 1, status: 'passed', durationMs: 2400, reason: '', measurementVersion: 2,
  secondStatus: 'passed', secondDurationMs: 220, secondReason: '', secondConnection: 'reused', ...change });
const ids = items => Array.from(items, item => item.id);
test('first and reused metrics remain distinct', () => {
  assert.equal(rank(Mode.FirstHttps, record()), 2400); assert.equal(rank(Mode.Reused, record()), 220);
});
for (const duration of [0, 0.25, 60000]) {
  test('both accepted boundaries preserve exact milliseconds: ' + duration, () => {
    const value = record('a', { durationMs: duration, secondDurationMs: duration });
    assert.equal(rank(Mode.FirstHttps, value), duration); assert.equal(rank(Mode.Reused, value), duration);
  });
}
for (const duration of [-1, NaN, Infinity, 60000.1, '123', undefined]) {
  test('invalid first duration excluded: ' + String(duration), () => {
    const value = record('a', { durationMs: duration });
    assert.equal(rank(Mode.FirstHttps, value), Infinity); assert.equal(rank(Mode.Reused, value), Infinity);
  });
  test('invalid reused duration never falls back to first: ' + String(duration), () => {
    const value = record('a', { secondDurationMs: duration });
    assert.equal(rank(Mode.Reused, value), Infinity); assert.equal(rank(Mode.FirstHttps, value), 2400);
  });
}
for (const change of [{ measurementVersion: 1 }, { measurementVersion: undefined }, { secondStatus: 'not-tested' },
  { secondStatus: 'failed' }, { secondConnection: 'new' }, { secondConnection: 'unknown' }, { secondReason: 'timeout' }]) {
  test('unconfirmed or ineligible second result excluded: ' + JSON.stringify(change), () => {
    const value = record('a', change); assert.equal(rank(Mode.Reused, value), Infinity);
    assert.equal(rank(Mode.FirstHttps, value), 2400);
  });
}
for (const change of [{ status: 'failed' }, { status: 'cancelled' }, { reason: 'https' }]) {
  test('unsuccessful overall result excluded from both modes: ' + JSON.stringify(change), () => {
    for (const mode of [Mode.FirstHttps, Mode.Reused]) assert.equal(rank(mode, record('a', change)), Infinity);
  });
}
test('missing results remain unranked', () => {
  for (const mode of [Mode.FirstHttps, Mode.Reused]) assert.equal(rank(mode, undefined), Infinity);
});
test('original and unrecognized mode return an independent unchanged array', () => {
  const nodes = Object.freeze([{ id: 'a' }, { id: 'b' }]);
  for (const mode of [Mode.Original, 'unsupported']) {
    const result = sort(nodes, [record('b')], mode);
    assert.deepEqual(ids(result), ['a', 'b']); assert.notEqual(result, nodes);
  }
});
test('all ineligible groups keep their shared original order after confirmed ties', () => {
  const nodes = Object.freeze(['legacy', 'new', 'warm1', 'missing', 'unknown', 'failed', 'warm2', 'fast'].map(id => Object.freeze({ id })));
  const results = Object.freeze([record('legacy', { measurementVersion: 1 }), record('new', { secondConnection: 'new' }),
    record('warm1'), record('unknown', { secondConnection: 'unknown' }), record('failed', { secondStatus: 'failed' }),
    record('warm2'), record('fast', { secondDurationMs: 1 })].map(Object.freeze));
  assert.deepEqual(ids(sort(nodes, results, Mode.Reused)), ['fast', 'warm1', 'warm2', 'legacy', 'new', 'missing', 'unknown', 'failed']);
  assert.deepEqual(ids(nodes), ['legacy', 'new', 'warm1', 'missing', 'unknown', 'failed', 'warm2', 'fast']);
});
test('first metric sorting accepts normalized legacy values and preserves ties', () => {
  const nodes = ['legacy', 'a', 'b', 'missing'].map(id => ({ id }));
  assert.deepEqual(ids(sort(nodes, [record('legacy', { measurementVersion: 1, durationMs: 5 }),
    record('a', { durationMs: 3 }), record('b', { durationMs: 3 })], Mode.FirstHttps)), ['a', 'b', 'legacy', 'missing']);
});
test('duplicate record cannot replace first indexed identity and foreign record cannot add a node', () => {
  assert.deepEqual(ids(sort([{ id: 'a' }, { id: 'b' }], [record('a', { secondConnection: 'unknown' }),
    record('a', { secondDurationMs: 0 }), record('b'), record('outside', { secondDurationMs: 0 })], Mode.Reused)), ['b', 'a']);
});
test('empty input and no eligible results remain stable', () => {
  assert.deepEqual(ids(sort([], [], Mode.Reused)), []);
  assert.deepEqual(ids(sort([{ id: 'a' }, { id: 'b' }], [], Mode.Reused)), ['a', 'b']);
});
const report = { scope: 'Synthetic execution of actual ArkTS model; no device, network or private records',
  sourceHashes: { [relative]: crypto.createHash('sha256').update(source).digest('hex') }, total: cases.length,
  passed: cases.length, failed: 0, cases };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/node-latency-sort-verification.json'), JSON.stringify(report, null, 2));
console.log(`Node latency sort: ${report.passed}/${report.total} passed.`);
