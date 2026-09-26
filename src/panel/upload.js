/**
 * upload.js —— 读取用户选中的本地文件。
 *
 * 浏览器安全约束：扩展**无法自行读取磁盘**，必须由用户主动选择文件。
 * 这是硬性限制，不是设计取舍。所以这里的流程是：
 *   用户点「附加文件」→ 系统文件选择框 → 读取内容 → 作为任务上下文
 *
 * 支持的读取方式：
 *   - 文本类（md/txt/json/csv/代码）：直接读成字符串
 *   - 图片：读成 data URL，交给支持视觉的模型
 *   - 其它二进制：只报告元信息，不读内容（避免塞爆上下文）
 */

/** 单文件大小上限（字节）。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
/** 单个任务最多附带几个文件。 */
export const MAX_FILES = 5;
/** 文本类文件读入上下文的字符上限。 */
export const MAX_TEXT_CHARS = 100_000;

/** 按扩展名判断读取方式。 */
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh',
  'sql', 'ini', 'toml', 'conf', 'env', 'gitignore', 'vue', 'svelte',
];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

export function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

export function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXT.includes(e)) return 'image';
  if (TEXT_EXT.includes(e)) return 'text';
  return 'binary';
}

/** 人类可读的大小。 */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 读取单个 File 对象，返回结构化结果。 */
export function readFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('没有文件'));

    const kind = kindOf(file.name);

    if (file.size > MAX_FILE_BYTES && kind !== 'image') {
      return resolve({
        name: file.name,
        size: file.size,
        kind: 'too-large',
        note: `文件过大（${formatSize(file.size)}，上限 ${formatSize(MAX_FILE_BYTES)}），未读取内容`,
      });
    }

    const reader = new FileReader();

    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));

    reader.onload = () => {
      const raw = reader.result;

      if (kind === 'image') {
        // 图片转 data URL，交给支持视觉的模型
        resolve({
          name: file.name,
          size: file.size,
          kind: 'image',
          dataUrl: String(raw),
          // 超过 1MB 的图片不直接塞进上下文，只给元信息
          tooBigForContext: file.size > 1024 * 1024,
        });
        return;
      }

      if (kind === 'text') {
        const text = String(raw || '');
        resolve({
          name: file.name,
          size: file.size,
          kind: 'text',
          text: text.slice(0, MAX_TEXT_CHARS),
          truncated: text.length > MAX_TEXT_CHARS,
        });
        return;
      }

      // 二进制：只给元信息
      resolve({
        name: file.name,
        size: file.size,
        kind: 'binary',
        note: '二进制文件，未读取内容',
      });
    };

    if (kind === 'image') reader.readAsDataURL(file);
    else if (kind === 'text') reader.readAsText(file, 'utf-8');
    else reader.readAsArrayBuffer(file); // 只为了拿到大小，不解析
  });
}

/** 批量读取（带数量上限）。 */
export async function readFiles(fileList) {
  const files = Array.from(fileList || []).slice(0, MAX_FILES);
  const out = [];
  for (const f of files) {
    try {
      out.push(await readFile(f));
    } catch (err) {
      out.push({ name: f.name, kind: 'error', note: String(err?.message || err) });
    }
  }
  return out;
}

/**
 * 转义文件内容里可能伪造边界的标签。
 *
 * 文件内容会拼进提示词，如果里面含 `</file>` 就能伪造出新标签，
 * 让模型看到错误的文件边界。文件可能来自任何来源（下载的、别人发的），
 * 所以不能假设它可信。
 * 只转义尖括号，不影响可读性。
 */
function escapeTags(text) {
  return String(text ?? '').replace(/<\/?file\b/gi, (m) => m.replace(/[<>]/g, (c) => (c === '<' ? '＜' : '＞')));
}

/**
 * 把读到的文件拼成给模型看的上下文。
 * 用 XML 风格的标签包裹，避免和用户的话混在一起。
 */
export function renderFiles(files) {
  if (!files?.length) return '';
  const parts = [];
  for (const f of files) {
    if (f.kind === 'text') {
      parts.push(
        `<file name="${escapeTags(f.name)}">\n${escapeTags(f.text)}${
          f.truncated ? '\n…（内容过长已截断）' : ''
        }\n</file>`,
      );
    } else if (f.kind === 'image') {
      parts.push(
        `<file name="${escapeTags(f.name)}" type="image">${
          f.tooBigForContext ? '（图片较大，未直接读入）' : '（见附带的图片内容）'
        }</file>`,
      );
    } else {
      parts.push(
        `<file name="${escapeTags(f.name)}" size="${formatSize(f.size)}">${escapeTags(f.note || '')}</file>`,
      );
    }
  }
  return parts.join('\n\n');
}

/** 给界面用的简短摘要。 */
export function summarizeFiles(files) {
  if (!files?.length) return '';
  return files
    .map((f) => {
      if (f.kind === 'text') return `${f.name}（文本，${formatSize(f.size)}）`;
      if (f.kind === 'image') return `${f.name}（图片，${formatSize(f.size)}）`;
      return `${f.name}（${formatSize(f.size)}）`;
    })
    .join('、');
}
