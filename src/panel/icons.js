/**
 * icons.js —— 内置图标库。
 *
 * 每个图标是一段 24x24 视口的 SVG 路径（只含路径，不含 <svg> 外壳），
 * 由 brand.js 统一套上描边样式。这样换图标只需换路径字符串，
 * 不涉及任何 DOM 结构或 CSS 改动。
 *
 * 绘制约定与界面一致：1.6 描边、圆头圆角、不填充。
 */

export const ICON_LIBRARY = [
  {
    // 品牌默认图标：南瓜。
    // 用描边勾勒"扁圆瓜体 + 顶部短蒂 + 两条瓣纹"，
    // 与扩展的 PNG 图标（实心剪影）呼应但更适合 16px 的线框场景。
    id: 'pumpkin',
    name: '南瓜',
    paths: [
      // 瓜体：扁圆（宽 > 高，这是南瓜区别于番茄/苹果的关键比例）
      'M12 8c-4.4 0-7.5 2-7.5 5.2S7.6 19 12 19s7.5-2.6 7.5-5.8S16.4 8 12 8z',
      // 瓜蒂
      'M11 8V5.6c0-.9.7-1.6 1.6-1.6',
      // 两条瓣纹
      'M9 9.5c-.6 1.5-.6 6 0 8.5',
      'M15 9.5c.6 1.5.6 6 0 8.5',
    ],
  },
  {
    id: 'bolt',
    name: '闪电',
    paths: ['M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z'],
  },
  {
    id: 'spark',
    name: '星火',
    paths: [
      'M12 3v4M12 17v4M3 12h4M17 12h4',
      'M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8',
    ],
  },
  {
    id: 'orbit',
    name: '轨道',
    paths: ['M12 3a9 9 0 0 0 0 18 9 9 0 0 0 0-18z', 'M3.6 9.5c3-2.4 13.8-2.4 16.8 0', 'M3.6 14.5c3 2.4 13.8 2.4 16.8 0'],
  },
  {
    id: 'prism',
    name: '棱镜',
    paths: ['M12 3 21 19H3z', 'M12 3v16', 'M7.5 11h9'],
  },
  {
    id: 'wave',
    name: '波',
    paths: ['M2 12c2.5-5 5-5 7.5 0s5 5 7.5 0 3.5-2 4.5 0', 'M2 17c2.5-4 5-4 7.5 0s5 4 7.5 0'],
  },
  {
    id: 'cube',
    name: '立方',
    paths: ['M12 2.5 20.5 7v10L12 21.5 3.5 17V7z', 'M3.5 7 12 11.5 20.5 7', 'M12 11.5v10'],
  },
  {
    id: 'compass',
    name: '罗盘',
    paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M15.5 8.5 13.5 13.5 8.5 15.5l2-5z'],
  },
  {
    id: 'leaf',
    name: '叶',
    paths: ['M20 4C11 4 5 8 5 15a5 5 0 0 0 5 5c7 0 10-7 10-16z', 'M5 20C8 15 12 11 16 8'],
  },
  {
    id: 'key',
    name: '钥',
    paths: ['M15 3a5 5 0 1 0-4.6 7L9 11.4V14H6.4L4 16.4V20h3.6l1.4-1.4V16h2.6l1.4-1.4V12.6L15 11a5 5 0 0 0 0-8z', 'M16.5 7.5h.01'],
  },
  {
    id: 'feather',
    name: '羽',
    paths: ['M20 4c-9 0-13 4-13 11l-4 5', 'M20 4c0 8-4 11-11 11', 'M8 15h6'],
  },
  {
    id: 'moon',
    name: '月',
    paths: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
  },
  {
    id: 'sun',
    name: '日',
    paths: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19'],
  },
  {
    id: 'mountain',
    name: '山',
    paths: ['M2 19h20L14 5l-4 7-2-3z', 'M11 12h3'],
  },
  {
    id: 'anchor',
    name: '锚',
    paths: ['M12 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M12 7v14', 'M5 13c0 5 3 7 7 7s7-2 7-7h-3M5 13H2'],
  },
  {
    id: 'flame',
    name: '焰',
    paths: ['M12 21c3.9 0 6-2.4 6-5.5 0-4.5-6-11.5-6-11.5S6 11 6 15.5C6 18.6 8.1 21 12 21z', 'M12 21c1.7 0 2.6-1.1 2.6-2.5 0-2-2.6-5-2.6-5s-2.6 3-2.6 5c0 1.4.9 2.5 2.6 2.5z'],
  },
  {
    id: 'sigil',
    name: '符文',
    paths: ['M12 2 4 7v10l8 5 8-5V7z', 'M12 7v10', 'M8 10l8 4M16 10l-8 4'],
  },
  {
    id: 'lens',
    name: '透镜',
    paths: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M15.5 15.5 21 21'],
  },
  {
    id: 'quill',
    name: '笔',
    paths: ['M20 4 8 16l-4 4 4-4z', 'M20 4c-6 0-9 3-9 8', 'M6 14l4 4'],
  },
  {
    id: 'nova',
    name: '新星',
    paths: ['M12 3v18M3 12h18', 'M6 6l12 12M18 6 6 18'],
  },
  {
    id: 'gate',
    name: '门',
    paths: ['M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16', 'M3 21h18', 'M14 12h.01'],
  },
];

/** 按 id 取图标；取不到返回第一个，保证永远有东西可画。 */
export function getIcon(id) {
  return ICON_LIBRARY.find((i) => i.id === id) || ICON_LIBRARY[0];
}

/**
 * 把图标渲染成 SVG 元素。
 * 统一描边样式在这里落地，调用方不需要关心。
 */
export function renderIcon(id, { size = 16, className = '' } = {}) {
  const icon = getIcon(id);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (className) svg.setAttribute('class', className);
  for (const d of icon.paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/** 把图标渲染成 data URL（用于扩展工具栏图标，需要光栅化）。 */
export function iconSvgString(id, { size = 128, stroke = '#ffffff', fill = 'none' } = {}) {
  const icon = getIcon(id);
  const paths = icon.paths.map((d) => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"
    fill="${fill}" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    ${paths}</svg>`;
}
