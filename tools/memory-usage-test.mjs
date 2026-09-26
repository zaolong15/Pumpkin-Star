#!/usr/bin/env node
/**
 * memory-usage-test.mjs —— 记忆库与 token 用量的行为测试。
 *
 * 用假的 chrome.storage.local 跑真实模块，验证：
 *   - 记忆去重、分类、站点过滤、容量上限
 *   - 注入上下文的挑选与渲染
 *   - 用量累计、分项解析、会话/总计分离
 *
 * 用法：node tools/memory-usage-test.mjs
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

/* ---------------- 假 storage ---------------- */

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: store[key] };
        return { ...store };
      },
      async set(obj) {
        Object.assign(store, obj);
      },
    },
  },
};

const mod = (p) => `file:///${path.join(root, p).replace(/\\/g, '/')}`;
const mem = await import(mod('src/shared/memory.js'));
const usage = await import(mod('src/shared/usage.js'));
const { MEMORY_KINDS, MEMORY_LIMIT } = await import(mod('src/shared/messages.js'));

/* ---------------- 记忆库 ---------------- */

console.log('\n记忆库测试\n');

console.log('[1] 新增与去重');
let r = await mem.addMemory({ kind: MEMORY_KINDS.PREFERENCE, text: '回答先给结论' });
check(r.added === true, '首次添加成功');
r = await mem.addMemory({ kind: MEMORY_KINDS.PREFERENCE, text: '回答先给结论' });
check(r.added === false, '重复内容被识别为重复（未新增）');
r = await mem.addMemory({ kind: MEMORY_KINDS.PREFERENCE, text: '回答先给结论！' });
check(r.added === false, '仅标点不同也算重复');
r = await mem.addMemory({ kind: MEMORY_KINDS.FACT, text: '用户在做量化交易' });
check(r.added === true, '不同内容正常新增');

let list = await mem.listMemories();
check(list.length === 2, `当前共 ${list.length} 条记忆`);

console.log('\n[2] 站点记忆与域名提取');
await mem.addMemory({
  kind: MEMORY_KINDS.SITE,
  text: '搜索结果在 .result 里',
  url: 'https://www.example.com/search?q=x',
});
list = await mem.listMemories();
const siteItem = list.find((m) => m.kind === MEMORY_KINDS.SITE);
check(Boolean(siteItem), '站点记忆已保存');
check(siteItem.site === 'example.com', `域名已规范化（www 被去掉：${siteItem.site}）`);
check(mem.siteOf('https://a.b.cn/x') === 'a.b.cn', 'siteOf 处理普通域名');
check(mem.siteOf('not a url') === '', 'siteOf 对非法 URL 返回空');

console.log('\n[3] 上下文挑选：站点记忆按域名过滤');
let picked = await mem.selectForContext('https://example.com/other');
check(picked.some((m) => m.kind === MEMORY_KINDS.SITE), '同站访问时带上站点经验');
picked = await mem.selectForContext('https://other-site.com/');
check(!picked.some((m) => m.kind === MEMORY_KINDS.SITE), '异站访问时不带该站点经验');
check(picked.some((m) => m.kind === MEMORY_KINDS.PREFERENCE), '偏好始终带上');
check(picked.some((m) => m.kind === MEMORY_KINDS.FACT), '事实始终带上');

console.log('\n[4] 渲染成提示词');
const rendered = mem.renderForPrompt(picked);
check(rendered.includes('用户偏好'), '包含偏好分组');
check(rendered.includes('回答先给结论'), '包含偏好内容');
check(rendered.includes('已知事实'), '包含事实分组');
check(mem.renderForPrompt([]) === '', '空记忆渲染为空串');

console.log('\n[5] 新增与更新/删除');
const one = await mem.addMemory({ kind: MEMORY_KINDS.FACT, text: '临时条目' });
await mem.updateMemory(one.item.id, { text: '改过的条目' });
list = await mem.listMemories();
check(list.some((m) => m.text === '改过的条目'), '更新生效');
await mem.deleteMemory(one.item.id);
list = await mem.listMemories();
check(!list.some((m) => m.text === '改过的条目'), '删除生效');

