'use strict';
// Read only regular JSON/JPEG inputs in this fixed QA directory. Write only
// report.html; screenshots are referenced verbatim and never decoded or edited.
const fs = require('node:fs');
const path = require('node:path');

const phase = process.argv[2] || 'phase12';
if (!['phase12', 'phase13', 'phase14'].includes(phase) || process.argv.length > 3) throw Error('Unknown report phase');
const version = { phase12: '0.12.0', phase13: '0.13.0', phase14: '0.14.0' }[phase];
const directory = path.resolve(__dirname, '../build/' + phase + '-emulators');
const output = path.join(directory, 'report.html');
const categories = [
  { key: 'phone', label: '手机', short: 'Phone' },
  { key: 'tablet', label: '平板', short: 'Tablet' },
  { key: 'pc', label: '电脑', short: 'PC' },
  { key: 'fold', label: '折叠屏', short: 'Fold' }
];
const excludedName = /(?:^|[-_\s])(initial|debug|start|seed-debug|boot|lock(?:ed|screen)?|unlock(?:ed)?|launcher|desktop|failure|failed|interrupted)(?:$|[-_\s])/i;
const systemName = /(?:^|[-_\s])system(?:$|[-_\s])/i;
const excludedMode = /^(?:initial|debug|start|system|boot|lock|unlock|launcher|desktop)/i;
const pages = { Home: '连接首页', Nodes: '节点列表', Settings: '设置', Network: '分流与 DNS',
  NetworkSettings: '分流与 DNS', Import: '导入节点', Editor: '编辑节点', Subscriptions: '订阅管理',
  Backup: '导出与恢复', Diagnostics: '连接诊断', About: '关于', Privacy: '隐私说明',
  ThemeDark: '设置 · 深色外观', ThemeSystem: '设置 · 跟随系统', SeedCatalog: '节点示例', Inspect: '界面检查',
  Install: '安装后首页', HomeNetwork: '首页直达网络设置', NodeHelp: '节点检测说明' };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const boundedText = (value, maximum = 160) => typeof value === 'string' ? value.slice(0, maximum) : '';
const validBounds = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1];
const number = value => Number.isInteger(value) ? String(value) : value.toFixed(1);
const flag = value => value === true ? '有' : value === false ? '无' : '未记录';
const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile());
const files = new Map(entries.map(entry => [entry.name.toLowerCase(), entry.name]));
let finalPreviewHash;
if (phase !== 'phase12' && files.has('final-verification.json')) {
  const verification = JSON.parse(fs.readFileSync(path.join(directory, files.get('final-verification.json')), 'utf8'));
  if (/^[0-9a-f]{64}$/.test(verification.preview?.sha256 || '')) finalPreviewHash = verification.preview.sha256;
}
if (phase === 'phase14' && !finalPreviewHash) throw Error('Phase14 requires a verified final preview hash');
const rejected = { excluded: 0, notQa: 0, incomplete: 0, earlierCandidate: 0 };
const records = [];

