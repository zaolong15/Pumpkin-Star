/**
 * files.js —— 文件输出。
 *
 * 三条路径：
 *   1. 导出下载   —— 用 chrome.downloads 或 Blob URL 直接下载，无需额外权限
 *   2. 写入本地文件夹 —— 用 File System Access API 让用户选一个目录，
 *      之后 Agent 可以直接把内容写成文件（需要用户明确授权）
 *   3. 剪贴板     —— 兜底
 *
 * 安全约定：
 *   - 写入目录必须由用户主动选择并授权，扩展无法自行决定写到哪里。
 *   - 文件名会被清洗：去掉路径分隔符与控制字符，防止越出所选目录。
 *   - 单文件大小有上限，避免模型一次写出巨大文件。
 */

/** 单文件大小上限（字符数）。 */
export const MAX_FILE_CHARS = 2_000_000;

/** 允许的扩展名（写文件时用；导出时按 MIME 决定）。 */
const SAFE_EXT = ['md', 'txt', 'json', 'csv', 'html', 'xml', 'yaml', 'yml', 'log', 'tsv'];

/** MIME 映射，用于下载导出。 */
const MIME = {
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  html: 'text/html;charset=utf-8',
  xml: 'application/xml;charset=utf-8',
  yaml: 'text/yaml;charset=utf-8',
  yml: 'text/yaml;charset=utf-8',
  log: 'text/plain;charset=utf-8',
  tsv: 'text/tab-separated-values;charset=utf-8',
};

/**
 * 清洗文件名。
 * 关键：必须去掉路径分隔符与 .. ，否则模型可能写出
 * "../../something" 这类越出所选目录的路径。
 */
export function sanitizeFilename(name, fallbackExt = 'md') {
  let n = String(name || '').trim();
  if (!n) n = `output.${fallbackExt}`;

  // 去掉目录部分：只取最后一段
  n = n.replace(/\\/g, '/').split('/').pop() || '';

  // 去掉控制字符与在 Windows 上非法的字符
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, '');

  // 去掉开头的点（隐藏文件 / .. 之类）
  n = n.replace(/^\.+/, '');

  // 折叠空白
  n = n.replace(/\s+/g, ' ').trim();

  if (!n) n = `output.${fallbackExt}`;

  // 限制长度（保留扩展名）
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }

  // 没有扩展名就补一个
  if (!/\.[a-z0-9]{1,8}$/i.test(n)) n = `${n}.${fallbackExt}`;

  return n;
}

/** 从文件名推断扩展名。 */
export function extOf(filename) {
  const m = String(filename || '').match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : 'txt';
}

/** 该扩展名是否允许写入。 */
export function isAllowedExt(ext) {
  return SAFE_EXT.includes(String(ext || '').toLowerCase());
}

/**
 * 把内容转成某种格式的文本。
 * @param {*} data
 * @param {string} format md | txt | json | csv
 */
export function serialize(data, format = 'md') {
  const f = String(format || 'md').toLowerCase();
  // 已经是字符串就直接用（模型通常直接给 markdown）
  if (typeof data === 'string') return data;

  if (f === 'json') return JSON.stringify(data, null, 2);

  if (f === 'csv') {
    // data 期望是 [{...}, {...}] 或 {headers, rows}
    const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
    const headers =
      Array.isArray(data?.headers) && data.headers.length
        ? data.headers
        : rows.length
          ? Object.keys(rows[0])
          : [];
    if (!headers.length) return '';
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r?.[h])).join(','))].join('\n');
  }

  if (f === 'txt') {
    if (Array.isArray(data)) return data.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    return typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  }

  // md：对象数组渲染成表格
  if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
    const headers = Object.keys(data[0]);
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = data.map((r) => `| ${headers.map((h) => String(r?.[h] ?? '')).join(' | ')} |`);
    return [head, sep, ...body].join('\n');
  }
  if (typeof data === 'object') {
    return Object.entries(data)
      .map(([k, v]) => `- **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
  }
  return String(data);
}

/** 校验要写入的内容。 */
export function validateContent(content) {
  const text = typeof content === 'string' ? content : serialize(content);
  if (!text) throw new Error('没有可写入的内容');
  if (text.length > MAX_FILE_CHARS) {
    throw new Error(`内容过长（${text.length} 字符，上限 ${MAX_FILE_CHARS}）`);
  }
  return text;
}

/** 组装下载用的 MIME。 */
export function mimeOf(filename) {
  return MIME[extOf(filename)] || 'text/plain;charset=utf-8';
}

/* ============================================================
   目录句柄的持久化
   ------------------------------------------------------------
   File System Access 的目录句柄可以存进 IndexedDB，
   浏览器会在下次会话里要求「重新确认权限」，但不需要重新选目录。
   ============================================================ */

const DB_NAME = 'pumpkin-star';
const STORE = 'handles';
const DIR_KEY = 'outputDir';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** 让用户选一个输出目录（必须在用户手势里调用）。 */
export async function chooseOutputDir() {
  if (!window.showDirectoryPicker) {
    throw new Error('当前浏览器不支持选择本地文件夹（需要 Chromium 内核且为安全上下文）');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'lightning-output' });
  // 立刻要一次写权限，避免之后每次写都要确认
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('没有获得该文件夹的写入权限');
  await idbSet(DIR_KEY, handle);
  return { name: handle.name };
}

/** 取回已保存的目录句柄（不弹选择框）。 */
export async function getOutputDir() {
  const handle = await idbGet(DIR_KEY);
  if (!handle) return null;
  // 浏览器可能降级了权限，这里主动确认一次
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return handle;
  // 没权限就尝试重新申请（如果这次调用源自用户手势，会成功）
  const asked = await handle.requestPermission({ mode: 'readwrite' });
  return asked === 'granted' ? handle : null;
}

/** 忘记已选的目录。 */
export async function forgetOutputDir() {
  await idbDel(DIR_KEY);
  return { forgotten: true };
}

/**
 * 往已授权的目录里写文件。
 * @param {string} filename
 * @param {string} content
 */
export async function writeToOutputDir(filename, content) {
  const dir = await getOutputDir();
  if (!dir) throw new Error('尚未授权输出文件夹，请先在设置里选择');

  const name = sanitizeFilename(filename);
  const ext = extOf(name);
  if (!isAllowedExt(ext)) {
    throw new Error(`出于安全考虑，不允许写入 .${ext} 文件（支持：${SAFE_EXT.join(', ')}）`);
  }
  const text = validateContent(content);

  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();

  return { name, chars: text.length, dir: dir.name };
}
