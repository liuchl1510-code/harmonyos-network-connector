'use strict';
// Reproducible versions of the 33 template checks used during phase15.
// Requires the existing DevEco SDK TypeScript runtime; no package installation.
// Only the authored .ets template and SDK compiler are read from disk. All kit,
// FS, heap API and UIAbility-context operations below are in-memory mocks.
// SDK syntax transpilation is not a complete ArkTS application build.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const templatePath=path.join(__dirname,'fixtures','EmulatorHeapProbe.ets');
const studio=process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio';
const compilerPath=path.join(studio,'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js');
let compiler,activeTest='sdk-syntax-transpile';
try{compiler=require(compilerPath);}catch(_){console.error('HEAP_PROBE_TEST_SDK_TYPESCRIPT_UNAVAILABLE');process.exitCode=1;}

function fixture(compiled,options={}){
 const files=new Map(),descriptors=new Map(),logs=[],rawCalls=[],legacyCalls=[];
 let nextFd=1,resolvePending;
 const fileIo={
  OpenMode:{CREATE:1,WRITE_ONLY:2,TRUNC:4},
  openSync(file,mode){assert.equal(mode,7);const fd=nextFd++;descriptors.set(fd,file);files.set(file,Buffer.alloc(0));return{fd};},
  writeSync(fd,buffer){
   assert(descriptors.has(fd));if(options.diskError)throw{code:13900042,message:'synthetic-private-file'};
   const bytes=Buffer.from(buffer),count=Math.min(bytes.length,options.partial||bytes.length),file=descriptors.get(fd);
   files.set(file,Buffer.concat([files.get(file),bytes.subarray(0,count)]));return count;
  },
  fsyncSync(fd){assert(descriptors.has(fd));},
  closeSync(file){assert(descriptors.delete(file.fd));},
  renameSync(from,to){assert(files.has(from));files.set(to,files.get(from));files.delete(from);},
  accessSync:file=>files.has(file)||(options.preexisting&&file.endsWith('.heapsnapshot')),
  unlinkSync:file=>files.delete(file),
  statSync(file){
   if(!files.has(file))throw{code:13900002,name:'BusinessError',message:'synthetic-private-path'};
   return{size:files.get(file).length,isFile:()=>!options.directoryOutput};
  }
 };
 const hidebug={};
 if(!options.noRaw)hidebug.dumpJsRawHeapData=(gc,clean)=>{
  rawCalls.push([gc,clean]);
  if(options.pending)return new Promise(resolve=>{resolvePending=()=>{files.set('/cache/actual.rawheap',Buffer.from('heap'));resolve('/cache/actual.rawheap');};});
  if(Object.hasOwn(options,'error'))return Promise.reject(options.error);
  if(!options.noOutput)files.set('/cache/actual.rawheap',Buffer.from(options.emptyOutput?'':'heap'));
  return Promise.resolve('/cache/actual.rawheap');
 };
 if(!options.noLegacy)hidebug.dumpJsHeapData=(filename,clean)=>{
  legacyCalls.push([filename,clean]);if(Object.hasOwn(options,'error'))throw options.error;
  if(!options.noOutput){
   files.set((options.legacyDir||'/app-files')+'/'+filename+'.heapsnapshot',Buffer.from(options.emptyOutput?'':'heap'));
   if(options.ambiguous)files.set('/files/'+filename+'.heapsnapshot',Buffer.from('other'));
  }
 };
 const context={exports:{},Date,Uint8Array,Number,Error,TypeError,require(name){
  if(name==='@kit.PerformanceAnalysisKit')return{hidebug,hilog:{info:(...args)=>logs.push(args),warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args)}};
  if(name==='@kit.CoreFileKit')return{fileIo};
  if(name==='@kit.BasicServicesKit')return{deviceInfo:{abiList:options.abi||'x86_64'}};
  if(name==='@kit.ArkTS')return{util:{TextEncoder:class{encodeInto(text){return new TextEncoder().encode(text);}}}};
  if(name==='./BuildCapabilities')return{VPN_CORE_AVAILABLE:options.core||false};
  throw Error('UNEXPECTED_TEMPLATE_IMPORT');
 }};
 vm.runInNewContext(compiled,context,{filename:'EmulatorHeapProbe.mock.js'});
 return{files,logs,rawCalls,legacyCalls,
  request:(label='before',gc='true',api)=>context.exports.handleHeapCapture(
   {parameters:{uiHeapCapture:label,uiHeapGc:gc,uiHeapApi:api}},
   {applicationInfo:{debug:options.debug!==false},cacheDir:'/cache',filesDir:'/files',
    getApplicationContext:()=>({cacheDir:'/app-cache',filesDir:'/app-files'})}),
  receipt:label=>JSON.parse(files.get('/cache/heap-probe-'+label+'.json')),
  resolve:()=>resolvePending()};
}

