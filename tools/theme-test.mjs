#!/usr/bin/env node
/**
 * theme-test.mjs —— 主题引擎与外观设置的行为测试。
 *
 * 抽出 panel.js 里的主题函数真跑，验证：
 *   颜色解析、派生色计算、明暗判定、变量写入、非法输入回退。
 *
 * 用法：node tools/theme-test.mjs
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

/* ---------------- 把主题函数从 panel.js 里抽出来单跑 ---------------- */

const panelSrc = await readFile(path.join(root, 'src/panel/panel.js'), 'utf8');

// 默认设置直接从真实模块导入，别手搓 JSON 解析
const { DEFAULT_SETTINGS } = await import(
  `file:///${path.join(root, 'src/shared/messages.js').replace(/\\/g, '/')}`
);

function extract(name) {
  // 匹配 const name = ... ;  或  function name(...) { ... }
  const fn = panelSrc.match(new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm'));
  if (fn) return fn[0];
  const arrow = panelSrc.match(new RegExp(`^const ${name} = [\\s\\S]*?;\\n`, 'm'));
  if (arrow) return arrow[0];
  throw new Error(`抽不出 ${name}`);
}

const pieces = [
  extract('parseHex'),
  extract('rgbToHsl'),
  extract('clamp'),
  extract('shade'),
  extract('isLightColor'),
  extract('resolveMode'),
].join('\n');

// 假的 document / window，用来承接 applyTheme 的写入
const written = new Map();
const attrs = new Map();
const fake = {
  document: {
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, v),
      getAttribute: (k) => attrs.get(k),
      style: {
        setProperty: (k, v) => written.set(k, v),
        removeProperty: (k) => written.delete(k),
      },
    },
  },
  window: {
    matchMedia: (q) => ({ matches: q.includes('light') }),
  },
};

const applyThemeSrc = panelSrc.match(/function applyTheme\(theme\) \{[\s\S]*?\n\}/)[0];

// syncFloatTheme 依赖 chrome，桩掉
const factory = new Function('document', 'window', 'DEFAULT_SETTINGS', 'syncFloatTheme', `
  ${pieces}
  ${applyThemeSrc}
  return { parseHex, rgbToHsl, shade, clamp, isLightColor, resolveMode, applyTheme };
`);

const theme = factory(
  fake.document,
  fake.window,
  DEFAULT_SETTINGS,
  () => {},
);

/* ---------------- 开测 ---------------- */

console.log('\n主题引擎测试\n');

console.log('[1] 颜色解析');
check(theme.parseHex('#4f8cff').r === 0x4f, '解析 6 位十六进制');
check(theme.parseHex('4f8cff').g === 0x8c, '不带 # 也能解析');
check(theme.parseHex('#abc').r === 0xaa, '3 位缩写展开为 6 位');
check(theme.parseHex('#ABC').b === 0xcc, '大写十六进制');
check(theme.parseHex('') === null, '空串返回 null');
check(theme.parseHex('#xyzxyz') === null, '非法字符返回 null');
check(theme.parseHex('#12345') === null, '位数不对返回 null');
check(theme.parseHex(null) === null, 'null 返回 null');

console.log('\n[2] HSL 转换');
let hsl = theme.rgbToHsl({ r: 255, g: 0, b: 0 });
check(Math.round(hsl.h) === 0 && Math.round(hsl.s) === 100 && Math.round(hsl.l) === 50, '纯红 → hsl(0,100%,50%)');
hsl = theme.rgbToHsl({ r: 0, g: 255, b: 0 });
check(Math.round(hsl.h) === 120, '纯绿 → 色相 120');
hsl = theme.rgbToHsl({ r: 128, g: 128, b: 128 });
check(Math.round(hsl.s) === 0, '灰色饱和度为 0');

console.log('\n[3] 明暗判定（决定按钮文字用黑还是白）');
check(theme.isLightColor({ r: 255, g: 255, b: 255 }) === true, '白色判定为亮色');
check(theme.isLightColor({ r: 0, g: 0, b: 0 }) === false, '黑色判定为暗色');
check(theme.isLightColor({ r: 79, g: 140, b: 255 }) === false, '默认蓝色判定为暗色（文字用白）');
check(theme.isLightColor({ r: 250, g: 240, b: 120 }) === true, '明黄判定为亮色（文字用黑）');

