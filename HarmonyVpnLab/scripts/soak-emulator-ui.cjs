'use strict';
// Bounded emulator-only UI exercise. Never starts a VPN or reads node contents.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {parseStat,parseStatus}=require('./measure-device-stability.cjs');
const diagnostic=require('./emulator-failure-detail.cjs');
const root=path.resolve(__dirname,'..'),bundle='com.example.harmonyvpnlab';
const hdc=path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/toolchains/hdc.exe');
const options={};for(let i=2;i<process.argv.length;i+=2){if(!['--target','--minutes','--label','--deadline','--activity','--memory-breakdown-every'].includes(process.argv[i])||!process.argv[i+1]||options[process.argv[i]])throw Error('Invalid soak arguments');options[process.argv[i]]=process.argv[i+1];}
const target=options['--target'],minutes=Number(options['--minutes']),label=options['--label'],deadline=Date.parse(options['--deadline']);
const activity=options['--activity']||'navigation';if(!['navigation','idle','inspection'].includes(activity))throw Error('Invalid soak activity');
const memoryBreakdownEvery=Number(options['--memory-breakdown-every']||'0');
if(!/^(0|[1-9][0-9]*)$/.test(options['--memory-breakdown-every']||'0')||!Number.isInteger(memoryBreakdownEvery)||memoryBreakdownEvery>1000)throw Error('Memory breakdown interval must be 0 or 1..1000');
if(!/^127\.0\.0\.1:15\d{3}$/.test(target||'')||!Number.isInteger(minutes)||minutes<1||minutes>180||!/^[a-z0-9-]{1,64}$/.test(label||'')||!Number.isFinite(deadline)||deadline<=Date.now()+60000)throw Error('Explicit emulator, bounded duration and future deadline required');
const out=path.join(root,'build/phase14-soak',label);fs.mkdirSync(path.dirname(out),{recursive:true});
if(fs.existsSync(out))throw Error('Use a new soak label; existing observations are never overwritten');fs.mkdirSync(out);
const started=Date.now(),mono=performance.now(),end=Math.min(started+minutes*60000,deadline-30000),records=[];
const plannedMillis=end-started,deadlineLimited=plannedMillis<minutes*60000;
let interrupted=false;process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
let activeMode='none',failureContext={stage:'preflight',operation:'validate-preview',mode:'none'};
function context(stage,operation,mode=activeMode){failureContext={stage,operation,mode};return failureContext;}
function budget(){if(interrupted||fs.existsSync(path.join(out,'stop.request')))throw Error('SOAK_STOP_REQUESTED');if(Date.now()>=end||performance.now()-mono>=plannedMillis)throw Error('SOAK_DEADLINE');}
function run(args,timeout=12000){budget();const operation=args[1]==='param'?(args[3]==='const.product.model'?'guest-model':'guest-name'):args[1]==='bm'?'package-info':args[1]==='pidof'?'process-id':args[1]==='hidumper'?'memory-breakdown':args[1]==='cat'&&args[2]?.endsWith('/stat')?'proc-stat':args[1]==='cat'&&args[2]?.endsWith('/status')?'proc-status':'hdc-command';
 const where=context(['param','bm'].includes(args[1])?'preflight':'metrics',operation);
 try{return cp.execFileSync(hdc,['-t',target,...args],{encoding:'utf8',windowsHide:true,timeout:Math.min(timeout,Math.max(1000,end-Date.now())),maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});}
 catch(original){const error=Error('UI_OR_HDC_OPERATION_FAILED');error.failureDetail=diagnostic.command(where,original);throw error;}}
