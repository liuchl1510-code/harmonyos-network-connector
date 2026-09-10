'use strict';
// Actual helper in a VM with in-memory files and simulated child processes only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const diagnostic=require('./emulator-failure-detail.cjs');
const source=fs.readFileSync(path.join(__dirname,'test-adaptive-emulator.cjs'),'utf8');
const target='127.0.0.1:15558',hash='a'.repeat(64),passed=[];
function fixture(options={}){
 const state={commands:[],timeouts:[],elapsed:0,logs:[],errors:[],files:new Map()},mod={exports:{}};
 const processMock={argv:['synthetic-node','test-adaptive-emulator.cjs',target,options.mode||'Inspect','synthetic-diagnostic','phase14'],env:{HARMONY_UI_QA_CAPTURE_IMAGE:'0'},pid:1234};
 const tree={attributes:{bundleName:'com.example.harmonyvpnlab',type:'root',visible:true,bounds:'[0,0][1200,900]'},children:[{attributes:{id:'navHome',type:'Button',visible:true,enabled:!options.disabled,bounds:options.overflow?'[-100,0][100,100]':'[0,0][100,100]'}}]};
 if(options.modal)tree.children.push({attributes:{type:'Dialog',visible:true}});
 if(options.ambiguous)tree.children.push(tree.children[0]);
 const cp={execFileSync(exe,args,opts){assert(opts.windowsHide);assert.equal(args[0],'-t');assert.equal(args[1],target);state.commands.push(args.slice(2));const a=args.slice(2);
  const op=a[1]==='uitest'&&a[2]==='dumpLayout'?'dump':a[1]==='cat'?'read':a[1]==='rm'?'cleanup':'other';
  assert.equal(opts.timeout,op==='dump'?30000:12000);state.timeouts.push(opts.timeout);state.elapsed+=op==='dump'?(options.dumpDurationMs??5):7;
  if(options.fail===op||options.cleanupFailure&&op==='cleanup')throw Object.assign(Error('synthetic-private-command-and-AX'),op==='cleanup'?{status:8}:options.error||{code:'ETIMEDOUT',status:null});
  if(op==='read')return options.raw??JSON.stringify(tree);return '';
 }};
 const memory={mkdirSync(){},existsSync(){return true;},readFileSync(){return JSON.stringify({target,sha256:hash});},writeFileSync(p,s){state.files.set(p,s);}};
 const context={module:mod,process:processMock,__dirname,Buffer,console:{log:s=>state.logs.push(s),error:s=>state.errors.push(s)},setTimeout:cb=>Promise.resolve().then(cb),
  require(name){if(name==='node:fs')return memory;if(name==='node:child_process')return cp;if(name==='node:perf_hooks')return{performance:{now:()=>state.elapsed}};return require(name);}};
 context.require.main={};vm.runInNewContext(source,context);
 return{state,processMock,async run(){try{await mod.exports.main();}catch(error){mod.exports.reportFailure(error);}return state.errors.length?JSON.parse(state.errors.at(-1)):undefined;}};
}
async function test(name,fn){await fn();passed.push(name);}
(async()=>{
 await test('successful helper retains its existing keys plus fixed numeric UI timing',async()=>{
  const f=fixture();assert.equal(await f.run(),undefined);assert.equal(f.processMock.exitCode,undefined);const result=JSON.parse(f.state.logs.at(-1));
  assert.deepEqual(Object.keys(result),['target','label','mode','capturedAt','artifactSHA256','appBounds','sideNavigation','twoColumns','controls','horizontalOverflow','scope','uiTiming']);assert.equal(result.artifactSHA256,hash);assert.equal(f.state.commands.length,3);assert.deepEqual(result.uiTiming,{layoutDumps:1,slowLayoutDumps:0,maxLayoutDumpMs:5,layoutTimeoutMs:30000});assert.deepEqual(f.state.timeouts,[30000,12000,12000]);
 });
 await test('slow layout timing counts only dumps and uses the strict ten-second threshold',async()=>{
  for(const duration of [10000,10001]){const f=fixture({mode:'Home',dumpDurationMs:duration});assert.equal(await f.run(),undefined);const timing=JSON.parse(f.state.logs.at(-1)).uiTiming;assert.equal(timing.layoutDumps,f.state.commands.filter(a=>a[2]==='dumpLayout').length);assert.equal(timing.slowLayoutDumps,duration>10000?timing.layoutDumps:0);assert.equal(timing.maxLayoutDumpMs,duration);assert(f.state.timeouts.includes(12000));}
 });
 await test('a thirty-second timeout remains failed, records elapsed time and never retries the dump',async()=>{
  const f=fixture({fail:'dump',dumpDurationMs:30023}),report=await f.run();assert.equal(report.errorCode,'HDC_TIMEOUT');assert.deepEqual(report.uiTiming,{layoutDumps:1,slowLayoutDumps:1,maxLayoutDumpMs:30023,layoutTimeoutMs:30000});assert.equal(f.state.commands.filter(a=>a[2]==='dumpLayout').length,1);assert.equal(f.processMock.exitCode,1);
 });
 await test('layout temporary paths differ between helpers even when host PID is reused',async()=>{
  const a=fixture(),b=fixture();await a.run();await b.run();const first=a.state.commands[0][4],second=b.state.commands[0][4];assert.notEqual(first,second);assert.match(first,/^\/data\/local\/tmp\/harmony-adaptive-1234-[a-f0-9-]+\.json$/);assert(a.state.commands.filter(x=>x[1]==='cat'||x[1]==='rm').every(x=>x.at(-1)===first));
 });
 for(const [error,expected] of [[{code:'ETIMEDOUT',status:null},'HDC_TIMEOUT'],[{code:'ENOBUFS'},'HDC_OUTPUT_LIMIT'],[{code:'ENOENT'},'HDC_UNAVAILABLE'],[{code:'EACCES'},'HDC_ACCESS_DENIED'],[{status:7},'HDC_EXIT_NONZERO'],[{code:'synthetic-private-code',status:'synthetic-private-status'},'HDC_OPERATION_FAILED']])await test('fixed classification '+expected+' does not retain original error fields',async()=>{
  const f=fixture({fail:'dump',error:{...error,stdout:'synthetic-private-stdout',stderr:'synthetic-private-stderr'}}),report=await f.run();assert.equal(report.errorCode,expected);assert.equal(report.failureDetail.stage,'snapshot');assert.equal(report.failureDetail.operation,'dump-layout');assert.equal(report.failureDetail.mode,'Inspect');assert.equal(f.processMock.exitCode,1);assert.equal(f.state.commands.filter(a=>a[2]==='dumpLayout').length,1);assert(!JSON.stringify([...f.state.files.values(),f.state.logs,f.state.errors]).includes('synthetic-private'));
 });
 await test('cleanup failure does not replace an earlier layout dump failure',async()=>{
  const f=fixture({fail:'dump',cleanupFailure:true}),report=await f.run();assert.equal(report.errorCode,'HDC_TIMEOUT');assert.equal(report.failureDetail.operation,'dump-layout');assert.equal(f.state.commands.length,2);
 });
 await test('standalone cleanup failure is still reported as failure',async()=>{
  const f=fixture({cleanupFailure:true}),report=await f.run();assert.equal(report.errorCode,'HDC_EXIT_NONZERO');assert.equal(report.failureDetail.operation,'cleanup-layout');assert.equal(report.failureDetail.exitStatus,8);
 });
 await test('invalid AX JSON is classified without retaining its body',async()=>{
  const f=fixture({raw:'synthetic-private-AX'}),report=await f.run();assert.equal(report.errorCode,'UI_LAYOUT_JSON_INVALID');assert.equal(report.failureDetail.operation,'parse-layout');assert(!JSON.stringify(f.state.errors).includes('synthetic-private'));
 });
 for(const [option,expected] of [['modal','UI_SYSTEM_MODAL'],['ambiguous','UI_CONTROL_AMBIGUOUS'],['disabled','UI_CONTROL_DISABLED']])await test('navigation reports fixed '+expected,async()=>{
  const f=fixture({mode:'Home',[option]:true}),report=await f.run();assert.equal(report.errorCode,expected);assert.equal(report.failureDetail.mode,'Home');assert.equal(f.processMock.exitCode,1);
 });
 await test('overflow remains nonzero and gives the parent an explicit layout error',async()=>{
  const f=fixture({overflow:true}),report=await f.run();assert.equal(report.errorCode,'UI_LAYOUT_OR_OVERFLOW_FAILURE');assert.equal(f.processMock.exitCode,1);assert.equal(JSON.parse(f.state.logs[0]).horizontalOverflow.length,1);
 });
 await test('diagnostic whitelist rejects unknown metadata and bounds child envelope parsing',()=>{
  const d=diagnostic.sanitize({stage:'synthetic-private-stage',operation:'synthetic-private-command',mode:'synthetic-private-mode',errorCode:'HDC_TIMEOUT',exitStatus:'synthetic-private-status',stdout:'synthetic-private-output'});assert.deepEqual(d,{stage:'unknown',operation:'unknown',mode:'unknown',errorCode:'HDC_TIMEOUT'});
  assert.equal(diagnostic.sanitize({errorCode:'synthetic-private-code'}),undefined);assert.equal(diagnostic.helper('x'.repeat(8193),'Home'),undefined);assert.equal(diagnostic.helper('not JSON','Home'),undefined);
 });
 console.log(JSON.stringify({passed:passed.length,failed:0,scope:'Actual helper and shared failure metadata with simulated HDC, memory files and no device actions.',tests:passed}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
