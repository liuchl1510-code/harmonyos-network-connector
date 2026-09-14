/*
 * Offline parser checks using only fictional node data. No network requests.
 * Uses the TypeScript bundled with DevEco; does not install npm packages.
 * Usage: node scripts/test-node-import.cjs [--typescript-dir <typescript-package-dir>]
 *        [--emit-xray-fixtures <output-json-path>]
 * Fixtures contain only successful fictional cases as {name, configJSON} objects.
 * Alternative: set DEVECO_STUDIO_HOME to the installed DevEco Studio directory.
 * IMPORTANT: the SDK URL/Base64/UTF-8 APIs are replaced by Node equivalents.
 * This checks parser logic; actual ArkTS compilation and device checks are separate.
 */
const fs = require('fs'), Module = require('module'), assert = require('assert');
const nodePath = require('path'), crypto = require('crypto');
const projectRoot = nodePath.resolve(__dirname, '..');
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!['--typescript-dir', '--emit-xray-fixtures'].includes(option) ||
        !value || value.startsWith('--') || options.has(option)) {
        console.error('Usage: node test-node-import.cjs [--typescript-dir <typescript-package-dir>] ' +
            '[--emit-xray-fixtures <output-json-path>]');
        process.exit(2);
    }
    options.set(option, nodePath.resolve(value));
}
const devEcoPath = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const tsPath = options.get('--typescript-dir') || nodePath.join(devEcoPath,
    'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript');
const ts = require(tsPath);
const path = nodePath.join(projectRoot, 'entry/src/main/ets/model/NodeImport.ets');
const shim = `
const url = { URL: { parseURL: (s: string): URL => new URL(s) } };
const util = {
    Base64Helper: class {
        decodeSync(s: string): Uint8Array { return Buffer.from(s, 'base64'); }
    },
    TextDecoder: {
        create: (s: string, opts: Object): Object => ({
            decodeToString: (bytes: Uint8Array): string => new TextDecoder(s, opts).decode(bytes)
        })
    }
};`;
const source = fs.readFileSync(path, 'utf8').replace("import { url, util } from '@kit.ArkTS';", shim);
const out = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(out.diagnostics.length, 0);
const m = new Module(path);
const issues = require('./node-import-loader.cjs').loadNodeImporter(tsPath).issues;
m.require = name => { assert.equal(name, './NodeIssue'); return issues; };
m._compile(out.outputText, path);
const parse = m.exports.parseNode;
const uuid = 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60', base = `vless://${uuid}@example.invalid:443`, b64 = s => Buffer.from(s).toString('base64');
const tests = [];
const coreFixtures = [];
function good(name, input, check) {
    tests.push(() => {
        const imported = parse(input);
        const outbound = JSON.parse(imported.outboundJson);
        check?.(outbound, imported);
        // A complete minimal Xray document. A later validator may call LoadConfig;
        // this script does not start a core, create listeners or connect to a node.
        const config = { log: { loglevel: 'none' }, outbounds: [outbound] };
        coreFixtures.push({ name: name, configJSON: JSON.stringify(config) });
        return name;
    });
}
function bad(name, input) {
    tests.push(() => {
        let thrown = false;
        try {
            parse(input);
        } catch (e) {
            thrown = true;
            assert(!e.message.includes(uuid));
            assert(!e.message.includes('example.invalid'));
        }
        assert(thrown, 'accepted invalid case ' + name);
        return name;
    });
}
good('vless tcp', base + '?type=tcp&security=none', o => assert.equal(o.settings.vnext[0].users[0].encryption, 'none'));
good('vless tls ws', base + '?type=ws&security=tls&sni=sni.invalid&host=host.invalid&path=%2Fws%3Fed%3D2048&alpn=h2,http%2F1.1', o => assert.equal(o.streamSettings.wsSettings.path, '/ws?ed=2048'));
good('vless reality raw vision', base + '?type=raw&security=reality&sni=sni.invalid&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=0123&flow=xtls-rprx-vision', o => assert.equal(o.streamSettings.realitySettings.fingerprint, 'chrome'));
good('vless grpc', base + '?type=grpc&security=tls&serviceName=svc&mode=multi&authority=grpc.invalid', o => assert.equal(o.streamSettings.grpcSettings.multiMode, true));
good('trojan default tls', 'trojan://not-a-real-password%3A%2B%40@example.invalid:443#demo', o => assert.equal(o.settings.servers[0].password, 'not-a-real-password:+@'));
good('ss b64 userinfo', 'ss://' + b64('aes-128-gcm:not-a-real-password') + '@example.invalid:8388#demo');
good('ss plain encoded', 'ss://aes-256-gcm:fake%3A%40%2F%2B@example.invalid:8388', o => assert.equal(o.settings.servers[0].password, 'fake:@/+'));
good('ss 2022', 'ss://2022-blake3-aes-128-gcm:' + encodeURIComponent(b64('0123456789abcdef')) + '@[2001:db8::1]:8388');
good('vmess v2', 'vmess://' + b64(JSON.stringify({ v: '2', ps: '演示', add: 'example.invalid', port: '443', id: uuid, aid: '0', net: 'ws', type: 'none', path: '/ws', tls: 'tls' })), o => assert.equal(o.settings.vnext[0].users[0].alterId, 0));
good('vmess grpc', 'vmess://' + b64(JSON.stringify({ v: 2, add: 'example.invalid', port: 443, id: uuid, net: 'grpc', type: 'multi', path: 'svc', host: 'grpc.invalid', tls: 'tls' })), o => assert.equal(o.streamSettings.grpcSettings.serviceName, 'svc'));
const raw = { protocol: 'vless', tag: 'raw demo', settings: { vnext: [{ address: 'example.invalid', port: 443, users: [{ id: uuid, encryption: 'none' }] }] }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'sni.invalid', allowInsecure: false } }, mux: { enabled: false } };
good('raw preserve', JSON.stringify(raw), o => assert.deepEqual(o, raw));
good('literal forbidden text', JSON.stringify({ protocol: 'trojan', settings: { servers: [{ address: 'example.invalid', port: 443, password: 'fake "allowInsecure":true' }] }, streamSettings: { security: 'tls' } }));
const negativeCases = [['empty', ''],
    ['multi', base + '\n' + base],
    ['empty host', `vless://${uuid}@:443`],
    ['bad port', base.replace('443', '65536')],
    ['zero port', base.replace('443', '0')],
    ['missing port', base.replace(':443', '')],
    ['bad uuid', base.replace(uuid, 'not-a-uuid')],
    ['unknown transport', base + '?type=xhttp'],
    ['plugin', base + '?plugin=anything'],
    ['duplicate query', base + '?type=ws&type=tcp'],
    ['bad percent', base + '?path=%zz'],
    ['tls flag true', base + '?security=tls&allowInsecure=true'],
    ['skip cert', base + '?security=tls&skip-cert-verify=1'],
    ['flow wrong network', base + '?type=ws&security=tls&flow=xtls-rprx-vision'],
    ['vision none', base + '?flow=xtls-rprx-vision'],
    ['wrong transport params', base + '?path=%2Ftest'],
    ['unknown key', base + '?typo=x'],
    ['trojan no tls', 'trojan://fake@example.invalid:443?security=none'],
    ['ss plugin', 'ss://aes-128-gcm:fake@example.invalid:443?plugin=obfs'],
    ['ss weak', 'ss://rc4-md5:fake@example.invalid:443'],
    ['invalid b64', 'vmess://!'],
    ['legacy vmess', 'vmess://' + uuid + '@example.invalid:443'],
    ['full config', JSON.stringify({ outbounds: [raw], inbounds: [] })],
    ['json null', 'null'],
    ['raw insecure', JSON.stringify(raw).replace('"allowInsecure":false', '"allowInsecure":true')],
    ['escaped insecure key', JSON.stringify(raw).replace('"allowInsecure":false', '"allow\\u0049nsecure":true')],
    ['nested insecure', JSON.stringify({ ...raw, mux: { enabled: false, inner: { skipCertVerify: true } } })],
    ['chain proxy', JSON.stringify({ ...raw, proxySettings: { tag: 'other' } })],
    ['nested chain', JSON.stringify({ ...raw, streamSettings: { sockopt: { dialerProxy: 'other' } } })],
    ['alter id', 'vmess://' + b64(JSON.stringify({ add: 'example.invalid', port: 443, id: uuid, aid: 4 }))],
    ['vmess unknown key', 'vmess://' + b64(JSON.stringify({ add: 'example.invalid', port: 443, id: uuid, extra: 'x' }))],
    ['raw bad uuid', JSON.stringify(raw).replace(uuid, 'invalid')],
    ['raw string port', JSON.stringify(raw).replace('"port":443', '"port":"443"')],
    ['raw empty secret', JSON.stringify({ protocol: 'trojan', settings: { servers: [{ address: 'example.invalid', port: 443, password: '' }] }, streamSettings: { security: 'tls' } })]];