const shell=(...args)=>run(['shell',...args]);
const memoryColumns=['PssTotal','SharedClean','SharedDirty','PrivateClean','PrivateDirty','SwapTotal','SwapPssTotal','HeapSize','HeapAlloc','HeapFree'];
function memoryUnavailable(reason){return{status:'unavailable',reason};}
function parseMemoryBreakdown(raw){
 if(typeof raw!=='string')return memoryUnavailable('unsupported-format');
 const lines=raw.split(/\r?\n/),wanted=new Set(['total','ark ts heap','native heap','.so','.ttf']);let header=-1;
 for(let i=0;i<lines.length;i++){
  const tokens=lines[i].trim().split(/\s+/);
  if(tokens.slice(-10).join('|')===memoryColumns.join('|')){header=i;break;}
  const next=(lines[i+1]||'').trim().split(/\s+/);
  if(tokens.length===10&&next.length===10&&tokens.map((value,index)=>value+next[index]).join('|')===memoryColumns.join('|')){header=i+1;break;}
 }
 if(header<0)return memoryUnavailable('missing-columns');
 const rows=new Map();
 for(const line of lines.slice(header+1)){
  const tokens=line.trim().split(/\s+/);if(tokens.length<11)continue;
  const name=tokens.slice(0,-10).join(' ').toLowerCase();if(!wanted.has(name))continue;
  if(rows.has(name))return memoryUnavailable('ambiguous-rows');
  const values=tokens.slice(-10).map(value=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null);
  rows.set(name,values);
 }
 const value=(name,index)=>rows.get(name)?.[index]??null;
 const sum=(name,indexes)=>{const values=indexes.map(index=>value(name,index));if(!values.every(Number.isFinite))return null;const total=values.reduce((a,b)=>a+b,0);return Number.isSafeInteger(total)?total:null;};
 if(value('total',0)===null)return memoryUnavailable('missing-total');
 return{status:'available',unit:'KiB',totalPssKiB:value('total',0),totalPrivateDirtyKiB:value('total',4),
  arkPssKiB:value('ark ts heap',0),arkPrivateDirtyKiB:value('ark ts heap',4),arkHeapAllocKiB:value('ark ts heap',8),
  nativePssKiB:value('native heap',0),nativePrivateDirtyKiB:value('native heap',4),nativeHeapAllocKiB:value('native heap',8),
  soPssKiB:value('.so',0),soSharedKiB:sum('.so',[1,2]),soRssKiB:sum('.so',[1,2,3,4]),ttfPssKiB:value('.ttf',0)};
}
function collectMemoryBreakdown(pid,execute,remaining){
 if(!Number.isSafeInteger(pid)||pid<1)return memoryUnavailable('invalid-pid');
 const available=remaining();if(!Number.isFinite(available)||available<2500)return memoryUnavailable('insufficient-budget');
 try{return parseMemoryBreakdown(execute(['shell','hidumper','--mem',String(pid)],2000));}
 catch(error){if(['SOAK_DEADLINE','SOAK_STOP_REQUESTED'].includes(error?.message))throw error;return memoryUnavailable('command-failed');}
}
function metrics(){const pidText=shell('pidof',bundle).trim();if(!/^\d+$/.test(pidText))throw Error('UI_PROCESS_MISSING_OR_AMBIGUOUS');const pid=Number(pidText);let stat,status;
 try{stat=parseStat(shell('cat',`/proc/${pid}/stat`),pid);}catch(original){if(['SOAK_DEADLINE','SOAK_STOP_REQUESTED'].includes(original?.message))throw original;const error=Error('UI_PROC_STAT_UNAVAILABLE');error.failureDetail=diagnostic.sanitize(original?.failureDetail)||diagnostic.detail(context('metrics','proc-stat'),'UI_PROC_STAT_UNAVAILABLE');throw error;}
 try{status=parseStatus(shell('cat',`/proc/${pid}/status`),pid);}catch(_){status={rssKiB:null,threads:null};}
 const breakdown=memoryBreakdownEvery>0&&records.length%memoryBreakdownEvery===0?
  {memoryBreakdown:collectMemoryBreakdown(pid,run,()=>Math.min(end-Date.now(),plannedMillis-(performance.now()-mono)))}:{};
 return{pid,startTimeTicks:stat.startTimeTicks,totalTicks:stat.totalTicks,...status,...breakdown};}
