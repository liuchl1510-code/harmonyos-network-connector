'use strict';
// Execute the actual workflow using only in-memory files, a synthetic UI tree,
// virtual time and intercepted HDC/helper commands. No device/build writes.
const assert=require('node:assert/strict'),path=require('node:path');
const {runWorkflow,parseArgs,failureCode,defaultNetwork,REVISION}=require('./test-emulator-form-workflows.cjs');
const {sample}=require('./test-emulator-fixtures.cjs');
const TARGET='127.0.0.1:15558',SHA='a'.repeat(64),START=Date.parse('2026-09-09T17:00:00Z'),BUNDLE='com.example.harmonyvpnlab';
const SCENARIOS={editor:{field:'editNodePort',initial:'443',save:'saveNodeEditor',result:'nodeEditorResult',back:'backFromNodeEditor',title:'放弃未保存的修改？',discard:'放弃修改',error:'端口应为 1–65535 的整数。',mode:'Editor'},
 network:{field:'dnsUrl',initial:'https://1.1.1.1/dns-query',save:'saveNetworkSettings',result:'networkSettingsResult',back:'backFromNetworkSettings',title:'放弃未保存的设置？',discard:'放弃修改',error:'DNS 地址需包含 HTTPS 域名或 IPv4 地址及路径，不支持账号、片段或 IPv6 地址。',mode:'Network'},
 import:{field:'nodeInput',initial:'',save:'saveNode',result:'nodeSaveResult',back:'backToProbe',title:'放弃未保存的内容？',discard:'放弃修改',error:'订阅内容的 Base64 编码或 UTF-8 文本无效。',mode:'Import'},
 subscription:{field:'subscriptionUrl',initial:'',save:'previewSubscription',result:'subscriptionResult',back:'backToNodes',title:'放弃未保存的订阅内容？',discard:'放弃并返回',error:'订阅地址无效，请使用不含账号和片段的 HTTPS 链接（最多 4096 字符）',mode:'Subscriptions'}};
