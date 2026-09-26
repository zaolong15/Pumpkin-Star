/**
 * skills.js —— 自进化：技能库。
 *
 * 思路：Agent 完成一个任务后，判断"这类任务下次该怎么做"，
 * 提炼成一条可复用的**技能**（触发条件 + 步骤要点）。下次遇到
 * 同类任务时，把匹配的技能注入上下文，避免重走弯路。
 *
 * 与记忆库（memory.js）的区别：
 *   memory 记的是"事实与偏好"（用户是谁、偏好什么、某网站长什么样）
 *   skills 记的是"方法与流程"（这类任务分几步做、哪步容易出错、用什么工具）
 *   两者互补：记忆是名词，技能是动词。
 *
 * 设计取舍：
 *   - 技能由模型提炼，但**用户可以看、改、删**，不是黑盒。
 *   - 命中的技能会累加 hits，长期没用的会被淘汰（容量上限）。
 *   - 注入时只带最相关的几条，避免撑爆上下文。
 */

import { SKILL_LIMIT, SKILL_INJECT_LIMIT } from '../shared/messages.js';

const KEY = 'skills';

/** 归一化文本，用于去重与匹配。 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 URL 取域名。 */
function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 读取全部技能（按命中次数 + 新旧排序）。 */
export async function listSkills() {
  const stored = await chrome.storage.local.get(KEY);
  const list = Array.isArray(stored[KEY]) ? stored[KEY] : [];
  return list
    .slice()
    .sort((a, b) => (b.hits || 0) * 1e6 + (b.updatedAt || 0) - ((a.hits || 0) * 1e6 + (a.updatedAt || 0)));
}

async function saveAll(list) {
  let trimmed = list;
  if (list.length > SKILL_LIMIT) {
    // 淘汰：命中少、又旧的先走
    trimmed = list
      .slice()
      .sort((a, b) => (b.hits || 0) * 1e8 + (b.updatedAt || 0) - ((a.hits || 0) * 1e8 + (a.updatedAt || 0)))
      .slice(0, SKILL_LIMIT);
  }
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed;
}

let seq = 0;
const makeId = () => `s${Date.now().toString(36)}${(seq += 1)}`;

/**
 * 新增技能。同名（trigger 相同）的技能会合并：更新步骤、累加命中。
 * @param {{name:string, trigger:string, steps:string[], tools?:string[], site?:string, source?:string}} skill
 */
export async function addSkill(skill) {
  const name = String(skill?.name || '').trim();
  const trigger = String(skill?.trigger || '').trim();
  const steps = (Array.isArray(skill?.steps) ? skill.steps : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  if (!name) throw new Error('技能需要名称');
  if (!trigger) throw new Error('技能需要触发条件');
  if (!steps.length) throw new Error('技能至少需要一步');

  const list = await listSkills();
  const now = Date.now();
  const normTrigger = normalize(trigger);
  const dup = list.find((s) => normalize(s.trigger) === normTrigger);

  if (dup) {
    // 合并：采用更新的步骤，累加命中
    dup.name = name;
    dup.steps = steps;
    if (skill.tools?.length) dup.tools = skill.tools;
    dup.updatedAt = now;
    dup.hits = (dup.hits || 0) + 1;
    await saveAll(list);
    return { added: false, merged: true, skill: dup };
  }

  const item = {
    id: makeId(),
    name,
    trigger,
    steps,
    tools: Array.isArray(skill.tools) ? skill.tools.slice(0, 12) : [],
    site: skill.site || undefined,
    source: skill.source || 'auto',
    hits: 0,
    createdAt: now,
    updatedAt: now,
  };
  list.push(item);
  await saveAll(list);
  return { added: true, merged: false, skill: item };
}

/** 批量新增，返回实际新增数。 */
export async function addManySkills(items, source = 'auto') {
  let added = 0;
  for (const raw of items || []) {
    try {
      const r = await addSkill({ ...raw, source });
      if (r.added) added += 1;
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  return added;
}

export async function updateSkill(id, patch) {
  const list = await listSkills();
  const item = list.find((s) => s.id === id);
  if (!item) throw new Error('找不到该技能');
  if (patch.name !== undefined) item.name = String(patch.name).trim() || item.name;
  if (patch.trigger !== undefined) item.trigger = String(patch.trigger).trim() || item.trigger;
  if (Array.isArray(patch.steps)) {
    const steps = patch.steps.map((s) => String(s || '').trim()).filter(Boolean);
    if (!steps.length) throw new Error('技能至少需要一步');
    item.steps = steps;
  }
  item.updatedAt = Date.now();
  await saveAll(list);
  return item;
}

export async function deleteSkill(id) {
  const list = await listSkills();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) throw new Error('找不到该技能');
  await saveAll(next);
  return { deleted: 1 };
}

export async function clearSkills(onlyAuto = false) {
  if (!onlyAuto) {
    await chrome.storage.local.set({ [KEY]: [] });
    return { cleared: 'all' };
  }
  const list = await listSkills();
  await saveAll(list.filter((s) => s.source !== 'auto'));
  return { cleared: 'auto' };
}

/* ============================================================
   匹配：从任务描述里找出该用哪条技能
   ============================================================ */

/**
 * 中文停用词/高频字。
 *
 * 为什么必须过滤：中文没有空格，只能按字切分，而"页""面""的"
 * 这类字几乎出现在所有网页任务里。不过滤的话，"翻译这个页面"
 * 会因为共享"页面"而命中"去广告"技能 —— 这类误命中会让
 * 无关的技能被塞进上下文，污染提示词。
 */
const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没', '看', '好',
  '自', '己', '这', '那', '些', '把', '被', '让', '给', '对', '从', '为', '以',
  '页', '面', '网', '站', '点', '下', '中', '后', '前', '时', '能', '可', '请',
  '帮', '做', '用', '想', '需', '要', '它', '们', '与', '或', '而', '但', '如',
  '一个', '这个', '那个', '一下', '可以', '需要', '帮我', '然后', '现在', '什么',
  '怎么', '如何', '页面', '网页', '网站', '内容', '进行', '应该', '如果', '因为',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for',
  'it', 'this', 'that', 'with', 'be', 'can', 'you', 'me', 'my', 'please',
]);

