'use strict';
// Executes the real summary, journal, recovery and failure modules against an
// in-memory filesystem. No private files, native code, devices or network.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names = ['DiagnosticSummary','DiagnosticJournal','ConnectionRecoveryStore','ConnectionFailure'];
const sources = new Map(names.map(name => [name, fs.readFileSync(path.join(root, 'entry/src/main/ets/model', name + '.ets'), 'utf8')]));
const compiled = new Map([...sources].map(([name, source]) => {
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, name + ' transpilation'); return [name, result.outputText];
}));
const directory = '/synthetic-summary', clock = 1789000099999, run = '1789000000000', other = '1789000000001';
const secret = 'SECRET_NODE_192.0.2.10:443_https://secret.example.invalid/sub?token=KEY';
const journal = 'diagnostic-journal.json', recovery = 'connection-recovery.json', probe = 'vpn-probe.json', status = 'connection-status.json';
const event = (change = {}) => ({ at: 1789000000100, runId: run, code: 'session-start', kind: 'wifi', value: 0, ...change });
const observation = (change = {}) => ({ at: 1789000000200, runId: run, kind: 'connection', servicePid: 987654321,
  serviceStatusAt: 1789000000100, reason: 'service-exited', ...change });
const probeValue = (change = {}) => ({ phase: 'active', detail: secret, runId: run, kind: 'connection', updatedAt: 1789000000300, ...change });
const statusValue = (change = {}) => ({ phase: 'active', runId: run, updatedAt: 1789000000300, networkKind: 'wifi',
  reconnectCount: 2, cleanupConfirmed: false, servicePid: 987654321, snapshot: { selectedNode: secret, ownerEpoch: secret }, ...change });
