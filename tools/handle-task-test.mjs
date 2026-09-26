#!/usr/bin/env node
/**
 * handle-task-test.mjs —— 真实跑 handleTask，验证界面状态不会被卡住。
 *
 * 这是对 state-test 的补充：state-test 只测了状态函数本身，
 * 这里把 panel.js 里的 handleTask 连同真实的 runAgent 一起跑，
 * 覆盖「任务正常结束」「渲染抛错」「从未开始」等路径。
 *
 * 用法：node tools/handle-task-test.mjs
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

/* ---------------- 假 DOM ---------------- */

const mkEl = () => ({
  hidden: true,
  textContent: '',
  innerHTML: '',
  disabled: false,
  className: '',
  title: '',
  style: { height: '', setProperty() {}, removeProperty() {} },
  scrollHeight: 10,
  scrollTop: 0,
  value: '',
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {},
  append() {},
  remove() {},
  addEventListener() {},
  querySelectorAll: () => [],
  querySelector: () => null,
});

const el = new Proxy(
  {},
  {
    get: (t, k) => {
      if (!t[k]) t[k] = mkEl();
      return t[k];
    },
  },
);

globalThis.document = {
  documentElement: { setAttribute() {}, style: { setProperty() {}, removeProperty() {} } },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => mkEl(),
  getElementById: () => mkEl(),
};
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
};

/* ---------------- 假 chrome ---------------- */

let runStepImpl = null;
let abortCalls = 0;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    async sendMessage(msg) {
      switch (msg.type) {
        case 'agent/run-step':
          return runStepImpl(msg.payload);
        case 'agent/abort':
          abortCalls += 1;
          return { ok: true, data: { aborted: true } };
        case 'agent/get-page':
          return { ok: true, data: { url: 'https://x.com', title: 'T', elements: [], viewport: { width: 1000, height: 800 } } };
        case 'panel/memory-context':
          return { ok: true, data: { text: '', count: 0 } };
        case 'settings/get':
          return { ok: true, data: { apiKey: 'k', model: 'deepseek-chat', memoryEnabled: false } };
        case 'usage/task-record':
          return { ok: true, data: {} };
        case 'memory/distill':
          return { ok: true, data: { added: 0 } };
        default:
          return { ok: false, error: `未处理 ${msg.type}` };
      }
    },
  },
  storage: {
    local: { async get() { return {}; }, async set() {} },
  },
  permissions: { async request() { return true; }, async contains() { return false; } },
};

/* ---------------- 抽出 panel.js 的关键部分并组装 ---------------- */

const panelSrc = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');

function grab(re, label) {
  const m = panelSrc.match(re);
  if (!m) throw new Error(`抽不出 ${label}`);
  return m[0];
}

// 运行态相关的变量与函数（运行条移除后的精简版）
const pieces = [
  grab(/^let busy = [^;]+;/m, 'busy'),
  grab(/^let cancelled = [^;]+;/m, 'cancelled'),
  grab(/^let abortCurrent = [^;]+;/m, 'abortCurrent'),
  grab(/^function setBusy\([\s\S]*?\n\}/m, 'setBusy'),
  grab(/^function stopTask\([\s\S]*?\n\}/m, 'stopTask'),
  grab(/^function handleAgentEvent\([\s\S]*?\n\}\n/m, 'handleAgentEvent'),
  grab(/^async function handleTask\([\s\S]*?\n\}\n/m, 'handleTask'),
].join('\n');

const helpers = `
  const settings = { apiKey: 'k', model: 'deepseek-chat', memoryEnabled: false, evolutionEnabled: false };
  // handleTask 会读这两个（附件与剪贴板上下文），测试里给空值
  let attachments = [];
  let clipContext = '';
  const renderFiles = () => '';
  const summarizeFiles = () => '';
  const renderAttachBar = () => {};
  const addStepLine = () => {};
  let history = [];
  let sessionTokens = 0;
  const setStatus = (s, t) => { el.dot.className = 'dot ' + s; el.dot.title = t || ''; };
  const scrollToBottom = () => {};
  const updateModelHint = () => { el.modelHint.textContent = settings.model; };
  const fmtTokens = (n) => String(n);
  const renderMarkdown = (s) => String(s || '');
  const syncFloat = () => {};
  const openSettings = () => {};
  const autoGrow = () => {};
  const callBg = async (type, extra) => {
    const res = await chrome.runtime.sendMessage({ type, ...(extra || {}) });
    if (res && res.ok === false) throw new Error(res.error);
    return res ? res.data : null;
  };
  // addMessage：可被外部替换以注入渲染错误
  let addMessageImpl = () => {
    const d = { dataset: {}, remove() {}, innerHTML: '' };
    return d;
  };
  const addMessage = (...a) => addMessageImpl(...a);
  const MSG = { MEM_DISTILL: 'memory/distill', RUN_STEP: 'agent/run-step', ABORT: 'agent/abort' };
`;

const { runAgent } = await import(
  `file:///${path.join(root, 'src/panel/agent.js').replace(/\\/g, '/')}`
);

const makeCtx = () =>
  new Function(
    'el',
    'chrome',
    'runAgent',
    `${helpers}\n${pieces}\nreturn {
       handleTask,
       stopTask,
       isBusy: () => busy,
       isCancelled: () => cancelled,
       sendDisabled: () => el.send.disabled,
       setAddMessage: (fn) => { addMessageImpl = fn; },
     };`,
  )(el, globalThis.chrome, runAgent);

