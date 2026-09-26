#!/usr/bin/env node
/**
 * make-icons.mjs —— 生成扩展图标。
 *
 * 手工用贝塞尔/几何路径绘制，不依赖任何图形库：
 *   圆角方形底 + 一个"对话气泡 + 光标"的组合，表达"会动手的对话助手"。
 * 所有坐标在 128x128 画布上定义，再按比例缩放到各尺寸，保证矢量感。
 *
 * 用法：node tools/make-icons.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'icons');

const SIZES = [16, 32, 48, 128];
const SS = 4; // 超采样倍数，抗锯齿

/* ---------------- 几何工具 ---------------- */

const lerp = (a, b, t) => a + (b - a) * t;

/** 圆角矩形：返回点是否在内部。 */
function inRoundRect(x, y, left, top, right, bottom, r) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点到线段的距离，用于描边。 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 点到二次贝塞尔曲线的距离（采样近似）。
 * 精确解要解五次方程，图标描边用采样足够，取 24 段已经看不出锯齿。
 */
function distToQuad(px, py, x0, y0, x1, y1, x2, y2) {
  let best = Infinity;
  const N = 24;
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const mt = 1 - t;
    const bx = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
    const by = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
    best = Math.min(best, Math.hypot(px - bx, py - by));
  }
  return best;
}

/** 点是否在多边形内（射线法）。 */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 缩放后的绘图上下文：设计坐标 128x128 → 目标像素。
 * 所有绘制函数接收设计坐标，内部换算。
 */
function createCanvas(size) {
  const w = size * SS;
  const s = w / 128; // 设计单位 → 超采样像素
  const px = new Float64Array(w * w * 4); // RGBA 0..1

  /** 按 alpha 混合一层颜色。shape(x,y) 返回该点覆盖强度 0..1（已含 AA）。 */
  function fill(shape, [r, g, b], alpha = 1) {
    for (let y = 0; y < w; y += 1) {
      for (let x = 0; x < w; x += 1) {
        // 超采样内部按 2x2 抖动采样，边缘更平滑
        let cov = 0;
        const N = 2;
        for (let sy = 0; sy < N; sy += 1) {
          for (let sx = 0; sx < N; sx += 1) {
            const px0 = (x + (sx + 0.5) / N) / s;
            const py0 = (y + (sy + 0.5) / N) / s;
            cov += shape(px0, py0) ? 1 : 0;
          }
        }
        cov /= N * N;
        if (cov === 0) continue;
        const i = (y * w + x) * 4;
        const a = cov * alpha;
        const dstA = px[i + 3];
        const outA = a + dstA * (1 - a);
        if (outA === 0) continue;
        px[i] = (r * a + px[i] * dstA * (1 - a)) / outA;
        px[i + 1] = (g * a + px[i + 1] * dstA * (1 - a)) / outA;
        px[i + 2] = (b * a + px[i + 2] * dstA * (1 - a)) / outA;
        px[i + 3] = outA;
      }
    }
  }

  /**
   * 把形状覆盖的区域"擦除"（alpha 归零）。
   * 用于做负空间 —— 直接在白色南瓜上挖出瓣纹缝隙。
   */
  function erase(shape) {
    for (let y = 0; y < w; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const N = 2;
        let cov = 0;
        for (let sy = 0; sy < N; sy += 1) {
          for (let sx = 0; sx < N; sx += 1) {
            const px0 = (x + (sx + 0.5) / N) / s;
            const py0 = (y + (sy + 0.5) / N) / s;
            cov += shape(px0, py0) ? 1 : 0;
          }
        }
        cov /= N * N;
        if (cov === 0) continue;
        const i = (y * w + x) * 4;
        px[i + 3] *= 1 - cov;
      }
    }
  }

  /** 导出为 PNG 像素（8bit RGBA）。 */
  function toRGBA() {
    const buf = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // 盒式下采样 SS×SS
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < SS; sy += 1) {
          for (let sx = 0; sx < SS; sx += 1) {
            const i = ((y * SS + sy) * w + (x * SS + sx)) * 4;
            const pa = px[i + 3];
            r += px[i] * pa;
            g += px[i + 1] * pa;
            b += px[i + 2] * pa;
            a += pa;
          }
        }
        const n = SS * SS;
        const o = (y * size + x) * 4;
        if (a > 0) {
          buf[o] = Math.round(Math.min(255, (r / a) * 255));
          buf[o + 1] = Math.round(Math.min(255, (g / a) * 255));
          buf[o + 2] = Math.round(Math.min(255, (b / a) * 255));
        }
        buf[o + 3] = Math.round(Math.min(255, (a / n) * 255));
      }
    }
    return buf;
  }

  return { fill, erase, toRGBA, size };
}

