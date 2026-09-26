#!/usr/bin/env node
/**
 * abort-test.mjs —— 「停止」按钮的行为测试。
 *
 * 这个 bug 的根因是：取消标志只在循环的检查点生效，而在途的
 * 模型 fetch 可能要跑几十秒 —— 用户点了停止，界面却还在等。
 * 这里用「永不返回的 fetch」来复现并验证中止是否真的生效。
 *
 * 用法：node tools/abort-test.mjs
 */

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

/* ---------------- 假环境：模拟 background 的中止语义 ---------------- */

const inFlight = new Map();
let fetchStarted = 0;
let fetchAborted = 0;
/** 模型响应延迟（毫秒）—— 调大以模拟慢请求。 */
let modelDelay = 5000;

/**
 * 假的模型调用：像真实 fetch 一样可被 abort。
 * 这里精确复刻 background 里的行为，包括把用户中止与超时区分开。
 */
function fakeRunStep(payload) {
  const { requestId } = payload;
  fetchStarted += 1;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    if (requestId) inFlight.set(requestId, controller);
    const timer = setTimeout(() => {
      inFlight.delete(requestId);
      resolve({
        ok: true,
        data: {
          content: '',
          toolCalls: [
            { id: `c${fetchStarted}`, function: { name: 'finish', arguments: '{"summary":"慢请求终于返回了"}' } },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        },
      });
    }, modelDelay);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      fetchAborted += 1;
      inFlight.delete(requestId);
      const err = new Error(controller.__userAbort ? '__ABORTED__' : '请求超时（180s）');
      reject(err);
    });
  });
}

function fakeAbort(requestId) {
  const c = inFlight.get(requestId);
  if (!c) return { aborted: false };
  c.__userAbort = true;
  c.abort();
  inFlight.delete(requestId);
  return { aborted: true };
}

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    async sendMessage(msg) {
      switch (msg.type) {
        case 'agent/run-step':
          return fakeRunStep(msg.payload);
        case 'agent/abort':
          return { ok: true, data: fakeAbort(msg.requestId) };
        case 'agent/get-page':
          return { ok: true, data: { url: 'https://x.com', title: 'T', elements: [], viewport: { width: 1000, height: 800 } } };
        case 'panel/memory-context':
          return { ok: true, data: { text: '', count: 0 } };
        default:
          return { ok: false, error: `未处理 ${msg.type}` };
      }
    },
  },
};

const mod = (p) => `file:///${path.join(root, p).replace(/\\/g, '/')}`;
const { runAgent } = await import(mod('src/panel/agent.js'));
const { DEFAULT_SETTINGS } = await import(mod('src/shared/messages.js'));

/* ---------------- 测试 ---------------- */

console.log('\n停止按钮测试\n');

console.log('[1] 模型请求进行中时点停止');
{
  fetchStarted = 0;
  fetchAborted = 0;
  modelDelay = 5000; // 5 秒才返回

  let abortFn = null;
  const events = [];
  const startedAt = Date.now();

  const run = runAgent({
    task: '一个很慢的任务',
    settings: { ...DEFAULT_SETTINGS, apiKey: 'k', maxSteps: 8 },
    isCancelled: () => cancelledFlag,
    onAbortReady: (fn) => {
      abortFn = fn;
    },
    onEvent: (e) => events.push(e),
  });

  let cancelledFlag = false;
  // 等请求真正发出去（此时 currentRequestId 才会有值）
  await new Promise((r) => setTimeout(r, 120));
  check(fetchStarted === 1, '模型请求已发出');
  check(typeof abortFn === 'function', 'runAgent 把中止入口交给了面板');

  // 模拟点「停止」
  cancelledFlag = true;
  const aborted = await abortFn();
  check(aborted === true, '中止调用返回成功（确实有在途请求可中止）');

  const result = await run;
  const elapsed = Date.now() - startedAt;

  check(result.aborted === true, '运行结果标记为已中止');
  check(fetchAborted >= 1, `在途 fetch 被真正 abort（${fetchAborted} 次）`);
  // 关键：必须在模型延迟（5s）之前就结束
  check(elapsed < 2000, `立即结束而不是等模型返回（耗时 ${elapsed}ms << 5000ms）`);
  check(!result.error, '中止不算错误（不会弹出错误提示）');
  check(
    !events.some((e) => e.type === 'error'),
    '事件流里没有 error 事件',
  );
}

console.log('\n[2] 中止后不再继续下一步');
{
  fetchStarted = 0;
  fetchAborted = 0;
  modelDelay = 300;

  let cancelledFlag = false;
  let abortFn = null;
  const run = runAgent({
    task: '多步任务',
    settings: { ...DEFAULT_SETTINGS, apiKey: 'k', maxSteps: 8 },
    isCancelled: () => cancelledFlag,
    onAbortReady: (fn) => {
      abortFn = fn;
    },
    onEvent: () => {},
  });

  await new Promise((r) => setTimeout(r, 80));
  cancelledFlag = true;
  await abortFn();
  const result = await run;

  check(result.aborted === true, '标记为已中止');
  check(fetchStarted === 1, `只发出了 1 次请求（没有继续下一步，实际 ${fetchStarted}）`);
  check(result.steps.length === 0, '没有执行任何工具');
}

console.log('\n[3] 没有在途请求时中止是安全空操作');
{
  // 关键：让请求在 abortFn 被调用前就完成，此时 currentRequestId 已被清空。
  // 用一个"立即返回"的模型，并等它彻底结束再调 abort。
  modelDelay = 0;
  let finished = false;
  let abortFn = null;
  const run = runAgent({
    task: '快速任务',
    settings: { ...DEFAULT_SETTINGS, apiKey: 'k', maxSteps: 2 },
    isCancelled: () => false,
    onAbortReady: (fn) => {
      abortFn = fn;
    },
    onEvent: () => {},
  }).then((r) => {
    finished = true;
    return r;
  });

  // 轮询等任务真正结束（此时在途请求必然为空）
  for (let i = 0; i < 100 && !finished; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  check(finished, '快速任务已结束');
  const r = await abortFn();
  check(r === false, '无在途请求时返回 false（不报错）');
  const result = await run;
  check(!result.aborted, '没有误伤已完成的流程');
}

console.log('\n[4] 取消标志在工具执行前生效');
{
  // 让模型慢一点返回，这样我们能在"请求已发出但还没回来"时置位取消，
  // 验证请求返回后仍会检查取消标志并退出。
  modelDelay = 600;
  fetchStarted = 0;
  let cancelledFlag = false;
  const events = [];
  const run = runAgent({
    task: '任务',
    settings: { ...DEFAULT_SETTINGS, apiKey: 'k', maxSteps: 5 },
    isCancelled: () => cancelledFlag,
    onEvent: (e) => events.push(e),
  });

  // 等请求确实已发出，再置取消（此时不调 abort，让请求正常返回）
  for (let i = 0; i < 100 && fetchStarted === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  check(fetchStarted === 1, '请求已发出');
  cancelledFlag = true;

  const result = await run;
  check(result.aborted === true, '请求返回后检查取消标志并退出');
  check(result.steps.length === 0, '没有执行工具（取消生效）');
  check(!events.some((e) => e.type === 'done'), '没有误报完成');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 停止按钮测试全部通过。');
