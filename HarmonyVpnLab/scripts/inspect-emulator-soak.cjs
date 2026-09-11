'use strict';
// Read-only consistency inspection. This does not authenticate evidence or infer
// process liveness. Only these four fixed files are ever opened.
const fs=require('node:fs'),path=require('node:path'),{isDeepStrictEqual}=require('node:util');
const LIMITS={json:128*1024,samples:16*1024*1024,line:16*1024,count:10000};
const FAILURES=['UI_PREVIEW_REQUIRED','UI_ARTIFACT_IDENTITY_UNAVAILABLE','UI_ARTIFACT_CHANGED','UI_PROCESS_MISSING_OR_AMBIGUOUS','UI_PROC_STAT_UNAVAILABLE','UI_LAYOUT_OR_OVERFLOW_FAILURE','UI_PROCESS_RESTARTED','UI_HELPER_RESULT_INVALID','SOAK_OUTPUT_PERSISTENCE_FAILED','UI_OR_HDC_OPERATION_FAILED'];
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<0.011;
const span=rows=>rows.length>1?Number((rows.at(-1).elapsedSeconds-rows[0].elapsedSeconds).toFixed(2)):0;
function requireThat(condition,code){if(!condition){const error=Error(code);error.inspectionCode=code;throw error;}}
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validateCollector(value){
 const keys=['helperScript','helperSHA256','hdcTimeoutMs','layoutTimeoutMs','helperTimeoutMs','slowLayoutThresholdMs','uiTimingSchemaVersion'];
 requireThat(exactKeys(value,keys)&&/^scripts[\\/]test-adaptive-emulator\.cjs$/.test(value.helperScript)&&hash(value.helperSHA256)&&value.hdcTimeoutMs===12000&&value.layoutTimeoutMs===30000&&value.helperTimeoutMs===90000&&value.slowLayoutThresholdMs===10000&&value.uiTimingSchemaVersion===1,'COLLECTOR_INVALID');
}
function validateUiTiming(value,collector,successful,code){
 const keys=['layoutDumps','slowLayoutDumps','maxLayoutDumpMs','layoutTimeoutMs'];
 requireThat(exactKeys(value,keys)&&keys.every(key=>integer(value[key]))&&value.layoutDumps<=1000&&value.slowLayoutDumps<=value.layoutDumps&&value.maxLayoutDumpMs<=120000&&value.layoutTimeoutMs===collector.layoutTimeoutMs&&(!successful||value.layoutDumps>0)&&(value.layoutDumps>0||(value.slowLayoutDumps===0&&value.maxLayoutDumpMs===0))&&((value.slowLayoutDumps>0)===(value.maxLayoutDumpMs>collector.slowLayoutThresholdMs)),code);
}
function validateSummaryTiming(summary,manifest,rows){
 // Missing fields in pre-timing records remain unverified; never synthesize them.
 const fields=['collector','uiTiming','failedHelperUiTiming'];
 if(!Object.hasOwn(manifest,'collector')){requireThat(fields.every(key=>!Object.hasOwn(summary,key)),'SUMMARY_COLLECTOR_MISMATCH');return;}
 requireThat(fields.every(key=>Object.hasOwn(summary,key))&&isDeepStrictEqual(summary.collector,manifest.collector),'SUMMARY_COLLECTOR_MISMATCH');
 const timings=rows.filter(row=>Object.hasOwn(row,'uiTiming')).map(row=>row.uiTiming);
 const expected=timings.length?{helpersWithTiming:timings.length,layoutDumps:timings.reduce((n,v)=>n+v.layoutDumps,0),slowLayoutDumps:timings.reduce((n,v)=>n+v.slowLayoutDumps,0),maxLayoutDumpMs:Math.max(...timings.map(v=>v.maxLayoutDumpMs)),layoutTimeoutMs:manifest.collector.layoutTimeoutMs}:null;
 requireThat(isDeepStrictEqual(summary.uiTiming,expected),'SUMMARY_UI_TIMING_MISMATCH');
 if(summary.failedHelperUiTiming!==null){
  requireThat(summary.outcome==='failed'&&summary.failureDetail?.stage==='ui-helper','FAILED_HELPER_UI_TIMING_INVALID');
  validateUiTiming(summary.failedHelperUiTiming,manifest.collector,false,'FAILED_HELPER_UI_TIMING_INVALID');
 }
}
function fileSnapshot(directory,name,limit,optional=false,prefixBytes){
 const file=path.join(directory,name);let fd;
 try{
  let stat;try{stat=fs.lstatSync(file);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  requireThat(stat.isFile()&&!stat.isSymbolicLink(),'FILE_NOT_REGULAR');
  fd=fs.openSync(file,'r');stat=fs.fstatSync(fd);
  requireThat(stat.isFile()&&integer(stat.size)&&stat.size<=limit,'FILE_SIZE_LIMIT');
  const length=prefixBytes===undefined?stat.size:prefixBytes;
  requireThat(integer(length)&&length<=stat.size&&length<=limit,'PUBLISHED_PREFIX_TRUNCATED');
  const buffer=Buffer.alloc(length);let offset=0;
  while(offset<length){const count=fs.readSync(fd,buffer,offset,length-offset,offset);requireThat(count>0,'PUBLISHED_PREFIX_TRUNCATED');offset+=count;}
  return{buffer,size:stat.size};
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function jsonFile(directory,name,optional=false){
 const value=fileSnapshot(directory,name,LIMITS.json,optional);if(value===null)return null;
 try{const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value.buffer));requireThat(parsed&&typeof parsed==='object'&&!Array.isArray(parsed),'JSON_OBJECT_REQUIRED');return parsed;}
 catch(error){if(error.inspectionCode)throw error;requireThat(false,'JSON_INVALID');}
}
function validateManifest(m){
 requireThat(m.schemaVersion===1&&m.recordType==='soak-run-manifest','MANIFEST_SCHEMA_UNSUPPORTED');
 if(Object.hasOwn(m,'collector'))validateCollector(m.collector);
 requireThat(typeof m.runId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.runId)&&hash(m.script?.sha256)&&timestamp(m.startedAt),'MANIFEST_IDENTITY_INVALID');
 const r=m.request,p=m.plan;
 requireThat(r&&/^127\.0\.0\.1:15\d{3}$/.test(r.target)&&/^[a-z0-9-]{1,64}$/.test(r.label)&&['phase14','phase15','phase16'].includes(r.phase)&&['idle','navigation','inspection'].includes(r.activity)&&integer(r.minutes)&&r.minutes>=1&&r.minutes<=180&&integer(r.memoryBreakdownEvery)&&r.memoryBreakdownEvery<=1000&&timestamp(r.hardDeadline),'REQUEST_INVALID');
 const expected=Math.min(r.minutes*60000,Date.parse(r.hardDeadline)-30000-Date.parse(m.startedAt));
 requireThat(p&&p.plannedMillis===expected&&expected>0&&p.hardDeadlineReserveMillis===30000&&p.deadlineLimited===(expected<r.minutes*60000)&&timestamp(p.observationEndsAt)&&Date.parse(p.observationEndsAt)===Date.parse(m.startedAt)+expected,'PLAN_MISMATCH');
 requireThat(m.host&&typeof m.host.hostname==='string'&&m.host.hostname.length>0&&integer(m.host.pid)&&m.host.pid>0&&typeof m.host.nodeVersion==='string'&&typeof m.host.platform==='string','HOST_IDENTITY_INVALID');
 requireThat(Array.isArray(r.argv)&&r.argv.length>=8&&r.argv.length<=14&&r.argv.length%2===0,'REQUEST_ARGV_INVALID');
 const args={};for(let i=0;i<r.argv.length;i+=2){const key=r.argv[i],value=r.argv[i+1];requireThat(['--target','--minutes','--label','--deadline','--activity','--memory-breakdown-every','--phase'].includes(key)&&typeof value==='string'&&!Object.hasOwn(args,key),'REQUEST_ARGV_INVALID');args[key]=value;}
 requireThat(args['--target']===r.target&&Number(args['--minutes'])===r.minutes&&args['--label']===r.label&&Date.parse(args['--deadline'])===Date.parse(r.hardDeadline)&&(args['--activity']||'navigation')===r.activity&&(args['--phase']||'phase14')===r.phase&&Number(args['--memory-breakdown-every']||0)===r.memoryBreakdownEvery,'REQUEST_ARGV_MISMATCH');
}
function identity(record,m,type){requireThat(record?.schemaVersion===1&&record.recordType===type&&record.runId===m.runId&&record.scriptSHA256===m.script.sha256&&record.startedAt===m.startedAt,'RECORD_IDENTITY_MISMATCH');}
function parseSamples(buffer,m){
 if(buffer.length===0)return[];
 requireThat(buffer.at(-1)===10,'PUBLISHED_PREFIX_NOT_LINE_ALIGNED');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch(_){requireThat(false,'SAMPLE_UTF8_INVALID');}
 const lines=text.slice(0,-1).split('\n');requireThat(lines.length<=LIMITS.count,'SAMPLE_COUNT_LIMIT');
 const rows=[],modes=m.request.activity==='idle'?['idle']:m.request.activity==='inspection'?['Inspect','observation']:['Nodes','Settings','HomeNetwork','Home','About','Privacy','Editor','observation'];
 for(let i=0;i<lines.length;i++){
  requireThat(Buffer.byteLength(lines[i])<=LIMITS.line,'SAMPLE_LINE_LIMIT');let row;
  try{row=JSON.parse(lines[i]);}catch(_){requireThat(false,'SAMPLE_JSON_INVALID');}
  requireThat(row&&row.runId===m.runId,'SAMPLE_RUN_ID_MISMATCH');requireThat(row.sampleIndex===i,'SAMPLE_SEQUENCE_INVALID');
  requireThat(hash(row.artifactSHA256)&&(!i||row.artifactSHA256===rows[0].artifactSHA256),'SAMPLE_ARTIFACT_MISMATCH');
  requireThat(integer(row.pid)&&row.pid>0&&integer(row.startTimeTicks)&&integer(row.totalTicks)&&(!i||(row.pid===rows[0].pid&&row.startTimeTicks===rows[0].startTimeTicks&&row.totalTicks>=rows[i-1].totalTicks)),'SAMPLE_PROCESS_MISMATCH');
  requireThat(Number.isFinite(row.elapsedSeconds)&&row.elapsedSeconds>=0&&(!i||row.elapsedSeconds>=rows[i-1].elapsedSeconds)&&timestamp(row.hostObservedAt)&&Date.parse(row.hostObservedAt)>=Date.parse(m.startedAt),'SAMPLE_TIME_INVALID');
  requireThat(i===0?row.mode==='baseline':modes.includes(row.mode),'SAMPLE_MODE_INVALID');
  if(Object.hasOwn(row,'uiTiming')){
   requireThat(Object.hasOwn(m,'collector')&&!['idle','observation'].includes(row.mode),'SAMPLE_UI_TIMING_INVALID');
   validateUiTiming(row.uiTiming,m.collector,true,'SAMPLE_UI_TIMING_INVALID');
  }
  const memoryExpected=m.request.memoryBreakdownEvery>0&&i%m.request.memoryBreakdownEvery===0;
  requireThat(Object.hasOwn(row,'memoryBreakdown')===memoryExpected&&(!memoryExpected||['available','unavailable'].includes(row.memoryBreakdown?.status)),'SAMPLE_MEMORY_SCHEDULE_MISMATCH');rows.push(row);
 }
 return rows;
}
function inspectRun(directory){
 const result={schemaVersion:1,recordType:'soak-inspection',status:'invalid',completionConfirmed:false,issues:[]};
 try{
  const m=jsonFile(directory,'run-manifest.json',true);
  if(m===null){result.status='unsupported-legacy';result.issues=['MANIFEST_MISSING_NO_RETROACTIVE_RECOVERY'];return result;}
  validateManifest(m);const c=jsonFile(directory,'checkpoint.json'),s=jsonFile(directory,'summary.json',true);
  identity(c,m,'soak-run-checkpoint');
  requireThat(c.completionClaim===false&&c.state==='last-observed'&&!Object.hasOwn(c,'outcome')&&!Object.hasOwn(c,'finishedAt')&&c.sampleFile==='samples.jsonl'&&integer(c.samples)&&c.samples<=LIMITS.count&&integer(c.sampleBytes)&&timestamp(c.updatedAt),'CHECKPOINT_INVALID');
  if(s!==null)identity(s,m,'soak-run-summary');
  const publishedBytes=s===null?c.sampleBytes:s.sampleBytes;
  requireThat(integer(publishedBytes)&&publishedBytes<=LIMITS.samples&&c.sampleBytes<=publishedBytes,'PUBLISHED_BYTES_INVALID');
  const data=fileSnapshot(directory,'samples.jsonl',LIMITS.samples,true,publishedBytes);
  requireThat(data!==null||publishedBytes===0,'SAMPLES_MISSING');const buffer=data?.buffer||Buffer.alloc(0),rows=parseSamples(buffer,m);
  const checkpointRows=parseSamples(buffer.subarray(0,c.sampleBytes),m);
  requireThat(checkpointRows.length===c.samples&&isDeepStrictEqual(c.lastObserved,checkpointRows.at(-1)||null)&&near(c.observedSeconds,span(checkpointRows)),'CHECKPOINT_PREFIX_MISMATCH');
  requireThat(!checkpointRows.length||Date.parse(c.updatedAt)>=Date.parse(checkpointRows.at(-1).hostObservedAt),'CHECKPOINT_TIME_INVALID');
  result.samples=rows.length;result.publishedSampleBytes=publishedBytes;result.unpublishedTailBytes=(data?.size||0)-publishedBytes;result.observedSeconds=span(rows);result.startedAt=m.startedAt;
  if(rows.length)result.artifactSHA256=rows[0].artifactSHA256;
  if(s===null){result.status='completion-unconfirmed';result.issues=['SUMMARY_MISSING_COMPLETION_UNCONFIRMED'];return result;}
  const r=m.request;
  requireThat(s.finalization==='orderly'&&['completed','failed','stopped','deadline-reached','insufficient-observation'].includes(s.outcome),'SUMMARY_OUTCOME_INVALID');
  validateSummaryTiming(s,m,rows);
  requireThat(s.target===r.target&&s.label===r.label&&s.phase===r.phase&&s.activity===r.activity&&s.memoryBreakdownEvery===r.memoryBreakdownEvery&&s.requestedMinutes===r.minutes&&s.hardDeadline===r.hardDeadline&&s.deadlineLimited===m.plan.deadlineLimited,'SUMMARY_REQUEST_MISMATCH');
  requireThat(s.samples===rows.length&&near(s.observedSeconds,span(rows))&&Number.isFinite(s.elapsedSeconds)&&s.elapsedSeconds>=0&&(!rows.length||s.elapsedSeconds>=rows.at(-1).elapsedSeconds)&&timestamp(s.finishedAt)&&Date.parse(s.finishedAt)>=Date.parse(m.startedAt)&&(!rows.length||Date.parse(s.finishedAt)>=Date.parse(rows.at(-1).hostObservedAt)),'SUMMARY_OBSERVATION_MISMATCH');
  requireThat(!rows.length||(s.artifactSHA256===rows[0].artifactSHA256&&typeof s.version==='string'&&s.version.endsWith('-ui-preview')&&integer(s.versionCode)),'SUMMARY_ARTIFACT_MISMATCH');
  const actions=r.activity==='navigation'?rows.slice(1).filter(row=>row.mode!=='observation').length:0,inspections=rows.filter(row=>row.mode==='Inspect').length;
  requireThat(integer(s.actions)&&integer(s.uiInspections)&&s.actions<=actions&&s.uiInspections<=inspections&&(s.outcome==='failed'||(s.actions===actions&&s.uiInspections===inspections)),'SUMMARY_ACTION_COUNT_MISMATCH');
  requireThat(s.memoryBreakdownSamples===rows.filter(row=>row.memoryBreakdown).length&&s.memoryBreakdownUnavailable===rows.filter(row=>row.memoryBreakdown?.status==='unavailable').length,'SUMMARY_MEMORY_COUNT_MISMATCH');
  requireThat(s.sameProcess===(s.failure!=='UI_PROCESS_RESTARTED'&&rows.length>1),'SUMMARY_PROCESS_MISMATCH');
  if(s.outcome==='completed'){
   requireThat(s.failure===null&&s.failureDetail===null&&s.stopReason===null&&s.deadlineLimited===false&&rows.length>1&&s.sameProcess===true&&span(rows)>=r.minutes*60-20&&(r.activity!=='navigation'||actions>0)&&(r.activity!=='inspection'||inspections>0)&&s.elapsedSeconds>=m.plan.plannedMillis/1000-0.02,'COMPLETION_EVIDENCE_INSUFFICIENT');
   requireThat(c.sampleBytes===publishedBytes&&c.samples===rows.length&&result.unpublishedTailBytes===0,'COMPLETED_PUBLICATION_MISMATCH');
  }else if(s.outcome==='failed'){requireThat(FAILURES.includes(s.failure),'FAILED_OUTCOME_WITHOUT_FAILURE');}
  else{requireThat(s.failure===null&&s.failureDetail===null,'NONFAILED_OUTCOME_HAS_FAILURE');}
  if(s.outcome==='stopped')requireThat(['SIGINT','SIGTERM','stop.request'].includes(s.stopReason),'STOP_REASON_INVALID');
  if(s.outcome==='deadline-reached')requireThat(s.deadlineLimited===true,'DEADLINE_OUTCOME_INVALID');
  if(s.outcome==='insufficient-observation')requireThat(!s.deadlineLimited&&(span(rows)<r.minutes*60-20||(r.activity==='navigation'&&actions===0)||(r.activity==='inspection'&&inspections===0)),'INSUFFICIENT_OUTCOME_INVALID');
  result.status='finalized';result.completionConfirmed=s.outcome==='completed';result.outcome=s.outcome;result.finishedAt=s.finishedAt;return result;
 }catch(error){result.status='invalid';result.completionConfirmed=false;result.issues=[error.inspectionCode||'READ_FAILED'];delete result.outcome;return result;}
}
module.exports={inspectRun,LIMITS};
if(require.main===module){
 if(process.argv.length!==4||process.argv[2]!=='--run-dir'){console.log(JSON.stringify({schemaVersion:1,recordType:'soak-inspection',status:'invalid',completionConfirmed:false,issues:['USAGE_EXPECTED_RUN_DIR']}));process.exitCode=2;}
 else{const report=inspectRun(path.resolve(process.argv[3]));console.log(JSON.stringify(report));process.exitCode=report.status==='finalized'&&report.outcome==='completed'?0:1;}
}
