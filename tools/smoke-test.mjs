#!/usr/bin/env node
/**
 * smoke-test.mjs —— 不开浏览器，用假的 chrome API + 假的模型接口
 * 跑通一条完整的智能体链路：snapshot → type_text → click → finish
 *
 * 用法：node tools/smoke-test.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const assert = (cond, msg) => {
  if (cond) console.log(`  \u2713 ${msg}`);
  else {
    failures.push(msg);
    console.log(`  \u2717 ${msg}`);
  }
};
// 后加的用例用了 check 这个名字，统一成同一个断言函数
const check = assert;

// ---------- 1. 搭一个假的浏览器环境 ----------
const calls = [];

const fakeSnapshot = {
  url: 'https://example.com/search',
  title: '示例搜索',
  truncated: false,
  scroll: { y: 0, maxY: 1200 },
  elements: [
    { id: 'e1', tag: 'input', type: 'search', placeholder: '搜索…', box: [0, 0, 100, 30] },
    { id: 'e2', tag: 'button', text: '搜索', box: [110, 0, 60, 30] },
    { id: 'e3', tag: 'a', text: '关于我们', href: 'https://example.com/about', box: [0, 40, 80, 20] },
  ],
};

const pageText = {
  url: 'https://example.com/search',
  title: '示例搜索',
  text: '这是一段用来测试的正文内容。'.repeat(20),
  truncated: false,
};

/** 模拟 content script 的行为。 */
function fakeContent(msg) {
  calls.push(msg.type);
  switch (msg.type) {
    case 'cs/ping':
      return { ok: true };
    case 'cs/snapshot':
      return { ok: true, data: fakeSnapshot };
    case 'cs/read':
      return { ok: true, data: pageText };
    case 'cs/act': {
      const a = msg.action;
      if (a.type === 'type') return { ok: true, typed: a.value };
      if (a.type === 'click') return { ok: true, clicked: '搜索' };
      if (a.type === 'scroll') return { ok: true, moved: 800 };
      return { ok: false, error: `未支持 ${a.type}` };
    }
    default:
      return { ok: false, error: `未知 ${msg.type}` };
  }
}

/** 模拟模型：按脚本依次返回工具调用，最后 finish。 */
const modelScript = [
  {
    toolCalls: [
      { id: 'c1', function: { name: 'type_text', arguments: '{"id":"e1","value":"深空探测","enter":false}' } },
    ],
  },
  { toolCalls: [{ id: 'c2', function: { name: 'click', arguments: '{"id":"e2"}' } }] },
  {
    toolCalls: [
      { id: 'c3', function: { name: 'finish', arguments: '{"summary":"已在「示例搜索」输入 **深空探测** 并点击搜索。"}' } },
    ],
  },
];
let modelTurn = 0;
const sentMessages = [];

/** 假 chrome API。 */
const storage = {};
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    async sendMessage(msg) {
      // panel/agent -> background 的记录
      if (msg.type === 'agent/run-step') {
        sentMessages.push(msg.payload.messages);
        const reply = modelScript[Math.min(modelTurn, modelScript.length - 1)];
        modelTurn += 1;
        return { ok: true, data: { content: '', toolCalls: reply.toolCalls, usage: { total_tokens: 100 } } };
      }
      if (msg.type === 'agent/get-page') return { ok: true, data: fakeSnapshot };
      if (msg.type === 'agent/get-page-text') return { ok: true, data: pageText };
      if (msg.type === 'agent/exec-action') return { ok: true, data: fakeContent({ type: 'cs/act', action: msg.action }) };
      return { ok: false, error: `smoke：未处理 ${msg.type}` };
    },
  },
  storage: {
    local: {
      async get(k) {
        return { [k]: storage[k] };
      },
      async set(obj) {
        Object.assign(storage, obj);
      },
    },
  },
  sidePanel: { setPanelBehavior: async () => {} },
  tabs: {},
  scripting: {},
};

// ---------- 2. 加载真实模块 ----------
console.log('\n[1] 模块加载');
const { runAgent, TOOLS } = await import(`file:///${path.join(root, 'src/panel/agent.js').replace(/\\/g, '/')}`);
assert(typeof runAgent === 'function', 'agent.js 导出 runAgent');
assert(TOOLS.length >= 10, `工具表有 ${TOOLS.length} 个工具`);

const msgMod = await import(`file:///${path.join(root, 'src/shared/messages.js').replace(/\\/g, '/')}`);
assert(msgMod.DEFAULT_SETTINGS.apiKey === '', '默认设置里没有硬编码密钥');

