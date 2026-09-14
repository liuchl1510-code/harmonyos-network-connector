'use strict';
// Authored classification and ConnectionStatus reader with synthetic errors/files.
// This neither starts a VPN nor reads any private node or device data.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names = ['entry/src/main/ets/model/ConnectionFailure.ets', 'entry/src/main/ets/model/ConnectionControl.ets'];
const sources = new Map(names.map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
let bytes = '';
function load(name, require) {
  const output = ts.transpileModule(sources.get(name), { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(output.diagnostics.length, 0); const context = { exports: {}, require };
  vm.runInNewContext(output.outputText, context); return context.exports;
}
const failure = load(names[0], key => { throw Error('Unexpected import ' + key); });
const control = load(names[1], key => {
  if (key === './ConnectionFailure') return failure;
  if (key === '@kit.ArkTS') return { util: { generateRandomUUID: () => 'synthetic-ui' } };
  if (key === '@kit.CoreFileKit') return { fileIo: { readTextSync: () => bytes } };
  throw Error('Unexpected import ' + key);
});
const cases = [], test = (name, run) => { run(); cases.push({ name, passed: true }); };
const plain = value => JSON.parse(JSON.stringify(value));
const basic = () => ({ runId: '1780000000000', phase: 'destroying', updatedAt: 1780000001000, servicePid: 1234, cleanupConfirmed: false });
for (const stage of ['configuration','authorization','start-request','vpn-init','vpn-create','endpoint-dns','network','core-init','runtime-clock','forwarding','status','cleanup','proxy-dns','https','response']) {
  test('authored stage has bounded record and fixed user-facing text: ' + stage, () => {
    const value = failure.makeConnectionFailure(stage); assert(failure.validConnectionFailure(value));
    assert.deepEqual(Object.keys(value).sort(), ['at', 'reason', 'stage']); assert.equal(value.reason, 'failed');
    assert(failure.failureStageLabel(stage)); assert(failure.failureProblem(value)); assert(failure.failureSuggestion(value));
  });
}
for (const invalid of [null, undefined, [], {}, { stage: 'secret.example', reason: 'failed', at: 1 },
  { stage: 'https', reason: 'secret-token', at: 1 }, { stage: 'https', reason: 'failed', at: NaN },
  { stage: 'https', reason: 'failed', at: -1 }, { stage: 'https', reason: 'failed', at: 1.1 },
  { stage: 'https', reason: 'failed', at: 1, message: 'secret-token' }]) {
  test('invalid diagnostics are not valid records: ' + cases.length, () => {
    assert.equal(failure.validConnectionFailure(invalid), false);
    assert(!failure.failureProblem(invalid).includes('secret')); assert(!failure.failureSuggestion(invalid).includes('secret'));
  });
}
test('factory rejects arbitrary stage or reason', () => {
  assert.throws(() => failure.makeConnectionFailure('secret.example'));
  assert.throws(() => failure.makeConnectionFailure('https', 'password=value'));
  assert.equal(failure.failureStageLabel('secret.example'), '连接检查');
});
for (const [code, reason] of [[2300028,'timeout'], [2300007,'connection'], [2300060,'tls']]) {
  test('known SDK code only classifies the HTTPS client operation: ' + code, () => {
    const value = failure.connectionFailureFromError({ code, message: 'secret.example token' }, 'https');
    assert.equal(value.reason, reason); assert.equal(value.stage, 'https');
    assert.equal(failure.connectionFailureFromError({ code }, 'proxy-dns').reason, 'failed');
    assert(!JSON.stringify(value).includes('secret')); assert(!failure.failureProblem(value).includes('secret'));
  });
}
test('error message and arbitrary lookalike fields never determine stage or cause', () => {
  const value = failure.connectionFailureFromError({ message: 'timeout REALITY password=secret', stage: 'configuration', reason: 'tls', code: '2300028' }, 'core-init');
  assert.equal(value.stage, 'core-init'); assert.equal(value.reason, 'failed');
});
test('authored typed inner error preserves its precise stage across outer wrappers', () => {
  const error = new failure.ConnectionFailureError('runtime-clock');
  const classified = failure.connectionFailureFromError(error, 'core-init');
  assert.equal(classified.stage, 'runtime-clock'); assert.equal(classified.at, error.failure.at);
  assert.notEqual(classified, error.failure); assert(!String(error).includes('secret'));
});
test('old ConnectionStatus files remain readable without diagnostic fields', () => {
  bytes = JSON.stringify(basic()); const result = control.readConnectionStatus('/synthetic');
  assert.equal(result.phase, 'destroying'); assert.equal(result.servicePid, 1234); assert.equal(result.failure, undefined);
});
test('all valid independent service issue fields retain exact data', () => {
  const value = basic(); value.failure = { stage: 'core-init', reason: 'failed', at: 3 };
  value.cleanupFailure = { stage: 'cleanup', reason: 'failed', at: 4 }; value.currentIssue = { stage: 'endpoint-dns', reason: 'failed', at: 2 };
  bytes = JSON.stringify(value); assert.deepEqual(plain(control.readConnectionStatus('/synthetic')), value);
});
for (const field of ['failure', 'cleanupFailure', 'currentIssue']) for (const invalid of [null, 'secret.example',
  { stage: 'https', reason: 'failed', at: 1, secret: 'private-value' }, { stage: 'unknown-secret', reason: 'failed', at: 1 }]) {
  test('bad ' + field + ' cannot hide existing lifecycle/PID evidence: ' + cases.length, () => {
    const value = basic(); value[field] = invalid; bytes = JSON.stringify(value); const original = bytes;
    const result = control.readConnectionStatus('/synthetic'); assert(result);
    assert.equal(result.phase, 'destroying'); assert.equal(result.cleanupConfirmed, false); assert.equal(result.servicePid, 1234);
    assert.equal(result[field], undefined); assert.equal(bytes, original); assert(!JSON.stringify(result).includes('secret'));
  });
}
test('proxy and physical DNS suggestions preserve distinct control paths', () => {
  assert.match(failure.failureProblem(failure.makeConnectionFailure('proxy-dns')), /不等同于 DNS 配置错误/);
  assert.match(failure.failureSuggestion(failure.makeConnectionFailure('proxy-dns')), /先核对节点.*再检查 DoH/);
  assert.match(failure.failureSuggestion(failure.makeConnectionFailure('endpoint-dns')), /不由应用内 DoH 设置控制/);
});
test('stable reason indices encode and decode only whitelisted event values', () => {
  for (const [index, reason] of ['failed','timeout','connection','tls','invalid-response','unavailable'].entries()) {
    const value = failure.makeConnectionFailure('https', reason);
    assert.equal(failure.failureDiagnosticValue(value), index);
    assert.deepEqual(plain(failure.failureFromDiagnosticEvent(failure.failureDiagnosticCode(value), index, value.at)), plain(value));
  }
  for (const [code, index, at] of [['operation-failed-unknown',0,1], ['operation-failed-https',6,1],
    ['operation-failed-https',NaN,1], ['operation-failed-https',1,-1], ['latency-failed',0,1],
    ['operation-failed-https',0,Infinity]]) assert.equal(failure.failureFromDiagnosticEvent(code,index,at), undefined);
});
const report = { passed: cases.length, failed: 0, scope: 'authored error classification and backward-compatible status reader; synthetic errors and files only',
  sourceSHA256: Object.fromEntries([...sources].map(([name, source]) => [name, crypto.createHash('sha256').update(source).digest('hex')])), cases };
fs.mkdirSync(path.join(root, 'build'), { recursive: true }); fs.writeFileSync(path.join(root, 'build/connection-failure-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: 0 }));
