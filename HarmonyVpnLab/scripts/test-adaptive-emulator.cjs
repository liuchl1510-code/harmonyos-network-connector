'use strict';
// Explicit emulator UI QA. Synthetic node links only; no private node/backup reads.
// Always target the selected emulator so a USB phone cannot receive these actions.
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const diagnostic=require('./emulator-failure-detail.cjs');
const HDC=path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/toolchains/hdc.exe');
const target=process.argv[2],mode=process.argv[3]||'Inspect',label=process.argv[4]||mode.toLowerCase();
const phase=process.argv[5]||'phase12';
if(!/^127\.0\.0\.1:15[0-9]{3}$/.test(target||'')||!/^[a-zA-Z0-9_-]+$/.test(label))throw Error('Explicit test emulator and safe artifact label required');
if(!['phase12','phase13','phase14','phase15','phase16'].includes(phase)||process.argv.length>6)throw Error('Unknown QA phase or extra arguments');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build',phase+'-emulators'),bundle='com.example.harmonyvpnlab';
fs.mkdirSync(out,{recursive:true});
const remote='/data/local/tmp/harmony-adaptive-'+process.pid+'-'+crypto.randomUUID()+'.json';
const HDC_TIMEOUT_MS=12000,LAYOUT_TIMEOUT_MS=30000,SLOW_LAYOUT_MS=10000;
const uiTiming={layoutDumps:0,slowLayoutDumps:0,maxLayoutDumpMs:0,layoutTimeoutMs:LAYOUT_TIMEOUT_MS};
let failureContext={stage:'preflight',operation:'validate-mode',mode};
function context(stage,operation){failureContext={stage,operation,mode};return failureContext;}
function fail(code,stage,operation){return diagnostic.failure(code,context(stage,operation));}
const run=args=>{let stage='navigation',operation='hdc-command';
 if(args[0]==='install'){stage='install';operation='install-preview';}
 else if(args[0]==='file'){stage=args[1]==='recv'?'capture':'fixture';operation=args[1]==='recv'?'receive-image':'send-fixture';}
 else if(args[1]==='uitest'&&args[2]==='dumpLayout'){stage='snapshot';operation='dump-layout';}
 else if(args[1]==='cat'){stage='snapshot';operation='read-layout';}
 else if(args[1]==='rm'){stage=args[3]?.endsWith('.jpeg')?'capture':'snapshot';operation=stage==='capture'?'cleanup-image':'cleanup-layout';}
 else if(args[1]==='snapshot_display'){stage='capture';operation='capture-image';}
 else if(args[1]==='bm'){stage='preflight';operation='package-info';}
 else if(args[1]==='aa')operation=args[2]==='start'?'start-app':'stop-app';
 else if(args[1]==='uitest'&&args[2]==='uiInput')operation={click:'click-control',swipe:'swipe',inputText:'input-text',keyEvent:'back-key'}[args[3]]||'hdc-command';
 const where=context(stage,operation),isLayout=operation==='dump-layout',began=performance.now();
 try{return cp.execFileSync(HDC,['-t',target,...args],{encoding:'utf8',windowsHide:true,timeout:isLayout?LAYOUT_TIMEOUT_MS:HDC_TIMEOUT_MS,maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});}
 catch(original){const error=Error('UI_OPERATION_FAILED');error.failureDetail=diagnostic.command(where,original);throw error;}
 finally{if(isLayout){const elapsed=Math.max(0,Math.ceil(performance.now()-began));uiTiming.layoutDumps++;if(elapsed>SLOW_LAYOUT_MS)uiTiming.slowLayoutDumps++;uiTiming.maxLayoutDumpMs=Math.max(uiTiming.maxLayoutDumpMs,elapsed);}}};
