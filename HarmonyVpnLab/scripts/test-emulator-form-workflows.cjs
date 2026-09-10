'use strict';
// Guarded revision: old 25-step evidence predates these extra checks and is not rewritten.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {safeCatalog}=require('./test-emulator-fixtures.cjs');
const REVISION='2026-09-09-safety-v3',TOTAL_MS=180000,MAX_METADATA=4*1024*1024;
const SCRIPT_SHA256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const DEFAULT_DNS='https://1.1.1.1/dns-query';
const CASES={editor:{mode:'Editor',field:'editNodePort',initial:'443',value:'70000',save:'saveNodeEditor',result:'nodeEditorResult',errors:['端口应为 1–65535 的整数。'],back:'backFromNodeEditor',title:'放弃未保存的修改？',discard:'放弃修改'},
 network:{mode:'Network',field:'dnsUrl',initial:DEFAULT_DNS,value:'bad',save:'saveNetworkSettings',result:'networkSettingsResult',errors:['DNS 地址需为有效的 HTTPS URL。','DNS 地址需包含 HTTPS 域名或 IPv4 地址及路径，不支持账号、片段或 IPv6 地址。'],back:'backFromNetworkSettings',title:'放弃未保存的设置？',discard:'放弃修改'},
 import:{mode:'Import',field:'nodeInput',initial:'',value:'bad',save:'saveNode',result:'nodeSaveResult',errors:['订阅内容的 Base64 编码或 UTF-8 文本无效。'],back:'backToProbe',title:'放弃未保存的内容？',discard:'放弃修改'},
 subscription:{mode:'Subscriptions',field:'subscriptionUrl',initial:'',value:'bad',save:'previewSubscription',result:'subscriptionResult',errors:['订阅地址无效，请使用不含账号和片段的 HTTPS 链接（最多 4096 字符）'],back:'backToNodes',title:'放弃未保存的订阅内容？',discard:'放弃并返回'}};
