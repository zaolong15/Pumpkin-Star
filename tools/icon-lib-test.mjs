#!/usr/bin/env node
/**
 * icon-lib-test.mjs —— 校验内置图标库。
 *
 * 图标是纯路径字符串，肉眼看不到，很容易写出跑出画布、命令不合法
 * 或退化成一条线的图形。这里做静态校验。
 *
 * 关键：必须实现一个**正确的路径解析器**。
 * 第一版按"数字成对即 x,y"来读，遇到相对命令（c/s/q 等小写）
 * 就把相对偏移当绝对坐标算，得出完全错误的包围盒。
 * 下面按 SVG 规范逐命令推进游标。
 *
 * 用法：node tools/icon-lib-test.mjs
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

/* ---------------- 路径解析：算出真实包围盒 ---------------- */

/** 每个命令消耗的参数个数。 */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * 解析 SVG 路径，返回 { bounds, errors }。
 * 支持绝对/相对命令与隐式重复（M 后跟多组坐标视作 L）。
 */
function analyzePath(d) {
  const errors = [];
  // 拆成 [命令, 参数字符串] 序列
  const tokens = [...d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let prevCmd = null;

  const track = (px, py) => {
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  };

  for (const [, rawCmd, rawArgs] of tokens) {
    const upper = rawCmd.toUpperCase();
    const rel = rawCmd !== upper;
    const arity = ARITY[upper];
    if (arity === undefined) {
      errors.push(`非法命令 "${rawCmd}"`);
      continue;
    }
    const nums = (rawArgs.match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) || []).map(Number);

    if (upper === 'Z') {
      x = startX;
      y = startY;
      track(x, y);
      prevCmd = upper;
      continue;
    }
    if (arity > 0 && nums.length === 0) {
      errors.push(`命令 ${rawCmd} 缺少参数`);
      continue;
    }
    if (nums.length % arity !== 0) {
      errors.push(`命令 ${rawCmd} 参数个数 ${nums.length} 不是 ${arity} 的倍数`);
    }

    // 逐组消费参数
    const groups = Math.floor(nums.length / arity);
    let isFirstGroup = true;
    for (let g = 0; g < groups; g += 1) {
      const a = nums.slice(g * arity, (g + 1) * arity);
      // M 的后续组按 L 处理（SVG 规范）
      const cmd = upper === 'M' && !isFirstGroup ? 'L' : upper;
      isFirstGroup = false;

      let nx = x;
      let ny = y;
      switch (cmd) {
        case 'M':
          nx = rel ? x + a[0] : a[0];
          ny = rel ? y + a[1] : a[1];
          startX = nx;
          startY = ny;
          track(nx, ny);
          break;
        case 'L':
          nx = rel ? x + a[0] : a[0];
          ny = rel ? y + a[1] : a[1];
          track(nx, ny);
          break;
        case 'H':
          nx = rel ? x + a[0] : a[0];
          track(nx, y);
          break;
        case 'V':
          ny = rel ? y + a[0] : a[0];
          track(x, ny);
          break;
        case 'C': {
          // 两个控制点也要计入包围盒（曲线可能外扩）
          const p1 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
          const p2 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
          nx = rel ? x + a[4] : a[4];
          ny = rel ? y + a[5] : a[5];
          track(p1[0], p1[1]);
          track(p2[0], p2[1]);
          track(nx, ny);
          break;
        }
        case 'S':
        case 'Q': {
          const p1 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
          nx = rel ? x + a[2] : a[2];
          ny = rel ? y + a[3] : a[3];
          track(p1[0], p1[1]);
          track(nx, ny);
          break;
        }
        case 'T':
          nx = rel ? x + a[0] : a[0];
          ny = rel ? y + a[1] : a[1];
          track(nx, ny);
          break;
        case 'A':
          nx = rel ? x + a[5] : a[5];
          ny = rel ? y + a[6] : a[6];
          track(nx, ny);
          break;
        default:
          errors.push(`未处理的命令 ${cmd}`);
      }
      x = nx;
      y = ny;
    }
    prevCmd = upper;
  }
  void prevCmd;

  return {
    bounds: { minX, maxX, minY, maxY },
    errors,
    hasContent: Number.isFinite(minX),
  };
}

/* ---------------- 读图标库 ---------------- */

const src = await readFile(path.join(root, 'src/panel/icons.js'), 'utf8');

// 直接 import 真实模块，而不是用正则从源码里"数"。
// 之前的正则会因为条目内的注释块（注释里的 } 提前闭合）少数一个图标。
const mod = await import(
  `file:///${path.join(root, 'src/panel/icons.js').replace(/\\/g, '/')}`
);
const icons = mod.ICON_LIBRARY.map((i) => ({ id: i.id, name: i.name, paths: i.paths }));

