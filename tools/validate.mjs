#!/usr/bin/env node
/**
 * validate.mjs —— 加载扩展前的自检。
 * 检查 manifest 结构、文件是否齐全、JS 语法是否能解析、模块导入路径是否存在。
 *
 * 用法：node tools/validate.mjs
 */

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const checks = [];

const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function ok(msg) {
  checks.push(`  \u2713 ${msg}`);
}
function bad(msg) {
  problems.push(msg);
  checks.push(`  \u2717 ${msg}`);
}

// ---------- 1. manifest ----------
const manifestPath = path.join(root, 'manifest.json');
if (!(await exists(manifestPath))) {
  bad('缺少 manifest.json');
} else {
  let m;
  try {
    m = JSON.parse(await readFile(manifestPath, 'utf8'));
    ok('manifest.json 是合法 JSON');
  } catch (err) {
    bad(`manifest.json 解析失败：${err.message}`);
  }

  if (m) {
    if (m.manifest_version !== 3) bad(`manifest_version 应为 3，实际 ${m.manifest_version}`);
    else ok('manifest_version = 3');

    for (const key of ['name', 'version', 'description']) {
      if (!m[key]) bad(`manifest 缺少 ${key}`);
    }
    if (m.name && m.version) ok(`扩展 ${m.name} v${m.version}`);

    // 引用的文件必须存在
    const referenced = [
      m.background?.service_worker,
      m.side_panel?.default_path,
      ...(m.content_scripts || []).flatMap((cs) => cs.js || []),
      ...Object.values(m.icons || {}),
      ...Object.values(m.action?.default_icon || {}),
    ].filter(Boolean);

    for (const file of referenced) {
      const p = path.join(root, file);
      if (await exists(p)) ok(`引用文件存在：${file}`);
      else bad(`manifest 引用了不存在的文件：${file}`);
    }

    if (!m.permissions?.includes('sidePanel')) {
      bad('建议声明 sidePanel 权限（否则侧边栏无法打开）');
    } else {
      ok('已声明 sidePanel 权限');
    }
    if (!m.host_permissions?.length) bad('缺少 host_permissions，无法操作网页');
    else ok(`host_permissions: ${m.host_permissions.join(', ')}`);
  }
}

// ---------- 2. 面板 HTML 的内联脚本（MV3 CSP 禁止） ----------
const htmlPath = path.join(root, 'src/panel/panel.html');
if (await exists(htmlPath)) {
  const html = await readFile(htmlPath, 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    bad('panel.html 含内联 <script>，MV3 的 CSP 会拦截');
  } else {
    ok('panel.html 没有内联脚本');
  }
  if (/\son\w+\s*=\s*["']/i.test(html)) {
    bad('panel.html 含内联事件属性（onclick 等），MV3 的 CSP 会拦截');
  } else {
    ok('panel.html 没有内联事件属性');
  }

  // HTML 里引用的本地资源是否存在
  for (const match of html.matchAll(/(?:src|href)="(?!https?:|#)([^"]+)"/g)) {
    const p = path.join(path.dirname(htmlPath), match[1]);
    if (await exists(p)) ok(`panel.html 资源存在：${match[1]}`);
    else bad(`panel.html 引用了不存在的资源：${match[1]}`);
  }
}

// ---------- 3. 模块导入路径 ----------
async function checkImports(file) {
  const full = path.join(root, file);
  if (!(await exists(full))) {
    bad(`模块文件不存在：${file}`);
    return;
  }
  const src = await readFile(full, 'utf8');

  // 语法检查：用动态 import 交给 V8 解析（模块）
  try {
    await import(`${pathToFileUrl(full)}?t=${Date.now()}`);
    ok(`${file} 语法通过`);
  } catch (err) {
    if (err instanceof SyntaxError) {
      bad(`${file} 语法错误：${err.message}`);
    } else if (/chrome is not defined|Cannot read properties of undefined/i.test(err.message)) {
      ok(`${file} 语法通过（运行时依赖 chrome API，已跳过执行）`);
    } else {
      ok(`${file} 语法通过`);
    }
  }

  for (const match of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(full), match[1]);
    if (await exists(target)) ok(`${file} → ${match[1]} 存在`);
    else bad(`${file} 导入了不存在的模块：${match[1]}`);
  }
}

function pathToFileUrl(p) {
  return `file:///${p.replace(/\\/g, '/')}`;
}

for (const file of [
  'src/background.js',
  'src/panel/agent.js',
  'src/panel/panel.js',
  'src/shared/messages.js',
  'src/shared/memory.js',
  'src/shared/usage.js',
]) {
  await checkImports(file);
}