/** 把中文按字切分（中文没有空格，逐字 + 双字组合更稳）。 */
function tokens(text) {
  const s = normalize(text);
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) {
    if (!STOPWORDS.has(w)) out.add(w);
  }
  const cjk = s.match(/[\u4e00-\u9fa5]/g) || [];
  for (let i = 0; i < cjk.length; i += 1) {
    const single = cjk[i];
    if (!STOPWORDS.has(single)) out.add(single);
    if (i + 1 < cjk.length) {
      const pair = single + cjk[i + 1];
      if (!STOPWORDS.has(pair)) out.add(pair);
    }
  }
  return out;
}

/**
 * 计算任务与技能触发条件的相关度（0..1）。
 *
 * 用"双向覆盖"而不是单向命中率：
 * 单向的话，只要技能描述短、任务里字多，就容易被几个常见字刷高。
 * 这里同时要求技能的关键词也被覆盖到。
 */
export function scoreSkill(task, skill) {
  const t = tokens(task);
  const g = tokens(`${skill.trigger} ${skill.name} ${(skill.steps || []).join(' ')}`);
  if (!t.size || !g.size) return 0;

  const weight = (w) => (w.length > 1 ? 2 : 1); // 双字/单词权重更高
  let forward = 0; // 任务里的词有多少出现在技能里
  let tTotal = 0;
  for (const w of t) {
    tTotal += weight(w);
    if (g.has(w)) forward += weight(w);
  }
  let backward = 0; // 技能的关键词有多少被任务覆盖
  let gTotal = 0;
  for (const w of g) {
    gTotal += weight(w);
    if (t.has(w)) backward += weight(w);
  }

  const f = forward / (tTotal || 1);
  const b = backward / (gTotal || 1);
  // 调和平均：两边都要够高才算真匹配
  if (f + b === 0) return 0;
  return (2 * f * b) / (f + b);
}

/**
 * 为当前任务挑选相关技能。
 * @param {string} task 任务描述
 * @param {string} url 当前网址
 */
/**
 * 匹配阈值。
 *
 * 实测分数分布（见 tools/evolution-test.mjs 的用例）：
 *   负例（无关任务）        0.000  —— 过滤停用词后干净归零
 *   正例（同类任务）        0.131 ~ 0.378
 * 取 0.12：正例全部通过，负例仍在 0 附近被挡掉。
 * 阈值定高会漏掉简短的正当任务（如"帮我翻译一下"只有 0.131）。
 */
const MATCH_THRESHOLD = 0.12;

export async function selectSkills(task, url, limit = SKILL_INJECT_LIMIT) {
  const site = siteOf(url || '');
  const list = await listSkills();

  const scored = list
    .map((s) => {
      // 站点专属技能：**硬性排除**而不是扣分。
      // 之前用 "score -= 0.5"，但任务文字里若提到该域名，
      // 匹配分很高，扣完仍然超标 —— 结果异站也注入了该站经验。
      if (s.site && s.site !== site) return null;

      let score = scoreSkill(task, s);
      if (s.site && s.site === site) score += 0.15; // 同站加分
      score += Math.min((s.hits || 0) * 0.03, 0.15); // 用过且有效的更可信
      return { s, score };
    })
    .filter(Boolean)
    .filter((x) => x.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const picked = scored.map((x) => x.s);

  // 累加命中，用于后续排序与淘汰
  if (picked.length) {
    const ids = new Set(picked.map((s) => s.id));
    const now = Date.now();
    for (const s of list) if (ids.has(s.id)) { s.hits = (s.hits || 0) + 1; s.lastUsedAt = now; }
    saveAll(list).catch(() => {});
  }

  return picked;
}

/** 渲染成给模型看的文本。没有技能时返回空串。 */
export function renderSkills(skills) {
  if (!skills?.length) return '';
  const out = [];
  for (const s of skills) {
    out.push(`【${s.name}】适用：${s.trigger}`);
    (s.steps || []).forEach((step, i) => out.push(`  ${i + 1}. ${step}`));
    if (s.tools?.length) out.push(`  常用工具：${s.tools.join('、')}`);
  }
  return out.join('\n');
}

/** 技能库统计。 */
export async function skillStats() {
  const list = await listSkills();
  const auto = list.filter((s) => s.source === 'auto').length;
  return { total: list.length, auto, manual: list.length - auto, limit: SKILL_LIMIT };
}
