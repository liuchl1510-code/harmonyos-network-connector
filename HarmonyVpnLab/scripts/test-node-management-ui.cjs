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
const nodePerformance = {};
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
            .replace(/^(\s*)@State /gm, '$1').replace(/@StorageProp\([^)]*\)\s*/g, '')
            .replace(/^struct (\w+) \{/m, 'export class $1 {');
    }
    const output = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
        reportDiagnostics: true
    });
    assert.equal(output.diagnostics.length, 0, 'SDK transpilation failed: ' + relative);
    compiledFiles.set(relative, output.outputText);
}
for (const file of ['model/NodeImport.ets', 'model/NodeBatchImport.ets', 'model/SubscriptionFetch.ets', 'model/NodeEditGuard.ets', 'model/BatchLatency.ets', 'model/NodeScanner.ets', 'model/AdaptiveLayout.ets', 'model/NodeListFilter.ets', 'model/NodeListNavigation.ets']) compile(file);
for (const file of ['pages/NodeConfig.ets', 'pages/Subscriptions.ets', 'pages/Nodes.ets']) compile(file, true);
function execute(relative, imports, timers = {}) {
    const context = { VPN_CORE_AVAILABLE: true, exports: {}, Error, Date, Uint8Array, ArrayBuffer, Promise, URL, TextDecoder, $r: name => name,
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
const batchLatency = execute('model/BatchLatency.ets', {});
const adaptiveLayout = execute('model/AdaptiveLayout.ets', {});
const nodeListFilter = execute('model/NodeListFilter.ets', {});
const nodeListNavigation = execute('model/NodeListNavigation.ets', {});
const firstNode = single.parseNode(FIRST);
const secondNode = single.parseNode(SECOND);
const savedNode = (node, id = 'node-first', sourceId = '') => ({ ...clone(node), id, sourceId, modifiedAt: 1, favorite: false });

function harness(options = {}) {
    const state = {
        catalog: { schemaVersion: 1, revision: 0, activeNodeId: 'node-old',
            nodes: [savedNode(firstNode, 'node-old')], subscriptions: [] },
        allowed: true, events: [], writes: [], logs: [], receipt: 0, nextId: 1,
        now: 1000, nextTimer: 1, timers: new Map(), requests: [], currentProfile: clone(firstNode),
        mode: '', readsAfterWrite: 0, scans: [], scannerModuleLoads: 0, capabilityChecks: 0, wallNow: 1789000000000,
        probeState: { phase: 'idle', kind: 'lifecycle', runId: '', detail: '', updatedAt: 1789000000000 },
        connectionStatus: undefined, command: undefined, commands: [], latencyRequests: [], latencyProofs: [],
        latencyRecords: [], latencyReads: 0, hashRequests: [], vpnStarts: [], measurements: [], processAlive: true, processCheckThrows: false,
        dialogs: [], backs: 0, backThrows: false, profileReadsThrow: false, addressWrites: 0, routeParams: {}, routes: []
    };
    const timers = {
        setTimeout(callback, delay) { const id = state.nextTimer++; state.timers.set(id, { callback, delay, kind: 'timeout' }); return id; },
        clearTimeout(id) { state.timers.delete(id); },
        setInterval(callback, delay) { const id = state.nextTimer++; state.timers.set(id, { callback, delay, kind: 'interval' }); return id; },
        clearInterval(id) { state.timers.delete(id); },
        Date: class extends Date { static now() { return state.wallNow++; } }
    };
    const guard = execute('model/NodeEditGuard.ets', {
        'libvpnbridge.so': { default: { processAlive: () => { if (state.processCheckThrows) throw RAW_ERROR; return state.processAlive; } } },
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
            if (state.mode === 'raw-write-error') throw RAW_ERROR;
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
        selectCatalogNode(_, id) { allowed(); state.catalog.activeNodeId = id; state.writes.push('select'); if(options.mutationReadbackError)state.mode='catalog-read-error'; },
        setCatalogNodeFavorite(_, id, favorite) {
            allowed(); const node = state.catalog.nodes.find(n => n.id === id); assert(node);
            if (state.mode === 'write-error') throw RAW_ERROR;
            node.favorite = favorite; state.writes.push('favorite'); if(options.mutationReadbackError)state.mode='catalog-read-error';
        },
        renameCatalogNode(_, id, name) {
            allowed(); const node = state.catalog.nodes.find(n => n.id === id); assert(node); node.name = name; state.writes.push('rename'); if(options.mutationReadbackError)state.mode='catalog-read-error';
        },
        deleteCatalogNode(_, id) {
            allowed(); state.catalog.nodes = state.catalog.nodes.filter(n => n.id !== id);
            if (state.catalog.activeNodeId === id) state.catalog.activeNodeId = state.catalog.nodes[0]?.id || '';
            state.writes.push('delete');
            if(options.mutationReadbackError)state.mode='catalog-read-error';
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
        'libvpnbridge.so': { default: { processAlive: () => { if (state.processCheckThrows) throw RAW_ERROR; return state.processAlive; } } },
        '../model/BatchLatency': batchLatency,
        '../model/AdaptiveLayout': adaptiveLayout,
        '../model/NodeListFilter': nodeListFilter,
        '../model/NodeListNavigation': nodeListNavigation,
        '../model/BuildCapabilities': { VPN_CORE_AVAILABLE: true },
        '@kit.AbilityKit': {},
        '@kit.ArkUI': { router: { RouterMode: { Single: 1 } } },
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
        '@kit.PerformanceAnalysisKit': { hilog: { info: (...args) => { if (options.logThrows) throw RAW_ERROR; state.logs.push(args); } } },
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
            readNodeLatencies() { state.latencyReads++; if (options.recordsThrow) throw RAW_ERROR; return clone(state.latencyRecords); },
            fingerprintOutbound(outboundJson) {
                const request = { outboundJson }; state.hashRequests.push(request);
                if (options.hashThrow) return Promise.reject(RAW_ERROR);
                if (options.hashDeferred) return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
                return Promise.resolve(crypto.createHash('sha256').update(outboundJson).digest('hex'));
            },
            latencyLabel: record => record ? (record.status === 'passed' ? `首次 HTTPS ${record.durationMs} ms` : '检测未通过') : '未检测',
            latencySecondaryLabel: record => record?.status !== 'passed' ? '' : record.measurementVersion !== 2 ? '复用延迟 未检测（旧记录）' :
                record.secondStatus === 'failed' ? (record.secondReason === 'timeout' ? '复用检测超时' : '复用检测未通过') :
                record.secondConnection === 'reused' ? `复用延迟 ${record.secondDurationMs} ms` :
                `再次 HTTPS ${record.secondDurationMs} ms（${record.secondConnection === 'new' ? '新建连接' : '复用未确认'}）`
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
            readNodeProfile() { state.events.push('profile-read'); if (state.profileReadsThrow) throw RAW_ERROR; return clone(state.currentProfile); },
            nodeServerAddress: node => JSON.parse(node.outboundJson).settings.vnext?.[0].address || 'example.invalid',
            updateNodeServerAddress(_, address) {
                allowed(); if (state.mode === 'raw-address-error') throw RAW_ERROR;
                state.addressWrites++;
                const outbound = JSON.parse(state.currentProfile.outboundJson); outbound.settings.vnext[0].address = address.trim();
                state.currentProfile.outboundJson = JSON.stringify(outbound);
                if (state.mode === 'address-readback-error') state.profileReadsThrow = true;
            }
        }
    };
    let scannerModule;
    Object.defineProperty(imports, '../model/NodeScanner', { get() {
        state.scannerModuleLoads++;
        if (options.scannerModuleThrows) throw RAW_ERROR;
        scannerModule ??= execute('model/NodeScanner.ets', {
            '@kit.AbilityKit': {}, '@kit.ScanKit': imports['@kit.ScanKit']
        });
        return scannerModule;
    } });
    function page(name) {
        const api = execute('pages/' + name + '.ets', imports, { ...timers, canIUse(capability) {
            state.capabilityChecks++;
            assert.equal(capability, 'SystemCapability.Multimedia.Scan.ScanBarcode');
            if (options.capabilityThrows) throw RAW_ERROR;
            return options.scanCapability !== false;
        } });
        const instance = new api[name]();
        instance.getUIContext = () => ({ getHostContext: () => ({ filesDir: 'synthetic-memory-only' }),
            getRouter: () => ({ getParams: () => state.routeParams,
                replaceUrl(options, mode) { state.routes.push({ options: clone(options), mode }); return Promise.resolve(); },
                back() { if (state.backThrows) throw RAW_ERROR; state.backs++; } }),
            getPromptAction: () => ({ showDialog(options) {
                const dialog = { options }; state.dialogs.push(dialog);
                return new Promise((resolve, reject) => { dialog.resolve = resolve; dialog.reject = reject; });
            } }) });
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

function casesNodeForm() {
    const cases = [], add = (name, run) => cases.push({ name: 'NodeConfig form: ' + name, run });
    add('clean return needs no dialog and double return does not navigate twice', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear();
        assert.equal(p.onBackPress(), false); await p.requestBack(); await p.requestBack();
        assert.equal(h.state.backs, 1); assert.equal(h.state.dialogs.length, 0);
    });
    for (const field of ['input', 'replacementAddress']) add(field + ' stays intact when return is declined', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); p[field] = field === 'input' ? SECOND : 'changed.invalid';
        const before = clone(h.state.catalog), pending = p.requestBack();
        assert.equal(p.confirmingLeave, true); await p.requestBack(); assert.equal(h.state.dialogs.length, 1);
        assert(!JSON.stringify(h.state.dialogs[0].options).includes(p[field]));
        h.state.dialogs[0].resolve({ index: 0 }); await pending;
        assert(p[field].length > 0); assert.equal(p.confirmingLeave, false); assert.equal(h.state.backs, 0);
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0);
    });
    add('system return consumes dirty back and preserves partial preview until confirmed', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); p.input = SECOND + '\ninvalid-fixture'; p.save();
        assert.equal(p.onBackPress(), true); assert.equal(p.onBackPress(), true); assert.equal(h.state.dialogs.length, 1);
        assert.equal(p.partialCount, 1); h.state.dialogs[0].resolve({ index: 1 }); await flush();
        assert.equal(h.state.backs, 1); assert.equal(p.input, ''); assert.equal(p.pendingNodes.length, 0);
        assert.equal(h.state.writes.length, 0);
    });
    for (const failure of ['dialog', 'router']) add(failure + ' failure keeps all input and exposes no raw error', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); p.input = SECOND; p.replacementAddress = 'changed.invalid';
        const pending = p.requestBack();
        if (failure === 'dialog') h.state.dialogs[0].reject(RAW_ERROR);
        else { h.state.backThrows = true; h.state.dialogs[0].resolve({ index: 1 }); }
        await pending; assert.equal(p.input, SECOND); assert.equal(p.replacementAddress, 'changed.invalid');
        assert.equal(p.confirmingLeave, false); assert.equal(p.leaving, false); noVisibleSecrets(p, h.state);
    });
    add('pending confirmation blocks save partial save address update and scanner', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND + '\ninvalid-fixture'; p.save();
        p.replacementAddress = 'changed.invalid'; const pending = p.requestBack();
        p.save(); p.savePartial(); p.updateAddress(); await p.scan();
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.addressWrites, 0); assert.equal(h.state.scans.length, 0);
        h.state.dialogs[0].resolve({ index: 0 }); await pending; assert.equal(p.partialCount, 1);
    });
    add('old leave confirmation cannot navigate or clear a newer visit', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); p.input = FIRST;
        const pending = p.requestBack(); p.aboutToDisappear(); p.aboutToAppear(); p.input = SECOND;
        h.state.dialogs[0].resolve({ index: 1 }); await pending;
        assert.equal(h.state.backs, 0); assert.equal(p.input, SECOND); assert.equal(p.leaving, false);
    });
    add('confirmed return discards a scanner result that arrives later', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); const scan = p.scan(); await flush();
        const pending = p.requestBack(); h.state.dialogs[0].resolve({ index: 1 }); await pending;
        h.state.scans[0].resolve({ originalValue: FIRST }); await scan;
        assert.equal(h.state.backs, 1); assert.equal(p.input, ''); assert.equal(p.scanning, false); assert.equal(h.state.writes.length, 0);
    });
    add('return confirmation before scanner module resolves prevents native launch', async () => {
        const h = harness(), p = h.page('NodeConfig'); const scan = p.scan(); const pending = p.requestBack();
        await scan; assert.equal(p.confirmingLeave, true); assert.equal(p.scanning, false); assert.equal(h.state.scans.length, 0);
        h.state.dialogs[0].resolve({ index: 0 }); await pending; assert.equal(p.input, ''); assert.match(p.message, /重新扫码/);
    });
    add('staying after cancelling a scan permits a new scan while the old result stays stale', async () => {
        const h = harness(), p = h.page('NodeConfig'); const old = p.scan(); await flush(); const pending = p.requestBack();
        h.state.dialogs[0].resolve({ index: 0 }); await pending; const fresh = p.scan(); await flush();
        assert.equal(h.state.scans.length, 2); h.state.scans[0].resolve({ originalValue: FIRST }); await old;
        assert.equal(p.input, ''); assert.equal(p.scanning, true);
        h.state.scans[1].resolve({ originalValue: SECOND }); await fresh; assert.equal(p.input, SECOND); assert.equal(p.scanning, false);
    });
    add('ordinary page hiding under the scanner preserves its valid result', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); const scan = p.scan(); await flush();
        p.onPageHide(); assert.equal(p.scanning, true); p.onPageShow();
        h.state.scans[0].resolve({ originalValue: SECOND }); await scan;
        assert.equal(p.input, SECOND); assert.equal(p.scanning, false); assert.equal(h.state.writes.length, 0);
    });
    for (const outcome of ['resolve', 'reject']) add('hidden old ' + outcome + ' cannot release a newer confirmation lock', async () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); p.input = FIRST;
        const old = p.requestBack(); p.onPageHide(); p.onPageShow(); p.input = SECOND; const fresh = p.requestBack();
        if (outcome === 'resolve') h.state.dialogs[0].resolve({ index: 1 }); else h.state.dialogs[0].reject(RAW_ERROR);
        await old; assert.equal(p.confirmingLeave, true); assert.equal(p.input, SECOND); assert.equal(h.state.backs, 0);
        h.state.dialogs[1].resolve({ index: 0 }); await fresh; assert.equal(p.confirmingLeave, false); noVisibleSecrets(p, h.state);
    });
    add('repeated save clicks after successful import preserve receipt and perform one write', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND; p.save(); const receipt = p.saveReceipt, message = p.message;
        p.save(); p.savePartial(); assert.equal(h.state.writes.length, 1); assert.equal(p.saveReceipt, receipt); assert.equal(p.message, message);
    });
    add('repeated confirmation clicks after partial import cannot overwrite its success', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND + '\ninvalid-fixture'; p.save(); p.savePartial();
        const receipt = p.saveReceipt; p.savePartial(); assert.equal(h.state.writes.length, 1); assert.equal(p.saveReceipt, receipt);
    });
    add('connection beginning after page open blocks each mutation and retains drafts', () => {
        const h = harness(), p = h.page('NodeConfig'); p.aboutToAppear(); p.input = SECOND + '\ninvalid-fixture'; p.save();
        p.replacementAddress = 'changed.invalid'; h.state.allowed = false; p.savePartial(); p.save(); p.updateAddress();
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.addressWrites, 0); assert.equal(p.partialCount, 1);
        assert.equal(p.input, SECOND + '\ninvalid-fixture'); assert.equal(p.replacementAddress, 'changed.invalid'); assert.equal(p.editable, false);
    });
    add('unexpected import errors stay private and retain input', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND; h.state.mode = 'raw-write-error'; p.save();
        assert.equal(p.input, SECOND); assert.equal(h.state.writes.length, 0); assert.match(p.message, /输入已保留/); noVisibleSecrets(p, h.state);
    });
    add('profile load failure does not escape or expose its raw payload', () => {
        const h = harness(), p = h.page('NodeConfig'); h.state.profileReadsThrow = true;
        assert.doesNotThrow(() => p.aboutToAppear()); assert.equal(p.savedAddress, ''); noVisibleSecrets(p, h.state);
    });
    add('profile readback failure after committed import keeps input and reports uncertainty', () => {
        const h = harness(), p = h.page('NodeConfig'); p.input = SECOND; h.state.profileReadsThrow = true; p.save();
        assert.equal(h.state.writes.length, 1); assert.equal(p.input, SECOND); assert.equal(h.state.receipt, 0);
        assert.match(p.message, /保存已提交.*读回校验未确认/); noVisibleSecrets(p, h.state);
    });
    add('address update errors retain input without exception text', () => {
        const h = harness(), p = h.page('NodeConfig'); p.replacementAddress = 'changed.invalid'; h.state.mode = 'raw-address-error'; p.updateAddress();
        assert.equal(p.replacementAddress, 'changed.invalid'); assert.equal(h.state.addressWrites, 0); noVisibleSecrets(p, h.state);
    });
    add('committed address change with unreadable profile is not called an unsaved failure', () => {
        const h = harness(), p = h.page('NodeConfig'); p.replacementAddress = 'changed.invalid'; h.state.mode = 'address-readback-error'; p.updateAddress();
        assert.equal(h.state.addressWrites, 1); assert.equal(p.replacementAddress, 'changed.invalid');
        assert.match(p.message, /修改已提交.*读回未确认/); noVisibleSecrets(p, h.state);
    });
    add('successful address update absorbs a second queued click', () => {
        const h = harness(), p = h.page('NodeConfig'); p.replacementAddress = 'changed.invalid'; p.updateAddress(); const message = p.message;
        p.updateAddress(); assert.equal(h.state.addressWrites, 1); assert.equal(p.replacementAddress, ''); assert.equal(p.message, message);
    });
    add('diagnostic logging failure cannot misreport a committed import or address update', () => {
        const h = harness({ logThrows: true }), p = h.page('NodeConfig'); p.input = SECOND; p.save();
        assert.equal(h.state.writes.length, 1); assert.equal(p.input, ''); assert.match(p.saveReceipt, /^保存回执/); assert.match(p.message, /已新增/);
        p.replacementAddress = 'changed.invalid'; p.updateAddress();
        assert.equal(p.replacementAddress, ''); assert.match(p.message, /已更新/); noVisibleSecrets(p, h.state);
    });
    add('diagnostic logging failure preserves a successfully decoded scanner draft', async () => {
        const h = harness({ logThrows: true }), p = h.page('NodeConfig'); const pending = p.scan(); await flush();
        h.state.scans[0].resolve({ originalValue: SECOND }); await pending;
        assert.equal(p.input, SECOND); assert.match(p.message, /已识别/); assert.equal(h.state.writes.length, 0); noVisibleSecrets(p, h.state);
    });
    return cases;
}

