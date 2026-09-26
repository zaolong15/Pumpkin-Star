#!/usr/bin/env node
/**
 * e2e-test.mjs —— 端到端：让智能体真的用新功能完成一次任务。
 *
 * 与 smoke-test 的区别：这里跑的是"净化页面"这类真实任务，
 * 验证 思考 → 工具调用 → 页面改造 → 记忆写入 → 用量统计 这条完整链路。
 *
 * 用法：node tools/e2e-test.mjs
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

/* ---------------- 假环境 ---------------- */

const storage = {};
const addedMemories = [];
const patchLog = [];
let pageUrl = 'https://news.example.com/article/1';

const snapshotData = {
  url: pageUrl,
  title: '一篇被广告包围的文章',
  truncated: false,
  scroll: { y: 0, maxY: 900 },
  elements: [
    { id: 'e1', tag: 'article', text: '正文内容…' },
    { id: 'e2', tag: 'div', text: '限时优惠！', role: 'button' },
    { id: 'e3', tag: 'aside', text: '相关推荐', role: 'button' },
    { id: 'e4', tag: 'button', text: '订阅' },
  ],
};
const pageText = { url: pageUrl, title: '一篇被广告包围的文章', text: '正文'.repeat(50), truncated: false };

/** 记忆库内容（会被注入上下文）。 */
const memories = [
  { id: 'm1', kind: 'preference', text: '喜欢简洁的阅读界面', hits: 1 },
  { id: 'm2', kind: 'fact', text: '常在通勤时读长文' },
  { id: 'm3', kind: 'site', text: '该站的广告元素通常带 role=button 且文字含"限时"', site: 'news.example.com' },
];

/** 模型这次的剧本：快照 → 注入CSS → 隐藏广告 → 记住偏好 → 完成。 */
const script = [
  {
    toolCalls: [{ id: 'c1', function: { name: 'snapshot', arguments: '{}' } }],
    usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 },
  },
  {
    toolCalls: [
      { id: 'c2', function: { name: 'add_style', arguments: JSON.stringify({
        css: '.ad,.ad-banner,[class*="promo"]{display:none!important}\narticle{font-size:18px;line-height:1.9;max-width:720px;margin:0 auto}',
      }) } },
      { id: 'c3', function: { name: 'hide', arguments: '{"id":"e2"}' } },
      { id: 'c4', function: { name: 'hide', arguments: '{"id":"e3"}' } },
    ],
    usage: { prompt_tokens: 1100, completion_tokens: 120, total_tokens: 1220 },
  },
  {
    toolCalls: [
      { id: 'c5', function: { name: 'remember', arguments: '{"kind":"preference","text":"阅读类页面喜欢净化后的简洁排版"}' } },
    ],
    usage: { prompt_tokens: 1250, completion_tokens: 40, total_tokens: 1290 },
  },
  {
    toolCalls: [{ id: 'c6', function: { name: 'finish', arguments: JSON.stringify({
      summary: '已净化页面：\n- 注入 CSS 隐藏广告位与促销块\n- 隐藏了"限时优惠"和"相关推荐"\n- 正文改为 18px / 行距 1.9 / 最大宽度 720px 居中\n\n刷新页面即恢复原样。',
    }) } }],
    usage: { prompt_tokens: 1300, completion_tokens: 80, total_tokens: 1380 },
  },
];

let turn = 0;
const capturedTurns = [];

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    async sendMessage(msg) {
      switch (msg.type) {
        case 'agent/run-step': {
          capturedTurns.push(JSON.parse(JSON.stringify(msg.payload.messages)));
          const step = script[Math.min(turn, script.length - 1)];
          turn += 1;
          return { ok: true, data: {
            content: step.content || '',
            toolCalls: step.toolCalls,
            usage: step.usage,
          } };
        }
        case 'agent/get-page':
          return { ok: true, data: snapshotData };
        case 'agent/get-page-text':
          return { ok: true, data: pageText };
        case 'agent/exec-action': {
          patchLog.push(msg.action);
          return { ok: true, data: { ok: true, ...msg.action } };
        }
        case 'agent/memory/add':
        case 'memory/add': {
          addedMemories.push(msg.item);
          return { ok: true, data: { added: true, item: { ...msg.item, id: `new${addedMemories.length}` } } };
        }
        case 'panel/memory-context':
          return { ok: true, data: { text: memories.map((m) => `- ${m.text}`).join('\n'), count: memories.length, url: pageUrl } };
        case 'usage/task-record':
          return { ok: true, data: { id: 't1' } };
        case 'memory/distill':
          return { ok: true, data: { added: 0 } };
        default:
          return { ok: false, error: `e2e 未处理 ${msg.type}` };
      }
    },
  },
  storage: {
    local: {
      async get(k) { return { [k]: storage[k] }; },
      async set(o) { Object.assign(storage, o); },
    },
  },
};

