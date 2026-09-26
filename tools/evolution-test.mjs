#!/usr/bin/env node
/**
 * evolution-test.mjs —— 自进化（技能库 + 规则库）的行为测试。
 *
 * 验证：
 *   - 技能去重、合并、命中累加、容量淘汰
 *   - 任务匹配：同类任务命中、无关任务不误命中、跨站技能被排除
 *   - 规则去重、置信度累积、可禁用、注入排序
 *   - 提示词渲染格式
 *
 * 用法：node tools/evolution-test.mjs
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
      async get(k) {
        return { [k]: store[k] };
      },
      async set(o) {
        Object.assign(store, o);
      },
    },
  },
};

const mod = (p) => `file:///${path.join(root, p).replace(/\\/g, '/')}`;
const sk = await import(mod('src/shared/skills.js'));
const ev = await import(mod('src/shared/evolution.js'));
const { SKILL_LIMIT, RULE_LIMIT } = await import(mod('src/shared/messages.js'));

/* ---------------- 技能库 ---------------- */

console.log('\n自进化测试\n');

console.log('[1] 技能：新增与合并');
{
  let r = await sk.addSkill({
    name: '搜索结果提取',
    trigger: '在搜索结果页提取条目',
    steps: ['先 outline 看结构', '定位结果列表容器', '逐条读取标题与链接'],
    tools: ['outline', 'read_page'],
  });
  check(r.added === true, '首次添加成功');

  r = await sk.addSkill({
    name: '搜索结果提取',
    trigger: '在搜索结果页提取条目',
    steps: ['先 outline', '提取 .result 下的条目'],
  });
  check(r.added === false && r.merged === true, '相同触发条件的技能被合并');

  const list = await sk.listSkills();
  check(list.length === 1, `合并后只有 1 条（实际 ${list.length}）`);
  check(list[0].hits === 1, `合并时累加命中（${list[0].hits}）`);
  check(list[0].steps.length === 2, '步骤被更新为新版本');
}

console.log('\n[2] 技能：参数校验');
{
  for (const [bad, label] of [
    [{ trigger: 'x', steps: ['a'] }, '缺名称'],
    [{ name: 'x', steps: ['a'] }, '缺触发条件'],
    [{ name: 'x', trigger: 'y' }, '缺步骤'],
    [{ name: 'x', trigger: 'y', steps: [] }, '步骤为空数组'],
    [{ name: 'x', trigger: 'y', steps: ['  '] }, '步骤只有空白'],
  ]) {
    let threw = false;
    try { await sk.addSkill(bad); } catch { threw = true; }
    check(threw, `${label} 被拒绝`);
  }
}

console.log('\n[3] 技能：匹配（核心能力）');
{
  await sk.clearSkills();
  await sk.addSkill({
    name: '去广告',
    trigger: '净化页面 去掉广告 隐藏弹窗',
    steps: ['用 outline 找广告容器', 'hide 掉它们'],
  });
  await sk.addSkill({
    name: '翻译全文',
    trigger: '翻译页面 正文 译成中文',
    steps: ['read_page 读正文', '直接输出译文'],
  });
  await sk.addSkill({
    name: '站点登录',
    trigger: '登录 example.com 账号',
    steps: ['点右上角登录'],
    site: 'example.com',
  });

  const list = await sk.listSkills();
  check(list.length === 3, `共 ${list.length} 条技能`);

  // 同类任务应当命中
  const adSkills = await sk.selectSkills('帮我把这个页面的广告去掉', 'https://other.com');
  check(adSkills.some((s) => s.name === '去广告'), '「去广告」任务命中对应技能');

  const trSkills = await sk.selectSkills('把这个页面翻译成中文', 'https://other.com');
  check(trSkills.some((s) => s.name === '翻译全文'), '「翻译」任务命中对应技能');
  check(!trSkills.some((s) => s.name === '去广告'), '不会误命中无关技能');

  // 完全无关的任务不应命中
  const none = await sk.selectSkills('今天天气怎么样', 'https://other.com');
  check(none.length === 0, `无关任务不命中任何技能（实际 ${none.length}）`);
}