/* ---------------- 开测 ---------------- */

console.log('\nhandleTask 状态测试\n');

console.log('[1] 任务正常结束 → 解除忙碌');
{
  runStepImpl = async () => ({
    ok: true,
    data: {
      content: '',
      toolCalls: [{ id: 'c1', function: { name: 'finish', arguments: '{"summary":"做完了"}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  });
  const ctx = makeCtx();
  await ctx.handleTask('测试任务');
  check(ctx.isBusy() === false, 'busy 归位 false');
  check(ctx.sendDisabled() === false, '发送键恢复可用');
  check(ctx.sendDisabled() === false, '发送键恢复可用');
}

console.log('\n[2] 渲染抛错 → 仍然解除忙碌（这是"显示处理中"的根因之一）');
{
  runStepImpl = async () => ({
    ok: true,
    data: {
      content: '',
      toolCalls: [{ id: 'c1', function: { name: 'finish', arguments: '{"summary":"x"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  });
  const ctx = makeCtx();
  // 让"占位消息"之后的所有渲染都抛错
  let calls = 0;
  ctx.setAddMessage((role, content) => {
    calls += 1;
    if (calls > 1) throw new Error('模拟渲染崩溃');
    return { dataset: {}, remove() {}, innerHTML: '' };
  });
  await ctx.handleTask('会崩的任务');
  check(ctx.isBusy() === false, '渲染崩溃后 busy 仍然归位');
  check(ctx.sendDisabled() === false, '仍然解除忙碌');
}

console.log('\n[3] addMessage 一开始就抛错 → 不能把 busy 卡在 true');
{
  runStepImpl = async () => ({ ok: true, data: { content: 'ok', toolCalls: [], usage: null } });
  const ctx = makeCtx();
  ctx.setAddMessage(() => {
    throw new Error('第一条消息就崩');
  });
  await ctx.handleTask('立刻崩溃');
  check(ctx.isBusy() === false, 'busy 未被卡住（setBusy 在 try 内）');
  check(ctx.sendDisabled() === false, '没有残留忙碌');
}

console.log('\n[4] 模型请求抛错 → 解除忙碌');
{
  runStepImpl = async () => ({ ok: false, error: '接口返回 500' });
  const ctx = makeCtx();
  await ctx.handleTask('会失败的任务');
  check(ctx.isBusy() === false, 'busy 归位');
  check(ctx.sendDisabled() === false, '解除忙碌');
}

console.log('\n[5] 停止：立即解除忙碌，不等请求返回');
{
  runStepImpl = async () => {
    // 永不返回的请求，模拟慢模型
    return new Promise(() => {});
  };
  const ctx = makeCtx();
  abortCalls = 0;
  ctx.handleTask('慢任务'); // 故意不 await
  await new Promise((r) => setTimeout(r, 30));
  check(ctx.isBusy() === true, '任务正在跑（发送键置灰）');

  ctx.stopTask();
  check(ctx.isCancelled() === true, '置位取消标志');
  // 关键：立即恢复可输入，不等后台循环真正退出。
  // 因为"展示状态"已经不存在了，不需要等任何收尾确认。
  check(ctx.isBusy() === false, '立即解除忙碌（不用等请求返回）');
  check(ctx.sendDisabled() === false, '发送键立刻恢复可用');
  await new Promise((r) => setTimeout(r, 20));
  check(abortCalls >= 1, '掐断了在途的模型请求');
}

console.log('\n[6] 停止：反复点都是安全的');
{
  runStepImpl = async () => new Promise(() => {});
  const ctx = makeCtx();
  ctx.handleTask('慢任务2');
  await new Promise((r) => setTimeout(r, 30));
  check(ctx.isBusy() === true, '任务正在跑');
  ctx.stopTask();
  ctx.stopTask();
  ctx.stopTask();
  check(ctx.isBusy() === false, '连点多次仍是解除忙碌，不抛错');
  check(ctx.sendDisabled() === false, '发送键可用');
}

console.log('\n[7] 空闲时点停止：无副作用');
{
  const ctx = makeCtx();
  ctx.stopTask();
  check(ctx.isBusy() === false, '空闲点停止不会进入忙碌');
  check(ctx.sendDisabled() === false, '发送键不受影响');
  check(ctx.isCancelled() === true, '取消标志被置位（下次任务会重置，无影响）');
}

console.log('\n[8] 慢任务结束后仍会自行收尾（不依赖用户点停止）');
{
  runStepImpl = async () => {
    await new Promise((r) => setTimeout(r, 120));
    return {
      ok: true,
      data: {
        content: '',
        toolCalls: [{ id: 'c1', function: { name: 'finish', arguments: '{"summary":"慢但是完成了"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      },
    };
  };
  const ctx = makeCtx();
  const p = ctx.handleTask('慢任务3');
  await new Promise((r) => setTimeout(r, 30));
  check(ctx.isBusy() === true, '等待期间是忙碌状态');
  await p;
  check(ctx.isBusy() === false, '结束后自动解除忙碌');
  check(ctx.sendDisabled() === false, '发送键恢复');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 handleTask 状态测试全部通过。');
