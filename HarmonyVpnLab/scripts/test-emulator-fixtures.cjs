'use strict';
// Emulator-only synthetic fixtures. A write-ahead journal makes partial restores retryable.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const {loadNodeParser}=require('./node-import-loader.cjs');
const parseNode=loadNodeParser(),root=path.resolve(__dirname,'..'),bundle='com.example.harmonyvpnlab';
const hdc=path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/toolchains/hdc.exe');
const names=['示例节点 A（仅用于界面验证）','示例节点 B · 较长名称用于检查平板与电脑的换行'];
const emptyHistory=Buffer.from('{"schemaVersion":1,"results":[]}');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const exactKeys=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
function sample(i){return parseNode(JSON.stringify({protocol:'vless',settings:{vnext:[{address:'192.0.2.'+((i-1)%250+1),port:443,users:[{id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),encryption:'none'}]}]}}));}
function historyBytes(nodes){return Buffer.from(JSON.stringify({schemaVersion:1,results:nodes.map((n,i)=>({nodeId:n.id,outboundFingerprint:sha(Buffer.from(n.outboundJson)),runId:'qa-history-'+i,checkedAt:0,status:'passed',durationMs:500-i,reason:''}))}));}
function safeCatalog(c,large){try{
 if(!exactKeys(c,['schemaVersion','revision','activeNodeId','nodes','subscriptions'])||c.schemaVersion!==1||!Number.isSafeInteger(c.revision)||c.revision<0||!Array.isArray(c.nodes)||!Array.isArray(c.subscriptions)||c.subscriptions.length||c.nodes.length!==(large?500:2)||!c.nodes.some(n=>n.id===c.activeNodeId))return false;
 return c.nodes.every((n,index)=>{const i=index+1;return exactKeys(n,['id','name','protocol','outboundJson','sourceId','modifiedAt'])&&n.id===(large?'qa-load-'+String(i).padStart(3,'0'):'qa-node-'+(i===1?'a':'b'))&&n.sourceId===''&&n.protocol==='vless'&&Number.isSafeInteger(n.modifiedAt)&&n.modifiedAt>=0&&n.name===(large?`界面性能样例 ${String(i).padStart(3,'0')}（合成数据）`:names[index])&&parseNode(n.outboundJson).outboundJson===sample(i).outboundJson;});
 }catch(_){return false;}}