for (const [name, input] of negativeCases)
    bad(name, input);
let passed = 0;
let failed = 0;
const results = [];
for (let index = 0; index < tests.length; index++) {
    try {
        results.push({ index: index + 1, name: tests[index](), passed: true });
        passed++;
    }
    catch (e) {
        // All inputs in this file are synthetic. Still keep diagnostics free of input values.
        results.push({ index: index + 1, passed: false });
        failed++;
    }
}
const report = {
    checkedAt: new Date().toISOString(),
    source: 'entry/src/main/ets/model/NodeImport.ets',
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'),
    nodeIssueSha256: crypto.createHash('sha256').update(fs.readFileSync(nodePath.join(projectRoot, 'entry/src/main/ets/model/NodeIssue.ets'))).digest('hex'),
    nodeVersion: process.version,
    typescriptVersion: ts.version,
    passed: passed, failed: failed, total: tests.length,
    scope: 'Synthetic offline parser logic: Node mocks replace SDK URL, Base64Helper and TextDecoder.',
    limitations: [
        'No actual HarmonyOS SDK API execution in this script.',
        'TypeScript transpilation does not replace the real ArkTS compiler.',
        'No Xray core validation or network connections; no real user node data.',
        'Device import and connectivity require separate validation.'
    ],
    results: results
};
const reportPath = nodePath.join(projectRoot, 'build/parser-verification.json');
fs.mkdirSync(nodePath.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
const fixturesPath = options.get('--emit-xray-fixtures');
if (fixturesPath && failed === 0) {
    fs.mkdirSync(nodePath.dirname(fixturesPath), { recursive: true });
    fs.writeFileSync(fixturesPath, JSON.stringify(coreFixtures, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ fixtures: coreFixtures.length, output: fixturesPath,
        scope: 'Fictional configurations only; no Xray core execution or network access' }));
}
console.log(JSON.stringify({ passed: passed, failed: failed, total: tests.length, report: reportPath,
    scope: 'SDK mocks; synthetic offline logic only' }));
if (failed > 0)
    process.exit(1);
