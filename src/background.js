/**
 * background.js —— MV3 service worker。
 * 把"标签页操作"和"网络请求"这两件面板做不了的事集中在这里，
 * 同时充当 侧边栏 ↔ 页面悬浮窗 之间的中转站。
 */

import { MSG, DEFAULT_SETTINGS } from './shared/messages.js';
import { addUsage, getUsage, resetAll, resetSession, addTaskRecord } from './shared/usage.js';
import { supportsBalanceQuery, normalizeBalance } from './shared/usage.js';
import {
  listConversations,
  getConversation,
  createConversation,
  saveConversation,
  renameConversation,
  deleteConversation,
  clearConversations,
  conversationStats,
  lastConversationId,
} from './shared/conversations.js';
import {
  listSkills,
  addSkill,
  addManySkills,
  updateSkill,
  deleteSkill,
  clearSkills,
  skillStats,
  selectSkills,
  renderSkills,
} from './shared/skills.js';
import {
  listRules,
  addRule,
  addManyRules,
  updateRule,
  deleteRule,
  clearRules,
  ruleStats,
  selectRules,
  renderRules,
} from './shared/evolution.js';
import {
  listMemories,
  addMemory,
  addMany,
  updateMemory,
  deleteMemory,
  clearMemories,
  memoryStats,
  selectForContext,
  renderForPrompt,
} from './shared/memory.js';

// ---------- 侧边栏：点击图标即打开 ----------
function enableActionClick() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enableActionClick);
chrome.runtime.onStartup?.addListener(enableActionClick);

// ---------- 设置读写 ----------
async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// ---------- 与 content script 通信 ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/** 确保目标页有注入好的 content script；没有就补注入（应对安装前已打开的页面）。 */
async function ensureContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_PING });
    if (res?.ok) return true;
  } catch {
    /* 未注入，继续往下补 */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js', 'src/content/floating.js'],
    });
    return true;
  } catch {
    return false;
  }
}

function assertInjectable(tab) {
  if (!tab?.id) throw new Error('没有可操作的标签页');
  const url = tab.url || '';
  if (/^(chrome|edge|about|devtools|chrome-extension|extension):/i.test(url)) {
    throw new Error('浏览器内置页面不允许操作，请切换到普通网页');
  }
  if (/^https:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i.test(url)) {
    throw new Error('扩展商店页面不允许操作');
  }
}

async function withContent(message, { requireTab = true } = {}) {
  const tab = await activeTab();
  if (requireTab) assertInjectable(tab);
  const ready = await ensureContent(tab.id);
  if (!ready) throw new Error('无法连接页面脚本，请刷新页面后重试');
  const res = await chrome.tabs.sendMessage(tab.id, message);
  if (!res) throw new Error('页面没有响应');
  if (res.ok === false) throw new Error(res.error || '页面操作失败');
  return res;
}

/** 向当前标签页的悬浮窗推送状态（失败静默——很多页面没有悬浮窗）。 */
async function pushFloatState(tabId, state) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.CS_FLOAT, state });
  } catch {
    /* 忽略 */
  }
}

// ---------- 接口地址归一化 ----------
/**
 * 把用户填的 Base URL 补全成可用的接口地址。
 *
 * 为什么要带 /v1：这是 OpenAI 定下的约定，绝大多数服务商都遵循
 * （DeepSeek / OpenAI / 通义 / Kimi / Ollama...），所以 /v1 是默认值。
 * 但用户不该被迫记住这件事 —— 这里两种写法都接受：
 *   https://api.deepseek.com              → .../chat/completions
 *   https://api.deepseek.com/v1           → .../v1/chat/completions
 *   https://api.deepseek.com/v1/          → 同上（去掉多余斜杠）
 *   https://xxx/compatible-mode/v1        → 保持原样（已含路径）
 */