const shell=(...a)=>run(['shell',...a]),pause=ms=>new Promise(r=>setTimeout(r,ms));
const installationFile=path.join(out,'install-'+target.split(':')[1]+'.json');
const flag=x=>x===true||x==='true';
function snapshot(){let tree,primary;try{shell('uitest','dumpLayout','-p',remote);const raw=shell('cat',remote);try{tree=JSON.parse(raw);}catch(_){throw fail('UI_LAYOUT_JSON_INVALID','snapshot','parse-layout');}}catch(error){primary=error;throw error;}finally{try{shell('rm','-f',remote);}catch(error){if(!primary)throw error;}}
  context('snapshot','parse-layout');const controls=[],scrolls=[],allIds=[];let appBounds,modal=false;
  function visit(n,owned=false,side=false){const a=n.attributes||{};if(a.bundleName)owned=a.bundleName===bundle;side=side||a.id==='appSideNavigation';
    if(flag(a.visible)&&/^Paf\.Permission\./.test(a.id||''))modal=true;
    if(owned&&a.type==='root'&&flag(a.visible))appBounds=a.bounds;
    if(owned&&a.id)allIds.push(a.id);
    if(owned&&flag(a.visible)){if(['UIExtensionComponent','ModalPage','Dialog'].includes(a.type))modal=true;
      if(a.type==='Scroll'&&!side)scrolls.push(a);
      if(a.id)controls.push(a);
      if(['Option','MenuItem'].includes(a.type)&&a.text==='编辑节点')controls.push({...a,id:'qaEditNode'});
    }for(const c of n.children||[])visit(c,owned,side);}
  visit(tree);return{tree,controls,scrolls,allIds,appBounds,modal};
}
function bounds(x){const b=String(x.bounds||x).match(/-?\d+/g)?.map(Number);if(!b||b.length!==4)throw fail('UI_BOUNDS_INVALID','capture','capture-layout');return b;}
async function find(id){for(const direction of [1,-1])for(let i=0;i<6;i++){const s=snapshot();if(s.modal)throw fail('UI_SYSTEM_MODAL','navigation','find-control');const found=s.controls.filter(x=>x.id===id);if(found.length===1)return found[0];if(found.length>1)throw fail('UI_CONTROL_AMBIGUOUS','navigation','find-control');let scroll=s.scrolls.length===1?s.scrolls[0]:undefined;
  if(s.scrolls.length===2&&s.allIds.includes('nodeDetailsPanel')){const list=s.controls.find(x=>x.id==='nodeListContent');if(list){const [left,,right]=bounds(list),center=(left+right)/2;const candidates=s.scrolls.filter(x=>{const [l,,r]=bounds(x);return l<=center&&center<=r});if(candidates.length===1)scroll=candidates[0];}}
  if(!scroll)break;const [l,t,r,b]=bounds(scroll),x=Math.round(l+12),y1=Math.round(t+(b-t)*(direction===1?.78:.22)),y2=Math.round(t+(b-t)*(direction===1?.22:.78));shell('uitest','uiInput','swipe',String(x),String(y1),String(x),String(y2));await pause(100);}throw fail('UI_CONTROL_UNAVAILABLE','navigation','find-control');}
