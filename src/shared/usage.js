/**
 * usage.js —— token 用量统计。
 *
 * 记录每次模型调用的 token 消耗，按"会话累计 + 历史总计 + 每次任务"三个粒度展示。
 * 数据只存本机（chrome.storage.local）。
 */

const KEY = 'usage';

/** 单次任务最多保留的历史记录条数。 */
const HISTORY_LIMIT = 100;

function emptyTotals() {
  return { prompt: 0, completion: 0, total: 0, calls: 0, reasoning: 0 };
}

/** 读取用量数据。 */
export async function getUsage() {
  const stored = await chrome.storage.local.get(KEY);
  const data = stored[KEY];
  if (!data || typeof data !== 'object') {
    return { totals: emptyTotals(), session: emptyTotals(), history: [] };
  }
  return {
    totals: { ...emptyTotals(), ...(data.totals || {}) },
    session: { ...emptyTotals(), ...(data.session || {}) },
    history: Array.isArray(data.history) ? data.history : [],
  };
}

/** 从模型返回的 usage 字段规范化出各项数字。 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  // 有些服务不返回 total_tokens，或与实际不符，这里以分项之和为准
  const total = Number(usage.total_tokens) || prompt + completion;
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
  if (!prompt && !completion && !total) return null;
  return { prompt, completion, total, reasoning, calls: 1 };
}

function accumulate(base, delta) {
  return {
    prompt: (base.prompt || 0) + (delta.prompt || 0),
    completion: (base.completion || 0) + (delta.completion || 0),
    total: (base.total || 0) + (delta.total || 0),
    reasoning: (base.reasoning || 0) + (delta.reasoning || 0),
    calls: (base.calls || 0) + (delta.calls || 0),
  };
}

/**
 * 记一次调用。
 * @param {object} usage 模型接口返回的 usage
 * @returns {object} 更新后的用量数据
 */
export async function addUsage(usage) {
  const delta = normalizeUsage(usage);
  const data = await getUsage();
  if (!delta) return data;

  data.totals = accumulate(data.totals, delta);
  data.session = accumulate(data.session, delta);
  await chrome.storage.local.set({ [KEY]: data });
  return data;
}

/** 记一次完整任务（用于历史列表）。 */
export async function addTaskRecord({ task, model, usage, steps, ok }) {
  const delta = normalizeUsage(usage);
  const data = await getUsage();

  const record = {
    id: `t${Date.now().toString(36)}`,
    at: Date.now(),
    task: String(task || '').slice(0, 120),
    model: model || '',
    steps: steps || 0,
    ok: ok !== false,
    tokens: delta ? delta.total : 0,
    prompt: delta ? delta.prompt : 0,
    completion: delta ? delta.completion : 0,
  };

  data.history = [record, ...(data.history || [])].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [KEY]: data });
  return record;
}

/** 只重置会话计数（历史总计保留）。 */
export async function resetSession() {
  const data = await getUsage();
  data.session = emptyTotals();
  await chrome.storage.local.set({ [KEY]: data });
  return data;
}

/** 全部清零。 */
export async function resetAll() {
  const data = { totals: emptyTotals(), session: emptyTotals(), history: [] };
  await chrome.storage.local.set({ [KEY]: data });
  return data;
}

/** 粗略估算一次请求的 token（上限兜底，接口没返回 usage 时用）。 */
export function estimateTokens(text) {
  const s = String(text || '');
  // 中文约 1 字 1 token，英文约 4 字符 1 token，取折中
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk + other / 3.5);
}

/* ============================================================
   费用估算
   ------------------------------------------------------------
   单价由用户填写（不同服务商、不同模型差异很大，且会调整，
   写死会很快过时）。默认给出 DeepSeek 的常见档位。
   ============================================================ */

export const DEFAULT_PRICES = { input: 2, output: 8 }; // 元 / 百万 token

/** 把 token 数换算成金额（元）。 */
export function costOf({ prompt = 0, completion = 0 }, prices = DEFAULT_PRICES) {
  const inRate = Number(prices?.input) || 0;
  const outRate = Number(prices?.output) || 0;
  return (prompt / 1_000_000) * inRate + (completion / 1_000_000) * outRate;
}