async function main(){
 const source=fs.readFileSync(templatePath,'utf8');
 const compiled=compiler.transpileModule(source,{fileName:'EmulatorHeapProbe.ts',reportDiagnostics:true,
  compilerOptions:{target:compiler.ScriptTarget.ES2021,module:compiler.ModuleKind.CommonJS}});
 assert.equal(compiled.diagnostics.length,0,'SDK syntax transpilation produced diagnostics');
 const make=options=>fixture(compiled.outputText,options),drain=()=>new Promise(setImmediate),passed=[];
 const test=async(name,fn)=>{activeTest=name;await fn();passed.push(name);};
 for(const [name,options] of [['core-enabled',{core:true}],['non-debug',{debug:false}],['ARM ABI',{abi:'arm64-v8a'}]]){
  await test(name+' rejects all capture and filesystem operations',async()=>{const f=make(options);f.request();await drain();assert.equal(f.rawCalls.length,0);assert.equal(f.legacyCalls.length,0);assert.equal(f.files.size,0);});
 }
 await test('invalid labels, GC values, API values and legacy GC=false are rejected',()=>{
  const f=make();for(const request of [['../outside','true'],['before',true],['idle','yes'],['before','false','legacy'],['before','true','fallback'],['before','true',null]])f.request(...request);
  assert.equal(f.rawCalls.length+f.legacyCalls.length,0);assert.equal(f.files.size,0);
 });
 await test('default raw API completes four distinct labels through short writes and refuses duplicates',async()=>{
  const f=make({partial:3});for(const label of ['before','after01','after02','idle']){
   f.request(label,'false');await drain();const r=f.receipt(label);assert.equal(r.state,'completed');assert.equal(r.api,'raw');assert.equal(r.gcMode,'explicit-boolean');assert.equal(r.needGC,false);assert.equal(r.snapshotPath,'/cache/actual.rawheap');assert.equal(r.snapshotSizeBytes,4);assert.deepEqual(f.rawCalls.at(-1),[false,false]);
  }f.request('before');await drain();assert.equal(f.rawCalls.length,4);assert.equal(f.legacyCalls.length,0);
 });
 await test('a pending raw request publishes started and rejects concurrent work without queuing it',async()=>{
  const f=make({pending:true});f.request();f.request('after01');assert.equal(f.rawCalls.length,1);assert.equal(f.receipt('before').state,'started');f.resolve();await drain();assert.equal(f.receipt('before').state,'completed');assert.equal(f.rawCalls.length,1);
 });
 const errors=[
  ['numeric BusinessError',{code:11400106,name:'BusinessError',message:'synthetic-private-error'}],
  ['null',null],['string','synthetic-private-error'],
  ['strict numeric string',{code:'401',name:'TypeError',message:'synthetic-private-error'}],
  ['leading zero and arbitrary name',{code:'01',name:'synthetic-private-name'}],
  ['decimal string',{code:'1.0'}],['exponent string',{code:'1e3'}],['whitespace string',{code:' 401'}],
  ['negative zero string',{code:'-0'}],['unsafe integer string',{code:'9007199254740992'}],
  ['fractional number',{code:1.5}],['boolean code',{code:true}]
 ];
 for(const [name,error] of errors)await test(name+' is sanitized without fallback or retry',async()=>{
  const f=make({error});f.request();await drain();const r=f.receipt('before');assert.equal(r.state,'failed');
  assert.equal(r.errorCode,error?.code===11400106?11400106:error?.code==='401'?401:-1);
  assert.equal(r.errorName,['BusinessError','TypeError'].includes(error?.name)?error.name:'UnknownError');
  assert.equal(r.rawApiAvailable,true);assert.equal(r.legacyApiAvailable,true);assert.equal(f.legacyCalls.length,0);
  assert(!JSON.stringify([...f.files.values()].map(bytes=>bytes.toString())).includes('synthetic-private'));
  assert(!JSON.stringify(f.logs).includes('synthetic-private'));f.request();assert.equal(f.rawCalls.length,1);
 });
 for(const [name,options] of [['unavailable API',{noRaw:true}],['missing file',{noOutput:true}],['empty file',{emptyOutput:true}],['directory output',{directoryOutput:true}]]){
  await test('raw '+name+' cannot report completed or invoke legacy',async()=>{const f=make(options);f.request();await drain();const r=f.receipt('before');assert.equal(r.state,'failed');assert.equal(f.legacyCalls.length,0);if(options.noRaw){assert.equal(r.rawApiAvailable,false);assert.equal(r.errorName,'TypeError');}});
 }
 for(const legacyDir of ['/files','/app-files','/cache','/app-cache'])await test('legacy validates its exact internally named output in '+legacyDir,async()=>{
  const f=make({legacyDir});f.request('before','true','legacy');await drain();const r=f.receipt('before');
  assert.equal(r.state,'completed');assert.equal(r.api,'legacy');assert.equal(r.gcMode,'platform-default');assert.equal(r.needGC,undefined);assert.equal(r.requestedNeedGC,true);assert.equal(r.snapshotPath,legacyDir+'/'+r.snapshotFileBase+'.heapsnapshot');assert(r.snapshotFileBase.length<128);assert.equal(f.legacyCalls.length,1);assert.equal(f.legacyCalls[0][1],false);assert.equal(f.rawCalls.length,0);
 });
 for(const [name,options] of [['unavailable API',{noLegacy:true}],['missing file',{noOutput:true}],['empty file',{emptyOutput:true}],['directory output',{directoryOutput:true}],['stale file',{preexisting:true}],['ambiguous outputs',{ambiguous:true}]]){
  await test('legacy '+name+' remains failed without fallback',async()=>{const f=make(options);f.request('before','true','legacy');await drain();const r=f.receipt('before');assert.equal(r.state,'failed');assert.equal(f.rawCalls.length,0);assert.equal(r.snapshotPath,undefined);if(options.preexisting||options.noLegacy)assert.equal(f.legacyCalls.length,0);});
 }
 await test('receipt write failure prevents capture and emits only a fixed failure event',async()=>{
  const f=make({diskError:true});f.request();await drain();assert.equal(f.rawCalls.length,0);assert.equal(f.legacyCalls.length,0);assert.equal(f.files.size,0);assert(f.logs.some(args=>args[2].startsWith('HEAP_PROBE_RECEIPT_FAILED')));assert(!JSON.stringify(f.logs).includes('synthetic-private'));
 });
 assert.equal(passed.length,33);
 console.log(JSON.stringify({passed:passed.length,failed:0,templateSHA256:crypto.createHash('sha256').update(source).digest('hex'),
  scope:'SDK TypeScript syntax transpilation and actual template VM mocks; no full ArkTS build, device commands, real heap reads or filesystem writes.',tests:passed}));
}
if(compiler)main().catch(error=>{console.error(JSON.stringify({passed:false,errorCode:'HEAP_PROBE_TEMPLATE_TEST_FAILED',test:activeTest,assertion:typeof error.code==='string'&&error.code==='ERR_ASSERTION'?error.code:undefined}));process.exitCode=1;});