const mod = (p) => `file:///${path.join(root, p).replace(/\\/g, '/')}`;
const { runAgent } = await import(mod('src/panel/agent.js'));
const { DEFAULT_SETTINGS } = await import(mod('src/shared/messages.js'));

/* ---------------- 跑真实任务 ---------------- */

console.log('\n端到端：净化页面任务\n');

const events = [];
const result = await runAgent({
  task: '把这个页面改造成适合阅读的样子，去掉广告和弹窗',
  settings: { ...DEFAULT_SETTINGS, apiKey: 'k', maxSteps: 8, memoryEnabled: true },
  isCancelled: () => false,
  onEvent: (e) => events.push(e),
});

console.log('[1] 任务完成');
check(!result.error, '任务无错误结束');
check(Boolean(result.summary), '拿到最终答复');
check(result.summary.includes('广告'), '答复说明了改造内容');
check(!result.exhausted, '没有耗尽步数');

console.log('\n[2] 事件流');
check(events.some((e) => e.type === 'step'), '有步进事件');
check(!events.some((e) => e.type === 'reasoning'), '不再产生推理过程事件（已移除思考展示）');

console.log('\n[3] 页面改造真的执行了');
const styleAction = patchLog.find((a) => a.type === 'add_style');
const hideActions = patchLog.filter((a) => a.type === 'hide');
check(Boolean(styleAction), '注入了全局 CSS');
check(styleAction.css.includes('display:none'), 'CSS 里确实有隐藏规则');
check(styleAction.css.includes('font-size'), 'CSS 里调整了字号');
check(hideActions.length === 2, `隐藏了 ${hideActions.length} 个干扰元素`);
check(hideActions.map((a) => a.id).sort().join(',') === 'e2,e3', '隐藏的正是广告位与侧边栏');

console.log('\n[4] 记忆写入');
check(addedMemories.length === 1, `写入 ${addedMemories.length} 条记忆`);
check(addedMemories[0].kind === 'preference', '类型为偏好');
check(addedMemories[0].text.includes('简洁'), '内容合理');
check(events.some((e) => e.type === 'memory-added'), '界面收到记忆写入事件');

console.log('\n[5] 记忆注入上下文');
check(events.some((e) => e.type === 'memory' && e.count === 3), '启动时注入了 3 条长期记忆');
const firstTurn = capturedTurns[0];
const memMsg = firstTurn.find((m) => m.role === 'system' && m.content.includes('【长期记忆】'));
check(Boolean(memMsg), '上下文里带上了长期记忆块');
check(memMsg.content.includes('该站的广告元素'), '站点经验被注入');

// 结构约定：system 提示 → 长期记忆 → 用户任务 → 环境信息
const roles = firstTurn.map((m) => m.role);
check(roles[0] === 'system', '第 1 条是主系统提示');
check(roles[1] === 'system' && firstTurn[1].content.includes('【长期记忆】'), '第 2 条是长期记忆');
check(roles[2] === 'user', '第 3 条是用户任务');
check(firstTurn[firstTurn.length - 1].content.includes('【当前环境】'), '最后一条是当前环境信息');
check(firstTurn.filter((m) => m.role === 'user').length === 1, '只有一条用户消息（记忆没有被误插成对话）');

console.log('\n[6] 步数上限');
const stepEvent = events.find((e) => e.type === 'step');
check(stepEvent.total === 8, `严格按设置的步数上限（${stepEvent.total}）`);
const envMsg = firstTurn[firstTurn.length - 1];
check(!envMsg.content.includes('深度思考'), '环境信息里不再标注思考模式');
check(firstTurn[0].content.includes('页面改造'), '主提示包含页面改造指引');

console.log('\n[7] token 统计');
const usageEvents = events.filter((e) => e.type === 'usage');
check(usageEvents.length === 4, `收到 ${usageEvents.length} 次用量更新（每次模型调用一次）`);
const final = usageEvents[usageEvents.length - 1].usage;
check(final.total === 860 + 1220 + 1290 + 1380, `总 token 累计正确（${final.total}）`);
check(final.prompt === 800 + 1100 + 1250 + 1300, `输入 token 累计正确（${final.prompt}）`);
check(final.completion === 60 + 120 + 40 + 80, `输出 token 累计正确（${final.completion}）`);
check(final.calls === 4, `调用次数正确（${final.calls}）`);
check(usageEvents[0].usage.total === 860, '首次更新只含第一轮用量（不是一次性汇总）');

console.log('\n[8] 工具序列符合预期');
const tools = result.steps.map((s) => s.tool);
check(tools[0] === 'snapshot', '先看页面结构');
check(tools.includes('add_style'), '使用了全局 CSS 改造');
check(tools.includes('hide'), '使用了隐藏');
check(tools.includes('remember'), '使用了记忆');
check(result.steps.length === 5, `共执行 ${result.steps.length} 个工具调用`);

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 端到端测试全部通过。');
