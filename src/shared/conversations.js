/**
 * conversations.js —— 对话历史。
 *
 * 目标：像 DeepSeek 那样，可以保留多段对话、随时新建、随时切回。
 *
 * 设计取舍：
 *   - 存在 chrome.storage.local（不是 sync）—— 对话可能很长，sync 有 100KB 配额
 *   - 每段对话独立存 key，避免一次读写整个历史（快，且不会互相拖累）
 *   - 每段最多 200 条消息，超出丢弃最早的（保留最近上下文）
 *   - 索引单独存一份，用于快速列出列表而不用读全部内容
 */

const INDEX_KEY = 'conversations';
const MSG_PREFIX = 'conv:';
/** 单段对话最多保留多少条消息。 */
export const MAX_MESSAGES = 200;
/** 最多保留多少段对话。 */
export const MAX_CONVERSATIONS = 50;

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq += 1)}`;

/** 从第一条用户消息生成标题。 */
function titleFrom(messages) {
  const firstUser = (messages || []).find((m) => m.role === 'user');
  if (!firstUser) return '新对话';
  const t = String(firstUser.content || '').replace(/\s+/g, ' ').trim();
  return t.length > 30 ? `${t.slice(0, 30)}…` : t || '新对话';
}

/** 取对话索引（不含正文，快）。 */
export async function listConversations() {
  const stored = await chrome.storage.local.get(INDEX_KEY);
  const list = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function saveIndex(list) {
  await chrome.storage.local.set({ [INDEX_KEY]: list });
  return list;
}

/** 读一段对话的完整消息。 */
export async function getConversation(id) {
  if (!id) return null;
  const key = MSG_PREFIX + id;
  const stored = await chrome.storage.local.get(key);
  const data = stored[key];
  if (!data) return null;
  return { id, ...data };
}

/** 新建一段对话，返回其 id。 */
export async function createConversation() {
  const id = newId();
  const now = Date.now();
  const conv = { id, title: '新对话', messages: [], createdAt: now, updatedAt: now };
  await chrome.storage.local.set({ [MSG_PREFIX + id]: conv });

  const list = await listConversations();
  list.unshift({
    id,
    title: conv.title,
    count: 0,
    createdAt: now,
    updatedAt: now,
  });
  // 超出上限时淘汰最旧的（连同正文一起删）
  if (list.length > MAX_CONVERSATIONS) {
    const dropped = list.splice(MAX_CONVERSATIONS);
    for (const d of dropped) {
      await chrome.storage.local.remove(MSG_PREFIX + d.id).catch(() => {});
    }
  }
  await saveIndex(list);
  return id;
}

/** 覆盖写入一段对话的消息。 */
export async function saveConversation(id, messages) {
  if (!id) throw new Error('缺少对话 id');
  const now = Date.now();
  const trimmed = (messages || []).slice(-MAX_MESSAGES);

  const stored = await chrome.storage.local.get(MSG_PREFIX + id);
  const prev = stored[MSG_PREFIX + id] || {};
  const conv = {
    id,
    title: prev.title && prev.title !== '新对话' ? prev.title : titleFrom(trimmed),
    messages: trimmed,
    createdAt: prev.createdAt || now,
    updatedAt: now,
  };
  await chrome.storage.local.set({ [MSG_PREFIX + id]: conv });

  // 更新索引
  const list = await listConversations();
  const item = list.find((c) => c.id === id);
  const entry = {
    id,
    title: conv.title,
    count: trimmed.length,
    createdAt: conv.createdAt,
    updatedAt: now,
  };
  if (item) Object.assign(item, entry);
  else list.unshift(entry);
  await saveIndex(list);

  return { id, title: conv.title, count: trimmed.length, truncated: (messages || []).length > MAX_MESSAGES };
}

/** 重命名。 */
export async function renameConversation(id, title) {
  const clean = String(title || '').trim().slice(0, 60);
  if (!clean) throw new Error('标题不能为空');

  const key = MSG_PREFIX + id;
  const stored = await chrome.storage.local.get(key);
  if (stored[key]) {
    stored[key].title = clean;
    stored[key].updatedAt = Date.now();
    await chrome.storage.local.set({ [key]: stored[key] });
  }
  const list = await listConversations();
  const item = list.find((c) => c.id === id);
  if (item) {
    item.title = clean;
    item.updatedAt = Date.now();
    await saveIndex(list);
  }
  return { id, title: clean };
}

/** 删除一段对话。 */
export async function deleteConversation(id) {
  await chrome.storage.local.remove(MSG_PREFIX + id);
  const list = await listConversations();
  await saveIndex(list.filter((c) => c.id !== id));
  return { deleted: 1 };
}

/** 清空全部对话。 */
export async function clearConversations() {
  const list = await listConversations();
  for (const c of list) {
    await chrome.storage.local.remove(MSG_PREFIX + c.id).catch(() => {});
  }
  await saveIndex([]);
  return { cleared: list.length };
}

/** 统计。 */
export async function conversationStats() {
  const list = await listConversations();
  const totalMessages = list.reduce((s, c) => s + (c.count || 0), 0);
  return { count: list.length, totalMessages, limit: MAX_CONVERSATIONS };
}

/** 找到最近一次使用的对话 id（用于重开侧边栏时恢复）。 */
export async function lastConversationId() {
  const list = await listConversations();
  return list[0]?.id || null;
}