console.log('\n[4] 派生色计算');
const s = theme.shade({ h: 220, s: 100, l: 65 }, -10);
check(s.includes('hsl('), '返回 hsl 字符串');
check(s.includes('55'), `明度被降低（${s}）`);
const clamped = theme.shade({ h: 220, s: 100, l: 95 }, 20);
check(clamped.includes('100'), '明度被钳制在 100 以内');

console.log('\n[5] 深浅模式解析');
check(theme.resolveMode('light') === 'light', '显式浅色');
check(theme.resolveMode('dark') === 'dark', '显式深色');
check(theme.resolveMode('system') === 'light', 'system 时读取系统偏好（桩为 light）');
check(theme.resolveMode(undefined) === 'light', '未设置时按 system 处理');

console.log('\n[6] applyTheme 写入正确');
written.clear();
attrs.clear();
theme.applyTheme({
  accent: '#10b981',
  mode: 'dark',
  glass: 'tint',
  radius: 0.5,
  density: 'compact',
  motion: false,
});
check(written.get('--accent') === '#10b981', `主题色写入正确（${written.get('--accent')}）`);
check(attrs.get('data-mode') === 'dark', '深浅模式写入 data-mode');
check(attrs.get('data-glass') === 'tint', '玻璃模式写入 data-glass');
check(attrs.get('data-density') === 'compact', '密度写入 data-density');
check(attrs.get('data-motion') === 'off', '关闭动效写入 data-motion=off');
check(written.get('--radius') === '8.0px', `圆角 0.5 → 8px（${written.get('--radius')}）`);
check(Boolean(written.get('--accent-hover')), '派生出 hover 色');
check(Boolean(written.get('--accent-soft')), '派生出浅底色');
check(written.get('--accent-on') === '#ffffff', '暗色主题色的按钮文字为白色');
check(attrs.get('data-accent') === 'custom', '使用自定义色时标记 data-accent=custom');

console.log('\n[6b] 中性模式（DSH 风格默认）');
written.clear();
attrs.clear();
theme.applyTheme({ accent: 'neutral', mode: 'dark' });
check(attrs.get('data-accent') === 'neutral', '中性模式标记 data-accent=neutral');
check(!written.has('--accent'), '中性模式下不写入 --accent（交由样式表按深浅决定）');
check(!written.has('--accent-on'), '中性模式下不写入 --accent-on');
// 先设自定义再切回中性，应当清掉之前的内联值
written.clear();
theme.applyTheme({ accent: '#ff0000', mode: 'dark' });
check(written.has('--accent'), '自定义色写入了 --accent');
theme.applyTheme({ accent: 'neutral', mode: 'dark' });
check(!written.has('--accent'), '切回中性后清掉了内联 --accent（否则会残留红色）');
written.clear();
theme.applyTheme({});
check(!written.has('--accent'), '默认设置即中性');

console.log('\n[7] 圆角映射边界');
written.clear();
theme.applyTheme({ radius: 0 });
check(written.get('--radius') === '4.0px', `最小圆角 4px（${written.get('--radius')}）`);
theme.applyTheme({ radius: 1 });
check(written.get('--radius') === '12.0px', `最大圆角 12px（${written.get('--radius')}）`);
theme.applyTheme({ radius: 5 });
check(written.get('--radius') === '12.0px', '超范围圆角被钳制');
theme.applyTheme({ radius: -3 });
check(written.get('--radius') === '4.0px', '负值圆角被钳制');

console.log('\n[8] 非法/缺失输入的回退');
written.clear();
theme.applyTheme({ accent: '不是颜色' });
check(written.get('--accent') === '#4f8cff', '非法主题色回退到默认蓝');
written.clear();
attrs.clear();
theme.applyTheme({});
check(attrs.get('data-glass') === DEFAULT_SETTINGS.theme.glass, '空设置使用默认玻璃模式');
theme.applyTheme(null);
check(attrs.get('data-glass') === DEFAULT_SETTINGS.theme.glass, 'null 不抛错且用默认值');

console.log('\n[9] 亮色主题色会切换按钮文字颜色');
written.clear();
theme.applyTheme({ accent: '#fde047', mode: 'dark' });
check(written.get('--accent-on') === '#0d0f14', '明黄主题色 → 按钮文字用深色');

