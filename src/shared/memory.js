/**
 * memory.js —— 本地记忆库。
 *
 * 三类记忆：
 *   preference  用户偏好（"回答用中文"、"别自动提交表单"）
 *   fact        关于用户或环境的事实（"我在做量化交易"、"常用 DeepSeek"）
 *   site        某个网站的操作经验（"example.com 的搜索框是 e3"）
 *
 * 设计取舍：
 *   - 全部存在 chrome.storage.local，不出本机。
 *   - 按 key 去重（同一条事实不重复记），命中时刷新 updatedAt。
 *   - 注入上下文时按"类型 + 时效"挑选，并做条数上限，避免撑爆 prompt。
 */

import { MEMORY_KINDS, MEMORY_LIMIT, MEMORY_INJECT_LIMIT } from '../shared/messages.js';

const KEY = 'memory';

/** 归一化文本用于去重：去掉空白与标点差异。 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。，,.!！?？;；:：'"]/g, '')
    .trim();
}

/** 从 URL 提取站点标识（域名）。 */
export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 读取全部记忆。 */
export async function listMemories() {
  const stored = await chrome.storage.local.get(KEY);
  const list = Array.isArray(stored[KEY]) ? stored[KEY] : [];
  // 按更新时间倒序
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function saveAll(list) {
  // 超限时优先淘汰"旧的、命中少的"条目
  let trimmed = list;
  if (list.length > MEMORY_LIMIT) {
    trimmed = list
      .slice()
      .sort((a, b) => {
        const scoreA = (a.updatedAt || 0) + (a.hits || 0) * 86400000;
        const scoreB = (b.updatedAt || 0) + (b.hits || 0) * 86400000;
        return scoreB - scoreA;
      })
      .slice(0, MEMORY_LIMIT);
  }
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed;
}

let idSeq = 0;
function makeId() {
  idSeq += 1;
  return `m${Date.now().toString(36)}${idSeq}`;
}

/**
 * 新增一条记忆。若内容重复则合并（延长时效、累加命中）。
 * @returns {{added: boolean, item: object}}
 */
export async function addMemory({ kind = MEMORY_KINDS.FACT, text, source, url }) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('记忆内容不能为空');
  if (clean.length > 400) throw new Error('记忆内容过长（上限 400 字）');

  const validKind = Object.values(MEMORY_KINDS).includes(kind) ? kind : MEMORY_KINDS.FACT;
  const list = await listMemories();
  const norm = normalize(clean);

  const dup = list.find((m) => normalize(m.text) === norm);
  const now = Date.now();

  if (dup) {
    dup.updatedAt = now;
    dup.hits = (dup.hits || 0) + 1;
    // 站点记忆补上新出现的网址
    if (url && dup.site && !dup.urls?.includes(url)) {
      dup.urls = [...(dup.urls || []), url].slice(-5);
    }
    await saveAll(list);
    return { added: false, item: dup };
  }

  const item = {
    id: makeId(),
    kind: validKind,
    text: clean,
    site: url ? siteOf(url) : undefined,
    urls: url ? [url] : [],
    source: source || 'manual',
    hits: 0,
    createdAt: now,
    updatedAt: now,
  };
  list.push(item);
  await saveAll(list);
  return { added: true, item };
}

/** 批量新增（用于从对话提炼）。返回实际新增条数。 */
export async function addMany(items, source = 'auto') {
  let added = 0;
  for (const raw of items || []) {
    if (!raw?.text) continue;
    try {
      const res = await addMemory({
        kind: raw.kind,
        text: raw.text,
        url: raw.url,
        source,
      });
      if (res.added) added += 1;
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  return added;
}

export async function updateMemory(id, patch) {
  const list = await listMemories();
  const item = list.find((m) => m.id === id);
  if (!item) throw new Error('找不到该记忆');
  if (patch.text !== undefined) {
    const clean = String(patch.text).trim();
    if (!clean) throw new Error('记忆内容不能为空');
    item.text = clean;
  }
  if (patch.kind && Object.values(MEMORY_KINDS).includes(patch.kind)) item.kind = patch.kind;
  item.updatedAt = Date.now();
  await saveAll(list);
  return item;
}

export async function deleteMemory(id) {
  const list = await listMemories();
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) throw new Error('找不到该记忆');
  await saveAll(next);
  return { deleted: 1 };
}

export async function clearMemories(kind) {
  if (!kind) {
    await chrome.storage.local.set({ [KEY]: [] });
    return { cleared: 'all' };
  }
  const list = await listMemories();
  await saveAll(list.filter((m) => m.kind !== kind));
  return { cleared: kind };
}

/**
 * 挑选要注入上下文的记忆。
 * 规则：站点经验按当前域名过滤（只带该站的），偏好与事实全带；
 * 总量受 MEMORY_INJECT_LIMIT 限制，优先新的、命中的。
 */
export async function selectForContext(url, limit = MEMORY_INJECT_LIMIT) {
  const site = siteOf(url || '');
  const list = await listMemories();

  const scored = list.map((m) => {
    let score = (m.updatedAt || 0) / 1e10 + (m.hits || 0);
    if (m.kind === MEMORY_KINDS.SITE) {
      // 站点不匹配的直接排除，匹配的加分
      if (!site || m.site !== site) return null;
      score += 5;
    }
    if (m.kind === MEMORY_KINDS.PREFERENCE) score += 2;
    return { m, score };
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limit).map((s) => s.m);

  // 命中计数（用于后续排序，失败不影响主流程）
  if (picked.length) {
    const ids = new Set(picked.map((m) => m.id));
    const now = Date.now();
    for (const m of list) if (ids.has(m.id)) m.hits = (m.hits || 0) + 1;
    saveAll(list).catch(() => {});
  }

  return picked;
}

/** 渲染成给模型看的文本块。没有记忆时返回空串。 */
export function renderForPrompt(memories) {
  if (!memories?.length) return '';
  const groups = {
    [MEMORY_KINDS.PREFERENCE]: [],
    [MEMORY_KINDS.FACT]: [],
    [MEMORY_KINDS.SITE]: [],
  };
  for (const m of memories) (groups[m.kind] || groups.fact).push(m);

  const lines = [];
  if (groups.preference.length) {
    lines.push('用户偏好：');
    lines.push(...groups.preference.map((m) => `- ${m.text}`));
  }
  if (groups.fact.length) {
    lines.push('已知事实：');
    lines.push(...groups.fact.map((m) => `- ${m.text}`));
  }
  if (groups.site.length) {
    lines.push('该网站的操作经验：');
    lines.push(...groups.site.map((m) => `- ${m.text}`));
  }
  return lines.join('\n');
}

/** 记忆库统计。 */
export async function memoryStats() {
  const list = await listMemories();
  const byKind = { preference: 0, fact: 0, site: 0 };
  for (const m of list) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
  return { total: list.length, byKind, limit: MEMORY_LIMIT };
}