const clone = value => JSON.parse(JSON.stringify(value));
function scenario(initial = {}, options = {}) {
  const files = new Map(Object.entries(initial).map(([name,value]) => [directory + '/' + name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]));
  const calls = [], reads = new Map(), loaded = new Map(), encodedInputs = [];
  const fakeFs = {
    accessSync(name) { calls.push({ op: 'access', name }); if (options.fail === 'access' && (!options.file || name.endsWith(options.file))) throw Error(secret); return files.has(name); },
    statSync(name) { calls.push({ op: 'stat', name }); if (options.fail === 'stat' && (!options.file || name.endsWith(options.file))) throw Error(secret);
      return { size: options.fakeSize ?? files.get(name).length, isFile: () => !options.directory }; },
    readTextSync(name, opts) { calls.push({ op: 'read', name, limit: opts?.length }); assert(Number.isInteger(opts?.length));
      if (options.fail === 'read' && (!options.file || name.endsWith(options.file))) throw Error(secret);
      const number = (reads.get(name) || 0) + 1; reads.set(name, number);
      if (options.change && number === 2 && name.endsWith(options.change.file)) files.set(name, Buffer.from(JSON.stringify(options.change.value)));
      return files.get(name).subarray(0, opts.length).toString(); }
  };
  for (const method of ['writeSync','openSync','renameSync','unlinkSync','fsyncSync']) fakeFs[method] = () => { throw Error('MUTATION_NOT_ALLOWED'); };
  const util = { TextEncoder: class { encodeInto(text) {
    encodedInputs.push(text);
    if (options.emptyEncodingUndefined && text.length === 0) return undefined;
    return new TextEncoder().encode(text);
  } }, generateRandomUUID: () => { throw Error('RANDOM_NOT_ALLOWED'); } };
  class FakeDate extends Date { static now() { return options.now ?? clock; } }
  function load(name) {
    if (loaded.has(name)) return loaded.get(name);
    const result = {}; loaded.set(name, result);
    const require = id => {
      if (id === '@kit.CoreFileKit') return { fileIo: fakeFs };
      if (id === '@kit.ArkTS') return { util };
      if (id === './ConnectionLifecycle') return { readConnectionLifecycle: () => { throw Error('LIFECYCLE_PROBE_NOT_ALLOWED'); } };
      if (id.startsWith('./') && compiled.has(id.substring(2))) return load(id.substring(2));
      throw Error('UNEXPECTED_MODULE');
    };
    vm.runInNewContext(compiled.get(name), { exports: result, require, Date: FakeDate }); return result;
  }
  const api = load('DiagnosticSummary');
  return { api, files, calls, encodedInputs, inspectJournal: () => load('DiagnosticJournal').inspectDiagnosticEvents(directory),
    inspectRecovery: () => load('ConnectionRecoveryStore').inspectConnectionRecoveries(directory),
    collect: (args = []) => clone(api.collectDiagnosticSummary(directory, ...(args.length ? args : ['0.22.0',43,26,true]))) };
}
const tests = [], test = (name, body) => tests.push({ name, body });
function checkPrivate(snapshot) {
  const all = JSON.stringify(snapshot);
  for (const value of [secret, '192.0.2.10', 'https://', 'token=', '987654321', run, other, 'ownerEpoch', 'servicePid', 'selectedNode']) assert(!all.includes(value), 'private token escaped: ' + value);
  assert(Buffer.byteLength(snapshot.text) <= 65536);
}
test('missing sources are reported without claiming healthy state or creating files', () => {
  const s=scenario(), result=s.collect(); assert.equal(result.journalStatus,'missing'); assert.equal(result.recoveryStatus,'missing');
  assert.equal(result.lifecycleStatus,'missing'); assert.equal(result.partial,false); assert.match(result.text,/不表示连接正常/); assert.equal(s.files.size,0); checkPrivate(result);
});
test('valid empty records differ from missing and malformed content', () => {
  const result=scenario({[journal]:[],[recovery]:{schemaVersion:1,observations:[]}}).collect();
  assert.equal(result.journalStatus,'empty'); assert.equal(result.recoveryStatus,'empty'); assert.equal(result.partial,false); assert.match(result.text,/没有可展示的有效事件/);
});
for (const [name,initial] of [['journal',{[journal]:'{'}],['recovery',{[recovery]:'{'}],['probe',{[probe]:'{'}],['status',{[status]:'{'}]]) {
  test(name+' malformed input is preserved and marks a partial snapshot',()=>{const s=scenario(initial), before=[...s.files].map(([k,v])=>[k,v.toString()]);
    const result=s.collect(); assert.equal(result.partial,true); assert.match(result.text,/格式无效/); assert.deepEqual([...s.files].map(([k,v])=>[k,v.toString()]),before); checkPrivate(result);});
}
for (const method of ['access','stat','read']) {
  test(method+' read errors are classified without exposing exception text',()=>{const result=scenario({[journal]:[event()]},{fail:method,file:journal}).collect();
    assert.equal(result.journalStatus,'unreadable'); assert.equal(result.partial,true); assert.match(result.text,/读取失败/); checkPrivate(result);});
}
test('one failed source does not erase the independently readable recovery stream',()=>{
  const result=scenario({[journal]:'{',[recovery]:{schemaVersion:1,observations:[observation()]}}).collect();
  assert.equal(result.eventCount,0); assert.equal(result.recoveryCount,1); assert.match(result.text,/应用观察到服务退出/); checkPrivate(result);
});
test('strict event and observation envelopes reject injected arbitrary fields',()=>{
  const result=scenario({[journal]:[event({secret})],[recovery]:{schemaVersion:1,observations:[observation({secret})]}}).collect();
  assert.equal(result.journalStatus,'invalid'); assert.equal(result.recoveryStatus,'invalid'); checkPrivate(result);
});
test('untrusted state details snapshots PID and owner data never enter returned snapshot',()=>{
  const result=scenario({[probe]:probeValue({ownerEpoch:secret}),[status]:statusValue({error:secret})}).collect();
  assert.equal(result.lifecycleStatus,'available'); assert.equal(result.partial,false); assert.match(result.text,/应用记录阶段：active/); checkPrivate(result);
});
test('events and observations sharing a run use one anonymous session across sources',()=>{
  const result=scenario({[journal]:[event()],[recovery]:{schemaVersion:1,observations:[observation()]},[probe]:probeValue(),[status]:statusValue()}).collect();
  assert.equal(result.sessionCount,1); assert.equal(result.eventCount,1); assert.equal(result.recoveryCount,1); assert.match(result.text,/会话 1/); assert(!result.text.includes('会话 2')); checkPrivate(result);
});
test('older failure keeps a separate session from a later successful snapshot',()=>{
  const result=scenario({[journal]:[event({code:'operation-failed-https',kind:'',value:1}),event({runId:other,at:1789000000200})],
    [probe]:probeValue({runId:other}),[status]:statusValue({runId:other})}).collect();
  assert.equal(result.sessionCount,2); assert.match(result.text,/会话 1 \| 操作未完成；域名 HTTPS 检查：超时/); assert.match(result.text,/会话 2；应用记录阶段：active/); checkPrivate(result);
});
test('foreign service receipt is partial and cannot claim cleanup or attribute failure',()=>{
  const result=scenario({[probe]:probeValue(),[status]:statusValue({runId:other,phase:'destroyed',cleanupConfirmed:true,failure:{stage:'core-init',reason:'failed',at:clock}})}).collect();
  assert.equal(result.partial,true); assert.equal(result.lifecycleStatus,'invalid'); assert.match(result.text,/未合并清理及失败信息/);
  assert(!result.text.includes('记录了清理完成回执')); assert(!result.text.includes('代理核心准备')); checkPrivate(result);
});
for (const file of [probe,status]) {
  test(file+' identity change during sampling prevents mixed snapshots',()=>{
    const result=scenario({[probe]:probeValue(),[status]:statusValue()}, {change:{file,value:file===probe?probeValue({runId:other}):statusValue({runId:other})}}).collect();
    assert.equal(result.partial,true); assert.match(result.text,/采集期间状态发生变化/); assert(!result.text.includes('会话 1失败阶段')); checkPrivate(result);
  });
}
test('only matching terminal cleanup receipt is described as a recorded receipt',()=>{
  const result=scenario({[probe]:probeValue({phase:'stopped'}),[status]:statusValue({phase:'destroyed',cleanupConfirmed:true})}).collect();
  assert.match(result.text,/该会话记录了清理完成回执/); assert.match(result.text,/不代表实时联网/); checkPrivate(result);
});
test('active receipt with a true cleanup flag is not a terminal cleanup acknowledgement',()=>{
  const result=scenario({[probe]:probeValue(),[status]:statusValue({cleanupConfirmed:true})}).collect(); assert.match(result.text,/清理回执：未确认清理完成/);
});
test('conflicting same-run phases remain attributed persisted records and require a refresh',()=>{
  const result=scenario({[probe]:probeValue(),[status]:statusValue({phase:'destroyed',cleanupConfirmed:true})}).collect();
  assert.equal(result.partial,true);assert.match(result.text,/两个来源阶段尚未一致/);assert.match(result.text,/应用记录阶段：active/);
  assert.match(result.text,/服务记录阶段：destroyed/);assert.match(result.text,/不代表实时联网/);
});
test('process-exit observations explicitly cannot establish cleanup or exit reason',()=>{
  const result=scenario({[recovery]:{schemaVersion:1,observations:[observation()]}}).collect();
  assert.match(result.text,/检测时未收到清理完成回执；退出原因尚未确认/); assert(!result.text.includes('清理回执：该会话'));
});
test('fixed failure fields are shown separately for operation cleanup and pending step',()=>{
  const result=scenario({[probe]:probeValue(),[status]:statusValue({failure:{stage:'core-init',reason:'failed',at:clock},
    cleanupFailure:{stage:'cleanup',reason:'timeout',at:clock},currentIssue:{stage:'https',reason:'tls',at:clock}})}).collect();
  assert.match(result.text,/会话 1失败阶段：代理核心准备/); assert.match(result.text,/会话 1清理阶段问题：资源清理/);
  assert.match(result.text,/会话 1该回执的未完成步骤：域名 HTTPS 检查/); assert.match(result.text,/不能单凭该阶段判定根本原因/); checkPrivate(result);
});
test('direct DNS stage remains a bounded operation classification in summary',()=>{
  const result=scenario({[probe]:probeValue(),[status]:statusValue({currentIssue:{stage:'direct-dns',reason:'timeout',at:clock}})}).collect();
  assert.match(result.text,/直连 DNS 检查/); assert.match(result.text,/不能单凭该阶段判定根本原因/); checkPrivate(result);
});
for(const field of ['failure','cleanupFailure','currentIssue']) test(field+' arbitrary injected classification is omitted',()=>{
  const result=scenario({[probe]:probeValue(),[status]:statusValue({[field]:{stage:secret,reason:secret,at:clock}})}).collect(); assert.equal(result.partial,true); assert.match(result.text,/分类无效/); checkPrivate(result);
});
test('unknown phase or runId is rejected rather than printed',()=>{
  for(const changes of [{phase:secret},{runId:secret},{updatedAt:-1},{kind:secret}]){
    const result=scenario({[probe]:probeValue(changes)}).collect();assert.equal(result.lifecycleStatus,'invalid');assert.equal(result.partial,true);checkPrivate(result);
  }
});
test('invalid optional network and count fields are omitted without coercion',()=>{
  const result=scenario({[probe]:probeValue(),[status]:statusValue({networkKind:secret,reconnectCount:secret,cleanupConfirmed:secret})}).collect();
  assert.equal(result.partial,true); assert.match(result.text,/网络分类无效/); assert.match(result.text,/计数超出范围/); checkPrivate(result);
});
test('version API and build number reject arbitrary text including newline injection',()=>{
  for(const args of [[secret,43,26,true],['0.22.0',secret,26,true],['0.22.0',43,secret,true],['0.22.0\n'+secret,43,26,true]]){
    const result=scenario().collect(args); assert.equal(result.partial,true); checkPrivate(result);
  }
});
test('zero build and API metadata sentinels are unavailable rather than valid numbers',()=>{
  const result=scenario().collect(['0.22.0',0,0,true]);assert.equal(result.partial,true);assert.match(result.text,/版本号：不可用/);assert.match(result.text,/系统 API：不可用/);
});
test('preview mode still reads safe event streams but never reads or probes lifecycle',()=>{
  const s=scenario({[journal]:[event()],[probe]:secret,[status]:secret}), result=s.collect(['0.22.0',43,26,false]);
  assert.equal(result.lifecycleStatus,'preview'); assert.equal(result.eventCount,1); assert.equal(result.partial,false);
  assert(s.calls.every(call=>call.name.endsWith(journal)||call.name.endsWith(recovery))); assert.match(result.text,/界面预览无 VPN 核心/); checkPrivate(result);
});
test('all reads enforce per-source byte bounds and never enumerate private data',()=>{
  const s=scenario({[journal]:[event()],[recovery]:{schemaVersion:1,observations:[observation()]},[probe]:probeValue(),[status]:statusValue()});s.collect();
  assert(s.calls.every(call=>[journal,recovery,probe,status].some(name=>call.name===directory+'/'+name)));
  assert(s.calls.filter(call=>call.op==='read').every(call=>call.limit===(call.name.endsWith(journal)?65537:32769)));
});
test('oversized journal is rejected before any text read',()=>{
  const s=scenario({[journal]:' '.repeat(65537)}),result=s.collect();assert.equal(result.journalStatus,'invalid');assert(!s.calls.some(call=>call.op==='read'&&call.name.endsWith(journal)));
});
test('oversized state or recovery file is rejected before any text read',()=>{
  for(const file of [recovery,probe,status]){const s=scenario({[file]:' '.repeat(32769)}),result=s.collect();assert.equal(result.partial,true);assert(!s.calls.some(call=>call.op==='read'&&call.name.endsWith(file)));}
});
test('UTF8 expansion beyond a lying stat is rejected after bounded read',()=>{
  const result=scenario({[journal]:'中'.repeat(22000)},{fakeSize:1}).collect();assert.equal(result.journalStatus,'invalid');assert.equal(result.partial,true);
});
test('maximum event and observation input produces bounded anonymous output',()=>{
  const events=Array.from({length:200},(_,i)=>event({runId:String(1789000000000+i),at:clock+i,code:'operation-failed-proxy-dns',kind:'',value:1}));
  const observations=Array.from({length:50},(_,i)=>observation({runId:String(1789000000000+i),at:clock+300+i}));
  const result=scenario({[journal]:events,[recovery]:{schemaVersion:1,observations}}).collect();assert.equal(result.eventCount,200);assert.equal(result.recoveryCount,50);
  assert.equal(result.sessionCount,200);assert(Buffer.byteLength(result.text)<=65536);checkPrivate(result);
});
test('OHOS empty-string encoding returning undefined does not prevent summary generation',()=>{
  for(const initial of [{},{[journal]:[],[recovery]:{schemaVersion:1,observations:[]}},{[journal]:[event()],[probe]:probeValue(),[status]:statusValue()}]){
    const s=scenario(initial,{emptyEncodingUndefined:true}),result=s.collect();
    assert.match(result.text,/Harmony VPN 诊断摘要/);assert(s.encodedInputs.every(text=>text.length>0));
    assert.equal(result.partial,false);checkPrivate(result);
  }
});
test('UTF8 output accounting never re-encodes the accumulated summary and remains within byte bound',()=>{
  const events=Array.from({length:200},(_,i)=>event({runId:String(1789000000000+i),at:clock+i,code:'operation-failed-proxy-dns',kind:'',value:1}));
  const observations=Array.from({length:50},(_,i)=>observation({runId:String(1789000000000+i),at:clock+300+i}));
  const s=scenario({[journal]:events,[recovery]:{schemaVersion:1,observations}},{emptyEncodingUndefined:true}),result=s.collect();
  assert(s.encodedInputs.every(text=>text.length>0));
  // Input JSON is encoded once per file; every summary encoding contains just
  // one newly appended line, even when the retained history approaches its cap.
  const outputInputs=s.encodedInputs.filter(text=>!text.startsWith('[')&&!text.startsWith('{'));
  assert(outputInputs.length>250);assert(outputInputs.every(text=>text.endsWith('\n')&&!text.slice(0,-1).includes('\n')));
  assert(Buffer.byteLength(result.text,'utf8')<=s.api.DIAGNOSTIC_SUMMARY_MAX_BYTES);
  assert(Buffer.byteLength(result.text,'utf8')>result.text.length);checkPrivate(result);
});
test('out-of-range timestamps and counters are not echoed as identifiers',()=>{
  const result=scenario({[journal]:[event({at:Number.MAX_SAFE_INTEGER}),event({code:'network-change',value:Number.MAX_SAFE_INTEGER})]}).collect();
  assert.equal(result.partial,true);assert(!result.text.includes(String(Number.MAX_SAFE_INTEGER)));assert.match(result.text,/计数超出范围/);assert.match(result.text,/省略 1 条记录/);checkPrivate(result);
});
test('generated clock outside range is bounded without throwing',()=>{
  for(const now of [0,-1,Infinity,Number.MAX_SAFE_INTEGER]){const result=scenario({}, {now}).collect();assert.equal(result.partial,true);assert.equal(result.generatedAt,0);assert.match(result.text,/生成时间不可用/);assert(!result.text.includes('1970-'));}
});
test('event time range covers only valid retained events and is absent for empty history',()=>{
  const first=1789000000100,last=1789000000900;
  const result=scenario({[journal]:[event({at:last}),event({at:first})]}).collect();
  assert(result.text.includes('有效事件记录范围（UTC）：'+new Date(first).toISOString()+' 至 '+new Date(last).toISOString()));
  assert(!scenario({[journal]:[]}).collect().text.includes('有效事件记录范围'));
});
test('same frozen summary is independent of later source updates',()=>{
  const s=scenario({[journal]:[event()]}),first=s.collect(),original=first.text;s.files.set(directory+'/'+journal,Buffer.from('[]'));const second=s.collect();
  assert.equal(first.text,original);assert.equal(first.eventCount,1);assert.equal(second.eventCount,0);assert.notEqual(first.text,second.text);
});
test('inspection states distinguish missing empty invalid unreadable and available',()=>{
  for(const [initial,options,expected] of [[{}, {},'missing'],[{[journal]:[],[recovery]:{schemaVersion:1,observations:[]}}, {},'empty'],
    [{[journal]:'{',[recovery]:'{'},{},'invalid'],[{[journal]:[],[recovery]:[]},{fail:'read'},'unreadable'],
    [{[journal]:[event()],[recovery]:{schemaVersion:1,observations:[observation()]}},{},'available']]){
    const s=scenario(initial,options);assert.equal(s.inspectJournal().status,expected);assert.equal(s.inspectRecovery().status,expected);
  }
});
const results=tests.map(({name,body})=>{try{body();return{name,passed:true};}catch(error){return{name,passed:false,detail:error.message};}});
const report={checkedAt:new Date().toISOString(),passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,total:results.length,
  scope:'Real DiagnosticSummary, DiagnosticJournal, ConnectionRecoveryStore and ConnectionFailure methods transpiled using DevEco SDK; synthetic in-memory files only.',
  limitations:['Persisted files are individually atomic, not a cross-file transaction; repeated identity checks detect observed changes, not every possible concurrent write.',
    'This is no native process or live connectivity validation.'],
  sourceSHA256:Object.fromEntries([...sources].map(([name,source])=>['entry/src/main/ets/model/'+name+'.ets',crypto.createHash('sha256').update(source).digest('hex')])),results};
report.sourceSHA256['scripts/test-diagnostic-summary.cjs']=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
fs.mkdirSync(path.join(root,'build'),{recursive:true});fs.writeFileSync(path.join(root,'build/diagnostic-summary-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,failed:report.failed,total:report.total,failures:results.filter(x=>!x.passed)}));if(report.failed)process.exitCode=1;