console.log('\n[10] CSS 变量与样式表一致性');
const cssSrc = await readFile(path.join(root, 'src/panel/panel.css'), 'utf8');
const usedVars = new Set([...cssSrc.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
const definedInCss = new Set([...cssSrc.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
const definedByJs = new Set([
  '--radius', '--radius-sm', '--radius-lg',
  '--accent', '--accent-hover', '--accent-active', '--accent-soft', '--accent-on', '--accent-line',
  // 色板圆点的颜色由 JS 逐个 setProperty('--sw', ...) 写入
  '--sw',
]);
// 反向确认：JS 里确实写了 --sw，不是漏定义
const writesSw = /setProperty\(\s*'--sw'/.test(panelSrc);
check(writesSw, '--sw 确实由 JS 写入（不是漏定义）');
const missing = [...usedVars].filter((v) => !definedInCss.has(v) && !definedByJs.has(v));
check(missing.length === 0, `所有 var() 都有定义${missing.length ? `（缺 ${missing.join(', ')}）` : ''}`);
check(definedInCss.has('--glass-bg'), 'CSS 定义了玻璃背景变量');
check(definedInCss.has('--radius'), 'CSS 有圆角默认值（避免 JS 未跑时塌陷）');

console.log('\n[11] 文字对比度（WCAG）');
{
  const block = (sel) => {
    const m = cssSrc.match(new RegExp(`${sel}\\s*\\{([\\s\\S]*?)\\n\\}`));
    const out = {};
    if (!m) return out;
    for (const [, k, v] of m[1].matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
      const val = v.trim();
      // 只取纯色：hex 或 oklch(L% C H)（忽略带 alpha 的、以及 var() 引用）
      if (/^#[0-9a-f]{6}$/i.test(val)) out[k] = val;
      else {
        const om = val.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
        if (om) out[k] = { oklch: [Number(om[1]), Number(om[2]), Number(om[3])] };
      }
    }
    return out;
  };
  const darkVars = block(':root');
  const lightVars = block(":root\\[data-mode='light'\\]");

  /** oklch → sRGB → 相对亮度。oklch 用 Oklab 的 L/C/h 定义。 */
  const lumOf = (color) => {
    if (typeof color === 'string') {
      const h = color.replace('#', '');
      const c = [0, 2, 4]
        .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    // oklch → Oklab → LMS → 线性 sRGB
    const [Lp, C, Hdeg] = color.oklch;
    const L = Lp / 100;
    const hRad = (Hdeg * Math.PI) / 180;
    const a = C * Math.cos(hRad);
    const b2 = C * Math.sin(hRad);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b2;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b2;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b2;
    const l = l_ ** 3;
    const m = m_ ** 3;
    const s = s_ ** 3;
    const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    return 0.2126 * clamp01(rl) + 0.7152 * clamp01(gl) + 0.0722 * clamp01(bl);
  };

  const contrast = (a, b) => {
    const [x, y] = [lumOf(a), lumOf(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  for (const [label, set] of [['深色', darkVars], ['浅色', lightVars]]) {
    const bg = set['--bg'];
    check(Boolean(bg), `${label}定义了 --bg`);
    if (!bg) continue;
    const cMain = contrast(set['--fg'], bg);
    const cDim = contrast(set['--fg-dim'], bg);
    const cFaint = contrast(set['--fg-faint'], bg);
    check(cMain >= 7, `${label}正文对比度 ≥7（实测 ${cMain.toFixed(1)}）`);
    check(cDim >= 4, `${label}次要文字对比度 ≥4（实测 ${cDim.toFixed(1)}）`);
    check(cFaint >= 3, `${label}微弱文字对比度 ≥3（实测 ${cFaint.toFixed(1)}）`);
  }
  // 浅色模式必须覆盖语义色，否则深色版的亮色在白底上看不清
  for (const key of ['--ok', '--warn', '--err']) {
    check(Boolean(lightVars[key]), `浅色模式定义了 ${key}`);
    check(
      JSON.stringify(lightVars[key]) !== JSON.stringify(darkVars[key]),
      `浅色模式的 ${key} 与深色不同`,
    );
  }
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 主题测试全部通过。');