console.log('\n[3b] 技能：停用词过滤（防止高频字导致误命中）');
{
  // 这是实测发现过的真问题：中文按字切分时，"页面""的"这类字
  // 几乎出现在所有网页任务里，会让"翻译这个页面"命中"去广告"技能。
  const list = await sk.listSkills();
  const ad = list.find((s) => s.name === '去广告');
  const tr = list.find((s) => s.name === '翻译全文');
  check(Boolean(ad) && Boolean(tr), '取到测试用技能');

  const cross = sk.scoreSkill('把这个页面翻译成中文', ad);
  check(cross < 0.1, `翻译任务不会匹配去广告技能（得分 ${cross.toFixed(3)}）`);

  const cross2 = sk.scoreSkill('帮我把这个页面的广告去掉', tr);
  check(cross2 < 0.1, `去广告任务不会匹配翻译技能（得分 ${cross2.toFixed(3)}）`);

  // 高频字单独出现时不应算作匹配
  const weak = sk.scoreSkill('看看这个页面', ad);
  check(weak === 0, `纯高频字（页面）不构成匹配（得分 ${weak.toFixed(3)}）`);

  // 但真正相关的关键词仍然要能命中
  const strong = sk.scoreSkill('去掉广告和弹窗', ad);
  check(strong > 0.15, `真正的关键词仍然命中（得分 ${strong.toFixed(3)}）`);
}

console.log('\n[4] 技能：站点限定');
{
  const same = await sk.selectSkills('登录 example.com 账号', 'https://example.com/login');
  check(same.some((s) => s.name === '站点登录'), '同站访问时命中站点技能');

  const other = await sk.selectSkills('登录 example.com 账号', 'https://totally-different.com');
  check(!other.some((s) => s.name === '站点登录'), '异站访问时排除站点技能');

  // 这是实测发现过的真问题：当任务文字里**提到**该域名时，
  // 文本匹配分会很高，早先用"扣 0.5 分"的软惩罚挡不住。
  // 现在改成硬性排除，所以这个用例必须通过。
  const mentioned = await sk.selectSkills(
    '去 example.com 登录一下',
    'https://totally-different.com',
  );
  check(
    !mentioned.some((s) => s.name === '站点登录'),
    '即使任务文字提到该域名，异站也不注入该站技能（硬排除）',
  );
}

console.log('\n[5] 技能：命中累加');
{
  await sk.clearSkills();
  await sk.addSkill({ name: 'A', trigger: '总结页面要点', steps: ['read_page'] });
  const before = (await sk.listSkills())[0].hits || 0;
  await sk.selectSkills('总结这个页面的要点', 'https://x.com');
  const after = (await sk.listSkills())[0].hits || 0;
  check(after === before + 1, `命中一次后 hits 递增（${before} → ${after}）`);
}

console.log('\n[6] 技能：渲染成提示词');
{
  const list = await sk.listSkills();
  const text = sk.renderSkills(list);
  check(text.includes('【A】'), '渲染出技能名');
  check(text.includes('适用：'), '渲染出触发条件');
  check(text.includes('1. read_page'), '渲染出编号步骤');
  check(sk.renderSkills([]) === '', '空列表渲染为空串');
}

console.log('\n[7] 技能：容量上限');
{
  await sk.clearSkills();
  for (let i = 0; i < SKILL_LIMIT + 15; i += 1) {
    await sk.addSkill({ name: `技能${i}`, trigger: `触发条件编号${i}`, steps: ['步骤'] });
  }
  const list = await sk.listSkills();
  check(list.length <= SKILL_LIMIT, `条目数被限制在 ${SKILL_LIMIT}（实际 ${list.length}）`);
}

