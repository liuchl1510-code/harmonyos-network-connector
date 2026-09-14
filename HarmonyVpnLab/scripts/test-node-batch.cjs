// Offline tests of the authored batch importer and the real single-node parser.
// SDK Base64 and UTF-8 operations are replaced by Node APIs, so a passing result
// does not replace an ArkTS build or a HarmonyOS device check. Fictional data only.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const { loadNodeImporter } = require('./node-import-loader.cjs');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourcePath = path.resolve(__dirname, '../entry/src/main/ets/model/NodeBatchImport.ets');
const original = fs.readFileSync(sourcePath, 'utf8');
const importLine = "import { util } from '@kit.ArkTS';";
assert(original.includes(importLine));
const shim = `const util = {
  Base64Helper: class { decodeSync(value: string): Uint8Array { return Buffer.from(value, 'base64'); } },
  TextDecoder: { create: (name: string, options: Object): Object => ({
    decodeToString: (bytes: Uint8Array): string => new TextDecoder(name, options).decode(bytes)
  }) }
};`;
const compiled = ts.transpileModule(original.replace(importLine, shim), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true
});
assert.equal(compiled.diagnostics.length, 0);
const importer = loadNodeImporter();
const parser = importer.parser.parseNode;
const loaded = new Module(sourcePath);
loaded.require = name => {
    if (name === './NodeIssue') return importer.issues;
    assert.equal(name, './NodeImport', 'Unexpected batch importer dependency');
    return { parseNode: parser };
};
loaded._compile(compiled.outputText, sourcePath);
const parse = loaded.exports.parseNodeBatch;
const uuid = 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60';
const first = `vless://${uuid}@example.invalid:443#${encodeURIComponent('中文节点')}`;
const second = 'trojan://fictional-password@example.invalid:443#second';
const ss = 'ss://aes-128-gcm:fictional-password@example.invalid:8388#third';
const vmess = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: '测试 VMess', add: 'example.invalid',
    port: '443', id: uuid, aid: '0', net: 'tcp', type: 'none' })).toString('base64');