export function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\s+/g, '');
  if (!u) return 'https://api.deepseek.com/v1';
  // 用户可能把完整端点粘进来了，去掉尾部的 /chat/completions
  u = u.replace(/\/chat\/completions\/?$/i, '');
  u = u.replace(/\/+$/, '');

  // 已经带版本段（/v1 /v2 /v1beta ...）或明显是带路径的兼容端点，原样保留
  if (/\/(v\d+[a-z]*|compatible-mode\/v\d+|api\/v\d+)$/i.test(u)) return u;
  if (/\/v\d+[a-z]*\//i.test(u)) return u.replace(/\/+$/, '');

  // 裸域名或路径末尾没有版本号：补 /v1
  return `${u}/v1`;
}

/**
 * 拼出具体端点。
 * kind: 'chat' | 'models' | 'balance'
 * balance 是 DeepSeek 特有且不带 /v1，其余都在 /v1 下。
 */
export function endpointFor(baseUrl, kind) {
  const base = normalizeBaseUrl(baseUrl);
  if (kind === 'balance') {
    // 余额接口挂在 API 根路径，要去掉版本段
    return `${base.replace(/\/(v\d+[a-z]*)$/i, '')}/user/balance`;
  }
  if (kind === 'models') return `${base}/models`;
  return `${base}/chat/completions`;
}

// ---------- 网络代理 ----------
// 面板页受扩展 CSP 限制，跨域 fetch 放在 service worker 里做最稳妥。
//
// 中止机制：面板点「停止」时发 agent/abort，这里把对应请求的
// AbortController abort 掉 —— 否则用户点了停止，界面还要干等模型
// 请求返回（可能 30~180 秒）才真正停下来。
const inFlight = new Map(); // requestId -> AbortController

function abortRequest(requestId) {
  const c = inFlight.get(requestId);
  if (!c) return false;
  c.__userAbort = true; // 与"超时"区分开
  c.abort();
  inFlight.delete(requestId);
  return true;
}

