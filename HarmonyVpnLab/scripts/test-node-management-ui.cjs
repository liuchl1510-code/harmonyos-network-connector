'use strict';
// Execute real authored page methods after removing only ArkUI build/decorators.
// Real parsers and SubscriptionFetch run against in-memory catalog, HTTP stream,
// SDK, scanner and timer mocks. No private files, real HTTP, HDC, or phone interactions.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
    'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourceHashes = {};
const compiledFiles = new Map();
function compile(relative, page = false) {
    const file = path.join(project, 'entry/src/main/ets', relative);
    const original = fs.readFileSync(file, 'utf8');
    sourceHashes[relative] = crypto.createHash('sha256').update(original).digest('hex');
    let source = original;
    if (page) {
        const boundary = source.indexOf('\n  build() {');
        assert(boundary > 0, 'Page build boundary changed: ' + relative);
        source = source.slice(0, boundary) + '\n}\n';
        source = source.replace(/^@Entry\s*$/gm, '').replace(/^@Component\s*$/gm, '')
            .replace(/^(\s*)@State /gm, '$1').replace(/^struct (\w+) \{/m, 'export class $1 {');
    }
    const output = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
        reportDiagnostics: true
    });
    assert.equal(output.diagnostics.length, 0, 'SDK transpilation failed: ' + relative);
    compiledFiles.set(relative, output.outputText);
}
for (const file of ['model/NodeImport.ets', 'model/NodeBatchImport.ets', 'model/SubscriptionFetch.ets', 'model/NodeEditGuard.ets']) compile(file);
for (const file of ['pages/NodeConfig.ets', 'pages/Subscriptions.ets', 'pages/Nodes.ets']) compile(file, true);
function execute(relative, imports, timers = {}) {
    const context = { exports: {}, Error, Date, Uint8Array, ArrayBuffer, Promise, URL, TextDecoder,
        require(name) { assert(Object.hasOwn(imports, name), 'Unexpected dependency: ' + name); return imports[name]; },
        ...timers };
    vm.runInNewContext(compiledFiles.get(relative), context, { filename: relative });
    return context.exports;
}
const UUID = 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60';
const FIRST = `vless://${UUID}@example.invalid:443#${encodeURIComponent('节点一')}`;
const SECOND = 'trojan://fictional-password@example.invalid:443#second';
const TOKEN = 'synthetic-subscription-token';
const ADDRESS = 'https://subscription.invalid/list?token=' + TOKEN;
const RAW_ERROR = new Error(ADDRESS + ' native-error=synthetic-secret-body');
const clone = value => JSON.parse(JSON.stringify(value));
const sdk = {
    url: { URL: { parseURL: value => new URL(value) } },
    util: {
        Base64Helper: class { decodeSync(value) { return Buffer.from(value, 'base64'); } },
        TextDecoder: { create: (name, options) => ({ decodeToString: bytes => new TextDecoder(name, options).decode(bytes) }) }
    }
};
const single = execute('model/NodeImport.ets', { '@kit.ArkTS': sdk });
const batch = execute('model/NodeBatchImport.ets', { '@kit.ArkTS': sdk, './NodeImport': single });
const firstNode = single.parseNode(FIRST);
const secondNode = single.parseNode(SECOND);
const savedNode = (node, id = 'node-first', sourceId = '') => ({ ...clone(node), id, sourceId, modifiedAt: 1 });