function casesNodeScan() {
    const cases = [], add = (name, run) => cases.push({ name: 'NodeConfig scan: ' + name, run });
    add('unsupported device never loads ScanKit and can still paste/import a node', async () => {
        const h = harness({ scanCapability: false, scannerModuleThrows: true }), p = h.page('NodeConfig');
        p.aboutToAppear(); assert.equal(p.scanSupported, false); await p.scan();
        assert.equal(h.state.scannerModuleLoads, 0); assert.equal(h.state.scans.length, 0); assert.equal(p.scanning, false);
        assert.match(p.message, /不支持系统扫码/);
        p.input = SECOND; p.save(); assert.equal(h.state.writes.length, 1); assert.equal(p.input, '');
    });
    add('capability query failure keeps the import page usable without loading scanner', async () => {
        const h = harness({ capabilityThrows: true }), p = h.page('NodeConfig'); p.aboutToAppear(); await p.scan();
        assert.equal(p.scanSupported, false); assert.equal(h.state.scannerModuleLoads, 0); noVisibleSecrets(p, h.state);
        p.input = SECOND; p.save(); assert.equal(h.state.writes.length, 1);
    });
    add('late module load after page disposal cannot start the system scanner', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan(); p.aboutToDisappear(); await pending;
        assert.equal(h.state.scans.length, 0); assert.equal(p.scanning, false); assert.equal(p.input, '');
    });
    add('connection activation during module loading prevents the scanner call', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan(); h.state.allowed = false; await pending;
        assert.equal(h.state.scans.length, 0); assert.equal(p.scanning, false); assert.equal(h.state.writes.length, 0);
    });
    add('unavailable scanner module reports a safe failure and does not block paste import', async () => {
        const h = harness({ scannerModuleThrows: true }), p = h.page('NodeConfig'); await p.scan();
        assert.equal(h.state.scans.length, 0); assert.equal(p.scanning, false); noVisibleSecrets(p, h.state);
        p.input = SECOND; p.save(); assert.equal(h.state.writes.length, 1);
    });
    add('uses QR-only single-result system scanner with album support', async () => {
        const h = harness(), p = h.page('NodeConfig'), before = clone(h.state.catalog);
        p.saveReceipt = '保存回执：old';
        const pending = p.scan(); await flush();
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
        const pending = p.scan(); await flush(); h.state.scans[0].resolve({ originalValue: text }); await pending;
        assert.equal(p.input, text); assert.equal(h.state.writes.length, 0);
        p.save(); assert.equal(h.state.writes.length, 0); assert.equal(p.partialCount, 1); assert.match(p.saveReceipt, /请确认/);
        p.savePartial(); assert.equal(h.state.writes.length, 1); assert.equal(h.state.receipt, 1);
    });
    add('Base64 QR contents use the real batch parser without automatic persistence', async () => {
        const h = harness(), p = h.page('NodeConfig'); const text = Buffer.from(FIRST + '\n' + SECOND).toString('base64');
        const pending = p.scan(); await flush(); h.state.scans[0].resolve({ originalValue: text }); await pending;
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
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan(); await flush(); const receipt = p.saveReceipt;
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
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan(); await flush();
        h.state.scans[0].reject(Object.assign(new Error(RAW_ERROR.message), { code: 1000500002 })); await pending;
        assert.equal(p.message, '已取消扫码。'); assert.equal(p.input, ''); assert.equal(p.scanning, false);
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.requests.length, 0); noVisibleSecrets(p, h.state);
    });
    for (const mode of ['scanThrow', 'reject-error', 'reject-plain-object', 'reject-null']) {
        add(mode + ' native failure is never echoed', async () => {
            const h = harness({ scanThrow: mode === 'scanThrow' }), p = h.page('NodeConfig'); const pending = p.scan(); await flush();
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
            const h = harness(), p = h.page('NodeConfig'); const before = clone(h.state.catalog); const pending = p.scan(); await flush();
            h.state.scans[0].resolve({ originalValue: content }); await pending;
            assert.equal(p.input, ''); assert.equal(p.scanning, false); assert.match(p.message, /^扫码未完成/);
            assert.equal(h.state.requests.length, 0); assert.equal(h.state.writes.length, 0); assert.deepEqual(h.state.catalog, before);
            noVisibleSecrets(p, h.state);
        });
    }
    add('late successful result after leaving cannot refill the form', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan(); await flush();
        p.aboutToDisappear(); const message = p.message; h.state.scans[0].resolve({ originalValue: SECOND }); await pending;
        assert.equal(p.input, ''); assert.equal(p.message, message); assert.equal(p.scanning, false);
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.logs.length, 0);
    });
    add('late failure after leaving cannot replace a newer page message', async () => {
        const h = harness(), p = h.page('NodeConfig'); const pending = p.scan(); await flush();
        p.aboutToDisappear(); p.aboutToAppear(); const message = p.message; h.state.scans[0].reject(RAW_ERROR); await pending;
        assert.equal(p.input, ''); assert.equal(p.message, message); assert.equal(p.scanning, false); noVisibleSecrets(p, h.state);
    });
    add('old scan completion cannot end a newer scan or overwrite its result', async () => {
        const h = harness(), p = h.page('NodeConfig'); const old = p.scan(); await flush(); p.aboutToDisappear(); p.aboutToAppear();
        const fresh = p.scan(); await flush(); assert.equal(h.state.scans.length, 2);
        h.state.scans[0].resolve({ originalValue: FIRST }); await old;
        assert.equal(p.scanning, true); assert.equal(p.input, '');
        h.state.scans[1].resolve({ originalValue: SECOND }); await fresh;
        assert.equal(p.scanning, false); assert.equal(p.input, SECOND); assert.equal(h.state.writes.length, 0);
    });
    add('old scan resolving after fresh completion preserves the fresh input', async () => {
        const h = harness(), p = h.page('NodeConfig'); const old = p.scan(); await flush(); p.aboutToDisappear(); p.aboutToAppear();
        const fresh = p.scan(); await flush(); h.state.scans[1].resolve({ originalValue: SECOND }); await fresh;
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
    add('search feedback and clear action preserve catalog, selection and an existing batch', () => {
        const h = harness(), p = h.page('Nodes');
        h.state.catalog.nodes = Array.from({ length: 70 }, (_, i) => savedNode(i % 2 ? firstNode : secondNode, 'id-' + i));
        p.aboutToAppear(); p.limit = 100; p.search = 'trojan';
        assert.match(p.searchResultText(), /匹配 35 个/); assert.match(p.batchButtonText(), /35/);
        const before = clone(h.state.catalog), batch = { active: 'synthetic unchanged batch' }; p.batchQueue = batch; p.batchActive = true;
        p.clearSearch(); assert.equal(p.search, ''); assert.equal(p.limit, 50); assert.match(p.searchResultText(), /50 \/ 70/);
        assert.match(p.batchButtonText(), /70/); assert.equal(p.batchQueue, batch); assert.equal(p.batchActive, true);
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0); assert.equal(h.state.vpnStarts.length, 0);
    });
    add('detection explanation starts collapsed and toggles without changing a node or starting work', () => {
        const h = harness(), p = h.page('Nodes'); p.aboutToAppear(); const before = clone(h.state.catalog);
        assert.equal(p.latencyHelpExpanded, false); p.toggleLatencyHelp(); assert.equal(p.latencyHelpExpanded, true);
        p.toggleLatencyHelp(); assert.equal(p.latencyHelpExpanded, false);
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0); assert.equal(h.state.vpnStarts.length, 0);
    });
    add('responsive node information preserves useful width beside the fixed action area', () => {
        const h = harness(), p = h.page('Nodes');
        for (const width of [240, 320, 360, 600, 679, 680, 707.2, 840, 1024, 1280, 1920]) {
            p.windowWidthVp = width;
            const info = p.nodeInformationWidth(), frame = adaptiveLayout.nodeListContentWidth(width);
            assert(Number.isFinite(info) && info > 0 && info < frame);
            if (p.wideNodeRows()) assert(info >= 300, 'Wide row leaves too little space for a long node name');
        }
        p.windowWidthVp = 360; assert.equal(p.wideNodeRows(), false);
        p.windowWidthVp = 707.2; assert.equal(p.wideNodeRows(), true);
        p.windowWidthVp = 1280; assert.equal(p.wideNodeRows(), true);
    });
    add('actual UI keeps one set of node controls, native data menus and all connection guards', () => {
        const sdkRoot = path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio', 'sdk/default/openharmony/ets/build-tools/ets-loader');
        const options = ts.readConfigFile(path.join(sdkRoot, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions;
        const file = path.join(project, 'entry/src/main/ets/pages/Nodes.ets'), sourceText = fs.readFileSync(file, 'utf8');
        const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, options);
        assert.equal(source.parseDiagnostics.length, 0, 'SDK ArkTS UI syntax');
        const ids = [];
        function visit(node) {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'id') ids.push(node);
            ts.forEachChild(node, visit);
        }
        visit(source);
        function attributes(idExpression) {
            const matches = ids.filter(call => call.arguments[0]?.getText(source) === idExpression); assert.equal(matches.length, 1, idExpression + ' must occur once');
            let base = matches[0];
            while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) base = base.expression.expression;
            assert(ts.isEtsComponentExpression(base)); const result = new Map(); let node = base;
            while (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ts.isCallExpression(node.parent.parent)) {
                const access = node.parent, call = access.parent; result.set(access.name.text, call.arguments); node = call;
            }
            return result;
        }
        const more = attributes('`nodeMore-${node.id}`');
        assert.equal(more.get('bindMenu')[0].getText(source), 'this.nodeMenuItems(node)');
        assert.equal(more.get('enabled')[0].getText(source), 'this.editable');
        assert.equal(attributes('`testNodeLatency-${node.id}`').get('enabled')[0].getText(source), 'VPN_CORE_AVAILABLE && this.editable && !this.preparing && !this.testingId');
        assert.equal(attributes('`selectNode-${node.id}`').get('enabled')[0].getText(source), 'node.id === this.activeId || this.editable');
        assert.equal(attributes("'testFilteredNodes'").get('enabled')[0].getText(source), 'VPN_CORE_AVAILABLE && this.editable && this.filtered().length > 0');
        for (const id of ['`nodeMore-${node.id}`', '`testNodeLatency-${node.id}`', '`selectNode-${node.id}`']) {
            const size = attributes(id).get('constraintSize')[0];
            const minimum = size.properties.find(prop => prop.name.getText(source) === 'minHeight');
            assert(Number(minimum.initializer.text) >= 44, id + ' must remain easy to tap');
        }
        const row = attributes('`nodeRow-${node.id}`'), color = row.get('backgroundColor')[0];
        assert(ts.isConditionalExpression(color)); assert.equal(color.whenTrue.arguments[0].text, 'app.color.accent_soft');
        for (const id of ["'clearNodeSearch'", "'nodeSearchResultCount'", "'nodeLatencyScopeNotice'", "'toggleNodeLatencyHelp'", "'nodeLatencyHelp'"]) attributes(id);
        const perNode = ids.filter(call => call.arguments[0].getText(source).includes('node.id'));
        const rendered = [];
        for (const node of [{ id: 'first' }, { id: 'second' }]) {
            for (const call of perNode) {
                const expression = call.arguments[0].getText(source);
                rendered.push(new Function('node', 'return ' + expression).call({ activeId: 'first' }, node));
            }
        }
        assert.equal(new Set(rendered).size, rendered.length, 'Wide/narrow rows introduce duplicate node IDs');
    });
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
        const h = harness(), p = h.page('Nodes'); p.aboutToAppear(); p.onPageShow(); const before = clone(p.nodes);
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
    h.state.processAlive = true;
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
    h.state.processAlive = false; // This helper models actual process exit, not onDestroy alone.
    p.pollLatency();
}

