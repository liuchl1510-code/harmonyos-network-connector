'use strict';
// Parse the actual ArkTS UI trees using the installed SDK's component grammar,
// then evaluate their authored width bindings with the actual shared layout
// model. This verifies integration and geometry contracts, not native rendering.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sdk = path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader');
const ts = require(path.join(sdk, 'node_modules/typescript'));
const parserOptions = ts.readConfigFile(path.join(sdk, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions;
const pages = ['Settings', 'NetworkSettings', 'NodeConfig', 'Subscriptions', 'NodeEditor', 'NodeBackup',
  'About', 'Privacy', 'Diagnostics', 'DiagnosticSummary', 'Index', 'RuntimeSmoke'];
const modelPath = path.join(root, 'entry/src/main/ets/model/AdaptiveLayout.ets');
const modelSource = fs.readFileSync(modelPath, 'utf8');
const modelCompiled = ts.transpileModule(modelSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(modelCompiled.diagnostics.length, 0, 'Layout model transpilation');
const layout = {};
vm.runInNewContext(modelCompiled.outputText, { exports: layout, module: { exports: layout } });
assert.equal(typeof layout.formContentWidth, 'function');
const widths = [240, 320, 360, 480, 600, 768, 840, 841, 1024, 1280, 1920];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function componentAttributes(component) {
  const attributes = new Map();
  let node = component;
  while (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node &&
    node.parent.parent && ts.isCallExpression(node.parent.parent)) {
    const access = node.parent, call = access.parent;
    attributes.set(access.name.text, call.arguments);
    node = call;
  }
  return attributes;
}
function componentOf(expression) {
  let node = expression;
  while (node && !ts.isEtsComponentExpression(node) && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    node = node.expression.expression;
  }
  return node && ts.isEtsComponentExpression(node) ? node : undefined;
}
function directComponents(component) {
  return (component.body?.statements || []).filter(ts.isExpressionStatement).map(statement => componentOf(statement.expression)).filter(Boolean);
}
function expectAdaptive(component, source, label, sideNavigation = false) {
  const expression = componentAttributes(component).get('width')?.[0];
  assert(expression && ts.isCallExpression(expression), label + ': content width is not bound to the layout model');
  assert.equal(expression.expression.getText(source), 'formContentWidth', label + ': wrong width provider');
  assert.equal(expression.arguments.length, 1);
  assert.equal(expression.arguments[0].getText(source), 'this.windowWidthVp', label + ': stale or hard-coded viewport width');
  // Evaluate the validated actual binding, not a reimplementation of its math.
  const evaluate = new Function('formContentWidth', 'return ' + expression.getText(source));
  return widths.map(viewport => {
    const content = evaluate.call({ windowWidthVp: viewport }, layout.formContentWidth);
    const available = sideNavigation && layout.useSideNavigation(viewport) ? viewport - 176 : viewport;
    assert(Number.isFinite(content) && content > 0 && content <= available && content <= 840,
      `${label}: content exceeds the window or form limit at ${viewport} vp`);
    if (viewport <= 840) assert.equal(content, viewport, label + ': narrow layouts lost available width');
    const left = (available - content) / 2, right = available - left - content;
    assert.equal(left, right, label + ': centered geometry is asymmetric');
    return { viewport, available, content, margin: left };
  });
}
const reports = [], hashes = { 'model/AdaptiveLayout.ets': hash(modelSource) };
const beforeArgument = process.argv.indexOf('--before');
const before = beforeArgument >= 0 ? JSON.parse(fs.readFileSync(process.argv[beforeArgument + 1], 'utf8')) : undefined;
for (const name of pages) {
  const file = path.join(root, `entry/src/main/ets/pages/${name}.ets`);
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, parserOptions);
  assert.equal(source.parseDiagnostics.length, 0, `${name}: ArkTS UI parse error`);
  hashes[`pages/${name}.ets`] = hash(text);
  const structure = source.statements.find(node => node.kind === ts.SyntaxKind.StructDeclaration);
  assert(structure, name + ': missing page component');
  const viewportProperty = structure.members.find(member => ts.isPropertyDeclaration(member) && member.name.getText(source) === 'windowWidthVp');
  assert(viewportProperty, name + ': missing live viewport property');
  assert.equal(viewportProperty.initializer.getText(source), '360');
  const decorator = viewportProperty.modifiers?.find(ts.isDecorator);
  assert(decorator && ts.isCallExpression(decorator.expression));
  assert.equal(decorator.expression.expression.getText(source), 'StorageProp');
  assert.equal(decorator.expression.arguments[0].text, 'windowWidthVp');
  const build = structure.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'build');
  const rootExpression = build.body.statements.find(ts.isExpressionStatement)?.expression;
  const pageRoot = componentOf(rootExpression);
  assert(pageRoot, name + ': missing root layout');
  const rootAttributes = componentAttributes(pageRoot);
  assert.equal(rootAttributes.get('width')?.[0].text, '100%', name + ': page stopped filling the window');
  assert.equal(rootAttributes.get('height')?.[0].text, '100%', name + ': page stopped filling available height');
  let contentBody = build.body;
  if (name === 'Settings') {
    const shells = [];
    walk(build.body, node => {
      if ((ts.isCallExpression(node) || ts.isEtsComponentExpression(node)) && node.expression.getText(source) === 'GlassDockLayout') shells.push(node);
    });
    assert.equal(shells.length, 1, 'Settings: missing shared shell');
    const shell = shells[0], argument = shell.arguments[0]; assert(ts.isObjectLiteralExpression(argument));
    const props = new Map(argument.properties.map(property => [property.name.getText(source), property.initializer.getText(source)]));
    assert.equal(props.get('content'), '() => { this.pageContent(); }');
    assert.equal(props.get('showDock'), '!useSideNavigation(this.windowWidthVp)');
    const pane = componentAttributes(shell);
    assert(pane.has('layoutWeight'), 'Settings: main pane does not receive remaining width');
    assert.equal(pane.get('height')?.[0].text, '100%', 'Settings: main pane lost available height');
    const builder = structure.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'pageContent');
    assert(builder?.modifiers?.some(modifier => ts.isDecorator(modifier) && modifier.expression.getText(source) === 'Builder'));
    contentBody = builder.body;
  }
  const scrolls = [];
  walk(contentBody, node => { if (ts.isEtsComponentExpression(node) && node.expression.getText(source) === 'Scroll') scrolls.push(node); });
  let geometries;
  if (name === 'RuntimeSmoke') {
    assert.equal(rootAttributes.get('justifyContent')?.[0].getText(source), 'FlexAlign.Center');
    geometries = expectAdaptive(directComponents(pageRoot)[0], source, name + ' content');
  } else {
    assert.equal(scrolls.length, 1, name + ': unexpected scrolling structure');
    const scroll = scrolls[0], attributes = componentAttributes(scroll);
    assert.equal(attributes.get('width')?.[0].text, '100%', name + ': scroll viewport does not fill the window');
    assert(attributes.has('layoutWeight') || attributes.get('height')?.[0].text === '100%', name + ': scroll lost its usable height');
    assert.equal(attributes.get('align')?.[0].getText(source), 'Alignment.Top', name + ': content is not top-centered');
    const content = directComponents(scroll);
    assert.equal(content.length, 1, name + ': form needs one constrained content container');
    geometries = expectAdaptive(content[0], source, name + ' scroll content', name === 'Settings');
    if (pageRoot !== scroll) {
      for (const region of directComponents(pageRoot).filter(component => component !== scroll)) {
        // Framework navigation components without a layout body are owned by the
        // application shell; fixed form headers/actions share the content frame.
        if (!region.body) continue;
        if (name === 'Settings' && directComponents(region).includes(scroll)) {
          const pane = componentAttributes(region);
          assert(pane.has('layoutWeight'), 'Settings: main pane does not receive remaining width');
          assert.equal(pane.get('height')?.[0].text, '100%', 'Settings: main pane lost available height');
          continue;
        }
        const regionGeometry = expectAdaptive(region, source, name + ' fixed region');
        assert.deepEqual(regionGeometry, geometries, name + ': fixed header/action and body disagree');
      }
    }
  }
  if (before?.[name]) {
    let business = text.slice(0, text.indexOf('  build() {'));
    business = business.replace(/^import[^;]*;\r?\n/gm, '').replace(/^\s*@StorageProp\([^\n]*\r?\n/gm, '');
    assert.equal(hash(business), before[name].businessHash, name + ': business methods or existing state changed');
    const ids = [...text.matchAll(/\.id\(([^\r\n]+?)\)/g)].map(match => match[1]);
    const events = [...text.matchAll(/\.(?:onClick|onChange|onSelect|onBackPress)\(([^\r\n]*)/g)].map(match => match[0]);
    assert.deepEqual(ids, before[name].ids, name + ': control IDs changed');
    assert.deepEqual(events, before[name].events, name + ': event handlers changed');
  }
  reports.push({ page: name, passed: true, geometries });
}
const report = { passed: reports.length, failed: 0, sourceSHA256: hashes, pages: reports,
  interactionBaselineCompared: Boolean(before), scope: 'SDK ArkTS AST integration and authored width geometry; no native layout, font rendering, emulator or device execution.' };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/adaptive-secondary-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, interactionBaselineCompared: report.interactionBaselineCompared, scope: report.scope }));
