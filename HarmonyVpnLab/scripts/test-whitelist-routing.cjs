'use strict';
// Execute the real ArkTS policy/config builders; all nodes and requests synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),ets=path.join(root,'entry/src/main/ets/model');
const ts=require(path.join(process.env.DEVECO_STUDIO_HOME||'C:/Program Files/Huawei/DevEco Studio','sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
function load(name,imports={}){const file=path.join(ets,name+'.ets'),out=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});assert.equal(out.diagnostics.length,0);const m=new Module(file);m.require=key=>{assert(Object.hasOwn(imports,key));return imports[key];};m._compile(out.outputText,file);return m.exports;}
const b=load('NodeBootstrap'),a=load('AppRouting'),p=load('NetworkPolicy',{'./NodeBootstrap':b,'./AppRouting':a}),c=load('ConnectionConfig',{'./NodeBootstrap':b,'./NetworkPolicy':p});
const node=JSON.stringify({protocol:'vless',settings:{vnext:[{address:'192.0.2.1',port:443,users:[{id:'00000000-0000-4000-8000-000000000001',encryption:'none'}]}]}});
const build=policy=>JSON.parse(c.buildConnectionConfig(node,18900,18901,'/synthetic/log',undefined,policy));
let passed=0;const test=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
const white=new p.NetworkPolicy();white.mode='whitelist';
test('white rule order and fields exactly match pinned v2rayN source after tag/inbound translation',()=>{
 const upstream=JSON.parse(fs.readFileSync(path.join(root,'rules/custom_routing_white.json'),'utf8'));
 assert.equal(upstream.length,8);
 const expected=upstream.map(({remarks,...rule})=>({type:'field',inboundTag:['connection-in'],...rule,outboundTag:rule.outboundTag==='proxy'?'nodeProxy':rule.outboundTag==='block'?'rule-block':rule.outboundTag}));
 assert.deepEqual(p.policyRoutingRules(white),expected.map(v=>Object.assign(new p.RoutingRule(v.outboundTag),v)));
});
test('whitelist keeps global defaults and saved custom/app preferences independent',()=>{
 assert.equal(new p.NetworkPolicy().mode,'global');assert.equal(p.networkPolicyLabel(white),'白名单 · 绕过大陆');
 const before=JSON.stringify(white);white.direct=['full:retained.example'];white.proxy=['0.0.0.0/0'];white.block=['full:ignored.example'];white.bypassLan=true;white.appMode='exclude';white.appBundles=['com.example.reader'];
 const checked=p.validateNetworkPolicy(white);assert.equal(checked.mode,'whitelist');assert.deepEqual(checked.direct,white.direct);assert.deepEqual(checked.appBundles,white.appBundles);
 const clean=new p.NetworkPolicy();clean.mode='whitelist';assert.deepEqual(build(checked),build(clean));
 assert.notEqual(JSON.stringify(white),before);
});
test('whitelist preserves DNS IPv6 virtual-route safety before upstream rules',()=>{
 const config=build(white),rules=config.routing.rules;assert.equal(config.routing.domainStrategy,'AsIs');
 assert.deepEqual(rules.slice(0,4).map(x=>x.outboundTag),['block-ipv6','nodeProxy','dns-out','block-virtual']);
 assert.deepEqual(rules.slice(4,-1),JSON.parse(JSON.stringify(p.policyRoutingRules(white))));
 assert.equal(rules.at(-1).outboundTag,'nodeProxy');assert.equal(config.inbounds[0].sniffing.routeOnly,true);
 assert.equal(config.outbounds.find(o=>o.tag==='direct').settings.domainStrategy,'ForceIPv4');
 assert.equal(config.dns.servers[0].address,white.dnsUrl);assert.equal(config.dns.disableFallback,true);
});
test('mode switching does not activate retained custom rules or lose rule mode',()=>{
 white.mode='global';const global=build(white);assert.equal(global.inbounds[0].sniffing,undefined);assert(!global.outbounds.some(o=>o.tag==='direct'));assert.equal(global.routing.rules.length,5);
 white.mode='rules';assert(build(white).routing.rules.some(r=>r.domain?.includes('full:ignored.example')));white.mode='whitelist';
 assert(!build(white).routing.rules.some(r=>r.domain?.includes('full:ignored.example')));
});
test('returned upstream rules are isolated from callers',()=>{const first=p.policyRoutingRules(white);first[1].domain.push('full:mutated.example');assert.equal(p.policyRoutingRules(white)[1].domain.length,1);});
const cases=[
 {name:'google beats CN IP',domain:'www.google.com',ips:['223.5.5.5'],expectedTag:'nodeProxy'},
 {name:'google CN exception',domain:'www.google.cn',ips:['223.5.5.5'],expectedTag:'nodeProxy'},
 {name:'CN domain with foreign IP',domain:'www.baidu.com',ips:['8.8.8.8'],expectedTag:'direct'},
 {name:'private domain',domain:'router.lan',expectedTag:'direct'},
 {name:'private IPv4',ips:['192.168.1.1'],expectedTag:'direct'},
 {name:'CN IPv4',ips:['123.125.114.144'],expectedTag:'direct'},
 {name:'unknown domain foreign IP',domain:'hvpn-unlisted-20260923.com',ips:['93.184.216.34'],expectedTag:'nodeProxy'},
 {name:'unknown domain existing CN IP',domain:'hvpn-unlisted-20260923.com',ips:['123.125.114.144'],expectedTag:'direct'},
 {name:'AsIs does not resolve unknown name',domain:'hvpn-unlisted-20260923.com',resolvedIPs:['123.125.114.144'],expectedTag:'nodeProxy',expectedDnsLookups:0},
 {name:'UDP443 foreign blocked',network:'udp',port:443,ips:['8.8.8.8'],expectedTag:'rule-block'},
 {name:'UDP443 Google blocked',network:'udp',port:443,domain:'www.google.com',expectedTag:'rule-block'},
 {name:'UDP443 CN blocked',network:'udp',port:443,domain:'www.baidu.com',expectedTag:'rule-block'},
 {name:'public DNS ordinary TCP',ips:['223.5.5.5'],port:80,expectedTag:'direct'},
 {name:'public DNS explicit exception',ips:['52.80.66.66'],port:853,expectedTag:'direct'},
 {name:'DNS domain',domain:'doh.pub',expectedTag:'direct'},
 {name:'captured DNS UDP precedes white',ips:['223.5.5.5'],network:'udp',port:53,expectedTag:'dns-out'},
 {name:'captured DNS TCP precedes white',ips:['8.8.8.8'],port:53,expectedTag:'dns-out'},
 {name:'internal DoH always proxy',inboundTag:'dns-via-node',domain:'doh.pub',expectedTag:'nodeProxy'},
 {name:'IPv6 remains rejected',ips:['2400:3200::1'],expectedTag:'block-ipv6'},
 {name:'virtual interface remains rejected',ips:['198.18.0.1'],port:80,expectedTag:'block-virtual'},
 {name:'foreign domain proxy',domain:'www.cloudflare.com',ips:['104.16.124.96'],expectedTag:'nodeProxy'}
].map(v=>({network:'tcp',port:443,inboundTag:'connection-in',expectedDnsLookups:0,...v}));
const global=new p.NetworkPolicy();
const globalCases=cases.filter(v=>!['block-ipv6','block-virtual','dns-out'].includes(v.expectedTag)).map(v=>({...v,name:'global '+v.name,expectedTag:'nodeProxy'}));
const fixtures=[{name:'v2rayN whitelist',configJSON:JSON.stringify(build(white)),cases},{name:'global unchanged',configJSON:JSON.stringify(build(global)),cases:globalCases}];
const out=path.join(root,'build');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'whitelist-core-fixtures.json'),JSON.stringify(fixtures,null,2)+'\n');
const sourceHashes=Object.fromEntries(['NetworkPolicy','ConnectionConfig','NodeBootstrap','AppRouting'].map(n=>[n+'.ets',crypto.createHash('sha256').update(fs.readFileSync(path.join(ets,n+'.ets'))).digest('hex')]));
fs.writeFileSync(path.join(out,'whitelist-policy-tests.json'),JSON.stringify({passed,generatedCoreCases:cases.length+globalCases.length,sourceHashes,networkUsed:false},null,2)+'\n');
console.log(JSON.stringify({passed,generatedCoreCases:cases.length+globalCases.length}));
