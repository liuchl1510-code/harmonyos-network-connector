#!/usr/bin/env node
'use strict';

// Offline analysis of explicitly supplied, synthetic UI profiling captures.
// Never emits heap strings, property names, source text, paths, or error text.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const CANDIDATES = Object.freeze(['Index', 'Home', 'Nodes', 'Settings', 'NetworkSettings', 'About', 'Privacy',
  'NodeEditor', 'NodeConfig', 'NodeBackup', 'Subscriptions', 'Diagnostics', 'ViewPU', 'ViewV2',
  'ObservedPropertySimplePU', 'ObservedPropertyObjectPU', 'ObservedPropertyPU',
  'SynchedPropertySimpleOneWayPU', 'SynchedPropertyObjectOneWayPU', 'SynchedPropertySimpleTwoWayPU',
  'SynchedPropertyObjectTwoWayPU', 'SubscriberManager']);
const NODE_TYPES = new Set(['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native',
  'synthetic', 'concatenated string', 'sliced string', 'slicedstring', 'symbol', 'bigint', 'class', 'framework', 'handle']);
const EDGE_TYPES = new Set(['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak', 'native',
  'native_string', 'xref']);
const STRING_TYPES = new Set(['string', 'concatenated string', 'sliced string', 'slicedstring']);
const CLASSIFIABLE = new Set(['object', 'framework', 'class']);
const STRUCTURAL = new Set(['__proto__', 'prototype', 'constructor']);
const TOKENS = CANDIDATES.map(name => [name, new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`)]);
const check = (condition, code) => assert(condition, code);
const integer = n => Number.isSafeInteger(n) && n >= 0;
function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), 'TIMESTAMP_INVALID');
  const number = Date.parse(value); check(integer(number), 'TIMESTAMP_INVALID'); return number;
}
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const zero = () => ({ count: 0, selfBytes: 0, nativeBytes: 0 });
function add(sum, selfBytes, nativeBytes) { sum.count++; sum.selfBytes += selfBytes; sum.nativeBytes += nativeBytes; }
function candidate(name) {
  const matches = TOKENS.filter(([, expression]) => expression.test(name));
  return matches.length === 1 ? matches[0][0] : null;
}
function loadCapture(directory) {
  const capture = JSON.parse(fs.readFileSync(path.join(directory, 'capture.json'), 'utf8').replace(/^\uFEFF/, ''));
  check(capture.state === 'complete' && capture.heapPrivate === true, 'CAPTURE_NOT_COMPLETE_PRIVATE');
  const identity = capture.identity;
  check(identity && integer(identity.pid) && identity.pid > 0 && integer(identity.startTimeTicks), 'IDENTITY_INVALID');
  check(identity.mainTid === identity.pid, 'NOT_MAIN_THREAD_CAPTURE');
  check(typeof identity.artifactSHA256 === 'string' && /^[a-f0-9]{64}$/i.test(identity.artifactSHA256), 'ARTIFACT_HASH_INVALID');
  const receipt = capture.apiReceipt;
  check(receipt && receipt.state === 'completed' && ['legacy', 'raw'].includes(receipt.api), 'RECEIPT_INVALID');
  const gcMode = receipt.api === 'legacy' ? 'platform-default' : 'explicit-boolean';
  check(receipt.gcMode === gcMode && typeof receipt.requestedNeedGC === 'boolean', 'GC_RECEIPT_INVALID');
  check(integer(receipt.requestNumber) && receipt.requestNumber > 0, 'REQUEST_NUMBER_INVALID');
  const timeline = { requestNumber: receipt.requestNumber, captureStart: timestamp(capture.startedAt),
    apiStart: timestamp(receipt.requestedAt), apiEnd: timestamp(receipt.finishedAt), captureEnd: timestamp(capture.finishedAt) };
  check(timeline.captureStart <= timeline.apiStart && timeline.apiStart <= timeline.apiEnd &&
    timeline.apiEnd <= timeline.captureEnd, 'CAPTURE_TIME_ORDER_INVALID');
  check(receipt.needClean === false, 'NODE_ID_CACHE_CLEARED_OR_UNKNOWN');
  const bytes = fs.readFileSync(path.join(directory, 'snapshot.heapsnapshot'));
  const hash = sha256(bytes);
  check(capture.converted && capture.converted.sha256.toLowerCase() === hash && capture.converted.bytes === bytes.length,
    'CONVERTED_HASH_OR_SIZE_MISMATCH');
  const heap = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const { nodes, edges, strings } = heap;
  const { meta, node_count: count, edge_count: edgeCount } = heap.snapshot;
  check(Array.isArray(nodes) && Array.isArray(edges) && Array.isArray(strings) && integer(count) && integer(edgeCount),
    'HEAP_ARRAYS_INVALID');
  const fields = meta.node_fields; const edgeFields = meta.edge_fields;
  check(Array.isArray(fields) && new Set(fields).size === fields.length, 'NODE_FIELDS_INVALID');
  check(Array.isArray(edgeFields) && new Set(edgeFields).size === edgeFields.length, 'EDGE_FIELDS_INVALID');
  const nf = Object.fromEntries(['type', 'name', 'id', 'self_size', 'edge_count', 'native_size'].map(k => [k, fields.indexOf(k)]));
  const ef = Object.fromEntries(['type', 'name_or_index', 'to_node'].map(k => [k, edgeFields.indexOf(k)]));
  check(Object.values(nf).every(i => i >= 0) && Object.values(ef).every(i => i >= 0), 'REQUIRED_FIELDS_MISSING');
  check(nodes.length === count * fields.length && edges.length === edgeCount * edgeFields.length, 'ARRAY_COUNTS_MISMATCH');
  check(capture.converted.nodeCount === count && capture.converted.edgeCount === edgeCount, 'RECEIPT_COUNTS_MISMATCH');
  const nt = meta.node_types[nf.type]; const et = meta.edge_types[ef.type];
  check(Array.isArray(nt) && new Set(nt).size === nt.length && nt.every(t => NODE_TYPES.has(t)), 'NODE_TYPE_ENUM_UNSUPPORTED');
  check(Array.isArray(et) && new Set(et).size === et.length && et.every(t => EDGE_TYPES.has(t)), 'EDGE_TYPE_ENUM_UNSUPPORTED');
  const nodeWidth = fields.length; const edgeWidth = edgeFields.length;
  const starts = new Uint32Array(count + 1); const ids = new Set();
  const id = i => nodes[i * nodeWidth + nf.id];
  const type = i => nt[nodes[i * nodeWidth + nf.type]];
  const name = i => strings[nodes[i * nodeWidth + nf.name]];
  const self = i => nodes[i * nodeWidth + nf.self_size];
  const native = i => nodes[i * nodeWidth + nf.native_size];
  let offset = 0; let reservedZeroHandleCount = 0;
  for (let i = 0; i < count; i++) {
    const row = i * nodeWidth;
    for (const key of ['type', 'name', 'id', 'self_size', 'edge_count', 'native_size']) {
      check(integer(nodes[row + nf[key]]), 'NODE_VALUE_INVALID');
    }
    check(nodes[row + nf.type] < nt.length && nodes[row + nf.name] < strings.length, 'NODE_INDEX_INVALID');
    check(typeof name(i) === 'string', 'NODE_NAME_INVALID');
    // This Ark exporter uses ID 0 for multiple synthetic handle records.
    // Keep them in totals, but exclude them from cross-snapshot ID matching.
    if (id(i) === 0 && type(i) === 'handle') reservedZeroHandleCount++;
    else check(id(i) > 0 && !ids.has(id(i)), 'DUPLICATE_NODE_ID');
    ids.add(id(i));
    starts[i] = offset; offset += nodes[row + nf.edge_count] * edgeWidth;
    check(offset <= edges.length, 'EDGE_COUNT_OVERFLOW');
  }
  starts[count] = offset; check(offset === edges.length, 'EDGE_COUNT_SUM_MISMATCH');
  for (let p = 0; p < edges.length; p += edgeWidth) {
    check(integer(edges[p + ef.type]) && edges[p + ef.type] < et.length, 'EDGE_TYPE_INVALID');
    const to = edges[p + ef.to_node];
    check(integer(to) && to < nodes.length && to % nodeWidth === 0, 'EDGE_DESTINATION_INVALID');
    const kind = et[edges[p + ef.type]], value = edges[p + ef.name_or_index];
    check(integer(value), 'EDGE_NAME_INVALID');
    if (!['element', 'hidden'].includes(kind)) check(value < strings.length, 'EDGE_STRING_INDEX_INVALID');
  }
  const structural = new Map();
  for (let i = 0; i < count; i++) {
    if (!CLASSIFIABLE.has(type(i)) && type(i) !== 'closure') continue;
    const found = Object.create(null);
    for (let p = starts[i]; p < starts[i + 1]; p += edgeWidth) {
      if (et[edges[p + ef.type]] !== 'property') continue;
      const key = strings[edges[p + ef.name_or_index]];
      if (STRUCTURAL.has(key)) found[key] = edges[p + ef.to_node] / nodeWidth;
    }
    structural.set(i, found);
  }
  // Resolve prototypes from their own constructor edge. Never count a class
  // definition or method closure as an instance merely because its name matches.
  const prototypes = new Map();
  for (const [i, links] of structural) {
    if (!CLASSIFIABLE.has(type(i)) || links.constructor === undefined) continue;
    const ctor = links.constructor;
    if (!['closure', 'framework', 'class'].includes(type(ctor))) continue;
    const className = candidate(name(ctor));
    if (className) prototypes.set(i, { className, constructorIndex: ctor });
  }
  const classified = new Map();
  for (let i = 0; i < count; i++) {
    if (STRING_TYPES.has(type(i))) continue;
    const tokenClass = candidate(name(i)); const links = structural.get(i) || Object.create(null);
    let className = tokenClass, role = type(i) === 'closure' ? 'closureNameToken' : 'nameTokenOnly';
    let witness = null;
    if (prototypes.has(i)) { className = prototypes.get(i).className; role = 'prototype'; }
    else if (CLASSIFIABLE.has(type(i)) && prototypes.has(links.__proto__)) {
      const proto = prototypes.get(links.__proto__);
      className = proto.className;
      role = links.constructor === undefined ? 'instanceViaPrototypeConstructor' : 'derivedPrototypeViaBase';
      witness = [id(i), id(links.__proto__), id(proto.constructorIndex)];
    } else if (className && ['closure', 'framework', 'class'].includes(type(i)) && links.prototype !== undefined) {
      role = 'constructorLike';
    }
    if (className) classified.set(i, { className, role, witness });
  }
  // A graph path excluding explicit weak edges is a retaining-path candidate,
  // not proof of GC liveness: runtime special/ephemeron semantics are not modeled.
  check(type(0) === 'synthetic', 'EXPECTED_SYNTHETIC_ROOT');
  const parent = new Int32Array(count).fill(-1); const queue = new Uint32Array(count);
  let head = 0, tail = 1; queue[0] = 0; parent[0] = 0;
  while (head < tail) {
    const from = queue[head++];
    for (let p = starts[from]; p < starts[from + 1]; p += edgeWidth) {
      if (et[edges[p + ef.type]] === 'weak') continue;
      const to = edges[p + ef.to_node] / nodeWidth;
      if (parent[to] === -1) { parent[to] = from; queue[tail++] = to; }
    }
  }
  function rootPath(i) {
    if (parent[i] === -1) return null;
    const result = []; let cursor = i;
    while (true) { result.push({ nodeOrdinal: cursor, objectId: id(cursor) }); if (cursor === 0) break; cursor = parent[cursor]; }
    return result.reverse();
  }
  const byType = Object.fromEntries(nt.filter(t => !STRING_TYPES.has(t)).map(t => [t, zero()]));
  const byClass = Object.fromEntries(CANDIDATES.map(c => [c, {}]));
  const objectById = new Map(); let stringNodeCount = 0; const total = zero();
  for (let i = 0; i < count; i++) {
    if (STRING_TYPES.has(type(i))) { stringNodeCount++; continue; }
    add(total, self(i), native(i)); add(byType[type(i)], self(i), native(i));
    if (id(i) > 0) objectById.set(id(i), { type: type(i), nodeOrdinal: i, selfBytes: self(i), nativeBytes: native(i) });
    const c = classified.get(i);
    if (!c) continue;
    byClass[c.className][c.role] ||= { ...zero(), byNodeType: {}, ids: [] };
    const group = byClass[c.className][c.role]; add(group, self(i), native(i));
    group.byNodeType[type(i)] = (group.byNodeType[type(i)] || 0) + 1; group.ids.push(id(i));
  }
  const examples = [];
  for (const [i, c] of classified) {
    if (!['instanceViaPrototypeConstructor', 'prototype'].includes(c.role)) continue;
    if (examples.filter(x => x.className === c.className && x.role === c.role).length >= 5) continue;
    examples.push({ className: c.className, role: c.role, objectId: id(i), selfBytes: self(i), nativeBytes: native(i),
      prototypeConstructorWitnessIds: c.witness, rootPathIgnoringWeakEdges: rootPath(i) });
  }
  return {
    identity: { pid: identity.pid, mainTid: identity.mainTid, startTimeTicks: identity.startTimeTicks,
      artifactSHA256: identity.artifactSHA256.toLowerCase() },
    comparisonIdentity: [identity.target, identity.versionName, identity.versionCode], objectById, timeline,
    anonymousWitness: objectId => {
      const value = objectById.get(objectId);
      return value ? { objectId, nodeType: value.type, selfBytes: value.selfBytes, nativeBytes: value.nativeBytes,
        rootPathIgnoringWeakEdges: rootPath(value.nodeOrdinal) } : null;
    },
    public: { sha256: hash, fileBytes: bytes.length, api: receipt.api,
      gcMode, requestedNeedGC: receipt.requestedNeedGC, needClean: false,
      schema: { nodeWidth, edgeWidth, nativeSizePresent: true, reservedZeroHandleCount,
        nodeTypeDescriptorCount: meta.node_types.length, nodeTypeDescriptorCountMatchesFields: meta.node_types.length === nodeWidth },
      nodeCount: count, edgeCount, stringNodeCount, stringTableEntryCount: strings.length,
      graphReachableIgnoringWeakEdges: tail, totalNonString: total, byType, byClass, examples }
  };
}
function delta(a, b) { return { count: b.count - a.count, selfBytes: b.selfBytes - a.selfBytes, nativeBytes: b.nativeBytes - a.nativeBytes }; }
function compare(a, b) {
  check(JSON.stringify(a.identity) === JSON.stringify(b.identity) &&
    JSON.stringify(a.comparisonIdentity) === JSON.stringify(b.comparisonIdentity), 'CAPTURE_IDENTITIES_DIFFER');
  check(a.public.api === b.public.api && a.public.gcMode === b.public.gcMode &&
    a.public.requestedNeedGC === b.public.requestedNeedGC, 'CAPTURE_METHODS_DIFFER');
  const byType = {};
  for (const type of Object.keys(a.public.byType)) byType[type] = delta(a.public.byType[type], b.public.byType[type] || zero());
  const byClass = {};
  for (const className of CANDIDATES) {
    const ar = a.public.byClass[className], br = b.public.byClass[className]; byClass[className] = {};
    for (const role of new Set([...Object.keys(ar), ...Object.keys(br)])) {
      const ag = ar[role] || { ...zero(), ids: [] }, bg = br[role] || { ...zero(), ids: [] };
      const beforeIds = new Set(ag.ids), afterIds = new Set(bg.ids);
      byClass[className][role] = { ...delta(ag, bg), sameIds: bg.ids.filter(id => beforeIds.has(id)).length,
        addedIds: bg.ids.filter(id => !beforeIds.has(id)), removedIds: ag.ids.filter(id => !afterIds.has(id)) };
    }
  }
  const added = zero(), removed = zero(); let commonIds = 0, commonIdsSelfDelta = 0, commonIdsNativeDelta = 0;
  let sameIdTypeChangedCount = 0;
  for (const [id, value] of b.objectById) {
    const old = a.objectById.get(id);
    if (old) {
      commonIds++; commonIdsSelfDelta += value.selfBytes - old.selfBytes;
      commonIdsNativeDelta += value.nativeBytes - old.nativeBytes;
      if (old.type !== value.type) sameIdTypeChangedCount++;
    } else add(added, value.selfBytes, value.nativeBytes);
  }
  for (const [id, value] of a.objectById) if (!b.objectById.has(id)) add(removed, value.selfBytes, value.nativeBytes);
  const addedArrays = [], removedArrays = [], grownArrays = [], shrunkArrays = [];
  for (const [id, value] of b.objectById) {
    if (value.type !== 'array') continue;
    const old = a.objectById.get(id);
    if (!old) addedArrays.push({ id, selfBytes: value.selfBytes });
    else if (value.selfBytes > old.selfBytes) grownArrays.push({ id, selfBytes: value.selfBytes - old.selfBytes });
    else if (value.selfBytes < old.selfBytes) shrunkArrays.push({ id, selfBytes: old.selfBytes - value.selfBytes });
  }
  for (const [id, value] of a.objectById) {
    if (value.type === 'array' && !b.objectById.has(id)) removedArrays.push({ id, selfBytes: value.selfBytes });
  }
  const largest = (rows, capture = b) => rows.sort((x, y) => y.selfBytes - x.selfBytes || x.id - y.id).slice(0, 8)
    .map(row => ({ ...capture.anonymousWitness(row.id), comparedSelfBytes: row.selfBytes }));
  return { totalNonString: delta(a.public.totalNonString, b.public.totalNonString), byType, byClass,
    anonymousArrayWitnesses: { largestAddedArrays: largest(addedArrays), largestRemovedArrays: largest(removedArrays, a),
      largestGrownExistingArrays: largest(grownArrays), largestShrunkExistingArrays: largest(shrunkArrays) },
    nonStringIdentityChurn: { commonIds, commonIdsSelfDelta, commonIdsNativeDelta, sameIdTypeChangedCount, added, removed } };
}
function main(args) {
  let output = null; const directories = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') { check(!output && args[i + 1], 'OUTPUT_ARGUMENT_INVALID'); output = args[++i]; }
    else directories.push(args[i]);
  }
  check(directories.length >= 2 && directories.length <= 12, 'TWO_TO_TWELVE_CAPTURES_REQUIRED');
  if (output) {
    const resolved = path.resolve(output);
    check(path.extname(resolved) === '.json' && directories.every(directory =>
      !resolved.startsWith(path.resolve(directory) + path.sep)), 'OUTPUT_MUST_NOT_OVERWRITE_CAPTURE');
  }
  const captures = directories.map(loadCapture);
  for (let i = 1; i < captures.length; i++) {
    const previous = captures[i - 1].timeline, current = captures[i].timeline;
    check(previous.requestNumber < current.requestNumber && previous.captureEnd < current.captureStart,
      'CAPTURE_SEQUENCE_NOT_STRICTLY_INCREASING');
  }
  const report = { schemaVersion: 1, syntheticUiOnly: true, rawStringsOmitted: true, identity: captures[0].identity,
    interpretation: { classNamesAreFixedAllowlist: true, classInstancesRequirePrototypeConstructorEvidence: true,
      encodedClassNameTokenMayCollideAcrossModules: true, derivedPrototypesExcludedFromInstanceCounts: true,
      graphPathsExcludeExplicitWeakEdgesOnly: true, nodeIdCachePreservedByReceipt: true,
      defaultGcNotProvenBySnapshotFile: true, sizeDeltasAreNotLeakVerdicts: true,
      firstUseDefinitionsMayRemainCached: true, selfAndNativeSizesAreSeparate: true },
    captureSequenceValidated: true,
    captures: captures.map((c, index) => ({ captureIndex: index, requestNumber: c.timeline.requestNumber,
      captureElapsedMs: c.timeline.captureEnd - c.timeline.captureStart,
      apiElapsedMs: c.timeline.apiEnd - c.timeline.apiStart,
      sinceFirstCaptureMs: c.timeline.captureStart - captures[0].timeline.captureStart,
      gapFromPriorCaptureFinishMs: index ? c.timeline.captureStart - captures[index - 1].timeline.captureEnd : 0,
      ...c.public })),
    comparisons: captures.slice(1).map((c, index) => ({ beforeIndex: index, afterIndex: index + 1, ...compare(captures[index], c) })) };
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  // Console summary remains small. The optional JSON also contains only sanitized fields.
  const classes = Object.fromEntries(CANDIDATES.map(c => [c, report.captures.map(h =>
    Object.fromEntries(Object.entries(h.byClass[c]).map(([role, g]) => [role, { count: g.count, selfBytes: g.selfBytes, nativeBytes: g.nativeBytes }])))]));
  console.log(JSON.stringify({ schemaVersion: 1, validated: true, identity: report.identity,
    captures: report.captures.map(h => ({ captureIndex: h.captureIndex, nodeCount: h.nodeCount, edgeCount: h.edgeCount,
      stringNodeCount: h.stringNodeCount, stringTableEntryCount: h.stringTableEntryCount, totalNonString: h.totalNonString })),
    typeDeltas: report.comparisons.map(c => c.byType), classes }, null, 2));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ validated: false,
    code: error instanceof assert.AssertionError && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'ANALYSIS_FAILED' })); process.exitCode = 1; }
}
module.exports = { loadCapture, compare, CANDIDATES };