/* ---------------- 开测 ---------------- */

console.log('\n图标库校验\n');

console.log('[1] 结构');
check(icons.length >= 18, `图标数量足够（${icons.length} 个）`);
check(new Set(icons.map((i) => i.id)).size === icons.length, 'id 无重复');
check(icons.every((i) => i.name && i.name.length > 0), '每个图标都有名字');
check(icons.every((i) => i.paths.length > 0), '每个图标至少有一条路径');

console.log('\n[2] 路径解析无错误');
{
  const allErrors = [];
  for (const icon of icons) {
    for (const d of icon.paths) {
      const { errors } = analyzePath(d);
      for (const e of errors) allErrors.push(`${icon.id}: ${e}`);
    }
  }
  check(allErrors.length === 0, `全部路径合法${allErrors.length ? `\n       ${allErrors.join('\n       ')}` : ''}`);
}

console.log('\n[3] 包围盒在视口内（相对命令已正确解析）');
{
  const out = [];
  for (const icon of icons) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const d of icon.paths) {
      const { bounds, hasContent } = analyzePath(d);
      if (!hasContent) continue;
      minX = Math.min(minX, bounds.minX);
      maxX = Math.max(maxX, bounds.maxX);
      minY = Math.min(minY, bounds.minY);
      maxY = Math.max(maxY, bounds.maxY);
    }
    // 允许少量溢出（曲线控制点常略微超出视觉边界）
    const ok = minX >= -6 && maxX <= 30 && minY >= -6 && maxY <= 30;
    if (!ok) out.push(`${icon.id}: x[${minX.toFixed(1)},${maxX.toFixed(1)}] y[${minY.toFixed(1)},${maxY.toFixed(1)}]`);
  }
  check(out.length === 0, `全部图标大致在视口内${out.length ? `\n       ${out.join('\n       ')}` : ''}`);
}

console.log('\n[4] 图形有实际尺寸（不是退化成点或线）');
{
  const tiny = [];
  for (const icon of icons) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const d of icon.paths) {
      const { bounds, hasContent } = analyzePath(d);
      if (!hasContent) continue;
      minX = Math.min(minX, bounds.minX);
      maxX = Math.max(maxX, bounds.maxX);
      minY = Math.min(minY, bounds.minY);
      maxY = Math.max(maxY, bounds.maxY);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (w < 6 || h < 6) tiny.push(`${icon.id}: ${w.toFixed(1)}x${h.toFixed(1)}`);
  }
  check(tiny.length === 0, `没有退化图形${tiny.length ? `（${tiny.join(', ')}）` : ''}`);
}

console.log('\n[5] 每个图标视觉大小接近（不会有的特别大有的特别小）');
{
  const sizes = icons.map((icon) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const d of icon.paths) {
      const { bounds, hasContent } = analyzePath(d);
      if (!hasContent) continue;
      minX = Math.min(minX, bounds.minX); maxX = Math.max(maxX, bounds.maxX);
      minY = Math.min(minY, bounds.minY); maxY = Math.max(maxY, bounds.maxY);
    }
    return { id: icon.id, size: Math.max(maxX - minX, maxY - minY) };
  });
  const avg = sizes.reduce((s, x) => s + x.size, 0) / sizes.length;
  const off = sizes.filter((s) => Math.abs(s.size - avg) > avg * 0.75);
  check(off.length === 0,
    `图标尺寸均衡（平均 ${avg.toFixed(1)}）${off.length ? `，偏离：${off.map((o) => `${o.id}=${o.size.toFixed(1)}`).join(', ')}` : ''}`);
}

console.log('\n[6] 导出函数');
check(/export function getIcon/.test(src), '导出 getIcon');
check(/export function renderIcon/.test(src), '导出 renderIcon');
check(/export function iconSvgString/.test(src), '导出 iconSvgString');
// 兜底检查：只要在 getIcon 函数体里同时出现 find 和 ICON_LIBRARY[0] 即可。
// 不用复杂正则 —— 之前用 [^)]* 会在第一个 ) 处截断，误判成没有兜底。
{
  const fn = src.match(/export function getIcon\([\s\S]*?\n\}/)?.[0] || '';
  check(Boolean(fn), '能取到 getIcon 函数体');
  check(fn.includes('ICON_LIBRARY.find') && fn.includes('ICON_LIBRARY[0]'),
    'getIcon 有兜底（取不到返回第一个）');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log(`\u2713 图标库校验通过（${icons.length} 个图标）。`);