function safeEmptyHistory(bytes){if(bytes===null)return true;try{const v=JSON.parse(bytes);return exactKeys(v,['schemaVersion','results'])&&v.schemaVersion===1&&Array.isArray(v.results)&&v.results.length===0;}catch(_){return false;}}
function sameOrPendingPrefix(actual,expected,pending){return actual!==null&&(actual.equals(expected)||(pending&&actual.length<expected.length&&actual.equals(expected.subarray(0,actual.length))));}
function main(target,mode){
 if(!/^127\.0\.0\.1:15\d{3}$/.test(target||'')||!['seed500','restore'].includes(mode))throw Error('FIXTURE_ARGUMENTS_INVALID');
 const out=path.join(root,'build/phase14-fixtures',target.split(':')[1]);let ascii,stopped=false,manifest;
 const run=args=>cp.execFileSync(hdc,['-t',target,...args],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:8e6,stdio:['ignore','pipe','pipe']});
 const shell=(...args)=>run(['shell',...args]),dest=name=>'/data/storage/el2/base/haps/entry/files/'+name;
 function get(name,optional=false){
  const local=path.join(ascii,name);if(fs.existsSync(local))fs.unlinkSync(local);let response;
  try{response=run(['file','recv','-b',bundle,dest(name),local]);}catch(error){const diagnostic=String(error.stdout||'')+String(error.stderr||'');if(optional&&/no such file|does not exist|not exist/i.test(diagnostic))return null;throw Error('FIXTURE_READ_FAILED');}
  if(!response.includes('FileTransfer finish')||!fs.existsSync(local)){if(optional&&/no such file|does not exist|not exist/i.test(response))return null;throw Error('FIXTURE_READ_FAILED');}
  if(fs.statSync(local).size>4*1024*1024)throw Error('FIXTURE_READ_TOO_LARGE');return fs.readFileSync(local);
 }
 function journal(){const temporary=path.join(out,'manifest.pending.json');fs.writeFileSync(temporary,JSON.stringify(manifest,null,2));fs.renameSync(temporary,path.join(out,'manifest.json'));}
 function put(name,bytes){
  manifest.pendingFile=name;manifest.pendingSHA256=sha(bytes);journal();const local=path.join(ascii,name);fs.writeFileSync(local,bytes);
  if(!run(['file','send','-b',bundle,local,dest(name)]).includes('FileTransfer finish'))throw Error('FIXTURE_WRITE_FAILED');
  if(!get(name).equals(bytes))throw Error('FIXTURE_READBACK_MISMATCH');manifest.pendingFile='';manifest.pendingSHA256='';journal();
 }
 function allowedRemote(bytes,originals,name){return originals.some(expected=>expected===null?bytes===null:sameOrPendingPrefix(bytes,expected,manifest.pendingFile===name&&manifest.pendingSHA256===sha(expected)));}
 try{
  if(shell('param','get','const.product.model').trim()!=='emulator'||shell('param','get','const.product.name').trim()!=='emulator')throw Error('FIXTURE_EMULATOR_REQUIRED');
  const raw=shell('bm','dump','-n',bundle),info=JSON.parse(raw.slice(raw.indexOf('{')));if(!info.versionName?.endsWith('-ui-preview')||info.applicationInfo?.cpuAbi!=='x86_64')throw Error('FIXTURE_PREVIEW_REQUIRED');
  fs.mkdirSync(out,{recursive:true});ascii=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-fixture-'));
  // Stop the only application writer before checking either file. Refusal still resumes the preview.
  shell('aa','force-stop',bundle);stopped=true;
  const currentBytes=get('node-catalog.json'),currentHistory=get('node-latency.json',true),backup=path.join(out,'original-catalog.json'),oldHistoryPath=path.join(out,'original-latency.json');
  if(mode==='seed500'){
   if(!safeCatalog(JSON.parse(currentBytes),false)||JSON.parse(currentBytes).revision>=Number.MAX_SAFE_INTEGER)throw Error('FIXTURE_CATALOG_NOT_SYNTHETIC');if(!safeEmptyHistory(currentHistory))throw Error('FIXTURE_HISTORY_NOT_EMPTY');
   if(fs.existsSync(backup)||fs.existsSync(path.join(out,'manifest.json')))throw Error('FIXTURE_BACKUP_ALREADY_EXISTS');
   const nodes=Array.from({length:500},(_,index)=>{const i=index+1,node=sample(i);return{id:'qa-load-'+String(i).padStart(3,'0'),name:`界面性能样例 ${String(i).padStart(3,'0')}（合成数据）`,protocol:node.protocol,outboundJson:node.outboundJson,sourceId:'',modifiedAt:0};});
   const catalog=Buffer.from(JSON.stringify({schemaVersion:1,revision:JSON.parse(currentBytes).revision+1,activeNodeId:nodes[0].id,nodes,subscriptions:[]}));
   const history=historyBytes(nodes);
   fs.writeFileSync(backup,currentBytes,{flag:'wx'});if(currentHistory!==null)fs.writeFileSync(oldHistoryPath,currentHistory,{flag:'wx'});
   fs.writeFileSync(path.join(out,'large-catalog.json'),catalog,{flag:'wx'});fs.writeFileSync(path.join(out,'synthetic-history.json'),history,{flag:'wx'});
   manifest={schemaVersion:2,target,version:info.versionName,versionCode:info.versionCode,originalSHA256:sha(currentBytes),originalLatencySHA256:currentHistory===null?null:sha(currentHistory),largeSHA256:sha(catalog),historySHA256:sha(history),nodes:500,historyIsSynthetic:true,networkRequests:0,state:'seeding',pendingFile:'',pendingSHA256:''};
   journal();put('node-catalog.json',catalog);put('node-latency.json',history);manifest.state='seeded';journal();
  }else{
   manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
   const original=fs.readFileSync(backup),large=fs.readFileSync(path.join(out,'large-catalog.json')),history=fs.readFileSync(path.join(out,'synthetic-history.json')),oldHistory=fs.existsSync(oldHistoryPath)?fs.readFileSync(oldHistoryPath):null;
   if(manifest.target!==target||manifest.nodes!==500||manifest.historyIsSynthetic!==true||manifest.networkRequests!==0||sha(original)!==manifest.originalSHA256||sha(large)!==manifest.largeSHA256||sha(history)!==manifest.historySHA256||!safeCatalog(JSON.parse(original),false)||!safeCatalog(JSON.parse(large),true)||!history.equals(historyBytes(JSON.parse(large).nodes))||!safeEmptyHistory(oldHistory))throw Error('FIXTURE_BACKUP_NOT_VERIFIED');
   if(manifest.schemaVersion===undefined){
    // Legacy manifests were written only after both seed transfers completed.
    // Accept only that exact schema and individually verified known current bytes.
    if(!exactKeys(manifest,['target','version','originalSHA256','largeSHA256','historySHA256','nodes','historyIsSynthetic','networkRequests'])||![original,large].some(b=>currentBytes.equals(b))||![oldHistory,emptyHistory,history].some(b=>b===null?currentHistory===null:currentHistory?.equals(b)))throw Error('FIXTURE_LEGACY_STATE_NOT_VERIFIED');
    manifest={...manifest,schemaVersion:2,originalLatencySHA256:oldHistory===null?null:sha(oldHistory),state:'seeded',pendingFile:'',pendingSHA256:'',upgradedFromLegacy:true};
   }else if(manifest.schemaVersion!==2||manifest.originalLatencySHA256!==(oldHistory===null?null:sha(oldHistory))||!['seeding','seeded','restoring','restored'].includes(manifest.state)||!['','node-catalog.json','node-latency.json'].includes(manifest.pendingFile))throw Error('FIXTURE_MANIFEST_INVALID');
   if(!allowedRemote(currentBytes,[original,large],'node-catalog.json')||!allowedRemote(currentHistory,[oldHistory,emptyHistory,history],'node-latency.json'))throw Error('FIXTURE_CURRENT_DATA_CHANGED');
   manifest.state='restoring';journal();if(!currentBytes.equals(original))put('node-catalog.json',original);
   const restoredHistory=oldHistory||emptyHistory;if(!currentHistory?.equals(restoredHistory))put('node-latency.json',restoredHistory);
   manifest.state='restored';manifest.pendingFile='';manifest.pendingSHA256='';journal();
   fs.writeFileSync(path.join(out,'restored.json'),JSON.stringify({target,at:new Date().toISOString(),originalSHA256:sha(original),nodes:2,historyRestoredAsEmpty:oldHistory===null,networkRequests:0},null,2));
  }
  shell('aa','start','-a','EntryAbility','-b',bundle);stopped=false;const result={target,mode,nodes:mode==='seed500'?500:2,readbackVerified:true,historyIsSynthetic:true,networkRequests:0};console.log(JSON.stringify(result));return result;
 }finally{
  if(stopped){try{shell('aa','start','-a','EntryAbility','-b',bundle);}catch(_){}}
  // Delete received bytes even when a nonfixture catalog was refused.
  if(ascii&&path.dirname(path.resolve(ascii))===path.resolve(os.tmpdir()))fs.rmSync(ascii,{recursive:true,force:true});
 }
}
module.exports={main,sample,safeCatalog,safeEmptyHistory,sameOrPendingPrefix};
if(require.main===module){try{if(process.argv.length!==4)throw Error('FIXTURE_ARGUMENTS_INVALID');main(process.argv[2],process.argv[3]);}catch(_){console.error('FIXTURE_OPERATION_FAILED; original backups and transfer journal are preserved for a verified restore retry.');process.exitCode=1;}}