let threw = false;
try {
  await mem.deleteMemory('不存在');
} catch {
  threw = true;
}
check(threw, '删除不存在的条目会报错');

threw = false;
try {
  await mem.addMemory({ kind: MEMORY_KINDS.FACT, text: '   ' });
} catch {
  threw = true;
}
check(threw, '空内容被拒绝');

threw = false;
try {
  await mem.addMemory({ kind: MEMORY_KINDS.FACT, text: 'x'.repeat(500) });
} catch {
  threw = true;
}
check(threw, '超长内容被拒绝');

console.log('\n[6] 非法类型回退到 fact');
const weird = await mem.addMemory({ kind: 'nonsense', text: '类型不合法的条目' });
check(weird.item.kind === MEMORY_KINDS.FACT, `非法 kind 回退为 ${weird.item.kind}`);

console.log('\n[7] 批量新增');
const added = await mem.addMany(
  [
    { kind: 'preference', text: '喜欢表格输出' },
    { kind: 'fact', text: '常用 DeepSeek' },
    { kind: 'preference', text: '喜欢表格输出' }, // 重复
    { text: '' }, // 空，应跳过
    { kind: 'site', text: '登录按钮在右上角', url: 'https://shop.test.com/x' },
  ],
  'auto',
);
check(added === 3, `批量新增 3 条有效记忆（实际 ${added}）`);

console.log('\n[8] 统计');
const stats = await mem.memoryStats();
check(stats.total > 0, `统计到 ${stats.total} 条`);
check(typeof stats.byKind.preference === 'number', '按类型统计偏好数量');
check(stats.limit === MEMORY_LIMIT, '返回容量上限');

console.log('\n[9] 容量上限：超出后自动淘汰');
for (let i = 0; i < MEMORY_LIMIT + 20; i += 1) {
  await mem.addMemory({ kind: MEMORY_KINDS.FACT, text: `压力测试条目-${i}` });
}
const after = await mem.listMemories();
check(after.length <= MEMORY_LIMIT, `条目数被限制在 ${MEMORY_LIMIT}（实际 ${after.length}）`);

console.log('\n[10] 清空');
await mem.clearMemories(MEMORY_KINDS.FACT);
let remaining = await mem.listMemories();
check(!remaining.some((m) => m.kind === MEMORY_KINDS.FACT), '按类型清空生效');
check(remaining.length > 0, '其他类型记忆保留');
await mem.clearMemories();
remaining = await mem.listMemories();
check(remaining.length === 0, '全部清空生效');

/* ---------------- 用量 ---------------- */

console.log('\n\nToken 用量测试\n');

console.log('[11] usage 解析');
check(usage.normalizeUsage(null) === null, 'null 输入返回 null');
check(usage.normalizeUsage({}) === null, '空对象返回 null');
let u = usage.normalizeUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
check(u.prompt === 100 && u.completion === 50 && u.total === 150, '标准字段解析正确');
u = usage.normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
check(u.total === 150, '缺少 total_tokens 时自动相加');
u = usage.normalizeUsage({
  prompt_tokens: 10,
  completion_tokens: 90,
  completion_tokens_details: { reasoning_tokens: 60 },
});
check(u.reasoning === 60, '解析推理 token 数');

console.log('\n[12] 累计');
await usage.resetAll();
let data = await usage.getUsage();
check(data.totals.total === 0, '初始为 0');

await usage.addUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
await usage.addUsage({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 });
data = await usage.getUsage();
check(data.totals.total === 450, `总计累计正确（${data.totals.total}）`);
check(data.session.total === 450, '会话同步累计');
check(data.totals.calls === 2, `调用次数正确（${data.totals.calls}）`);
check(data.totals.prompt === 300 && data.totals.completion === 150, '输入/输出分项累计正确');