function casesNodeLatency() {
    const cases = [], add = (name, run) => cases.push({ name: 'Nodes latency: ' + name, run });
    add('first and second timing labels remain separate and keep one timestamp', async () => {
        const h = harness(), p = h.page('Nodes');
        const record = latencyRecord(h.state.catalog.nodes[0]);
        p.latencies = [{ ...record, durationMs: 2400, measurementVersion: 2,
            secondStatus: 'passed', secondDurationMs: 230, secondConnection: 'reused', secondReason: '' }];
        assert.match(p.latencyText('node-old'), /^首次 HTTPS 2400 ms\n复用延迟 230 ms · /);
        p.latencies = [record];
        assert.match(p.latencyText('node-old'), /\n复用延迟 未检测（旧记录） · /);
        p.latencies = [{ ...record, measurementVersion: 2, secondStatus: 'failed', secondReason: 'timeout' }];
        assert.match(p.latencyText('node-old'), /^首次 HTTPS 321 ms\n复用检测超时 · /);
        assert.equal(p.latencyText('node-missing'), '未检测');
    });
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
        assert.equal(p.testingId, ''); assert.equal(p.editable, true); assert.match(p.latencyText('node-old'), /^首次 HTTPS 321 ms/);
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
        assert.match(p.latencyText('node-old'), /^首次 HTTPS 321 ms/); assert.equal(p.latencyText('node-second'), '未检测');
        assert.equal(p.latencyText('deleted-node'), '未检测');
    });
    add('configuration refresh hides previous result before asynchronous hash finishes', async () => {
        const h = harness({ hashDeferred: true }), p = h.page('Nodes');
        const old = latencyRecord(h.state.catalog.nodes[0]);
        p.nodes = clone(h.state.catalog.nodes); p.latencies = [old];
        assert.match(p.latencyText('node-old'), /^首次 HTTPS 321 ms/);
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
        h.state.catalog.nodes[0].outboundJson = secondNode.outboundJson;
        p.nodes = clone(h.state.catalog.nodes);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])]; const destroyed = p.refreshLatencies();
        p.aboutToDisappear(); h.state.hashRequests[1].resolve(outboundHash(secondNode.outboundJson)); await destroyed;
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