function harness(options = {}) {
    const state = {
        catalog: { schemaVersion: 1, revision: 0, activeNodeId: 'node-old',
            nodes: [savedNode(firstNode, 'node-old')], subscriptions: [] },
        allowed: true, events: [], writes: [], logs: [], receipt: 0, nextId: 1,
        now: 1000, nextTimer: 1, timers: new Map(), requests: [], currentProfile: clone(firstNode),
        mode: '', readsAfterWrite: 0, scans: [], wallNow: 1789000000000,
        probeState: { phase: 'idle', kind: 'lifecycle', runId: '', detail: '', updatedAt: 1789000000000 },
        connectionStatus: undefined, command: undefined, commands: [], latencyRequests: [], latencyProofs: [],
        latencyRecords: [], hashRequests: [], vpnStarts: [], measurements: []
    };
    const timers = {
        setTimeout(callback, delay) { const id = state.nextTimer++; state.timers.set(id, { callback, delay, kind: 'timeout' }); return id; },
        clearTimeout(id) { state.timers.delete(id); },
        setInterval(callback, delay) { const id = state.nextTimer++; state.timers.set(id, { callback, delay, kind: 'interval' }); return id; },
        clearInterval(id) { state.timers.delete(id); },
        Date: class extends Date { static now() { return state.wallNow++; } }
    };
    const guard = execute('model/NodeEditGuard.ets', {
        'libvpnbridge.so': { default: { processAlive: () => true } },
        './ProbeState': { readProbeState: () => clone(state.probeState) },
        './ConnectionControl': { readConnectionStatus: () => state.connectionStatus && clone(state.connectionStatus) }
    });
    function managementAllowed() { return state.allowed && guard.isNodeManagementAllowed('synthetic-memory-only'); }
    function allowed() { if (!managementAllowed()) throw new Error('连接运行期间请先断开。'); }
    function readCatalog() {
        state.events.push('catalog-read');
        if (state.mode === 'catalog-read-error') throw new Error('safe catalog read failure');
        const value = clone(state.catalog);
        if (state.writes.length > 0) {
            state.readsAfterWrite++;
            if (state.mode === 'readback-missing') value.nodes = value.nodes.slice(0, -1);
        }
        return value;
    }
    const catalog = {
        readNodeCatalog: readCatalog,
        importManualNodes(_, nodes) {
            state.events.push('manual-write-attempt'); allowed();
            if (state.mode === 'write-error') throw new Error('safe write failure');
            let added = 0, duplicates = 0;
            for (const node of nodes) {
                if (state.catalog.nodes.some(saved => saved.outboundJson === node.outboundJson)) { duplicates++; continue; }
                state.catalog.nodes.push(savedNode(node, 'node-' + state.nextId++)); added++;
            }
            if (!state.catalog.activeNodeId && state.catalog.nodes.length) state.catalog.activeNodeId = state.catalog.nodes[0].id;
            state.events.push('manual-write'); state.writes.push('manual');
            return { added, duplicates, activeNodeId: state.catalog.activeNodeId };
        },
        saveSubscriptionWithNodes(_, id, name, address, nodes) {
            allowed();
            if (state.mode === 'write-error') throw new Error('safe subscription write failure');
            const target = id || 'source-' + state.nextId++;
            const existing = state.catalog.subscriptions.find(source => source.id === target);
            if (existing) { existing.name = name; existing.url = address; existing.lastUpdatedAt = 2; }
            else state.catalog.subscriptions.push({ id: target, name, url: address, lastUpdatedAt: 2 });
            state.catalog.nodes = state.catalog.nodes.filter(node => node.sourceId !== target);
            for (const node of nodes) state.catalog.nodes.push(savedNode(node, 'node-' + state.nextId++, target));
            state.events.push('subscription-transaction'); state.writes.push('subscription-transaction');
            return { added: nodes.length, duplicates: 0, activeNodeId: state.catalog.activeNodeId };
        },
        // Detect the retired two-write workflow instead of silently accepting it.
        saveSubscription() { throw new Error('UI used retired non-atomic saveSubscription'); },
        replaceSubscriptionNodes() { throw new Error('UI used retired non-atomic replaceSubscriptionNodes'); },
        deleteSubscription(_, id) {
            allowed(); state.catalog.subscriptions = state.catalog.subscriptions.filter(s => s.id !== id);
            state.catalog.nodes = state.catalog.nodes.filter(n => n.sourceId !== id); state.writes.push('delete-subscription');
        },
        selectCatalogNode(_, id) { allowed(); state.catalog.activeNodeId = id; state.writes.push('select'); },
        renameCatalogNode(_, id, name) {
            allowed(); const node = state.catalog.nodes.find(n => n.id === id); assert(node); node.name = name; state.writes.push('rename');
        },
        deleteCatalogNode(_, id) {
            allowed(); state.catalog.nodes = state.catalog.nodes.filter(n => n.id !== id);
            if (state.catalog.activeNodeId === id) state.catalog.activeNodeId = state.catalog.nodes[0]?.id || '';
            state.writes.push('delete');
        }
    };
    function createHttp() {
        if (options.createThrow) throw RAW_ERROR;
        const handlers = new Map();
        const request = { handlers, destroyed: 0, off: [], address: '', options: undefined };
        request.status = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
        const native = {
            on(event, callback) { handlers.set(event, callback); },
            off(event) { request.off.push(event); handlers.delete(event); },
            destroy() { request.destroyed++; if (options.destroyThrow) throw RAW_ERROR; },
            requestInStream(address, requestOptions) {
                request.address = address; request.options = requestOptions;
                if (options.requestThrow) throw RAW_ERROR;
                return request.status;
            }
        };
        request.complete = (text, status = 200) => {
            const bytes = Uint8Array.from(Buffer.from(text, 'utf8'));
            handlers.get('dataReceive')?.(bytes.buffer); handlers.get('dataEnd')?.(); request.resolve(status);
        };
        state.requests.push(request);
        return native;
    }
    const fetch = execute('model/SubscriptionFetch.ets', {
        '@kit.NetworkKit': { http: { RequestMethod: { GET: 'GET' }, createHttp } },
        '@kit.ArkTS': sdk,
        '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => state.now } }
    }, timers);
    const imports = {
        '@kit.AbilityKit': {},
        '@kit.NetworkKit': { vpnExtension: {
            startVpnExtensionAbility(want) {
                const start = { want: clone(want) }; state.vpnStarts.push(start);
                if (options.vpnThrow) return Promise.reject(RAW_ERROR);
                if (options.vpnDeferred) return new Promise((resolve, reject) => { start.resolve = resolve; start.reject = reject; });
                return Promise.resolve();
            }
        } },
        '@kit.ScanKit': {
            scanCore: { ScanType: { QR_CODE: 'QR_CODE_FIXTURE' } },
            scanBarcode: { startScanForResult(context, scanOptions) {
                const scan = { context, options: clone(scanOptions) };
                state.scans.push(scan);
                if (options.scanThrow) throw RAW_ERROR;
                return new Promise((resolve, reject) => { scan.resolve = resolve; scan.reject = reject; });
            } }
        },
        '@kit.PerformanceAnalysisKit': { hilog: { info: (...args) => state.logs.push(args) } },
        '@kit.ArkTS': { ...sdk, util: { ...sdk.util, generateRandomUUID() {
            assert(state.events.includes('manual-write'), 'Receipt created before a write');
            assert(state.events.lastIndexOf('catalog-read') > state.events.lastIndexOf('manual-write'),
                'Receipt created before read-back of the latest catalog write');
            state.events.push('receipt'); return '00000000-0000-4000-8000-' + String(++state.receipt).padStart(12, '0');
        } } },
        '../model/NodeImport': single, '../model/NodeBatchImport': batch, '../model/NodeCatalog': catalog,
        '../model/NodeEditGuard': { assertNodeManagementAllowed: allowed, isNodeManagementAllowed: managementAllowed },
        '../model/ConnectionControl': {
            ConnectionCommand: class { constructor(runId, action) { this.runId = runId; this.action = action; } },
            readConnectionCommand: () => state.command && clone(state.command),
            readConnectionStatus: () => state.connectionStatus && clone(state.connectionStatus),
            writeConnectionCommand(_, command) { state.command = clone(command); state.commands.push(clone(command)); }
        },
        '../model/ProbeState': {
            ProbeState: class {
                constructor(phase = 'idle', detail = '', runId = '', kind = 'lifecycle') {
                    this.phase = phase; this.detail = detail; this.runId = runId; this.kind = kind; this.updatedAt = state.wallNow++;
                }
            },
            readProbeState: () => clone(state.probeState),
            writeProbeState(_, value) { state.probeState = clone(value); }
        },
        '../model/NodeLatency': {
            readNodeLatencies() { if (options.recordsThrow) throw RAW_ERROR; return clone(state.latencyRecords); },
            fingerprintOutbound(outboundJson) {
                const request = { outboundJson }; state.hashRequests.push(request);
                if (options.hashThrow) return Promise.reject(RAW_ERROR);
                if (options.hashDeferred) return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
                return Promise.resolve(crypto.createHash('sha256').update(outboundJson).digest('hex'));
            },
            latencyLabel: record => record ? (record.status === 'passed' ? `HTTPS ${record.durationMs} ms` : '检测未通过') : '未检测'
        },
        '../model/LatencyProtocol': {
            LatencyRequest: class {
                constructor(runId, nodeId, outboundFingerprint) {
                    this.runId = runId; this.nodeId = nodeId; this.outboundFingerprint = outboundFingerprint; this.createdAt = state.wallNow++;
                }
            },
            writeLatencyRequest(_, request) { state.latencyRequests.push(clone(request)); },
            writeLatencyProof(_, proof) { state.latencyProofs.push(clone(proof)); }
        },
        '../model/LatencyProbe': {
            measureNodeLatency(request, current) {
                const measure = { request: clone(request), current }; state.measurements.push(measure);
                return new Promise((resolve, reject) => { measure.resolve = resolve; measure.reject = reject; });
            }
        },
        '../model/SubscriptionFetch': fetch,
        '../model/NodeProfile': {
            readNodeProfile() { state.events.push('profile-read'); return clone(state.currentProfile); },
            nodeServerAddress: node => JSON.parse(node.outboundJson).settings.vnext?.[0].address || 'example.invalid',
            updateNodeServerAddress() { allowed(); }
        }
    };
    function page(name) {
        const api = execute('pages/' + name + '.ets', imports, timers);
        const instance = new api[name]();
        instance.getUIContext = () => ({ getHostContext: () => ({ filesDir: 'synthetic-memory-only' }), getRouter: () => ({ back() {} }) });
        return instance;
    }
    return { state, page, timers };
}

