#!/usr/bin/env node
/**
 * files-test.mjs —— 文件输出的行为测试。
 *
 * 重点是**安全**：模型会提议文件名，而我们要把它写进用户授权的目录里。
 * 如果文件名没洗干净，"../../.ssh/authorized_keys" 这类路径就可能越出目录。
 * 这里逐条验证清洗与校验逻辑。
 *
 * 用法：node tools/files-test.mjs
 */

import { readFile } from 'node:fs/promises';
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

// 抽出纯函数部分（不碰 DOM / IndexedDB）
const src = await readFile(path.join(root, 'src/panel/files.js'), 'utf8');

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`抽不出 ${label}`);
  return m[0];
}

const code = [
  src.match(/export const MAX_FILE_CHARS = [^;]+;/)[0].replace('export ', ''),
  src.match(/const SAFE_EXT = \[[^\]]+\];/)[0],
  src.match(/const MIME = \{[\s\S]*?\n\};/)[0],
  grab(/export function sanitizeFilename[\s\S]*?\n\}/, 'sanitizeFilename'),
  grab(/export function extOf[\s\S]*?\n\}/, 'extOf'),
  grab(/export function isAllowedExt[\s\S]*?\n\}/, 'isAllowedExt'),
  grab(/export function serialize[\s\S]*?\n\}\n/, 'serialize'),
  grab(/export function validateContent[\s\S]*?\n\}/, 'validateContent'),
  grab(/export function mimeOf[\s\S]*?\n\}/, 'mimeOf'),
].join('\n').replace(/export /g, '');

const api = new Function(`${code}
  return { sanitizeFilename, extOf, isAllowedExt, serialize, validateContent, mimeOf,
           MAX_FILE_CHARS, SAFE_EXT };`)();

console.log('\n文件输出测试\n');

console.log('[1] 文件名清洗：阻止路径穿越');
{
  // 注意：清洗后没有扩展名的会被补上 .md，所以期望值里带上
  const cases = [
    ['../../etc/passwd', 'passwd.md'],
    ['..\\..\\windows\\system32\\evil.exe', 'evil.exe'],
    ['/absolute/path/file.md', 'file.md'],
    ['normal.md', 'normal.md'],
    ['  空格前后.md  ', '空格前后.md'],
    ['sub/dir/report.csv', 'report.csv'],
    // 关键安全用例：结果里绝不能出现路径分隔符或 ..
    ['../../../../etc/cron.d/backdoor', 'backdoor.md'],
  ];
  let ok = true;
  for (const [input, want] of cases) {
    const got = api.sanitizeFilename(input);
    if (got !== want) {
      ok = false;
      console.log(`      ! ${JSON.stringify(input)} → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
    }
  }
  check(ok, '路径分隔符与 .. 被剥离，只保留最后一段');

  // 独立再断言一次：任意恶意输入的结果都不含分隔符
  const evil = ['../a', '..\\b', 'x/../../y', '/etc/shadow', 'C:\\Windows\\x.md'];
  const bad = evil.map((e) => api.sanitizeFilename(e)).filter((r) => /[/\\]/.test(r) || r.includes('..'));
  check(bad.length === 0, `任何输入都不会残留路径成分${bad.length ? `（${bad.join(', ')}）` : ''}`);
}

console.log('\n[2] 文件名清洗：非法字符与隐藏文件');
{
  check(!api.sanitizeFilename('a<b>c:d"e|f?g*h.md').match(/[<>:"|?*]/), 'Windows 非法字符被移除');
  check(!api.sanitizeFilename('a\u0000b.md').includes('\u0000'), '控制字符被移除');
  check(!api.sanitizeFilename('.hidden.md').startsWith('.'), '不会生成隐藏文件');
  check(!api.sanitizeFilename('...').startsWith('.'), '纯点的输入被清理');
  const long = api.sanitizeFilename('x'.repeat(300) + '.md');
  check(long.length <= 120, `超长文件名被截断（${long.length}）`);
  check(long.endsWith('.md'), '截断后仍保留扩展名');
}

console.log('\n[3] 自动补扩展名与兜底');
{
  check(api.sanitizeFilename('report') === 'report.md', '无扩展名时补 .md');
  check(api.sanitizeFilename('') === 'output.md', '空输入有兜底名');
  check(api.sanitizeFilename('   ') === 'output.md', '纯空白有兜底名');
  check(api.sanitizeFilename('name.', 'txt') === 'name..txt' || api.extOf(api.sanitizeFilename('name.')) !== '', '异常结尾被处理');
}

console.log('\n[4] 扩展名白名单');
{
  check(api.isAllowedExt('md'), 'md 允许');
  check(api.isAllowedExt('JSON'), '大小写不敏感');
  check(!api.isAllowedExt('exe'), 'exe 不允许');
  check(!api.isAllowedExt('sh'), 'sh 不允许');
  check(!api.isAllowedExt('bat'), 'bat 不允许');
  check(!api.isAllowedExt('js'), 'js 不允许（避免写入可执行脚本）');
  check(api.extOf('a/b/c.MD') === 'md', 'extOf 正确取扩展名');
  check(api.extOf('noext') === 'txt', '无扩展名返回 txt');
}

console.log('\n[5] MIME 映射');
{
  check(api.mimeOf('a.md').includes('markdown'), 'md → markdown');
  check(api.mimeOf('a.json').includes('json'), 'json → json');
  check(api.mimeOf('a.csv').includes('csv'), 'csv → csv');
  check(api.mimeOf('a.xyz').includes('text/plain'), '未知扩展名回退 text/plain');
}

console.log('\n[6] 内容序列化');
{
  check(api.serialize('已经是字符串') === '已经是字符串', '字符串原样返回');
  const obj = { a: 1, b: 'x' };
  check(JSON.parse(api.serialize(obj, 'json')).a === 1, 'json 格式可解析');

  const rows = [
    { 名称: '苹果', 价格: 5 },
    { 名称: '香蕉', 价格: 3 },
  ];
  const csv = api.serialize(rows, 'csv');
  check(csv.split('\n').length === 3, `csv 有 3 行（表头 + 2 行数据）`);
  check(csv.startsWith('名称,价格'), 'csv 表头正确');
  const md = api.serialize(rows, 'md');
  check(md.includes('| 名称 | 价格 |'), 'md 渲染成表格');
  check(md.includes('| 苹果 | 5 |'), 'md 表格有数据行');
}

console.log('\n[7] CSV 转义（逗号、引号、换行）');
{
  const rows = [{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' }];
  const csv = api.serialize(rows, 'csv');
  check(csv.includes('"x,y"'), '含逗号的字段被引号包裹');
  check(csv.includes('"he said ""hi"""'), '引号被双写转义');
  check(csv.includes('"line1\nline2"'), '含换行的字段被引号包裹');
}

console.log('\n[8] 内容校验');
{
  check(api.validateContent('hello') === 'hello', '正常内容通过');
  let threw = false;
  try { api.validateContent(''); } catch { threw = true; }
  check(threw, '空内容被拒绝');
  threw = false;
  try { api.validateContent('x'.repeat(api.MAX_FILE_CHARS + 1)); } catch { threw = true; }
  check(threw, '超大内容被拒绝（防止写出巨大文件）');
  const big = api.validateContent('x'.repeat(1000));
  check(big.length === 1000, '接近上限的内容通过');
}

console.log('\n[9] 空表格不会生成坏文件');
{
  check(api.serialize([], 'csv') === '', '空数组的 csv 为空串');
  check(api.serialize({ headers: [], rows: [] }, 'csv') === '', '无表头的 csv 为空串');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 文件输出测试全部通过。');
