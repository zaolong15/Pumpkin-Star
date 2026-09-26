#!/usr/bin/env node
/**
 * icon-check.mjs —— 不看图也能验证图标是否正确。
 * 解码生成的 PNG，检查尺寸、透明通道、主要图形是否落在预期位置。
 *
 * 用法：node tools/icon-check.mjs
 */

import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
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

/** 极简 PNG 解码：只支持我们生成的 8bit RGBA、filter 0/1/2/3/4。 */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error(`不支持的位深/色型 ${data[8]}/${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prior[x];
      const c = x >= bpp ? prior[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, px };
}

const at = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return {
    r: img.px[i],
    g: img.px[i + 1],
    b: img.px[i + 2],
    a: img.px[i + 3],
  };
};

console.log('\n图标校验\n');

for (const size of [16, 32, 48, 128]) {
  const file = path.join(root, `icons/icon${size}.png`);
  let img;
  try {
    img = decodePNG(await readFile(file));
  } catch (err) {
    check(false, `icon${size}.png 无法解码：${err.message}`);
    continue;
  }

  console.log(`[icon${size}.png]`);
  check(img.width === size && img.height === size, `尺寸 ${img.width}x${img.height}`);

  const ratio = size / 128;
  const corner = at(img, 0, 0);
  check(corner.a < 40, `左上角透明（圆角生效，alpha=${corner.a}）`);
  const topMid = at(img, Math.floor(size / 2), Math.max(0, Math.round(8 * ratio)));
  check(topMid.a > 200, `顶部边缘不透明（alpha=${topMid.a}）`);
  check(topMid.r > topMid.b + 60, `底色是暖色/南瓜橙（r=${topMid.r} b=${topMid.b}）`);

  // ---- 南瓜主体校验 ----
  // 不再猜采样点：直接统计所有白色像素的分布与包围盒，
  // 这样无论哪个尺寸、形状怎么微调，判定都成立。
  let totalWhite = 0;
  let upperWhite = 0;
  let lowerWhite = 0;
  let minX = size;
  let maxX = -1;
  let minY = size;
  let maxY = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const p = at(img, x, y);
      if (p.a > 200 && p.r > 200 && p.g > 200 && p.b > 200) {
        totalWhite += 1;
        if (y < img.height / 2) upperWhite += 1;
        else lowerWhite += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  check(totalWhite > 0, `存在白色南瓜像素（${totalWhite} 个）`);
  check(upperWhite > 0 && lowerWhite > 0, '南瓜上下贯通（星体与瓜蒂都有白色）');

  const pw = maxX - minX + 1;
  const ph = maxY - minY + 1;

  // 关键比例：南瓜**瓜体**是扁圆的（宽 > 高）。
  // 注意不能量整个包围盒 —— 顶上还有瓜蒂，会把高度撑起来，
  // 使整体宽高比接近 1（实测正好 1.00）。所以先找瓜体起点：
  // 瓜蒂很窄，瓜体从"宽度突然变大"的那一行开始。
  const rowWidths = [];
  for (let y = minY; y <= maxY; y += 1) {
    let left = size;
    let right = -1;
    for (let x = 0; x < img.width; x += 1) {
      const p = at(img, x, y);
      if (p.a > 200 && p.r > 230 && p.g > 230 && p.b > 230) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (right >= 0) rowWidths.push({ y, w: right - left + 1 });
  }

  // 瓜体起点 = 宽度首次超过最大宽度一半的那一行（瓜蒂只有最大宽度的 ~20%）
  const maxRowW = Math.max(...rowWidths.map((r) => r.w));
  const bodyStart = rowWidths.find((r) => r.w > maxRowW * 0.5);
  const bodyHeight = bodyStart ? maxY - bodyStart.y + 1 : ph;
  const bodyRatio = pw / bodyHeight;

  check(
    bodyRatio > 1.05,
    `瓜体是扁圆形（${pw} 宽 x ${bodyHeight} 高，比例 ${bodyRatio.toFixed(2)} > 1）`,
  );
  check(bodyRatio < 1.9, `比例没夸张到不像南瓜（${bodyRatio.toFixed(2)}）`);
  const minH = size >= 32 ? 0.6 : 0.5;
  check(ph / size >= minH,
    `整体高度占比合理（${((ph / size) * 100).toFixed(0)}%，阈值 ${minH * 100}%）`);

  // 瓜蒂确实存在：顶部那一段应当明显窄于瓜体。
  // 16px 下瓜蒂会被圆整到只剩 1~2 行（实测 2 行），所以阈值按尺寸放宽。
  const stemRows = bodyStart ? bodyStart.y - minY : 0;
  const minStem = size >= 32 ? 3 : 1;
  check(
    stemRows >= minStem,
    `顶部有瓜蒂（前 ${stemRows} 行是窄的，阈值 ${minStem}）`,
  );

  const cxOff = Math.abs((minX + maxX) / 2 - (size - 1) / 2);
  check(cxOff <= size * 0.15, `南瓜水平居中（偏移 ${cxOff.toFixed(1)}px）`);

  // 南瓜底色应当占相当比例（说明渐变底铺满）
  {
    let orange = 0;
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        const p = at(img, x, y);
        if (p.a > 200 && p.r > p.b + 60) orange += 1;
      }
    }
    const or = orange / (size * size);
    check(or > 0.3, `南瓜底色占比合理（${(or * 100).toFixed(0)}%）`);
  }

  // 白色占比不能太高，否则星形糊成一块
  const whiteRatio = totalWhite / (size * size);
  check(whiteRatio > 0.03, `白色占比够看得见（${(whiteRatio * 100).toFixed(0)}%）`);
  check(whiteRatio < 0.45, `白色占比合理、没糊成一块（${(whiteRatio * 100).toFixed(0)}%）`);

  // 南瓜特征：**横向宽度随高度先增后减**（椭圆轮廓），
  // 而不是方块那样恒定、或星形那样忽宽忽窄。
  {
    const widths = [];
    for (let y = minY; y <= maxY; y += 1) {
      let left = size;
      let right = -1;
      for (let x = 0; x < img.width; x += 1) {
        const p = at(img, x, y);
        if (p.a > 200 && p.r > 230 && p.g > 230 && p.b > 230) {
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
      if (right >= 0) widths.push(right - left + 1);
    }
    check(widths.length > 0, '能测到逐行宽度');

    if (widths.length) {
      const maxW = Math.max(...widths);
      const maxIdx = widths.indexOf(maxW);
      const first = widths[0];
      const last = widths[widths.length - 1];
      const mid = widths.length / 2;
      // 最宽处应当在中部（允许前后 1/3 的浮动，因为上方有瓜蒂）
      check(
        maxIdx > widths.length * 0.25 && maxIdx < widths.length * 0.85,
        `最宽处在中部（第 ${maxIdx}/${widths.length} 行）—— 椭圆轮廓`,
      );
      // 两端明显比中间窄
      check(first < maxW * 0.7 && last < maxW * 0.7, '上下两端收窄（不是方块）');
    }
  }

  // 瓣纹：48px 以上应当能在南瓜中部测到"缝隙"（一行里出现多段白色）
  if (size >= 48) {
    const probeY = Math.round(minY + (maxY - minY) * 0.55);
    let runs = 0;
    let inRun = false;
    for (let x = 0; x < img.width; x += 1) {
      const p = at(img, x, probeY);
      const white = p.a > 200 && p.r > 230 && p.g > 230 && p.b > 230;
      if (white && !inRun) {
        runs += 1;
        inRun = true;
      } else if (!white) {
        inRun = false;
      }
    }
    check(runs >= 3, `南瓜有瓣纹（y=${probeY} 处 ${runs} 段白色，中间被缝隙隔开）`);
  }
  // 小尺寸不做瓣纹（会被抗锯齿糊掉），只要求是完整的一块
  if (size <= 32) {
    const probeY = Math.round(minY + (maxY - minY) * 0.55);
    let runs = 0;
    let inRun = false;
    for (let x = 0; x < img.width; x += 1) {
      const p = at(img, x, probeY);
      const white = p.a > 200 && p.r > 230 && p.g > 230 && p.b > 230;
      if (white && !inRun) {
        runs += 1;
        inRun = true;
      } else if (!white) {
        inRun = false;
      }
    }
    check(runs === 1, `小尺寸下南瓜是完整一块（${runs} 段，无碎缝）`);
  }

  // 四角在圆角外，应当是透明的（不是橙色 —— 那是圆角矩形的正常表现）
  for (const [px, py] of [[1, 1], [size - 2, 1], [1, size - 2], [size - 2, size - 2]]) {
    const p = at(img, px, py);
    check(p.a < 100, `圆角外的角落 (${px},${py}) 透明（alpha=${p.a}）`);
  }
  // 而边中点应当是蓝色底（往里探几像素，避开边缘抗锯齿）
  let edgeOk = true;
  for (const [px, py] of [
    [Math.floor(size / 2), Math.round(size * 0.12)],
    [Math.round(size * 0.12), Math.floor(size / 2)],
  ]) {
    const p = at(img, px, py);
    if (!(p.a > 200 && p.r > p.b + 60)) {
      edgeOk = false;
      console.log(`      ! 边中点 (${px},${py}) rgba=${p.r},${p.g},${p.b},${p.a} 不是蓝底`);
    }
  }
  check(edgeOk, '边缘内侧是南瓜橙底（圆角矩形铺满画布）');

  // 中央不应有缺口
  const center = at(img, Math.floor(size / 2), Math.floor(size / 2));
  check(center.a > 200, '中心区域无空洞');

  // 不透明像素的占比应当合理（不是空白也不是满块）
  let opaque = 0;
  for (let y = 0; y < img.height; y += 1)
    for (let x = 0; x < img.width; x += 1) if (at(img, x, y).a > 128) opaque += 1;
  const coverage = opaque / (img.width * img.height);
  check(coverage > 0.7 && coverage < 0.98, `不透明占比合理（${(coverage * 100).toFixed(1)}%）`);
}

// manifest 引用的尺寸是否齐全
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const referenced = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
]);
console.log('\n[manifest 一致性]');
for (const ref of referenced) {
  const size = Number(ref.match(/icon(\d+)\.png/)?.[1]);
  check(Boolean(size), `引用 ${ref} 可识别`);
  if (size) {
    try {
      const img = decodePNG(await readFile(path.join(root, ref)));
      check(img.width === size, `${ref} 实际尺寸与文件名一致（${img.width}）`);
    } catch (err) {
      check(false, `${ref} 读取失败：${err.message}`);
    }
  }
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败`);
  process.exit(1);
}
console.log('\u2713 图标全部合格。');
