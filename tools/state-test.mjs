#!/usr/bin/env node
/**
 * state-test.mjs —— 界面状态测试（运行条移除后的版本）。
 *
 * 背景：之前有一整套"处理中"运行条状态机，反复出现
 * "任务已结束但界面仍显示处理中"的问题。既然显示状态与真实状态
 * 是两份数据、任何异常路径都可能让它们不同步，最彻底的解法是
 * **不再显示运行状态** —— 只改控件的可用性。
 *
 * 这个套件验证的就是这套简化后的设计：
 *   1. 界面里不存在任何"处理中"文字元素
 *   2. 运行中只切换发送键/停止键的可用性
 *   3. busy 只在 finally 里复位（有 try/finally 保证）
 *   4. 停止键在任何状态下点都有确定行为
 *
 * 用法：node tools/state-test.mjs
 */

import { readFile } from 'node:fs/promises';
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

const panelSrc = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');
const htmlSrc = await readFile(path.join(root, 'src/panel/panel.html'), 'utf8');
const cssSrc = await readFile(path.join(root, 'src/panel/panel.css'), 'utf8');

/* ---------------- 抽出精简后的状态函数 ---------------- */

const grab = (name) => {
  const m = panelSrc.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`抽不出 ${name}`);
  return m[0];
};

const stateSrc = [
  panelSrc.match(/^let busy = [^;]+;/m)?.[0],
  panelSrc.match(/^let cancelled = [^;]+;/m)?.[0],
  panelSrc.match(/^let abortCurrent = [^;]+;/m)?.[0],
  grab('setBusy'),
  grab('stopTask'),
]
  .filter(Boolean)
  .join('\n');

const mkEl = () => ({
  hidden: true,
  textContent: '',
  disabled: false,
  className: '',
  title: '',
});
const el = {
  send: mkEl(),
  cancel: mkEl(),
  dot: mkEl(),
  modelHint: mkEl(),
  tokenHint: mkEl(),
};
const settings = { apiKey: 'k', model: 'deepseek-chat', memoryEnabled: false };
const setStatus = (s, t) => {
  el.dot.className = `dot${s === 'busy' ? ' busy' : s === 'err' ? ' err' : ''}`;
  el.dot.title = t || '';
};
const updateModelHint = () => {
  el.modelHint.textContent = settings.apiKey ? settings.model : '未配置';
};

const spawn = () =>
  new Function(
    'el',
    'settings',
    'setStatus',
    'updateModelHint',
    `${stateSrc}
     return {
       setBusy,
       stopTask,
       isBusy: () => busy,
       isCancelled: () => cancelled,
       setAbort: (fn) => { abortCurrent = fn; },
     };`,
  )(el, settings, setStatus, updateModelHint);

/* ---------------- 开测 ---------------- */

console.log('\n界面状态测试（运行条已移除）\n');

console.log('[1] 「处理中」相关元素已彻底移除');
{
  check(!/id="runbar"/.test(htmlSrc), 'HTML 里没有 runbar 元素');
  check(!/id="runText"/.test(htmlSrc), 'HTML 里没有 runText 元素');
  check(!/处理中/.test(htmlSrc), 'HTML 里没有「处理中」文字');
  check(!/正在停止/.test(htmlSrc), 'HTML 里没有「正在停止」文字');
  check(!/\.runbar/.test(cssSrc), 'CSS 里没有 runbar 规则');
  check(!/\.run-tokens/.test(cssSrc), 'CSS 里没有 run-tokens 规则');
  // panel.js 里只允许在注释中提及"处理中"（解释为什么移除），不能有实际文案
  const codeOnly = panelSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check(!/处理中/.test(codeOnly), 'panel.js 的代码里没有「处理中」文案（注释除外）');
  check(!/正在停止/.test(codeOnly), 'panel.js 的代码里没有「正在停止」文案');
  // 这些是旧状态机的函数，应当全部消失
  for (const dead of ['setRunning', 'forceIdle', 'stopWatchdog', 'runStaleSince']) {
    check(!new RegExp(`\\b${dead}\\b`).test(codeOnly), `已移除旧状态机函数 ${dead}`);
  }
}

console.log('\n[2] 运行中只切换控件可用性');
{
  const S = spawn();
  // 初始态取自 HTML：停止键带 disabled，发送键不带。
  // 注入的假 el 是"已按 HTML 初始化"的状态，所以这里先按实情设一次，
  // 之后的断言才是在验证 setBusy 的切换行为。
  el.cancel.disabled = true;
  check(el.send.disabled === false, '初始：发送键可用');
  check(el.cancel.disabled === true, '初始：停止键禁用（没东西可停）');

  S.setBusy(true);
  check(S.isBusy() === true, 'busy 置位');
  check(el.send.disabled === true, '运行中：发送键置灰');
  check(el.cancel.disabled === false, '运行中：停止键点亮');

  S.setBusy(false);
  check(S.isBusy() === false, 'busy 复位');
  check(el.send.disabled === false, '结束后：发送键恢复');
  check(el.cancel.disabled === true, '结束后：停止键回到禁用');
}

console.log('\n[3] 停止键在任何状态下都有确定行为');
{
  // 状态一：正在运行
  let S = spawn();
  S.setBusy(true);
  let abortCalled = 0;
  S.setAbort(async () => {
    abortCalled += 1;
    return true;
  });
  S.stopTask();
  await new Promise((r) => setTimeout(r, 10));
  check(S.isCancelled() === true, '运行中点停止：置取消标志');
  check(abortCalled === 1, '运行中点停止：掐断在途请求');
  check(S.isBusy() === false, '运行中点停止：立即解除忙碌（可继续输入）');

  // 状态二：空闲
  S = spawn();
  S.stopTask();
  check(S.isBusy() === false, '空闲点停止：不进入忙碌');
  check(el.send.disabled === false, '空闲点停止：发送键不受影响');

  // 状态三：没有中止函数（异常残留）
  S = spawn();
  S.setBusy(true);
  S.setAbort(null);
  S.stopTask();
  check(S.isBusy() === false, '无中止函数时点停止：仍然解除忙碌，不抛错');
}

