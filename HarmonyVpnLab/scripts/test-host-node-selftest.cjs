// Reproducible synthetic validation. Never opens the user's .private directory.
// All node connections terminate at these temporary loopback fixture servers.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

async function main() {
    const project = path.resolve(__dirname, '..');
    const privateDir = path.join(os.tmpdir(), 'HarmonyVpnLab-host-synthetic-' + crypto.randomUUID(), '.private');
    fs.mkdirSync(privateDir, { recursive: true });
    const sockets = new Set();
    const closedFixture = net.createServer(socket => {
        socket.on('error', () => {});
        socket.end();
    });
    const stalledFixture = net.createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
    });
    const cases = [];
    function save(name, value) {
        const file = path.join(privateDir, name);
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
        return file;
    }
    function run(file, args = [], timeout = 4000) {
        return new Promise((resolve, reject) => {
            const started = performance.now();
            const child = spawn(process.execPath, [path.join(__dirname, 'test-host-node.cjs'),
                '--node-file', file, '--timeout-ms', String(timeout), ...args], {
                windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            const watchdog = setTimeout(() => { child.kill(); reject(new Error('RUNNER_DID_NOT_EXIT')); }, timeout + 2000);
            child.stdout.on('data', value => { stdout += value; });
            child.stderr.on('data', value => { stderr += value; });
            child.once('error', error => { clearTimeout(watchdog); reject(error); });
            child.once('close', code => {
                clearTimeout(watchdog);
                try {
                    assert.equal(stderr, '');
                    assert.equal(code, 1); // Each fixture deliberately cannot serve a real target.
                    const result = JSON.parse(stdout);
                    assert.equal(result.success, false);
                    resolve({ ...result, runnerProcessElapsedMs: Math.round(performance.now() - started) });
                } catch (error) { reject(error); }
            });
        });
    }
    try {
        await new Promise(resolve => closedFixture.listen(0, '127.0.0.1', resolve));
        await new Promise(resolve => stalledFixture.listen(0, '127.0.0.1', resolve));
        const outbound = {
            protocol: 'vless',
            settings: { vnext: [{ address: '127.0.0.1', port: closedFixture.address().port,
                users: [{ id: 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60', encryption: 'none' }] }] },
            streamSettings: { network: 'tcp', security: 'none' }
        };
        const full = { inbounds: [{ protocol: 'tun' }],
            routing: { rules: [{ type: 'field', outboundTag: 'must-not-run' }] },
            outbounds: [outbound, { protocol: 'freedom' }] };
        const invalid = save('synthetic-invalid.txt', 'not-a-node');
        const complete = save('synthetic-complete.json', full);
        const unsupported = save('synthetic-unsupported.json', { outbounds: [{ ...outbound,
            streamSettings: { network: 'raw', security: 'reality',
                realitySettings: { mldsa65Verify: 'synthetic-nonempty' } } }] });
        let result = await run(invalid);
        assert.equal(result.errorClass, 'NODE_PARSE_FAILED');
        cases.push({ name: 'invalid-node', ...result });
        result = await run(complete);
        assert.equal(result.errorClass, 'OUTBOUND_INDEX_REQUIRED');
        cases.push({ name: 'explicit-index-required', ...result });
        result = await run(unsupported, ['--outbound-index', '0']);
        assert.equal(result.errorClass, 'UNSUPPORTED_SECURITY');
        cases.push({ name: 'nonempty-mldsa65-rejected', ...result });
        result = await run(complete, ['--outbound-index', '0']);
        assert.equal(result.xrayVersion, '25.8.3');
        assert(['tls', 'connect'].includes(result.stage));
        assert(result.elapsedMs < 4000);
        cases.push({ name: 'loopback-node-closed', ...result });

        result = await run(complete, ['--outbound-index', '0', '--core-dir', path.join(project, 'build/host'),
            '--core-executable', path.join(project, 'build/host/xray.exe')]);
        assert.equal(result.xrayVersion, '25.8.3');
        assert(['tls', 'connect'].includes(result.stage));
        cases.push({ name: 'explicit-core-directory', ...result });

        const invalidCoreDir = path.join(path.dirname(privateDir), 'invalid-core');
        fs.mkdirSync(invalidCoreDir);
        fs.copyFileSync(path.join(project, 'build/host/xray.exe'), path.join(invalidCoreDir, 'xray.exe'));
        const invalidRecord = JSON.parse(fs.readFileSync(path.join(project, 'build/host/build-verification.json'), 'utf8').replace(/^\uFEFF/, ''));
        invalidRecord.executableSHA256 = '0'.repeat(64);
        fs.writeFileSync(path.join(invalidCoreDir, 'build-verification.json'), JSON.stringify(invalidRecord));
        result = await run(complete, ['--outbound-index', '0', '--core-dir', invalidCoreDir]);
        assert.equal(result.stage, 'core-version');
        assert.equal(result.errorClass, 'CORE_BUILD_VERIFICATION_MISMATCH');
        cases.push({ name: 'alternate-core-digest-rejected', ...result });

        const override = save('synthetic-override.json', {
            protocol: 'vless', settings: { vnext: [{ address: 'node.example.invalid', port: stalledFixture.address().port,
                users: [{ id: 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60', encryption: 'none' }] }] },
            streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'synthetic-server.invalid' } }
        });
        result = await run(override, ['--server-address', '127.0.0.1'], 2000);
        assert.equal(result.errorClass, 'TIMEOUT');
        assert(result.elapsedMs < 2200);
        assert(result.runnerProcessElapsedMs < 3500);
        cases.push({ name: 'loopback-stall-timeout-and-override', ...result });

        let overrideChecked = false;
        for (const name of fs.readdirSync(privateDir).filter(name => name.endsWith('.config.json'))) {
            const config = JSON.parse(fs.readFileSync(path.join(privateDir, name), 'utf8'));
            assert.equal(config.inbounds.length, 1);
            assert.equal(config.inbounds[0].listen, '127.0.0.1');
            assert.equal(config.inbounds[0].protocol, 'http');
            assert.equal(config.outbounds.length, 1);
            assert.equal(config.routing, undefined);
            assert.equal(config.dns, undefined);
            if (config.outbounds[0].streamSettings.security === 'tls') {
                assert.equal(config.outbounds[0].settings.vnext[0].address, '127.0.0.1');
                assert.equal(config.outbounds[0].streamSettings.tlsSettings.serverName, 'synthetic-server.invalid');
                overrideChecked = true;
            }
        }
        assert(overrideChecked);
        const report = { checkedAt: new Date().toISOString(), passed: cases.length, total: 7, cases,
            scope: 'Synthetic invalid files and two loopback fixtures only; no user node file read or external node connection.',
            limitations: 'Does not establish real-node reachability or successful end-to-end HTTPS; SDK parser APIs are mocked.' };
        const output = path.join(project, 'build/host/runner-verification.json');
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ passed: cases.length, total: 7, output, scope: report.scope }));
    } finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all([new Promise(resolve => closedFixture.close(resolve)),
            new Promise(resolve => stalledFixture.close(resolve))]);
    }
}

main().catch(error => {
    console.error('Synthetic host runner verification failed (synthetic inputs only): ' + error.message);
    process.exitCode = 1;
});