// content script 是非模块脚本，用 Function 构造器做语法检查（不执行）
const csPath = path.join(root, 'src/content/content.js');
for (const relPath of ['src/content/content.js', 'src/content/floating.js']) {
  const p = path.join(root, relPath);
  if (!(await exists(p))) {
    bad(`缺少 ${relPath}`);
    continue;
  }
  const src = await readFile(p, 'utf8');
  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
    ok(`${relPath} 语法通过`);
  } catch (err) {
    bad(`${relPath} 语法错误：${err.message}`);
  }
}

// ---------- 4. 跨文件一致性：工具名必须被 content 支持 ----------
try {
  const agentSrc = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');
  const bgSrc = await readFile(path.join(root, 'src/background.js'), 'utf8');
  const msgSrc = await readFile(path.join(root, 'src/shared/messages.js'), 'utf8');
  const panelSrc = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');
  const csSrc = await readFile(csPath, 'utf8');
  const floatPath = path.join(root, 'src/content/floating.js');
  const floatSrc = (await exists(floatPath)) ? await readFile(floatPath, 'utf8') : '';
  const csSrcAll = `${csSrc}\n${floatSrc}`;

  const declared = [...agentSrc.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  if (declared.length >= 8) ok(`已定义 ${declared.length} 个工具`);
  else bad(`工具数量偏少（${declared.length}），可能定义缺失`);

  for (const need of ['snapshot', 'read_page', 'click', 'type_text', 'finish']) {
    if (declared.includes(need)) ok(`工具存在：${need}`);
    else bad(`缺少必需工具：${need}`);
  }

  // 解析 MSG 常量表：只取 MSG 对象内部（KEY: 'value' 且值含斜杠）
  const msgBlock = msgSrc.match(/export const MSG = \{([\s\S]*?)\n\};/)?.[1] || '';
  const msgTable = [...msgBlock.matchAll(/([A-Z_]+):\s*'([^']+)'/g)].map((m) => ({
    key: m[1],
    value: m[2],
  }));
  ok(`消息常量 ${msgTable.length} 个`);

  for (const { key, value } of msgTable) {
    // background 通过 MSG.KEY 引用；content 侧（含悬浮窗）直接匹配字面量
    const usedInBg = new RegExp(`MSG\\.${key}\\b`).test(bgSrc);
    const usedInContent = new RegExp(`'${value}'`).test(csSrcAll);
    const usedInAgent = new RegExp(`MSG\\.${key}\\b`).test(agentSrc);
    const usedInPanel = new RegExp(`MSG\\.${key}\\b`).test(panelSrc);

    if (!usedInBg && !usedInContent && !usedInAgent && !usedInPanel) {
      bad(`消息常量 ${key} ('${value}') 从未被使用`);
    } else if (value.startsWith('cs/') && !usedInContent) {
      bad(`content script 没有处理消息 ${value}`);
    } else if (!value.startsWith('cs/') && !usedInBg) {
      bad(`background 没有处理消息 ${value}（缺少 MSG.${key} 分支）`);
    } else {
      const where = [
        usedInBg && 'background',
        usedInContent && 'content',
        usedInAgent && 'agent',
        usedInPanel && 'panel',
      ]
        .filter(Boolean)
        .join('/');
      ok(`消息 ${value} 已接通 (${where})`);
    }
  }

  // content 侧出现的 cs/* 字面量必须在常量表中有定义
  for (const src of [csSrc, floatSrc]) {
    for (const m of src.matchAll(/'(cs\/[a-z-]+)'/g)) {
      if (msgTable.some((t) => t.value === m[1])) continue;
      bad(`content 侧处理了未定义的消息 ${m[1]}`);
    }
  }

  // 悬浮窗与 background 之间的字面量消息必须是双端成对的
  const floatMessages = ['float/task', 'float/stop', 'float/undo', 'float/patch-stats'];
  for (const fm of floatMessages) {
    const inFloat = floatSrc.includes(`'${fm}'`);
    const inBg = bgSrc.includes(`'${fm}'`);
    if (inFloat && inBg) ok(`悬浮窗消息 ${fm} 两端成对`);
    else bad(`悬浮窗消息 ${fm} 不成对（悬浮窗:${inFloat} background:${inBg}）`);
  }
} catch (err) {
  bad(`一致性检查失败：${err.message}`);
}

// ---------- 输出 ----------
console.log(`\nAI Agent 扩展自检 — ${rel(root)}\n`);
console.log(checks.join('\n'));
console.log('');
if (problems.length) {
  console.log(`\u2717 发现 ${problems.length} 个问题：`);
  problems.forEach((p) => console.log(`   - ${p}`));
  process.exit(1);
} else {
  console.log('\u2713 全部通过，可以去 edge://extensions 加载这个文件夹了。');
  process.exit(0);
}
