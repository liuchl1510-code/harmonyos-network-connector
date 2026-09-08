/*
 * Explicit, local Windows A/B probe. Never changes system proxy/VPN settings.
 * Usage: node test-host-node.cjs --node-file <file-in-.private-directory>
 *   [--outbound-index <index>] [--server-address <literal-IP>]
 *   [--typescript-dir <SDK-TypeScript-package>] [--timeout-ms <1000..20000>]
 *   [--core-dir <directory-with-xray.exe-and-build-verification.json>]
 *   [--core-executable <same-digest-executable-at-its-installed-path>]
 *   [--outbound-interface <Windows-network-interface-name>]
 *
 * Complete JSON requires an explicit outbound index. Only that outbound is
 * retained; original inbounds/routing/DNS are never executed. Nonempty REALITY
 * mldsa65Verify is rejected as UNSUPPORTED_SECURITY for this A/B comparison:
 * that configuration is outside this importer's validated scope, even though
 * the upstream core already contains ML-DSA verification support.
 * Runtime config, child stdout/stderr, and runner diagnostics stay beside the
 * input in .private. stdout contains one sanitized JSON summary, never a node.
 * Files are retained privately for diagnosis; the source node file is untouched.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { loadNodeParser } = require('./node-import-loader.cjs');

const PROJECT = path.resolve(__dirname, '..');
const TARGET_IP = '1.1.1.1';
const TARGET_PATH = '/cdn-cgi/trace';
const EXPECTED_VERSION = '25.8.3';
const EXPECTED_MODULE = 'github.com/xtls/xray-core@v1.250803.0';

class ProbeError extends Error {
    constructor(code) { super(code); this.code = code; }
}

function parseArguments(args) {
    const allowed = ['--node-file', '--outbound-index', '--server-address', '--typescript-dir', '--timeout-ms', '--core-dir', '--core-executable', '--outbound-interface'];
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
        if (!allowed.includes(args[index]) || !args[index + 1] ||
            args[index + 1].startsWith('--') || options.has(args[index])) {
            throw new ProbeError('ARGUMENT_ERROR');
        }
        options.set(args[index], args[index + 1]);
    }
    if (!options.has('--node-file')) throw new ProbeError('NODE_FILE_REQUIRED');
    const timeout = Number(options.get('--timeout-ms') || 20000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 20000) throw new ProbeError('ARGUMENT_ERROR');
    if (options.has('--server-address') && net.isIP(options.get('--server-address')) === 0) {
        throw new ProbeError('SERVER_ADDRESS_MUST_BE_LITERAL_IP');
    }
    if (options.has('--outbound-index') && !/^(0|[1-9][0-9]*)$/.test(options.get('--outbound-index'))) {
        throw new ProbeError('OUTBOUND_INDEX_INVALID');
    }
    if (options.has('--outbound-interface') && (process.platform !== 'win32' ||
        !os.networkInterfaces()[options.get('--outbound-interface')]?.some(item => item.family === 'IPv4' && !item.internal))) {
        throw new ProbeError('OUTBOUND_INTERFACE_INVALID');
    }
    return { options, timeout };
}

function selectOutbound(text, options, parseNode) {
    let selected = text;
    let object;
    if (text.trimStart().startsWith('{')) {
        try { object = JSON.parse(text); } catch (_) { throw new ProbeError('NODE_PARSE_FAILED'); }
        if (Object.prototype.hasOwnProperty.call(object, 'outbounds')) {
            if (!options.has('--outbound-index')) throw new ProbeError('OUTBOUND_INDEX_REQUIRED');
            const index = Number(options.get('--outbound-index'));
            if (!Array.isArray(object.outbounds) || !Number.isSafeInteger(index) ||
                index >= object.outbounds.length || !object.outbounds[index] ||
                typeof object.outbounds[index] !== 'object' || Array.isArray(object.outbounds[index])) {
                throw new ProbeError('OUTBOUND_INDEX_INVALID');
            }
            object = object.outbounds[index];
            selected = JSON.stringify(object);
        } else if (options.has('--outbound-index')) {
            throw new ProbeError('OUTBOUND_INDEX_NOT_APPLICABLE');
        }
    } else if (options.has('--outbound-index')) {
        throw new ProbeError('OUTBOUND_INDEX_NOT_APPLICABLE');
    }
    const verification = object?.streamSettings?.realitySettings?.mldsa65Verify;
    if (verification !== undefined && verification !== '') throw new ProbeError('UNSUPPORTED_SECURITY');
    let imported;
    try { imported = parseNode(selected); } catch (_) { throw new ProbeError('NODE_PARSE_FAILED'); }
    const outbound = JSON.parse(imported.outboundJson);
    if (options.has('--server-address')) {
        const servers = outbound.settings.vnext || outbound.settings.servers;
        if (!Array.isArray(servers) || servers.length !== 1) throw new ProbeError('NODE_PARSE_FAILED');
        // An explicit host-only override: preserve SNI, fingerprint, public key,
        // shortId, transport Host, credentials, port and every other node field.
        servers[0].address = options.get('--server-address');
    }
    if (options.has('--outbound-interface')) {
        // Per-socket IP_UNICAST_IF in upstream Windows core. This explicitly
        // avoids the existing system TUN for this one outbound; no OS route or
        // stored user node is changed. Preserve all authentication fields.
        outbound.streamSettings ??= {};
        outbound.streamSettings.sockopt ??= {};
        outbound.streamSettings.sockopt.interface = options.get('--outbound-interface');
    }
    return outbound;
}

function classify(error, stage, expired) {
    if (expired) return 'TIMEOUT';
    if (error instanceof ProbeError) return error.code;
    if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID'].includes(error?.code)) {
        return 'TLS_CERTIFICATE_REJECTED';
    }
    if (stage === 'tls') return 'TLS_HANDSHAKE_FAILED';
    if (stage === 'connect') return 'PROXY_CONNECT_FAILED';
    if (stage === 'http') return 'HTTP_IO_FAILED';
    if (stage === 'startup') return 'CORE_START_FAILED';
    if (stage === 'node') return 'NODE_FILE_OR_FORMAT_ERROR';
    if (stage === 'core-version') return 'CORE_VERSION_CHECK_FAILED';
    if (stage === 'parser') return 'PARSER_SETUP_FAILED';
    return 'LOCAL_OPERATION_FAILED';
}

async function main() {
    const started = performance.now();
    const summary = { success: false, stage: 'arguments', httpStatus: null,
        xrayVersion: 'unverified', coreModule: EXPECTED_MODULE, elapsedMs: 0,
        errorClass: null, realityInvalidConnectionCount: 0, socketOptionErrorCount: 0,
        outboundInterfaceRequested: false };
    let child;
    let childClosed;
    let childError;
    let privatePaths;
    let logDescriptors = [];
    const sockets = new Set();
    const controller = new AbortController();
    let deadlineTimer;
    let timeoutBudget = 20000;

    function track(socket) {
        sockets.add(socket);
        socket.on('error', () => {}); // Late errors never escape to public stderr.
        socket.once('close', () => sockets.delete(socket));
        return socket;
    }
    function ensureTime() {
        if (controller.signal.aborted) throw new ProbeError('TIMEOUT');
    }
    function remaining() { return Math.max(1, Math.floor(timeoutBudget - 800 - (performance.now() - started))); }
    function abort() {
        controller.abort();
        for (const socket of sockets) socket.destroy(new ProbeError('TIMEOUT'));
    }
    function withAbort(promise) {
        return new Promise((resolve, reject) => {
            if (controller.signal.aborted) { reject(new ProbeError('TIMEOUT')); return; }
            const aborted = () => reject(new ProbeError('TIMEOUT'));
            controller.signal.addEventListener('abort', aborted, { once: true });
            promise.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
        });
    }
    function delay(ms) {
        return new Promise((resolve, reject) => {
            ensureTime();
            const timer = setTimeout(done, Math.min(ms, remaining()));
            const onAbort = () => { clearTimeout(timer); reject(new ProbeError('TIMEOUT')); };
            function done() { controller.signal.removeEventListener('abort', onAbort); resolve(); }
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
    }
    function connect(port) {
        return withAbort(new Promise((resolve, reject) => {
            ensureTime();
            const socket = track(net.connect({ host: '127.0.0.1', port }));
            socket.once('connect', () => { socket.removeListener('error', failed); resolve(socket); });
            function failed(error) { socket.destroy(); reject(error); }
            socket.once('error', failed);
        }));
    }
    function headers(socket, request) {
        return withAbort(new Promise((resolve, reject) => {
            ensureTime();
            let bytes = Buffer.alloc(0);
            function cleanup() {
                socket.removeListener('data', data);
                socket.removeListener('error', failed);
                socket.removeListener('end', ended);
                socket.removeListener('close', ended);
            }
            function failed(error) { cleanup(); reject(error); }
            function ended() { failed(new ProbeError('PEER_CLOSED_BEFORE_HEADERS')); }
            function data(chunk) {
                bytes = Buffer.concat([bytes, chunk]);
                const end = bytes.indexOf('\r\n\r\n');
                if (end >= 0) {
                    const match = /^HTTP\/1\.[01] ([0-9]{3})(?:\s|\r\n)/.exec(bytes.subarray(0, end + 2).toString('latin1'));
                    cleanup();
                    socket.pause();
                    if (!match) { reject(new ProbeError('HTTP_HEADER_INVALID')); return; }
                    const tail = bytes.subarray(end + 4);
                    if (tail.length > 0) socket.unshift(tail);
                    resolve(Number(match[1]));
                } else if (bytes.length > 32768) {
                    failed(new ProbeError('HTTP_HEADER_TOO_LARGE'));
                }
            }
            socket.on('data', data);
            socket.once('error', failed);
            socket.once('end', ended);
            socket.once('close', ended);
            socket.resume();
            socket.write(request);
        }));
    }

    try {
        const { options, timeout } = parseArguments(process.argv.slice(2));
        summary.outboundInterfaceRequested = options.has('--outbound-interface');
        timeoutBudget = timeout;
        deadlineTimer = setTimeout(abort, Math.max(1, timeout - 800));
        summary.stage = 'node';
        const inputPath = fs.realpathSync(path.resolve(options.get('--node-file')));
        const privateDir = path.dirname(inputPath);
        if (path.basename(privateDir).toLowerCase() !== '.private') throw new ProbeError('PRIVATE_DIRECTORY_REQUIRED');
        const fileInfo = fs.statSync(inputPath);
        if (!fileInfo.isFile() || fileInfo.size > 524288) throw new ProbeError('NODE_FILE_SIZE_INVALID');
        const token = 'host-xray-' + crypto.randomUUID();
        privatePaths = {
            config: path.join(privateDir, token + '.config.json'),
            stdout: path.join(privateDir, token + '.stdout.log'),
            stderr: path.join(privateDir, token + '.stderr.log'),
            runner: path.join(privateDir, token + '.runner.log')
        };
        summary.stage = 'parser';
        const parser = loadNodeParser(options.get('--typescript-dir'));
        summary.stage = 'node';
        const outbound = selectOutbound(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''), options, parser);
        ensureTime();
        summary.stage = 'core-version';
        const coreDir = options.has('--core-dir') ? path.resolve(options.get('--core-dir')) : path.join(PROJECT, 'build/host');
        const executable = options.has('--core-executable') ? path.resolve(options.get('--core-executable')) : path.join(coreDir, 'xray.exe');
        const record = JSON.parse(fs.readFileSync(path.join(coreDir, 'build-verification.json'), 'utf8').replace(/^\uFEFF/, ''));
        // Alternate cores are an explicit A/B option. Every run still checks the
        // locally recorded binary digest and the executable's reported version.
        if (typeof record.xrayVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.xrayVersion) ||
            typeof record.coreModule !== 'string' || !/^github\.com\/xtls\/xray-core@(v[\d.]+|devel)$/i.test(record.coreModule) ||
            (!options.has('--core-dir') && (record.xrayVersion !== EXPECTED_VERSION || record.coreModule !== EXPECTED_MODULE)) ||
            record.executableSHA256 !== crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex')) {
            throw new ProbeError('CORE_BUILD_VERIFICATION_MISMATCH');
        }
        const version = spawnSync(executable, ['version'], { windowsHide: true, encoding: 'utf8',
            timeout: Math.min(2000, remaining()), maxBuffer: 65536 });
        fs.writeFileSync(privatePaths.stdout, version.stdout || '', { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(privatePaths.stderr, version.stderr || '', { flag: 'wx', mode: 0o600 });
        if (version.error || version.status !== 0 ||
            !new RegExp('^Xray ' + record.xrayVersion.replace(/\./g, '\\.') + '\\b').test(version.stdout || '')) {
            throw new ProbeError('CORE_VERSION_CHECK_FAILED');
        }
        summary.xrayVersion = record.xrayVersion;
        summary.coreModule = record.coreModule;
        ensureTime();
        summary.stage = 'startup';
        const port = await withAbort(new Promise((resolve, reject) => {
            const reservation = net.createServer();
            reservation.once('error', reject);
            reservation.listen(0, '127.0.0.1', () => {
                const value = reservation.address().port;
                reservation.close(error => error ? reject(error) : resolve(value));
            });
        }));
        const proxyPassword = crypto.randomBytes(24).toString('base64url');
        const config = {
            log: { loglevel: 'info' },
            inbounds: [{ tag: 'host-ab-loopback', listen: '127.0.0.1', port, protocol: 'http',
                settings: { allowTransparent: false, accounts: [{ user: 'host-ab', pass: proxyPassword }] } }],
            outbounds: [outbound]
        };
        fs.writeFileSync(privatePaths.config, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
        logDescriptors.push(fs.openSync(privatePaths.stdout, 'a'));
        logDescriptors.push(fs.openSync(privatePaths.stderr, 'a'));
        const childEnv = { ...process.env };
        for (const key of Object.keys(childEnv)) {
            if (/^(XRAY_|V2RAY_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)) delete childEnv[key];
        }
        child = spawn(executable, ['run', '-config', privatePaths.config], {
            windowsHide: true, shell: false, env: childEnv, stdio: ['ignore', ...logDescriptors]
        });
        child.on('error', error => { childError = error; });
        childClosed = new Promise(resolve => child.once('close', resolve));
        let proxy;
        while (!proxy) {
            ensureTime();
            if (childError || child.exitCode !== null) throw new ProbeError('CORE_START_FAILED');
            try { proxy = await connect(port); } catch (error) {
                ensureTime();
                if (error?.code !== 'ECONNREFUSED') throw error;
                await delay(40);
            }
        }
        summary.stage = 'connect';
        const credentials = Buffer.from('host-ab:' + proxyPassword).toString('base64');
        const proxyStatus = await headers(proxy,
            `CONNECT ${TARGET_IP}:443 HTTP/1.1\r\nHost: ${TARGET_IP}:443\r\n` +
            `Proxy-Authorization: Basic ${credentials}\r\n\r\n`);
        if (proxyStatus !== 200) {
            summary.httpStatus = proxyStatus;
            throw new ProbeError('PROXY_CONNECT_REJECTED');
        }
        ensureTime();
        summary.stage = 'tls';
        if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new ProbeError('INSECURE_TLS_ENV_REJECTED');
        const secure = track(tls.connect({ socket: proxy, rejectUnauthorized: true, minVersion: 'TLSv1.2',
            // The target is an IP, so do not send an IP literal as SNI. Explicit
            // identity checking still requires that exact IP in the certificate.
            checkServerIdentity: (_, certificate) => tls.checkServerIdentity(TARGET_IP, certificate) }));
        await withAbort(new Promise((resolve, reject) => {
            const closed = () => finish(new ProbeError('TLS_PEER_CLOSED'));
            function finish(error) {
                secure.removeListener('error', finish);
                secure.removeListener('close', closed);
                secure.removeListener('end', closed);
                if (error) reject(error); else resolve();
            }
            secure.once('secureConnect', () => finish(secure.authorized ? null : new ProbeError('TLS_CERTIFICATE_REJECTED')));
            secure.once('error', finish);
            secure.once('close', closed);
            secure.once('end', closed);
        }));
        ensureTime();
        summary.stage = 'http';
        summary.httpStatus = await headers(secure,
            `GET ${TARGET_PATH} HTTP/1.1\r\nHost: ${TARGET_IP}\r\nConnection: close\r\n` +
            'User-Agent: HarmonyVpnLab-host-ab/0.1\r\n\r\n');
        if (summary.httpStatus !== 200) throw new ProbeError('HTTP_STATUS_REJECTED');
        summary.success = true;
        summary.stage = 'complete';
    } catch (error) {
        summary.errorClass = classify(error, summary.stage, controller.signal.aborted);
        if (privatePaths) {
            try { fs.writeFileSync(privatePaths.runner, String(error?.stack || error), { flag: 'wx', mode: 0o600 }); } catch (_) {}
        }
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        for (const socket of sockets) socket.destroy();
        if (child && child.exitCode === null && child.signalCode === null) child.kill();
        if (childClosed) {
            let settled = false;
            await Promise.race([childClosed.then(() => { settled = true; }), new Promise(resolve => setTimeout(resolve, 500))]);
            if (!settled && child && child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await Promise.race([childClosed.then(() => { settled = true; }), new Promise(resolve => setTimeout(resolve, 200))]);
            }
            if (!settled) {
                summary.success = false;
                summary.stage = 'cleanup';
                summary.errorClass = 'PROCESS_CLEANUP_FAILED';
            }
        }
        for (const fd of logDescriptors) { try { fs.closeSync(fd); } catch (_) {} }
        if (privatePaths) {
            for (const logPath of [privatePaths.stdout, privatePaths.stderr]) {
                try {
                    const log = fs.readFileSync(logPath, 'utf8');
                    summary.realityInvalidConnectionCount += (log.match(/REALITY[^\r\n]*invalid[ _-]?connection/gi) || []).length;
                    summary.socketOptionErrorCount += (log.match(/failed to (?:apply socket|set IP(?:V6)?_UNICAST_IF|find the interface)/gi) || []).length;
                } catch (_) {}
            }
        }
        if (summary.socketOptionErrorCount > 0) {
            summary.success = false;
            summary.errorClass = 'SOCKET_OPTION_FAILED';
        }
        summary.elapsedMs = Math.round(performance.now() - started);
    }
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.exitCode = summary.success ? 0 : 1;
}

main().catch(() => {
    // No raw exception, stack, path, address, certificate or configuration leaves
    // this process through public stdout/stderr, including setup failures.
    process.stdout.write(JSON.stringify({ success: false, stage: 'internal', httpStatus: null,
        xrayVersion: 'unverified', coreModule: EXPECTED_MODULE, elapsedMs: null,
        errorClass: 'UNEXPECTED_LOCAL_FAILURE', realityInvalidConnectionCount: 0 }) + '\n');
    process.exitCode = 1;
});
