'use strict';
// Authored soak script with virtual time, memory-only output and simulated HDC/UI commands.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'soak-emulator-ui.cjs'),'utf8'),target='127.0.0.1:15558',hash='a'.repeat(64),start=Date.parse('2026-09-09T17:00:00Z');
const memHeader='PssTotal SharedClean SharedDirty PrivateClean PrivateDirty SwapTotal SwapPssTotal HeapSize HeapAlloc HeapFree';
const memRows=['ark ts heap 100 1 2 3 94 0 0 150 120 30','native heap 200 10 20 30 140 0 0 250 210 40',
 '.so 50 40 2 4 6 0 0 - - -','.ttf 20 10 0 10 0 0 0 - - -','Total 400 61 22 47 240 0 0 400 330 70'];
const memRaw='synthetic-private-memory-label\n'+memHeader+'\n'+memRows.join('\n')+'\nignored synthetic-private-memory-label';
function fixture(options={}){
 const state={elapsed:0,files:new Map(),dirs:new Set(),logs:[],commands:[],ui:[],signals:{},exitCode:undefined};
 const info={versionName:'0.14.0-ui-preview',versionCode:35,applicationInfo:{cpuAbi:'x86_64'}},installation={target,versionName:info.versionName,versionCode:35,sha256:hash};
 const norm=p=>path.resolve(p),out=norm(path.join(__dirname,'../build/phase14-soak/synthetic-safety'));
 const memory={existsSync(p){p=norm(p);if(p.endsWith('stop.request')&&options.stopAt!==undefined&&state.elapsed>=options.stopAt)return true;return state.files.has(p)||state.dirs.has(p)||(options.existingOutput&&p===out);},
  mkdirSync(p){state.dirs.add(norm(p));},readFileSync(p){assert(String(p).endsWith('install-15558.json'));return JSON.stringify({...installation,...options.installation});},
  appendFileSync(p,s){p=norm(p);state.files.set(p,(state.files.get(p)||'')+s);},writeFileSync(p,s){state.files.set(norm(p),s);}};
 class Clock extends Date{constructor(v){super(v===undefined?start+state.elapsed:v);}static now(){return start+state.elapsed;}}
 const commands={execFileSync(exe,args,opts){state.commands.push({exe,args,timeout:opts.timeout});assert(opts.windowsHide);assert(opts.timeout>0&&opts.timeout<=90000);state.elapsed+=50;
  if(exe==='synthetic-node'){
   assert.equal(args[1],target);assert.equal(args[4],'phase14');assert.equal(opts.env.HARMONY_UI_QA_CAPTURE_IMAGE,'0');state.ui.push(args[2]);
   if(options.uiFailure&&(!options.uiFailureMode||options.uiFailureMode===args[2]))throw Object.assign(Error('synthetic-private-ui-payload'),options.uiError||{});
   if(options.uiRaw!==undefined)return options.uiRaw;
   const artifact=options.changeArtifact&&state.ui.length>1?'b'.repeat(64):hash;
   return JSON.stringify({target,mode:args[2],artifactSHA256:artifact,appBounds:[0,0,1200,900],horizontalOverflow:options.overflow?['control']:[]});
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
 const mod={exports:{}},processMock={argv,env:{},execPath:'synthetic-node',on:(name,callback)=>{state.signals[name]=callback;}};
 const context={module:mod,process:processMock,__dirname,Date:Clock,console:{log:s=>state.logs.push(s),error:s=>state.logs.push(s)},
  setTimeout(callback,ms){assert(ms<=1000);state.elapsed+=ms;if(options.signalAt!==undefined&&state.elapsed>=options.signalAt)state.signals.SIGTERM?.();Promise.resolve().then(callback);},
  require(name){if(name==='node:fs')return memory;if(name==='node:child_process')return commands;if(name==='node:perf_hooks')return{performance:{now:()=>state.elapsed}};
   if(name==='./measure-device-stability.cjs')return{parseStat:s=>JSON.parse(s),parseStatus:s=>JSON.parse(s)};return require(name);}};
 context.require.main={};vm.runInNewContext(source,context);return{state,processMock,api:mod.exports,summary:()=>JSON.parse(state.files.get(path.join(out,'summary.json'))),samples:()=>String(state.files.get(path.join(out,'samples.jsonl'))||'').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
const passed=[];async function test(name,fn){await fn();passed.push(name);}
(async()=>{
 await test('invalid target is refused before any command',()=>assert.throws(()=>fixture({target:'USB_PHONE'})));
 await test('unknown activity is refused',()=>assert.throws(()=>fixture({activity:'connect'})));
 await test('existing output directory cannot be overwritten',()=>assert.throws(()=>fixture({existingOutput:true})));
 for(const kind of ['guestMismatch','missingPid','uiFailure','overflow'])await test(kind+' fails safely with no false completion',async()=>{const f=fixture({[kind]:true});await f.api.main();const report=f.summary();assert.equal(report.outcome,'failed');assert.equal(report.sameProcess,false);assert(!JSON.stringify(f.state.logs).includes('synthetic-private'));});
 await test('production package is rejected before UI navigation',async()=>{const f=fixture({info:{versionName:'0.14.0'}});await f.api.main();assert.equal(f.summary().outcome,'failed');assert.equal(f.state.ui.length,0);});
 await test('stale installation version cannot be attributed to the current package',async()=>{const f=fixture({installation:{versionCode:34}});await f.api.main();assert.equal(f.summary().failure,'UI_ARTIFACT_IDENTITY_UNAVAILABLE');assert.equal(f.state.ui.length,0);});
 await test('idle mode initializes Home once then observes without navigation actions',async()=>{const f=fixture({activity:'idle'});await f.api.main();const report=f.summary();assert.equal(report.outcome,'completed');assert.equal(report.activity,'idle');assert.deepEqual(f.state.ui,['Home']);assert.equal(report.actions,0);assert(report.observedSeconds>160);assert.equal(report.artifactSHA256,hash);assert.equal(report.versionCode,35);assert(f.samples().slice(1).every(s=>s.mode==='idle'));});
 await test('navigation mode retains late-window metric observations and reports actual sample span',async()=>{const f=fixture();await f.api.main();const report=f.summary();assert.equal(report.outcome,'completed');assert(report.actions>0);assert.equal(report.actions,f.state.ui.length-1);assert(f.samples().some(s=>s.mode==='observation'));const s=f.samples();assert.equal(report.observedSeconds,Number((s.at(-1).elapsedSeconds-s[0].elapsedSeconds).toFixed(2)));assert(report.elapsedSeconds>report.observedSeconds);});
 await test('hard deadline truncation is explicitly incomplete',async()=>{const f=fixture({activity:'idle',deadlineDelta:80000});await f.api.main();assert.equal(f.summary().outcome,'deadline-reached');assert.equal(f.summary().deadlineLimited,true);assert.equal(f.processMock.exitCode,1);});
 await test('one-minute navigation with no action is insufficient rather than completed',async()=>{const f=fixture({minutes:1});await f.api.main();assert.equal(f.summary().outcome,'insufficient-observation');assert.equal(f.summary().actions,0);});
 for(const key of ['stopAt','signalAt'])await test(key+' ends with stopped summary',async()=>{const f=fixture({activity:'idle',[key]:15000});await f.api.main();assert.equal(f.summary().outcome,'stopped');assert(f.summary().elapsedSeconds<18);assert.equal(f.processMock.exitCode,1);});
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
 console.log(JSON.stringify({passed:passed.length,failed:0,scope:'Actual soak logic with virtual clock and simulated FS/HDC/UI; no device or real output directories.',tests:passed}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