async function click(id){const a=await find(id);if(!flag(a.enabled))throw fail('UI_CONTROL_DISABLED','navigation','click-control');const b=bounds(a);shell('uitest','uiInput','click',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2)));await pause(350);}
async function home(){for(let i=0;i<5;i++){const s=snapshot();if(s.modal)throw fail('UI_SYSTEM_MODAL','navigation','find-control');if(s.controls.some(x=>x.id==='navHome')){await click('navHome');return;}const back=s.controls.find(x=>['backFromNetworkSettings','backFromNodeEditor','backFromNodeBackup','backToProbe','backToNodes','backFromAbout','backFromPrivacy','backFromDiagnosticJournal'].includes(x.id));if(back)await click(back.id);else{shell('aa','start','-a','EntryAbility','-b',bundle);await pause(800);}}throw fail('UI_HOME_UNAVAILABLE','navigation','return-home');}
async function capture(){const s=snapshot();if(!s.appBounds)throw fail('UI_APPLICATION_NOT_VISIBLE','capture','capture-layout');const fixed=new Set(['homePage','homeContent','homeTwoColumns','appSideNavigation','nodeListContent','nodeCount','nodeSearch','navHome','navNodes','navSettings','simulatorPreviewNotice','toggleConnection','previewNodeNotice','testFilteredNodes','openDeveloperTools','scanNode','saveNode','saveNodeEditor','saveNetworkSettings']);
  const secondary=new Set(['appVersion','aboutPage','privacyPage','privacyScope','diagnosticEventCount','diagnosticEmptyState','refreshDiagnosticJournal','backupCurrentCount','backupCurrentSelection','exportNodeCatalog','previewNodeBackup','subscriptionName','subscriptionUrl','previewSubscription','subscriptionEmptyState','homeRoutingSummary','openHomeNetworkSettings','nodeEditorDirtyState','nodeEditorResult','toggleNodeLatencyHelp','routingGlobal','routingRules','bypassLan','routingDirect','routingProxy','routingBlock','dnsUrl','resetDns','networkSettingsResult','networkSettingsDirtyState']);
  const controls=s.controls.filter(x=>fixed.has(x.id)||secondary.has(x.id)||/^backFrom|^backTo|^nodeName-|^appearance-|^nodeMore-|^selectNode-|^testNodeLatency-|^favoriteNode-|^inspectNode-|^filterNode|^filterFavorite|^nodeDetail|^clearNodeFilters|^viewImportedNodes|^importedNodesNotice/.test(x.id||'')).map(x=>({id:/^nodeName-/.test(x.id)?'sampleNodeRow':x.id,type:x.type,bounds:bounds(x),enabled:flag(x.enabled)}));
  const b=bounds(s.appBounds);const overflow=controls.filter(x=>x.bounds[0]<b[0]-2||x.bounds[2]>b[2]+2);
  context('capture','read-installation');const installation=fs.existsSync(installationFile)?JSON.parse(fs.readFileSync(installationFile,'utf8')):undefined;
  const result={target,label,mode,capturedAt:new Date().toISOString(),artifactSHA256:installation?.target===target?installation.sha256:undefined,appBounds:b,sideNavigation:controls.some(x=>x.id==='appSideNavigation'),twoColumns:controls.some(x=>x.id==='homeTwoColumns'),controls,horizontalOverflow:overflow.map(x=>x.id),scope:'UI-only x86_64 emulator build; no VPN network result',uiTiming:{...uiTiming}};
  context('output','write-report');fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify(result,null,2));
  if(process.env.HARMONY_UI_QA_CAPTURE_IMAGE!=='0'){
    const image=remote.slice(0,-5)+'.jpeg';let primary;try{shell('snapshot_display','-f',image);run(['file','recv',image,path.join(out,label+'.jpeg')]);}catch(error){primary=error;throw error;}finally{try{shell('rm','-f',image);}catch(error){if(!primary)throw error;}}
  }
  console.log(JSON.stringify(result));if(overflow.length)throw fail('UI_LAYOUT_OR_OVERFLOW_FAILURE','capture','capture-layout');
}
async function main(){
  if(mode==='Install'){
    const hap=path.join(root,'build/artifacts/simulator-ui/entry-default-signed.hap');
    const bytes=fs.readFileSync(hap);const installed=run(['install','-r',hap]);
    if(!installed.includes('install bundle successfully'))throw fail('UI_INSTALL_FAILED','install','install-preview');
    const raw=shell('bm','dump','-n',bundle),info=JSON.parse(raw.slice(raw.indexOf('{')));
    if(typeof info.versionName!=='string'||!info.versionName.endsWith('-ui-preview'))throw fail('UI_PREVIEW_REQUIRED','install','validate-preview');
    fs.writeFileSync(installationFile,JSON.stringify({target,versionName:info.versionName,versionCode:info.versionCode,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),installedAt:new Date().toISOString()},null,2));
    shell('aa','start','-a','EntryAbility','-b',bundle);await pause(1200);await home();
  }
  else if(mode==='SeedCatalog'){
    await home();await click('navNodes');const count=await find('nodeCount');
    if(count.text!=='共 0 个节点'||snapshot().controls.some(x=>x.id==='nodeManagerResult'&&/失败|损坏/.test(x.text||'')))throw fail('UI_FIXTURE_PRECONDITION_FAILED','fixture','find-control');
    const dest='/data/storage/el2/base/haps/entry/files/node-catalog.json';
    const names=['示例节点 A（仅用于界面验证）','示例节点 B · 较长名称用于检查平板与电脑的换行'];
    const catalog={schemaVersion:1,revision:1,activeNodeId:'qa-node-a',nodes:names.map((name,i)=>({id:'qa-node-'+(i?'b':'a'),name,protocol:'vless',outboundJson:JSON.stringify({protocol:'vless',settings:{vnext:[{address:'192.0.2.'+(i+1),port:443,users:[{id:'00000000-0000-4000-8000-00000000000'+(i+1),encryption:'none'}]}]}}),sourceId:'',modifiedAt:Date.now()})),subscriptions:[]};
    const local=path.join(os.tmpdir(),'harmony-adaptive-synthetic-catalog.json');fs.writeFileSync(local,JSON.stringify(catalog));
    shell('aa','force-stop',bundle);const sent=run(['file','send','-b',bundle,local,dest]);if(!sent.includes('FileTransfer finish'))throw fail('UI_FIXTURE_TRANSFER_FAILED','fixture','send-fixture');shell('aa','start','-a','EntryAbility','-b',bundle);await pause(1200);await click('navNodes');
    if((await find('nodeCount')).text!=='共 2 个节点')throw fail('UI_FIXTURE_NOT_ACCEPTED','fixture','find-control');
  }
  else if(mode==='Home')await home();
  else if(mode==='Nodes'){await home();await click('navNodes');}
  else if(mode==='Settings'){await home();await click('navSettings');}
  else if(mode==='ThemeDark'||mode==='ThemeSystem'){await home();await click('navSettings');await click(mode==='ThemeDark'?'appearance-dark':'appearance-system');}
  else if(mode==='Network'){await home();await click('navSettings');await click('openNetworkSettings');}
  else if(mode==='HomeNetwork'){await home();await click('openHomeNetworkSettings');}
  else if(mode==='NodeHelp'){await home();await click('navNodes');await click('toggleNodeLatencyHelp');}
  else if(['Backup','About','Privacy','Diagnostics'].includes(mode)){await home();await click('navSettings');await click({Backup:'openNodeBackup',About:'openAbout',Privacy:'openPrivacy',Diagnostics:'openSettingsDiagnostics'}[mode]);}
  else if(mode==='Subscriptions'){await home();await click('navNodes');await click('addNodes');await click('manageSubscriptions');}
  else if(mode==='Import'){await home();await click('navNodes');await click('addNodes');await click('importNodes');}
  else if(mode==='SeedSamples'){
    await home();await click('navNodes');const count=await find('nodeCount');if(count.text!=='共 0 个节点')throw fail('UI_FIXTURE_PRECONDITION_FAILED','fixture','find-control');
    await click('addNodes');await click('importNodes');const input=await find('nodeInput'),b=bounds(input);
    const names=['示例节点 A（仅用于界面验证）','示例节点 B · 较长名称用于检查平板与电脑的换行'];
    const links=names.map((n,i)=>`vless://00000000-0000-4000-8000-00000000000${i+1}@192.0.2.${i+1}:443#${encodeURIComponent(n)}`).join('\n');
    shell('uitest','uiInput','inputText',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2)),Buffer.from(links).toString('base64'));
    shell('uitest','uiInput','keyEvent','Back');await pause(250);await click('saveNode');await click('backToProbe');
    if((await find('nodeCount')).text!=='共 2 个节点')throw fail('UI_FIXTURE_NOT_ACCEPTED','fixture','find-control');
  }else if(mode==='Editor'){
    await home();await click('navNodes');let rowId;
    for(let i=0;i<6;i++){
      const s=snapshot();if(s.modal)throw fail('UI_SYSTEM_MODAL','navigation','find-control');rowId=s.allIds.find(id=>/^nodeMore-/.test(id));if(rowId)break;
      if(s.scrolls.length!==1)break;const [l,t,r,b]=bounds(s.scrolls[0]);shell('uitest','uiInput','swipe',String(l+12),String(Math.round(t+(b-t)*.8)),String(l+12),String(Math.round(t+(b-t)*.2)));await pause(250);
    }
    if(!rowId)throw fail('UI_SAMPLE_NODE_UNAVAILABLE','navigation','find-control');await click(rowId);await click('qaEditNode');
  }else if(mode==='Back'){shell('uitest','uiInput','keyEvent','Back');await pause(350);}
  else if(mode!=='Inspect')throw fail('UI_MODE_INVALID','preflight','validate-mode');
  await capture();
}
function reportFailure(error){const failureDetail=diagnostic.sanitize(error?.failureDetail)||diagnostic.detail(failureContext,'UI_OPERATION_FAILED');console.error(JSON.stringify({target,mode:failureDetail.mode,error:'Emulator UI operation failed',errorCode:failureDetail.errorCode,failureDetail,uiTiming:{...uiTiming}}));process.exitCode=1;}
module.exports={main,reportFailure};
if(require.main===module)main().catch(reportFailure);