console.log('\n[13] 会话重置不影响总计');
await usage.resetSession();
data = await usage.getUsage();
check(data.session.total === 0, '会话已清零');
check(data.totals.total === 450, '总计保留');

console.log('\n[14] 任务记录');
await usage.addTaskRecord({
  task: '总结这个页面',
  model: 'deepseek-chat',
  usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
  steps: 3,
  ok: true,
});
data = await usage.getUsage();
check(data.history.length === 1, '任务记录已写入');
check(data.history[0].tokens === 700, `记录 token 数正确（${data.history[0].tokens}）`);
check(data.history[0].task === '总结这个页面', '记录任务描述');
check(data.history[0].steps === 3, '记录步数');

await usage.addTaskRecord({ task: '第二个任务', ok: false });
data = await usage.getUsage();
check(data.history.length === 2, '多条记录');
check(data.history[0].task === '第二个任务', '新记录排在最前');

console.log('\n[15] 全部清零');
await usage.resetAll();
data = await usage.getUsage();
check(data.totals.total === 0 && data.history.length === 0, '全部清零生效');

console.log('\n[16] token 估算（接口没返回 usage 时的兜底）');
const zh = usage.estimateTokens('这是一段中文内容');
const en = usage.estimateTokens('this is a piece of english content');
check(zh > 0 && en > 0, `中文估算 ${zh}、英文估算 ${en}`);
check(zh >= 8, '中文按接近 1 字 1 token 估算');
check(usage.estimateTokens('') === 0, '空串估算为 0');

/* ---------------- 费用与余额 ---------------- */

console.log('\n\n费用与余额测试\n');

console.log('[17] 花费计算');
const prices = { input: 2, output: 8 }; // 元/百万
check(usage.costOf({ prompt: 1_000_000, completion: 0 }, prices) === 2, '100 万输入 token = 2 元');
check(usage.costOf({ prompt: 0, completion: 1_000_000 }, prices) === 8, '100 万输出 token = 8 元');
check(usage.costOf({ prompt: 500_000, completion: 500_000 }, prices) === 5, '混合计费正确');
check(usage.costOf({ prompt: 0, completion: 0 }, prices) === 0, '零 token 花费为 0');
check(usage.costOf({ prompt: 1000, completion: 0 }, {}) === 0, '单价缺失时花费为 0（不抛错）');
const tiny = usage.costOf({ prompt: 100, completion: 50 }, prices);
check(tiny > 0 && tiny < 0.01, `小额消耗能算出来（${tiny.toFixed(6)} 元）`);

console.log('\n[18] 今日花费');
await usage.resetAll();
const now = Date.now();
const yesterday = now - 26 * 3600 * 1000;
// 直接构造历史（模拟昨天的记录）
const st = await usage.getUsage();
await chrome.storage.local.set({
  usage: {
    totals: st.totals,
    session: st.session,
    history: [
      { at: now, prompt: 1_000_000, completion: 0, tokens: 1_000_000 },
      { at: now - 3600 * 1000, prompt: 0, completion: 1_000_000, tokens: 1_000_000 },
      { at: yesterday, prompt: 1_000_000, completion: 1_000_000, tokens: 2_000_000 },
    ],
  },
});
const data2 = await usage.getUsage();
const today = usage.todayCost(data2.history, prices);
check(Math.abs(today.cost - 10) < 0.001, `今日花费只统计今天（${today.cost} 元，昨日的 10 元被排除）`);
check(today.calls === 2, `今日调用 2 次（实际 ${today.calls}）`);
check(today.tokens === 2_000_000, `今日 token 2M（实际 ${today.tokens}）`);

// 边界：正好在昨天 23:59 的记录不应算进今天
const justBefore = usage.startOfToday(now) - 1;
const data3 = { history: [{ at: justBefore, prompt: 1_000_000, completion: 0 }] };
check(usage.todayCost(data3.history, prices).cost === 0, '今天零点前 1 毫秒的记录不计入今日');
const justAfter = usage.startOfToday(now);
const data4 = { history: [{ at: justAfter, prompt: 1_000_000, completion: 0 }] };
check(usage.todayCost(data4.history, prices).cost === 2, '今天零点整的记录计入今日');