console.log('\n[4] busy 只在 finally 里复位');
{
  const ht = panelSrc.match(/async function handleTask[\s\S]*?\n\}\n/)[0];
  check(/setBusy\(true\)/.test(ht), 'handleTask 里会置位 busy');
  check(/\} finally \{/.test(ht), '有 finally 块');
  const finallyBlock = ht.match(/\} finally \{([\s\S]*?)\n  \}/)[1];
  check(finallyBlock.includes('setBusy(false)'), 'finally 里复位 busy');
  check(finallyBlock.includes('abortCurrent = null'), 'finally 里清理中止函数');
  // setBusy(true) 必须在 try 内，否则它自己抛错就没人复位。
  // 定位要点：
  //   1) 用括号配对取 handleTask 的函数体（内部有嵌套 }，不能靠 \n}\n 截断）
  //   2) 匹配真正的调用语句，不能匹配到注释里提到的 "setBusy(true)"
  const fnStart = panelSrc.indexOf('async function handleTask');
  let depth = 0;
  let fnEnd = -1;
  for (let i = panelSrc.indexOf('{', fnStart); i < panelSrc.length; i += 1) {
    if (panelSrc[i] === '{') depth += 1;
    else if (panelSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        fnEnd = i;
        break;
      }
    }
  }
  const body = panelSrc.slice(fnStart, fnEnd);
  const tryIdx = body.indexOf('try {');
  const busyCall = body.match(/^\s*setBusy\(true\);/m);
  const addCall = body.match(/^\s*addMessage\('user'/m);
  check(Boolean(busyCall), 'handleTask 内确实调用了 setBusy(true)');
  check(Boolean(addCall), 'handleTask 内确实调用了 addMessage');
  check(busyCall.index > tryIdx, 'setBusy(true) 在 try 内部（关键）');
  check(addCall.index > tryIdx, 'addMessage 也在 try 内部');
}

console.log('\n[5] 停止按钮常驻、不依赖运行条');
{
  check(/id="btnCancel"/.test(htmlSrc), '停止键有独立 id');
  // 只看开始标签，不要跨到 SVG 里去（SVG 里会有 hidden 之外的属性干扰）
  const btnTag = htmlSrc.match(/<button id="btnCancel"[^>]*>/)[0];
  check(!/\shidden(\s|>|=)/.test(btnTag), '停止键不带 hidden 属性（常驻可见）');
  check(/\sdisabled/.test(btnTag), '停止键初始 disabled');
  // 停止键不应被塞在已移除的 runbar 里
  check(!/runbar[\s\S]{0,200}btnCancel/.test(htmlSrc), '停止键不在运行条内部');
  check(/\.cancel-btn\s*\{/.test(cssSrc), 'CSS 定义了 cancel-btn');
  check(/cancel-btn:disabled/.test(cssSrc), 'CSS 有禁用态样式');
}

console.log('\n[5b] HTML 结构完整性（防止编辑时留下重复元素）');
{
  // 这是实际踩过的坑：给输入区加新按钮时没删掉旧按钮，
  // 结果页面上出现了两个发送键、两个停止键，
  // 而且旧的那对还在 input-row 容器外面，会掉到下一行。
  const ids = [...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dups = [];
  for (const id of ids) {
    if (seen.has(id)) dups.push(id);
    seen.add(id);
  }
  check(
    dups.length === 0,
    `没有重复 id${dups.length ? `（重复：${[...new Set(dups)].join(', ')}）` : ''}`,
  );

  for (const key of ['btnSend', 'btnCancel', 'btnAttach', 'btnClip', 'input']) {
    const n = (htmlSrc.match(new RegExp(`id="${key}"`, 'g')) || []).length;
    check(n === 1, `${key} 只出现一次（实际 ${n}）`);
  }

  // 输入区的按钮必须都在 input-row 容器内，否则布局会错位
  const rowMatch = htmlSrc.match(/<div class="input-row">([\s\S]*?)\n      <\/div>/);
  check(Boolean(rowMatch), '能定位到 input-row 容器');
  if (rowMatch) {
    for (const key of ['btnAttach', 'btnClip', 'btnCancel', 'btnSend']) {
      check(rowMatch[1].includes(`id="${key}"`), `${key} 在 input-row 内（不会错位）`);
    }
  }

  // 标签配对
  const openBtn = (htmlSrc.match(/<button\b/g) || []).length;
  const closeBtn = (htmlSrc.match(/<\/button>/g) || []).length;
  check(openBtn === closeBtn, `button 标签配对（${openBtn} 开 / ${closeBtn} 闭）`);

  const openDiv = (htmlSrc.match(/<div\b/g) || []).length;
  const closeDiv = (htmlSrc.match(/<\/div>/g) || []).length;
  check(openDiv === closeDiv, `div 标签配对（${openDiv} 开 / ${closeDiv} 闭）`);
}

console.log('\n[6] 步骤时间线仍然记录过程（替代原来的文字提示）');
{
  check(/function addStepLine/.test(panelSrc), '仍有步骤时间线');
  const ht = panelSrc.match(/function handleAgentEvent[\s\S]*?\n\}/)[0];
  check(/addStepLine\(evt\.name/.test(ht), 'result 事件会写入时间线');
  // step / tool 不再改文字
  check(!/setBusy\(true, /.test(ht), 'step/tool 事件不再改任何文字状态');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 界面状态测试全部通过。');