function noVisibleSecrets(page, state) {
    const text = JSON.stringify({ message: page.message, previewNames: page.previewNames, logs: state.logs });
    for (const value of [ADDRESS, TOKEN, 'synthetic-secret-body', 'native-error=']) {
        assert(!text.includes(value), 'A native exception leaked into rendered state or logs');
    }
}
function casesNodeConfig() {
    const cases = [];
    const add = (name, run) => cases.push({ name: 'NodeConfig: ' + name, run });
    add('old profile is not a new receipt', () => {
        const h = harness(), p = h.page('NodeConfig'); p.saveReceipt = '保存回执：old'; p.aboutToAppear();
        assert.equal(p.saveReceipt, '尚未生成本次保存回执'); assert.match(p.message, /已保存/); assert.equal(h.state.receipt, 0);
    });
    for (const [name, text, count] of [['single node', SECOND, 1], ['multiple nodes', FIRST + '\n' + SECOND, 2]]) {
        add(name + ' generates a fresh receipt after complete read-back', () => {
            const h = harness(), p = h.page('NodeConfig'); h.state.catalog.nodes = []; h.state.catalog.activeNodeId = '';
            p.input = text; p.save();
            assert.equal(h.state.catalog.nodes.length, count); assert.match(p.saveReceipt, /^保存回执：/);
            assert.equal(p.input, ''); assert.equal(p.partialCount, 0); assert.equal(p.pendingNodes.length, 0);
            const order = h.state.events; assert(order.indexOf('receipt') > order.indexOf('manual-write'));
            assert(order.lastIndexOf('catalog-read') > order.indexOf('manual-write'));
            const old = p.saveReceipt; p.input = text; p.save(); assert.notEqual(p.saveReceipt, old);
        });
    }
    add('partial invalid input waits for explicit confirmation', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND + '\ninvalid-fixture'; p.save();
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.receipt, 0); assert.equal(p.partialCount, 1);
        assert.match(p.saveReceipt, /请确认/); assert.equal(p.pendingNodes[0].outboundJson, secondNode.outboundJson);
        p.savePartial(); assert.equal(h.state.writes.length, 1); assert.equal(h.state.receipt, 1); assert.equal(p.input, '');
    });
    add('missing one read-back node cannot report success', () => {
        const h = harness(), p = h.page('NodeConfig'); h.state.catalog.nodes = []; h.state.mode = 'readback-missing';
        p.input = FIRST + '\n' + SECOND; p.save();
        assert.equal(p.saveReceipt, '本次保存未完成'); assert.equal(h.state.receipt, 0); assert.equal(p.input, FIRST + '\n' + SECOND);
        assert.match(p.message, /读回校验/);
    });
    add('failed partial read-back cannot create a receipt', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND + '\ninvalid-fixture'; p.save();
        h.state.mode = 'readback-missing'; p.savePartial(); assert.equal(h.state.receipt, 0);
        assert.equal(p.saveReceipt, '本次保存未完成'); assert.equal(p.partialCount, 1);
    });
    for (const mode of ['write-error', 'catalog-read-error']) {
        add(mode + ' retains entered content and reports no receipt', () => {
            const h = harness(), p = h.page('NodeConfig'); h.state.mode = mode; p.input = SECOND; p.save();
            assert.equal(p.saveReceipt, '本次保存未完成'); assert.equal(p.input, SECOND); assert.equal(h.state.receipt, 0);
        });
    }
    add('all invalid content cannot write', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = 'vless://invalid-fixture'; p.save();
        assert.equal(h.state.writes.length, 0); assert.equal(p.saveReceipt, '本次保存未完成');
    });
    add('leaving clears pending input and confirmation', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND + '\ninvalid-fixture'; p.save(); p.replacementAddress = '192.0.2.1';
        p.aboutToDisappear(); assert.equal(p.input, ''); assert.equal(p.pendingNodes.length, 0); assert.equal(p.partialCount, 0);
        assert.equal(p.replacementAddress, '');
    });
    return cases;
}

