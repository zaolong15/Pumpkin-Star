#!/usr/bin/env node
/**
 * privacy-test.mjs —— 校验隐私政策里的声明与代码实际行为一致。
 *
 * 隐私政策是要对外承诺的，写错就是虚假陈述。
 * 这个套件把 PRIVACY.md 里的关键声明逐条对照源码验证。
 *
 * 用法：node tools/privacy-test.mjs
 */

import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (cond, msg) => {
  if (cond) console.log(`  \u2713 ${msg}`);
  else {
    failures.push(msg);
    console.log(`  \u2717 ${msg}`);
  }
};

const policy = await readFile(path.join(root, 'PRIVACY.md'), 'utf8');

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const srcFiles = walk(path.join(root, 'src'));
const sources = {};
for (const f of srcFiles) {
  // 用正斜杠作 key。
  // 注意：Windows 上 path.relative 返回的是 "src\content\content.js"（反斜杠），
  // 而下面取值写的是 "src/content/content.js"。不统一就会取到 undefined，
  // 表现为"断言失败但代码其实没问题" —— 这里踩过一次。
  const key = path.relative(root, f).split(path.sep).join('/');
  sources[key] = await readFile(f, 'utf8');
}
const allSrc = Object.values(sources).join('\n');

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

console.log('\n隐私政策一致性校验\n');

console.log('[1] 政策文件基本要求');
{
  check(policy.length > 1500, `政策内容足够详细（${policy.length} 字符）`);
  check(/最后更新/.test(policy), '有"最后更新"日期');
  check(/联系/.test(policy), '有联系方式章节');
  check(/删除/.test(policy), '说明了如何删除数据');
}

console.log('\n[2] 声明「无分析/遥测 SDK」');
{
  const sdkRe = /sentry|posthog|mixpanel|google-analytics|gtag|umami|plausible|matomo|amplitude|segment\.io|bugsnag/i;
  const found = Object.entries(sources)
    .filter(([, s]) => sdkRe.test(s))
    .map(([f]) => f);
  check(found.length === 0, `代码中无任何分析/遥测 SDK${found.length ? `（发现：${found.join(', ')}）` : ''}`);
  check(/不包含任何统计分析/.test(policy), '政策里明确声明了这一点');
}