async function chatCompletion({ messages, tools, toolChoice, requestId }) {
  const s = await getSettings();
  if (!s.apiKey) throw new Error('还没有配置 API Key，请点击右上角 ⚙ 设置');
  const url = endpointFor(s.baseUrl, 'chat');

  const body = {
    model: s.model,
    temperature: typeof s.temperature === 'number' ? s.temperature : 0.2,
    messages,
    ...(tools ? { tools, tool_choice: toolChoice || 'auto' } : {}),
  };

  const controller = new AbortController();
  if (requestId) inFlight.set(requestId, controller);
  const timer = setTimeout(() => controller.abort(), 180000);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    inFlight.delete(requestId);
    if (err?.name === 'AbortError') {
      // 区分"用户主动停止"与"超时"
      throw new Error(controller.__userAbort ? '__ABORTED__' : '请求超时（180s）');
    }
    throw new Error(`网络请求失败：${err?.message || err}`);
  }
  clearTimeout(timer);
  inFlight.delete(requestId);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let hint = '';
    if (resp.status === 401) hint = '（API Key 无效或已过期）';
    else if (resp.status === 404) hint = '（模型名或 Base URL 不对）';
    else if (resp.status === 429) hint = '（请求过于频繁或余额不足）';
    else if (resp.status === 400) hint = '（请求被拒绝，请检查模型名与参数）';
    throw new Error(`接口返回 ${resp.status}${hint}：${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`接口返回格式异常：${JSON.stringify(data).slice(0, 300)}`);

  const message = choice.message || {};

  // 记用量（失败不影响主流程）
  let usageInfo = null;
  try {
    const updated = await addUsage(data.usage);
    usageInfo = { delta: data.usage || null, totals: updated.totals, session: updated.session };
  } catch {
    /* 忽略 */
  }

  return {
    content: message.content || '',
    toolCalls: message.tool_calls || [],
    usage: data.usage || null,
    usageInfo,
    finishReason: choice.finish_reason,
  };
}

// ---------- 模型列表 ----------
/**
 * 拉取可用模型列表（GET /models，OpenAI 兼容接口通用）。
 * 用于设置里的"自动获取"按钮，省得用户手打模型名。
 */
let modelsCache = { at: 0, data: null, key: '' };

async function fetchModels({ force = false } = {}) {
  const s = await getSettings();
  if (!s.apiKey) throw new Error('请先填写 API Key');
  const url = endpointFor(s.baseUrl, 'models');

  const cacheKey = `${s.baseUrl}|${s.apiKey.slice(-6)}`;
  const now = Date.now();
  if (!force && modelsCache.data && modelsCache.key === cacheKey && now - modelsCache.at < 300000) {
    return { models: modelsCache.data, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let resp;
  try {
    resp = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${s.apiKey}` },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new Error('获取模型列表超时（20s）');
    throw new Error(`无法连接：${err?.message || err}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const hint = resp.status === 401 ? '（API Key 无效）' : resp.status === 404 ? '（该服务商可能不支持 /models）' : '';
    throw new Error(`返回 ${resp.status}${hint}：${text.slice(0, 160)}`);
  }

  const data = await resp.json().catch(() => null);
  // 兼容两种常见结构：{data:[{id}]} 和 {models:[{name}]}
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const models = raw
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model))
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim())
    .sort((a, b) => a.localeCompare(b));

  if (!models.length) throw new Error('接口没有返回任何模型');
  modelsCache = { at: now, data: models, key: cacheKey };
  return { models, cached: false };
}


/* ============================================================
   自进化：从一次任务里提炼技能与规则
   ------------------------------------------------------------
   这是"自进化"的核心闭环：
     执行任务 → 复盘（这次做得怎么样）→ 提炼（下次该怎么做）→ 注入下次
   单独发一次小请求做复盘，不复用主循环上下文，避免污染。
   ============================================================ */

/** 把一次任务的执行摘要喂给模型，让它产出结构化的复盘结果。 */
async function distillEvolution({ task, summary, steps, url, ok }) {
  const s = await getSettings();
  if (!s.evolutionEnabled) return { added: 0, skipped: '自进化已关闭' };
  if (!s.apiKey) return { added: 0, skipped: '未配置 API Key' };
  if (!task || !summary) return { added: 0, skipped: '内容不足' };

  // 把执行过程压成简短清单，让模型能看出"哪步多余、哪步失败"
  const stepLines = (steps || [])
    .slice(0, 25)
    .map((st) => {
      const args = st.args && Object.keys(st.args).length ? JSON.stringify(st.args).slice(0, 80) : '';
      const res = st.result?.error
        ? `失败：${String(st.result.error).slice(0, 60)}`
        : '成功';
      return `- ${st.tool} ${args} → ${res}`;
    })
    .join('\n');

  const prompt = `你在复盘一次浏览器智能体的执行过程，目的是让它下次做得更好。

## 任务
${String(task).slice(0, 400)}

## 执行过程（共 ${(steps || []).length} 步）
${stepLines || '（没有调用任何工具）'}

## 最终结果
${ok ? '成功' : '未完成或出错'}
${String(summary).slice(0, 600)}

## 当前网址
${url || '（未知）'}

## 请产出两部分

### 1. skills —— 可复用的操作技能（0~2 条）
只在这类任务**以后还会遇到**、且你有明确方法时才写。
- name：技能名，4~12 字
- trigger：什么情况下适用，写清楚触发场景的关键词
- steps：2~5 步要点，每步一句话，具体可执行
- tools：会用到哪些工具名

### 2. rules —— 对自己行为的提醒（0~2 条）
从这次的过程里看出"下次该注意什么"才写，例如：
- 走了多余的步骤（本来一步能做）
- 某个工具用错了顺序
- 某种失败是因为方法不当，下次该换法

规则要**通用**（不绑定这一次的具体页面），一句话说完。

## 硬性要求
- 宁缺毋滥：这两部分都可以是空数组。没有真正值得学的就返回空。
- 不要记录密码、身份证、银行卡等敏感信息。
- 不要写"要仔细""要小心"这类空话，必须具体可执行。

只输出 JSON，不要解释，格式：
{"skills":[{"name":"...","trigger":"...","steps":["..."],"tools":["..."]}],"rules":[{"text":"...","kind":"efficiency|reliability|preference"}]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let resp;
  try {
    resp = await fetch(endpointFor(s.baseUrl, 'chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { added: 0, skipped: '复盘请求失败' };
  }
  clearTimeout(timer);
  if (!resp.ok) return { added: 0, skipped: `复盘失败 ${resp.status}` };

  let text = '';
  try {
    const data = await resp.json();
    text = data?.choices?.[0]?.message?.content || '';
    await addUsage(data.usage).catch(() => {});
  } catch {
    return { added: 0, skipped: '复盘结果解析失败' };
  }

  // 容错解析（模型可能包了 ```json）
  let parsed = null;
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
  } catch {
    return { added: 0, skipped: '复盘结果不是合法 JSON' };
  }
  if (!parsed) return { added: 0, skipped: '复盘结果为空' };

  // 技能带上站点信息（若任务是站点专属，之后只在同站命中）
  const site = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '';
  const skillsAdded = await addManySkills(
    (Array.isArray(parsed.skills) ? parsed.skills : [])
      .filter((x) => x && x.name && x.trigger && Array.isArray(x.steps) && x.steps.length)
      .map((x) => ({
        name: String(x.name).slice(0, 40),
        trigger: String(x.trigger).slice(0, 200),
        steps: x.steps.map((t) => String(t).slice(0, 200)).slice(0, 6),
        tools: Array.isArray(x.tools) ? x.tools.slice(0, 10) : [],
        // 只有明确是站点专属的才绑站点；通用技能不绑
        site: x.siteSpecific ? site : undefined,
      })),
    'auto',
  );

  const rulesAdded = await addManyRules(
    (Array.isArray(parsed.rules) ? parsed.rules : [])
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({ text: String(x.text).slice(0, 280), kind: x.kind })),
    'auto',
  );

  return { added: skillsAdded + rulesAdded, skillsAdded, rulesAdded };
}

/** 单独提炼技能（供设置界面手动触发）。 */
async function distillSkill(payload) {
  const r = await distillEvolution(payload);
  return r;
}

/** 单独提炼规则。 */
async function distillRule(payload) {
  const r = await distillEvolution(payload);
  return r;
}

// ---------- 余额查询 ----------
/**
 * 查余额。只有 DeepSeek 有公开的余额接口（GET /user/balance），
 * 其他服务商一律回退到"手动预算"模式，由面板侧计算。
 * 余额缓存 60 秒，避免频繁点击打爆接口。
 */
let balanceCache = { at: 0, data: null, key: '' };

async function fetchBalance({ force = false } = {}) {
  const s = await getSettings();
  if (!s.apiKey) throw new Error('未配置 API Key');
  if (!supportsBalanceQuery(s.baseUrl)) {
    return { supported: false, reason: '该服务商没有公开的余额接口' };
  }

  const cacheKey = `${s.baseUrl}|${s.apiKey.slice(-6)}`;
  const now = Date.now();
  if (!force && balanceCache.data && balanceCache.key === cacheKey && now - balanceCache.at < 60000) {
    return { supported: true, cached: true, balance: balanceCache.data };
  }

  // 余额接口挂在 API 根路径，不带 /v1
  const root = endpointFor(s.baseUrl, 'balance');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let resp;
  try {
    resp = await fetch(root, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${s.apiKey}` },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`余额查询失败：${err?.message || err}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`余额接口返回 ${resp.status}：${text.slice(0, 160)}`);
  }

  const raw = await resp.json().catch(() => null);
  const balance = normalizeBalance(raw);
  if (!balance) throw new Error('余额接口返回格式不认识');

  balanceCache = { at: now, data: balance, key: cacheKey };
  return { supported: true, cached: false, balance };
}

// ---------- CDP 真实输入（可选，默认关闭）----------
/**
 * 用 chrome.debugger 通过调试协议派发输入事件。
 * 与 content script 的合成事件相比，CDP 产生的事件带 isTrusted=true，
 * 因此能通过一部分会检查该字段的风控页面。
 *
 * 代价（所以默认关闭）：
 *   - 需要 debugger 权限（安装/开启时会有权限提示）
 *   - 附加调试器期间，被操作的标签页顶部会显示"正在调试此浏览器"横幅
 *   - 同一标签页同时只能有一个调试器
 */
let cdpAttached = new Set();

async function cdpEnsureAttached(tabId) {
  if (cdpAttached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  cdpAttached.add(tabId);
  // 标签页关闭或被用户取消调试时同步状态
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) cdpAttached.delete(source.tabId);
  });
}