function casesNodeScan() {
    const cases = [], add = (name, run) => cases.push({ name: 'NodeConfig scan: ' + name, run });
    add('uses QR-only single-result system scanner with album support', async () => {
        const h = harness(), p = h.page('NodeConfig'), before = clone(h.state.catalog);
        p.saveReceipt = '保存回执：old';
        const pending = p.scan();
        assert.equal(p.scanning, true); assert.equal(h.state.scans.length, 1);
        assert.equal(h.state.scans[0].context.filesDir, 'synthetic-memory-only');
        assert.deepEqual(h.state.scans[0].options, { scanTypes: ['QR_CODE_FIXTURE'], enableMultiMode: false, enableAlbum: true });
        h.state.scans[0].resolve({ originalValue: FIRST }); await pending;
        assert.equal(p.scanning, false); assert.equal(p.input, FIRST);
        assert.equal(p.saveReceipt, '尚未生成本次保存回执'); assert.match(p.message, /已识别 1 个可用节点/);
        assert.equal(p.partialCount, 0); assert.equal(p.pendingNodes.length, 0);
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0); assert.equal(h.state.receipt, 0);
        assert.equal(h.state.requests.length, 0); assert(!JSON.stringify(h.state.logs).includes(UUID));
        p.save(); assert.equal(h.state.writes.length, 1); assert.equal(h.state.receipt, 1); assert.equal(p.input, '');
    });
    add('scanned mixed content still requires the existing partial-import confirmation', async () => {
        const h = harness(), p = h.page('NodeConfig'); const text = SECOND + '\ninvalid-fixture';
        const pending = p.scan(); h.state.scans[0].resolve({ originalValue: text }); await pending;
        assert.equal(p.input, text); assert.equal(h.state.writes.length, 0);
        p.save(); assert.equal(h.state.writes.length, 0); assert.equal(p.partialCount, 1); assert.match(p.saveReceipt, /请确认/);
        p.savePartial(); assert.equal(h.state.writes.length, 1); assert.equal(h.state.receipt, 1);
    });
    add('Base64 QR contents use the real batch parser without automatic persistence', async () => {
        const h = harness(), p = h.page('NodeConfig'); const text = Buffer.from(FIRST + '\n' + SECOND).toString('base64');
        const pending = p.scan(); h.state.scans[0].resolve({ originalValue: text }); await pending;
        assert.equal(p.input, text); assert.match(p.message, /已识别 2 个可用节点/);
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.requests.length, 0);
    });
    add('existing nonempty input is preserved without launching scanner', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND; p.message = 'existing text';
        p.pendingNodes = [secondNode]; p.partialCount = 1; p.saveReceipt = '尚未生成本次保存回执';
        await p.scan(); assert.equal(h.state.scans.length, 0); assert.equal(p.input, SECOND); assert.equal(p.message, 'existing text');
        assert.equal(p.partialCount, 1); assert.equal(p.pendingNodes.length, 1); assert.equal(h.state.writes.length, 0);
    });
    add('duplicate scan and save are ignored while scanner is pending', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan(); const receipt = p.saveReceipt;
        await p.scan(); p.save(); assert.equal(h.state.scans.length, 1); assert.equal(h.state.writes.length, 0);
        assert.equal(p.saveReceipt, receipt); h.state.scans[0].resolve({ originalValue: SECOND }); await pending;
        assert.equal(p.input, SECOND); assert.equal(h.state.writes.length, 0);
    });
    add('connection guard refuses scanner before any native request', async () => {
        const h = harness(), p = h.page('NodeConfig'); h.state.allowed = false; await p.scan();
        assert.equal(h.state.scans.length, 0); assert.equal(p.input, ''); assert.equal(p.scanning, false);
        assert.equal(h.state.writes.length, 0); assert.match(p.message, /扫码未完成/);
    });
    add('numeric cancellation code produces fixed safe text', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan();
        h.state.scans[0].reject(Object.assign(new Error(RAW_ERROR.message), { code: 1000500002 })); await pending;
        assert.equal(p.message, '已取消扫码。'); assert.equal(p.input, ''); assert.equal(p.scanning, false);
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.requests.length, 0); noVisibleSecrets(p, h.state);
    });
    for (const mode of ['scanThrow', 'reject-error', 'reject-plain-object', 'reject-null']) {
        add(mode + ' native failure is never echoed', async () => {
            const h = harness({ scanThrow: mode === 'scanThrow' }), p = h.page('NodeConfig'); const pending = p.scan();
            if (mode === 'reject-error') h.state.scans[0].reject(RAW_ERROR);
            if (mode === 'reject-plain-object') h.state.scans[0].reject({ code: 12345, message: RAW_ERROR.message });
            if (mode === 'reject-null') h.state.scans[0].reject(null);
            await pending; assert.match(p.message, /^扫码未完成/); assert.equal(p.input, ''); assert.equal(p.scanning, false);
            assert.equal(h.state.writes.length, 0); assert.equal(h.state.requests.length, 0); noVisibleSecrets(p, h.state);
        });
    }
    for (const [name, content] of [
        ['HTTPS subscription URL', ADDRESS], ['ordinary HTTP URL', 'http://example.invalid/' + TOKEN],
        ['invalid node URL', 'vless://invalid-' + TOKEN], ['HTML', '<html>' + TOKEN + ' synthetic-secret-body</html>'],
        ['empty result', ''], ['missing originalValue', undefined], ['wrong result type', 123]
    ]) {
        add(name + ' cannot trigger HTTP or persistence', async () => {
            const h = harness(), p = h.page('NodeConfig'); const before = clone(h.state.catalog); const pending = p.scan();
            h.state.scans[0].resolve({ originalValue: content }); await pending;
            assert.equal(p.input, ''); assert.equal(p.scanning, false); assert.match(p.message, /^扫码未完成/);
            assert.equal(h.state.requests.length, 0); assert.equal(h.state.writes.length, 0); assert.deepEqual(h.state.catalog, before);
            noVisibleSecrets(p, h.state);
        });
    }
    add('late successful result after leaving cannot refill the form', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan();
        p.aboutToDisappear(); const message = p.message; h.state.scans[0].resolve({ originalValue: SECOND }); await pending;
        assert.equal(p.input, ''); assert.equal(p.message, message); assert.equal(p.scanning, false);
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.logs.length, 0);
    });
    add('late failure after leaving cannot replace a newer page message', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan();
        p.aboutToDisappear(); p.aboutToAppear(); const message = p.message; h.state.scans[0].reject(RAW_ERROR); await pending;
        assert.equal(p.input, ''); assert.equal(p.message, message); assert.equal(p.scanning, false); noVisibleSecrets(p, h.state);
    });
    add('old scan completion cannot end a newer scan or overwrite its result', async () => {
        const h = harness(), p = h.page('NodeConfig'); const old = p.scan(); p.aboutToDisappear(); p.aboutToAppear();
        const fresh = p.scan(); assert.equal(h.state.scans.length, 2);
        h.state.scans[0].resolve({ originalValue: FIRST }); await old;
        assert.equal(p.scanning, true); assert.equal(p.input, '');
        h.state.scans[1].resolve({ originalValue: SECOND }); await fresh;
        assert.equal(p.scanning, false); assert.equal(p.input, SECOND); assert.equal(h.state.writes.length, 0);
    });
    add('old scan resolving after fresh completion preserves the fresh input', async () => {
        const h = harness(), p = h.page('NodeConfig'); const old = p.scan(); p.aboutToDisappear(); p.aboutToAppear();
        const fresh = p.scan(); h.state.scans[1].resolve({ originalValue: SECOND }); await fresh;
        h.state.scans[0].resolve({ originalValue: FIRST }); await old;
        assert.equal(p.input, SECOND); assert.equal(p.scanning, false); assert.equal(h.state.writes.length, 0);
    });
    return cases;
}

