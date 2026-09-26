#!/usr/bin/env node
/**
 * patch-test.mjs —— 页面改造功能的真实行为测试。
 *
 * 做法：手搓一个够用的 DOM 实现（Element / 样式 / 事件），
 * 把 content.js 放进去真跑一遍，验证改造与撤销是否真的生效。
 *
 * 为什么不用 jsdom：装依赖会破坏"零依赖"这个约束，
 * 而 content.js 用到的 DOM 面很窄，自己实现更可控。
 *
 * 用法：node tools/patch-test.mjs
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

/* ---------------- 迷你 DOM ---------------- */

class FakeStyle {
  constructor() {
    this._props = new Map();
    this.display = '';
  }
  setProperty(k, v) {
    this._props.set(k, String(v));
    if (k === 'display') this.display = String(v);
  }
  getPropertyValue(k) {
    return this._props.get(k) ?? '';
  }
  removeProperty(k) {
    this._props.delete(k);
    if (k === 'display') this.display = '';
  }
  getPropertyPriority() {
    return '';
  }
  /** 序列化，便于断言 */
  toString() {
    return [...this._props.entries()].map(([k, v]) => `${k}:${v}`).join(';');
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this._text = '';
    this._listeners = new Map();
    this.isConnected = false;
    this.value = '';
    this.rect = { left: 10, top: 20, width: 100, height: 30 };
    this.hidden = false;
  }

  get id() {
    return this.attributes.get('id') || '';
  }
  set id(v) {
    this.attributes.set('id', v);
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }

  get innerText() {
    return this.textContent;
  }

  get isContentEditable() {
    return this.attributes.get('contenteditable') === 'true';
  }

  get className() {
    return this.attributes.get('class') || '';
  }
  set className(v) {
    this.attributes.set('class', v);
  }

  appendChild(child) {
    child.parentNode = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n));
  }
  insertBefore(node, ref) {
    node.parentNode = this;
    node.isConnected = true;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, node);
    else this.children.push(node);
    return node;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    child.isConnected = false;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatchEvent(evt) {
    const type = evt?.type;
    for (const fn of this._listeners.get(type) || []) fn.call(this, evt);
    // 冒泡
    if (evt?.bubbles && this.parentNode) this.parentNode.dispatchEvent(evt);
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click', bubbles: true });
  }
  focus() {}
  blur() {}

  getBoundingClientRect() {
    return this.rect;
  }
  scrollIntoView() {}

  /**
   * 朴素选择器匹配，支持这些组合：
   *   tag / #id / .class / [attr] / [attr="v"] / tag[attr] / tag.class / tag#id
   * 够 content.js 用的（它只查 'style[data-ai-agent-patch]'、'.__ai_agent_hl'、
   * 以及一长串交互元素选择器）。
   */
  matches(sel) {
    const s = sel.trim();
    if (!s) return false;

    // 拆成 tag + 若干修饰符
    const m = s.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/);
    if (!m) return false;
    const [, tag, rest] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;

    // 逐个校验修饰符
    for (const token of rest.match(/[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || []) {
      if (token.startsWith('#')) {
        if (this.id !== token.slice(1)) return false;
      } else if (token.startsWith('.')) {
        if (!this.className.split(/\s+/).includes(token.slice(1))) return false;
      } else {
        const am = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
        if (!am) return false;
        if (am[2] === undefined) {
          if (!this.hasAttribute(am[1])) return false;
        } else if (this.getAttribute(am[1]) !== am[2]) {
          return false;
        }
      }
    }
    return true;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        for (const part of sel.split(',')) {
          if (c.matches(part.trim())) {
            out.push(c);
            break;
          }
        }
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest() {
    return null;
  }
  cloneNode() {
    const c = new FakeElement(this.tagName, this.ownerDocument);
    c._text = this._text;
    c.attributes = new Map(this.attributes);
    c.style = new FakeStyle();
    for (const [k, v] of this.style._props) c.style.setProperty(k, v);
    return c;
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
    this.documentElement.isConnected = true;
    this.body.isConnected = true;
    this.title = '测试页面';
  }
  createElement(tag) {
    return new FakeElement(tag, this);
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
}

/* ---------------- 搭建 content.js 运行环境 ---------------- */

const doc = new FakeDocument();

// 造一个有代表性的页面：正文 + 广告 + 侧边栏 + 待处理按钮
// 注意：snapshot 只收录"可交互元素"（a/button/input/...），
// 所以广告与侧边栏要做成带 role 或 tabindex 的节点，才能被正常识别。
const article = doc.createElement('article');
article.textContent = '这是一段正文内容。'.repeat(10);
doc.body.appendChild(article);

const ad = doc.createElement('div');
ad.className = 'ad-banner';
ad.textContent = '广告位';
ad.setAttribute('data-ad', '1');
ad.setAttribute('role', 'button'); // 让 snapshot 能看见它
doc.body.appendChild(ad);

const aside = doc.createElement('aside');
aside.className = 'sidebar';
aside.textContent = '侧边栏';
aside.setAttribute('role', 'button');
doc.body.appendChild(aside);

const btn = doc.createElement('button');
btn.textContent = '点我';
doc.body.appendChild(btn);

const listeners = [];
globalThis.document = doc;
globalThis.window = {
  __AI_AGENT_CONTENT_LOADED__: false,
  scrollY: 0,
  innerHeight: 800,
  innerWidth: 1200,
  devicePixelRatio: 1,
  screenX: 0,
  screenY: 0,
  scrollBy() {},
  getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
};
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
globalThis.location = { href: 'https://example.com/page' };
globalThis.history = { back() {} };
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.PointerEvent = class {
  constructor(type, opts) {
    Object.assign(this, { type }, opts || {});
  }
};
globalThis.MouseEvent = globalThis.PointerEvent;
globalThis.KeyboardEvent = globalThis.PointerEvent;
globalThis.Event = globalThis.PointerEvent;
globalThis.InputEvent = globalThis.PointerEvent;
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: (fn) => listeners.push(fn),
    },
  },
};