const base64 = value => Buffer.from(value).toString('base64');
const tests = [];
function good(name, text, expected, check) {
    tests.push(() => {
        const result = parse(text);
        assert(result instanceof loaded.exports.BatchImportResult);
        assert.deepEqual([result.nodes.length, result.rejected, result.duplicates, result.total], expected);
        assert.equal(result.total, result.nodes.length + result.rejected + result.duplicates);
        check?.(result);
        return name;
    });
}
function bad(name, text, pattern) {
    tests.push(() => {
        let error;
        try { parse(text); } catch (e) { error = e; }
        assert(error instanceof Error, 'Input unexpectedly accepted: ' + name);
        assert(!error.message.includes(uuid));
        assert(!error.message.includes('example.invalid'));
        assert(!error.message.includes('fictional-password'));
        const issue = importer.issues.nodeIssueFromError(error);
        if (pattern) assert.match(issue ? importer.issues.formatNodeIssue(issue) : error.message, pattern);
        return name;
    });
}
good('four supported protocols and Chinese names', [first, second, ss, vmess].join('\n'), [4, 0, 0, 4], r => {
    assert.deepEqual(r.nodes.map(n => n.protocol), ['vless', 'trojan', 'shadowsocks', 'vmess']);
    assert.equal(r.nodes[0].name, '中文节点');
    assert.equal(r.nodes[3].name, '测试 VMess');
});
good('CRLF with blank lines', '\r\n' + first + '\r\n\r\n\t' + second + '  \r\n', [2, 0, 0, 2]);
good('CR line endings', first + '\r' + second, [2, 0, 0, 2]);
good('UTF-8 BOM', '\ufeff' + first, [1, 0, 0, 1]);
good('invalid entries require explicit review', first + '\ninvalid-secret-line\n' + second.replace(':443', ':0'), [1, 2, 0, 3]);
good('unknown protocol rejected within mixed list', first + '\nhysteria2://fictional-password@example.invalid:443', [1, 1, 0, 2]);
good('unknown header is counted instead of mislabeled YAML', 'subscription-note: fictional\n' + first, [1, 1, 0, 2]);
good('exact outbound duplicates retain first name', first + '\n' + first.replace(/#.*$/, '#other') + '\n' + second, [2, 0, 1, 3], r => {
    assert.equal(r.nodes[0].name, '中文节点');
});
good('standard Base64', base64(first + '\n' + second), [2, 0, 0, 2]);
good('standard Base64 without padding', base64(first + '\n' + second).replace(/=+$/, ''), [2, 0, 0, 2]);
good('Base64 wraps across ASCII whitespace', base64(first + '\n' + vmess).match(/.{1,19}/g).join(' \t\r\n'), [2, 0, 0, 2]);
const unicodeNameLink = first.replace(/#.*$/, '#测试𐀿');
const urlSafe = Buffer.from(unicodeNameLink).toString('base64url');
assert(/[-_]/.test(urlSafe), 'URL-safe fixture must actually use that alphabet');
good('URL-safe Base64 with Unicode text', urlSafe, [1, 0, 0, 1], r => assert.equal(r.nodes[0].name, '测试𐀿'));
good('padded URL-safe Base64', urlSafe + '='.repeat((4 - urlSafe.length % 4) % 4), [1, 0, 0, 1]);
good('Base64 mixed valid and invalid preserves count', base64(first + '\nnot-a-node'), [1, 1, 0, 2]);
const outbound = JSON.parse(parser(first).outboundJson);
outbound.tag = 'JSON 中文';
good('single pretty-printed outbound JSON', JSON.stringify(outbound, null, 2), [1, 0, 0, 1], r => assert.equal(r.nodes[0].name, 'JSON 中文'));
good('500 entries', Array(500).fill(first).join('\n'), [1, 0, 499, 500]);
good('64 KiB single share link boundary', first.replace(/#.*$/, '#') + 'a'.repeat(65536 - Buffer.byteLength(first.replace(/#.*$/, '#'))), [1, 0, 0, 1]);
good('oversize single entry contributes rejected count', first + '\n' + second + 'a'.repeat(65536), [1, 1, 0, 2]);
good('UTF-8 byte limit is not character limit', first + '\n' + second + '中'.repeat(22000), [1, 1, 0, 2]);
good('1 MiB total boundary includes surrounding whitespace', first + ' '.repeat(1048576 - Buffer.byteLength(first)), [1, 0, 0, 1]);
bad('empty', '', /尚未填写/);
bad('whitespace only', ' \r\n\t', /尚未填写/);
bad('all invalid links', second.replace(':443', ':0') + '\n' + first.replace(uuid, 'fictional-bad-id'), /未找到/);
bad('501 lines', Array(501).fill(first).join('\n'), /500/);
bad('501 decoded lines', base64(Array(501).fill(first).join('\n')), /500/);
bad('interior blank lines cannot evade line limit', first + '\n'.repeat(501) + second, /500/);
bad('more than 1 MiB ASCII', 'a'.repeat(1048577), /大小限制/);
bad('more than 1 MiB UTF-8', '中'.repeat(349526), /大小限制/);
bad('oversize JSON', JSON.stringify({ ...outbound, tag: 'a'.repeat(65536) }), /64 KiB/);
bad('malformed JSON not split into links', '{\n' + first + '\n}', /JSON/);
bad('JSON array not split into links', '[\n' + first + '\n]', /JSON/);
bad('whole Xray document rejected', JSON.stringify({ outbounds: [outbound] }), /JSON/);
bad('Clash YAML', 'proxies:\n  - name: fictional\n    type: vless', /YAML/);
bad('YAML with share text not extracted', 'proxies:\n' + first, /YAML/);
bad('YAML document marker', '---\nproxies: []', /YAML/);
bad('YAML preceded by comments', '# fictional subscription\nproxies: []', /YAML/);
bad('Base64 Clash YAML', base64('proxies:\n  - name: fictional'), /YAML/);
bad('HTML', '<!DOCTYPE html><html>Login required</html>', /HTML/);
bad('Base64 HTML', base64('<html><body>Login required</body></html>'), /HTML/);
bad('HTML inside mixed list rejected', first + '\n<html>Login required</html>', /HTML/);
bad('plain binary NUL', first + '\u0000', /控制字符/);
bad('decoded binary NUL', Buffer.from([0, 1, 2, 3]).toString('base64'), /控制字符/);
bad('invalid UTF-8 bytes', Buffer.from([0xc0, 0xaf]).toString('base64'), /UTF-8/);
bad('UTF-8 encoded surrogate', Buffer.from([0xed, 0xa0, 0x80]).toString('base64'), /UTF-8/);
bad('unpaired input surrogate', first + '\ud800', /控制字符/);
bad('C1 controls', first + '\u0085', /控制字符/);
bad('invalid Base64 alphabet', '@@@!', /Base64/);
bad('internal Base64 padding', 'YW=Jj', /Base64/);
bad('too much Base64 padding', 'YQ===', /Base64/);
bad('wrong Base64 padding length', 'YQ=', /Base64/);
bad('Base64 impossible length', 'A', /Base64/);
bad('Base64 nonzero four padding bits', 'YR==', /Base64/);
bad('Base64 nonzero two padding bits', 'YWJ=', /Base64/);
bad('mixed Base64 alphabets', 'AA+_', /Base64/);
bad('Unicode whitespace inside Base64', base64(first).slice(0, 4) + '\u00a0' + base64(first).slice(4), /Base64/);
bad('double Base64 wrapper is not recursively decoded', base64(base64(first)), /未找到/);
bad('Base64 of outbound JSON is not share-list format', base64(JSON.stringify(outbound)), /JSON/);
bad('Base64 malformed JSON not split into links', base64('{\n' + first + '\n}'), /JSON/);
bad('Base64 malformed JSON array not split into links', base64('[\n' + first + '\n]'), /JSON/);

const passed = tests.map(test => test());
const record = {
    generatedAt: new Date().toISOString(), passed: passed.length, failed: 0,
    sourceSha256: crypto.createHash('sha256').update(original).digest('hex'),
    singleParserSha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,
        '../entry/src/main/ets/model/NodeImport.ets'))).digest('hex'),
    nodeIssueSha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,
        '../entry/src/main/ets/model/NodeIssue.ets'))).digest('hex'),
    fixturePolicy: 'fictional-only; offline; SDK shims; not a device result', tests: passed
};
const recordPath = path.resolve(__dirname, '../build/node-batch-verification.json');
fs.mkdirSync(path.dirname(recordPath), { recursive: true });
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ passed: record.passed, failed: record.failed, record: recordPath }));
