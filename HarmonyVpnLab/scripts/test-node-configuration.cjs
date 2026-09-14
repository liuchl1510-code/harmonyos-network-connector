'use strict';
// Actual pure configuration modules with the SDK TypeScript compiler and Node
// URL/text shims. No filesystem-backed catalog, network, device or native core.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),ts=require(path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const imported=require('./node-import-loader.cjs').loadNodeImporter(),parser=imported.parser,issues=imported.issues;
const sourceSHA256={};
for(const name of ['NodeImport','NodeIssue'])sourceSHA256[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'entry/src/main/ets/model',name+'.ets'))).digest('hex');
function load(name,dependencies){const filename=path.join(root,'entry/src/main/ets/model',name+'.ets'),source=fs.readFileSync(filename,'utf8');sourceSHA256[name]=crypto.createHash('sha256').update(source).digest('hex');
 const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});assert.equal(result.diagnostics.length,0,name+' transpilation');
 const m=new Module(filename);m.require=key=>{assert(Object.hasOwn(dependencies,key),'Unexpected dependency '+key);return dependencies[key];};m._compile(result.outputText,filename);return m.exports;}
const ark={util:{TextEncoder:class{encodeInto(value){return new TextEncoder().encode(value);}},Base64Helper:class{decodeSync(value){return Buffer.from(value,'base64');}},TextDecoder:{create:(encoding,options)=>({decodeToString:value=>new TextDecoder(encoding,options).decode(value)})}}};
const bootstrap=load('NodeBootstrap',{}),preflight=load('NodePreflight',{'./NodeImport':parser,'./NodeIssue':issues,'./NodeBootstrap':bootstrap});
const batch=load('NodeBatchImport',{'@kit.ArkTS':ark,'./NodeImport':parser,'./NodeIssue':issues});
const editor=load('NodeEditor',{'@kit.ArkTS':ark,'./NodeImport':parser,'./NodeIssue':issues});
const UUID='00000000-0000-4000-8000-000000000001',SECRET='synthetic-secret-never-in-node-issues',host='example.invalid';
const vless=`vless://${UUID}@${host}:443`,reality=vless+'?security=reality&sni=example.invalid&pbk='+ 'a'.repeat(43)+'&sid=abcd';
const copy=value=>JSON.parse(JSON.stringify(value));
const tests=[];function test(name,body){tests.push({name,body});}
function issueFor(input,code){let error;try{parser.parseNode(input);}catch(value){error=value;}assert(error instanceof issues.NodeIssueError);const issue=issues.nodeIssueFromError(error);assert(issue);assert.equal(issue.code,code);assert(issue.field&&issue.problem&&issue.suggestion);for(const secret of [UUID,host,SECRET])assert(!JSON.stringify(issue).includes(secret));return issue;}
for(const [label,input,code] of [
 ['empty','','input-empty'],['port',vless.replace(':443',':0'),'port-format'],['UUID',vless.replace(UUID,SECRET),'uuid-format'],
 ['address',vless.replace(host,''),'endpoint-format'],['missing endpoint',`vless://${UUID}`,'endpoint-format'],
 ['unsupported protocol','hysteria2://'+SECRET+'@'+host+':443','protocol-unsupported'],
 ['transport',vless+'?type=xhttp','transport-unsupported'],['security',vless+'?security=unsupported','security-unsupported'],
 ['unknown option',vless+'?'+SECRET+'=value','options-unsupported'],['duplicate option',vless+'?type=tcp&type=ws','duplicate-option'],
 ['certificate',vless+'?security=tls&allowInsecure=true','certificate-verification'],
 ['missing REALITY key',reality.replace(/pbk=[^&]+/,'pbk='),'reality-key'],['missing REALITY SNI',reality.replace('sni=example.invalid','sni='),'reality-sni'],
 ['REALITY shortId',reality.replace('sid=abcd','sid=abc'),'reality-short-id'],
 ['Vision transport',vless+'?security=tls&type=ws&flow=xtls-rprx-vision','flow-unsupported'],
 ['WebSocket path',vless+'?type=ws&path=invalid','ws-path'],['gRPC mode',vless+'?type=grpc&mode=invalid','grpc-mode'],
 ['ALPN',vless+'?security=tls&alpn=h2,,http%2F1.1','alpn-format'],['percent encoding',vless+'?path=%zz','percent-encoding'],
 ['JSON syntax','{"protocol":"'+SECRET+'"','json-syntax'],['full config','{"outbounds":[]}','json-document']
])test(label+' reports a fixed field, problem and suggestion',()=>{issueFor(input,code);});

