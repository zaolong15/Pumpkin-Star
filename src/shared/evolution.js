/**
 * evolution.js —— 自进化：从自己的执行记录里学规则。
 *
 * 与 skills.js 的分工：
 *   skills  记"这类任务怎么做" —— 面向具体任务的方法
 *   rules   记"我该注意什么"   —— 面向自身的经验教训（提示词层面的自我修正）
 *
 * rules 的来源是每次任务的结构化复盘：哪一步多余、哪里失败、
 * 下次该怎么调整。这些规则会被注入系统提示，从而改变以后的行为 ——
 * 这就是"自进化"的闭环：执行 → 复盘 → 提炼规则 → 影响下次执行。
 *
 * 安全边界：规则只影响提示词措辞，**不会**让 Agent 获得新能力，
 * 也不能覆盖安全底线（安全条款在提示词末尾，且明确声明不可被规则推翻）。
 */

import { RULE_LIMIT, RULE_INJECT_LIMIT } from '../shared/messages.js';

const KEY = 'rules';

export async function listRules() {
  const stored = await chrome.storage.local.get(KEY);
  const list = Array.isArray(stored[KEY]) ? stored[KEY] : [];
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function saveAll(list) {
  let trimmed = list;
  if (list.length > RULE_LIMIT) {
    // 淘汰：有效次数少、又旧的先走
    trimmed = list
      .slice()
      .sort((a, b) => (b.helpful || 0) * 1e8 + (b.updatedAt || 0) - ((a.helpful || 0) * 1e8 + (a.updatedAt || 0)))
      .slice(0, RULE_LIMIT);
  }
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed;
}

let seq = 0;
const makeId = () => `r${Date.now().toString(36)}${(seq += 1)}`;

const normalize = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[\s。，,.!！?？；;：:'"]/g, '')
    .trim();

/**
 * 新增规则。内容重复则合并（累加依据次数）。
 * @param {{text:string, kind?:string, evidence?:string}} rule
 */
export async function addRule(rule) {
  const text = String(rule?.text || '').trim();
  if (!text) throw new Error('规则内容不能为空');
  if (text.length > 300) throw new Error('规则过长（上限 300 字）');

  const KIND = ['efficiency', 'reliability', 'preference'];
  const kind = KIND.includes(rule?.kind) ? rule.kind : 'efficiency';

  const list = await listRules();
  const now = Date.now();
  const dup = list.find((r) => normalize(r.text) === normalize(text));

  if (dup) {
    dup.updatedAt = now;
    dup.occurrences = (dup.occurrences || 1) + 1;
    // 同一条经验反复出现，说明它更值得重视
    dup.confidence = Math.min(1, (dup.confidence || 0.5) + 0.15);
    await saveAll(list);
    return { added: false, merged: true, rule: dup };
  }

  const item = {
    id: makeId(),
    text,
    kind,
    evidence: rule.evidence ? String(rule.evidence).slice(0, 200) : undefined,
    source: rule.source || 'auto',
    occurrences: 1,
    confidence: 0.5,
    helpful: 0,
    createdAt: now,
    updatedAt: now,
  };
  list.push(item);
  await saveAll(list);
  return { added: true, merged: false, rule: item };
}

export async function addManyRules(items, source = 'auto') {
  let added = 0;
  for (const raw of items || []) {
    try {
      const r = await addRule({ ...raw, source });
      if (r.added) added += 1;
    } catch {
      /* 忽略单条失败 */
    }
  }
  return added;
}

export async function updateRule(id, patch) {
  const list = await listRules();
  const item = list.find((r) => r.id === id);
  if (!item) throw new Error('找不到该规则');
  if (patch.text !== undefined) {
    const t = String(patch.text).trim();
    if (!t) throw new Error('规则内容不能为空');
    item.text = t;
  }
  if (patch.kind !== undefined) item.kind = patch.kind;
  if (patch.enabled !== undefined) item.enabled = patch.enabled;
  item.updatedAt = Date.now();
  await saveAll(list);
  return item;
}

export async function deleteRule(id) {
  const list = await listRules();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) throw new Error('找不到该规则');
  await saveAll(next);
  return { deleted: 1 };
}

export async function clearRules(onlyAuto = false) {
  if (!onlyAuto) {
    await chrome.storage.local.set({ [KEY]: [] });
    return { cleared: 'all' };
  }
  const list = await listRules();
  await saveAll(list.filter((r) => r.source !== 'auto'));
  return { cleared: 'auto' };
}

/**
 * 挑选要注入的规则。
 * 按"置信度 × 发生次数"排序，取前若干条；用户可逐条禁用。
 */
export async function selectRules(limit = RULE_INJECT_LIMIT) {
  const list = await listRules();
  return list
    .filter((r) => r.enabled !== false)
    .sort(
      (a, b) =>
        (b.confidence || 0) * 10 + Math.min(b.occurrences || 1, 5) -
        ((a.confidence || 0) * 10 + Math.min(a.occurrences || 1, 5)),
    )
    .slice(0, limit);
}

const KIND_LABEL = {
  efficiency: '效率',
  reliability: '可靠性',
  preference: '偏好',
};

/** 渲染成提示词片段。 */
export function renderRules(rules) {
  if (!rules?.length) return '';
  return rules
    .map((r) => `- ${r.text}${r.kind ? `（${KIND_LABEL[r.kind] || r.kind}）` : ''}`)
    .join('\n');
}

export async function ruleStats() {
  const list = await listRules();
  const auto = list.filter((r) => r.source === 'auto').length;
  const enabled = list.filter((r) => r.enabled !== false).length;
  return { total: list.length, auto, manual: list.length - auto, enabled, limit: RULE_LIMIT };
}
