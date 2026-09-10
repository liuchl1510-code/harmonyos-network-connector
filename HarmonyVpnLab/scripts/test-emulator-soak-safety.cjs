'use strict';
// Authored soak script with virtual time, memory-only output and simulated HDC/UI commands.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'soak-emulator-ui.cjs'),'utf8'),target='127.0.0.1:15558',hash='a'.repeat(64),start=Date.parse('2026-09-09T17:00:00Z');
const helperSource=fs.readFileSync(path.join(__dirname,'test-adaptive-emulator.cjs'),'utf8');
const memHeader='PssTotal SharedClean SharedDirty PrivateClean PrivateDirty SwapTotal SwapPssTotal HeapSize HeapAlloc HeapFree';
const memRows=['ark ts heap 100 1 2 3 94 0 0 150 120 30','native heap 200 10 20 30 140 0 0 250 210 40',
 '.so 50 40 2 4 6 0 0 - - -','.ttf 20 10 0 10 0 0 0 - - -','Total 400 61 22 47 240 0 0 400 330 70'];
const memRaw='synthetic-private-memory-label\n'+memHeader+'\n'+memRows.join('\n')+'\nignored synthetic-private-memory-label';
function fixture(options={}){
 const state={elapsed:0,files:new Map(),dirs:new Set(),logs:[],commands:[],ui:[],signals:{},checkpoints:[],fsOperations:[],exitCode:undefined};
 const info={versionName:'0.14.0-ui-preview',versionCode:35,applicationInfo:{cpuAbi:'x86_64'}},installation={target,versionName:info.versionName,versionCode:35,sha256:hash};
 const phase=options.phase||'phase14',norm=p=>path.resolve(p),out=norm(path.join(__dirname,'../build',phase+'-soak/synthetic-safety'));
 const descriptors=new Map();let nextFd=10;
 const disk=p=>{const relative=path.relative(out,norm(p));assert(!relative.startsWith('..')&&!path.isAbsolute(relative));return path.join(options.realOutput,relative);};
 const fault=(operation,p)=>{state.fsOperations.push({operation,path:p});const code=options.fsFailure?.(operation,p,state);if(code)throw Object.assign(Error('synthetic-private-filesystem-error'),{code});};
 const memory={existsSync(p){p=norm(p);if(p.endsWith('stop.request')&&options.stopAt!==undefined&&state.elapsed>=options.stopAt)return true;return state.files.has(p)||state.dirs.has(p)||(options.existingOutput&&p===out);},
  mkdirSync(p){state.dirs.add(norm(p));},readFileSync(p){if(norm(p)===norm(path.join(__dirname,'soak-emulator-ui.cjs')))return source;if(norm(p)===norm(path.join(__dirname,'test-adaptive-emulator.cjs')))return helperSource;assert.equal(norm(p),norm(path.join(__dirname,'../build',phase+'-emulators/install-15558.json')));return JSON.stringify({...installation,...options.installation});},
  openSync(p,flags,mode){p=norm(p);fault('open',p);if(flags==='wx'&&state.files.has(p))throw Object.assign(Error('exists'),{code:'EEXIST'});const fd=nextFd++,realFd=options.realOutput?fs.openSync(disk(p),flags,mode):undefined;descriptors.set(fd,{p,flags,realFd});if(flags!=='a'||!state.files.has(p))state.files.set(p,'');return fd;},
  writeFileSync(fd,s){const d=descriptors.get(fd);assert(d);fault('write',d.p);if(options.realOutput)fs.writeFileSync(d.realFd,s);state.files.set(d.p,d.flags==='a'?state.files.get(d.p)+s:s);},
  fsyncSync(fd){const d=descriptors.get(fd);assert(d);fault('fsync',d.p);if(options.realOutput)fs.fsyncSync(d.realFd);},
  closeSync(fd){const d=descriptors.get(fd);assert(d);if(options.realOutput)fs.closeSync(d.realFd);descriptors.delete(fd);},
  renameSync(from,to){from=norm(from);to=norm(to);fault('rename',to);assert(state.files.has(from));if(options.realOutput)fs.renameSync(disk(from),disk(to));state.files.set(to,state.files.get(from));state.files.delete(from);if(to.endsWith('checkpoint.json'))state.checkpoints.push(JSON.parse(state.files.get(to)));},
  unlinkSync(p){p=norm(p);if(options.realOutput)fs.unlinkSync(disk(p));state.files.delete(p);}};
 class Clock extends Date{constructor(v){super(v===undefined?start+state.elapsed:v);}static now(){return start+state.elapsed;}}
 const commands={execFileSync(exe,args,opts){state.commands.push({exe,args,timeout:opts.timeout});assert(opts.windowsHide);assert(opts.timeout>0&&opts.timeout<=90000);state.elapsed+=options.commandDurationMs??50;
  if(exe==='synthetic-node'){
   assert.equal(args[1],target);assert.equal(args[4],phase);assert.equal(opts.env.HARMONY_UI_QA_CAPTURE_IMAGE,'0');state.ui.push(args[2]);
   if(options.uiFailure&&(!options.uiFailureMode||options.uiFailureMode===args[2]))throw Object.assign(Error('synthetic-private-ui-payload'),options.uiError||{});
   if(options.uiRaw!==undefined)return options.uiRaw;
   const artifact=options.changeArtifact&&state.ui.length>1?'b'.repeat(64):hash;
   return JSON.stringify({target,mode:args[2],artifactSHA256:artifact,appBounds:[0,0,1200,900],horizontalOverflow:options.overflow?['control']:[],...(options.legacyTiming?{}:{uiTiming:options.uiTiming===undefined?{layoutDumps:2,slowLayoutDumps:0,maxLayoutDumpMs:50,layoutTimeoutMs:30000}:options.uiTiming})});
  }
  assert.equal(args[0],'-t');assert.equal(args[1],target);const a=args.slice(2);assert.equal(a[0],'shell');
  if(options.hdcFailure===a[1]||(options.statFailure&&a[1]==='cat'&&a[2].endsWith('/stat')))throw Object.assign(Error('synthetic-private-hdc-output'),options.hdcError||{});
  if(a[1]==='param')return options.guestMismatch?'physical-device':'emulator';
  if(a[1]==='bm')return JSON.stringify({...info,...options.info});
  if(a[1]==='pidof')return options.missingPid?'':'222';
  if(a[1]==='hidumper'){
   assert.equal(JSON.stringify(a),JSON.stringify(['shell','hidumper','--mem','222']));assert(opts.timeout<=2000);
   if(options.memFailure)throw Error('synthetic-private-memory-error');return options.memOutput??memRaw;
  }
  if(a[1]==='cat'){
   if(a[2].endsWith('/status')){if(options.statusFailure)throw Error('synthetic-private-status');return JSON.stringify({rssKiB:100000+Math.floor(state.elapsed/100),threads:20});}
   return JSON.stringify({startTimeTicks:options.restartAt!==undefined&&state.elapsed>=options.restartAt?200:100,totalTicks:Math.floor(state.elapsed/100)});
  }
  throw Error('unexpected command');}};
 const minutes=options.minutes||3,deadline=start+(options.deadlineDelta||4*3600000);
 const argv=['synthetic-node','soak-emulator-ui.cjs','--target',options.target||target,'--minutes',String(minutes),'--label','synthetic-safety','--deadline',new Date(deadline).toISOString()];
 if(options.activity)argv.push('--activity',options.activity);
 if(options.memoryEvery!==undefined)argv.push('--memory-breakdown-every',String(options.memoryEvery));
 if(options.phase!==undefined)argv.push('--phase',options.phase);
 const mod={exports:{}},processMock={argv,env:{},execPath:'synthetic-node',pid:12345,version:process.version,platform:process.platform,on:(name,callback)=>{state.signals[name]=callback;}};
 const context={module:mod,process:processMock,__dirname,__filename:path.join(__dirname,'soak-emulator-ui.cjs'),Buffer,Date:Clock,console:{log:s=>state.logs.push(s),error:s=>state.logs.push(s)},
  setTimeout(callback,ms){assert(ms<=1000);if(options.blockAfterSamples&&state.checkpoints.at(-1)?.samples>=options.blockAfterSamples){process.stdout.write('INTERRUPTION_READY\n');setInterval(()=>{},1000);return;}state.elapsed+=ms;if(options.signalAt!==undefined&&state.elapsed>=options.signalAt)state.signals[options.signal||'SIGTERM']?.();Promise.resolve().then(callback);},
  require(name){if(name==='node:fs')return memory;if(name==='node:child_process')return commands;if(name==='node:perf_hooks')return{performance:{now:()=>state.elapsed}};
   if(name==='./measure-device-stability.cjs')return{parseStat:s=>JSON.parse(s),parseStatus:s=>JSON.parse(s)};return require(name);}};
 context.require.main={};vm.runInNewContext(source,context);return{state,processMock,api:mod.exports,manifest:()=>JSON.parse(state.files.get(path.join(out,'run-manifest.json'))),checkpoint:()=>JSON.parse(state.files.get(path.join(out,'checkpoint.json'))),summary:()=>JSON.parse(state.files.get(path.join(out,'summary.json'))),samples:()=>String(state.files.get(path.join(out,'samples.jsonl'))||'').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
const passed=[];async function test(name,fn){await fn();passed.push(name);}
(async()=>{
 if(process.argv[2]==='--interruption-child'){await fixture({activity:'idle',realOutput:process.argv[3],blockAfterSamples:2}).api.main();return;}
 await test('invalid target is refused before any command',()=>assert.throws(()=>fixture({target:'USB_PHONE'})));
 await test('unknown activity is refused',()=>assert.throws(()=>fixture({activity:'connect'})));
 await test('unknown phase is refused before any output or device command',()=>assert.throws(()=>fixture({phase:'phase16'})));
 await test('phase15 uses its own output and installation record and is forwarded to every UI helper',async()=>{
  const f=fixture({phase:'phase15',activity:'inspection'});await f.api.main();assert.equal(f.summary().outcome,'completed');assert.equal(f.summary().phase,'phase15');assert.equal(f.manifest().request.phase,'phase15');assert(f.state.ui.includes('Inspect'));assert([...f.state.files.keys()].every(p=>p.includes('phase15-soak')));
 });
 await test('existing output directory cannot be overwritten',()=>assert.throws(()=>fixture({existingOutput:true})));
 await test('manifest and initial checkpoint identify the run before any device command',()=>{
  const f=fixture({activity:'inspection',memoryEvery:4}),m=f.manifest(),c=f.checkpoint();assert.equal(f.state.commands.length,0);
  assert.equal(m.schemaVersion,1);assert.equal(m.recordType,'soak-run-manifest');assert.match(m.runId,/^[0-9a-f-]{36}$/);assert.notEqual(m.runId,fixture().manifest().runId);
  assert.equal(m.script.sha256,crypto.createHash('sha256').update(source).digest('hex'));assert.equal(m.startedAt,new Date(start).toISOString());assert.equal(m.host.pid,12345);assert(m.host.hostname);
  assert.equal(m.request.target,target);assert.equal(m.request.minutes,3);assert.equal(m.request.activity,'inspection');assert.equal(m.request.memoryBreakdownEvery,4);assert(m.request.argv.includes('--deadline'));
  assert.equal(c.runId,m.runId);assert.equal(c.scriptSHA256,m.script.sha256);assert.equal(c.recordType,'soak-run-checkpoint');assert.equal(c.completionClaim,false);assert.equal(c.state,'last-observed');assert.equal(c.samples,0);assert.equal(c.lastObserved,null);assert.equal(c.outcome,undefined);
  assert(![...f.state.files.keys()].some(p=>p.endsWith('summary.json')));
 });
 await test('each durable checkpoint is only last-observed evidence tied to the same run and byte prefix',async()=>{
  const f=fixture({activity:'idle'});await f.api.main();const m=f.manifest(),s=f.samples(),c=f.checkpoint(),report=f.summary();
  assert.equal(f.state.checkpoints.length,s.length+1);assert.equal(c.samples,s.length);assert.deepEqual(c.lastObserved,s.at(-1));
  const content=s.map(row=>JSON.stringify(row)+'\n').join('');assert.equal(c.sampleBytes,Buffer.byteLength(content));
  for(const [i,row] of s.entries()){assert.equal(row.runId,m.runId);assert.equal(row.sampleIndex,i);assert(Number.isFinite(Date.parse(row.hostObservedAt)));}
  for(const row of f.state.checkpoints){assert.equal(row.completionClaim,false);assert.equal(row.state,'last-observed');assert.equal(row.outcome,undefined);assert.equal(row.finishedAt,undefined);}
  assert.equal(report.recordType,'soak-run-summary');assert.equal(report.finalization,'orderly');assert.equal(report.runId,m.runId);assert.equal(report.scriptSHA256,m.script.sha256);assert.equal(report.sampleBytes,c.sampleBytes);
 });
 await test('manifest records the exact helper source hash and separate bounded collector timeouts',()=>{
  const f=fixture(),collector=f.manifest().collector;assert.equal(collector.helperSHA256,crypto.createHash('sha256').update(helperSource).digest('hex'));assert.equal(collector.hdcTimeoutMs,12000);assert.equal(collector.layoutTimeoutMs,30000);assert.equal(collector.helperTimeoutMs,90000);assert.equal(collector.slowLayoutThresholdMs,10000);assert.equal(collector.uiTimingSchemaVersion,1);
 });
 await test('validated numeric helper timing belongs to baseline and action samples and aggregates without observation fabrication',async()=>{
  const timing={layoutDumps:3,slowLayoutDumps:1,maxLayoutDumpMs:10001,layoutTimeoutMs:30000},f=fixture({uiTiming:timing});await f.api.main();const samples=f.samples(),s=f.summary();assert.equal(s.outcome,'completed');assert.deepEqual(samples[0].uiTiming,timing);assert(samples.filter(x=>x.mode==='observation').every(x=>x.uiTiming===undefined));assert.equal(s.uiTiming.helpersWithTiming,f.state.ui.length);assert.equal(s.uiTiming.layoutDumps,f.state.ui.length*3);assert.equal(s.uiTiming.slowLayoutDumps,f.state.ui.length);assert.equal(s.uiTiming.maxLayoutDumpMs,10001);assert.deepEqual(s.collector,f.manifest().collector);
 });
 await test('older successful helper JSON without timing stays compatible without fabricated timing values',async()=>{
  const f=fixture({activity:'idle',legacyTiming:true});await f.api.main();assert.equal(f.summary().outcome,'completed');assert.equal(f.summary().uiTiming,null);assert(f.samples().every(x=>x.uiTiming===undefined));
 });
 const validTiming={layoutDumps:2,slowLayoutDumps:0,maxLayoutDumpMs:50,layoutTimeoutMs:30000};
 for(const [name,timing] of [['null',null],['array',[]],['missing fields',{}],['unknown field',{...validTiming,raw:'synthetic-private-AX'}],['zero successful dumps',{...validTiming,layoutDumps:0,maxLayoutDumpMs:0}],['too many slow dumps',{...validTiming,slowLayoutDumps:3,maxLayoutDumpMs:11000}],['negative duration',{...validTiming,maxLayoutDumpMs:-1}],['unbounded duration',{...validTiming,maxLayoutDumpMs:120001}],['numeric string',{...validTiming,layoutDumps:'2'}],['old timeout claim',{...validTiming,layoutTimeoutMs:12000}],['missing slow count',{...validTiming,maxLayoutDumpMs:10001}],['inconsistent slow maximum',{...validTiming,slowLayoutDumps:1,maxLayoutDumpMs:10000}]]){
  await test('helper timing rejects '+name+' without retrying or persisting arbitrary metadata',async()=>{const f=fixture({uiTiming:timing});await f.api.main();assert.equal(f.summary().failure,'UI_HELPER_RESULT_INVALID');assert.equal(f.summary().outcome,'failed');assert.equal(f.state.ui.length,1);assert.equal(f.samples().length,0);assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));});
 }
 await test('failed layout timing is retained separately and cannot turn a timeout into a successful sample',async()=>{
  const uiTiming={layoutDumps:1,slowLayoutDumps:1,maxLayoutDumpMs:30023,layoutTimeoutMs:30000};
  const child={target,mode:'Inspect',errorCode:'HDC_TIMEOUT',failureDetail:{stage:'snapshot',operation:'dump-layout',mode:'Inspect',errorCode:'HDC_TIMEOUT'},uiTiming};
  const f=fixture({activity:'inspection',uiFailure:true,uiFailureMode:'Inspect',uiError:{status:1,stderr:JSON.stringify(child)}});await f.api.main();const s=f.summary();assert.equal(s.outcome,'failed');assert.equal(s.failureDetail.helperFailure.errorCode,'HDC_TIMEOUT');assert.deepEqual(s.failedHelperUiTiming,uiTiming);assert.equal(s.samples,1);assert.equal(s.uiInspections,0);assert.equal(s.uiTiming.helpersWithTiming,1);assert.deepEqual(f.state.ui,['Home','Inspect']);
 });
 await test('malformed or mismatched failed-helper timing is ignored while its failure remains visible',async()=>{
  for(const extra of [{uiTiming:{...validTiming,raw:'synthetic-private-AX'}},{target:'127.0.0.1:15559',uiTiming:validTiming}]){
   const child={target,mode:'Home',errorCode:'HDC_TIMEOUT',failureDetail:{stage:'snapshot',operation:'dump-layout',mode:'Home',errorCode:'HDC_TIMEOUT'},...extra};const f=fixture({uiFailure:true,uiError:{status:1,stderr:JSON.stringify(child)}});await f.api.main();assert.equal(f.summary().outcome,'failed');assert.equal(f.summary().failedHelperUiTiming,null);assert.equal(f.state.ui.length,1);assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));
  }
 });
 await test('atomic replacement flushes complete JSON before publication on a real filesystem',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-soak-atomic-')),file=path.join(dir,'checkpoint.json'),api=fixture().api;let flushed=false,renames=0;
  try{fs.writeFileSync(file,JSON.stringify({generation:1}));const observedFs={...fs,fsyncSync(fd){fs.fsyncSync(fd);flushed=true;},renameSync(from,to){renames++;assert(flushed);assert.equal(path.dirname(from),path.dirname(to));assert.equal(JSON.parse(fs.readFileSync(to,'utf8')).generation,1);assert.equal(JSON.parse(fs.readFileSync(from,'utf8')).generation,2);fs.renameSync(from,to);}};
   api.atomicWriteJson(file,{generation:2},observedFs);assert.equal(renames,1);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).generation,2);assert.deepEqual(fs.readdirSync(dir),['checkpoint.json']);
  }finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
 });
 for(const operation of ['writeFileSync','fsyncSync','renameSync'])await test('real '+operation+' failure preserves the previous checkpoint and never retries',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-soak-failure-')),file=path.join(dir,'checkpoint.json'),api=fixture().api;let calls=0;
  try{fs.writeFileSync(file,JSON.stringify({generation:1}));const brokenFs={...fs,[operation](...args){calls++;if(operation==='writeFileSync')fs.writeFileSync(args[0],'{partial');throw Object.assign(Error('synthetic-private-disk'),{code:'ENOSPC'});}};
   assert.throws(()=>api.atomicWriteJson(file,{generation:2},brokenFs),error=>error.message==='SOAK_OUTPUT_PERSISTENCE_FAILED'&&error.ioCode==='ENOSPC');assert.equal(calls,1);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).generation,1);assert.deepEqual(fs.readdirSync(dir),['checkpoint.json']);
  }finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
 });
 await test('checkpoint persistence failure terminates the run with an explicit failure and retains older observation evidence',async()=>{
  let failures=0;const f=fixture({activity:'idle',fsFailure(operation,p,state){if(operation==='rename'&&p.endsWith('checkpoint.json')&&state.elapsed>1000){failures++;return'ENOSPC';}}});
  await f.api.main();const report=f.summary();assert.equal(report.outcome,'failed');assert.equal(report.failure,'SOAK_OUTPUT_PERSISTENCE_FAILED');assert.equal(report.failureDetail.operation,'write-checkpoint');assert.equal(report.failureDetail.ioCode,'ENOSPC');assert.equal(failures,1);assert(f.checkpoint().samples<report.samples);assert.equal(report.samples,f.samples().length);assert.equal(f.processMock.exitCode,1);assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));
 });
 await test('a failed sample write cannot advance checkpoint sample count',async()=>{
  const f=fixture({activity:'idle',fsFailure(operation,p){if(operation==='write'&&p.endsWith('samples.jsonl'))return'EIO';}});await f.api.main();assert.equal(f.summary().failure,'SOAK_OUTPUT_PERSISTENCE_FAILED');assert.equal(f.summary().failureDetail.operation,'append-sample');assert.equal(f.summary().samples,0);assert.equal(f.checkpoint().samples,0);assert.equal(f.samples().length,0);
 });
 await test('a failed final summary publication leaves only unconfirmed checkpoint evidence and rejects main',async()=>{
  const f=fixture({activity:'idle',fsFailure(operation,p){if(operation==='rename'&&p.endsWith('summary.json'))return'EPERM';}});await assert.rejects(f.api.main(),/SOAK_OUTPUT_PERSISTENCE_FAILED/);assert(f.checkpoint().samples>2);assert.equal(f.checkpoint().completionClaim,false);assert(![...f.state.files.keys()].some(p=>p.endsWith('summary.json')));assert(!f.state.logs.some(line=>JSON.parse(line).recordType==='soak-run-summary'));
 });
 await test('abrupt termination of an actual child process retains a parseable manifest and checkpoint without inventing a summary',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-soak-interrupt-'));let child;
  try{child=cp.spawn(process.execPath,[__filename,'--interruption-child',dir],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('interruption child did not reach its checkpoint')),10000);let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('INTERRUPTION_READY')){clearTimeout(timeout);resolve();}});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(Error('interruption child exited before the forced interruption'));});});
   const exited=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});assert(child.kill('SIGKILL'));await exited;
   const m=JSON.parse(fs.readFileSync(path.join(dir,'run-manifest.json'),'utf8')),c=JSON.parse(fs.readFileSync(path.join(dir,'checkpoint.json'),'utf8')),lines=fs.readFileSync(path.join(dir,'samples.jsonl'),'utf8');
   assert.equal(c.runId,m.runId);assert.equal(c.samples,2);assert.equal(c.completionClaim,false);assert.equal(c.outcome,undefined);assert.equal(c.sampleBytes,Buffer.byteLength(lines));assert.equal(lines.trim().split('\n').map(JSON.parse).length,2);assert(!fs.existsSync(path.join(dir,'summary.json')));
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
 });
 for(const kind of ['guestMismatch','missingPid','uiFailure','overflow'])await test(kind+' fails safely with no false completion',async()=>{const f=fixture({[kind]:true});await f.api.main();const report=f.summary();assert.equal(report.outcome,'failed');assert.equal(report.sameProcess,false);assert(!JSON.stringify(f.state.logs).includes('synthetic-private'));});
 await test('production package is rejected before UI navigation',async()=>{const f=fixture({info:{versionName:'0.14.0'}});await f.api.main();assert.equal(f.summary().outcome,'failed');assert.equal(f.state.ui.length,0);});
 await test('stale installation version cannot be attributed to the current package',async()=>{const f=fixture({installation:{versionCode:34}});await f.api.main();assert.equal(f.summary().failure,'UI_ARTIFACT_IDENTITY_UNAVAILABLE');assert.equal(f.state.ui.length,0);});
 await test('idle mode initializes Home once then observes without navigation actions',async()=>{const f=fixture({activity:'idle'});await f.api.main();const report=f.summary();assert.equal(report.outcome,'completed');assert.equal(report.activity,'idle');assert.deepEqual(f.state.ui,['Home']);assert.equal(report.actions,0);assert(report.observedSeconds>160);assert.equal(report.artifactSHA256,hash);assert.equal(report.versionCode,35);assert(f.samples().slice(1).every(s=>s.mode==='idle'));});
 await test('navigation mode retains late-window metric observations and reports actual sample span',async()=>{const f=fixture();await f.api.main();const report=f.summary();assert.equal(report.outcome,'completed');assert(report.actions>0);assert.equal(report.actions,f.state.ui.length-1);assert(f.samples().some(s=>s.mode==='observation'));const s=f.samples();assert.equal(report.observedSeconds,Number((s.at(-1).elapsedSeconds-s[0].elapsedSeconds).toFixed(2)));assert(report.elapsedSeconds>report.observedSeconds);});
 await test('hard deadline truncation is explicitly incomplete',async()=>{const f=fixture({activity:'idle',deadlineDelta:80000});await f.api.main();assert.equal(f.summary().outcome,'deadline-reached');assert.equal(f.summary().deadlineLimited,true);assert.equal(f.processMock.exitCode,1);});
 await test('one-minute navigation with no action is insufficient rather than completed',async()=>{const f=fixture({minutes:1});await f.api.main();assert.equal(f.summary().outcome,'insufficient-observation');assert.equal(f.summary().actions,0);});
 for(const key of ['stopAt','signalAt'])await test(key+' ends with stopped summary',async()=>{const f=fixture({activity:'idle',[key]:15000});await f.api.main();assert.equal(f.summary().outcome,'stopped');assert.equal(f.summary().stopReason,key==='stopAt'?'stop.request':'SIGTERM');assert(f.summary().elapsedSeconds<18);assert.equal(f.processMock.exitCode,1);});
 await test('SIGINT has a separate stop reason and cannot be reported as completion',async()=>{const f=fixture({activity:'idle',signalAt:15000,signal:'SIGINT'});await f.api.main();assert.equal(f.summary().outcome,'stopped');assert.equal(f.summary().stopReason,'SIGINT');assert.equal(f.processMock.exitCode,1);});
 await test('a signal at the final timer boundary is still stopped rather than completed',async()=>{const f=fixture({activity:'idle',signalAt:180000});await f.api.main();assert.equal(f.summary().outcome,'stopped');assert.equal(f.summary().stopReason,'SIGTERM');assert.equal(f.processMock.exitCode,1);});
 await test('a loop with less than four seconds left waits to the exact plan boundary and its actual files pass inspection',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-soak-tail-'));
  try{const f=fixture({activity:'idle',minutes:1,commandDurationMs:500,realOutput:dir});await f.api.main();const s=f.summary();
   assert.equal(s.outcome,'completed');assert.equal(s.elapsedSeconds,60);assert.equal(f.state.elapsed,60000);assert.equal(s.samples,5);assert.equal(s.observedSeconds,42);assert.equal(f.state.commands.length,19);assert.equal(s.finishedAt,f.manifest().plan.observationEndsAt);
   const inspected=require('./inspect-emulator-soak.cjs').inspectRun(dir);assert.equal(inspected.status,'finalized');assert.equal(inspected.completionConfirmed,true);assert.equal(inspected.observedSeconds,42);
  }finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
 });
 await test('a final metric collection leaving less than four seconds also waits through the remaining interval',async()=>{
  const f=fixture({activity:'idle',minutes:1,commandDurationMs:1200});await f.api.main();assert.equal(f.samples().at(-1).elapsedSeconds,58.8);assert.equal(f.summary().elapsedSeconds,60);assert.equal(f.summary().outcome,'completed');assert.equal(f.summary().finishedAt,f.manifest().plan.observationEndsAt);
 });
 for(const [key,signal] of [['stopAt',undefined],['signalAt','SIGINT'],['signalAt','SIGTERM']])await test('the short final wait remains interruptible by '+(signal||'stop.request'),async()=>{
  const f=fixture({activity:'idle',minutes:1,commandDurationMs:500,[key]:59000,signal});await f.api.main();const s=f.summary();assert.equal(s.outcome,'stopped');assert.equal(s.stopReason,signal||'stop.request');assert(s.elapsedSeconds>=59&&s.elapsedSeconds<60);assert.equal(f.state.commands.length,19);assert.equal(f.processMock.exitCode,1);
 });
 for(const key of ['stopAt','signalAt'])await test(key+' at the short final timer boundary cannot become completed',async()=>{
  const f=fixture({activity:'idle',minutes:1,commandDurationMs:500,[key]:60000});await f.api.main();assert.equal(f.summary().outcome,'stopped');assert.equal(f.summary().stopReason,key==='stopAt'?'stop.request':'SIGTERM');assert.equal(f.summary().elapsedSeconds,60);assert.equal(f.processMock.exitCode,1);
 });
 await test('the short final wait honors the reserved hard deadline without claiming the requested duration',async()=>{
  const f=fixture({activity:'idle',minutes:1,commandDurationMs:500,deadlineDelta:75000});await f.api.main();assert.equal(f.summary().outcome,'deadline-reached');assert.equal(f.summary().elapsedSeconds,45);assert.equal(f.summary().deadlineLimited,true);assert.equal(f.summary().finishedAt,f.manifest().plan.observationEndsAt);assert.equal(f.processMock.exitCode,1);
 });
 await test('same-version artifact replacement cannot mix candidate observations',async()=>{const f=fixture({changeArtifact:true});await f.api.main();assert.equal(f.summary().failure,'UI_ARTIFACT_CHANGED');assert.equal(f.summary().artifactSHA256,hash);assert.equal(f.summary().outcome,'failed');});
 await test('process restart cannot be counted as a continuous observation',async()=>{const f=fixture({activity:'idle',restartAt:15000});await f.api.main();assert.equal(f.summary().failure,'UI_PROCESS_RESTARTED');assert.equal(f.summary().outcome,'failed');assert.equal(f.summary().sameProcess,false);});
 await test('unavailable RSS stays null rather than becoming zero',async()=>{const f=fixture({activity:'idle',statusFailure:true});await f.api.main();const report=f.summary();assert.equal(report.outcome,'completed');assert.equal(report.initialRssMiB,null);assert.equal(report.finalRssMiB,null);assert.equal(report.warmRssSlopeMiBPerHour,null);});
 for(const value of [-1,1001,'1.5','x','01'])await test('invalid memory interval '+value+' is rejected',()=>assert.throws(()=>fixture({memoryEvery:value})));
 await test('memory parser maps declared columns and exposes only selected numeric fields',()=>{
  const f=fixture(),m=f.api.parseMemoryBreakdown(memRaw);assert.equal(m.status,'available');assert.equal(m.totalPssKiB,400);
  assert.equal(m.arkPssKiB,100);assert.equal(m.arkPrivateDirtyKiB,94);assert.equal(m.nativeHeapAllocKiB,210);
  assert.equal(m.soSharedKiB,42);assert.equal(m.soRssKiB,52);assert.equal(m.ttfPssKiB,20);
  assert(!JSON.stringify(m).includes('synthetic-private'));assert.equal(m.unit,'KiB');
 });
 await test('memory parser also accepts a two-line header and does not assume missing statistics are zero',()=>{
  const f=fixture();const split='Pss Shared Shared Private Private Swap SwapPss Heap Heap Heap\nTotal Clean Dirty Clean Dirty Total Total Size Alloc Free';
  const m=f.api.parseMemoryBreakdown(split+'\n'+memRows.at(-1));assert.equal(m.totalPssKiB,400);assert.equal(m.arkPssKiB,null);assert.equal(m.soRssKiB,null);
  const full=f.api.parseMemoryBreakdown(split+'\n'+memRows.join('\n'));assert.equal(full.nativePrivateDirtyKiB,140);
 });
 await test('missing columns, duplicate totals and unavailable memory output cannot produce a valid zero measurement',()=>{
  const f=fixture();for(const raw of ['Permission denied',memRaw.replace('HeapFree','OtherColumn'),memHeader+'\n'+memRows.slice(0,-1).join('\n'),memRaw+'\n'+memRows.at(-1)]){
   const m=f.api.parseMemoryBreakdown(raw);assert.equal(m.status,'unavailable');assert.equal(m.totalPssKiB,undefined);
  }
 });
 await test('memory collector pins the numeric PID and skips when its full bounded command budget is unavailable',()=>{
  const f=fixture();let calls=0;
  const execute=(args,timeout)=>{calls++;assert.equal(JSON.stringify(args),JSON.stringify(['shell','hidumper','--mem','222']));assert.equal(timeout,2000);return memRaw;};
  assert.equal(f.api.collectMemoryBreakdown(222,execute,()=>2499).status,'unavailable');assert.equal(calls,0);
  assert.equal(f.api.collectMemoryBreakdown(0,execute,()=>10000).status,'unavailable');assert.equal(calls,0);
  assert.equal(f.api.collectMemoryBreakdown(222,execute,()=>3000).status,'available');assert.equal(calls,1);
  assert.equal(f.api.collectMemoryBreakdown(222,()=>{throw Error('synthetic-private');},()=>3000).status,'unavailable');
  assert.throws(()=>f.api.collectMemoryBreakdown(222,()=>{throw Error('SOAK_STOP_REQUESTED');},()=>3000));
 });
 await test('memory breakdown stays disabled by default with no additional device commands',async()=>{
  const f=fixture({activity:'idle'});await f.api.main();assert.equal(f.summary().memoryBreakdownEvery,0);
  assert.equal(f.summary().memoryBreakdownSamples,0);assert(f.samples().every(s=>!s.memoryBreakdown));
  assert(!f.state.commands.some(c=>c.args.includes('hidumper')));
 });
 await test('memory collection runs on baseline and every N samples using the explicit target and records no raw text',async()=>{
  const f=fixture({activity:'idle',memoryEvery:3});await f.api.main();const samples=f.samples();
  assert.equal(f.summary().outcome,'completed');assert.equal(f.summary().memoryBreakdownEvery,3);
  samples.forEach((s,i)=>{assert.equal(!!s.memoryBreakdown,i%3===0);if(s.memoryBreakdown)assert.equal(s.memoryBreakdown.status,'available');});
  assert.equal(f.state.commands.filter(c=>c.args.includes('hidumper')).length,samples.filter(s=>s.memoryBreakdown).length);
  assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private-memory'));
 });
 await test('unavailable optional memory interface does not abort ordinary samples or record zero PSS',async()=>{
  const f=fixture({activity:'idle',memoryEvery:1,memFailure:true});await f.api.main();assert.equal(f.summary().outcome,'completed');
  assert.equal(f.summary().memoryBreakdownUnavailable,f.samples().length);
  for(const sample of f.samples()){assert.equal(sample.memoryBreakdown.status,'unavailable');assert.equal(sample.memoryBreakdown.totalPssKiB,undefined);}
  assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private-memory'));
 });
 await test('helper timeout records fixed operation and mode without retrying or retaining child output',async()=>{
  const f=fixture({uiFailure:true,uiError:{code:'ETIMEDOUT',status:null,stdout:'synthetic-private-config',stderr:'synthetic-private-AX'}});await f.api.main();
  const s=f.summary();assert.equal(s.outcome,'failed');assert.equal(f.state.ui.length,1);assert.equal(s.failureDetail.stage,'ui-helper');assert.equal(s.failureDetail.operation,'navigate');assert.equal(s.failureDetail.mode,'Home');assert.equal(s.failureDetail.errorCode,'HELPER_TIMEOUT');assert.equal(s.failureDetail.exitStatus,undefined);assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));
 });
 await test('nonzero helper exit preserves only validated nested HDC diagnosis and numeric exit statuses',async()=>{
  const child={errorCode:'HDC_TIMEOUT',failureDetail:{stage:'snapshot',operation:'dump-layout',mode:'Home',errorCode:'HDC_TIMEOUT',exitStatus:7,stdout:'synthetic-private-tree',command:'synthetic-private-command'}};
  const f=fixture({uiFailure:true,uiError:{status:1,stderr:JSON.stringify(child)}});await f.api.main();const d=f.summary().failureDetail;
  assert.equal(d.errorCode,'HELPER_EXIT_NONZERO');assert.equal(d.exitStatus,1);assert.equal(d.helperFailure.operation,'dump-layout');assert.equal(d.helperFailure.errorCode,'HDC_TIMEOUT');assert.equal(d.helperFailure.exitStatus,7);assert.equal(f.state.ui.length,1);assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));
 });
 await test('unknown child details and mismatched modes are discarded without reading arbitrary error text',async()=>{
  for(const child of [{errorCode:'synthetic-private',failureDetail:{mode:'Home',errorCode:'synthetic-private'}},{errorCode:'HDC_TIMEOUT',failureDetail:{stage:'snapshot',operation:'dump-layout',mode:'Nodes',errorCode:'HDC_TIMEOUT'}}]){
   const f=fixture({uiFailure:true,uiError:{status:2,stderr:JSON.stringify(child)}});await f.api.main();assert.equal(f.summary().failureDetail.helperFailure,undefined);assert.equal(f.summary().outcome,'failed');assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));
  }
 });
 await test('HDC preflight timeout identifies model check and does not launch or retry a UI helper',async()=>{
  const f=fixture({hdcFailure:'param',hdcError:{code:'ETIMEDOUT',status:null,stderr:'synthetic-private-device'}});await f.api.main();const d=f.summary().failureDetail;
  assert.equal(d.stage,'preflight');assert.equal(d.operation,'guest-model');assert.equal(d.errorCode,'HDC_TIMEOUT');assert.equal(f.state.commands.length,1);assert.equal(f.state.ui.length,0);assert.equal(f.summary().outcome,'failed');
 });
 await test('proc stat failure keeps the original command diagnosis while retaining its existing failure category',async()=>{
  const f=fixture({statFailure:true,hdcError:{status:9,code:'synthetic-private-code'}});await f.api.main();const s=f.summary();assert.equal(s.failure,'UI_PROC_STAT_UNAVAILABLE');assert.equal(s.failureDetail.operation,'proc-stat');assert.equal(s.failureDetail.mode,'baseline');assert.equal(s.failureDetail.errorCode,'HDC_EXIT_NONZERO');assert.equal(s.failureDetail.exitStatus,9);
 });
 await test('malformed helper JSON has a fixed parse classification and no body in summary',async()=>{
  const f=fixture({uiRaw:'{synthetic-private-malformed'});await f.api.main();const s=f.summary();assert.equal(s.failure,'UI_HELPER_RESULT_INVALID');assert.equal(s.failureDetail.operation,'parse-helper-result');assert.equal(s.outcome,'failed');assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));
 });
 await test('successful and stopped observations have no failure diagnosis',async()=>{
  for(const options of [{activity:'idle'},{activity:'idle',stopAt:15000}]){const f=fixture(options);await f.api.main();assert.equal(f.summary().failureDetail,null);}
 });
 await test('inspection initializes Home once then only inspects layout, with separate count and late observation samples',async()=>{
  const f=fixture({activity:'inspection'});await f.api.main();const report=f.summary(),samples=f.samples();
  assert.equal(report.outcome,'completed');assert.equal(report.activity,'inspection');assert.equal(report.actions,0);assert(report.uiInspections>0);assert.equal(report.uiInspections,f.state.ui.length-1);assert.equal(f.state.ui[0],'Home');assert(f.state.ui.slice(1).every(mode=>mode==='Inspect'));
  assert.equal(report.uiInspections,samples.filter(s=>s.mode==='Inspect').length);assert.equal(report.sameProcess,true);assert.equal(report.artifactSHA256,hash);assert(report.observedSeconds>160);assert.equal(report.failureDetail,null);
  const firstObservation=samples.findIndex(s=>s.mode==='observation');assert(firstObservation>0);assert(samples.slice(firstObservation).every(s=>s.mode==='observation'));assert(samples.filter(s=>s.mode==='Inspect').at(-1).elapsedSeconds<91);
 });
 await test('one-minute inspection with zero inspections cannot be reported as complete',async()=>{
  const f=fixture({activity:'inspection',minutes:1});await f.api.main();const report=f.summary();assert.equal(report.outcome,'insufficient-observation');assert.equal(report.uiInspections,0);assert.equal(report.actions,0);assert.deepEqual(f.state.ui,['Home']);assert.equal(f.processMock.exitCode,1);
 });
 await test('hard deadline still truncates inspection without claiming completion',async()=>{
  const f=fixture({activity:'inspection',deadlineDelta:80000});await f.api.main();const report=f.summary();assert.equal(report.outcome,'deadline-reached');assert.equal(report.deadlineLimited,true);assert.equal(report.uiInspections,0);assert.equal(report.actions,0);assert.equal(f.processMock.exitCode,1);
 });
 for(const key of ['stopAt','signalAt'])await test('inspection '+key+' preserves stopped outcome and bounded termination',async()=>{
  const f=fixture({activity:'inspection',[key]:15000});await f.api.main();const report=f.summary();assert.equal(report.outcome,'stopped');assert(report.elapsedSeconds<18);assert.equal(report.actions,0);assert(report.uiInspections>0);assert.equal(report.failureDetail,null);assert.equal(f.processMock.exitCode,1);assert(f.state.ui.slice(1).every(mode=>mode==='Inspect'));
 });
 await test('inspection retains same-artifact attribution checks',async()=>{
  const f=fixture({activity:'inspection',changeArtifact:true});await f.api.main();const report=f.summary();assert.equal(report.outcome,'failed');assert.equal(report.failure,'UI_ARTIFACT_CHANGED');assert.equal(report.artifactSHA256,hash);assert.equal(report.uiInspections,0);assert.equal(report.actions,0);
 });
 await test('inspection still fails when the observed process restarts',async()=>{
  const f=fixture({activity:'inspection',restartAt:15000});await f.api.main();const report=f.summary();assert.equal(report.outcome,'failed');assert.equal(report.failure,'UI_PROCESS_RESTARTED');assert.equal(report.sameProcess,false);assert.equal(report.actions,0);
 });
 await test('inspection failures preserve fixed helper diagnosis and never retry or count a failed inspection',async()=>{
  const f=fixture({activity:'inspection',uiFailure:true,uiFailureMode:'Inspect',uiError:{code:'ETIMEDOUT',stderr:'synthetic-private-inspector'}});await f.api.main();const report=f.summary();assert.equal(report.outcome,'failed');assert.equal(report.failureDetail.stage,'ui-helper');assert.equal(report.failureDetail.operation,'inspect-layout');assert.equal(report.failureDetail.mode,'Inspect');assert.equal(report.failureDetail.errorCode,'HELPER_TIMEOUT');assert.equal(report.uiInspections,0);assert.equal(report.actions,0);assert.deepEqual(f.state.ui,['Home','Inspect']);assert(!JSON.stringify([...f.state.files.values(),f.state.logs]).includes('synthetic-private'));
 });
 console.log(JSON.stringify({passed:passed.length,failed:0,scope:'Actual soak logic with virtual clock and simulated HDC/UI; real temporary filesystem atomic/failure tests and an abruptly terminated child. No device commands or project output directories.',tests:passed}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
