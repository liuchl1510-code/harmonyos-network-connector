'use strict';
// Fixed-label parsing only; this test never opens HDC or reads private data.
const assert = require('node:assert/strict');
const { latencyLabel, DriverError } = require('./test-node-latency-device.cjs');
const cases = [
  ['HTTPS 2340 ms', 2340, null, null],
  ['首次 HTTPS 2340 ms\n复用延迟 未检测（旧记录）', 2340, null, null],
  ['首次 HTTPS 2400 ms\n复用延迟 230 ms · 09-11 08:00', 2400, 230, 'reused'],
  ['首次 HTTPS 2400 ms\n再次 HTTPS 800 ms（新建连接）', 2400, 800, 'new'],
  ['首次 HTTPS 2400 ms\n再次 HTTPS 800 ms（复用未确认）', 2400, 800, 'unknown'],
  ['首次 HTTPS 0 ms\n复用延迟 0 ms', 0, 0, 'reused'],
  ['首次 HTTPS 2400 ms\n复用检测超时', 2400, null, null],
  ['首次 HTTPS 2400 ms\n复用检测未通过', 2400, null, null]
];
for (const [text, first, second, connection] of cases) {
  const value = latencyLabel(text);
  assert.equal(value.status, 'passed'); assert.equal(value.durationMs, first);
  assert.equal(value.secondDurationMs, second); assert.equal(value.secondConnection, connection);
}
for (const text of ['首次 HTTPS 99999 ms', '首次 HTTPS 2 ms\n复用延迟 99999 ms',
  '首次 HTTPS 2 ms\nhttps://private.invalid/secret', '未检测\n复用延迟 1 ms',
  '首次 HTTPS 2 ms\n复用延迟 1 ms\nprivate', '首次 HTTPS 2 ms\n再次 HTTPS 1 ms（私密数据）']) {
  assert.throws(() => latencyLabel(text), error => error instanceof DriverError && !error.message.includes('private'));
}
assert.equal(latencyLabel('已取消：连接已停止').status, 'cancelled');
assert.equal(latencyLabel('失败：检测超时').status, 'failed');
console.log('Latency device labels: 16 synthetic cases passed; no device actions.');