function casesSubscriptions() {
    const cases = [], add = (name, run) => cases.push({ name: 'Subscriptions: ' + name, run });
    async function preview(p, h, text = FIRST + '\n' + SECOND, id = '') {
        const pending = p.preview(id, '合成订阅', ADDRESS);
        h.state.requests.at(-1).complete(text); await pending;
    }
    add('preview parses real streamed content without a catalog write', async () => {
        const h = harness(), p = h.page('Subscriptions'), before = clone(h.state.catalog);
        await preview(p, h); assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0);
        assert.equal(p.previewReady, true); assert.equal(p.pendingNodes.length, 2); assert.equal(p.busy, false);
        assert.match(p.previewNames[0], /节点一/); assert.equal(h.state.requests[0].destroyed, 1); assert.equal(h.state.timers.size, 0);
    });
    add('preview exposes rejected count for review before transactional save', async () => {
        const h = harness(), p = h.page('Subscriptions');
        await preview(p, h, FIRST + '\ninvalid-fixture'); assert.match(p.message, /1 个不支持或无效项/);
        assert.equal(h.state.writes.length, 0); p.save();
        assert.deepEqual(h.state.writes, ['subscription-transaction']); assert.equal(p.previewReady, false);
        assert.equal(p.pendingNodes.length, 0); assert.equal(p.address, ''); assert.equal(p.name, '');
    });
    add('new source and nodes are committed by one catalog transaction', async () => {
        const h = harness(), p = h.page('Subscriptions'); await preview(p, h); p.save();
        assert.deepEqual(h.state.writes, ['subscription-transaction']); assert.equal(h.state.catalog.subscriptions.length, 1);
        assert.equal(h.state.catalog.nodes.filter(node => node.sourceId).length, 2); assert.match(p.message, /订阅已保存/);
        assert.equal(h.state.catalog.activeNodeId, 'node-old'); noVisibleSecrets(p, h.state);
    });
    add('transaction failure preserves old catalog and pending confirmation', async () => {
        const h = harness(), p = h.page('Subscriptions'); await preview(p, h); const before = clone(h.state.catalog);
        h.state.mode = 'write-error'; p.save(); assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0);
        assert.equal(p.previewReady, true); assert.equal(p.pendingNodes.length, 2); assert.doesNotMatch(p.message, /订阅已保存/);
    });
    add('failed new fetch invalidates old preview but preserves saved catalog', async () => {
        const h = harness(), p = h.page('Subscriptions'); await preview(p, h); const before = clone(h.state.catalog);
        const second = p.preview('', '另一个来源', ADDRESS.replace('/list', '/changed'));
        assert.equal(p.previewReady, false); h.state.requests.at(-1).reject(RAW_ERROR); await second;
        assert.equal(p.pendingNodes.length, 0); assert.equal(p.previewReady, false); p.save();
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0); noVisibleSecrets(p, h.state);
    });
    add('late response after leaving is discarded and busy resets', async () => {
        const h = harness(), p = h.page('Subscriptions'); p.address = ADDRESS;
        const pending = p.preview(); p.aboutToDisappear(); h.state.requests[0].complete(FIRST); await pending;
        assert.equal(p.previewReady, false); assert.equal(p.pendingNodes.length, 0); assert.equal(p.address, '');
        assert.equal(p.busy, false); assert.equal(h.state.writes.length, 0);
        p.aboutToAppear(); const next = p.preview('', '再次进入', ADDRESS); assert.equal(h.state.requests.length, 2);
        h.state.requests[1].complete(SECOND); await next; assert.equal(p.pendingNodes[0].protocol, 'trojan');
    });
    add('old completion cannot overwrite a newer visit preview', async () => {
        const h = harness(), p = h.page('Subscriptions'); const old = p.preview('', '旧预览', ADDRESS);
        p.aboutToDisappear(); p.aboutToAppear(); const fresh = p.preview('', '新预览', ADDRESS);
        assert.equal(h.state.requests.length, 2); h.state.requests[1].complete(SECOND); await fresh;
        h.state.requests[0].complete(FIRST); await old;
        assert.equal(p.pendingNodes[0].protocol, 'trojan'); assert.equal(p.pendingName, '新预览'); assert.equal(p.previewReady, true);
    });
    for (const change of ['deleted', 'changed-url']) {
        add(change + ' source refuses pending commit', async () => {
            const h = harness(), p = h.page('Subscriptions');
            h.state.catalog.subscriptions = [{ id: 'source-old', name: '旧来源', url: ADDRESS, lastUpdatedAt: 1 }];
            await preview(p, h, SECOND, 'source-old');
            if (change === 'deleted') h.state.catalog.subscriptions = [];
            else h.state.catalog.subscriptions[0].url = ADDRESS + '-changed';
            const before = clone(h.state.catalog); p.save(); assert.deepEqual(h.state.catalog, before);
            assert.equal(h.state.writes.length, 0); assert.match(p.message, /发生变化/);
        });
    }
    add('unchanged existing source commits by one transaction', async () => {
        const h = harness(), p = h.page('Subscriptions');
        h.state.catalog.subscriptions = [{ id: 'source-old', name: '旧来源', url: ADDRESS, lastUpdatedAt: 1 }];
        await preview(p, h, SECOND, 'source-old'); p.save(); assert.deepEqual(h.state.writes, ['subscription-transaction']);
        assert.equal(h.state.catalog.subscriptions.length, 1); assert.equal(h.state.catalog.subscriptions[0].id, 'source-old');
    });
    add('a newly started connection blocks commit of an earlier preview', async () => {
        const h = harness(), p = h.page('Subscriptions'); await preview(p, h); h.state.allowed = false;
        const before = clone(h.state.catalog); p.save(); assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0);
        assert.equal(p.previewReady, true); assert.match(p.message, /先断开/);
    });
    add('busy preview prevents duplicate requests and commits', async () => {
        const h = harness(), p = h.page('Subscriptions'); const first = p.preview('', 'first', ADDRESS);
        await p.preview('', 'second', ADDRESS); p.save(); assert.equal(h.state.requests.length, 1); assert.equal(h.state.writes.length, 0);
        h.state.requests[0].complete(FIRST); await first; assert.equal(p.pendingName, 'first');
    });
    for (const fault of ['createThrow', 'requestThrow', 'destroyThrow', 'promiseReject']) {
        add(fault + ' native error is sanitized by Fetch before UI sees it', async () => {
            const h = harness({ [fault]: true }), p = h.page('Subscriptions'); const before = clone(h.state.catalog);
            const pending = p.preview('', '合成订阅', ADDRESS);
            if (fault === 'promiseReject') h.state.requests[0].reject(RAW_ERROR);
            if (fault === 'destroyThrow') h.state.requests[0].complete(FIRST);
            await pending; assert.match(p.message, /订阅请求失败/); noVisibleSecrets(p, h.state);
            assert.equal(p.previewReady, false); assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0);
        });
    }
    add('invalid streamed body cannot expose its private-looking payload', async () => {
        const h = harness(), p = h.page('Subscriptions');
        await preview(p, h, '<html>' + TOKEN + ' synthetic-secret-body</html>');
        assert.equal(p.previewReady, false); assert.match(p.message, /HTML/); noVisibleSecrets(p, h.state);
        assert.equal(h.state.writes.length, 0);
    });
    return cases;
}