// ---------- 3. 跑完整循环 ----------
console.log('\n[2] 智能体循环');
const events = [];
const result = await runAgent({
  task: '在搜索框输入「深空探测」并点击搜索',
  settings: { ...msgMod.DEFAULT_SETTINGS, apiKey: 'test-key', maxSteps: 6, language: 'zh' },
  isCancelled: () => false,
  onEvent: (e) => events.push(e.type),
});

assert(!result.error, '循环没有报错');
assert(result.summary?.includes('深空探测'), `拿到最终答复：${String(result.summary).slice(0, 40)}…`);
assert(result.steps.length === 2, `执行了 ${result.steps.length} 个动作（预期 2）`);
assert(result.steps[0].tool === 'type_text', '第 1 步是 type_text');
assert(result.steps[0].result.typed === '深空探测', '输入的文本正确');
assert(result.steps[1].tool === 'click', '第 2 步是 click');
assert(result.steps[1].result.clicked === '搜索', '点击的目标正确');
assert(events.includes('step') && events.includes('tool') && events.includes('result') && events.includes('done'), `事件齐全：${[...new Set(events)].join(',')}`);

// ---------- 4. 上下文正确性 ----------
console.log('\n[3] 上下文与工具协议');
const lastTurn = sentMessages[sentMessages.length - 1];
assert(lastTurn[0].role === 'system', '第一条是 system 提示');
assert(lastTurn.length > 3, `最终上下文累积了 ${lastTurn.length} 条消息`);
// 每个 tool 结果都必须有对应调用；finish 是终止工具，不产生结果，属正常
const toolMsgs = lastTurn.filter((m) => m.role === 'tool');
const askedToolMsgs = lastTurn.flatMap((m) => m.tool_calls || []);
assert(toolMsgs.length >= 1, `动作结果作为 tool 消息回灌（${toolMsgs.length} 条）`);
assert(toolMsgs.every((m) => typeof m.tool_call_id === 'string'), 'tool 消息带 tool_call_id');
assert(
  toolMsgs.every((m) => askedToolMsgs.some((c) => c.id === m.tool_call_id)),
  '每条 tool 结果都能对应到一次真实调用',
);
const nonFinishCalls = askedToolMsgs.filter((c) => c.function.name !== 'finish').length;
assert(
  nonFinishCalls === toolMsgs.length,
  `非 finish 调用与结果一一配对（${nonFinishCalls} 调用 / ${toolMsgs.length} 结果）`,
);
// 每条 tool 消息前面必须紧跟带 tool_calls 的 assistant 消息（OpenAI 协议要求）
const orderOk = lastTurn.every((m, i) => m.role !== 'tool' || lastTurn[i - 1]?.tool_calls);
assert(orderOk, '每条 tool 消息都紧跟在对应的 assistant.tool_calls 之后');
assert(lastTurn.some((m) => m.role === 'system' && m.content.includes('当前标签页')), '注入了页面上下文');
const toolNames = TOOLS.map((t) => t.function.name);
assert(new Set(toolNames).size === toolNames.length, '工具名无重复');
assert(
  TOOLS.every((t) => t.type === 'function' && t.function.parameters?.type === 'object'),
  '每个工具都有合法的 JSON Schema',
);
const finishTool = TOOLS.find((t) => t.function.name === 'finish');
assert(finishTool, '存在 finish 工具（保证循环可终止）');
assert(TOOLS.map((t) => t.function.name).includes('read_page'), '存在 read_page（翻译/总结依赖）');

// ---------- 5. 步数上限保护 ----------
console.log('\n[4] 边界情况');
// 模型永远返回同一个动作、从不 finish —— 应该在第 maxSteps 步被强制收敛
globalThis.chrome.runtime.sendMessage = async (msg) => {
  if (msg.type === 'agent/run-step') {
    modelTurn += 1;
    return {
      ok: true,
      data: {
        content: '',
        toolCalls: [{ id: `c${modelTurn}`, function: { name: 'scroll', arguments: '{"amount":800}' } }],
      },
    };
  }
  if (msg.type === 'agent/get-page') return { ok: true, data: fakeSnapshot };
  if (msg.type === 'agent/get-page-text') return { ok: true, data: pageText };
  if (msg.type === 'agent/exec-action') return { ok: true, data: { ok: true, moved: 800 } };
  return { ok: false, error: `smoke：未处理 ${msg.type}` };
};
modelTurn = 0;
const loopResult = await runAgent({
  task: '无限滚动',
  settings: { ...msgMod.DEFAULT_SETTINGS, apiKey: 'k', maxSteps: 3 },
  isCancelled: () => false,
  onEvent: () => {},
});
assert(loopResult.exhausted === true, '模型不调用 finish 时触发步数上限');
assert(loopResult.steps.length === 3, `严格遵守 maxSteps=3（实际执行 ${loopResult.steps.length} 步）`);
assert(modelTurn === 3, `恰好请求模型 3 次（实际 ${modelTurn} 次，无多余调用）`);
assert(loopResult.summary?.includes('最大步数'), '达到上限时给出可读提示');