function casesBatchLatency() {
    const cases = [], add = (name, run) => cases.push({ name: 'Nodes batch: ' + name, run });
    function setup(options = {}) {
        const h = harness(options), p = h.page('Nodes');
        h.state.catalog.nodes.push(savedNode(secondNode, 'node-second'));
        p.aboutToAppear(); return { h, p };
    }
    function recordCurrent(h, changes = {}) {
        const request = h.state.latencyRequests.at(-1);
        const node = h.state.catalog.nodes.find(item => item.id === request.nodeId);
        h.state.latencyRecords = h.state.latencyRecords.filter(item => item.nodeId !== request.nodeId);
        h.state.latencyRecords.push(latencyRecord(node, { runId: request.runId, ...changes }));
        h.state.probeState = { ...h.state.probeState, phase: 'stopped' };
        return request;
    }
    add('previous session reconnect count cannot cancel startup before this run publishes its heartbeat', async () => {
        const { h, p } = setup(); const before = clone(h.state.catalog);
        h.state.probeState = { ...h.state.probeState, runId: 'previous-connection', kind: 'connection', phase: 'stopped' };
        h.state.connectionStatus = { runId: 'previous-connection', phase: 'destroyed', cleanupConfirmed: true,
            servicePid: 555, reconnectCount: 2 };
        h.state.processAlive = false;
        // startVpnExtensionAbility resolves before the new service writes status.
        await p.startBatch(); p.pollLatency(); p.pollLatency(); await flush();
        assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.batchActive, true); assert.equal(p.batchQueue.phase, 'running');
        assert.equal(h.state.command.action, 'start'); assert.equal(h.state.commands.some(command => command.action === 'stop'), false);
        assert.equal(h.state.measurements.length, 0); assert.equal(p.batchQueue.completed, 0);
        activateLatency(h, p); assert.equal(h.state.measurements.length, 1);
        recordCurrent(h); finishLatency(h, p); await flush();
        assert.equal(h.state.vpnStarts.length, 2); assert.equal(p.batchActive, true); assert.equal(p.batchQueue.completed, 1);
        activateLatency(h, p); h.state.connectionStatus.reconnectCount = 1; p.pollLatency(); await flush();
        assert.equal(p.batchActive, false); assert.equal(h.state.command.action, 'stop'); assert.equal(h.state.vpnStarts.length, 2);
        assert.deepEqual(h.state.catalog, before); assert.equal(h.state.writes.length, 0);
    });
    add('serial runs wait for own cleanup, retain fingerprints/selection and finish fixed snapshot', async () => {
        const { h, p } = setup(); const before = clone(h.state.catalog);
        await p.startBatch(); const first = activateLatency(h, p);
        assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.batchActive, true); assert.equal(p.editable, false);
        await p.startLatency('node-second'); p.select('node-second'); p.renameId = 'node-old'; p.renameText = 'changed'; p.rename(); p.remove('node-old');
        assert.equal(h.state.writes.length, 0); assert.equal(h.state.vpnStarts.length, 1);
        recordCurrent(h); h.state.connectionStatus.phase = 'stopped'; h.state.connectionStatus.cleanupConfirmed = true;
        p.pollLatency(); await flush(); assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.testingId, first.nodeId);
        h.state.connectionStatus.phase = 'destroyed'; p.pollLatency(); p.pollLatency(); await flush();
        assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.batchQueue.completed, 0); assert.equal(p.editable, false);
        h.state.processAlive = false; p.pollLatency(); p.pollLatency(); await flush();
        assert.equal(h.state.vpnStarts.length, 2); assert.equal(h.state.latencyRequests[1].nodeId, 'node-second');
        assert.equal(h.state.latencyRequests[1].outboundFingerprint, outboundHash(secondNode.outboundJson));
        activateLatency(h, p); recordCurrent(h, { status: 'failed', durationMs: 0, reason: 'https' }); finishLatency(h, p); await flush();
        assert.equal(p.batchActive, false); assert.equal(p.testingId, ''); assert.match(p.batchProgress, /2\/2.*检测结束/);
        assert.deepEqual(h.state.catalog, before); assert.equal(p.editable, true); assert.equal(h.state.vpnStarts.length, 2);
    });
    add('visible search snapshot ignores later search changes and expansion limit', async () => {
        const { h, p } = setup(); p.search = 'trojan'; p.limit = 1; await p.startBatch();
        assert.equal(h.state.latencyRequests[0].nodeId, 'node-second'); p.search = '';
        activateLatency(h, p); recordCurrent(h); finishLatency(h, p); await flush();
        assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.batchQueue.targets.length, 1); assert.equal(p.batchActive, false);
    });
    add('cancel during snapshot or page hide never launches after late fingerprint', async () => {
        for (const hide of [false, true]) {
            const { h, p } = setup({ hashDeferred: true }); const task = p.startBatch();
            assert.equal(h.state.hashRequests.length, 1);
            if (hide) p.onPageHide(); else p.cancelLatency();
            h.state.hashRequests[0].resolve(outboundHash(firstNode.outboundJson)); await task;
            p.onPageShow(); p.pollLatency(); await flush();
            assert.equal(h.state.vpnStarts.length, 0); assert.equal(p.batchActive, false); assert.equal(p.preparing, false);
        }
    });
    for (const action of ['cancel', 'hide', 'foreign-command', 'foreign-state', 'selection-changed', 'recovery']) {
        add(action + ' stops queue and ignores late result/cleanup', async () => {
            const { h, p } = setup(); await p.startBatch(); const first = activateLatency(h, p);
            if (action === 'cancel') p.cancelLatency();
            if (action === 'hide') p.onPageHide();
            if (action === 'foreign-command') h.state.command.runId = 'foreign';
            if (action === 'foreign-state') h.state.probeState.runId = 'foreign';
            if (action === 'selection-changed') h.state.catalog.activeNodeId = 'node-second';
            if (action === 'recovery') h.state.connectionStatus.reconnectCount = 1;
            p.pollLatency(); assert.equal(p.batchActive, false);
            h.state.measurements[0].resolve(proofFor(first)); await flush();
            recordCurrent(h); h.state.probeState.runId = first.runId;
            h.state.connectionStatus = { runId: first.runId, phase: 'destroyed', cleanupConfirmed: true, servicePid: 123 };
            p.pollLatency(); await flush();
            assert.equal(p.testingId, first.nodeId); assert.equal(p.cancelling, true); assert.equal(p.editable, false);
            assert.match(p.message, /清理|等待/); assert(!p.message.includes('进程已退出'));
            h.state.processAlive = false; h.state.processCheckThrows = true; p.pollLatency();
            assert.equal(p.cancelling, true); assert(!p.message.includes('进程已退出'));
            h.state.processCheckThrows = false; finishLatency(h, p); p.onPageShow(); await flush();
            assert.equal(h.state.vpnStarts.length, 1); assert.equal(h.state.latencyProofs.length, 0);
            assert.equal(p.testingId, ''); assert.equal(p.cancelling, false);
            assert.match(p.message, /批量检测已停止.*进程已退出/); assert(!p.message.includes('正在清理'));
            if (['cancel', 'hide'].includes(action)) assert.match(p.message, /未启动后续节点/);
            else assert.match(p.message, /请检查/);
        });
    }
    add('authorization rejection stops entire queue and leaves safe retry', async () => {
        const { h, p } = setup({ vpnDeferred: true }); const task = p.startBatch(); await flush();
        assert.equal(h.state.vpnStarts.length, 1); h.state.vpnStarts[0].reject(RAW_ERROR); await task; p.pollLatency();
        assert.equal(p.batchActive, false); assert.equal(p.testingId, ''); assert.equal(h.state.vpnStarts.length, 1);
        assert.equal(p.editable, true); assert.equal(p.cancelling, false); assert.match(p.message, /VPN 授权/); noVisibleSecrets(p, h.state);
    });
    add('hide during pending VPN authorization leaves a stop command and no late successor', async () => {
        const { h, p } = setup({ vpnDeferred: true }); const task = p.startBatch(); await flush();
        const request = h.state.latencyRequests[0]; p.onPageHide();
        assert.equal(h.state.command.action, 'stop'); assert.equal(p.batchActive, false);
        h.state.vpnStarts[0].resolve(); await task;
        h.state.probeState = { ...h.state.probeState, runId: request.runId, phase: 'stopped' };
        h.state.connectionStatus = { runId: request.runId, phase: 'destroyed', cleanupConfirmed: true, servicePid: 123 };
        h.state.processAlive = false;
        p.onPageShow(); await flush(); assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.testingId, '');
    });
    add('cleanup failure stays locked, confirmed process exit permits the next verified result', async () => {
        const { h, p } = setup(); await p.startBatch(); activateLatency(h, p); recordCurrent(h);
        h.state.connectionStatus.phase = 'destroyed'; h.state.connectionStatus.cleanupConfirmed = false;
        p.pollLatency(); await flush(); assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.editable, false);
        h.state.processAlive = false; p.pollLatency(); await flush();
        assert.equal(h.state.vpnStarts.length, 2); assert.equal(h.state.latencyRequests[1].nodeId, 'node-second');
    });
    add('process inspection failure cannot advance a cleaned batch session or unlock its UI', async () => {
        const { h, p } = setup(); await p.startBatch(); activateLatency(h, p); recordCurrent(h);
        h.state.connectionStatus.phase = 'destroyed'; h.state.connectionStatus.cleanupConfirmed = true;
        h.state.processAlive = false; h.state.processCheckThrows = true;
        p.pollLatency(); p.pollLatency(); await flush();
        assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.batchQueue.completed, 0);
        assert.equal(p.batchActive, true); assert.equal(p.editable, false); assert.equal(p.testingId, 'node-old');
        noVisibleSecrets(p, h.state);
        h.state.processCheckThrows = false; p.pollLatency(); await flush();
        assert.equal(h.state.vpnStarts.length, 2); assert.equal(p.batchQueue.completed, 1);
    });
    add('batch remembers observed PID when later terminal heartbeat omits it', async () => {
        const { h, p } = setup(); await p.startBatch(); activateLatency(h, p); recordCurrent(h);
        h.state.connectionStatus = { runId: h.state.probeState.runId, phase: 'destroyed', cleanupConfirmed: true };
        p.pollLatency(); await flush(); assert.equal(h.state.vpnStarts.length, 1); assert.equal(p.batchQueue.completed, 0);
        h.state.processAlive = false; p.pollLatency(); await flush();
        assert.equal(h.state.vpnStarts.length, 2); assert.equal(p.batchQueue.completed, 1);
    });
    add('single-node cleanup cannot unlock a new batch until remembered PID exits', async () => {
        const { h, p } = setup(); await p.startLatency('node-old'); activateLatency(h, p); recordCurrent(h);
        h.state.connectionStatus.phase = 'destroyed'; h.state.connectionStatus.cleanupConfirmed = true;
        p.pollLatency(); await p.startBatch(); await p.startLatency('node-second');
        assert.equal(p.testingId, 'node-old'); assert.equal(p.editable, false); assert.equal(h.state.vpnStarts.length, 1);
        delete h.state.connectionStatus.servicePid; h.state.processCheckThrows = true; h.state.processAlive = false;
        p.pollLatency(); assert.equal(p.editable, false); assert.equal(p.testingId, 'node-old');
        h.state.processCheckThrows = false; p.pollLatency(); await flush();
        assert.equal(p.testingId, ''); assert.equal(p.editable, true);
        await p.startBatch(); assert.equal(h.state.vpnStarts.length, 2); assert.equal(p.batchActive, true);
    });
    add('recreated node page also blocks startup on a previous terminal live PID', async () => {
        const { h } = setup();
        h.state.probeState = { ...h.state.probeState, runId: 'old-run', phase: 'stopped', kind: 'node-latency' };
        h.state.connectionStatus = { runId: 'old-run', phase: 'destroyed', cleanupConfirmed: true, servicePid: 123 };
        const p = h.page('Nodes'); p.aboutToAppear();
        assert.equal(p.editable, false); await p.startBatch(); await p.startLatency('node-old'); assert.equal(h.state.vpnStarts.length, 0);
        h.state.processAlive = false; h.state.processCheckThrows = true; p.pollLatency();
        assert.equal(p.editable, false); await p.startLatency('node-old'); assert.equal(h.state.vpnStarts.length, 0);
        h.state.processCheckThrows = false; p.pollLatency(); assert.equal(p.editable, true);
        await p.startBatch(); assert.equal(h.state.vpnStarts.length, 1);
    });
    add('changed next-node configuration aborts before another VPN start', async () => {
        const { h, p } = setup(); await p.startBatch(); activateLatency(h, p); recordCurrent(h);
        h.state.catalog.nodes[1].outboundJson = firstNode.outboundJson;
        finishLatency(h, p); await flush(); assert.equal(p.batchActive, false); assert.equal(h.state.vpnStarts.length, 1);
    });
    for (const change of [{ runId: 'old' }, { outboundFingerprint: '0'.repeat(64) }, { status: 'cancelled', reason: 'stopped' }]) {
        add('stale/unconfirmed result cannot advance: ' + JSON.stringify(change), async () => {
            const { h, p } = setup(); await p.startBatch(); activateLatency(h, p); recordCurrent(h, change); finishLatency(h, p); await flush();
            assert.equal(p.batchActive, false); assert.equal(h.state.vpnStarts.length, 1);
        });
    }
    add('sorting changes only view with failures last, stable ties and restorable catalog order', () => {
        const { h, p } = setup(); h.state.catalog.nodes.push(savedNode(firstNode, 'node-third'));
        p.nodes = clone(h.state.catalog.nodes); const before = clone(h.state.catalog);
        p.latencies = [latencyRecord(p.nodes[0], { durationMs: 400 }), latencyRecord(p.nodes[1], { durationMs: 100 }),
            latencyRecord(p.nodes[2], { status: 'failed', durationMs: 0, reason: 'https' })];
        p.sortByLatency = true; assert.deepEqual(clone(p.filtered()).map(n => n.id), ['node-second', 'node-old', 'node-third']);
        p.sortByLatency = false; assert.deepEqual(clone(p.filtered()).map(n => n.id), before.nodes.map(n => n.id));
        assert.deepEqual(h.state.catalog, before); assert.equal(p.activeId, before.activeNodeId); assert.equal(h.state.writes.length, 0);
    });
    return cases;
}
function casesNodePerformance() {
    const cases = [], add = (name, run) => cases.push({ name: 'Nodes performance: ' + name, run });
    function largeCatalog(h, count = 500) {
        h.state.catalog.nodes = Array.from({ length: count }, (_, i) => {
            const outbound = JSON.parse(firstNode.outboundJson);
            outbound.settings.vnext[0].address = `synthetic-${i}.invalid`;
            const node = single.parseNode(JSON.stringify(outbound)); node.name = `Synthetic ${i}`;
            return savedNode(node, 'large-' + i);
        });
        h.state.catalog.activeNodeId = h.state.catalog.nodes[0].id;
        h.state.latencyRecords = h.state.catalog.nodes.map((node, i) => latencyRecord(node, {
            durationMs: (i * 73) % 997 + 1
        })).reverse();
    }
    add('500-node latency ordering matches the prior stable semantics using one result index', () => {
        const h = harness(), p = h.page('Nodes'); largeCatalog(h);
        p.nodes = clone(h.state.catalog.nodes); p.activeId = h.state.catalog.activeNodeId; p.sortByLatency = true;
        const plainRecords = clone(h.state.latencyRecords);
        let referenceVisits = 0, indexedIdReads = 0;
        const expected = [...p.nodes].sort((left, right) => {
            const a = plainRecords.find(result => { referenceVisits++; return result.nodeId === left.id; });
            const b = plainRecords.find(result => { referenceVisits++; return result.nodeId === right.id; });
            const rankA = batchLatency.latencySortRank(a?.status ?? '', a?.durationMs ?? 0);
            const rankB = batchLatency.latencySortRank(b?.status ?? '', b?.durationMs ?? 0);
            return rankA === rankB ? 0 : rankA < rankB ? -1 : 1;
        }).map(node => node.id);
        p.latencies = plainRecords.map(record => {
            const copy = { ...record }; Object.defineProperty(copy, 'nodeId', { get() { indexedIdReads++; return record.nodeId; } });
            return copy;
        });
        const actual = p.filtered().map(node => node.id);
        assert.deepEqual(clone(actual), expected); assert.equal(indexedIdReads, 500);
        assert(referenceVisits > 1000000); assert.equal(p.activeId, h.state.catalog.activeNodeId);
        assert.deepEqual(clone(p.nodes).map(node => node.id), h.state.catalog.nodes.map(node => node.id));
        nodePerformance.sort500 = { referenceResultPredicateVisits: referenceVisits, optimizedResultIndexIdReads: indexedIdReads };
    });
    add('indexed ordering preserves ties, failed/missing placement and search semantics', () => {
        const h = harness(), p = h.page('Nodes'); largeCatalog(h);
        p.nodes = clone(h.state.catalog.nodes); p.sortByLatency = true;
        p.latencies = h.state.latencyRecords.filter((_, i) => i % 5 !== 0).map((result, i) => ({
            ...result, status: i % 4 === 0 ? 'failed' : 'passed', reason: i % 4 === 0 ? 'timeout' : '', durationMs: i % 3 === 0 ? 10 : 20
        }));
        for (const search of ['', 'Synthetic 1', 'not present']) {
            p.search = search; const query = search.toLowerCase();
            const expected = p.nodes.filter(node => node.name.toLowerCase().includes(query) || node.protocol.includes(query)).sort((a, b) => {
                const left = p.latencies.find(result => result.nodeId === a.id), right = p.latencies.find(result => result.nodeId === b.id);
                const x = batchLatency.latencySortRank(left?.status ?? '', left?.durationMs ?? 0), y = batchLatency.latencySortRank(right?.status ?? '', right?.durationMs ?? 0);
                return x === y ? 0 : x < y ? -1 : 1;
            });
            assert.deepEqual(clone(p.filtered()).map(node => node.id), expected.map(node => node.id));
        }
        p.sortByLatency = false; p.search = ''; assert.deepEqual(clone(p.filtered()), clone(p.nodes));
    });
    add('first appearance/show reads once and unchanged return reuses all 500 fingerprints', async () => {
        const h = harness(), p = h.page('Nodes'); largeCatalog(h);
        const tasks = [], refresh = p.refreshLatencies.bind(p);
        p.refreshLatencies = () => { const task = refresh(); tasks.push(task); return task; };
        p.aboutToAppear(); p.onPageShow(); await Promise.all(tasks);
        assert.equal(h.state.events.filter(event => event === 'catalog-read').length, 1);
        assert.equal(h.state.latencyReads, 1); assert.equal(h.state.hashRequests.length, 500); assert.equal(p.latencies.length, 500);
        const first = { catalogReads: 1, resultReads: 1, fingerprintCalls: 500 };
        p.onPageHide(); assert.equal(h.state.timers.size, 0); p.onPageShow(); await tasks.at(-1);
        assert.equal(h.state.events.filter(event => event === 'catalog-read').length, 2);
        assert.equal(h.state.latencyReads, 2); assert.equal(h.state.hashRequests.length, 500);
        assert.equal(p.latencies.length, 500); assert.equal(p.historyFingerprints.size, 500); assert.equal(h.state.timers.size, 1);
        nodePerformance.firstShow500 = first;
        nodePerformance.unchangedRefresh500 = { resultReads: 1, additionalFingerprintCalls: 0, matchedResults: 500 };
        p.aboutToDisappear(); assert.equal(h.state.timers.size, 0); assert.equal(p.historyFingerprints.size, 0);
    });
    add('500-result refresh uses indexed nodes and invalidates changed/deleted identities only', async () => {
        const h = harness(), p = h.page('Nodes'); largeCatalog(h);
        let nodeIdReads = 0;
        p.nodes = h.state.catalog.nodes.map(node => {
            const copy = { ...node }; Object.defineProperty(copy, 'id', { get() { nodeIdReads++; return node.id; } }); return copy;
        });
        await p.refreshLatencies(); assert.equal(nodeIdReads, 1000); assert.equal(h.state.hashRequests.length, 500);
        nodePerformance.historyJoin500 = { priorLinearNodePredicateVisits: 500 * 501 / 2, optimizedNodeIdReads: nodeIdReads };
        h.state.catalog.nodes[5].name = 'Metadata changed'; p.nodes = clone(h.state.catalog.nodes);
        await p.refreshLatencies(); assert.equal(h.state.hashRequests.length, 500);
        const changed = h.state.catalog.nodes[17], removed = h.state.catalog.nodes[29];
        changed.protocol = secondNode.protocol; changed.outboundJson = secondNode.outboundJson;
        h.state.catalog.nodes = h.state.catalog.nodes.filter(node => node.id !== removed.id); p.nodes = clone(h.state.catalog.nodes);
        await p.refreshLatencies(); assert.equal(h.state.hashRequests.length, 501);
        assert.equal(p.latencies.length, 498); assert.equal(p.historyFingerprints.size, 499);
        assert.equal(p.historyFingerprints.has(removed.id), false);
        h.state.latencyRecords = h.state.latencyRecords.filter(record => record.nodeId !== changed.id);
        h.state.latencyRecords.push(latencyRecord(changed, { durationMs: 777, runId: 'fresh-result' }));
        await p.refreshLatencies(); assert.equal(h.state.hashRequests.length, 501);
        assert.equal(p.latencies.find(record => record.nodeId === changed.id).durationMs, 777); assert.equal(p.latencies.length, 499);
    });
    add('overlapping history refreshes share a pending fingerprint and only newest results win', async () => {
        const h = harness({ hashDeferred: true }), p = h.page('Nodes'); p.nodes = clone(h.state.catalog.nodes);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])]; const old = p.refreshLatencies();
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0], { durationMs: 555, runId: 'new-result' })]; const fresh = p.refreshLatencies();
        assert.equal(h.state.hashRequests.length, 1); h.state.hashRequests[0].resolve(outboundHash(firstNode.outboundJson));
        await Promise.all([old, fresh]); assert.equal(p.latencies.length, 1); assert.equal(p.latencies[0].durationMs, 555);
    });
    add('a changed outbound replaces an in-flight cache entry and late old completion cannot poison it', async () => {
        const h = harness({ hashDeferred: true }), p = h.page('Nodes'); p.nodes = clone(h.state.catalog.nodes);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])]; const old = p.refreshLatencies();
        h.state.catalog.nodes[0] = savedNode(secondNode, 'node-old'); p.nodes = clone(h.state.catalog.nodes);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])]; const fresh = p.refreshLatencies();
        assert.equal(h.state.hashRequests.length, 2); h.state.hashRequests[1].resolve(outboundHash(secondNode.outboundJson)); await fresh;
        h.state.hashRequests[0].resolve(outboundHash(firstNode.outboundJson)); await old;
        assert.equal(p.latencies[0].outboundFingerprint, outboundHash(secondNode.outboundJson));
        assert.equal(p.historyFingerprints.get('node-old').outboundJson, secondNode.outboundJson);
        assert.equal(p.historyFingerprints.get('node-old').value, outboundHash(secondNode.outboundJson));
    });
    add('failed cached fingerprint is retryable and obsolete identities cannot accumulate', async () => {
        const h = harness({ hashDeferred: true }), p = h.page('Nodes'); p.nodes = clone(h.state.catalog.nodes);
        h.state.latencyRecords = [latencyRecord(h.state.catalog.nodes[0])]; const failed = p.refreshLatencies();
        h.state.hashRequests[0].reject(RAW_ERROR); await failed; assert.equal(p.latencies.length, 0); noVisibleSecrets(p, h.state);
        const retry = p.refreshLatencies(); assert.equal(h.state.hashRequests.length, 2);
        h.state.hashRequests[1].resolve(outboundHash(firstNode.outboundJson)); await retry; assert.equal(p.latencies.length, 1);
        p.nodes = []; h.state.latencyRecords = []; await p.refreshLatencies(); assert.equal(p.historyFingerprints.size, 0);
        p.aboutToDisappear(); assert.equal(p.historyFingerprints.size, 0);
    });
    return cases;
}