console.log('\n[19] 按天聚合');
const days = usage.groupByDay(data2.history, prices);
check(days.length === 2, `聚合出 ${days.length} 天`);
check(days[0].day > days[1].day, '按日期倒序');
const totalAll = days.reduce((s, d) => s + d.cost, 0);
check(Math.abs(totalAll - 20) < 0.001, `两天合计 20 元（实际 ${totalAll}）`);

console.log('\n[20] 余额接口识别');
check(usage.supportsBalanceQuery('https://api.deepseek.com/v1'), '识别 DeepSeek 官方地址');
check(usage.supportsBalanceQuery('https://api.deepseek.com'), '识别不带 /v1 的地址');
check(!usage.supportsBalanceQuery('https://api.openai.com/v1'), 'OpenAI 不支持');
check(!usage.supportsBalanceQuery('http://localhost:11434/v1'), '本地 Ollama 不支持');
check(!usage.supportsBalanceQuery(''), '空地址不支持');

console.log('\n[21] 余额响应解析（DeepSeek 格式）');
let bal = usage.normalizeBalance({
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
});
check(bal !== null, '解析成功');
check(bal.total === 110, `总额 110（实际 ${bal.total}）`);
check(bal.granted === 10, '赠送 10');
check(bal.toppedUp === 100, '充值 100');
check(bal.currency === 'CNY', '币种 CNY');
check(bal.available === true, '账户可用');

bal = usage.normalizeBalance({
  is_available: false,
  balance_infos: [{ currency: 'USD', total_balance: '5.5' }],
});
check(bal.currency === 'USD', '识别美元');
check(bal.available === false, '识别账户不可用');

// 多币种时优先人民币
bal = usage.normalizeBalance({
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '10' },
    { currency: 'CNY', total_balance: '70' },
  ],
});
check(bal.total === 70, `多币种优先取人民币（${bal.total}）`);

check(usage.normalizeBalance(null) === null, 'null 返回 null');
check(usage.normalizeBalance({}) === null, '空对象返回 null');
check(usage.normalizeBalance({ balance_infos: [] }) === null, '空数组返回 null');
check(usage.normalizeBalance({ balance_infos: [{ currency: 'CNY', total_balance: 'abc' }] }) === null,
  '非法金额返回 null');

console.log('\n[22] 余额视图（两条路）');
let view = usage.balanceView({
  official: { total: 110, currency: 'CNY', granted: 10, toppedUp: 100, available: true },
  budget: null,
  spent: 3.5,
  today: 1.2,
});
check(view.source === 'official', '有官方数据时优先用官方');
check(view.total === 110 && view.symbol === '¥', '显示真实余额');
check(view.detail.includes('赠送'), '详情里带赠送额度');

view = usage.balanceView({ official: null, budget: 50, spent: 12.5, today: 3 });
check(view.source === 'budget', '无官方数据时用手动预算');
check(view.total === 37.5, `预算 50 − 已用 12.5 = 37.5（实际 ${view.total}）`);

view = usage.balanceView({ official: null, budget: 10, spent: 15, today: 0 });
check(view.total === 0, '超支时剩余显示为 0 而不是负数');
check(view.available === false, '超支标记为不可用');

view = usage.balanceView({ official: null, budget: null, spent: 0, today: 0 });
check(view.source === 'none', '都没配置时标记 none');
check(view.total === null, '未配置时余额为 null');
check(view.detail.includes('设置'), '给出引导文案');

console.log('\n[23] 货币符号');
check(usage.currencySymbol('CNY') === '¥', 'CNY → ¥');
check(usage.currencySymbol('USD') === '$', 'USD → $');
check(usage.currencySymbol('EUR') === 'EUR ', '未知币种回退为代码前缀');

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 记忆库与用量测试全部通过。');
