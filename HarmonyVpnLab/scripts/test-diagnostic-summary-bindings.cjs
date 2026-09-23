'use strict';
// Execute the real Diagnostics navigation method with a controlled router.
// Route registration and button callback are separately counted static checks.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const ts=require(path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names=['entry/src/main/ets/pages/Diagnostics.ets','entry/src/main/resources/base/profile/main_pages.json'];
const sources=names.map(name=>fs.readFileSync(path.join(root,name),'utf8'));
const boundary=sources[0].indexOf('\n  build() {');assert(boundary>0);
const methods=(sources[0].slice(0,boundary)+'\n}\n').replace(/^import[^\n]*\n/gm,'').replace(/^@Entry\s*$/gm,'').replace(/^@Component\s*$/gm,'')
  .replace(/^(\s*)@State /gm,'$1').replace(/@StorageProp\([^)]*\)\s*/g,'').replace(/^struct (\w+) \{/m,'export class $1 {');
const compiled=ts.transpileModule(methods,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});assert.equal(compiled.diagnostics.length,0);
function fixture(){const context={exports:{}},calls=[];vm.runInNewContext(compiled.outputText,context);const page=new context.exports.Diagnostics();
 const router={pushUrl:async args=>{calls.push(args);if(router.fail)throw Error('PRIVATE_RAW_ROUTE_ERROR');if(router.pending)await router.pending;}};
 page.getUIContext=()=>({getRouter:()=>router});return{page,router,calls};}
const tests=[],test=(name,kind,body)=>tests.push({name,kind,body});
test('diagnostic entry opens the summary route and releases its busy guard','execution',async()=>{
 const f=fixture();await f.page.openSummary();assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'pages/DiagnosticSummary');assert.equal(f.page.openingSummary,false);
});
test('repeated entry click cannot enqueue duplicate navigation while first push is pending','execution',async()=>{
 const f=fixture();let release;f.router.pending=new Promise(resolve=>release=resolve);const first=f.page.openSummary();assert.equal(f.page.openingSummary,true);
 await f.page.openSummary();assert.equal(f.calls.length,1);release();await first;assert.equal(f.page.openingSummary,false);
});
test('failed navigation exposes a fixed message and permits a later retry','execution',async()=>{
 const f=fixture();f.router.fail=true;await f.page.openSummary();assert.equal(f.page.openingSummary,false);assert.equal(f.page.message,'诊断摘要暂时无法打开，请重试。');
 f.router.fail=false;await f.page.openSummary();assert.equal(f.calls.length,2);assert.equal(f.page.openingSummary,false);
});
test('summary route is registered once and enabled entry invokes the authored method','static',()=>{
 const pages=JSON.parse(sources[1]);assert.equal(pages.src.filter(page=>page==='pages/DiagnosticSummary').length,1);
 const builder=sources[0].slice(boundary);assert(builder.includes(".id('openDiagnosticSummary')"));
 assert(/\.enabled\(!this\.openingSummary\)\s*\.onClick\(\(\) => \{ void this\.openSummary\(\); \}\)/.test(builder));
});
(async()=>{const results=[];for(const item of tests){try{await item.body();results.push({name:item.name,kind:item.kind,passed:true});}catch(error){results.push({name:item.name,kind:item.kind,passed:false,detail:error.message});}}
 const report={generatedAt:new Date().toISOString(),passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,
  executedCases:3,staticChecks:1,scope:'Actual Diagnostics openSummary with synthetic router; static route and button binding, no device/navigation rendering.',
  sourceSHA256:Object.fromEntries(names.map((name,index)=>[name,crypto.createHash('sha256').update(sources[index]).digest('hex')])),results};
 report.sourceSHA256['scripts/test-diagnostic-summary-bindings.cjs']=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
 fs.mkdirSync(path.join(root,'build'),{recursive:true});fs.writeFileSync(path.join(root,'build/diagnostic-summary-bindings-verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({passed:report.passed,failed:report.failed,executedCases:3,staticChecks:1,failures:results.filter(x=>!x.passed)}));if(report.failed)process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