function casesNodeCollection() {
    const cases = [], add = (name, run) => cases.push({ name: 'Node collection: ' + name, run });
    add('source, favorites, import-result and case-insensitive search intersect without mutating catalog', () => {
        const h = harness(), p = h.page('Nodes');
        h.state.catalog.nodes = [savedNode(firstNode, 'manual'), savedNode(secondNode, 'source-match', 'source-a'),
            savedNode(secondNode, 'source-other', 'source-b')];
        h.state.catalog.nodes[1].favorite = true; h.state.catalog.nodes[2].favorite = true;
        p.nodes = clone(h.state.catalog.nodes); const original = JSON.stringify(p.nodes);
        p.sourceFilterId = 'source-a'; p.favoritesOnly = true; p.search = ' TROJAN ';
        p.importedOnly = true; p.importedNodeIds = ['manual', 'source-match'];
        assert.deepEqual(Array.from(p.filtered(), n => n.id), ['source-match']);
        assert.equal(JSON.stringify(p.nodes), original); assert.equal(h.state.writes.length, 0);
    });
    add('manual source and missing imported identities never widen to all sources', () => {
        const h = harness(), p = h.page('Nodes'); p.nodes = [savedNode(firstNode), savedNode(secondNode, 'remote', 'source-a')];
        p.sourceFilterId = '$manual'; assert.equal(p.filtered().length, 1);
        p.importedOnly = true; p.importedNodeIds = ['deleted']; assert.equal(p.filtered().length, 0);
        p.clearFilters(); assert.equal(p.filtered().length, 2);
    });
    add('favorite changes metadata while retaining selection and outbound', () => {
        const h = harness(), p = h.page('Nodes'); p.reload(); const original = clone(h.state.catalog);
        p.toggleFavorite('node-old'); assert.equal(h.state.catalog.nodes[0].favorite, true);
        assert.equal(h.state.catalog.activeNodeId, original.activeNodeId);
        assert.equal(h.state.catalog.nodes[0].outboundJson, original.nodes[0].outboundJson);
        p.toggleFavorite('node-old'); assert.equal(h.state.catalog.nodes[0].favorite, false);
    });
    add('favorite is guarded and failed writes do not optimistically change UI state', () => {
        const h = harness(), p = h.page('Nodes'); p.reload(); h.state.allowed = false;
        p.toggleFavorite('node-old'); assert.equal(h.state.writes.length, 0);
        h.state.allowed = true; h.state.mode = 'write-error'; p.toggleFavorite('node-old');
        assert.equal(p.nodes[0].favorite, false); assert.match(p.message, /未保存/); noVisibleSecrets(p, h.state);
    });
    for (const operation of ['favorite','select','rename','delete']) {
        add(operation + ' distinguishes committed mutation from unconfirmed list readback', () => {
            const h = harness({mutationReadbackError:true}), p = h.page('Nodes'); p.reload();
            if(operation==='favorite')p.toggleFavorite('node-old');
            if(operation==='select')p.select('node-old');
            if(operation==='rename'){p.renameId='node-old';p.renameText='Saved name';p.rename();}
            if(operation==='delete')p.remove('node-old');
            assert(h.state.writes.includes(operation)); assert.equal(p.catalogReadable,false); assert.equal(p.editable,false);
            assert.match(p.message, /已保存|已提交/); assert.match(p.message,/读取未确认/);
            assert(!/未保存|原节点已保留/.test(p.message)); noVisibleSecrets(p,h.state);
        });
    }
    add('a consumed import request does not override later user filters after page return', () => {
        const h = harness(), p = h.page('Nodes'); p.reload();
        h.state.routeParams = new nodeListNavigation.ImportedNodesNavigation(['node-old'], UUID);
        p.applyImportedNavigation(); assert.equal(p.importedOnly, true);
        p.clearFilters(); p.search = 'mine'; p.applyImportedNavigation();
        assert.equal(p.importedOnly, false); assert.equal(p.search, 'mine');
    });
    add('an import route retains a catalog read error and waits for a successful reload', () => {
        const h = harness(), p = h.page('Nodes'); p.reload();
        h.state.routeParams = new nodeListNavigation.ImportedNodesNavigation(['node-old'], UUID);
        h.state.mode = 'catalog-read-error'; p.reload(); const failure = p.message;
        p.applyImportedNavigation(); assert.equal(p.message, failure); assert.match(p.message, /读取失败/);
        assert.equal(p.consumedImportRequest, ''); assert.equal(p.importedOnly, false);
        h.state.mode = ''; p.reload(); p.applyImportedNavigation();
        assert.equal(p.importedOnly, true); assert.equal(p.consumedImportRequest, UUID); assert.equal(p.message, '');
        p.clearFilters(); p.applyImportedNavigation(); assert.equal(p.importedOnly, false);
    });
    add('a fresh receipt for the same node opens its result again without selection or writes', () => {
        const h = harness(), p = h.page('Nodes'); p.reload();
        h.state.routeParams = new nodeListNavigation.ImportedNodesNavigation(['node-old'], UUID);
        p.applyImportedNavigation(); p.clearFilters();
        h.state.routeParams = new nodeListNavigation.ImportedNodesNavigation(['node-old'], '00000000-0000-4000-8000-000000000123');
        p.applyImportedNavigation(); assert.equal(p.importedOnly, true); assert.equal(p.detailNodeId, 'node-old');
        assert.equal(h.state.writes.length, 0);
    });
    add('viewing another node only changes detail focus', () => {
        const h = harness(), p = h.page('Nodes'); p.windowWidthVp = 1440;
        p.inspectNode('different-node'); assert.equal(p.detailNodeId, 'different-node');
        assert.equal(h.state.catalog.activeNodeId, 'node-old'); assert.equal(h.state.writes.length, 0);
    });
    add('same-id reload reads current row metadata and second rename starts from the saved name', () => {
        const h = harness(), p = h.page('Nodes'); p.reload(); const old = p.nodes[0];
        h.state.catalog.nodes[0].name = 'Updated synthetic name'; h.state.catalog.nodes[0].favorite = true;
        p.reload(); assert.notEqual(p.nodes[0], old); assert.equal(p.isFavorite(old.id), true);
        assert.equal(p.nodeById(old.id).name, 'Updated synthetic name');
        p.prepareRename(old.id); assert.equal(p.renameText, 'Updated synthetic name');
        assert.equal(h.state.writes.length, 0);
    });
    return cases;
}

async function main() {
    const passed = [], failed = [];
    for (const test of [...casesNodeConfig(), ...casesNodeForm(), ...casesNodeScan(), ...casesSubscriptions(), ...casesNodes(), ...casesNodeLatency(), ...casesBatchLatency(), ...casesNodePerformance(), ...casesNodeCollection()]) {
        try { await test.run(); passed.push(test.name); }
        catch (error) { failed.push({ name: test.name, error: error.message }); }
    }
    const record = { generatedAt: new Date().toISOString(), passed: passed.length, failed: failed.length, sourceHashes,
        scope: 'Real ArkTS methods/parsers/fetcher/NodeEditGuard, SDK transpilation, synthetic catalog/HTTP/scanner/timers/VPN state and deferred latency dependencies; not a device result.',
        tests: passed, failures: failed, nodePerformance };
    const output = path.join(project, 'build/node-management-ui-verification.json');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed, record: output }));
    if (failed.length) process.exitCode = 1;
}
module.exports = { runNodeConfigReceiptTests };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