// 加载 content.js
const src = await readFile(path.join(root, 'src/content/content.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function(src)();
check(listeners.length > 0, 'content.js 注册了消息监听器');

/** 向 content script 发消息，返回 Promise<结果>。
 *  超时给足：click/type 内部有 await sleep(...)，同步响应还没回来是正常的。 */
function send(msg, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    for (const fn of listeners) {
      fn(msg, {}, done);
    }
    setTimeout(() => done(null), timeoutMs);
  });
}

const snapshot = () => send({ type: 'cs/snapshot' });

/* ---------------- 开测 ---------------- */

console.log('\n页面改造功能测试\n');

console.log('[1] 快照与元素定位');
let snap = await snapshot();
check(snap?.ok === true, 'snapshot 成功');
// 页面上有 3 个可交互节点（广告、侧边栏、按钮），正文 article 不算
check(snap.data.elements.length === 3, `识别出 ${snap.data.elements.length} 个可交互元素（预期 3）`);

const adId = snap.data.elements.find((e) => e.text === '广告位')?.id;
const asideId = snap.data.elements.find((e) => e.text === '侧边栏')?.id;
check(Boolean(adId), `找到广告元素（${adId}）`);
check(Boolean(asideId), `找到侧边栏元素（${asideId}）`);

console.log('\n[2] hide 隐藏元素');
let r = await send({ type: 'cs/act', action: { type: 'hide', id: adId } });
check(r?.ok === true, 'hide 返回成功');
check(ad.style.display === 'none', '广告确实被设置为 display:none');
check(ad.isConnected, '元素仍在 DOM 中（只是隐藏，不是删除）');

console.log('\n[3] set_text 改文字');
const btnId = snap.data.elements.find((e) => e.text === '点我')?.id;
r = await send({ type: 'cs/act', action: { type: 'set_text', id: btnId, value: '已被 AI 改写' } });
check(r?.ok === true, 'set_text 返回成功');
check(btn.textContent === '已被 AI 改写', `按钮文字已改变（当前：${btn.textContent}）`);