const cancelResult = await runAgent({
  task: '取消测试',
  settings: { ...msgMod.DEFAULT_SETTINGS, apiKey: 'k' },
  isCancelled: () => true,
  onEvent: () => {},
});
assert(cancelResult.aborted === true, '取消信号能中断循环');

// ---------- 6. Markdown 渲染器的安全性 ----------
console.log('\n[5] 面板渲染安全');
const panelSrc = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');
assert(panelSrc.includes('escapeHtml'), '面板对内容做 HTML 转义');
const escapeIdx = panelSrc.indexOf('text = escapeHtml(text)');
const codeIdx = panelSrc.indexOf('blocks.push');
assert(codeIdx < escapeIdx, '代码块先于转义被摘出（顺序正确）');
// 只允许 replyEl 通过 renderMarkdown 写 HTML，且初始化清空为常量 ''
const rawHtmlWrites = [...panelSrc.matchAll(/(\w+)\.innerHTML\s*=\s*([^;]+);/g)].filter(
  ([, , rhs]) => !rhs.includes('renderMarkdown') && rhs !== "''",
);
assert(rawHtmlWrites.length === 0, `没有绕过渲染器的裸 innerHTML 赋值（发现 ${rawHtmlWrites.length} 处）`);
assert(!/\.innerHTML\s*=\s*`/.test(panelSrc), '没有用模板字符串拼 innerHTML');
assert(/textContent =/.test(panelSrc), '步骤时间线用 textContent 写入模型返回的文本');

// 渲染器必须能中和模型/网页回灌的注入载荷
{
  const escSrc = panelSrc.match(/const escapeHtml = [\s\S]*?;\n/)?.[0];
  const mdSrc = panelSrc.match(/function renderMarkdown\(src\) \{[\s\S]*?\n\}/)?.[0];
  assert(Boolean(escSrc && mdSrc), '能提取渲染器用于隔离测试');
  if (escSrc && mdSrc) {
    const renderMarkdown = new Function(`${escSrc}${mdSrc}; return renderMarkdown;`)();
    const ALLOWED = new Set([
      'p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a',
    ]);
    const payloads = [
      '<img src=x onerror=alert(1)>',
      '<script>alert(1)</script>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '**<img src=x onerror=alert(1)>**',
      '`<script>alert(1)</script>`',
      '```\n<script>alert(1)</script>\n```',
      '| <script>x</script> | b |\n| --- | --- |\n| 1 | 2 |',
      '[x](javascript:alert(1))',
      '<style>*{display:none}</style>',
    ];
    let unsafe = 0;
    for (const p of payloads) {
      const out = renderMarkdown(p);
      const tags = [...out.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>/g)];
      const illegal = tags.filter(([, n]) => !ALLOWED.has(n.toLowerCase()));
      const dangerous = tags.filter(([, , attrs]) => /\son\w+\s*=/i.test(attrs || '') || /javascript:/i.test(attrs || ''));
      if (illegal.length || dangerous.length) {
        unsafe += 1;
        console.log(`      ! 载荷未被中和：${JSON.stringify(p.slice(0, 40))}`);
      }
    }
    assert(unsafe === 0, `渲染器中和了全部 ${payloads.length} 个注入载荷`);
    assert(renderMarkdown('**粗体** 和 \`代码\`').includes('<strong>粗体</strong>'), '正常 Markdown 仍能渲染');
    assert(renderMarkdown('| a |\n| --- |\n| 1 |').includes('<table>'), 'Markdown 表格能渲染');
  }
}

// ---------- 7. content script 的动作覆盖 ----------
console.log('\n[6] content script 动作覆盖');
const contentSrc = await readFile(path.join(root, 'src/content/content.js'), 'utf8');
const agentSrc = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');
for (const action of [
  'click', 'type', 'select', 'scroll', 'navigate', 'back', 'wait', 'extract', 'highlight',
  'set_text', 'hide', 'show', 'set_style', 'add_style', 'remove',
]) {
  check(contentSrc.includes(`case '${action}'`) || contentSrc.includes(`'${action}'`), `content 支持 ${action}`);
}
check(contentSrc.includes('setNativeValue'), '输入使用原生 setter（兼容 React/Vue）');
check(contentSrc.includes('PointerEvent'), '点击派发完整指针事件序列');
check(contentSrc.includes('__AI_AGENT_CONTENT_LOADED__'), 'content script 可重复注入而不会重复挂载');
check(contentSrc.includes('recordPatch'), '改造动作会记录原始状态');
check(contentSrc.includes('resetPatches'), '提供撤销入口');

// 每个页面改造工具都要能在 content 侧找到对应实现
const patchTools = ['set_text', 'hide', 'show', 'set_style', 'add_style', 'remove_element', 'inject_js'];
for (const t of patchTools) {
  const mapped = agentSrc.includes(`case '${t}'`);
  check(mapped, `agent.js 里 ${t} 已映射到动作`);
}

// ---------- 8. 用量与主题 ----------
console.log('\n[7] Token 统计与外观');
{
  const agentSrc2 = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');
  check(agentSrc2.includes('trackUsage'), '累计每次调用的用量');
  check(agentSrc2.includes("type: 'usage'"), '用量会推给界面');
  // 深度思考已移除，不应再残留相关分支
  check(!agentSrc2.includes('thinkingStepBoost'), '已移除思考模式的步数加成');
  check(!agentSrc2.includes("type: 'reasoning'"), '已移除推理过程事件');

  // 上下文里不能残留未替换的占位符（之前的模板字符串踩过这个坑）
  check(!agentSrc2.includes("${'{maxSteps}'}"), '系统提示里没有未替换的占位符');
  check(/最多 \$\{maxSteps\} 步/.test(agentSrc2), '步数上限被真实写入提示词');

  const panelSrc2 = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');
  check(!panelSrc2.includes('chkThinking'), '面板已移除思考开关');
  check(!panelSrc2.includes('addReasoning'), '面板已移除思考过程渲染');

  const htmlSrc = await readFile(path.join(root, 'src/panel/panel.html'), 'utf8');
  check(!htmlSrc.includes('chkThinking'), '设置界面已移除思考开关');
  check(!htmlSrc.includes('深度思考'), '设置界面已无深度思考文案');

  const bgSrc3 = await readFile(path.join(root, 'src/background.js'), 'utf8');
  check(!bgSrc3.includes('enable_thinking'), '请求体不再携带思考参数');
  check(!bgSrc3.includes('reasoning_content'), '响应不再解析推理字段');

  const defSrc = await readFile(path.join(root, 'src/shared/messages.js'), 'utf8');
  check(!/\bthinking:\s*(true|false)/.test(defSrc), '默认设置里没有 thinking 字段');
}

// ---------- 9. 主题系统 ----------
console.log('\n[7b] 主题与个性化');
{
  const panelSrc3 = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');
  check(panelSrc3.includes('applyTheme'), '面板有主题应用函数');
  check(panelSrc3.includes('--accent'), '主题会写入 CSS 变量');
  check(panelSrc3.includes('rgbToHsl'), '从主题色推导派生色');
  check(panelSrc3.includes('isLightColor'), '按主题色明暗决定按钮文字颜色');
  check(panelSrc3.includes('prefers-color-scheme'), '支持跟随系统深浅');
  check(panelSrc3.includes('themeDraft'), '设置弹窗里改动即时预览');
  check(panelSrc3.includes('panel/theme'), '换肤后广播给悬浮窗');

  const cssSrc = await readFile(path.join(root, 'src/panel/panel.css'), 'utf8');
  check(cssSrc.includes("data-glass='tint'"), 'CSS 支持半透明档');
  check(cssSrc.includes("data-glass='off'"), 'CSS 支持不透明档');
  // 液态玻璃已按要求移除
  check(!cssSrc.includes("data-glass='blur'"), '已移除液态玻璃档');
  check(!cssSrc.includes('backdrop-filter'), '已移除 backdrop-filter（不再模糊背后网页）');
  check(cssSrc.includes("data-density"), 'CSS 支持密度切换');
  check(cssSrc.includes("data-motion='off'"), 'CSS 支持关闭动效');
  // 风格向 DSH 靠：克制。只保留必要的反馈动效，不做装饰性大动画
  check(/@keyframes\s+rise/.test(cssSrc), '有消息淡入动效');
  check(/@keyframes\s+breathe/.test(cssSrc), '有状态点呼吸动效');
  check(!/@keyframes\s+drift/.test(cssSrc), '已移除背景漂移动效（改为克制风格）');
  check(!/@keyframes\s+sweep/.test(cssSrc), '已移除高光扫过动效（改为克制风格）');
  check(cssSrc.includes('prefers-reduced-motion'), '尊重系统的减少动效偏好');
  // 灰阶：深色与浅色的背景都应是零彩度（oklch 的 C 分量为 0）
  const oklchNeutral = /--bg:\s*oklch\([\d.]+%\s+0\s+0\)/g;
  check((cssSrc.match(oklchNeutral) || []).length >= 2, '两套配色的主背景都是中性灰（对齐 DSH）');

  const defSrc2 = await readFile(path.join(root, 'src/shared/messages.js'), 'utf8');
  check(defSrc2.includes('ACCENT_PRESETS'), '提供预设色板');
  check(defSrc2.includes('GLASS_MODES'), '提供玻璃模式选项');

  const floatSrc = await readFile(path.join(root, 'src/content/floating.js'), 'utf8');
  check(floatSrc.includes('cs/float-theme'), '悬浮窗接收主题推送');
  check(floatSrc.includes('--accent'), '悬浮窗跟随主题色');
  check(floatSrc.includes('data-glass'), '悬浮窗跟随玻璃模式');
}

// ---------- 10. 记忆注入 ----------
console.log('\n[8] 记忆库接入');
{
  const agentSrc3 = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');
  check(agentSrc3.includes('panel/memory-context'), '运行时读取记忆注入上下文');
  check(agentSrc3.includes('【长期记忆】'), '注入时带明确标记');
  check(agentSrc3.includes("name: 'remember'"), '提供 remember 工具让模型主动记忆');
  check(agentSrc3.includes('MEM_ADD'), 'remember 落到记忆库');

  const bgSrc2 = await readFile(path.join(root, 'src/background.js'), 'utf8');
  check(bgSrc2.includes('distillMemory'), '任务结束后自动提炼记忆');
  check(bgSrc2.includes('memoryEnabled'), '记忆库可被设置关闭');
}

// ---------- 10. 悬浮窗 ----------
console.log('\n[8b] 页面悬浮窗');
{
  const floatSrc = await readFile(path.join(root, 'src/content/floating.js'), 'utf8');
  check(floatSrc.includes('attachShadow'), '悬浮窗用 Shadow DOM 隔离样式');
  check(floatSrc.includes('__AI_AGENT_FLOAT_LOADED__'), '悬浮窗防止重复挂载');
  check(floatSrc.includes("window.top !== window.self"), '不在 iframe 里显示悬浮窗');
  check(floatSrc.includes('floatingEnabled'), '悬浮窗可被设置关闭');
  check(floatSrc.includes("send('float/undo')") || floatSrc.includes("'float/undo'"), '悬浮窗能一键撤销页面改动');
  check(floatSrc.includes('MutationObserver'), '页面被 SPA 重绘后能补回悬浮窗');

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const csFiles = manifest.content_scripts?.[0]?.js || [];
  check(csFiles.includes('src/content/content.js'), 'manifest 注入了 content.js');
  check(csFiles.includes('src/content/floating.js'), 'manifest 注入了 floating.js');
  // 顺序很重要：content.js 必须先注册好消息处理器
  check(csFiles.indexOf('src/content/content.js') < csFiles.indexOf('src/content/floating.js'),
    'content.js 在 floating.js 之前注入');
}

// ---------- 11. 鼠标控制 ----------
console.log('\n[9] 鼠标控制');
{
  const contentSrc2 = await readFile(path.join(root, 'src/content/content.js'), 'utf8');
  const agentSrc4 = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');

  for (const t of ['click_at', 'hover', 'move_mouse']) {
    check(contentSrc2.includes(`'${t}'`), `content 实现 ${t}`);
    check(agentSrc4.includes(`case '${t}'`), `agent 映射 ${t}`);
    check(agentSrc4.includes(`name: '${t}'`), `agent 定义工具 ${t}`);
  }
  check(contentSrc2.includes('function moveMouseTo'), '有鼠标移动轨迹模拟');
  check(contentSrc2.includes('showCursor'), '有可见光标');
  check(contentSrc2.includes('function hideCursorLater'), '光标会在一段时间后消失');
  check(contentSrc2.includes('elementFromPoint'), 'click_at 用命中测试找目标');
  check(contentSrc2.includes('viewport'), 'snapshot 返回视口尺寸');

  // 事件序列：取 click 动作那一段来检查顺序，避免被文件里其他部分干扰
  const clickBlock = contentSrc2.match(/case 'click': \{[\s\S]*?\n      \}/)?.[0] || '';
  check(Boolean(clickBlock), '能定位到 click 动作的实现');
  if (clickBlock) {
    const seq = ['pointerover', 'mousedown', 'pointerup', 'el.click()'];
    let last = -1;
    let ordered = true;
    for (const t of seq) {
      const at = clickBlock.indexOf(t);
      if (at < 0 || at < last) {
        ordered = false;
        break;
      }
      last = at;
    }
    check(ordered, 'click 内部事件顺序正确（over → down → up → click）');
    check(clickBlock.includes('moveMouseTo'), '点击前先移动鼠标过去（触发 hover）');
    check(clickBlock.includes('clickCursor'), '点击时光标有反馈动画');
  }

  // 坐标必须交给模型，否则 click_at 无从下手
  check(agentSrc4.includes('center=('), '快照元素带中心坐标供 click_at 使用');
  const compact = agentSrc4.match(/function compactSnapshot[\s\S]*?\n\}/)?.[0] || '';
  check(compact.includes('e.box'), '中心坐标由元素的 box 计算得出');
  check(compact.includes('viewport'), '把视口尺寸一并交给模型');
}

// ---------- 12. 余额与花费 ----------
console.log('\n[10] 余额与花费');
{
  const bgSrc4 = await readFile(path.join(root, 'src/background.js'), 'utf8');
  check(bgSrc4.includes('user/balance'), '查询 DeepSeek 官方余额接口');
  check(bgSrc4.includes('balanceCache'), '余额结果有缓存（避免频繁请求）');
  check(/replace\(\/\\\/v1/.test(bgSrc4) || bgSrc4.includes('/v1'), '正确处理 /v1 前缀');

  const usageSrc = await readFile(path.join(root, 'src/shared/usage.js'), 'utf8');
  check(usageSrc.includes('costOf'), '提供 token → 金额换算');
  check(usageSrc.includes('todayCost'), '提供今日花费统计');
  check(usageSrc.includes('startOfToday'), '按本地时区算今天零点');
  check(usageSrc.includes('normalizeBalance'), '解析官方余额响应');
  check(usageSrc.includes('balanceView'), '统一官方/预算两种余额来源');
  check(usageSrc.includes('supportsBalanceQuery'), '按服务商判断是否支持余额查询');

  const defSrc3 = await readFile(path.join(root, 'src/shared/messages.js'), 'utf8');
  check(defSrc3.includes('BALANCE_GET'), '定义余额消息');
  check(defSrc3.includes('prices'), '默认设置含计费单价');
  check(defSrc3.includes('budget'), '默认设置含手动预算');

  const panelHtml = await readFile(path.join(root, 'src/panel/panel.html'), 'utf8');
  check(panelHtml.includes('uBalance'), '界面有余额显示位');
  check(panelHtml.includes('uToday'), '界面有今日花费显示位');
  check(panelHtml.includes('uPriceIn'), '界面可填输入单价');
  check(panelHtml.includes('sBudget'), '设置里可填手动预算');
}

// ---------- 13. 停止按钮 ----------
console.log('\n[11] 停止按钮');
{
  const agentSrc5 = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');
  const panelSrc4 = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');
  const bgSrc5 = await readFile(path.join(root, 'src/background.js'), 'utf8');

  check(agentSrc5.includes('onAbortReady'), 'runAgent 把中止入口交给面板');
  check(agentSrc5.includes('abortInFlight'), '实现了在途请求中止');
  check(agentSrc5.includes('currentRequestId'), '追踪当前在途请求 id');
  check(agentSrc5.includes('__ABORTED__'), '区分「用户中止」与「超时」');
  check(panelSrc4.includes('abortCurrent'), '面板持有中止入口');
  check(panelSrc4.includes('function stopTask'), '停止逻辑抽成独立函数');
  check(/Escape/.test(panelSrc4), 'Esc 也能停止');
  check(bgSrc5.includes('function abortRequest'), '后台能按 id 中止请求');
  check(bgSrc5.includes('inFlight'), '后台维护在途请求表');
  check(bgSrc5.includes('__userAbort'), '后台标记用户主动中止');
  // 中止不当成错误处理
  check(/err\.message === '__ABORTED__'/.test(agentSrc5), '中止不弹错误提示');
  // 请求参数里必须带 requestId，否则后台无从对应
  // 工具分组后 payload 用的是 activeTools（按任务预筛后的子集）
  check(/tools: activeTools/.test(agentSrc5), '请求使用按任务预筛的工具子集');
  check(/requestId \}/.test(agentSrc5), '请求带上 requestId');
}

// ---------- 14. Base URL 归一化 ----------
console.log('\n[12] Base URL 归一化');
{
  const bgSrc6 = await readFile(path.join(root, 'src/background.js'), 'utf8');
  check(bgSrc6.includes('export function normalizeBaseUrl'), '导出归一化函数');
  check(bgSrc6.includes('export function endpointFor'), '导出端点拼接函数');
  check(bgSrc6.includes('/chat/completions'), '能拼出对话端点');
  check(bgSrc6.includes('user/balance'), '能拼出余额端点');
  check(bgSrc6.includes("kind === 'models'"), '能拼出模型列表端点');
  // 余额端点不能带 /v1，其余要带
  check(/replace\(\/\\\/\(v\\d\+\[a-z\]\*\)\$\/i, ''\)/.test(bgSrc6) || bgSrc6.includes("kind === 'balance'"),
    '余额端点会去掉版本段');

  // 行为验证：真正跑一遍归一化逻辑
  const fnSrc = bgSrc6.match(/export function normalizeBaseUrl[\s\S]*?\n\}/)[0].replace('export ', '');
  const epSrc = bgSrc6.match(/export function endpointFor[\s\S]*?\n\}/)[0].replace('export ', '');
  const { normalizeBaseUrl, endpointFor } = new Function(
    `${fnSrc}\n${epSrc}\nreturn { normalizeBaseUrl, endpointFor };`,
  )();

  const cases = [
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/v1'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1'],
    ['  https://api.deepseek.com/v1  ', 'https://api.deepseek.com/v1'],
    ['https://api.openai.com', 'https://api.openai.com/v1'],
    ['http://localhost:11434', 'http://localhost:11434/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1'],
    ['', 'https://api.deepseek.com/v1'],
  ];
  let allOk = true;
  const bad = [];
  for (const [input, want] of cases) {
    const got = normalizeBaseUrl(input);
    if (got !== want) {
      allOk = false;
      bad.push(`${JSON.stringify(input)} → ${got}（期望 ${want}）`);
    }
  }
  check(allOk, `11 种写法都能正确归一化${bad.length ? `\n       ${bad.join('\n       ')}` : ''}`);

  check(endpointFor('https://api.deepseek.com', 'chat') === 'https://api.deepseek.com/v1/chat/completions',
    'chat 端点正确');
  check(endpointFor('https://api.deepseek.com/v1', 'models') === 'https://api.deepseek.com/v1/models',
    'models 端点正确');
  check(endpointFor('https://api.deepseek.com/v1', 'balance') === 'https://api.deepseek.com/user/balance',
    'balance 端点正确（不带 /v1）');
}

// ---------- 15. 模型列表与真实输入模式 ----------
console.log('\n[13] 模型列表与 CDP');
{
  const bgSrc7 = await readFile(path.join(root, 'src/background.js'), 'utf8');
  check(bgSrc7.includes('async function fetchModels'), '实现模型列表拉取');
  check(bgSrc7.includes('modelsCache'), '模型列表有缓存');
  check(/data\?\.data[\s\S]{0,80}data\?\.models/.test(bgSrc7), '兼容两种返回结构');
  check(bgSrc7.includes('Array.isArray'), '对非数组返回做防御');

  check(bgSrc7.includes('chrome.debugger.attach'), 'CDP 模式会附加调试器');
  check(bgSrc7.includes('Input.dispatchMouseEvent'), '用 CDP 派发鼠标事件');
  check(bgSrc7.includes('Input.dispatchKeyEvent'), '用 CDP 派发键盘事件');
  check(bgSrc7.includes('shouldUseCdp'), '有开关判断');
  check(bgSrc7.includes('cdpFallback'), 'CDP 失败时回退到合成事件');

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  // debugger 必须是可选权限：装扩展时不该吓到用户
  check(manifest.optional_permissions?.includes('debugger'), 'debugger 是可选权限（安装时不强制）');
  check(!manifest.permissions?.includes('debugger'), 'debugger 不在必选权限里');

  const defSrc4 = await readFile(path.join(root, 'src/shared/messages.js'), 'utf8');
  check(/cdpEnabled:\s*false/.test(defSrc4), 'CDP 默认关闭');

  const panelHtml2 = await readFile(path.join(root, 'src/panel/panel.html'), 'utf8');
  check(panelHtml2.includes('btnFetchModels'), '界面有获取模型列表按钮');
  check(panelHtml2.includes('datalist'), '用 datalist 提供模型下拉候选');
  check(panelHtml2.includes('btnCdpEnable'), '界面有真实输入模式启用按钮');

  const panelSrc5 = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');
  check(panelSrc5.includes('permissions.request'), '开启 CDP 时申请权限');
  check(panelSrc5.includes("permissions: ['debugger']"), '申请的正是 debugger 权限');
  check(panelSrc5.includes('permissions.contains'), '申请前先检查是否已授予');
  check(panelSrc5.includes("el.btnCdpEnable?.addEventListener('click'"), '用按钮 click 触发放权限（可靠手势）');
}

// ---------- 16. 省步骤 ----------
console.log('\n[14] 步骤效率');
{
  const agentSrc6 = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');
  check(agentSrc6.includes('省步骤'), '系统提示里有专门的省步骤章节');
  check(/只读任务不要 snapshot/.test(agentSrc6), '明确说纯阅读任务不必 snapshot');
  check(/能一次做完就别分两次/.test(agentSrc6), '鼓励一轮返回多个工具调用');
  check(/不要重复读取/.test(agentSrc6), '禁止重复读同一页');
  check(/别做用户没要求的事/.test(agentSrc6), '禁止多余动作');
  check(/明显做不到就直说/.test(agentSrc6), '做不到时尽早收尾而不是耗步数');
  // 工具描述也要一致，否则模型会照旧先 snapshot
  check(/只在需要点击或输入时才调用/.test(agentSrc6), 'snapshot 描述已改为按需调用');
  check(/不需要先 snapshot/.test(agentSrc6), 'read_page 描述说明无需先 snapshot');
}

// ---------- 8. background ----------
console.log('\n[7] background 安全性');
const bgSrc = await readFile(path.join(root, 'src/background.js'), 'utf8');
assert(bgSrc.includes('assertInjectable'), 'background 有页面可操作性守卫');
assert(/throw new Error\('浏览器内置页面不允许操作/.test(bgSrc), 'background 拒绝操作浏览器内置页');
assert(/throw new Error\('扩展商店页面不允许操作/.test(bgSrc), 'background 拒绝操作扩展商店页');

// 用真实守卫函数做行为测试，而不是匹配字符串
const guardSrc = bgSrc.match(/function assertInjectable[\s\S]*?\n}/);
assert(Boolean(guardSrc), '能提取到守卫函数用于行为验证');
if (guardSrc) {
  const guard = new Function(`return ${guardSrc[0]}`)();
  const guarded = [
    ['https://example.com', false],
    ['chrome://settings', true],
    ['edge://extensions', true],
    ['devtools://devtools/x', true],
    ['chrome-extension://abc/p.html', true],
    ['https://chrome.google.com/webstore/detail/x', true],
    ['https://microsoftedge.microsoft.com/addons/detail/x', true],
  ];
  let guardOk = true;
  for (const [url, shouldBlock] of guarded) {
    let blocked = false;
    try {
      guard({ id: 1, url });
    } catch {
      blocked = true;
    }
    if (blocked !== shouldBlock) {
      guardOk = false;
      console.log(`      ! ${url} 拦截=${blocked} 期望=${shouldBlock}`);
    }
  }
  assert(guardOk, `守卫行为正确（覆盖 ${guarded.length} 种 URL）`);
  let noTabBlocked = false;
  try {
    guard({});
  } catch {
    noTabBlocked = true;
  }
  assert(noTabBlocked, '没有标签页时守卫会拦截');
}
assert(bgSrc.includes('chrome.scripting.executeScript'), 'background 会自动补注入 content script');
assert(!/apiKey\s*[:=]\s*['"][^'"]+['"]/.test(bgSrc.replace(/placeholder[^\n]*/g, '')), 'background 没有硬编码密钥');
assert(bgSrc.includes('AbortController'), '网络请求带超时控制');

// ---------- 结果 ----------
console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 冒烟测试全部通过。');