function ui(mode){budget();activeMode=mode;const where=context('ui-helper',mode==='Inspect'?'inspect-layout':'navigate');let result;
 try{result=cp.execFileSync(process.execPath,[path.join(__dirname,'test-adaptive-emulator.cjs'),target,mode,label+'-'+mode.toLowerCase(),'phase14'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:Math.min(90000,Math.max(1000,end-Date.now())),maxBuffer:2*1024*1024,env:{...process.env,HARMONY_UI_QA_CAPTURE_IMAGE:'0'},stdio:['ignore','pipe','pipe']});}
 catch(original){const error=Error('UI_OR_HDC_OPERATION_FAILED');error.failureDetail=diagnostic.command(where,original,'HELPER');error.helperFailure=diagnostic.helper(original?.stderr,mode);throw error;}
 context('ui-helper','parse-helper-result');let value;try{const line=result.trim().split(/\r?\n/).findLast(x=>x.startsWith('{'));value=JSON.parse(line||'{}');}catch(_){throw Error('UI_HELPER_RESULT_INVALID');}
 context('ui-helper','validate-helper-result');if(!value?.appBounds||!Array.isArray(value.horizontalOverflow)||value.horizontalOverflow.length)throw Error('UI_LAYOUT_OR_OVERFLOW_FAILURE');
 if(value.target!==target||value.mode!==mode||!/^[a-f0-9]{64}$/.test(value.artifactSHA256||''))throw Error('UI_ARTIFACT_IDENTITY_UNAVAILABLE');
 return{mode,appBounds:value.appBounds,artifactSHA256:value.artifactSHA256};}