const CODES=new Set(['ARGUMENTS_INVALID','EMULATOR_REQUIRED','PREVIEW_REQUIRED','ARTIFACT_INVALID','ARTIFACT_CHANGED','OUTPUT_EXISTS','SYNTHETIC_CATALOG_REQUIRED','DEFAULT_NETWORK_REQUIRED','DRAFT_NOT_EMPTY','PREEXISTING_FEEDBACK','FEEDBACK_MISMATCH','INPUT_MISMATCH','INPUT_METHOD_CONSENT','UNEXPECTED_DIALOG','FIELD_UNAVAILABLE','CONTROL_DISABLED','CONTROL_NOT_FOUND','BOUNDS_INVALID','SCROLL_UNAVAILABLE','FOCUS_NOT_REACHED','DIALOG_CHOICE_MISSING','RETURN_NOT_CONFIRMED','TREE_INVALID','TRANSFER_FAILED','FILE_INVALID','STOP_REQUESTED','WORKFLOW_DEADLINE','HDC_OR_UI_FAILURE']);
class WorkflowError extends Error{constructor(code){super(CODES.has(code)?code:'HDC_OR_UI_FAILURE');this.code=this.message;}}
const fail=code=>{throw new WorkflowError(code);};
const failureCode=error=>error instanceof WorkflowError?error.code:'HDC_OR_UI_FAILURE';
const flag=value=>value===true||value==='true';
function parseArgs(args){
 if(args.length<2||!/^127\.0\.0\.1:15\d{3}$/.test(args[0]||'')||!Object.hasOwn(CASES,args[1]))fail('ARGUMENTS_INVALID');
 const result={target:args[0],which:args[1]};
 for(let i=2;i<args.length;i+=2){const key=args[i];if(!['--label','--deadline'].includes(key)||!args[i+1]||result[key])fail('ARGUMENTS_INVALID');result[key]=args[i+1];}
 if(result['--label']&&!/^[a-z0-9-]{1,64}$/.test(result['--label']))fail('ARGUMENTS_INVALID');
 if(result['--deadline']&&!Number.isFinite(Date.parse(result['--deadline'])))fail('ARGUMENTS_INVALID');
 return result;
}
function defaultNetwork(bytes){
 if(bytes===null)return true;
 try{const p=JSON.parse(bytes);const keys=['schemaVersion','mode','bypassLan','direct','proxy','block','dnsUrl'];
 return p&&Object.keys(p).length===keys.length&&Object.keys(p).every(k=>keys.includes(k))&&p.schemaVersion===1&&p.mode==='global'&&p.bypassLan===false&&p.dnsUrl===DEFAULT_DNS&&[p.direct,p.proxy,p.block].every(x=>Array.isArray(x)&&x.length===0);
 }catch(_){return false;}
}
async function runWorkflow(options,adapters={}){
 const argv=[options.target,options.which];for(const key of ['--label','--deadline'])if(options[key])argv.push(key,options[key]);options=parseArgs(argv);
 const io=adapters.fs||fs,command=adapters.execFileSync||cp.execFileSync,now=adapters.now||(()=>performance.now()),wall=adapters.wall||(()=>Date.now()),sleep=adapters.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
 const root=adapters.root||path.resolve(__dirname,'..'),tempRoot=adapters.tempRoot||os.tmpdir(),bundle='com.example.harmonyvpnlab',c=CASES[options.which];
 const started=wall(),mono=now(),hardDeadline=Math.min(started+TOTAL_MS,options['--deadline']?Date.parse(options['--deadline']):Infinity);
 const available=hardDeadline-started;if(available<10000)fail('WORKFLOW_DEADLINE');
 // Reserve cleanup time inside the total/global deadline.
 const deadline=mono+available-8000,label=options['--label']||options.which+'-safe3-'+started;
 const out=path.join(root,'build/phase14-ui-actions',label),stopFile=path.join(out,'stop.request');
 const qaLabel='pc-form-safe3-'+options.which+'-'+started,qaDir=path.join(root,'build/phase14-emulators'),projection=path.join(qaDir,qaLabel+'.json');
 const installationFile=path.join(qaDir,'install-'+options.target.split(':')[1]+'.json');
 const hdc=path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/toolchains/hdc.exe');
 const remoteBase='/data/local/tmp/harmony-form-safe3-'+process.pid+'-'+started,remoteAx=remoteBase+'.json',remoteImage=remoteBase+'.jpeg';
 const steps=[];let candidate,temp,created=false,outcome,problem;
 function check(){if(adapters.stopped?.()||io.existsSync(stopFile))fail('STOP_REQUESTED');if(now()>=deadline||wall()>=hardDeadline-8000)fail('WORKFLOW_DEADLINE');}
 function timeout(max){check();return Math.max(1,Math.min(max,Math.floor(deadline-now()),Math.floor(hardDeadline-8000-wall())));}
 function run(args,cleanup=false){return command(hdc,['-t',options.target,...args],{encoding:'utf8',windowsHide:true,timeout:cleanup?2000:timeout(12000),maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});}
 const shell=(...args)=>run(['shell',...args]);
 async function pause(ms){check();await sleep(Math.min(ms,timeout(ms)));check();}
 function readBytes(file,limit=MAX_METADATA){
  const fd=io.openSync(file,'r');try{const bytes=Buffer.alloc(limit+1);let count=0;
   while(count<bytes.length){const read=io.readSync(fd,bytes,count,bytes.length-count,count);if(!Number.isSafeInteger(read)||read<0||read>bytes.length-count)fail('FILE_INVALID');if(!read)break;count+=read;}
   if(count===0||count>limit)fail('FILE_INVALID');return bytes.subarray(0,count);
  }finally{io.closeSync(fd);}
 }
 function installation(){let data;try{data=JSON.parse(readBytes(installationFile,65536));}catch(_){fail('ARTIFACT_INVALID');}
  if(data.target!==options.target||typeof data.versionName!=='string'||data.versionName.length>64||!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?-ui-preview$/.test(data.versionName)||!Number.isSafeInteger(data.versionCode)||data.versionCode<1||!/^[a-f0-9]{64}$/i.test(data.sha256||''))fail('ARTIFACT_INVALID');
  return{target:data.target,versionName:data.versionName,versionCode:data.versionCode,sha256:data.sha256.toLowerCase()};
 }
 function sameCandidate(){
  check();const record=installation(),raw=shell('bm','dump','-n',bundle);let info;try{info=JSON.parse(raw.slice(raw.indexOf('{')));}catch(_){fail('PREVIEW_REQUIRED');}
  if(info.applicationInfo?.cpuAbi!=='x86_64'||info.versionName!==record.versionName||info.versionCode!==record.versionCode)fail('ARTIFACT_CHANGED');
  if(candidate&&(record.target!==candidate.target||record.sha256!==candidate.sha256||record.versionName!==candidate.versionName||record.versionCode!==candidate.versionCode))fail('ARTIFACT_CHANGED');
  return record;
 }
 function receive(name,optional=false){
  const local=path.join(temp,name);if(io.existsSync(local))io.unlinkSync(local);let response;
  try{response=run(['file','recv','-b',bundle,'/data/storage/el2/base/haps/entry/files/'+name,local]);}
  catch(error){const detail=String(error.stdout||'')+String(error.stderr||'');if(optional&&/no such file|does not exist|not exist/i.test(detail))return null;fail('TRANSFER_FAILED');}
  if(!response.includes('FileTransfer finish')||!io.existsSync(local)){if(optional&&/no such file|does not exist|not exist/i.test(response))return null;fail('TRANSFER_FAILED');}
  return readBytes(local);
 }
 function snapshot(){let tree;
  try{shell('uitest','dumpLayout','-p',remoteAx);tree=JSON.parse(shell('cat',remoteAx));}
  finally{run(['shell','rm','-f',remoteAx],true);}
  const items=[],queue=[{node:tree,owner:'',dialog:null}];let seen=0,appBounds;
  while(queue.length){if(++seen>20000)fail('TREE_INVALID');const {node,owner:parent,dialog:prior}=queue.pop();if(!node||typeof node!=='object')fail('TREE_INVALID');
   const a=node.attributes||{},owner=a.bundleName||parent,dialog=a.type==='AlertDialog'?a:prior;
   if(flag(a.visible)){
    if(a.id?.startsWith('Paf.Permission.'))fail('INPUT_METHOD_CONSENT');
    if(owner!==bundle&&['AlertDialog','Dialog','ModalPage','UIExtensionComponent'].includes(a.type))fail('UNEXPECTED_DIALOG');
    if(owner===bundle){items.push({...a,dialog});if(a.type==='root')appBounds=a.bounds;}
   }
   const children=node.children||[];if(!Array.isArray(children)||queue.length+children.length>20000)fail('TREE_INVALID');for(let i=children.length-1;i>=0;i--)queue.push({node:children[i],owner,dialog});
  }
  return{items,appBounds};
 }
 function bounds(value){const b=String(value?.bounds||value||'').match(/-?\d+/g)?.map(Number);if(!b||b.length!==4||b.some(x=>!Number.isSafeInteger(x))||b[2]<=b[0]||b[3]<=b[1])fail('BOUNDS_INVALID');return b;}
 function field(id,s=snapshot()){const found=s.items.filter(a=>a.id===id);if(found.length!==1)fail('FIELD_UNAVAILABLE');return found[0];}
 async function click(a,s=snapshot()){
  sameCandidate();if(!flag(a.enabled))fail('CONTROL_DISABLED');const b=bounds(a),app=bounds(s.appBounds);
  if(b[0]<app[0]||b[1]<app[1]||b[2]>app[2]||b[3]>app[3])fail('BOUNDS_INVALID');
  shell('uitest','uiInput','click',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2)));await pause(300);
 }
 async function find(id){for(let i=0;i<10;i++){const s=snapshot();if(s.items.some(a=>a.type==='AlertDialog'))fail('UNEXPECTED_DIALOG');const matches=s.items.filter(a=>a.id===id);if(matches.length>1)fail('FIELD_UNAVAILABLE');if(matches.length===1)return matches[0];
  const scroll=s.items.filter(a=>a.type==='Scroll'&&a.id!=='appSideNavigation');if(scroll.length!==1)fail('SCROLL_UNAVAILABLE');const b=bounds(scroll[0]);shell('uitest','uiInput','swipe',String(b[0]+12),String(Math.round(b[1]+(b[3]-b[1])*.8)),String(b[0]+12),String(Math.round(b[1]+(b[3]-b[1])*.2)));await pause(100);}
  fail('CONTROL_NOT_FOUND');
 }
 async function focus(id){for(let i=0;i<60;i++){sameCandidate();const s=snapshot();if(s.items.some(a=>a.type==='AlertDialog'))fail('UNEXPECTED_DIALOG');
  // Tab can scroll/rebuild the form before the target becomes visible. Missing
  // during this bounded transition is different from an ambiguous/disabled field.
  const matches=s.items.filter(a=>a.id===id);if(matches.length>1)fail('FIELD_UNAVAILABLE');
  if(matches.length===1){const a=matches[0];if(!flag(a.enabled))fail('CONTROL_DISABLED');if(flag(a.focused))return a;}
  shell('uitest','uiInput','keyEvent','2049');await pause(50);}fail('FOCUS_NOT_REACHED');}
 function assertInput(id,text){const actual=field(id).text;if(id==='subscriptionUrl'){
  if(!/^[*•●]+$/.test(actual||'')||actual.length!==text.length)fail('INPUT_MISMATCH');
 }else if(actual!==text)fail('INPUT_MISMATCH');}
 async function type(id,text,initial){if(!/^[a-z0-9]{1,8}$/.test(text))fail('ARGUMENTS_INVALID');const active=await focus(id);
  // This is the unique, enabled, focused target from the final focus snapshot;
  // never select/replace another draft merely because it passed an earlier read.
  if(!flag(active.focused)||!flag(active.enabled))fail('FOCUS_NOT_REACHED');if(active.text!==initial)fail('DRAFT_NOT_EMPTY');
  shell('uitest','uiInput','keyEvent','2072','2017');
  for(const ch of text)shell('uitest','uiInput','keyEvent',String(/[0-9]/.test(ch)?2000+Number(ch):2017+ch.charCodeAt(0)-97));await pause(id==='subscriptionUrl'?1500:250);assertInput(id,text);steps.push({step:'keyboard-input',id,expected:text,masked:id==='subscriptionUrl',passed:true});}
 function draft(){assertInput(c.field,c.value);}
 function dialog(s=snapshot()){const found=s.items.filter(a=>a.type==='AlertDialog'&&typeof a.text==='string'&&a.text.startsWith(c.title));if(found.length!==1)fail('DIALOG_CHOICE_MISSING');return found[0].dialog;}
 async function dialogChoice(text){const s=snapshot(),owned=dialog(s),matches=s.items.filter(a=>a.dialog===owned&&a.type==='Text'&&a.text===text);if(matches.length!==1)fail('DIALOG_CHOICE_MISSING');await click(matches[0],s);}
 async function capture(label){sameCandidate();snapshot();const local=path.join(out,label+'.jpeg');
  try{shell('snapshot_display','-f',remoteImage);const response=run(['file','recv',remoteImage,local]);if(!response.includes('FileTransfer finish')||!io.existsSync(local)||io.statSync(local).size<1)fail('TRANSFER_FAILED');}
  finally{run(['shell','rm','-f',remoteImage],true);}
 }
 try{
  if(io.existsSync(out)||io.existsSync(projection)||io.existsSync(path.join(qaDir,qaLabel+'.jpeg')))fail('OUTPUT_EXISTS');
  if(shell('param','get','const.product.model').trim()!=='emulator'||shell('param','get','const.product.name').trim()!=='emulator'||shell('param','get','const.product.cpu.abilist').trim()!=='x86_64')fail('EMULATOR_REQUIRED');
  candidate=sameCandidate();temp=io.mkdtempSync(path.join(tempRoot,'harmony-form-safe3-'));
  const catalogBytes=receive('node-catalog.json');
  let catalog;try{catalog=JSON.parse(catalogBytes);}catch(_){fail('SYNTHETIC_CATALOG_REQUIRED');}
  const checkCatalog=adapters.safeCatalog||safeCatalog;if(!checkCatalog(catalog,false)&&!checkCatalog(catalog,true))fail('SYNTHETIC_CATALOG_REQUIRED');
  if(options.which==='network'&&!defaultNetwork(receive('network-policy.json',true)))fail('DEFAULT_NETWORK_REQUIRED');
  io.mkdirSync(out,{recursive:true});created=true;
  command(process.execPath,[path.join(__dirname,'test-adaptive-emulator.cjs'),options.target,c.mode,qaLabel,'phase14'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:timeout(90000),maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,HARMONY_UI_QA_CAPTURE_IMAGE:'0'}});
  sameCandidate();const projected=JSON.parse(readBytes(projection,65536));if(projected.target!==options.target||projected.mode!==c.mode||projected.label!==qaLabel||projected.artifactSHA256!==candidate.sha256)fail('ARTIFACT_CHANGED');
  const initial=await find(c.field);if(initial.text!==c.initial)fail('DRAFT_NOT_EMPTY');
  if(options.which==='subscription'&&(await find('subscriptionName')).text!=='')fail('DRAFT_NOT_EMPTY');
  if(options.which==='subscription')await type('subscriptionName','draft','');await type(c.field,c.value,c.initial);
  if(snapshot().items.some(a=>a.id===c.result&&c.errors.includes(a.text)))fail('PREEXISTING_FEEDBACK');
  await click(await find(c.save));const result=await find(c.result);if(!c.errors.includes(result.text))fail('FEEDBACK_MISMATCH');draft();steps.push({step:'invalid-input-feedback',passed:true});await capture('validation-feedback');
  await click(await find(c.back));draft();dialog();await capture('discard-confirmation');steps.push({step:'native-confirmation-keeps-draft',passed:true});
  await dialogChoice('继续编辑');draft();steps.push({step:'cancel-keeps-draft',passed:true});
  sameCandidate();shell('uitest','uiInput','keyEvent','Back');await pause(300);draft();dialog();steps.push({step:'system-back-confirmation',passed:true});
  await dialogChoice(c.discard);if(snapshot().items.some(a=>a.id===c.back))fail('RETURN_NOT_CONFIRMED');steps.push({step:'explicit-discard-returns',passed:true});
  sameCandidate();outcome='passed';
 }catch(error){problem=failureCode(error);outcome=problem==='STOP_REQUESTED'?'stopped':problem==='WORKFLOW_DEADLINE'?'deadline-reached':'failed';}
 finally{
  if(temp){try{run(['shell','rm','-f',remoteAx,remoteImage],true);}catch(_){if(!problem){problem='HDC_OR_UI_FAILURE';outcome='failed';}}
   try{if(path.dirname(path.resolve(temp))!==path.resolve(tempRoot))fail('FILE_INVALID');io.rmSync(temp,{recursive:true,force:true});}catch(_){if(!problem){problem='FILE_INVALID';outcome='failed';}}}
 }
 const report={schemaVersion:2,scriptRevision:REVISION,scriptSHA256:SCRIPT_SHA256,recordedAt:new Date(wall()).toISOString(),startedAt:new Date(started).toISOString(),target:options.target,case:options.which,label,
  version:candidate?.versionName,versionCode:candidate?.versionCode,artifactSHA256:candidate?.sha256,passed:outcome==='passed',outcome,steps,error:problem,
  totalTimeoutMs:TOTAL_MS,hardDeadline:new Date(hardDeadline).toISOString(),elapsedMs:Math.round(now()-mono),stopMarker:path.relative(root,stopFile),record:created?path.relative(root,path.join(out,'result.json')):undefined,
  scope:'Revised native keyboard and owned discard-dialog workflow after exact synthetic-catalog/default-network guards; intentionally invalid input, no valid configuration save or VPN test. Earlier 25-step evidence predates this revision.'};
 if(created){try{io.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));}catch(_){fail('FILE_INVALID');}}
 return report;
}
module.exports={parseArgs,runWorkflow,failureCode,WorkflowError,defaultNetwork,CASES,REVISION};
if(require.main===module){let stopped=false;process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
 Promise.resolve().then(()=>runWorkflow(parseArgs(process.argv.slice(2)),{stopped:()=>stopped})).then(result=>{console.log(JSON.stringify({case:result.case,label:result.label,scriptRevision:result.scriptRevision,passed:result.passed,outcome:result.outcome,steps:result.steps.length,artifactSHA256:result.artifactSHA256,error:result.error,record:result.record}));if(!result.passed)process.exitCode=1;}).catch(error=>{console.error(failureCode(error));process.exitCode=1;});}