console.log('\n[8] 技能：编辑与删除、只清自动');
{
  await sk.clearSkills();
  const a = await sk.addSkill({ name: '手动的', trigger: '手动触发', steps: ['s1'], source: 'manual' });
  await sk.addSkill({ name: '自动的', trigger: '自动触发', steps: ['s2'], source: 'auto' });

  await sk.updateSkill(a.skill.id, { steps: ['新步骤1', '新步骤2'] });
  let list = await sk.listSkills();
  check(list.find((s) => s.name === '手动的').steps.length === 2, '更新步骤生效');

  await sk.clearSkills(true); // 只清自动
  list = await sk.listSkills();
  check(list.some((s) => s.name === '手动的'), '只清自动时保留手动技能');
  check(!list.some((s) => s.name === '自动的'), '自动技能被清除');

  await sk.deleteSkill(a.skill.id);
  list = await sk.listSkills();
  check(list.length === 0, '删除生效');
}

/* ---------------- 规则库 ---------------- */

console.log('\n\n规则库测试\n');

console.log('[9] 规则：新增与合并、置信度累积');
{
  let r = await ev.addRule({ text: '需要在页面里搜索时，直接用 type_text 的 enter 参数，不要多点一次按钮', kind: 'efficiency' });
  check(r.added === true, '首次添加成功');
  const c1 = r.rule.confidence;

  r = await ev.addRule({ text: '需要在页面里搜索时，直接用 type_text 的 enter 参数，不要多点一次按钮' });
  check(r.added === false && r.merged === true, '重复规则被合并');
  check(r.rule.confidence > c1, `置信度随重复出现提升（${c1} → ${r.rule.confidence}）`);
  check(r.rule.occurrences === 2, `记录出现次数（${r.rule.occurrences}）`);
}

console.log('\n[10] 规则：参数校验');
{
  for (const [bad, label] of [
    [{ text: '' }, '空内容'],
    [{ text: '   ' }, '纯空白'],
    [{ text: 'x'.repeat(400) }, '超长内容'],
  ]) {
    let threw = false;
    try { await ev.addRule(bad); } catch { threw = true; }
    check(threw, `${label} 被拒绝`);
  }
}

console.log('\n[11] 规则：注入排序与禁用');
{
  await ev.clearRules();
  await ev.addRule({ text: '规则A', kind: 'efficiency' });
  const high = await ev.addRule({ text: '规则B', kind: 'reliability' });
  // 让 B 反复出现，提升置信度
  await ev.addRule({ text: '规则B' });
  await ev.addRule({ text: '规则B' });

  await ev.updateRule(high.rule.id, { enabled: false });
  const picked = await ev.selectRules();
  check(!picked.some((r) => r.text === '规则B'), '被禁用的规则不会被注入');
  check(picked.some((r) => r.text === '规则A'), '启用的规则正常注入');

  await ev.updateRule(high.rule.id, { enabled: true });
  const picked2 = await ev.selectRules();
  const idxB = picked2.findIndex((r) => r.text === '规则B');
  const idxA = picked2.findIndex((r) => r.text === '规则A');
  check(idxB >= 0 && idxB < idxA, '高置信度规则排在前面');
}

console.log('\n[12] 规则：渲染成提示词');
{
  const rules = await ev.selectRules();
  const text = ev.renderRules(rules);
  check(text.includes('- 规则A'), '渲染成列表项');
  check(text.includes('（效率）') || text.includes('（可靠性）'), '带上类别标签');
  check(ev.renderRules([]) === '', '空规则渲染为空串');
}

console.log('\n[13] 规则：容量上限');
{
  await ev.clearRules();
  for (let i = 0; i < RULE_LIMIT + 15; i += 1) {
    await ev.addRule({ text: `规则编号${i}` });
  }
  const list = await ev.listRules();
  check(list.length <= RULE_LIMIT, `条目数被限制在 ${RULE_LIMIT}（实际 ${list.length}）`);
}

console.log('\n[14] 统计');
{
  await ev.clearRules();
  await ev.addRule({ text: '手动规则', source: 'manual' });
  await ev.addRule({ text: '自动规则', source: 'auto' });
  const st = await ev.ruleStats();
  check(st.total === 2, `统计总数（${st.total}）`);
  check(st.auto === 1 && st.manual === 1, '区分自动与手动');
  check(st.limit === RULE_LIMIT, '返回容量上限');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 自进化测试全部通过。');