console.log('\n[4] set_style 改样式');
r = await send({
  type: 'cs/act',
  action: { type: 'set_style', id: asideId, styles: { 'font-size': '20px', color: 'red' } },
});
check(r?.ok === true, 'set_style 返回成功');
check(aside.style.getPropertyValue('font-size') === '20px', '字号已生效');
check(aside.style.getPropertyValue('color') === 'red', '颜色已生效');

console.log('\n[5] add_style 注入全局 CSS');
r = await send({ type: 'cs/act', action: { type: 'add_style', css: '.ad-banner{display:none!important}' } });
check(r?.ok === true, 'add_style 返回成功');
const styles = doc.querySelectorAll('style[data-ai-agent-patch]');
check(styles.length === 1, `注入了 1 个样式表（实际 ${styles.length}）`);
check(styles[0].textContent.includes('.ad-banner'), '样式内容正确');

console.log('\n[6] remove_element 删除元素');
const sidebar2 = doc.body.querySelectorAll('.sidebar')[0];
r = await send({ type: 'cs/act', action: { type: 'remove', id: asideId } });
check(r?.ok === true, 'remove 返回成功');
check(sidebar2.parentNode === null, '元素已从 DOM 摘除');

console.log('\n[7] 改造计数');
r = await send({ type: 'cs/patch' });
check(r?.ok === true, 'patch 统计可读');
check(r.count >= 4, `记录了 ${r.count} 处改动`);
check(r.styles === 1, '统计到 1 个注入样式表');

console.log('\n[8] 撤销全部改动');
r = await send({ type: 'cs/patch-reset' });
check(r?.ok === true, '撤销返回成功');
check(ad.style.display === '', `广告 display 已还原（当前 "${ad.style.display}"）`);
check(btn.textContent === '点我', `按钮文字已还原（当前：${btn.textContent}）`);
check(aside.style.getPropertyValue('font-size') === '', '样式已还原');
check(sidebar2.parentNode !== null, '被删除的元素已重新插回 DOM');
check(doc.querySelectorAll('style[data-ai-agent-patch]').length === 0, '注入的样式表已移除');
check(r.failed.length === 0, `撤销过程无失败（${r.failed.length}）`);

console.log('\n[9] 二次撤销应当是空操作');
r = await send({ type: 'cs/patch-reset' });
check(r?.ok === true, '再次撤销不报错');
check(r.total === 0, '已无待撤销记录');

console.log('\n[10] 错误处理');
r = await send({ type: 'cs/act', action: { type: 'hide', id: 'e9999' } });
check(r?.ok === false, '操作不存在的元素会失败');
check(/找不到元素/.test(r.error || ''), '错误信息可读');
r = await send({ type: 'cs/act', action: { type: 'add_style', css: '' } });
check(r?.ok === false, '空 CSS 被拒绝');
r = await send({ type: 'cs/act', action: { type: 'inject_js', code: 'throw new Error("boom")' } });
check(r?.ok === false, '脚本抛错被捕获而不是崩溃');
check(/boom/.test(r.error || ''), '脚本错误信息被回传');

console.log('\n[11] inject_js 正常执行');
r = await send({
  type: 'cs/act',
  action: { type: 'inject_js', code: 'document.title = "被脚本改过";' },
});
check(r?.ok === true, 'inject_js 返回成功');
check(doc.title === '被脚本改过', `脚本确实执行了（title=${doc.title}）`);
doc.title = '测试页面';

console.log('\n[12] 原有点击仍然正常');
const btnId2 = (await snapshot()).data.elements.find((e) => e.text === '点我')?.id;
let clicked = false;
const b = doc.body.querySelectorAll('button')[0];
b.addEventListener('click', () => {
  clicked = true;
});
r = await send({ type: 'cs/act', action: { type: 'click', id: btnId2 } });
check(r?.ok === true, 'click 返回成功');
check(clicked, '点击事件真的派发了');

console.log('\n[13] 撤销不会误删页面原有内容');
const beforeCount = doc.body.children.length;
await send({ type: 'cs/patch-reset' });
check(doc.body.children.length === beforeCount, `页面结构未被破坏（${beforeCount} 个子节点）`);
check(doc.body.querySelectorAll('article').length === 1, '正文仍然在');

/* ---------------- 鼠标控制 ---------------- */