/** 今天零点的时间戳（本地时区）。 */
export function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 按天聚合花费。为了支持"今日花费"，每条任务记录都带日期。
 * @returns {Array<{day: string, cost: number, tokens: number, calls: number}>}
 */
export function groupByDay(history, prices = DEFAULT_PRICES) {
  const map = new Map();
  for (const r of history || []) {
    const d = new Date(r.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = map.get(key) || { day: key, cost: 0, tokens: 0, calls: 0 };
    cur.cost += costOf({ prompt: r.prompt, completion: r.completion }, prices);
    cur.tokens += r.tokens || 0;
    cur.calls += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** 今日花费（元）。 */
export function todayCost(history, prices = DEFAULT_PRICES, now = Date.now()) {
  const start = startOfToday(now);
  let cost = 0;
  let tokens = 0;
  let calls = 0;
  for (const r of history || []) {
    if ((r.at || 0) < start) continue;
    cost += costOf({ prompt: r.prompt, completion: r.completion }, prices);
    tokens += r.tokens || 0;
    calls += 1;
  }
  return { cost, tokens, calls };
}

/* ============================================================
   余额
   ------------------------------------------------------------
   两条路：
   1) 官方接口 —— DeepSeek 提供 GET /user/balance，能读到真实余额。
   2) 手动预算 —— 其他服务商没有统一接口，用户填一个总额，
      用「预算 − 累计消耗」估算剩余。
   ============================================================ */

/** 是否是该服务商支持余额查询的地址。 */
export function supportsBalanceQuery(baseUrl) {
  const b = String(baseUrl || '').toLowerCase();
  return b.includes('deepseek.com') || b.includes('deepseek.ai');
}

/**
 * 规范化余额接口返回。
 * DeepSeek: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 */
export function normalizeBalance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const infos = Array.isArray(raw.balance_infos) ? raw.balance_infos : [];
  if (!infos.length) return null;
  // 优先人民币，其次第一条
  const pick = infos.find((i) => String(i.currency).toUpperCase() === 'CNY') || infos[0];
  const total = Number(pick.total_balance);
  if (!Number.isFinite(total)) return null;
  return {
    available: raw.is_available !== false,
    currency: String(pick.currency || 'CNY').toUpperCase(),
    total,
    granted: Number(pick.granted_balance) || 0,
    toppedUp: Number(pick.topped_up_balance) || 0,
  };
}

/** 货币符号。 */
export function currencySymbol(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'CNY') return '¥';
  if (c === 'USD') return '$';
  return `${c} `;
}

/**
 * 统一的余额视图。
 * @param {object} opts
 * @param {object|null} opts.official 官方接口返回（已 normalize）
 * @param {number|null} opts.budget 手动预算
 * @param {number} opts.spent 累计消耗（元）
 * @param {number} opts.today 今日消耗（元）
 */
export function balanceView({ official, budget, spent = 0, today = 0 }) {
  if (official) {
    return {
      source: 'official',
      label: 'DeepSeek 实时余额',
      total: official.total,
      currency: official.currency,
      symbol: currencySymbol(official.currency),
      detail: [official.granted > 0 ? `赠送 ${official.granted.toFixed(2)}` : '', official.toppedUp > 0 ? `充值 ${official.toppedUp.toFixed(2)}` : '']
        .filter(Boolean)
        .join(' · '),
      available: official.available,
      spent,
      today,
    };
  }
  if (Number.isFinite(budget) && budget > 0) {
    const remain = Math.max(0, budget - spent);
    return {
      source: 'budget',
      label: '按预算估算',
      total: remain,
      currency: 'CNY',
      symbol: '¥',
      detail: `预算 ${budget.toFixed(2)} · 已用 ${spent.toFixed(2)}`,
      available: remain > 0,
      spent,
      today,
    };
  }
  return {
    source: 'none',
    label: '未配置',
    total: null,
    currency: 'CNY',
    symbol: '¥',
    detail: '在设置里填手动预算，或使用 DeepSeek 自动读取',
    available: null,
    spent,
    today,
  };
}