function casesNodes() {
    const cases = [], add = (name, run) => cases.push({ name: 'Nodes: ' + name, run });
    add('load filter pagination and source labels follow real methods', () => {
        const h = harness(), p = h.page('Nodes');
        h.state.catalog.nodes = Array.from({ length: 70 }, (_, i) => savedNode(i % 2 ? firstNode : secondNode, 'id-' + i, i % 2 ? 'source-a' : ''));
        h.state.catalog.subscriptions = [{ id: 'source-a', name: '合成来源', url: ADDRESS, lastUpdatedAt: 1 }];
        p.aboutToAppear(); assert.equal(p.nodes.length, 70); assert.equal(p.visibleNodes().length, 50);
        p.limit = 100; assert.equal(p.visibleNodes().length, 70); p.search = ' TROJAN '; assert.equal(p.filtered().length, 35);
        p.search = '节点一'; assert.equal(p.filtered().length, 35); assert.equal(p.sourceName('source-a'), '合成来源');
        assert.equal(p.sourceName(''), '手动导入'); assert.equal(p.sourceName('missing'), '订阅');
    });
    add('select rename and delete reload the confirmed catalog state', () => {
        const h = harness(), p = h.page('Nodes'); h.state.catalog.nodes.push(savedNode(secondNode, 'node-second')); p.aboutToAppear();
        p.select('node-second'); assert.equal(p.activeId, 'node-second');
        p.renameId = 'node-second'; p.renameText = '改名节点'; p.rename(); assert.equal(p.renameId, ''); assert.equal(p.renameText, '');
        assert.equal(p.nodes.find(node => node.id === 'node-second').name, '改名节点');
        p.deleteId = 'node-second'; p.remove('node-second'); assert.equal(p.deleteId, ''); assert.equal(p.activeId, 'node-old');
        assert.deepEqual(h.state.writes, ['select', 'rename', 'delete']);
    });
    add('connection guard keeps all node mutations unchanged', () => {
        const h = harness(), p = h.page('Nodes'); p.aboutToAppear(); h.state.allowed = false; const before = clone(h.state.catalog);
        p.select('missing'); assert.match(p.message, /先断开/); p.renameId = 'node-old'; p.renameText = 'new'; p.rename();
        assert.match(p.message, /先断开/); p.remove('node-old'); assert.match(p.message, /先断开/);
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0);
    });
    add('page polling is single-instance and ends on hide or disappear', () => {
        const h = harness(), p = h.page('Nodes'); p.onPageShow(); p.onPageShow();
        assert.equal(h.state.timers.size, 1); h.state.allowed = false; [...h.state.timers.values()][0].callback(); assert.equal(p.editable, false);
        p.onPageHide(); assert.equal(h.state.timers.size, 0); p.onPageShow(); assert.equal(h.state.timers.size, 1);
        p.aboutToDisappear(); assert.equal(h.state.timers.size, 0);
    });
    add('catalog read failure disables editing without losing displayed nodes', () => {
        const h = harness(), p = h.page('Nodes'); p.aboutToAppear(); const before = clone(p.nodes);
        h.state.mode = 'catalog-read-error'; p.onPageShow(); assert.deepEqual(clone(p.nodes), before); assert.equal(p.editable, false);
        assert.match(p.message, /读取失败/); p.aboutToDisappear();
    });
    return cases;
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const outboundHash = value => crypto.createHash('sha256').update(value).digest('hex');
function latencyRecord(node, changes = {}) {
    return { nodeId: node.id, outboundFingerprint: outboundHash(node.outboundJson), runId: '1789000000001',
        checkedAt: 1789000000002, status: 'passed', durationMs: 321, reason: '', ...changes };
}
function activateLatency(h, p) {
    const request = h.state.latencyRequests.at(-1); assert(request);
    h.state.probeState = { ...h.state.probeState, runId: request.runId, kind: 'node-latency', phase: 'active' };
    h.state.connectionStatus = { runId: request.runId, phase: 'active', reconnectCount: 0, servicePid: 123 };
    p.pollLatency();
    return request;
}
function proofFor(request, changes = {}) {
    return { runId: request.runId, nodeId: request.nodeId, outboundFingerprint: request.outboundFingerprint,
        status: 'passed', durationMs: 321, reason: '', checkedAt: 1789000000002, ...changes };
}
function finishLatency(h, p, phase = 'stopped') {
    h.state.probeState = { ...h.state.probeState, phase };
    h.state.connectionStatus = { runId: h.state.probeState.runId, phase: 'destroyed', cleanupConfirmed: true, servicePid: 123 };
    p.pollLatency();
}

