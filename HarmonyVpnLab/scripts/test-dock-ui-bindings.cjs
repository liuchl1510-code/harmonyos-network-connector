'use strict';
// Static ArkUI wiring checks only. Action execution belongs to the dock and
// connection-session suites; native layout and system bars need device QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sdk = path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader');
const ts = require(path.join(sdk, 'node_modules/typescript'));
const options = ts.readConfigFile(path.join(sdk, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions;
const sourceSHA256 = {}, cache = new Map();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function source(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const file = path.join(root, 'entry/src/main/ets', relative);
  const text = fs.readFileSync(file, 'utf8');
  sourceSHA256[relative] = hash(text);
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, options);
  assert.equal(parsed.parseDiagnostics.length, 0, relative + ': ArkTS parse diagnostics');
  const value = { text, parsed }; cache.set(relative, value); return value;
}
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function components(relative, name) {
  const { parsed } = source(relative), result = [];
  walk(parsed, node => {
    if ((ts.isEtsComponentExpression(node) || ts.isCallExpression(node)) &&
      node.expression.getText(parsed) === name) result.push(node);
  });
  return result;
}
function properties(component, relative) {
  const { parsed } = source(relative), argument = component.arguments[0];
  assert(ts.isObjectLiteralExpression(argument));
  return new Map(argument.properties.map(p => [p.name.getText(parsed), p.initializer.getText(parsed)]));
}
function attributes(component) {
  const values = new Map(); let node = component;
  while (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node &&
    node.parent.parent && ts.isCallExpression(node.parent.parent)) {
    const access = node.parent, call = access.parent;
    values.set(access.name.text, call.arguments); node = call;
  }
  return values;
}
function parentComponent(node, name, parsed) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isEtsComponentExpression(parent) && (!name || parent.expression.getText(parsed) === name)) return parent;
  }
  return undefined;
}
function owningMethod(node, parsed) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isMethodDeclaration(parent)) return parent.name.getText(parsed);
  }
  return undefined;
}
function componentWithId(file, name, id) {
  const found = components(file, name).filter(node => attributes(node).get('id')?.[0]?.text === id);
  assert.equal(found.length, 1, file + ': missing or duplicate ' + id); return found[0];
}
function bottomExpression(component, attribute, parsed) {
  const value = attributes(component).get(attribute)?.[0]; assert(value && ts.isObjectLiteralExpression(value));
  const bottom = value.properties.find(property => property.name?.getText(parsed) === 'bottom'); assert(bottom);
  return bottom.initializer.getText(parsed);
}
const cases = [];
function check(name, body) {
  try { body(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, detail: error.message }); }
}
check('Nodes blocks the dock across preparation, batch execution and an individual pending test', () => {
  const file = 'pages/Nodes.ets', found = components(file, 'AppTabBar'); assert.equal(found.length, 1);
  const props = properties(found[0], file);
  assert.equal(props.get('current'), "'nodes'");
  assert.equal(props.get('requestInProgress'), 'this.preparing || this.batchActive || this.testingId.length > 0');
});
check('Home forwards its authorization latch and owns the dock callback', () => {
  const file = 'pages/Home.ets', found = components(file, 'AppTabBar'); assert.equal(found.length, 1);
  const props = properties(found[0], file);
  assert.equal(props.get('current'), "'home'"); assert.equal(props.get('requestInProgress'), 'this.requesting');
  assert.equal(props.get('onConnectionAction'), '() => { void this.handleDockConnectionAction(); }');
});
check('AppTabBar forwards the parent latch and callback without replacing either', () => {
  const file = 'components/AppTabBar.ets', found = components(file, 'DockPowerButton'); assert.equal(found.length, 1);
  const props = properties(found[0], file);
  assert.equal(props.get('current'), 'this.current');
  assert.equal(props.get('requestInProgress'), 'this.requestInProgress');
  assert.equal(props.get('onConnectionAction'), 'this.onConnectionAction');
});
check('Settings remains navigation-only and routes power execution through the shared dock', () => {
  const file = 'pages/Settings.ets', found = components(file, 'AppTabBar'); assert.equal(found.length, 1);
  assert.deepEqual([...properties(found[0], file)], [['current', "'settings'"]]);
  assert(!/writeConnectionCommand|startVpnExtensionAbility|queueDockConnectionAction/.test(source(file).text));
});
check('Pages retain themed backgrounds without enabling global fullscreen or expanding their roots', () => {
  const pages = ['Home', 'Nodes', 'Settings', 'About', 'Diagnostics', 'NetworkSettings', 'NodeBackup', 'NodeConfig',
    'NodeEditor', 'Privacy', 'Subscriptions'];
  for (const name of pages) {
    const text = source('pages/' + name + '.ets').text;
    assert(text.includes(".background($r('app.color.page_bg'))"), name);
    assert(!/setWindowLayoutFullScreen\(/.test(text), name);
    const { parsed } = source('pages/' + name + '.ets');
    const structure = parsed.statements.find(node => node.kind === ts.SyntaxKind.StructDeclaration);
    const build = structure.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(parsed) === 'build');
    const roots = [];
    walk(build.body, node => {
      if (ts.isEtsComponentExpression(node) && !parentComponent(node, undefined, parsed)) roots.push(node);
    });
    assert.equal(roots.length, 1, name + ': page root');
    assert(!attributes(roots[0]).has('expandSafeArea'), name + ': safe-area expansion belongs to scrolling viewport only');
  }
});
check('NetworkSettings paints its contrasting action footer through the bottom safe area only', () => {
  const text = source('pages/NetworkSettings.ets').text;
  assert(text.includes(".background($r('app.color.surface'), { ignoresLayoutSafeAreaEdges: [LayoutSafeAreaEdge.BOTTOM] })"));
});
for (const [page, scrollId, contentId, minimumGap, edges] of [
  ['Home', 'homeScroll', 'homeContent', 24, '[SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]'],
  ['Nodes', 'nodesScroll', 'nodeListContent', 20, '[SafeAreaEdge.BOTTOM]'],
  ['Settings', 'settingsScroll', undefined, 28, '[SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]']
]) {
  check(page + ' binds content and dock builders to the shared overlapping shell with measured tail space', () => {
    const file = 'pages/' + page + '.ets', { parsed } = source(file);
    const docks = components(file, 'AppTabBar'); assert.equal(docks.length, 1);
    const dock = docks[0]; assert.equal(owningMethod(dock, parsed), 'navigationDock');
    const shells = components(file, 'GlassDockLayout'); assert.equal(shells.length, 1);
    const shell = shells[0], shellProps = properties(shell, file);
    assert.equal(owningMethod(shell, parsed), 'build');
    assert.equal(shellProps.get('content'), '() => { this.pageContent(); }');
    assert.equal(shellProps.get('dock'), '() => { this.navigationDock(); }');
    assert.equal(shellProps.get('dockHeight'), 'this.dockHeight');
    assert.equal(shellProps.get('showDock'), page === 'Home' ?
      '!this.developerTools && !useSideNavigation(this.windowWidthVp)' : '!useSideNavigation(this.windowWidthVp)');
    const scroll = componentWithId(file, 'Scroll', scrollId);
    assert.equal(owningMethod(scroll, parsed), 'pageContent');
    assert.equal(attributes(scroll).get('height')?.[0]?.text, '100%');
    assert.deepEqual(attributes(scroll).get('expandSafeArea')?.map(arg => arg.getText(parsed)),
      ['[SafeAreaType.SYSTEM]', edges]);
    assert(!attributes(dock).has('expandSafeArea'), 'dock controls must stay inside system safe areas');
    const measure = attributes(dock).get('onAreaChange')?.[0]; assert(measure && ts.isArrowFunction(measure));
    assert.match(measure.body.getText(parsed).replace(/\s+/g, ''), /this\.dockHeight=Number\(area\.height\);/);
    const structure = parsed.statements.find(node => node.kind === ts.SyntaxKind.StructDeclaration);
    const state = structure.members.find(member => ts.isPropertyDeclaration(member) && member.name.getText(parsed) === 'dockHeight');
    assert(state && state.modifiers?.some(modifier => ts.isDecorator(modifier) && modifier.expression.getText(parsed) === 'State'));
    const content = contentId ? componentWithId(file, 'Column', contentId) :
      components(file, 'Column').find(node => parentComponent(node, undefined, parsed) === scroll);
    assert(content, 'scroll content container is required');
    const expression = bottomExpression(content, 'padding', parsed);
    // Evaluate the authored geometry only; this is not an ArkUI rendering test.
    const evaluate = new Function('useSideNavigation', 'return (' + expression + ');');
    for (const dockHeight of [84, 120, 180, 240]) {
      const narrow = evaluate.call({ dockHeight, windowWidthVp: 360, developerTools: false }, () => false);
      assert(narrow >= dockHeight + minimumGap, 'last content must scroll above measured dock');
      const wide = evaluate.call({ dockHeight, windowWidthVp: 1200, developerTools: false }, () => true);
      assert.equal(wide, minimumGap, 'side navigation must not retain phantom dock spacing');
      if (page === 'Home') {
        assert.equal(evaluate.call({ dockHeight, windowWidthVp: 360, developerTools: true }, () => false), minimumGap);
      }
    }
  });
}
check('The shared shell uses an actual overlapping TabBar with no full-width color or blur strip', () => {
  const shellFile = 'components/GlassDockLayout.ets', shellSource = source(shellFile).parsed;
  const tabs = componentWithId(shellFile, 'Tabs', 'glassDockLayout');
  assert.equal(properties(tabs, shellFile).get('barPosition'), 'BarPosition.End');
  assert.equal(properties(tabs, shellFile).get('barModifier'), 'this.tabBarModifier');
  const tabAttrs = attributes(tabs);
  for (const [key, value] of Object.entries({ width: "'100%'", height: "'100%'", vertical: 'false', scrollable: 'false',
    barMode: 'BarMode.Fixed', barWidth: "'100%'", barHeight: 'this.dockHeight', barOverlap: 'true',
    barBackgroundColor: 'Color.Transparent', barBackgroundBlurStyle: 'BlurStyle.NONE', divider: 'null', animationDuration: '0', clip: 'false' })) {
    assert.equal(tabAttrs.get(key)?.[0]?.getText(shellSource), value, key);
  }
  const contents = components(shellFile, 'TabContent'); assert.equal(contents.length, 1, 'shell cannot own another page-routing mechanism');
  assert.equal(parentComponent(contents[0], 'Tabs', shellSource), tabs);
  assert.equal(attributes(contents[0]).get('clip')?.[0]?.getText(shellSource), 'false',
    'default TabContent clipping must not hide scroll expansion into system safe areas');
  assert.equal(attributes(contents[0]).get('tabBar')?.[0]?.getText(shellSource), 'this.dock');
  assert.equal(contents[0].body.statements.length, 1);
  assert.equal(contents[0].body.statements[0].getText(shellSource), 'this.content();');
  const shellStructure = shellSource.statements.find(node => node.kind === ts.SyntaxKind.StructDeclaration);
  const shellBuild = shellStructure.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(shellSource) === 'build');
  const modifier = shellStructure.members.find(member => ts.isPropertyDeclaration(member) && member.name.getText(shellSource) === 'tabBarModifier');
  assert.equal(modifier?.initializer?.getText(shellSource), 'new CommonModifier()');
  const appear = shellStructure.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(shellSource) === 'aboutToAppear');
  assert(appear?.body.statements.some(statement => statement.getText(shellSource) === 'this.tabBarModifier.clip(false);'),
    'the actual system TabBar must receive an unclipped CommonModifier for capsule shadows');
  const stacks = components(shellFile, 'Stack'); assert.equal(stacks.length, 1);
  const stack = stacks[0]; assert.equal(owningMethod(stack, shellSource), 'build');
  assert.equal(properties(stack, shellFile).get('alignContent'), 'Alignment.Top');
  assert.equal(attributes(stack).get('clip')?.[0]?.getText(shellSource), 'false');
  assert.equal(parentComponent(tabs, 'Stack', shellSource), stack);
  const scrims = components(shellFile, 'StatusBarScrim'); assert.equal(scrims.length, 1);
  assert.equal(parentComponent(scrims[0], undefined, shellSource), stack);
  assert(scrims[0].pos > tabs.end, 'the status scrim must draw over scrolled text, after the Tabs content');
  const condition = stack.body.statements.find(ts.isIfStatement); assert(condition);
  assert.equal(condition.expression.getText(shellSource), 'this.showDock');
  assert.equal(condition.elseStatement.statements.length, 1);
  assert.equal(condition.elseStatement.statements[0].getText(shellSource), 'this.content();');
  const file = 'components/AppTabBar.ets', { parsed } = source(file);
  const wrapper = componentWithId(file, 'Row', 'floatingNavigationDock'), attrs = attributes(wrapper);
  for (const name of ['background', 'backgroundColor']) {
    const args = attrs.get(name);
    if (args) assert.equal(args[0].getText(parsed), 'Color.Transparent', 'wrapper background must be transparent');
  }
  assert(!attrs.has('backgroundImage') && !attrs.has('expandSafeArea'));
  assert.equal(attrs.get('hitTestBehavior')?.[0]?.getText(parsed), 'HitTestMode.Transparent');
});
check('Nodes keeps the cancellation row above the measured overlay without moving it out of reach', () => {
  const file = 'pages/Nodes.ets', { parsed } = source(file);
  const button = componentWithId(file, 'Button', 'cancelNodeLatency');
  const row = parentComponent(button, 'Row', parsed); assert(row);
  const evaluate = new Function('useSideNavigation', 'return (' + bottomExpression(row, 'margin', parsed) + ');');
  for (const dockHeight of [84, 120, 180, 240]) {
    assert.equal(evaluate.call({ dockHeight, windowWidthVp: 360 }, () => false), dockHeight);
    assert.equal(evaluate.call({ dockHeight, windowWidthVp: 1200 }, () => true), 0);
  }
});
const report = {
  generatedAt: new Date().toISOString(), total: cases.length,
  passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length,
  classification: 'static ArkUI AST/source checks only', sourceSHA256,
  testFileSha256: hash(fs.readFileSync(__filename)),
  scope: 'Parent guards/callbacks, shared overlapping TabBar shell AST, measured tail-space expressions, transparent wrapper and scroll-only safe-area bindings; no native rendering or VPN proof.', cases
};
const output = path.join(root, 'build/dock-ui-bindings-verification.json');
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, staticChecks: report.total,
  failures: cases.filter(item => !item.passed), record: output }));
if (report.failed) process.exitCode = 1;
