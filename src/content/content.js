/**
 * content.js —— 智能体的"眼睛和手"。
 * 运行在页面里，不依赖任何构建工具，直接由 manifest 注入。
 *
 * 职责：
 *  1. snapshot  —— 把页面压缩成 LLM 可读的编号元素列表（可点击/可输入）。
 *  2. read      —— 抽取正文纯文本，用于翻译/总结/提取。
 *  3. act       —— 执行点击、输入、选择、滚动、跳转等动作。
 *  4. highlight —— 视觉反馈，让用户看到 AI 正在操作哪里。
 */

(() => {
  if (window.__AI_AGENT_CONTENT_LOADED__) return;
  window.__AI_AGENT_CONTENT_LOADED__ = true;

  const MAX_ELEMENTS = 150;
  const MAX_TEXT_CHARS = 20000;

  /** 交互元素候选选择器。 */
  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  /** 稳定 id 生成：给元素打标记，后续按 id 精确操作，避免选择器失效。 */
  let seq = 0;
  const registry = new Map();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function cleanText(value, max = 120) {
    const text = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  /** 为一个元素生成给 LLM 看的可读描述。 */
  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const info = {
      tag,
      role: role || undefined,
      text: undefined,
      name: undefined,
      type: undefined,
      value: undefined,
      placeholder: undefined,
      href: undefined,
      checked: undefined,
      disabled: undefined,
    };

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      info.type = el.getAttribute('type') || tag;
      info.name = cleanText(el.getAttribute('name') || el.id || '', 60) || undefined;
      info.placeholder = cleanText(el.getAttribute('placeholder') || '', 80) || undefined;
      if (tag === 'select') {
        info.value = cleanText(el.value, 60);
        info.options = Array.from(el.options)
          .slice(0, 12)
          .map((o) => cleanText(o.textContent, 30));
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        info.checked = el.checked;
      } else if (el.type !== 'password') {
        info.value = cleanText(el.value, 60) || undefined;
      }
    } else {
      info.text =
        cleanText(el.innerText || el.textContent, 120) ||
        cleanText(el.getAttribute('aria-label'), 120) ||
        cleanText(el.getAttribute('title'), 120) ||
        undefined;
    }

    if (tag === 'a' && el.href) info.href = el.href.slice(0, 200);
    const aria = el.getAttribute('aria-label');
    if (aria) info.name = cleanText(aria, 80);
    if (el.disabled) info.disabled = true;

    return info;
  }

  function keyFor(el) {
    if (!el.__aiAgentId) {
      seq += 1;
      el.__aiAgentId = `e${seq}`;
    }
    registry.set(el.__aiAgentId, el);
    return el.__aiAgentId;
  }

  /** 主快照：编号 + 描述当前页面所有可交互元素。 */
  function snapshot() {
    registry.clear();
    const nodes = document.querySelectorAll(INTERACTIVE_SELECTOR);
    const elements = [];
    let truncated = false;

    for (const el of nodes) {
      if (elements.length >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }
      if (!isVisible(el)) continue;
      // 跳过纯装饰性的嵌套命中，保留最外层可交互节点
      if (el.closest('[aria-hidden="true"]')) continue;
      const rect = el.getBoundingClientRect();
      elements.push({
        id: keyFor(el),
        ...describe(el),
        box: [
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        ],
      });
    }

    return {
      url: location.href,
      title: document.title,
      elements,
      truncated,
      scroll: {
        y: Math.round(window.scrollY),
        maxY: Math.round(
          Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        ),
      },
      // 视口尺寸：让模型知道 click_at 的坐标范围（视口坐标，不是文档坐标）
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
    };
  }

  /**
   * 结构快照：列出页面的"骨架"区块（区块容器、正文、广告位、侧栏等）。
   *
   * 为什么需要它：snapshot 只收可交互元素（按钮/链接/输入框），
   * 而"改页面"要动的是结构性元素 —— 广告容器、侧边栏、正文主体，
   * 它们既不是可交互元素，read_page 也只给纯文本不给结构。
   * 没有这个工具，模型只能盲猜 CSS 选择器，自然改不动。
   */
  function outline() {
    const STRUCTURAL = [
      'header', 'nav', 'main', 'article', 'section', 'aside', 'footer',
      'div[id]', 'div[class]', 'form', 'table', 'ul', 'figure',
      '[class*="ad"]', '[class*="sidebar"]', '[class*="banner"]',
      '[class*="popup"]', '[class*="modal"]', '[class*="content"]',
      '[class*="article"]', '[class*="comment"]', '[id*="ad"]',
    ].join(',');

    const nodes = document.querySelectorAll(STRUCTURAL);
    const blocks = [];
    const vh = window.innerHeight;

    for (const el of nodes) {
      if (blocks.length >= 120) break;
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      // 太小的忽略（多数是图标/装饰），但保留有明确语义标签的
      const semantic = /^(header|nav|main|article|section|aside|footer|form|table)$/i.test(el.tagName);
      if (rect.width < 40 || rect.height < 20) continue;
      if (!semantic && rect.width * rect.height < 4000) continue;

      // 跳过纯包裹层：只有一个子元素且自身没文字
      const ownText = (el.innerText || '').trim();
      const kidEls = el.children.length;
      if (!semantic && kidEls === 1 && ownText.length < 40) continue;

      const area = rect.width * rect.height;
      blocks.push({
        id: keyFor(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        cls: cleanText(el.className || '', 70) || undefined,
        text: cleanText(ownText, 60) || undefined,
        box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        // 面积占比帮模型判断"这块是不是主体"
        areaPct: Math.round((area / (window.innerWidth * vh)) * 100),
        // 是否在首屏
        inView: rect.top < vh && rect.bottom > 0,
      });
    }

    // 按面积从大到小，让主体区块排在前面
    blocks.sort((a, b) => b.areaPct - a.areaPct);

    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      blocks,
      truncated: blocks.length >= 120,
      // 顺手统计一下页面里出现的 class 名，方便模型写 CSS 时有的放矢
      bodyClass: cleanText(document.body.className || '', 120) || undefined,
      htmlClass: cleanText(document.documentElement.className || '', 120) || undefined,
    };
  }

  /** 抽取正文。优先 article/main，退化到 body，剔除脚本与导航噪音。 */
  function read() {
    const pick =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;

    const clone = pick.cloneNode(true);
    clone
      .querySelectorAll(
        'script,style,noscript,svg,iframe,nav,footer,header,form,aside,[aria-hidden="true"]',
      )
      .forEach((n) => n.remove());

    const text = clone.innerText || clone.textContent || '';
    const cleaned = text
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    return {
      url: location.href,
      title: document.title,
      text: cleaned.slice(0, MAX_TEXT_CHARS),
      truncated: cleaned.length > MAX_TEXT_CHARS,
    };
  }

  function resolve(id) {
    const el = registry.get(id);
    if (el && el.isConnected) return el;
    // 注册表失效（页面重绘）时按属性兜底查找
    const fallback = document.querySelector(`[data-ai-agent-id="${id}"]`);
    return fallback || null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 等待页面发生变化（DOM 变动或 URL 跳转），最多等 maxMs。
   *
   * 为什么不用固定 sleep：固定 600ms 在慢页面上可能不够、在快页面上纯浪费。
   * 这里用 MutationObserver 盯着，页面一动就立刻返回。
   * 如果一直没动（比如点击只是聚焦了输入框），才等到上限。
   */
  function waitForSettle(maxMs = 600, minMs = 80) {
    return new Promise((resolve) => {
      const startUrl = location.href;
      let done = false;
      let observer = null;

      const finish = () => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearTimeout(timer);
        clearTimeout(minTimer);
        resolve();
      };

      // 至少等 minMs：给事件处理函数一点执行时间，
      // 否则会在 DOM 还没变动时就立刻返回
      const minTimer = setTimeout(() => {
        // 过了最短时间后，检查是否已经有变化
        if (location.href !== startUrl) {
          finish();
          return;
        }
        try {
          observer = new MutationObserver(() => finish());
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'aria-hidden'],
          });
        } catch {
          finish();
        }
      }, minMs);

      const timer = setTimeout(finish, maxMs);
    });
  }

  /* ---------------- 页面改造记录（支持一键撤销） ----------------
   * 每条记录都保存"如何还原"。撤销时按倒序回放，保证嵌套修改也能正确恢复。
   */
  const patches = [];

  function recordPatch(el, record) {
    // 每个元素只记录第一次的原始状态，多次修改才能还原到最初
    const exists = patches.some((p) => p.el === el && p.kind === record.kind);
    if (exists) return;
    patches.push({ ...record, el });
  }

  function resetPatches() {
    let restored = 0;
    const failed = [];

    // 倒序回放
    for (let i = patches.length - 1; i >= 0; i -= 1) {
      const p = patches[i];
      try {
        switch (p.kind) {
          case 'text':
            if (p.el?.isConnected) {
              p.el.textContent = p.old;
              restored += 1;
            }
            break;
          case 'style': {
            if (!p.el) break;
            if (p.had) p.el.style.setProperty(p.prop, p.had);
            else p.el.style.removeProperty(p.prop);
            // 清理 show 时加的 important
            if (p.el.style.getPropertyValue(p.prop) === '' && p.el.style.getPropertyPriority?.(p.prop)) {
              p.el.style.removeProperty(p.prop);
            }
            restored += 1;
            break;
          }
          case 'style_multi':
            if (!p.el) break;
            for (const [k, v] of Object.entries(p.prev || {})) {
              if (v) p.el.style.setProperty(k, v);
              else p.el.style.removeProperty(k);
            }
            restored += 1;
            break;
          case 'remove':
            if (p.parent && p.el) {
              p.parent.insertBefore(p.el, p.next || null);
              restored += 1;
            } else {
              failed.push('有一个被删除的元素无法恢复（父节点已消失）');
            }
            break;
          default:
            break;
        }
      } catch (err) {
        failed.push(String(err?.message || err));
      }
    }

    // 移除注入的样式表
    document.querySelectorAll('style[data-ai-agent-patch]').forEach((s) => {
      s.remove();
      restored += 1;
    });

    // 清理高亮残留
    document.querySelectorAll('.__ai_agent_hl').forEach((n) => n.remove());

    const total = patches.length;
    patches.length = 0;
    return { ok: true, restored, total, failed };
  }

  function patchStats() {
    return {
      count: patches.length,
      kinds: [...new Set(patches.map((p) => p.kind))],
      styles: document.querySelectorAll('style[data-ai-agent-patch]').length,
    };
  }

  function highlight(el, color = '#2563eb') {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = '__ai_agent_hl';
    Object.assign(box.style, {
      position: 'fixed',
      left: `${rect.left - 3}px`,
      top: `${rect.top - 3}px`,
      width: `${rect.width + 6}px`,
      height: `${rect.height + 6}px`,
      border: `2px solid ${color}`,
      borderRadius: '6px',
      background: `${color}22`,
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'opacity .35s ease',
      opacity: '1',
    });
    document.documentElement.appendChild(box);
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 400);
    }, 900);
  }

  /* ---------------- 可见光标 ----------------
   * 在页面上画一个跟着走的小光标，让用户看到"AI 正在点这里"。
   * 纯视觉，pointer-events: none，不影响页面本身。
   */
  let cursorEl = null;
  /** 光标上一次落点，用作下一次移动的起点（让轨迹连续）。 */
  let lastMouse = { x: null, y: null };

  function showCursor(x, y) {
    if (!cursorEl || !cursorEl.isConnected) {
      cursorEl = document.createElement('div');
      cursorEl.className = '__ai_agent_cursor';
      Object.assign(cursorEl.style, {
        position: 'fixed',
        width: '16px',
        height: '16px',
        marginLeft: '-8px',
        marginTop: '-8px',
        borderRadius: '50%',
        border: '2px solid #2563eb',
        background: 'rgba(37,99,235,.22)',
        pointerEvents: 'none',
        zIndex: '2147483647',
        transition: 'left .22s ease, top .22s ease, transform .12s ease, opacity .3s ease',
        opacity: '1',
      });
      document.documentElement.appendChild(cursorEl);
    }
    cursorEl.style.left = `${x}px`;
    cursorEl.style.top = `${y}px`;
  }

  function clickCursor() {
    if (!cursorEl) return;
    cursorEl.style.transform = 'scale(.6)';
    setTimeout(() => {
      if (cursorEl) cursorEl.style.transform = 'scale(1)';
    }, 120);
  }

  function hideCursorLater(ms = 700) {
    setTimeout(() => {
      if (!cursorEl) return;
      cursorEl.style.opacity = '0';
      setTimeout(() => {
        cursorEl?.remove();
        cursorEl = null;
      }, 320);
    }, ms);
  }

  /**
   * 让光标从当前位置"走"到目标，并派发中间的 mousemove（触发 hover 逻辑）。
   *
   * 步数取值：3 步足够触发 hover 逻辑（关键是**有** mousemove 事件，
   * 而不是轨迹多平滑）。原来 6 步 × 28ms = 168ms，现在 84ms。
   */
  async function moveMouseTo(el, tx, ty) {
    const startX = lastMouse.x ?? tx - 60;
    const startY = lastMouse.y ?? ty - 40;
    const steps = 3;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const x = startX + (tx - startX) * t;
      const y = startY + (ty - startY) * t;
      showCursor(x, y);
      if (el) {
        el.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
          }),
        );
      }
      await sleep(28);
    }
    lastMouse = { x: tx, y: ty };
  }


  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function fireInput(el, value) {
    // React/Vue 受控组件需要原生 setter + 事件冒泡
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 执行一个动作。返回结构化结果，便于 LLM 判断成功与否。 */
  async function act(action) {
    const { type } = action;

    if (type === 'scroll') {
      const before = window.scrollY;
      const amount =
        action.amount === 'top'
          ? -document.documentElement.scrollHeight
          : action.amount === 'bottom'
            ? document.documentElement.scrollHeight
            : Number(action.amount) || window.innerHeight * 0.85;
      window.scrollBy({ top: amount, behavior: 'smooth' });
      // 平滑滚动的动画约 250~300ms；450 是保守值，收到 300
      await sleep(300);
      return {
        ok: true,
        moved: Math.round(window.scrollY - before),
        y: Math.round(window.scrollY),
      };
    }

    if (type === 'navigate') {
      if (!action.url) return { ok: false, error: '缺少 url' };
      location.href = action.url;
      return { ok: true, navigating: action.url };
    }

    if (type === 'new_tab') {
      // content script 无法自己开标签页（没有 tabs 权限的页面上下文），
      // 这里只把请求回报给 background，由它调用 chrome.tabs.create。
      return { ok: true, __openTab: action.url || 'about:blank' };
    }

    if (type === 'back') {
      history.back();
      return { ok: true };
    }

    if (type === 'click_at') {
      // 按坐标点击：用于元素难以定位、或需要点画面某处的情况
      const x = Number(action.x);
      const y = Number(action.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: 'click_at 需要有效的 x/y 坐标' };
      }
      // 找出该坐标下最顶层的元素
      const target = document.elementFromPoint(x, y);
      if (!target) return { ok: false, error: `坐标 (${x}, ${y}) 上没有元素` };

      await moveMouseTo(target, x, y);
      clickCursor();
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
      };
      target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      await sleep(60);
      target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
      target.click();
      await sleep(500);
      hideCursorLater();

      const d = describe(target);
      return {
        ok: true,
        clicked: d.text || d.name || target.tagName.toLowerCase(),
        at: [x, y],
      };
    }

    if (type === 'hover') {
      // 悬停：触发依赖 mouseover 才展开的菜单
      const el = resolve(action.id);
      if (!el) return { ok: false, error: `找不到元素 ${action.id}` };
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(280);
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      await moveMouseTo(el, cx, cy);
      el.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }),
      );
      el.dispatchEvent(
        new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window, clientX: cx, clientY: cy }),
      );
      // 等菜单展开：有 DOM 变化就立刻返回，最多 400ms
      await waitForSettle(400, 100);
      hideCursorLater();
      return { ok: true, hovered: action.id, at: [Math.round(cx), Math.round(cy)] };
    }

    if (type === 'move_mouse') {
      // 只移动不点击：让 AI 能"指"给用户看
      const x = Number(action.x);
      const y = Number(action.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: 'move_mouse 需要有效的 x/y 坐标' };
      }
      await moveMouseTo(document.elementFromPoint(x, y), x, y);
      hideCursorLater(900);
      return { ok: true, moved: [x, y] };
    }

    // 只解析元素坐标，不做任何视觉动作。
    // 供 CDP 模式使用：后台需要坐标来派发真实输入事件。
    if (action.resolveOnly) {
      const el = resolve(action.id);
      if (!el) return { ok: false, error: `找不到元素 ${action.id}` };
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { ok: true, at: [r.left + r.width / 2, r.top + r.height / 2] };
    }

    // ---------- 剪贴板 ----------
    // 注意：navigator.clipboard.writeText / readText 在 content script 里
    // 需要页面处于聚焦状态，且 readText 会弹权限提示（首次）。
    if (type === 'copy') {
      const value = String(action.value ?? '');
      if (!value) return { ok: false, error: 'copy 需要 value' };
      try {
        await navigator.clipboard.writeText(value);
        return { ok: true, copied: value.length };
      } catch (err) {
        return { ok: false, error: `写入剪贴板失败：${err?.message || err}（页面可能需要先聚焦）` };
      }
    }

    if (type === 'paste') {
      try {
        const text = await navigator.clipboard.readText();
        return { ok: true, text: String(text || '').slice(0, 20000) };
      } catch (err) {
        return {
          ok: false,
          error: `读取剪贴板失败：${err?.message || err}（浏览器会要求剪贴板权限，请允许）`,
        };
      }
    }

    if (type === 'wait') {
      const ms = Math.min(Number(action.ms) || 1000, 10000);
      await sleep(ms);
      return { ok: true, waited: ms };
    }

    if (type === 'extract') {
      const data = read();
      return { ok: true, url: data.url, title: data.title, text: data.text };
    }

    if (type === 'highlight') {
      const el = resolve(action.id);
      if (!el) return { ok: false, error: `找不到元素 ${action.id}` };
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      highlight(el, action.color || '#f59e0b');
      return { ok: true };
    }

    // ---------- 页面改造（临时，刷新即失效） ----------

    if (type === 'add_style') {
      if (!action.css || typeof action.css !== 'string') {
        return { ok: false, error: '缺少 css 内容' };
      }
      const style = document.createElement('style');
      style.setAttribute('data-ai-agent-patch', 'style');
      // 防呆：CSS 里的 </style> 会截断标签，转义掉
      style.textContent = action.css.replace(/<\/style/gi, '<\\/style');
      document.documentElement.appendChild(style);
      return { ok: true, injected: 'style', length: action.css.length };
    }

    if (type === 'inject_js') {
      if (!action.code || typeof action.code !== 'string') {
        return { ok: false, error: '缺少 code 内容' };
      }
      // 在页面主世界执行需要 script 标签；这里用扩展世界执行，够用于改 DOM。
      try {
        const fn = new Function(
          'document',
          'window',
          `"use strict";\n${action.code}`,
        );
        fn(document, window);
        return { ok: true, injected: 'js' };
      } catch (err) {
        return { ok: false, error: `脚本执行失败：${err?.message || err}` };
      }
    }

    if (type === 'remove') {
      const el = resolve(action.id);
      if (!el) return { ok: false, error: `找不到元素 ${action.id}` };
      recordPatch(el, {
        kind: 'remove',
        parent: el.parentNode,
        next: el.nextSibling,
      });
      el.remove();
      return { ok: true, removed: action.id };
    }

    // 以下动作都需要元素
    const el = resolve(action.id);
    if (!el) {
      return {
        ok: false,
        error: `找不到元素 ${action.id}，页面可能已刷新，请重新 snapshot`,
      };
    }
    if (!isVisible(el)) {
      el.scrollIntoView({ block: 'center' });
      await sleep(300);
    }

    if (type === 'set_text') {
      recordPatch(el, {
        kind: 'text',
        prop: el.isContentEditable ? 'textContent' : 'textContent',
        old: el.textContent,
      });
      el.textContent = String(action.value ?? '');
      if (!el.isContentEditable && 'value' in el && /^(input|textarea)$/i.test(el.tagName)) {
        fireInput(el, String(action.value ?? ''));
      }
      return { ok: true, set_text: action.id, value: String(action.value ?? '').slice(0, 80) };
    }

    if (type === 'hide') {
      recordPatch(el, {
        kind: 'style',
        prop: 'display',
        old: el.style.display,
        had: el.style.display,
      });
      el.style.display = 'none';
      return { ok: true, hidden: action.id };
    }

    if (type === 'show') {
      recordPatch(el, {
        kind: 'style',
        prop: 'display',
        old: el.style.display,
        had: el.style.display,
      });
      el.style.display = '';
      el.style.removeProperty('display');
      // 有些元素是被内联样式或类隐藏的，直接强制显示
      if (!isVisible(el)) el.style.setProperty('display', 'block', 'important');
      return { ok: true, shown: action.id };
    }

    if (type === 'set_style') {
      const props = action.styles || {};
      if (!props || typeof props !== 'object') {
        return { ok: false, error: 'styles 需要是对象，例如 {"color":"red"}' };
      }
      const prev = {};
      for (const [k, v] of Object.entries(props)) {
        prev[k] = el.style.getPropertyValue(k);
        try {
          el.style.setProperty(k, String(v));
        } catch {
          return { ok: false, error: `样式属性非法：${k}` };
        }
      }
      recordPatch(el, { kind: 'style_multi', prev });
      return { ok: true, styled: action.id, applied: Object.keys(props) };
    }


    switch (type) {
      case 'click': {
        highlight(el);
        await sleep(120);
        el.focus?.({ preventScroll: true });
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        // 先让鼠标"走"过去（派发移动事件），再按下、抬起。
        // 很多页面靠 mousemove 触发 hover 展开菜单，跳过这步会点不中。
        await moveMouseTo(el, cx, cy);

        const base = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX: cx,
          clientY: cy,
          screenX: cx + (window.screenX || 0),
          screenY: cy + (window.screenY || 0),
          button: 0,
          buttons: 1,
        };

        el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new PointerEvent('pointerenter', { ...base, pointerId: 1, isPrimary: true, bubbles: false }));
        el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
        el.dispatchEvent(new PointerEvent('pointermove', { ...base, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mousemove', base));
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mousedown', base));

        await sleep(60); // 真实点击里按下与抬起之间有间隔，页面可能据此判断

        el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        clickCursor();
        el.click();

        // 等页面"确实动了"再返回，而不是固定等 600ms。
        // 大多数点击会立刻触发 DOM 变动，实测能省下 300~500ms/次。
        await waitForSettle(600);
        hideCursorLater();

        const described = describe(el);
        return {
          ok: true,
          clicked: described.text || described.name || action.id,
          at: [Math.round(cx), Math.round(cy)],
          urlChanged: location.href,
        };
      }

      case 'type': {
        const value = String(action.value ?? '');
        highlight(el);
        el.focus?.();
        if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          fireInput(el, value);
        }
        if (action.enter) {
          await sleep(100);
          for (const t of ['keydown', 'keypress', 'keyup']) {
            el.dispatchEvent(
              new KeyboardEvent(t, {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
              }),
            );
          }
          if (el.form) el.form.requestSubmit?.();
          // 提交后等页面有反应就返回，不再固定等 600ms
          await waitForSettle(600);
        }
        return { ok: true, typed: value };
      }

      case 'select': {
        const value = String(action.value ?? '');
        highlight(el);
        const match = Array.from(el.options || []).find(
          (o) =>
            o.value === value ||
            cleanText(o.textContent, 60).toLowerCase() === value.toLowerCase(),
        );
        if (!match) {
          return {
            ok: false,
            error: `下拉框没有选项 "${value}"`,
            options: Array.from(el.options || []).map((o) => cleanText(o.textContent, 30)),
          };
        }
        el.value = match.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selected: cleanText(match.textContent, 40) };
      }

      default:
        return { ok: false, error: `未知动作 ${type}` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg?.type) {
        case 'cs/ping':
          sendResponse({ ok: true });
          return false;
        case 'cs/snapshot':
          sendResponse({ ok: true, data: snapshot() });
          return false;
        case 'cs/outline':
          sendResponse({ ok: true, data: outline() });
          return false;
        case 'cs/read':
          sendResponse({ ok: true, data: read() });
          return false;
        case 'cs/highlight': {
          const el = resolve(msg.id);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            highlight(el, msg.color || '#f59e0b');
          }
          sendResponse({ ok: Boolean(el) });
          return false;
        }
        case 'cs/act':
          act(msg.action || {}).then(
            (res) => sendResponse(res),
            (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
          );
          return true; // 异步响应
        case 'cs/patch':
          sendResponse({ ok: true, ...patchStats() });
          return false;
        case 'cs/patch-reset':
          sendResponse(resetPatches());
          return false;
        default:
          sendResponse({ ok: false, error: `未知消息 ${msg?.type}` });
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
      return false;
    }
  });
})();