console.log('\n[14] 鼠标事件序列');
// 记录一次点击期间派发了哪些事件 —— 真实的鼠标点击应当有完整的序列
const btn2 = doc.body.querySelectorAll('button')[0];
const events = [];
for (const t of [
  'pointerover', 'mouseover', 'pointerenter', 'mouseenter',
  'pointermove', 'mousemove',
  'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
]) {
  btn2.addEventListener(t, () => events.push(t));
}
// 元素坐标：mini-DOM 的 getBoundingClientRect 返回 left:10 top:20 width:100 height:30
const id2 = (await snapshot()).data.elements.find((e) => e.tag === 'button')?.id;
r = await send({ type: 'cs/act', action: { type: 'click', id: id2 } });
check(r?.ok === true, 'click 执行成功');
check(events.includes('pointerdown'), '派发了 pointerdown');
check(events.includes('mousedown'), '派发了 mousedown');
check(events.includes('mouseup'), '派发了 mouseup');
check(events.includes('click'), '派发了 click');
check(events.includes('mouseover'), '点击前先派发 mouseover（触发 hover 逻辑）');
check(
  events.indexOf('mousedown') < events.indexOf('mouseup'),
  'mousedown 早于 mouseup（顺序正确）',
);
check(r.at?.[0] === 60, `返回点击坐标 x=60（元素中心，实际 ${r.at?.[0]}）`);
check(r.at?.[1] === 35, `返回点击坐标 y=35（实际 ${r.at?.[1]}）`);

console.log('\n[15] 可见光标');
const cursor = doc.documentElement.querySelectorAll('.__ai_agent_cursor');
check(cursor.length >= 0, '光标元素可被创建（不影响页面）');
// 光标如果存在，必须是不可交互的，否则会挡住页面点击
const existing = doc.documentElement.querySelectorAll('.__ai_agent_cursor')[0];
if (existing) {
  check(existing.style.pointerEvents === 'none', '光标 pointer-events:none（不挡页面）');
}

console.log('\n[16] hover 悬停');
const btn3 = doc.body.querySelectorAll('button')[0];
let hovered = false;
btn3.addEventListener('mouseover', () => {
  hovered = true;
});
const id3 = (await snapshot()).data.elements.find((e) => e.tag === 'button')?.id;
r = await send({ type: 'cs/act', action: { type: 'hover', id: id3 } });
check(r?.ok === true, 'hover 执行成功');
check(hovered, '元素收到了 mouseover');
check(Array.isArray(r.at), '返回了悬停坐标');

console.log('\n[17] click_at 坐标点击');
let atClicked = false;
btn3.addEventListener('click', () => {
  atClicked = true;
});
// mini-DOM 的 elementFromPoint 需要桩
doc.elementFromPoint = () => btn3;
r = await send({ type: 'cs/act', action: { type: 'click_at', x: 60, y: 35 } });
check(r?.ok === true, 'click_at 执行成功');
check(atClicked, '坐标点击真的触发了目标元素的 click');
check(r.at?.[0] === 60 && r.at?.[1] === 35, '回报了实际点击坐标');

console.log('\n[18] 坐标错误处理');
r = await send({ type: 'cs/act', action: { type: 'click_at', x: 'abc', y: 10 } });
check(r?.ok === false, '非法坐标被拒绝');
check(/坐标/.test(r.error || ''), '错误信息说明是坐标问题');
doc.elementFromPoint = () => null;
r = await send({ type: 'cs/act', action: { type: 'click_at', x: 9999, y: 9999 } });
check(r?.ok === false, '坐标上没有元素时报错而不是崩溃');
check(/没有元素/.test(r.error || ''), '错误信息可读');
doc.elementFromPoint = () => btn3;

console.log('\n[19] 快照带视口与中心坐标');
snap = await snapshot();
check(Boolean(snap.data.viewport), 'snapshot 返回视口尺寸');
check(typeof snap.data.viewport.width === 'number', '视口宽度是数字');
const anyEl = snap.data.elements[0];
check(Array.isArray(anyEl.box), '元素带 box 坐标');
check(anyEl.box.length === 4, 'box 是 [x,y,w,h]');

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 页面改造测试全部通过。');