/** 通过 CDP 发送一次鼠标点击。 */
async function cdpClick(tabId, x, y) {
  await cdpEnsureAttached(tabId);
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseMoved',
    buttons: 0,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mousePressed',
    buttons: 1,
  });
  await new Promise((r) => setTimeout(r, 60)); // 与真实点击一致的按下-抬起间隔
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseReleased',
    buttons: 0,
  });
}

/** 通过 CDP 输入文本（逐字符派发，触发 input 事件）。 */
async function cdpType(tabId, text) {
  await cdpEnsureAttached(tabId);
  for (const ch of String(text)) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: ch,
      unmodifiedText: ch,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      text: ch,
      unmodifiedText: ch,
    });
  }
}

/** 通过 CDP 发一次按键（用于回车等）。 */
async function cdpKey(tabId, key) {
  await cdpEnsureAttached(tabId);
  const map = {
    Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
    Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
    Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
  };
  const info = map[key] || map.Enter;
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', ...info });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', ...info });
}

/** 释放调试器（切换标签页或关闭功能时调用）。 */
async function cdpDetach(tabId) {
  if (!cdpAttached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* 已经断开 */
  }
  cdpAttached.delete(tabId);
}

/** 判断当前是否应该走 CDP 路径。 */
async function shouldUseCdp() {
  const s = await getSettings();
  if (!s.cdpEnabled) return false;
  // 检查权限是否已授予（optional_permissions 需要用户同意）
  try {
    return await chrome.permissions.contains({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}

// ---------- 记忆：从对话中提炼 ----------
/**
 * 让模型从一轮任务里提炼值得长期记住的内容。
 * 单独发一次小请求，不复用主循环的上下文，避免污染。
 */
async function distillMemory({ task, summary, url }) {
  const s = await getSettings();
  if (!s.apiKey) throw new Error('未配置 API Key');
  if (!s.memoryEnabled) return { added: 0, skipped: '记忆库已关闭' };
  if (!summary || !task) return { added: 0, skipped: '内容不足' };

  const prompt = `从下面这次"用户请求 + AI 完成结果"中，提炼值得长期记住的信息。

只提炼这三类，没有就返回空数组：
- preference：用户表现出的稳定偏好（回复语言、格式、禁忌、习惯）
- fact：关于用户本人或其环境的事实（职业、项目、常用工具）
- site：这个网站上的操作经验（哪个按钮管什么用、表单怎么填、有什么坑）

规则：
- 只记"下次还用得上"的，一次性的临时信息不要记（比如"今天要查天气"）。
- 每条一句话，具体、可执行、不要含糊。
- 不要记录密码、身份证、银行卡、手机号等敏感信息。
- 最多 3 条。宁缺毋滥，没有值得记的就返回 []。

用户请求：${String(task).slice(0, 500)}
完成结果：${String(summary).slice(0, 800)}
当前网址：${url || '（未知）'}

只输出 JSON，不要解释，格式：
{"items":[{"kind":"preference|fact|site","text":"..."}]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let resp;
  try {
    resp = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { added: 0, skipped: '提炼请求失败' };
  }
  clearTimeout(timer);

  if (!resp.ok) return { added: 0, skipped: `提炼失败 ${resp.status}` };

  let text = '';
  try {
    const data = await resp.json();
    text = data?.choices?.[0]?.message?.content || '';
    await addUsage(data.usage).catch(() => {});
  } catch {
    return { added: 0, skipped: '提炼结果解析失败' };
  }

  // 容错解析：模型可能包了 ```json
  let items = [];
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) items = JSON.parse(match[0]).items || [];
  } catch {
    return { added: 0, skipped: '提炼结果不是合法 JSON' };
  }

  const added = await addMany(
    items
      .filter((i) => i && typeof i.text === 'string' && i.text.trim())
      .map((i) => ({ kind: i.kind, text: i.text.trim(), url })),
    'auto',
  );
  return { added, considered: items.length };
}

/** 取要注入上下文的记忆文本。 */
async function memoryContext() {
  const s = await getSettings();
  if (!s.memoryEnabled) return { text: '', count: 0 };
  const tab = await activeTab().catch(() => null);
  const picked = await selectForContext(tab?.url || '');
  return { text: renderForPrompt(picked), count: picked.length, url: tab?.url };
}

/**
 * 取要注入上下文的"自进化"内容：命中的技能 + 积累的规则。
 * @param {string} task 当前任务描述（用于匹配技能）
 */
async function evolutionContext(task) {
  const s = await getSettings();
  if (!s.evolutionEnabled || !s.evolutionInject) {
    return { skillText: '', ruleText: '', skillCount: 0, ruleCount: 0 };
  }
  const tab = await activeTab().catch(() => null);
  const [skills, rules] = await Promise.all([
    selectSkills(task || '', tab?.url || ''),
    selectRules(),
  ]);
  return {
    skillText: renderSkills(skills),
    ruleText: renderRules(rules),
    skillCount: skills.length,
    ruleCount: rules.length,
    matched: skills.map((x) => x.name),
  };
}

// ---------- 悬浮窗 → 侧边栏 的中转 ----------
// 悬浮窗点快捷指令时，侧边栏可能还没打开；这里把请求暂存，等面板来取。
let pendingFloat = null;

async function floatTask({ prompt, label, openOnly }) {
  const tab = await activeTab();
  // 打开侧边栏（需要用户手势，悬浮窗的点击算手势，可以透传）
  try {
    if (tab?.windowId !== undefined && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    /* 打不开就让用户手动点图标 */
  }

  if (openOnly) return { ok: true, opened: true };

  pendingFloat = { prompt, label, at: Date.now() };
  // 通知侧边栏来取（侧边栏可能还没加载，取不到也没关系，它会主动轮询）
  try {
    await chrome.runtime.sendMessage({ type: 'panel/float-task', task: pendingFloat });
  } catch {
    /* 侧边栏没开 */
  }
  await pushFloatState(tab?.id, { status: 'busy', text: label ? `已发送：${label}` : '已发送' });
  return { ok: true, queued: true };
}

async function floatUndo() {
  const res = await withContent({ type: MSG.CS_PATCH_RESET });
  return { ok: true, data: res };
}

async function floatPatchStats() {
  try {
    const res = await withContent({ type: MSG.CS_PATCH });
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- 路由 ----------
const handlers = {
  // ---- 设置 ----
  [MSG.GET_SETTINGS]: () => getSettings(),
  [MSG.SET_SETTINGS]: async (msg) => {
    const current = await getSettings();
    const next = { ...current, ...(msg.settings || {}) };
    await chrome.storage.local.set({ settings: next });
    return next;
  },

  // ---- 页面 ----
  [MSG.GET_PAGE]: async () => {
    const res = await withContent({ type: MSG.CS_SNAPSHOT });
    return res.data;
  },
  [MSG.GET_PAGE_TEXT]: async () => {
    const res = await withContent({ type: MSG.CS_READ });
    return res.data;
  },
  [MSG.GET_OUTLINE]: async () => {
    const res = await withContent({ type: MSG.CS_OUTLINE });
    return res.data;
  },
  [MSG.EXEC_ACTION]: async (msg) => {
    const action = msg.action || {};

    // CDP 模式：点击与输入走调试协议，事件带 isTrusted，能过部分风控
    if (['click', 'click_at', 'type'].includes(action.type) && (await shouldUseCdp())) {
      try {
        const tab = await activeTab();
        assertInjectable(tab);

        // 需要坐标：先问页面要元素位置
        let x = action.x;
        let y = action.y;
        if (x === undefined || y === undefined) {
          const pos = await chrome.tabs.sendMessage(tab.id, {
            type: MSG.CS_ACT,
            action: { type: 'move_mouse', resolveOnly: true, id: action.id },
          });
          if (pos?.at) {
            [x, y] = pos.at;
          } else if (pos?.ok === false) {
            throw new Error(pos.error || '无法定位元素');
          }
        }

        if (action.type === 'type') {
          // 先把焦点放到目标上，再逐字符输入
          if (x !== undefined && y !== undefined) await cdpClick(tab.id, x, y);
          await cdpType(tab.id, action.value || '');
          if (action.enter) await cdpKey(tab.id, 'Enter');
        } else {
          if (x === undefined || y === undefined) throw new Error('缺少坐标');
          await cdpClick(tab.id, x, y);
        }

        // 改造类动作后的计数刷新仍然照常
        return { ok: true, via: 'cdp', at: [Math.round(x), Math.round(y)] };
      } catch (err) {
        // CDP 失败就退回合成事件，保证功能不中断
        const res = await withContent({ type: MSG.CS_ACT, action });
        return { ...res, cdpFallback: String(err?.message || err) };
      }
    }

    const res = await withContent({ type: MSG.CS_ACT, action });
    // 改造类动作后刷新悬浮窗上的计数
    if (action.type && ['set_text', 'hide', 'show', 'set_style', 'add_style', 'remove', 'inject_js'].includes(action.type)) {
      const stats = await floatPatchStats();
      if (stats.ok) {
        const tab = await activeTab();
        await pushFloatState(tab?.id, { patchCount: stats.data?.count || 0 });
      }
    }
    return res;
  },
  [MSG.PAGE_PATCH]: () => floatPatchStats(),
  [MSG.PAGE_RESET]: () => floatUndo(),

  // ---- 模型 ----
  [MSG.RUN_STEP]: async (msg) => chatCompletion(msg.payload || {}),
  [MSG.ABORT]: (msg) => ({ aborted: abortRequest(msg.requestId) }),
  [MSG.MODELS_GET]: async (msg) => {
    try {
      return await fetchModels({ force: Boolean(msg.force) });
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  },

  // ---- 记忆 ----
  [MSG.MEM_LIST]: async () => ({ items: await listMemories(), stats: await memoryStats() }),
  [MSG.MEM_ADD]: async (msg) => addMemory(msg.item || {}),
  [MSG.MEM_UPDATE]: async (msg) => updateMemory(msg.id, msg.patch || {}),
  [MSG.MEM_DELETE]: async (msg) => deleteMemory(msg.id),
  [MSG.MEM_CLEAR]: async (msg) => clearMemories(msg.kind),
  [MSG.MEM_DISTILL]: async (msg) => distillMemory(msg.payload || {}),

  // ---- 用量 ----
  [MSG.USAGE_GET]: () => getUsage(),
  [MSG.USAGE_ADD]: async (msg) => addUsage(msg.usage),
  [MSG.USAGE_RESET]: async (msg) => {
    const data = msg.scope === 'session' ? await resetSession() : await resetAll();
    return data;
  },

  // ---- 技能库（自进化） ----
  [MSG.SKILL_LIST]: async () => ({ items: await listSkills(), stats: await skillStats() }),
  [MSG.SKILL_ADD]: async (msg) => addSkill(msg.skill || {}),
  [MSG.SKILL_UPDATE]: async (msg) => updateSkill(msg.id, msg.patch || {}),
  [MSG.SKILL_DELETE]: async (msg) => deleteSkill(msg.id),
  [MSG.SKILL_CLEAR]: async (msg) => clearSkills(Boolean(msg.onlyAuto)),
  [MSG.SKILL_DISTILL]: async (msg) => distillSkill(msg.payload || {}),

  // ---- 规则库（自进化） ----
  [MSG.RULE_LIST]: async () => ({ items: await listRules(), stats: await ruleStats() }),
  [MSG.RULE_ADD]: async (msg) => addRule(msg.rule || {}),
  [MSG.RULE_UPDATE]: async (msg) => updateRule(msg.id, msg.patch || {}),
  [MSG.RULE_DELETE]: async (msg) => deleteRule(msg.id),
  [MSG.RULE_CLEAR]: async (msg) => clearRules(Boolean(msg.onlyAuto)),
  [MSG.RULE_DISTILL]: async (msg) => distillRule(msg.payload || {}),

  // ---- 自定义图标 ----
  [MSG.ICON_APPLY]: async (msg) => {
    const images = msg.images || {};
    const toImageData = (o) =>
      o ? new ImageData(new Uint8ClampedArray(o.data), o.width, o.height) : null;
    const detail = {};
    if (images[16]) detail.imageData = toImageData(images[16]);
    if (images[32]) detail.imageData = toImageData(images[32]);
    if (!detail.imageData) throw new Error('没有收到图标数据');
    await chrome.action.setIcon(detail);
    return { ok: true };
  },
  [MSG.ICON_RESET]: async () => {
    // 恢复 manifest 里声明的图标
    await chrome.action.setIcon({
      path: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    });
    return { ok: true };
  },

  // ---- 标签页 ----
  [MSG.OPEN_TAB]: async (msg) => {
    const tab = await chrome.tabs.create({
      url: msg.url && msg.url !== 'about:blank' ? msg.url : undefined,
      active: msg.focus !== false,
    });
    // 给页面一点加载时间，这样后续操作能立刻接上
    if (msg.focus !== false && msg.url && msg.url !== 'about:blank') {
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok: true, tabId: tab.id, url: tab.pendingUrl || tab.url, focused: msg.focus !== false };
  },

  // ---- 对话历史 ----
  [MSG.CONV_LIST]: async () => ({ items: await listConversations(), stats: await conversationStats() }),
  [MSG.CONV_CREATE]: () => createConversation(),
  [MSG.CONV_GET]: async (msg) => getConversation(msg.id),
  [MSG.CONV_SAVE]: async (msg) => saveConversation(msg.id, msg.messages),
  [MSG.CONV_RENAME]: async (msg) => renameConversation(msg.id, msg.title),
  [MSG.CONV_DELETE]: async (msg) => deleteConversation(msg.id),
  [MSG.CONV_CLEAR]: () => clearConversations(),

  // ---- 真实输入模式 ----
  [MSG.CDP_DETACH]: async () => {
    const tab = await activeTab().catch(() => null);
    if (tab?.id) await cdpDetach(tab.id);
    // 全部断开（切换标签页后可能残留）
    for (const id of [...cdpAttached]) await cdpDetach(id);
    return { detached: true };
  },

  // ---- 余额 ----
  [MSG.BALANCE_GET]: async (msg) => {
    try {
      return await fetchBalance({ force: Boolean(msg.force) });
    } catch (err) {
      // 余额查不到不该打断面板，把原因带回去让界面显示
      return { supported: true, error: String(err?.message || err) };
    }
  },

  // ---- 会话记录 ----
  'usage/task-record': async (msg) => addTaskRecord(msg.record || {}),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;

  Promise.resolve(handler(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // 异步响应
});

// 悬浮窗相关消息（分开注册，逻辑与主路由不同：需要回传 tab 操作结果）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'float/task':
      floatTask(msg).then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
      );
      return true;
    case 'float/stop':
      // 由侧边栏实际中断；这里只转发信号
      chrome.runtime
        .sendMessage({ type: 'panel/float-stop' })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false, error: '侧边栏未打开，无法停止' }));
      return true;
    case 'float/undo':
      floatUndo().then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
      );
      return true;
    case 'float/patch-stats':
      floatPatchStats().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'panel/float-pending':
      // 侧边栏来取暂存的悬浮窗指令
      sendResponse({ ok: true, task: pendingFloat });
      pendingFloat = null;
      return true;
    case 'conv/last-id':
      lastConversationId().then(
        (id) => sendResponse({ ok: true, data: id }),
        () => sendResponse({ ok: true, data: null }),
      );
      return true;
    case 'evolution/context':
      evolutionContext(msg.task).then(
        (r) => sendResponse({ ok: true, data: r }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
      );
      return true;
    case 'panel/memory-context':
      memoryContext().then(
        (r) => sendResponse({ ok: true, data: r }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
      );
      return true;
    case 'panel/theme': {
      // 侧边栏换肤后广播给所有标签页的悬浮窗
      chrome.tabs
        .query({})
        .then((tabs) => {
          for (const t of tabs) {
            if (!t.id) continue;
            chrome.tabs
              .sendMessage(t.id, { type: 'cs/float-theme', theme: msg.theme })
              .catch(() => {});
          }
        })
        .catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
    default:
      return false;
  }
});