function fixture(which='editor',options={}){
 const scenario=SCENARIOS[which],root=path.resolve('C:/synthetic-workflow-project'),tempRoot=path.resolve('C:/synthetic-workflow-temp');
 const files=new Map(),dirs=new Set(),fds=new Map(),state={clock:0,nextFd:1,commands:[],helper:0,keys:0,selectAll:0,typedKeys:0,treeReads:0,focusMissing:options.focusMissingSnapshots||0,saveClicks:0,backClicks:0,discards:0,screenshots:0,removed:[],cleaned:0,dialog:false,returned:false,focus:'',inputs:{[scenario.field]:options.draft===undefined?scenario.initial:options.draft},message:options.preexistingFeedback?scenario.error:'',installHash:SHA};
 if(which==='subscription')state.inputs.subscriptionName=options.nameDraft||'';
 const nodes=[1,2].map(i=>({id:i===1?'qa-node-a':'qa-node-b',name:i===1?'示例节点 A（仅用于界面验证）':'示例节点 B · 较长名称用于检查平板与电脑的换行',protocol:'vless',outboundJson:sample(i).outboundJson,sourceId:'',modifiedAt:0}));
 if(options.realNode)nodes[0].outboundJson=JSON.stringify({protocol:'vless',settings:{vnext:[{address:'private.example.com',port:443,users:[{id:'00000000-0000-4000-8000-000000000099',encryption:'none'}]}]}});
 const catalog=Buffer.from(JSON.stringify({schemaVersion:1,revision:1,activeNodeId:'qa-node-a',nodes,subscriptions:[]}));
 const norm=p=>path.resolve(String(p));const installation=path.join(root,'build/phase14-emulators/install-15558.json');
 function install(){return JSON.stringify({target:options.badTarget?'127.0.0.1:15559':TARGET,versionName:'0.14.0-ui-preview',versionCode:options.badCode?34:35,sha256:options.badHash?'not-a-hash':state.installHash});}
 files.set(installation,Buffer.from(install()));
 const io={existsSync(p){p=norm(p);if(p.endsWith('stop.request')&&options.stopAt!==undefined&&state.clock>=options.stopAt)return true;if(options.existingOutput&&p.includes('phase14-ui-actions'))return true;return files.has(p)||dirs.has(p);},
  mkdirSync(p){dirs.add(norm(p));},mkdtempSync(p){const result=norm(p+'owned');dirs.add(result);return result;},
  openSync(p){p=norm(p);if(!files.has(p))throw Error('synthetic-private-missing');const fd=state.nextFd++;fds.set(fd,p);return fd;},
  readSync(fd,buffer,offset,length,position){const value=files.get(fds.get(fd));const n=Math.min(length,value.length-position,options.shortRead?7:length);if(n<=0)return 0;value.copy(buffer,offset,position,position+n);return n;},
  closeSync(fd){fds.delete(fd);},writeFileSync(p,value){if(options.reportWriteFailure&&String(p).endsWith('result.json'))throw Error('synthetic-private-storage');files.set(norm(p),Buffer.from(value));},
  statSync:p=>({size:files.get(norm(p)).length}),unlinkSync:p=>files.delete(norm(p)),rmSync(p){p=norm(p);assert.equal(path.dirname(p),tempRoot);for(const key of files.keys())if(key.startsWith(p+path.sep))files.delete(key);dirs.delete(p);state.cleaned++;}};
 const attr=(type,id,text,bounds='[100,200][700,250]',extra={})=>({attributes:{bundleName:BUNDLE,type,id,text,bounds,visible:'true',enabled:'true',...extra},children:[]});
 function tree(){
  state.treeReads++;
  const app=attr('root','appRoot','','[0,0][1200,1000]');if(state.returned)return app;
  const initialHidden=state.treeReads<=(options.initialMissingSnapshots||0);
  const focusHidden=state.keys>0&&(options.focusNeverAppears||state.focusMissing>0);
  if(state.keys>0&&state.focusMissing>0)state.focusMissing--;
  if(state.keys>0&&options.draftChangesOnFocus)state.inputs[scenario.field]='8443';
  const order=which==='subscription'?['subscriptionName',scenario.field]:[scenario.field];
  for(const id of order){if(id===scenario.field&&(initialHidden||focusHidden))continue;const text=id==='subscriptionUrl'?'*'.repeat(state.inputs[id].length):state.inputs[id];app.children.push(attr('TextInput',id,text,id==='subscriptionName'?'[100,100][700,150]':'[100,200][700,250]',{focused:state.focus===id?'true':'false',enabled:options.disabledField||(options.disabledDuringFocus&&state.keys>0)?'false':'true'}));}
  if(options.duplicateDuringFocus&&state.keys>0)app.children.push(attr('TextInput',scenario.field,state.inputs[scenario.field]));
  app.children.push(attr('Scroll','formScroll','','[100,100][1000,600]'));
  app.children.push(attr('Button',scenario.save,'save',options.badBounds?'[0,0][9000,10]':'[100,400][300,450]',{enabled:options.disabledSave?false:'true'}));
  if(options.duplicateSave)app.children.push(attr('Button',scenario.save,'save','[400,400][600,450]'));
  app.children.push(attr('Button',scenario.back,'back','[10,10][90,50]'));
  app.children.push(attr('Text',scenario.result,state.message,'[100,500][1000,600]'));
  // This decoy is not inside the owned dialog and must never be chosen.
  if(options.decoyChoice)app.children.push(attr('Text','decoy','继续编辑','[10,800][100,850]'));
  if(state.dialog){const dialog=attr('AlertDialog','dialog',scenario.title+' message','[200,620][900,800]');
   dialog.children.push(attr('Text','stay','继续编辑','[300,700][450,750]'));dialog.children.push(attr('Text','discard',scenario.discard,'[500,700][650,750]'));
   if(options.duplicateDialogChoice)dialog.children.push(attr('Text','stay2','继续编辑','[700,700][850,750]'));app.children.push(dialog);}
  if(options.consent)app.children.push(attr('Text','Paf.Permission.consent','synthetic-private-consent','[100,100][900,900]'));
  return app;
 }
 const command=(exe,args,settings)=>{
  assert(settings.windowsHide);assert(settings.timeout>0&&settings.timeout<=90000);assert.deepEqual(settings.stdio,['ignore','pipe','pipe']);state.commands.push(args);state.clock+=10;
  if(args[0]==='-t'){
   assert.equal(args[1],TARGET);const a=args.slice(2);
   if(a[0]==='shell'){
    if(a[1]==='param')return options.guestMismatch?'not-emulator':a[3]==='const.product.cpu.abilist'?'x86_64':'emulator';
    if(a[1]==='bm')return JSON.stringify({versionName:options.release?'0.14.0':'0.14.0-ui-preview',versionCode:35,applicationInfo:{cpuAbi:options.arm?'arm64-v8a':'x86_64'}});
    if(a[1]==='rm'){state.removed.push(...a.slice(3));return '';}
    if(a[1]==='uitest'&&a[2]==='dumpLayout'){if(options.dumpFailure)throw Error('synthetic-private-layout');return '';}
    if(a[1]==='cat')return options.invalidTree?'synthetic-private-invalid-json':JSON.stringify(tree());
    if(a[1]==='snapshot_display'){state.screenshots++;return 'success';}
    if(a[1]==='uitest'&&a[2]==='uiInput'){
     if(a[3]==='keyEvent'){
      state.keys++;if(options.swapAfterKeys&&state.keys===2){state.installHash='b'.repeat(64);files.set(installation,Buffer.from(install()));}
      const key=a[4],order=which==='subscription'?['subscriptionName',scenario.field]:[scenario.field];
      if(key==='2049'){state.focus=order[(order.indexOf(state.focus)+1)%order.length];return '';}
      if(key==='2072'){state.selectAll++;if(!options.ignoreSelectAll)state.inputs[state.focus]='';return '';}
      if(key==='Back'){state.dialog=true;return '';}
      state.typedKeys++;const code=Number(key),character=code<=2009?String(code-2000):String.fromCharCode(97+code-2017);state.inputs[state.focus]+=options.wrongInput?'x':character;return '';
     }
     if(a[3]==='click'){
      const x=Number(a[4]),y=Number(a[5]);
      if(x===200&&y===425){state.saveClicks++;state.message=options.wrongFeedback?'旧操作成功信息':scenario.error;return '';}
      if(x===50&&y===30){state.backClicks++;state.dialog=true;return '';}
      if(x===375&&y===725){state.dialog=false;return '';}
      if(x===575&&y===725){state.discards++;state.dialog=false;state.returned=true;return '';}
      throw Error('Unexpected or decoy click');
     }
     if(a[3]==='swipe')return '';
    }
    throw Error('Unexpected shell operation');
   }
   assert.equal(a[0],'file');assert.equal(a[1],'recv','Workflow must not send/save files');
   if(a[2]==='-b'){
    const name=path.posix.basename(a[4]),local=norm(a[5]);if(options.transferFailure)throw Object.assign(Error('synthetic-private-transfer'),{stderr:'transport failed'});
    if(name==='node-catalog.json')files.set(local,catalog);
    else if(name==='network-policy.json'){if(options.privateNetwork)files.set(local,Buffer.from(JSON.stringify({schemaVersion:1,mode:'rules',bypassLan:false,direct:['private.example.com'],proxy:[],block:[],dnsUrl:'https://1.1.1.1/dns-query'})));else return 'No such file';}
    else throw Error('Unexpected sandbox read');return 'FileTransfer finish';
   }
   if(options.captureTransferFailure)return 'Transfer failed';files.set(norm(a[3]),Buffer.from('synthetic-jpeg'));return 'FileTransfer finish';
  }
  state.helper++;assert.equal(settings.env.HARMONY_UI_QA_CAPTURE_IMAGE,'0');assert.equal(args[1],TARGET);assert.equal(args[2],scenario.mode);assert(args[3].startsWith('pc-form-safe3-'));
  if(options.helperDeadline)state.clock+=180000;
  const projection={target:TARGET,mode:scenario.mode,label:args[3],artifactSHA256:options.badProjection?'b'.repeat(64):SHA};
  files.set(path.join(root,'build/phase14-emulators',args[3]+'.json'),Buffer.from(JSON.stringify(projection)));
  if(options.artifactSwap){state.installHash='b'.repeat(64);files.set(installation,Buffer.from(install()));}
  return 'helper complete';
 };
 return{state,files,fds,run:()=>runWorkflow({target:TARGET,which,'--label':'synthetic-safe3',...(options.deadline?{'--deadline':new Date(START+options.deadline).toISOString()}: {})},
  {fs:io,execFileSync:command,root,tempRoot,now:()=>state.clock,wall:()=>START+state.clock,sleep:async ms=>{state.clock+=ms;},stopped:()=>options.signalStop&&state.keys>0}),report:()=>JSON.parse(files.get(path.join(root,'build/phase14-ui-actions/synthetic-safe3/result.json')))};
}
const passed=[];async function test(name,body){await body();passed.push(name);}
(async()=>{
 await test('CLI accepts only explicit emulator/case and bounded label/deadline options',()=>{assert.equal(parseArgs([TARGET,'editor']).which,'editor');for(const args of [['USB','editor'],[TARGET,'unknown'],[TARGET,'editor','--label','../x'],[TARGET,'editor','--deadline','invalid'],[TARGET,'editor','--x','1']])assert.throws(()=>parseArgs(args));});
 for(const which of Object.keys(SCENARIOS))await test(which+' guarded workflow completes its real script steps using invalid synthetic input',async()=>{const f=fixture(which,{decoyChoice:true,shortRead:true}),r=await f.run();assert.equal(r.passed,true);assert.equal(r.steps.length,which==='subscription'?7:6);assert.equal(r.scriptRevision,REVISION);assert.equal(r.artifactSHA256,SHA);assert.equal(f.state.saveClicks,1);assert.equal(f.state.discards,1);assert.equal(f.state.screenshots,2);assert.equal(f.state.cleaned,1);assert.equal(f.fds.size,0);assert(f.state.removed.every(p=>p.startsWith('/data/local/tmp/harmony-form-safe3-')));});
 for(const option of ['guestMismatch','release','arm','badTarget','badCode','badHash'])await test(option+' blocks any helper, keyboard and screenshot before action',async()=>{const f=fixture('editor',{[option]:true}),r=await f.run();assert.equal(r.passed,false);assert.equal(f.state.helper,0);assert.equal(f.state.keys,0);assert.equal(f.state.screenshots,0);});
 await test('non-synthetic node catalog is refused and received bytes are removed',async()=>{const f=fixture('editor',{realNode:true}),r=await f.run();assert.equal(r.error,'SYNTHETIC_CATALOG_REQUIRED');assert.equal(f.state.helper,0);assert.equal(f.state.cleaned,1);assert(!JSON.stringify(r).includes('private.example.com'));});
 await test('personal network preferences are not opened or overwritten',async()=>{const f=fixture('network',{privateNetwork:true}),r=await f.run();assert.equal(r.error,'DEFAULT_NETWORK_REQUIRED');assert.equal(f.state.helper,0);assert.equal(f.state.keys,0);assert.equal(f.state.cleaned,1);});
 for(const option of ['badProjection','artifactSwap'])await test(option+' cannot attribute workflow to a stale same-version SHA',async()=>{const f=fixture('editor',{[option]:true}),r=await f.run();assert.equal(r.error,'ARTIFACT_CHANGED');assert.equal(f.state.keys,0);assert.equal(f.state.screenshots,0);});
 await test('candidate swap after typing is caught before any save click',async()=>{const f=fixture('editor',{swapAfterKeys:true}),r=await f.run();assert.equal(r.error,'ARTIFACT_CHANGED');assert.equal(f.state.saveClicks,0);assert.equal(f.state.screenshots,0);assert(/^[a-f0-9]{64}$/.test(r.scriptSHA256));});
 await test('initial target can appear after bounded scrolling without replacing an unseen draft',async()=>{const f=fixture('editor',{initialMissingSnapshots:2}),r=await f.run();assert.equal(r.passed,true);assert.equal(r.steps.length,6);assert(f.state.commands.some(a=>a.includes('swipe')));});
 await test('Tab transition may temporarily hide target before it becomes uniquely focused',async()=>{const f=fixture('editor',{focusMissingSnapshots:3}),r=await f.run();assert.equal(r.passed,true);assert.equal(r.steps.length,6);assert.equal(f.state.selectAll,1);});
 await test('target that never appears during focus is refused without input or save',async()=>{const f=fixture('editor',{focusNeverAppears:true}),r=await f.run();assert.equal(r.error,'FOCUS_NOT_REACHED');assert.equal(f.state.selectAll,0);assert.equal(f.state.typedKeys,0);assert.equal(f.state.saveClicks,0);assert(f.state.keys<=60);});
 for(const [option,error] of [['disabledDuringFocus','CONTROL_DISABLED'],['duplicateDuringFocus','FIELD_UNAVAILABLE']])await test(option+' remains an immediate refusal during transition',async()=>{const f=fixture('editor',{[option]:true}),r=await f.run();assert.equal(r.error,error);assert.equal(f.state.selectAll,0);assert.equal(f.state.typedKeys,0);assert.equal(f.state.saveClicks,0);});
 await test('draft changing while focus moves is preserved before select-all',async()=>{const f=fixture('editor',{draftChangesOnFocus:true}),r=await f.run();assert.equal(r.error,'DRAFT_NOT_EMPTY');assert.equal(f.state.inputs.editNodePort,'8443');assert.equal(f.state.selectAll,0);assert.equal(f.state.saveClicks,0);});
 await test('sandbox I/O failure is distinguished from a non-synthetic catalog',async()=>{const f=fixture('editor',{transferFailure:true}),r=await f.run();assert.equal(r.error,'TRANSFER_FAILED');assert.equal(f.state.helper,0);assert.equal(f.state.keys,0);});
 await test('preexisting unsaved port draft is not selected or overwritten',async()=>{const f=fixture('editor',{draft:'8443'}),r=await f.run();assert.equal(r.error,'DRAFT_NOT_EMPTY');assert.equal(f.state.keys,0);assert.equal(f.state.saveClicks,0);});
 await test('preexisting subscription name is not overwritten',async()=>{const f=fixture('subscription',{nameDraft:'existing'}),r=await f.run();assert.equal(r.error,'DRAFT_NOT_EMPTY');assert.equal(f.state.keys,0);});
 for(const which of ['import','subscription'])await test(which+' nonempty unrelated feedback cannot pass invalid-input acceptance',async()=>{const f=fixture(which,{wrongFeedback:true}),r=await f.run();assert.equal(r.error,'FEEDBACK_MISMATCH');assert(!r.steps.some(s=>s.step==='invalid-input-feedback'));assert.equal(f.state.screenshots,0);});
 await test('old exact feedback is not counted as a newly observed validation result',async()=>{const f=fixture('import',{preexistingFeedback:true}),r=await f.run();assert.equal(r.error,'PREEXISTING_FEEDBACK');assert.equal(f.state.saveClicks,0);});
 for(const option of ['wrongInput','ignoreSelectAll'])await test(option+' is detected before clicking save',async()=>{const f=fixture('editor',{[option]:true}),r=await f.run();assert.equal(r.error,'INPUT_MISMATCH');assert.equal(f.state.saveClicks,0);});
 for(const option of ['disabledSave','duplicateSave','badBounds'])await test(option+' prevents an unsafe save click',async()=>{const f=fixture('editor',{[option]:true}),r=await f.run();assert.equal(r.passed,false);assert.equal(f.state.saveClicks,0);});
 await test('duplicate owned dialog choice is refused rather than choosing an arbitrary text',async()=>{const f=fixture('editor',{duplicateDialogChoice:true}),r=await f.run();assert.equal(r.error,'DIALOG_CHOICE_MISSING');assert.equal(f.state.discards,0);});
 await test('input method consent cannot be accepted by the keyboard workflow',async()=>{const f=fixture('editor',{consent:true}),r=await f.run();assert.equal(r.error,'INPUT_METHOD_CONSENT');assert.equal(f.state.keys,0);assert.equal(f.state.screenshots,0);});
 for(const option of ['dumpFailure','invalidTree','transferFailure'])await test(option+' emits no raw private-looking text and cleans temporary files',async()=>{const f=fixture('editor',{[option]:true}),r=await f.run();assert.equal(r.passed,false);assert(!JSON.stringify(r).includes('synthetic-private'));assert.equal(f.state.cleaned,1);if(option!=='transferFailure')assert(f.state.removed.some(p=>p.endsWith('.json')));});
 await test('failed screenshot transfer cannot produce a passed workflow record',async()=>{const f=fixture('editor',{captureTransferFailure:true}),r=await f.run();assert.equal(r.error,'TRANSFER_FAILED');assert.equal(r.passed,false);assert(f.state.removed.some(p=>p.endsWith('.jpeg')));});
 await test('global deadline after helper is reported without subsequent typing',async()=>{const f=fixture('editor',{helperDeadline:true}),r=await f.run();assert.equal(r.outcome,'deadline-reached');assert.equal(f.state.keys,0);assert.equal(f.state.cleaned,1);});
 await test('too-near explicit global deadline rejects immediately',async()=>{const f=fixture('editor',{deadline:5000});await assert.rejects(f.run(),e=>failureCode(e)==='WORKFLOW_DEADLINE');assert.equal(f.state.commands.length,0);});
 for(const option of [{stopAt:500},{signalStop:true}])await test('stop or signal records incomplete steps without discarding the draft',async()=>{const f=fixture('editor',option),r=await f.run();assert.equal(r.outcome,'stopped');assert.equal(r.passed,false);assert.equal(f.state.discards,0);assert.equal(f.state.cleaned,1);});
 await test('existing run directory is never overwritten',async()=>{const f=fixture('editor',{existingOutput:true}),r=await f.run();assert.equal(r.error,'OUTPUT_EXISTS');assert.equal(f.state.commands.length,0);});
 await test('secondary report-storage failure exposes a fixed code only',async()=>{const f=fixture('editor',{reportWriteFailure:true});await assert.rejects(f.run(),error=>failureCode(error)==='FILE_INVALID');});
 await test('unknown errors and forged code fields are never a diagnostic output channel',()=>{assert.equal(failureCode(Object.assign(Error('synthetic-private'),{code:'SYNTHETIC_CATALOG_REQUIRED'})),'HDC_OR_UI_FAILURE');assert(defaultNetwork(null));assert(!defaultNetwork(Buffer.from('{"private":"synthetic-private"}')));});
 console.log(JSON.stringify({passed:passed.length,failed:0,scriptRevision:REVISION,scope:'Actual guarded script with synthetic in-memory files/UI and simulated commands/time; no device or old QA artifact changes.',tests:passed}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