for (const entry of entries.filter(item => item.name.toLowerCase().endsWith('.json'))) {
  const base = entry.name.slice(0, -5);
  if (excludedName.test(base)) { rejected.excluded++; continue; }
  const jsonPath = path.join(directory, entry.name);
  // Large AX trees are not report inputs. This also bounds malformed input reads.
  if (fs.statSync(jsonPath).size > 1024 * 1024) { rejected.notQa++; continue; }
  let data;
  try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { rejected.incomplete++; continue; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.target !== 'string' || !data.target ||
    typeof data.label !== 'string' || !data.label || !validBounds(data.appBounds) || !Array.isArray(data.horizontalOverflow)) {
    rejected.notQa++; continue;
  }
  if (finalPreviewHash && data.artifactSHA256 !== finalPreviewHash) { rejected.earlierCandidate++; continue; }
  const systemTheme = data.mode === 'ThemeSystem';
  if (excludedName.test(data.label) || excludedMode.test(boundedText(data.mode)) || /启动|锁屏|解锁/.test(data.label) ||
    ((systemName.test(base) || systemName.test(data.label)) && !systemTheme)) {
    rejected.excluded++; continue;
  }
  const category = categories.find(item => new RegExp('^' + item.key + '(?:[-_]|$)', 'i').test(data.label));
  if (!category) { rejected.notQa++; continue; }
  const imageName = files.get((base + '.jpeg').toLowerCase());
  if (!imageName || fs.statSync(path.join(directory, imageName)).size === 0) { rejected.incomplete++; continue; }
  const bounds = data.appBounds.slice();
  records.push({ category: category.key, categoryLabel: category.label, label: boundedText(data.label),
    mode: boundedText(data.mode, 64), target: boundedText(data.target, 100), bounds,
    width: bounds[2] - bounds[0], height: bounds[3] - bounds[1],
    sideNavigation: data.sideNavigation, twoColumns: data.twoColumns,
    overflowCount: data.horizontalOverflow.length,
    overflow: data.horizontalOverflow.slice(0, 30).map((item, index) => ({
      id: boundedText(typeof item === 'string' ? item : item?.id, 120) || `检查项 ${index + 1}`,
      bounds: validBounds(item?.bounds) ? item.bounds.slice() : undefined
    })), imageName });
}
records.sort((a, b) => categories.findIndex(item => item.key === a.category) - categories.findIndex(item => item.key === b.category) ||
  a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
const counts = Object.fromEntries(categories.map(item => [item.key, records.filter(record => record.category === item.key).length]));
const overflowRecords = records.filter(record => record.overflowCount > 0).length;
const generatedAt = new Date().toISOString();
const verificationLink = files.has('final-verification.json') ? '<a href="final-verification.json" target="_blank" rel="noopener">最终包与截图对应记录</a>' : '阶段十二文档';
const candidateNote = phase === 'phase14' ? '本轮修复草稿保护、桌面键盘操作与大字号按钮换行。此页仅展示最终预览包的截图，包哈希见' + verificationLink + '；长时间导航与排序对照的候选版本分别记录在阶段十四文档中。<a href="../phase13-emulators/report.html">查看上一轮界面</a>。' : phase === 'phase12' ? '同一版本包含多个候选：fold-home-default 是 680 vp 修复前对照，fold-home-final 是修复后记录。早期截图不能统一归入最终 HAP 哈希，详见' + verificationLink + '。' :
  '本轮聚焦首页、节点管理、编辑保护和设置分组。此页仅展示最终预览包的截图，原始 JSON 记录对应包哈希；<a href="../phase12-emulators/report.html">查看上一轮界面</a>。API 24 平板的安装和联网验证已按用户要求暂停。';

function card(record, index) {
  const imageUrl = encodeURIComponent(record.imageName);
  const title = pages[record.mode] || record.mode || '界面检查';
  const bounds = `[${number(record.bounds[0])}, ${number(record.bounds[1])}] → [${number(record.bounds[2])}, ${number(record.bounds[3])}]`;
  const warning = record.overflowCount > 0;
  const detail = warning ? `<details class="overflow-detail"><summary>查看 ${record.overflowCount} 个记录项</summary><ul>${record.overflow.map(item =>
    `<li>${escapeHtml(item.id)}${item.bounds ? ' · [' + item.bounds.map(number).join(', ') + ']' : ''}</li>`).join('')}</ul>${record.overflowCount > 30 ? '<p>仅显示前 30 个记录项。</p>' : ''}</details>` : '';
  return `<article class="card" data-category="${record.category}" data-overflow="${warning ? 'yes' : 'no'}" data-search="${escapeHtml(record.label + ' ' + title + ' ' + record.mode)}">
    <a class="shot" href="${imageUrl}" target="_blank" rel="noopener" data-lightbox data-title="${escapeHtml(record.label)}" aria-label="查看原图：${escapeHtml(record.label)}">
      <img src="${imageUrl}" alt="${escapeHtml(record.categoryLabel + ' · ' + record.label)}" loading="lazy" decoding="async">
      <span class="zoom-hint">点击查看原图</span>
    </a>
    <div class="card-body"><div class="card-heading"><div><span class="eyebrow">${escapeHtml(record.categoryLabel)} · ${String(index + 1).padStart(2, '0')}</span><h2>${escapeHtml(title)}</h2></div>
      <span class="badge ${warning ? 'warning' : 'clear'}">${warning ? record.overflowCount + ' 项横向溢出' : '未记录横向溢出'}</span></div>
      <p class="filename">${escapeHtml(record.label)}</p>
      <dl class="metrics"><div><dt>应用区域</dt><dd>${number(record.width)} × ${number(record.height)} <small>px</small></dd></div>
      <div><dt>侧栏 / 双栏</dt><dd>${flag(record.sideNavigation)} / ${flag(record.twoColumns)}</dd></div></dl>
      <p class="bounds">bounds ${bounds}</p><p class="target">目标 ${escapeHtml(record.target)}</p>${detail}
      <a class="original-link" href="${imageUrl}" target="_blank" rel="noopener">在新标签页打开原图 ↗</a>
    </div></article>`;
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Harmony VPN ${version} · 多端界面验收</title>
<style>
:root{color-scheme:light;--bg:#f2f5fa;--surface:#fff;--ink:#17243b;--muted:#607089;--line:#dfe6f1;--accent:#245bc6;--accent-soft:#eaf0ff;--warning:#935513;--warning-bg:#fff3df;--clear:#17734c;--clear-bg:#e8f5ed;--shadow:0 12px 38px #2234520b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.55}button,input,select{font:inherit}a{color:var(--accent)}button,a,input,select{touch-action:manipulation}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #769eea;outline-offset:3px}
.wrap{max-width:1480px;margin:auto;padding:36px 28px 56px}.masthead{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:24px}.kicker{font-size:12px;letter-spacing:.16em;font-weight:750;color:var(--accent)}h1{font-size:clamp(28px,3vw,42px);line-height:1.2;margin:10px 0 12px;letter-spacing:-.035em}.intro{color:var(--muted);margin:0;max-width:740px}.version{font-size:13px;white-space:nowrap;padding:8px 13px;border:1px solid var(--line);border-radius:99px;background:var(--surface)}
.notice{background:var(--warning-bg);border:1px solid #e7cfac;border-left:5px solid #bd7b2b;border-radius:14px;padding:18px 20px;margin-bottom:24px}.notice strong{display:block;color:var(--warning);font-size:17px;margin-bottom:5px}.notice p{margin:5px 0;color:var(--ink)}.notice .subtle{font-size:13px;color:var(--muted)}
.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:22px}.summary-item{border:1px solid var(--line);border-radius:16px;background:var(--surface);padding:18px 20px;box-shadow:var(--shadow)}.summary-item span{display:block;color:var(--muted);font-size:13px}.summary-item b{font-size:29px;letter-spacing:-.04em;font-weight:680}.summary-item small{margin-left:8px;color:var(--muted)}
.toolbar{position:sticky;top:0;z-index:5;margin-bottom:20px;padding:16px 0;background:var(--bg);border-bottom:1px solid var(--line)}.toolbar-top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:14px;align-items:center}.tabs{display:flex;flex-wrap:wrap;gap:8px}.tab{border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:9px 14px;color:var(--muted);cursor:pointer}.tab[aria-pressed=true]{color:#fff;background:var(--accent);border-color:var(--accent)}.tab span{opacity:.75;margin-left:7px;font-size:12px}.filters{display:flex;flex-wrap:wrap;gap:10px}input,select{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:9px 12px}input{width:min(240px,100%)}.result-count{font-size:13px;color:var(--muted);margin:12px 0 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:22px;align-items:start}.card{overflow:hidden;background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.card[hidden]{display:none}.shot{position:relative;display:flex;width:100%;height:340px;align-items:center;justify-content:center;background:#e7ecf4;border-bottom:1px solid var(--line);padding:14px;overflow:hidden}.shot img{width:100%;height:100%;object-fit:contain;transition:transform .18s ease}.shot:hover img{transform:scale(1.02)}.zoom-hint{position:absolute;right:12px;bottom:12px;background:#17243bc9;color:#fff;border-radius:8px;padding:5px 9px;font-size:12px;pointer-events:none}.card-body{padding:18px}.card-heading{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}.eyebrow{font-size:11px;letter-spacing:.05em;color:var(--muted)}h2{font-size:19px;margin:3px 0 0;line-height:1.35}.badge{font-size:11px;border-radius:7px;white-space:nowrap;padding:5px 7px;margin-top:3px}.clear{color:var(--clear);background:var(--clear-bg)}.warning{color:var(--warning);background:var(--warning-bg)}.filename{font-size:13px;word-break:break-all;color:var(--muted);margin:10px 0 16px}.metrics{display:grid;grid-template-columns:1.35fr 1fr;gap:12px;margin:0 0 12px}.metrics dt{font-size:11px;color:var(--muted);margin-bottom:4px}.metrics dd{font-size:15px;margin:0;font-weight:600}.metrics small{font-size:10px;font-weight:400;color:var(--muted)}.bounds,.target{font-size:11px;color:var(--muted);margin:3px 0;overflow-wrap:anywhere}.original-link{display:inline-block;font-size:13px;margin-top:14px;text-decoration:none}.original-link:hover{text-decoration:underline}.overflow-detail{margin-top:12px;color:var(--warning);font-size:12px;overflow-wrap:anywhere}.overflow-detail summary{cursor:pointer}.overflow-detail ul{padding-left:18px}.empty{padding:60px 24px;text-align:center;border:1px dashed var(--line);border-radius:18px;background:var(--surface);color:var(--muted)}.empty[hidden]{display:none}footer{border-top:1px solid var(--line);margin-top:34px;padding-top:20px;font-size:12px;color:var(--muted)}footer p{margin:6px 0}code{font-family:ui-monospace,Consolas,monospace;font-size:.95em}
dialog{padding:0;border:1px solid #516075;border-radius:14px;background:#101824;color:#f1f5fc;max-width:96vw;width:1400px;height:94vh;max-height:94vh}dialog::backdrop{background:#000c}.lightbox-head{height:62px;display:flex;align-items:center;gap:16px;justify-content:space-between;padding:12px 18px;border-bottom:1px solid #354156}.lightbox-head strong{font-size:14px;overflow-wrap:anywhere}.lightbox-head a{color:#adc8ff;font-size:13px;white-space:nowrap}.close{background:#2a3546;border:1px solid #4a5970;color:#fff;cursor:pointer;border-radius:8px;padding:6px 12px}.lightbox-image{display:block;width:100%;height:calc(100% - 62px);object-fit:contain;padding:10px}
@media(max-width:700px){.wrap{padding:24px 16px 40px}.masthead{gap:12px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-item{padding:14px 16px}.filters{width:100%}.filters input{flex:1;min-width:120px}.grid{grid-template-columns:1fr}.shot{height:370px}.version{font-size:11px}.tab{padding:8px 10px}.lightbox-head{padding:10px;gap:8px}.lightbox-head a{display:none}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111925;--surface:#1b2636;--ink:#e5ecf7;--muted:#a0afc4;--line:#344256;--accent:#8eb4ff;--accent-soft:#283c60;--warning:#e7bb7d;--warning-bg:#342a1f;--clear:#90d5b0;--clear-bg:#1e392d;--shadow:none}.tab[aria-pressed=true]{color:#12213a}.shot{background:#121c2b}.notice{border-color:#675133;border-left-color:#bb8b47}}
@media(prefers-reduced-motion:reduce){.shot img{transition:none}.shot:hover img{transform:none}}
</style></head><body><main class="wrap">
<header class="masthead"><div><div class="kicker">HARMONY VPN · ADAPTIVE UI REVIEW</div><h1>${phase === 'phase13' ? '外观与操作体验预览' : '多端界面验收画廊'}</h1><p class="intro">手机、平板、电脑与折叠屏的界面记录。筛选设备，查看应用区域和布局状态，点击截图核对完整原图。</p></div><span class="version">主窗口版本 ${version}</span></header>
<section class="notice" aria-label="验收范围"><strong>x86_64 界面预览不包含 VPN 核心，不能作为联网通过的证据。</strong><p>${candidateNote}</p><p class="subtle">bounds 与宽高单位为截图 / AX 坐标中的 px，不是 vp。横向溢出为空仅表示本次记录的控件未被检查器标记，不代表所有内容、字体裁切或滚动场景均通过。折叠/旋转连续切换尚未验收通过。</p><p class="subtle">模拟器使用合成节点，不含真实凭据；页面可显示不等于输入、扫码、文件选择器或 VPN 全流程通过。具体操作以对应阶段记录为准。</p></section>
<section class="summary" aria-label="设备截图数量">${categories.map(item => `<div class="summary-item"><span>${item.label} / ${item.short}</span><b>${counts[item.key]}</b><small>${counts[item.key] ? '张已记录' : '待纳入记录'}</small></div>`).join('')}</section>
<section class="toolbar" aria-label="画廊筛选"><div class="toolbar-top"><div class="tabs" role="group" aria-label="选择设备类型"><button class="tab" data-filter="all" aria-pressed="true">全部<span>${records.length}</span></button>${categories.map(item => `<button class="tab" data-filter="${item.key}" aria-pressed="false">${item.label}<span>${counts[item.key]}</span></button>`).join('')}</div><div class="filters"><input id="search" type="search" aria-label="搜索页面或记录名" placeholder="搜索页面或记录名"><select id="overflow" aria-label="横向溢出筛选"><option value="all">所有检查结果</option><option value="yes">有横向溢出记录</option><option value="no">未记录横向溢出</option></select></div></div><p class="result-count" id="resultCount" aria-live="polite">共 ${records.length} 张截图，其中 ${overflowRecords} 张含横向溢出记录。</p></section>
<section class="grid" id="gallery" aria-label="截图画廊">${records.map(card).join('\n')}</section><p class="empty" id="emptyState" ${records.length ? 'hidden' : ''}>当前筛选没有截图。后续 QA 记录生成后，重跑脚本即可更新此画廊。</p>
<footer><p>生成时间：<time datetime="${generatedAt}">${generatedAt}</time>。图片以相对链接直接引用同目录 JPEG，未修改像素，没有外部脚本、字体或 CDN。</p><p>只纳入包含 target、label、有效 appBounds 与 horizontalOverflow 的 JSON，并要求同名 JPEG 存在。启动、锁屏、initial / debug / start 等素材与原始 AX 树均不纳入。</p><p>更新方式：在项目目录运行 <code>node scripts/make-adaptive-report.cjs ${phase}</code>。脚本只读取 <code>build/${phase}-emulators/</code>，仅写入该目录的 <code>report.html</code>。</p></footer>
</main><dialog id="lightbox" aria-labelledby="lightboxTitle"><div class="lightbox-head"><strong id="lightboxTitle">截图原图</strong><a id="lightboxOriginal" href="#" target="_blank" rel="noopener">在新标签页查看原图 ↗</a><button class="close" id="closeLightbox" aria-label="关闭原图">关闭 ×</button></div><img class="lightbox-image" id="lightboxImage" alt=""></dialog>
<script>
(() => {
  const cards = Array.from(document.querySelectorAll('.card'));
  const tabs = Array.from(document.querySelectorAll('[data-filter]'));
  const search = document.getElementById('search'), overflow = document.getElementById('overflow');
  let category = 'all';
  function filter() {
    const query = search.value.trim().toLocaleLowerCase(); let visible = 0, flagged = 0;
    cards.forEach(card => {
      const show = (category === 'all' || card.dataset.category === category) &&
        (overflow.value === 'all' || card.dataset.overflow === overflow.value) && card.dataset.search.toLocaleLowerCase().includes(query);
      card.hidden = !show; if (show) { visible++; if (card.dataset.overflow === 'yes') flagged++; }
    });
    document.getElementById('resultCount').textContent = '显示 ' + visible + ' / ' + cards.length + ' 张截图；当前筛选中 ' + flagged + ' 张含横向溢出记录。';
    document.getElementById('emptyState').hidden = visible > 0;
  }
  tabs.forEach(tab => tab.addEventListener('click', () => { category = tab.dataset.filter; tabs.forEach(item => item.setAttribute('aria-pressed', String(item === tab))); filter(); }));
  search.addEventListener('input', filter); overflow.addEventListener('change', filter);
  const dialog = document.getElementById('lightbox'), large = document.getElementById('lightboxImage');
  document.querySelectorAll('[data-lightbox]').forEach(link => link.addEventListener('click', event => {
    if (typeof dialog.showModal !== 'function' || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault(); large.src = link.getAttribute('href'); large.alt = link.dataset.title;
    document.getElementById('lightboxTitle').textContent = link.dataset.title;
    document.getElementById('lightboxOriginal').href = link.getAttribute('href'); dialog.showModal();
  }));
  document.getElementById('closeLightbox').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { large.removeAttribute('src'); });
})();
</script></body></html>`;

// Every generated image link must resolve to a regular file from the input list.
for (const record of records) {
  if (!files.has(record.imageName.toLowerCase())) throw Error('A report image disappeared from the input snapshot.');
}
fs.writeFileSync(output, html, 'utf8');
console.log(JSON.stringify({ report: 'build/' + phase + '-emulators/report.html', screenshots: records.length,
  categories: counts, horizontalOverflowRecords: overflowRecords, skipped: rejected,
  scope: 'x86_64 UI preview only; no VPN core or network acceptance' }));