function casesNodeLatency() {
    const cases = [], add = (name, run) => cases.push({ name: 'Nodes latency: ' + name, run });
    add('temporary test targets requested node without changing selection or catalog', async () => {
        const h = harness(), p = h.page('Nodes'); h.state.catalog.nodes.push(savedNode(secondNode, 'node-second'));
        p.aboutToAppear(); const before = clone(h.state.catalog);
        await p.startLatency('node-second');
        assert.deepEqual(h.state.catalog, before); assert.equal(p.activeId, 'node-old');
        assert.equal(h.state.latencyRequests.length, 1); assert.equal(h.state.vpnStarts.length, 1);
        assert.equal(h.state.latencyRequests[0].nodeId, 'node-second');
        assert.equal(h.state.latencyRequests[0].outboundFingerprint, outboundHash(secondNode.outboundJson));
        assert.equal(h.state.vpnStarts[0].want.parameters.kind, 'node-latency');
        assert.equal(h.state.commands[0].action, 'start'); assert.equal(h.state.writes.length, 0);
        assert.equal(p.testingId, 'node-second'); assert.equal(p.editable, false);
        assert.equal(h.state.measurements.length, 0); assert.match(p.latencyText('node-second'), /准备检测/);
        noVisibleSecrets(p, h.state);
    });
    for (const change of ['outbound-changed', 'node-deleted', 'connection-started', 'page-destroyed']) {
        add(change + ' during async hash cannot write request or start VPN', async () => {
            const h = harness({ hashDeferred: true }), p = h.page('Nodes'); p.aboutToAppear();
            const pending = p.startLatency('node-old'); assert.equal(p.preparing, true);
            assert.equal(h.state.hashRequests.length, 1);
            if (change === 'outbound-changed') h.state.catalog.nodes[0].outboundJson = secondNode.outboundJson;
            if (change === 'node-deleted') h.state.catalog.nodes = [];
            if (change === 'connection-started') h.state.allowed = false;
            if (change === 'page-destroyed') p.aboutToDisappear();
            h.state.hashRequests[0].resolve(outboundHash(firstNode.outboundJson)); await pending;
            assert.equal(h.state.vpnStarts.length, 0); assert.equal(h.state.latencyRequests.length, 0);
            assert.equal(h.state.commands.length, 0); assert.equal(h.state.writes.length, 0);
            if (change !== 'page-destroyed') assert.equal(p.preparing, false);
        });
    }
    add('duplicate start is ignored while fingerprint or VPN request is pending', async () => {
        const h = harness({ hashDeferred: true }), p = h.page('Nodes'); p.aboutToAppear();
        const pending = p.startLatency('node-old'); await p.startLatency('node-old');
        assert.equal(h.state.hashRequests.length, 1);
        h.state.hashRequests[0].resolve(outboundHash(firstNode.outboundJson)); await pending;
        await p.startLatency('node-old'); assert.equal(h.state.vpnStarts.length, 1);
    });
    add('successful probe writes matching proof exactly once and waits for service cleanup', async () => {
        const h = harness(), p = h.page('Nodes'); p.aboutToAppear(); await p.startLatency('node-old');
        const request = activateLatency(h, p); p.pollLatency(); p.pollLatency();
        assert.equal(h.state.measurements.length, 1); assert.equal(h.state.measurements[0].current(), true);
        assert.match(p.latencyText('node-old'), /检测 HTTPS/);
        const proof = proofFor(request); h.state.measurements[0].resolve(proof); await flush();
        assert.deepEqual(h.state.latencyProofs, [proof]); assert.equal(p.testingId, 'node-old'); assert.equal(p.editable, false);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])]; finishLatency(h, p); await flush();
        assert.equal(p.testingId, ''); assert.equal(p.editable, true); assert.match(p.latencyText('node-old'), /^HTTPS 321 ms/);
        assert.equal(h.state.catalog.activeNodeId, 'node-old'); assert.equal(h.state.writes.length, 0);
    });
    add('negative HTTPS proof retains failure classification instead of successful zero latency', async () => {
        const h = harness(), p = h.page('Nodes'); await p.startLatency('node-old');
        const request = activateLatency(h, p), proof = proofFor(request, { status: 'failed', durationMs: 0, reason: 'https' });
        h.state.measurements[0].resolve(proof); await flush();
        assert.deepEqual(h.state.latencyProofs, [proof]); assert.equal(h.state.latencyProofs[0].status, 'failed');
    });
    for (const change of ['cancel', 'page-destroyed', 'recovery', 'network-recovered', 'foreign-run', 'foreign-command', 'stop-command', 'foreign-kind']) {
        add(change + ' invalidates in-flight probe and its late proof', async () => {
            const h = harness(), p = h.page('Nodes'); await p.startLatency('node-old');
            const request = activateLatency(h, p), measure = h.state.measurements[0];
            if (change === 'cancel') p.cancelLatency();
            if (change === 'page-destroyed') p.aboutToDisappear();
            if (change === 'recovery') h.state.connectionStatus.phase = 'recovering';
            if (change === 'network-recovered') h.state.connectionStatus.reconnectCount = 1;
            if (change === 'foreign-run') h.state.probeState.runId = '1789000999999';
            if (change === 'foreign-command') h.state.command.runId = '1789000999999';
            if (change === 'stop-command') h.state.command.action = 'stop';
            if (change === 'foreign-kind') h.state.probeState.kind = 'connection';
            assert.equal(measure.current(), false); measure.resolve(proofFor(request)); await flush();
            assert.equal(h.state.latencyProofs.length, 0); assert.equal(h.state.writes.length, 0);
            if (['cancel', 'page-destroyed'].includes(change)) assert.equal(h.state.command.action, 'stop');
        });
    }
    add('cancelled old probe cannot submit into a subsequent new test', async () => {
        const h = harness(), p = h.page('Nodes'); await p.startLatency('node-old');
        const first = activateLatency(h, p), old = h.state.measurements[0]; p.cancelLatency(); finishLatency(h, p);
        await p.startLatency('node-old'); const second = activateLatency(h, p);
        assert.notEqual(first.runId, second.runId); assert.equal(h.state.measurements.length, 2);
        old.resolve(proofFor(first)); await flush(); assert.equal(h.state.latencyProofs.length, 0);
        h.state.measurements[1].resolve(proofFor(second)); await flush();
        assert.deepEqual(h.state.latencyProofs.map(proof => proof.runId), [second.runId]);
    });
    add('rejected VPN authorization unlocks retry without changing selected node', async () => {
        const h = harness({ vpnDeferred: true }), p = h.page('Nodes'); p.aboutToAppear();
        const first = p.startLatency('node-old'); await flush(); assert.equal(h.state.vpnStarts.length, 1);
        h.state.vpnStarts[0].reject(RAW_ERROR); await first;
        assert.equal(p.preparing, false); assert.equal(p.testingId, ''); assert.equal(p.editable, true);
        assert.equal(h.state.probeState.phase, 'failed'); assert.equal(h.state.command.action, 'stop');
        const second = p.startLatency('node-old'); await flush(); assert.equal(h.state.vpnStarts.length, 2);
        h.state.vpnStarts[1].resolve(); await second;
        assert.equal(p.testingId, 'node-old'); assert.equal(h.state.writes.length, 0); noVisibleSecrets(p, h.state);
    });
    add('cancel during pending VPN start cleans up late rejection without touching a later run', async () => {
        const h = harness({ vpnDeferred: true }), p = h.page('Nodes');
        const pending = p.startLatency('node-old'); await flush();
        const firstId = h.state.latencyRequests[0].runId;
        p.cancelLatency(); const cancellationMessage = p.message;
        h.state.vpnStarts[0].reject(RAW_ERROR); await pending;
        assert.equal(h.state.probeState.runId, firstId); assert.equal(h.state.probeState.phase, 'failed');
        assert.equal(h.state.command.action, 'stop'); assert.equal(p.message, cancellationMessage);
        p.pollLatency(); assert.equal(p.testingId, ''); assert.equal(p.editable, true);
        const retry = p.startLatency('node-old'); await flush(); assert.equal(h.state.vpnStarts.length, 2);
        h.state.vpnStarts[1].resolve(); await retry; assert.equal(p.testingId, 'node-old');

        // If cleanup has already allowed another test, the first attempt's
        // closure must still identify only its own run when its API rejects.
        const other = harness({ vpnDeferred: true }), q = other.page('Nodes');
        const old = q.startLatency('node-old'); await flush(); q.cancelLatency(); finishLatency(other, q);
        const current = q.startLatency('node-old'); await flush();
        const currentState = clone(other.state.probeState), currentCommand = clone(other.state.command);
        const commandCount = other.state.commands.length;
        other.state.vpnStarts[0].reject(RAW_ERROR); await old;
        assert.deepEqual(other.state.probeState, currentState); assert.deepEqual(other.state.command, currentCommand);
        assert.equal(other.state.commands.length, commandCount);
        other.state.vpnStarts[1].resolve(); await current; noVisibleSecrets(q, other.state);
    });
    add('hash failure before request leaves a safe retry state', async () => {
        const h = harness({ hashThrow: true }), p = h.page('Nodes'); await p.startLatency('node-old');
        assert.equal(p.preparing, false); assert.equal(p.testingId, ''); assert.equal(p.editable, true);
        assert.equal(h.state.vpnStarts.length, 0); assert.equal(h.state.commands.length, 0); noVisibleSecrets(p, h.state);
    });
    add('unexpected measurement rejection cancels the temporary VPN without exposing exception', async () => {
        const h = harness(), p = h.page('Nodes'); await p.startLatency('node-old'); activateLatency(h, p);
        h.state.measurements[0].reject(RAW_ERROR); await flush();
        assert.equal(h.state.command.action, 'stop'); assert.equal(h.state.latencyProofs.length, 0); noVisibleSecrets(p, h.state);
    });
    add('records are shown only when node id and current outbound hash match', async () => {
        const h = harness(), p = h.page('Nodes'); h.state.catalog.nodes.push(savedNode(secondNode, 'node-second'));
        p.nodes = clone(h.state.catalog.nodes);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0]),
            latencyRecord(h.state.catalog.nodes[1], { outboundFingerprint: '0'.repeat(64) }),
            latencyRecord(h.state.catalog.nodes[0], { nodeId: 'deleted-node' })];
        await p.refreshLatencies();
        assert.deepEqual(clone(p.latencies).map(record => record.nodeId), ['node-old']);
        assert.match(p.latencyText('node-old'), /^HTTPS 321 ms/); assert.equal(p.latencyText('node-second'), '未检测');
        assert.equal(p.latencyText('deleted-node'), '未检测');
    });
    add('configuration refresh hides previous result before asynchronous hash finishes', async () => {
        const h = harness({ hashDeferred: true }), p = h.page('Nodes');
        const old = latencyRecord(h.state.catalog.nodes[0]);
        p.nodes = clone(h.state.catalog.nodes); p.latencies = [old];
        assert.match(p.latencyText('node-old'), /^HTTPS 321 ms/);
        h.state.catalog.nodes[0].outboundJson = secondNode.outboundJson;
        p.nodes = clone(h.state.catalog.nodes); h.state.latencyRecords = [old];
        const pending = p.refreshLatencies();
        assert.equal(h.state.hashRequests.length, 1); assert.equal(p.latencies.length, 0);
        assert.equal(p.latencyText('node-old'), '未检测');
        h.state.hashRequests[0].resolve(outboundHash(secondNode.outboundJson)); await pending;
        assert.equal(p.latencyText('node-old'), '未检测'); assert.equal(p.latencies.length, 0);
    });
    add('late record refresh cannot replace a newer refresh or repopulate destroyed page', async () => {
        const h = harness({ hashDeferred: true }), p = h.page('Nodes'); p.nodes = clone(h.state.catalog.nodes);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])];
        const old = p.refreshLatencies(); h.state.latencyRecords = [];
        await p.refreshLatencies(); h.state.hashRequests[0].resolve(outboundHash(firstNode.outboundJson)); await old;
        assert.equal(p.latencies.length, 0);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])]; const destroyed = p.refreshLatencies();
        p.aboutToDisappear(); h.state.hashRequests[1].resolve(outboundHash(firstNode.outboundJson)); await destroyed;
        assert.equal(p.latencies.length, 0);
    });
    add('unreadable result history preserves catalog and shows fixed error', async () => {
        const h = harness({ recordsThrow: true }), p = h.page('Nodes'); const before = clone(h.state.catalog);
        p.reload(); await flush(); assert.equal(p.latencies.length, 0);
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0); noVisibleSecrets(p, h.state);
        assert.match(p.message, /历史检测记录无法读取/);
    });
    return cases;
}

function runNodeConfigReceiptTests() {
    const cases = casesNodeConfig();
    for (const test of cases) test.run();
    return cases.length;
}
async function main() {
    const passed = [], failed = [];
    for (const test of [...casesNodeConfig(), ...casesNodeScan(), ...casesSubscriptions(), ...casesNodes(), ...casesNodeLatency()]) {
        try { await test.run(); passed.push(test.name); }
        catch (error) { failed.push({ name: test.name, error: error.message }); }
    }
    const record = { generatedAt: new Date().toISOString(), passed: passed.length, failed: failed.length, sourceHashes,
        scope: 'Real ArkTS methods/parsers/fetcher/NodeEditGuard, SDK transpilation, synthetic catalog/HTTP/scanner/timers/VPN state and deferred latency dependencies; not a device result.',
        tests: passed, failures: failed };
    const output = path.join(project, 'build/node-management-ui-verification.json');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed, record: output }));
    if (failed.length) process.exitCode = 1;
}
module.exports = { runNodeConfigReceiptTests };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
