'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const root=path.resolve(__dirname,'..');
const ts=require(path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
function load(name,imports={}){const file=path.join(root,'entry/src/main/ets',name);const result=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});assert.equal(result.diagnostics.length,0);const m=new Module(file);m.require=k=>{assert(Object.hasOwn(imports,k),k);return imports[k]};m._compile(result.outputText,file);return m.exports;}
const layout=load('model/AdaptiveLayout.ets');let passed=0;function test(name,fn){fn();passed++;console.log('PASS '+name)}
for(const width of [240,320,360,480,600,679,680,707.2,768,799,800,840,1023,1024,1280,1600,1920,3200])test('content fits logical window '+width,()=>{
  const rail=layout.useSideNavigation(width)?176:0;
  assert(layout.formContentWidth(width)<=Math.min(width,840));
  assert(layout.primaryContentWidth(width)+rail<=width);
  assert(layout.nodeListContentWidth(width)+rail<=width);
  assert(layout.primaryContentWidth(width)<=1200);
  assert(layout.nodeListContentWidth(width)<=1040);
});
test('phone, tablet and resized PC use width rather than hardware labels',()=>{
  assert.equal(layout.useSideNavigation(1023),false);assert.equal(layout.useSideNavigation(1024),true);
  assert.equal(layout.homeUsesColumns(679),false);assert.equal(layout.homeUsesColumns(680),true);
  assert.equal(layout.homeUsesColumns(707.2),true);
  assert.equal(layout.homeUsesColumns(1024),true);
});
test('invalid resize data has a finite mobile fallback',()=>{for(const w of [0,-1,NaN,Infinity])assert.equal(layout.normalizedWindowWidth(w),360)});
test('window resize updates density-aware vp and removes exact listener on destroy',()=>{
  const values=new Map(),events=[],main={getUIContext:()=>({px2vp:n=>n/2}),getWindowProperties:()=>({windowRect:{width:2560,height:1600}}),on:(name,fn)=>events.push({name,fn}),off:(name,fn)=>{assert.equal(name,'windowSizeChange');assert.equal(fn,events[0].fn);events.push({off:true})}};
  global.AppStorage={setOrCreate:(k,v)=>values.set(k,v)};
  const {default:Ability}=load('entryability/EntryAbility.ets',{'@kit.AbilityKit':{UIAbility:class{}},'@kit.ArkUI':{},'@kit.BasicServicesKit':{deviceInfo:{deviceType:'phone'}},'@kit.PerformanceAnalysisKit':{hilog:{info(){},warn(){}}},'libvpnbridge.so':{},'../model/Appearance':{applyAppearance(){},readAppearance:()=> 'system'},'../model/AdaptiveLayout':layout,'../model/BuildCapabilities':{VPN_CORE_AVAILABLE:true}});
  const a=new Ability();a.mainWindow=main;a.attachWindowSize();assert.equal(values.get('windowWidthVp'),1280);
  events[0].fn({width:720,height:1200});assert.equal(values.get('windowWidthVp'),360);
  events[0].fn({width:2048,height:1200});assert.equal(values.get('windowWidthVp'),1024);
  a.attachWindowSize();assert.equal(events.length,1);a.onWindowStageDestroy();assert.equal(events.length,2);assert.equal(a.mainWindow,undefined);
});
const out=path.join(root,'build/adaptive-layout-verification.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({passed,scope:'actual pure layout and EntryAbility listener with synthetic SDK; not visual emulator evidence'},null,2));console.log(JSON.stringify({passed,failed:0}));