test('empty REALITY shortId remains valid in links and JSON',()=>{
 const node=parser.parseNode(reality.replace('sid=abcd','sid='));assert.equal(JSON.parse(node.outboundJson).streamSettings.realitySettings.shortId,'');
 assert.deepEqual(preflight.checkNodeForConnection(node),[]);assert.equal(parser.parseNode(node.outboundJson).outboundJson,node.outboundJson);
});
test('an empty JSON server address is located at the address field',()=>{
 const raw=JSON.parse(parser.parseNode(vless).outboundJson);raw.settings.vnext[0].address='';issueFor(JSON.stringify(raw),'address-format');
});
test('REALITY JSON fingerprint missing is located without inventing a default',()=>{
 const node=parser.parseNode(reality),raw=JSON.parse(node.outboundJson);delete raw.streamSettings.realitySettings.fingerprint;
 const original=JSON.stringify(raw);issueFor(original,'reality-fingerprint');assert.equal(JSON.stringify(raw),original);
});
test('TLS SNI is optional and original omitted settings remain omitted',()=>{
 const raw={protocol:'trojan',settings:{servers:[{address:host,port:443,password:' '+SECRET+' '}]},streamSettings:{network:'tcp',security:'tls'}};
 const node=parser.parseNode(JSON.stringify(raw));assert.deepEqual(preflight.checkNodeForConnection(node),[]);
 assert.equal(editor.nodeFromEditorDraft(node,editor.nodeEditorDraft(node)).outboundJson,JSON.stringify(raw));
});
for(const address of ['127.0.0.1','localhost','192.168.10.20','10.0.0.2','node.example.invalid'])test('preflight does not reject or rewrite local/remote address '+address,()=>{
 const node=parser.parseNode(vless.replace(host,address)),before=JSON.stringify(node);Object.freeze(node);
 assert.deepEqual(preflight.checkNodeForConnection(node),[]);assert.equal(JSON.stringify(node),before);
});
test('IPv6 import support remains while current connection entry reports its separate limitation',()=>{
 const node=parser.parseNode(`ss://aes-128-gcm:${SECRET}@[2001:db8::1]:443`),before=node.outboundJson;
 assert.equal(preflight.checkNodeForConnection(node)[0].code,'ipv4-entry-required');assert.equal(node.outboundJson,before);
});
test('saved JSON numeric shorthand is reported by existing bootstrap rules without normalization',()=>{
 const raw=JSON.parse(parser.parseNode(vless).outboundJson);raw.settings.vnext[0].address='127.1';
 const node=parser.parseNode(JSON.stringify(raw)),before=node.outboundJson;
 assert.equal(preflight.checkNodeForConnection(node)[0].code,'bootstrap-host-format');assert.equal(node.outboundJson,before);
});
test('preflight returns only the first blocking issue and preserves the supplied object',()=>{
 const raw=JSON.parse(parser.parseNode(vless).outboundJson);raw.settings.vnext[0].port=0;raw.settings.vnext[0].users[0].id=SECRET;
 const node=new parser.ImportedNode('synthetic','vless',JSON.stringify(raw)),before=JSON.stringify(node);Object.freeze(node);
 const results=preflight.checkNodeForConnection(node);assert.equal(results.length,1);assert.equal(results[0].code,'port-format');assert.equal(JSON.stringify(node),before);
});
test('preflight refuses protocol label mismatch without modifying the outbound',()=>{
 const node=parser.parseNode(vless);node.protocol='trojan';const before=JSON.stringify(node);
 assert.equal(preflight.checkNodeForConnection(node)[0].code,'protocol-unsupported');assert.equal(JSON.stringify(node),before);
});
test('deep options, ALPN string/array and legacy Host survive checking and no-op editor roundtrips',()=>{
 for(const alpn of ['h2,http/1.1',['h2','http/1.1']]){
  const raw=JSON.parse(parser.parseNode(vless).outboundJson);raw.streamSettings={network:'ws',security:'tls',tlsSettings:{alpn,enableSessionResumption:true},wsSettings:{path:'/ws',headers:{Host:'legacy.invalid','X-Synthetic':'kept'}}};raw.mux={enabled:false,concurrency:4};
  const node=parser.parseNode(JSON.stringify(raw)),before=JSON.stringify(node);assert.deepEqual(preflight.checkNodeForConnection(node),[]);assert.equal(JSON.stringify(node),before);
  assert.equal(editor.nodeFromEditorDraft(node,editor.nodeEditorDraft(node)).outboundJson,node.outboundJson);
 }
});
test('invalid field edits retain original node and complete dirty draft for correction',()=>{
 const node=parser.parseNode(reality),draft=editor.nodeEditorDraft(node),original=JSON.stringify(node);draft.publicKey=SECRET;const before=JSON.stringify(draft);
 let failure;try{editor.nodeFromEditorDraft(node,draft);}catch(error){failure=error;}
 assert.equal(issues.nodeIssueFromError(failure).code,'reality-key');assert.equal(JSON.stringify(node),original);assert.equal(JSON.stringify(draft),before);
 draft.publicKey='a'.repeat(43);assert.equal(editor.nodeFromEditorDraft(node,draft).outboundJson,node.outboundJson);
});
test('invalid advanced JSON is classified while the original remains unchanged',()=>{
 const node=parser.parseNode(vless),before=JSON.stringify(node);let error;try{editor.nodeFromEditorJson(node.name,'{"'+SECRET+'":');}catch(value){error=value;}
 assert.equal(issues.nodeIssueFromError(error).code,'json-syntax');assert.equal(JSON.stringify(node),before);
});
test('partial lists keep original nonempty entry order and safe error codes',()=>{
 const result=batch.parseNodeBatch('\n'+vless+'\n\n'+vless.replace(':443',':0')+'\n'+vless+'\n'+vless.replace(UUID,SECRET));
 assert.deepEqual([result.nodes.length,result.rejected,result.duplicates,result.total],[1,2,1,4]);
 assert.deepEqual(result.issues.map(x=>[x.entryIndex,x.code]),[[2,'port-format'],[4,'uuid-format']]);
 assert(!JSON.stringify(result.issues).includes(SECRET));
});
test('Base64 list issue indices refer to decoded nonempty entries',()=>{
 const text=vless+'\n'+vless.replace(UUID,SECRET),result=batch.parseNodeBatch(Buffer.from(text).toString('base64'));
 assert.equal(result.issues[0].entryIndex,2);assert.equal(result.issues[0].code,'uuid-format');
});
test('all-invalid lists expose bounded details but never return saveable nodes',()=>{
 let error;try{batch.parseNodeBatch(Array(15).fill(vless.replace(UUID,SECRET)).join('\n'));}catch(value){error=value;}
 assert(error instanceof batch.BatchImportFailure);assert.equal(error.rejected,15);assert.equal(error.total,15);assert.equal(error.issues.length,10);
 assert.deepEqual(error.issues.map(x=>x.entryIndex),[1,2,3,4,5,6,7,8,9,10]);assert(!('nodes' in error));assert(!JSON.stringify(error.issues).includes(SECRET));
});
test('partial lists retain accurate totals after the ten-detail cap',()=>{
 const result=batch.parseNodeBatch(vless+'\n'+Array(15).fill(vless.replace(':443',':0')).join('\n'));
 assert.equal(result.nodes.length,1);assert.equal(result.rejected,15);assert.equal(result.issues.length,10);assert.equal(result.issues[9].entryIndex,11);
});
test('single invalid JSON retains its concrete issue instead of becoming a generic batch failure',()=>{
 const raw=JSON.parse(parser.parseNode(reality).outboundJson);raw.streamSettings.realitySettings.shortId='abc';let error;
 try{batch.parseNodeBatch(JSON.stringify(raw));}catch(value){error=value;}assert.equal(issues.nodeIssueFromError(error).code,'reality-short-id');
});
test('unknown exceptions and forged plain objects cannot be accepted as authored issue evidence',()=>{
 for(const error of [new Error(SECRET),{code:'port-format',message:SECRET},null])assert.equal(issues.nodeIssueFromError(error),undefined);
 const issue=issues.nodeIssue(SECRET);assert.equal(issue.code,'configuration-invalid');assert(!JSON.stringify(issue).includes(SECRET));
 const actual=new issues.NodeIssueError('port-format');actual.message=SECRET;assert(!JSON.stringify(issues.nodeIssueFromError(actual)).includes(SECRET));
 const forged=issues.nodeIssue('port-format');forged.problem=SECRET;forged.suggestion=SECRET;assert(!issues.formatNodeIssue(forged).includes(SECRET));
});
test('authored unknown or mutated code falls back without reflecting the supplied code',()=>{
 const actual=new issues.NodeIssueError(SECRET);assert.equal(actual.code,'configuration-invalid');assert(!actual.message.includes(SECRET));
 actual.code=SECRET;assert.equal(issues.nodeIssueFromError(actual),undefined);
});

const results=[];for(const item of tests){try{item.body();results.push({name:item.name,passed:true});}catch(error){results.push({name:item.name,passed:false,detail:error.message});}}
const report={generatedAt:new Date().toISOString(),passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,total:results.length,sourceSHA256,
 scope:'Actual pure NodeIssue/NodeImport/NodePreflight/NodeBatchImport/NodeEditor modules with SDK transpilation and synthetic data. No DNS, file storage, native core or device.',results};
const destination=path.join(root,'build/node-configuration-verification.json');fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,failed:report.failed,total:report.total,failures:results.filter(x=>!x.passed),record:destination}));if(report.failed)process.exitCode=1;