function append(record){context('output','append-sample');records.push(record);fs.appendFileSync(path.join(out,'samples.jsonl'),JSON.stringify(record)+'\n');}
function slope(samples){const valid=samples.filter(x=>Number.isFinite(x.rssKiB));if(valid.length<3)return null;const x0=valid[0].elapsedSeconds,ys=valid.map(x=>x.rssKiB/1024),xs=valid.map(x=>(x.elapsedSeconds-x0)/3600),mx=xs.reduce((a,b)=>a+b,0)/xs.length,my=ys.reduce((a,b)=>a+b,0)/ys.length;const denom=xs.reduce((a,x)=>a+(x-mx)**2,0);return denom?xs.reduce((a,x,i)=>a+(x-mx)*(ys[i]-my),0)/denom:null;}
async function pause(){const until=Math.min(end,Date.now()+12000);while(Date.now()<until){budget();await new Promise(r=>setTimeout(r,Math.min(1000,until-Date.now())));}}
async function main(){let outcome='completed',failure=null,failureDetail=null,base,info,artifactSHA256,actionCount=0,uiInspections=0;
 try{if(shell('param','get','const.product.model').trim()!=='emulator'||shell('param','get','const.product.name').trim()!=='emulator')throw Error('UI_PREVIEW_REQUIRED');
   const raw=shell('bm','dump','-n',bundle);info=JSON.parse(raw.slice(raw.indexOf('{')));if(!info.versionName?.endsWith('-ui-preview')||info.applicationInfo?.cpuAbi!=='x86_64')throw Error('UI_PREVIEW_REQUIRED');
   context('preflight','read-installation');const installation=JSON.parse(fs.readFileSync(path.join(root,'build/phase14-emulators','install-'+target.split(':')[1]+'.json'),'utf8'));
   if(installation.target!==target||installation.versionName!==info.versionName||installation.versionCode!==info.versionCode||!/^[a-f0-9]{64}$/.test(installation.sha256||''))throw Error('UI_ARTIFACT_IDENTITY_UNAVAILABLE');
   artifactSHA256=installation.sha256;const home=ui('Home');if(home.artifactSHA256!==artifactSHA256)throw Error('UI_ARTIFACT_CHANGED');
   activeMode='baseline';base=metrics();append({elapsedSeconds:Number(((performance.now()-mono)/1000).toFixed(2)),mode:'baseline',artifactSHA256,...base});let cycle=0;
   const modes=['Nodes','Settings','HomeNetwork','Home','About','Privacy','Editor','Home'];
   while(Date.now()<end&&performance.now()-mono<plannedMillis){budget();const observingOnly=activity==='idle'||end-Date.now()<90000;
     const mode=activity==='idle'?'idle':observingOnly?'observation':activity==='inspection'?'Inspect':modes[cycle%modes.length],action=observingOnly?{mode,artifactSHA256}:ui(mode);
     if(action.artifactSHA256!==artifactSHA256)throw Error('UI_ARTIFACT_CHANGED');
     if(end-Date.now()<4000)break;
     activeMode=mode;const sample=metrics();context('observation','validate-process');if(sample.pid!==base.pid||sample.startTimeTicks!==base.startTimeTicks)throw Error('UI_PROCESS_RESTARTED');
     const record={elapsedSeconds:Number(((performance.now()-mono)/1000).toFixed(2)),...action,...sample};append(record);cycle++;
     if(!observingOnly&&activity==='navigation')actionCount++;
     if(!observingOnly&&activity==='inspection')uiInspections++;
     if(cycle%8===0)console.log(JSON.stringify({progress:true,label,cycle,elapsedSeconds:record.elapsedSeconds,rssMiB:sample.rssKiB===null?null:Number((sample.rssKiB/1024).toFixed(2)),threads:sample.threads}));
     await pause();
   }
 }catch(error){const code=String(error.message||'UNKNOWN');if(code==='SOAK_DEADLINE')outcome=deadlineLimited?'deadline-reached':'completed';else if(code==='SOAK_STOP_REQUESTED')outcome='stopped';else{outcome='failed';failure=['UI_PREVIEW_REQUIRED','UI_ARTIFACT_IDENTITY_UNAVAILABLE','UI_ARTIFACT_CHANGED','UI_PROCESS_MISSING_OR_AMBIGUOUS','UI_PROC_STAT_UNAVAILABLE','UI_LAYOUT_OR_OVERFLOW_FAILURE','UI_PROCESS_RESTARTED','UI_HELPER_RESULT_INVALID'].includes(code)?code:'UI_OR_HDC_OPERATION_FAILED';failureDetail=diagnostic.sanitize(error?.failureDetail)||diagnostic.detail(failureContext,code)||diagnostic.detail(failureContext,'UI_OPERATION_FAILED');const helper=diagnostic.sanitize(error?.helperFailure);if(helper&&helper.mode===failureDetail.mode)failureDetail.helperFailure=helper;}}
 finally{const warm=records.filter(x=>x.elapsedSeconds>=300),last=records.at(-1),observedSeconds=records.length>1?Number((last.elapsedSeconds-records[0].elapsedSeconds).toFixed(2)):0;
   if(outcome==='completed'&&deadlineLimited)outcome='deadline-reached';
   if(outcome==='completed'&&((activity==='navigation'&&actionCount===0)||(activity==='inspection'&&uiInspections===0)||observedSeconds<minutes*60-20))outcome='insufficient-observation';
   const summary={startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),target,label,activity,memoryBreakdownEvery,memoryBreakdownSamples:records.filter(x=>x.memoryBreakdown).length,memoryBreakdownUnavailable:records.filter(x=>x.memoryBreakdown?.status==='unavailable').length,requestedMinutes:minutes,elapsedSeconds:Number(((performance.now()-mono)/1000).toFixed(2)),observedSeconds,hardDeadline:new Date(deadline).toISOString(),deadlineLimited,outcome,failure,failureDetail,version:info?.versionName,versionCode:info?.versionCode,artifactSHA256,samples:records.length,actions:actionCount,uiInspections,sameProcess:failure!=='UI_PROCESS_RESTARTED'&&records.length>1&&records.every(x=>x.pid===base?.pid&&x.startTimeTicks===base?.startTimeTicks),initialRssMiB:base?.rssKiB?base.rssKiB/1024:null,finalRssMiB:last?.rssKiB?last.rssKiB/1024:null,warmRssSlopeMiBPerHour:slope(warm),cpuTicksAdded:last&&base?last.totalTicks-base.totalTicks:null,scope:'UI-only preview navigation, repeated layout inspection or idle process observations; inspection returns Home once, then only invokes Inspect until the final observation window. actions counts navigation and uiInspections counts completed Inspect samples, excluding initial Home. observedSeconds is the measured sample span, distinct from wall duration. Optional memory breakdown retains numeric statistics only. No VPN networking, typing or file-picker acceptance'};fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));if(outcome!=='completed')process.exitCode=1;}
}
module.exports={main,slope,parseMemoryBreakdown,collectMemoryBreakdown};
if(require.main===module)main().catch(()=>{console.error('SOAK_FATAL');process.exitCode=1;});