/**
 * 渐变填充：按 y 在两个颜色之间插值。
 * 分层写入同一个形状是安全的——因为每层只覆盖自己那条 y 带，
 * 带与带之间互不重叠，不会互相覆盖。
 */
function gradientFill(canvas, shape, top, bottom) {
  const bands = 64;
  for (let i = 0; i < bands; i += 1) {
    const t = bands === 1 ? 0 : i / (bands - 1);
    const y0 = (128 * i) / bands;
    const y1 = (128 * (i + 1)) / bands;
    const col = [
      lerp(top[0], bottom[0], t),
      lerp(top[1], bottom[1], t),
      lerp(top[2], bottom[2], t),
    ];
    canvas.fill((x, y) => y >= y0 && y < y1 && shape(x, y), col, 1);
  }
}

/* ---------------- 图标设计 ---------------- */

// 南瓜配色：上亮下深，暖橙
const PS_TOP = [1.0, 0.72, 0.30];
const PS_BOTTOM = [0.93, 0.45, 0.09];
// 瓜蒂的深绿
const STEM = [0.22, 0.45, 0.22];

/**
 * 主图形：圆角方底 + 白色南瓜剪影。
 *
 * 为什么用**剪影**而不是画细节：
 *   16px 下任何细节都会被抗锯齿吃掉。南瓜的识别特征只有两条 ——
 *   「扁圆的轮廓」和「顶部的小蒂」，所以只保留这两点：
 *     1. 一个略扁的椭圆体（比正圆宽一点，这是南瓜的关键比例）
 *     2. 顶部一个短小的梯形蒂
 *   中间的瓣纹用**负空间**表达（留白），而不是描线 ——
 *   描线在小尺寸会糊，留白则始终清晰。
 */
function drawIcon(size) {
  const c = createCanvas(size);

  // 1) 圆角方形底，带竖向渐变
  const bgShape = (x, y) => inRoundRect(x, y, 6, 6, 122, 122, 30);
  gradientFill(c, bgShape, PS_TOP, PS_BOTTOM);

  // 2) 南瓜主体：中心 (64,72)，横向半径 44，纵向半径 36
  //    宽 > 高 是南瓜的标志性比例（正圆会读成番茄/苹果）
  const cx = 64;
  const cy = 72;
  const rx = 44;
  const ry = 36;
  const body = (x, y) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  };
  c.fill(body, [1, 1, 1], 1);

  // 3) 瓜蒂：顶部一个小梯形，稍微向左歪（更自然）
  const stemPts =
    size <= 32
      ? [
          // 小尺寸：短粗，保证能看见
          [58, 22],
          [72, 22],
          [70, 38],
          [60, 38],
        ]
      : [
          [57, 20],
          [73, 20],
          [71, 38],
          [59, 38],
        ];
  c.fill((x, y) => inPolygon(x, y, stemPts), [1, 1, 1], 1);

  // 4) 瓣纹用负空间（挖掉两条竖向缝隙），而不是画线。
  //    缝隙很窄，小尺寸下会自然消失，不会让南瓜变成"裂开的圆"。
  if (size >= 48) {
    // 缝隙刻意做细做短：
    //   - 细：太宽会把南瓜切成三块，读起来像"裂开的圆"
    //   - 短：上下各留 9px 不收口，让轮廓保持完整
    //   - 两端收窄成纺锤形，模拟真实瓣纹的曲率
    const gapW = size >= 96 ? 2.0 : 1.5;
    const gapTop = cy - ry * 0.62;
    const gapBottom = cy + ry * 0.62;
    for (const off of [-21, 21]) {
      const gx = cx + off;
      c.erase(
        (x, y) =>
          body(x, y) &&
          y > gapTop &&
          y < gapBottom &&
          // 纺锤形：中间最宽，两端收到 0
          Math.abs(x - gx) <= gapW * (1 - ((y - cy) / (ry * 0.62)) ** 2),
      );
    }
  }

  return c.toRGBA();
}

/* ---------------- PNG 编码（零依赖） ---------------- */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前加 filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 主流程 ---------------- */

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const rgba = drawIcon(size);
  const png = encodePNG(rgba, size);
  await writeFile(path.join(outDir, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} B`);
}
console.log('\n图标已生成。');
