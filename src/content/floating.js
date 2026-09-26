/**
 * floating.js —— 页面右下角的悬浮窗。
 *
 * 独立于 content.js（各占一个 IIFE，互不干扰），只做三件事：
 *   1. 显示当前状态（空闲 / 运行中 / 第几步 / 花了多少 token）
 *   2. 提供「停止」按钮，运行中可直接中断
 *   3. 提供快捷指令，点一下就把任务发给侧边栏
 *
 * 与侧边栏通过 background 中转消息；侧边栏没开时也能用快捷指令唤起它。
 */

(() => {
  if (window.__AI_AGENT_FLOAT_LOADED__) return;
  window.__AI_AGENT_FLOAT_LOADED__ = true;

  const HOST_ID = '__ai_agent_float_host__';

  /** 快捷指令：点了直接执行。 */
  const QUICK_ACTIONS = [
    { icon: '📄', label: '总结本页', prompt: '总结当前页面，用 5 个要点说明。' },
    { icon: '🌐', label: '翻译本页', prompt: '把当前页面的正文翻译成中文，保留段落结构。' },
    { icon: '🧹', label: '净化页面', prompt: '把当前页面改造成适合阅读的样子：隐藏广告/弹窗/侧边栏/悬浮元素，把正文字号调大、行距放宽，用深色或简洁配色。' },
    { icon: '🎯', label: '提取要点', prompt: '提取当前页面的关键信息，整理成 Markdown 表格。' },
  ];

  let host = null;
  let shadow = null;
  let ui = {};
  let enabled = false; // 默认不显示，读到设置后再决定
  let themeFromSettings = null;
  let state = { status: 'idle', step: 0, total: 0, text: '', tokens: 0 };

  /* ---------------- 构建 DOM ---------------- */

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.id = HOST_ID;
    // 用 Shadow DOM 隔离样式，避免被宿主页面 CSS 污染（也避免污染页面）
    shadow = host.attachShadow({ mode: 'open' });

    const wrap = document.createElement('div');
    // scope 承载主题变量；wrap 负责定位 —— 分开是为了让 :host 上的
    // data-* 属性改变量时，不影响布局规则
    wrap.className = 'wrap host-scope';

    // 折叠状态的小圆钮
    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.title = 'AI Agent';
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    launcher.appendChild(glyph);
    launcher.addEventListener('click', () => toggle(true));

    // 展开的面板
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = 'AI Agent';
    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot';
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = '收起';
    close.textContent = '×';
    close.addEventListener('click', () => toggle(false));
    head.append(statusDot, title, close);

    const statusLine = document.createElement('div');
    statusLine.className = 'status-line';
    statusLine.textContent = '就绪';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const tokenLine = document.createElement('span');
    tokenLine.className = 'tokens';
    tokenLine.textContent = '';
    const patchLine = document.createElement('span');
    patchLine.className = 'patches';
    patchLine.textContent = '';
    meta.append(tokenLine, patchLine);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const action of QUICK_ACTIONS) {
      const b = document.createElement('button');
      b.className = 'quick';
      b.type = 'button';
      b.title = action.prompt;
      const i = document.createElement('span');
      i.className = 'qi';
      i.textContent = action.icon;
      const l = document.createElement('span');
      l.textContent = action.label;
      b.append(i, l);
      b.addEventListener('click', () => sendTask(action.prompt, action.label));
      grid.appendChild(b);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'stop';
    stopBtn.type = 'button';
    stopBtn.textContent = '停止';
    stopBtn.addEventListener('click', stopRun);
    const undoBtn = document.createElement('button');
    undoBtn.className = 'undo';
    undoBtn.type = 'button';
    undoBtn.textContent = '撤销页面改动';
    undoBtn.addEventListener('click', undoSideEffects);
    const openBtn = document.createElement('button');
    openBtn.className = 'open';
    openBtn.type = 'button';
    openBtn.textContent = '打开侧栏';
    openBtn.addEventListener('click', () => {
      sendTask('', null, { openOnly: true });
    });
    foot.append(stopBtn, undoBtn, openBtn);

    card.append(head, statusLine, meta, grid, foot);
    wrap.append(launcher, card);

    shadow.append(styleSheet(), wrap);
    // 页面可能还没有 body（极早期脚本），退回到 documentElement
    (document.body || document.documentElement).appendChild(host);

    Object.assign(ui, {
      launcher,
      card,
      statusDot,
      title,
      statusLine,
      tokenLine,
      patchLine,
      stopBtn,
      undoBtn,
      grid,
    });

    // 默认展开一小段时间提示存在，然后自动收起
    toggle(true);
    setTimeout(() => {
      if (state.status === 'idle') toggle(false);
    }, 2600);
  }

  function styleSheet() {
    const style = document.createElement('style');
    // 变量挂在 :host 上，主题一改就整体换肤；玻璃模式通过 [data-glass] 切换
    style.textContent = `
:host { all: initial; }
.wrap {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--fg);
}
.host-scope {
  /* 中性灰阶，与面板/DSH 一致 */
  --accent: oklch(92.2% 0 0);
  --accent-on: oklch(20.5% 0 0);
  --accent-soft: oklch(100% 0 0 / 0.1);
  --accent-line: oklch(100% 0 0 / 0.16);
  --surface: oklch(20.5% 0 0);
  --surface-2: oklch(24% 0 0);
  --surface-3: oklch(18% 0 0);
  --hover: oklch(26.9% 0 0);
  --fg: oklch(98.5% 0 0);
  --fg-dim: oklch(70.8% 0 0);
  --fg-faint: oklch(55.6% 0 0);
  --line: oklch(100% 0 0 / 0.1);
  --line-soft: oklch(100% 0 0 / 0.06);
  --ok: oklch(70% 0.13 155);
  --warn: oklch(76.9% 0.188 70.08);
  --err: oklch(70.4% 0.191 22.216);
  --radius: 8px;
  --radius-sm: 6px;
  --glass-bg: oklch(18% 0 0 / 0.8);
  --glass-border: oklch(100% 0 0 / 0.09);
  --glass-shadow: 0 10px 30px oklch(0% 0 0 / 0.42);
  --speed: .15s;
  color-scheme: dark;
}
:host([data-mode="light"]) .host-scope {
  --accent: oklch(20.5% 0 0);
  --accent-on: oklch(98.5% 0 0);
  --accent-soft: oklch(0% 0 0 / 0.07);
  --accent-line: oklch(0% 0 0 / 0.14);
  --surface: oklch(100% 0 0);
  --surface-2: oklch(98% 0 0);
  --surface-3: oklch(97% 0 0);
  --hover: oklch(95% 0 0);
  --fg: oklch(14.5% 0 0);
  --fg-dim: oklch(55.6% 0 0);
  --fg-faint: oklch(64% 0 0);
  --line: oklch(92.2% 0 0);
  --line-soft: oklch(95% 0 0);
  --ok: oklch(58% 0.15 155);
  --warn: oklch(66.6% 0.179 58.318);
  --err: oklch(57.7% 0.245 27.325);
  --glass-bg: oklch(100% 0 0 / 0.8);
  --glass-border: oklch(0% 0 0 / 0.07);
  --glass-shadow: 0 10px 30px oklch(20% 0 0 / 0.14);
  color-scheme: light;
}
/* 玻璃三档 */
:host([data-glass="tint"]) .card {
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  border-color: var(--glass-border);
}
:host([data-glass="off"]) .card {
  background: var(--surface);
  border-color: var(--line);
}
:host([data-motion="off"]) * { transition: none !important; animation: none !important; }

/* 启动器：中性圆钮，跟随主题色 */
.launcher {
  position: absolute; right: 0; bottom: 0;
  width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--glass-border);
  cursor: pointer;
  background: var(--accent);
  color: var(--accent-on);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 10px oklch(0% 0 0 / 0.28);
  transition: transform var(--speed) ease, opacity var(--speed) ease, background var(--speed) ease;
}
.launcher:hover { transform: scale(1.06); }
.launcher:active { transform: scale(.95); }
.launcher .glyph {
  width: 14px; height: 14px; border-radius: 4px; background: currentColor;
}
.card {
  width: 248px; border-radius: var(--radius); overflow: hidden;
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  transform-origin: bottom right;
  transition: opacity var(--speed) ease, transform var(--speed) ease;
}
.card.hidden { opacity: 0; transform: scale(.92) translateY(6px); pointer-events: none; }
.launcher.hidden { opacity: 0; pointer-events: none; }
.head {
  display: flex; align-items: center; gap: 7px;
  padding: 10px 11px; background: color-mix(in srgb, var(--surface-2) 65%, transparent);
  border-bottom: 1px solid var(--line-soft);
}
.status-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: 0 0 auto;
  transition: background var(--speed) ease, box-shadow var(--speed) ease;
}
.status-dot.busy { background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: blink 1.2s infinite; }
.status-dot.err { background: var(--err); box-shadow: 0 0 8px var(--err); }
@keyframes blink { 50% { opacity: .3; } }
.title { font-weight: 600; font-size: 12.5px; letter-spacing: .2px; }
.close {
  margin-left: auto; border: 0; background: transparent; color: var(--fg-dim);
  font-size: 17px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 5px;
  transition: color var(--speed) ease, background var(--speed) ease;
}
.close:hover { color: var(--fg); background: var(--hover); }
.status-line {
  padding: 8px 11px 4px; font-size: 12px; color: var(--fg-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meta {
  display: flex; gap: 10px; padding: 0 11px 9px;
  font-size: 10.5px; color: var(--fg-faint); min-height: 0;
}
.meta span:empty { display: none; }
.grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 0 11px 10px;
}
.quick {
  display: flex; align-items: center; gap: 5px; cursor: pointer;
  padding: 7px 9px; border-radius: var(--radius-sm); font: inherit; font-size: 11.5px;
  background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  color: var(--fg);
  border: 1px solid var(--line);
  transition: background var(--speed) ease, border-color var(--speed) ease, transform var(--speed) ease;
}
.quick:hover {
  background: var(--hover);
  border-color: var(--accent-line);
  transform: translateY(-1px);
}
.quick:active { transform: translateY(0) scale(.97); }
.quick .qi { font-size: 12px; }
.foot {
  display: flex; gap: 6px; padding: 9px 11px 11px;
  border-top: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--surface-3) 65%, transparent);
}
.foot button {
  flex: 1; cursor: pointer; font: inherit; font-size: 11px; padding: 6px 4px;
  border-radius: var(--radius-sm); border: 1px solid var(--line);
  background: transparent; color: var(--fg-dim);
  transition: background var(--speed) ease, color var(--speed) ease, border-color var(--speed) ease;
}
.foot .stop { color: var(--err); border-color: color-mix(in srgb, var(--err) 34%, transparent); }
.foot .stop:hover { background: color-mix(in srgb, var(--err) 14%, transparent); }
.foot .undo:hover, .foot .open:hover { background: var(--hover); color: var(--fg); }
.foot button:disabled { opacity: .4; cursor: not-allowed; }
`;
    return style;
  }

  function toggle(open) {
    if (!ui.card) return;
    if (open) {
      ui.card.classList.remove('hidden');
      ui.launcher.classList.add('hidden');
    } else {
      ui.card.classList.add('hidden');
      ui.launcher.classList.remove('hidden');
    }
  }

  /* ---------------- 主题 ---------------- */

  /** #rrggbb → 是否偏亮（决定按钮上的文字用黑还是白）。 */
  function isLight(hex) {
    const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
    if (!m) return false;
    const r = parseInt(m[1].slice(0, 2), 16) / 255;
    const g = parseInt(m[1].slice(2, 4), 16) / 255;
    const b = parseInt(m[1].slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.55;
  }

  /** 把主题设置映射到 host 的 data-* 与 CSS 变量。 */
  function applyTheme(theme) {
    if (!theme) return;
    const h = host || document.getElementById(HOST_ID);
    if (!h) return;

    const mode =
      theme.resolvedMode || (theme.mode === 'light' ? 'light' : theme.mode === 'dark' ? 'dark' : 'dark');
    h.setAttribute('data-mode', mode);
    h.setAttribute('data-glass', theme.glass || 'tint');
    h.setAttribute('data-motion', theme.motion === false ? 'off' : 'on');

    // 圆角跟随侧边栏设置（与面板同一套映射：0..1 → 6..16px）
    const r = Math.max(0, Math.min(1, Number(theme.radius ?? 0.55)));
    h.style.setProperty('--radius', `${(6 + r * 10).toFixed(1)}px`);
    h.style.setProperty('--radius-sm', `${(5 + r * 5).toFixed(1)}px`);

    // 中性模式：清掉内联色，让样式表按深浅决定（与面板一致）
    if (!theme.accent || theme.accent === 'neutral') {
      h.setAttribute('data-accent', 'neutral');
      for (const v of ['--accent', '--accent-on', '--accent-soft', '--accent-line']) {
        h.style.removeProperty(v);
      }
      return;
    }

    h.setAttribute('data-accent', 'custom');
    const accent = /^#?[0-9a-f]{6}$/i.test(String(theme.accent))
      ? String(theme.accent).startsWith('#')
        ? theme.accent
        : `#${theme.accent}`
      : '#4f8cff';
    h.style.setProperty('--accent', accent);
    h.style.setProperty('--accent-on', isLight(accent) ? '#0d0f14' : '#ffffff');
    h.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 16%, transparent)`);
    h.style.setProperty('--accent-line', `color-mix(in srgb, ${accent} 50%, transparent)`);
  }

  /* ---------------- 与 background 通信 ---------------- */

  async function send(type, payload = {}) {
    try {
      return await chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      return null;
    }
  }

  async function sendTask(prompt, label, opts = {}) {
    const res = await send('float/task', { prompt, label, ...opts });
    if (res?.ok === false && res.error) {
      setState({ status: 'err', text: res.error });
    }
  }

  async function stopRun() {
    const res = await send('float/stop');
    if (res?.ok === false) setState({ status: 'err', text: res.error || '停止失败' });
  }

  async function undoSideEffects() {
    const res = await send('float/undo');
    if (res?.ok) {
      setState({ status: 'idle', text: `已撤销页面改动（${res.data?.restored ?? 0} 处）` });
      refreshPatches();
    } else {
      setState({ status: 'err', text: res?.error || '撤销失败' });
    }
  }

  async function refreshPatches() {
    const res = await send('float/patch-stats');
    if (res?.ok) {
      const n = res.data?.count || 0;
      if (ui.patchLine) ui.patchLine.textContent = n ? `改动 ${n} 处` : '';
      if (ui.undoBtn) ui.undoBtn.disabled = n === 0;
    }
  }

  /* ---------------- 状态渲染 ---------------- */

  function setState(next) {
    state = { ...state, ...next };
    if (!ui.statusLine) return;

    const { status, step, total, text, tokens } = state;

    ui.statusDot.className = `status-dot${status === 'busy' ? ' busy' : status === 'err' ? ' err' : ''}`;

    if (text) {
      ui.statusLine.textContent = text;
    } else if (status === 'busy') {
      ui.statusLine.textContent = total ? `运行中 ${step}/${total} 步…` : '运行中…';
    } else if (status === 'err') {
      ui.statusLine.textContent = '出错了';
    } else {
      ui.statusLine.textContent = '就绪';
    }

    if (ui.tokenLine) {
      ui.tokenLine.textContent = tokens ? `${tokens.toLocaleString()} tokens` : '';
    }
    if (ui.stopBtn) ui.stopBtn.disabled = status !== 'busy';
  }

  /* ---------------- 监听 background 推送 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'cs/float') {
      // background 推送状态
      setState(msg.state || {});
      if (msg.state?.patchCount !== undefined && ui.patchLine) {
        const n = msg.state.patchCount;
        ui.patchLine.textContent = n ? `改动 ${n} 处` : '';
        if (ui.undoBtn) ui.undoBtn.disabled = n === 0;
      }
      if (msg.open) toggle(true);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'cs/float-theme') {
      // 侧边栏换肤后实时同步
      applyTheme(msg.theme);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  /* ---------------- 初始化 ---------------- */

  async function init() {
    // 读取设置，判断是否显示
    try {
      const res = await send('settings/get');
      const s = res?.data || {};
      enabled = s.floatingEnabled === true;
      themeFromSettings = s.theme || null;
    } catch {
      enabled = false;
    }
    if (!enabled) return;
    // 不在 iframe 里显示，避免一页多个悬浮窗
    if (window.top !== window.self) return;

    const start = () => {
      build();
      // 首次应用主题（设置里的外观）
      applyTheme(themeFromSettings);
      refreshPatches();
      setState({ status: 'idle' });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  init();

  // 页面被 SPA 重绘掉时，补回来
  const observer = new MutationObserver(() => {
    if (enabled && window.top === window.self && !document.getElementById(HOST_ID) && host) {
      host = null;
      shadow = null;
      build();
    }
  });
  const attachObserver = () => {
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: false });
    }
  };
  if (document.documentElement) attachObserver();
  else document.addEventListener('DOMContentLoaded', attachObserver, { once: true });
})();