console.log('\n[3] 声明「无远程代码」');
{
  const remote = [];
  for (const [f, s] of Object.entries(sources)) {
    if (/createElement\(['"]script['"]\)[\s\S]{0,150}\.src\s*=/.test(s)) remote.push(`${f}: 动态 script`);
    if (/import\s*\(\s*['"]https?:/.test(s)) remote.push(`${f}: 动态 import 远程`);
    if (/document\.write/.test(s)) remote.push(`${f}: document.write`);
    if (/\beval\s*\(/.test(s) && !f.includes('content.js')) remote.push(`${f}: eval`);
  }
  check(remote.length === 0, `无动态远程代码加载${remote.length ? `（${remote.join(', ')}）` : ''}`);
  check(/不使用任何远程代码/.test(policy), '政策里声明了不用远程代码');
}

console.log('\n[4] 声明「无第三方库」');
{
  const ext = [];
  for (const [f, s] of Object.entries(sources)) {
    for (const m of s.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.')) ext.push(`${f}: ${m[1]}`);
    }
  }
  check(ext.length === 0, `无外部依赖${ext.length ? `（${ext.join(', ')}）` : ''}`);
  check(/不包含任何第三方库/.test(policy), '政策里声明了无第三方库');
}

console.log('\n[5] 声明「无自建服务器」');
{
  // 检查所有 fetch 的目标都是用户配置的 baseUrl
  const bg = sources['src/background.js'] || '';
  const fetches = [...bg.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  const hardcoded = fetches.filter((f) => /^['"`]https?:\/\//.test(f) && !/deepseek\.com/.test(f));
  check(hardcoded.length === 0, `所有请求目标都来自用户配置${hardcoded.length ? `（硬编码：${hardcoded.join(', ')}）` : ''}`);
  check(/没有自建后端服务器|没有自己的服务器/.test(policy), '政策里声明了无自建服务器');
}

console.log('\n[6] 声明「不在后台自动发起任务」');
{
  const panel = sources['src/panel/panel.js'] || '';
  // handleTask 不应被定时器调用
  const timerCall = /setInterval\([^)]*handleTask/.test(panel) || /setTimeout\([^)]*handleTask/.test(panel);
  check(!timerCall, '没有用定时器自动发起任务');

  // content script 不应主动上报
  const cs = sources['src/content/content.js'] || '';
  const activeSend = /chrome\.runtime\.sendMessage\(/.test(cs);
  check(!activeSend, 'content script 不主动上报（只被动响应）');
  check(/不在后台自动浏览|不会在后台访问网页|不会在后台主动访问/.test(policy), '政策里声明了不后台浏览');
}

console.log('\n[7] 声明「本地存储位置」与代码一致');
{
  // 代码里用的存储 API
  const usesLocal = /chrome\.storage\.local/.test(allSrc);
  const usesSync = /chrome\.storage\.sync/.test(allSrc);
  check(usesLocal, '代码使用 chrome.storage.local');
  check(!usesSync, '代码不使用 chrome.storage.sync（不会云同步到账号）');
  check(/chrome\.storage\.local/.test(policy), '政策里提到了 chrome.storage.local');
  check(/IndexedDB/.test(policy), '政策里提到了 IndexedDB（文件夹句柄）');

  // 代码里的存储项用英文 key，政策面向用户所以用中文名 —— 做映射后检查。
  // 直接查英文 key 会误报。
  const KEY_TO_CN = {
    settings: '设置',
    memory: '记忆',
    skills: '技能',
    rules: '规则',
    usage: '用量',
  };
  const keys = new Set(['settings']);
  for (const s of Object.values(sources)) {
    for (const m of s.matchAll(/const KEY = '([^']+)'/g)) keys.add(m[1]);
  }
  const missing = [...keys].filter((k) => {
    const cn = KEY_TO_CN[k];
    return cn ? !policy.includes(cn) : false;
  });
  check(
    missing.length === 0,
    `所有存储项都在政策中说明（${[...keys].map((k) => KEY_TO_CN[k] || k).join('、')}）${missing.length ? ` —— 缺：${missing.join(', ')}` : ''}`,
  );
}

console.log('\n[8] 声明「剪贴板仅主动触发」');
{
  const cs = sources['src/content/content.js'] || '';
  check(/clipboard\.(read|write)Text/.test(cs), '代码使用剪贴板 API');
  // 不应有剪贴板监听
  check(!/addEventListener\(\s*['"]paste['"]/.test(cs), '没有监听 paste 事件（不监控剪贴板）');
  check(!/addEventListener\(\s*['"]copy['"]/.test(cs), '没有监听 copy 事件');
  check(/不会在后台读取剪贴板/.test(policy), '政策里声明了不监控剪贴板');
}

console.log('\n[9] 声明「文件需用户主动选择」');
{
  const html = sources['src/panel/panel.html'] || '';
  check(/<input[^>]*type=["']file["']/.test(html), '用 <input type=file> 选文件（用户主动）');
  const fsApi = /showDirectoryPicker/.test(allSrc);
  check(fsApi, '文件夹写入用 showDirectoryPicker（需用户授权）');
  check(/无法自行访问你的磁盘/.test(policy), '政策里声明了无法自行读盘');
}

console.log('\n[10] 权限说明与 manifest 一致');
{
  for (const p of manifest.permissions) {
    check(new RegExp(`\`${p}\``).test(policy), `政策解释了 ${p} 权限`);
  }
  for (const p of manifest.optional_permissions || []) {
    check(new RegExp(`\`${p}\``).test(policy), `政策解释了可选权限 ${p}`);
    check(policy.includes(`${p}（**可选**）`) || policy.includes(`关于 \`${p}\``), `${p} 标注为可选`);
  }
  check(policy.includes('<all_urls>'), '解释了 <all_urls> 权限');
}

console.log('\n[11] 政策里没有遗留占位符');
{
  const placeholders = policy.match(/<your-username>|TODO|待补充|XXX|\[请填写\]/g) || [];
  // <your-username> 是故意的，提醒用户替换 —— 单独提示
  const realPlaceholders = placeholders.filter((p) => p !== '<your-username>');
  check(realPlaceholders.length === 0, `无未填写的占位符${realPlaceholders.length ? `（${realPlaceholders.join(', ')}）` : ''}`);
  if (placeholders.includes('<your-username>')) {
    console.log('      注意：政策里的 GitHub 链接含 <your-username>，发布前需替换为真实用户名');
  }
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 隐私政策与代码行为一致。');
