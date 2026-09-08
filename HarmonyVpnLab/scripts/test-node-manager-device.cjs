'use strict';
// Only synthetic fixtures are entered. Raw UI trees and subscription URLs are
// never written to disk or stdout; the temporary device tree is always removed.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const hdc = 'C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe';
const mode = process.argv[2] || 'inspect';
const outputDir=path.resolve(__dirname,'../build/node-manager-tests');
let progress={stage:'starting'};
function checkpoint(values){progress={...progress,...values};fs.mkdirSync(outputDir,{recursive:true});fs.writeFileSync(path.join(outputDir,'device-smoke-progress.json'),JSON.stringify(progress,null,2));}
const quote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(args) { try { return cp.execFileSync(hdc, args, {encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,timeout:15000}); } catch (_) { throw new Error('device-command-failed'); } }
const targets = command(['list','targets','-v']).split(/\r?\n/).filter(line => /\sUSB\s+Connected\s/.test(line));
assert.equal(targets.length, 1, 'one-connected-device');
const device = targets[0].trim().split(/\s+/)[0];
const shell = cmd => command(['-t',device,'shell',cmd]);
function flatten(n, out=[]) { if(n.attributes)out.push(n.attributes);for(const c of n.children||[])flatten(c,out);return out; }
const visible = n => n.visible === 'true' || n.visible === true;
function layout() {
  const remote = '/data/local/tmp/harmonyvpnlab-node-manager.json';
  let text;
  try { shell('uitest dumpLayout -p '+quote(remote)); text=shell('cat '+quote(remote)); }
  finally { shell('rm -f '+quote(remote)); }
  let nodes;try{nodes=flatten(JSON.parse(text));}catch(_){throw new Error('layout-unavailable');}
  const screens=['toggleConnection','nodeCount','nodeSearch','backToConnection','nodeInput','scanNode','saveNode','nodeSaveReceipt','backToProbe','subscriptionUrl','subscriptionResult','backToNodes'];
  if(!nodes.some(n=>screens.includes(n.id)||n.id?.startsWith('nodeName-')))throw new Error('unexpected-foreground-page');
  return nodes;
}
function rect(n) { const a=String(n.bounds).match(/-?\d+/g)?.map(Number);if(!a||a.length!==4)throw new Error('invalid-bounds');return a; }
async function find(id, enabled=true) {
  let nodes=layout();
  const match=()=>nodes.find(n=>n.id===id&&visible(n)&&(!enabled||n.enabled==='true'||n.enabled===true));
  if(match())return match();
  for(const down of [true,false])for(let i=0;i<4;i++){
    const s=nodes.find(n=>n.type==='Scroll'&&visible(n));if(!s)throw new Error('scroll-unavailable');
    const [l,t,r,b]=rect(s),x=Math.round((l+r)/2),a=Math.round(t+(b-t)*.2),z=Math.round(t+(b-t)*.8);
    shell(`uitest uiInput swipe ${x} ${down?z:a} ${x} ${down?a:z}`);await wait(120);nodes=layout();if(match())return match();
  }
  throw new Error('control-not-found:'+id.replace(/-[a-z0-9-]{20,}$/i,'-id'));
}
async function click(id) { const [l,t,r,b]=rect(await find(id));shell(`uitest uiInput click ${Math.floor((l+r)/2)} ${Math.floor((t+b)/2)}`);await wait(300); }
async function input(id, value) {
  const n=await find(id);if(id==='nodeInput'&&n.text)throw new Error('unsaved-private-input');
  const [l,t,r,b]=rect(n),x=Math.floor((l+r)/2),y=Math.floor((t+b)/2);
  if(n.text){
    shell(`uitest uiInput click ${x} ${y}`);
    shell('uitest uiInput keyEvent 2072 2017');shell('uitest uiInput keyEvent 2055');await wait(150);
    if((await find(id,false)).text!=='')throw new Error('input-clear-failed');
  }
  if(value)shell(`uitest uiInput inputText ${x} ${y} ${quote(value)}`);
  await wait(180);if((await find(id,false)).text!==value)throw new Error('input-not-matching');
  shell('uitest uiInput keyEvent Back');await wait(180);
}
async function openNodes() { if(layout().some(n=>n.id==='toggleConnection'))await click('openNodeConfig');await find('nodeCount',false); }
async function count() { return Number((await find('nodeCount',false)).text.match(/\d+/)[0]); }
async function inspect() {
  const nodes=layout();
  if(nodes.some(n=>n.id==='subscriptionUrl'))return {page:'subscriptions',inputPresent:!!nodes.find(n=>n.id==='subscriptionUrl')?.text};
  if(nodes.some(n=>n.id==='nodeInput'))return {page:'import',inputPresent:!!nodes.find(n=>n.id==='nodeInput')?.text};
  if(nodes.some(n=>n.id==='nodeCount'))return {page:'nodes',count:await count()};
  return {page:'connection',state:nodes.find(n=>n.id==='connectionState')?.text};
}
async function main() {
  if(mode==='inspect'){console.log(JSON.stringify(await inspect()));return;}
  if(mode==='verify-scan'){
    assert.equal((await find('nodeInput',false)).text,'','scan-input-cleared');
    assert.match((await find('nodeSaveReceipt',false)).text,/^保存回执：/,'scan-save-receipt');
    const resultText=(await find('nodeSaveResult',false)).text;
    assert.match(resultText,/^已新增 \d+ 个节点，跳过 \d+ 个已有节点/);
    const added=Number(resultText.match(/已新增 (\d+)/)[1]);
    const duplicate=Number(resultText.match(/跳过 (\d+)/)[1]);
    const log=shell('hilog -x -T HarmonyVpnLab');
    const scanLines=log.split(/\r?\n/).filter(line=>/NODE_SCAN_PARSED count=\d+|NODE_BATCH_SAVED added=\d+ duplicates=\d+/.test(line));
    assert.ok(scanLines.some(line=>line.includes('NODE_SCAN_PARSED count=')),'scan-callback-evidence');
    await click('backToProbe');
    const all=layout(),selected=all.find(n=>n.id?.startsWith('selectNode-')&&n.text==='已选中');
    if(!selected)throw new Error('selected-node-not-visible');
    const originalId=selected.id.substring('selectNode-'.length);
    const other=all.find(n=>n.id?.startsWith('nodeName-')&&n.id!==('nodeName-'+originalId));
    const testedId=added===1&&other?other.id.substring('nodeName-'.length):originalId;
    const result={checkedAt:new Date().toISOString(),version:'0.7.1',scanCallbackObserved:true,readbackReceiptVerified:true,inputCleared:true,added,duplicates:duplicate,catalogCount:await count(),originalId,testedId};
    fs.mkdirSync(outputDir,{recursive:true});fs.writeFileSync(path.join(outputDir,'device-scan-verification.json'),JSON.stringify(result,null,2));
    fs.writeFileSync(path.join(outputDir,'device-scan-events.log'),scanLines.join('\n'));
    if(testedId!==originalId)await click('selectNode-'+testedId);
    await click('backToConnection');console.log(JSON.stringify(result));return;
  }
  if(mode==='prepare-scanned-test'){
    await openNodes();
    const baseline=JSON.parse(fs.readFileSync(path.join(outputDir,'device-smoke-progress.json'),'utf8'));
    const total=await count();assert.equal(total,2,'two-nodes-after-user-scan');
    const all=layout(),selected=all.find(n=>n.id?.startsWith('selectNode-')&&n.text==='已选中');
    if(!selected)throw new Error('selected-node-not-visible');
    const originalId=selected.id.substring('selectNode-'.length);
    const imported=all.find(n=>n.id?.startsWith('nodeName-')&&n.id!==('nodeName-'+baseline.originalId));
    if(!imported)throw new Error('imported-node-not-visible');
    const testedId=imported.id.substring('nodeName-'.length);
    const result={checkedAt:new Date().toISOString(),version:'0.7.1',scanReportedByUser:true,scanCallbackLogRetained:false,readbackReceiptInspected:false,catalogCount:total,originalNodeRetained:all.some(n=>n.id==='nodeName-'+baseline.originalId),originalId,testedId};
    fs.mkdirSync(outputDir,{recursive:true});fs.writeFileSync(path.join(outputDir,'device-scan-verification.json'),JSON.stringify(result,null,2));
    if(testedId!==originalId)await click('selectNode-'+testedId);await click('backToConnection');console.log(JSON.stringify(result));return;
  }
  if(mode==='restore-scan-selection'){
    const p=JSON.parse(fs.readFileSync(path.join(outputDir,'device-scan-verification.json'),'utf8'));
    await openNodes();if(p.testedId!==p.originalId)await click('selectNode-'+p.originalId);
    assert.equal((await find('selectNode-'+p.originalId,false)).text,'已选中');await click('backToConnection');
    p.originalSelectionRestored=true;fs.writeFileSync(path.join(outputDir,'device-scan-verification.json'),JSON.stringify(p,null,2));console.log('Original selection restored; scanned nodes retained.');return;
  }
  if(mode==='inspect-fixtures'){
    console.log(JSON.stringify(layout().filter(n=>visible(n)&&((n.id==='renameNodeInput')||(n.id?.startsWith('nodeName-')&&n.text.startsWith('HARMONY-LOCAL-TEST'))||['nodeCount','confirmRenameNode','nodeManagerResult','backToConnection'].includes(n.id))).map(n=>({id:n.id,text:n.text,enabled:n.enabled,bounds:n.bounds}))));return;
  }
  if(mode==='subscriptions'){await openNodes();await click('manageSubscriptions');console.log('Subscription form opened; no URL was read or entered.');return;}
  if(mode==='import'){
    if(layout().some(n=>n.id==='subscriptionUrl'))await click('backToNodes');
    await openNodes();await click('importNodes');console.log('Node import page opened; use scanNode or paste a share link on the phone.');return;
  }
  if(mode==='restore-fixtures'){
    const p=JSON.parse(fs.readFileSync(path.join(outputDir,'device-smoke-progress.json'),'utf8'));
    shell('uitest uiInput keyEvent Back');await wait(200);
    shell('aa start -a EntryAbility -b com.example.harmonyvpnlab');await wait(500);
    await openNodes();
    await input('nodeSearch','');await click('selectNode-'+p.originalId);
    await input('nodeSearch','HARMONY-LOCAL-TEST');
    for(const id of [p.aid,p.bid]){if(id){await click('deleteNode-'+id);await click('confirmDeleteNode');}}
    await input('nodeSearch','');assert.equal(await count(),p.before);assert.equal((await find('selectNode-'+p.originalId,false)).text,'已选中');
    await click('backToConnection');checkpoint({stage:'restored-after-driver-input-error',originalRestored:true});console.log('Original node restored and synthetic fixtures removed.');return;
  }
  if(mode!=='smoke')throw new Error('unknown-mode');
  const first=layout().find(n=>n.id==='toggleConnection');
  if(!first||first.text!=='连接')throw new Error('disconnect-before-node-tests');
  await openNodes();const before=await count();assert.equal(before,1,'expected-single-migrated-node');
  const original=layout().find(n=>n.id?.startsWith('selectNode-')&&n.text==='已选中');
  if(!original)throw new Error('current-node-not-visible');const originalId=original.id.substring('selectNode-'.length);
  checkpoint({stage:'original-recorded',originalId,before});
  await click('importNodes');
  const auth=Buffer.from('aes-128-gcm:synthetic-only').toString('base64url');
  const fixtures=[`ss://${auth}@192.0.2.1:12341#HARMONY-LOCAL-TEST-A`,`ss://${auth}@192.0.2.1:12342#HARMONY-LOCAL-TEST-B`].join('\n');
  await input('nodeInput',fixtures);await click('saveNode');
  assert.match((await find('nodeSaveReceipt',false)).text,/^保存回执：/,'fresh-readback-receipt');
  assert.equal((await find('nodeInput',false)).text,'','input-cleared');
  await click('backToProbe');assert.equal(await count(),before+2,'batch-added-two');
  await input('nodeSearch','HARMONY-LOCAL-TEST');
  const names=layout().filter(n=>n.id?.startsWith('nodeName-')&&/^HARMONY-LOCAL-TEST-[AB]$/.test(n.text));
  if(names.length!==2)throw new Error('two-synthetic-fixtures-not-visible');
  const aid=names.find(n=>n.text.endsWith('-A')).id.substring('nodeName-'.length);
  const bid=names.find(n=>n.text.endsWith('-B')).id.substring('nodeName-'.length);
  checkpoint({stage:'fixtures-recorded',aid,bid});
  await click('selectNode-'+aid);await click('renameNode-'+aid);
  await input('renameNodeInput','HARMONY-LOCAL-TEST-RENAMED');await click('confirmRenameNode');
  await click('backToConnection');assert.equal((await find('currentNodeName',false)).text,'HARMONY-LOCAL-TEST-RENAMED');
  shell('aa force-stop com.example.harmonyvpnlab');shell('aa start -a EntryAbility -b com.example.harmonyvpnlab');await wait(700);
  assert.equal((await find('currentNodeName',false)).text,'HARMONY-LOCAL-TEST-RENAMED','selection-and-name-survive-restart');
  await openNodes();await click('selectNode-'+originalId);
  await input('nodeSearch','HARMONY-LOCAL-TEST');
  for(const id of [aid,bid]){await click('deleteNode-'+id);await click('confirmDeleteNode');}
  assert.equal(await count(),before,'synthetic-fixtures-removed');
  await input('nodeSearch','');assert.equal((await find('selectNode-'+originalId,false)).text,'已选中','original-restored');
  await click('backToConnection');
  checkpoint({stage:'completed',originalRestored:true});
  const result={checkedAt:new Date().toISOString(),passed:true,version:'0.7.0',migratedCount:before,batchImported:2,renamed:true,selectionSurvivesRestart:true,originalRestored:true,syntheticFixturesRemoved:true,noFixtureConnectionAttempted:true};
  const dir=path.resolve(__dirname,'../build/node-manager-tests');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'device-node-manager-verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
main().catch(error=>{const reason=/^[A-Za-z][A-Za-z0-9:-]+$/.test(error.message)?error.message:'assertion-failed';const line=String(error.stack).match(/test-node-manager-device\.cjs:(\d+):\d+/)?.[1];console.error(JSON.stringify({error:reason,line,recovery:'device-smoke-progress.json'}));process.exitCode=1;});
