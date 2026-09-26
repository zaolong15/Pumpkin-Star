#!/usr/bin/env node
/**
 * outline-test.mjs —— 验证"结构快照"真的能看见可改造的区块。
 *
 * 这个测试针对一个真实问题：snapshot 只收可交互元素，
 * 而广告容器、侧边栏、正文主体都不是可交互元素 ——
 * 模型因此拿不到编号，只能盲猜 CSS，于是"改页面没效果"。
 *
 * 用法：node tools/outline-test.mjs
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

/* ---------------- 迷你 DOM（与 patch-test 同源，略作精简） ---------------- */

class FakeStyle {
  constructor() {
    this._p = new Map();
    this.display = '';
  }
  setProperty(k, v) {
    this._p.set(k, String(v));
    if (k === 'display') this.display = String(v);
  }
  getPropertyValue(k) {
    return this._p.get(k) ?? '';
  }
  removeProperty(k) {
    this._p.delete(k);
    if (k === 'display') this.display = '';
  }
  getPropertyPriority() {
    return '';
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
    this.isConnected = false;
    this.value = '';
    this.rect = { left: 0, top: 0, width: 300, height: 150 };
  }
  get id() {
    return this.attributes.get('id') || '';
  }
  set id(v) {
    this.attributes.set('id', v);
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get innerText() {
    return this.textContent;
  }
  get className() {
    return this.attributes.get('class') || '';
  }
  set className(v) {
    this.attributes.set('class', v);
  }
  get isContentEditable() {
    return false;
  }
  appendChild(c) {
    c.parentNode = this;
    c.isConnected = true;
    this.children.push(c);
    return c;
  }
  append(...n) {
    n.forEach((x) => this.appendChild(x));
  }
  insertBefore(n, ref) {
    n.parentNode = this;
    n.isConnected = true;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, n);
    else this.children.push(n);
    return n;
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
      this.isConnected = false;
    }
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
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  addEventListener() {}
  dispatchEvent() {
    return true;
  }
  click() {}
  focus() {}
  /**
   * 返回一个"像 DOMRect"的对象。
   * 真实 DOMRect 除了 left/top/width/height 还有 right/bottom/x/y，
   * content.js 用到 bottom 判断元素是否在首屏 —— 替身必须一并提供，
   * 否则会误判成"不是代码的问题"。
   */
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    };
  }
  scrollIntoView() {}
  matches(sel) {
    const s = sel.trim();
    const m = s.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[\w-]+(?:[~^$*]?="[^"]*")?\])*)$/);
    if (!m) return false;
    const [, tag, rest] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const t of rest.match(/[.#][\w-]+|\[[\w-]+(?:[~^$*]?="[^"]*")?\]/g) || []) {
      if (t.startsWith('#')) {
        if (this.id !== t.slice(1)) return false;
      } else if (t.startsWith('.')) {
        if (!this.className.split(/\s+/).includes(t.slice(1))) return false;
      } else {
        const am = t.match(/^\[([\w-]+)(?:([~^$*]?)=("([^"]*)")?)?\]$/);
        if (!am) return false;
        const [, key, op, , val] = am;
        const actual = this.getAttribute(key);
        if (actual === null) return false;
        if (!op) continue;
        if (op === '~=' && !actual.split(/\s+/).includes(val)) return false;
        if (op === '*' && !actual.includes(val)) return false;
        if (op === '^=' && !actual.startsWith(val)) return false;
        if (op === '$=' && !actual.endsWith(val)) return false;
        if (op === '=' && actual !== val) return false;
      }
    }
    return true;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        for (const part of sel.split(',')) {
          if (part.trim() && c.matches(part.trim())) {
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
    this.title = '测试文章页';
  }
  createElement(t) {
    return new FakeElement(t, this);
  }
  querySelector(s) {
    return this.documentElement.querySelector(s);
  }
  querySelectorAll(s) {
    return this.documentElement.querySelectorAll(s);
  }
}

/* ---------------- 造一个真实的文章页 ---------------- */

const doc = new FakeDocument();
doc.body.className = 'page article-page';
doc.documentElement.className = 'theme-light';

// 页头
const header = doc.createElement('header');
header.className = 'site-header';
header.textContent = '我的网站';
header.rect = { left: 0, top: 0, width: 1200, height: 60 };
doc.body.appendChild(header);

// 导航
const nav = doc.createElement('nav');
nav.className = 'main-nav';
nav.textContent = '首页 文章 关于';
nav.rect = { left: 0, top: 60, width: 1200, height: 40 };
doc.body.appendChild(nav);

// 正文主体 —— 最要紧的改造目标
const article = doc.createElement('article');
article.className = 'post-content';
article.textContent = '这是正文内容，很长很长。'.repeat(20);
article.rect = { left: 100, top: 120, width: 700, height: 900 };
doc.body.appendChild(article);

// 广告位 —— 典型改造目标，且不是可交互元素
const ad = doc.createElement('div');
ad.className = 'ad-banner promo-box';
ad.textContent = '限时优惠 立即抢购';
ad.rect = { left: 100, top: 150, width: 700, height: 120 };
doc.body.appendChild(ad);

// 侧边栏
const aside = doc.createElement('aside');
aside.className = 'sidebar related';
aside.textContent = '相关推荐';
aside.rect = { left: 830, top: 120, width: 300, height: 600 };
doc.body.appendChild(aside);

// 评论区
const comments = doc.createElement('section');
comments.className = 'comment-section';
comments.textContent = '评论区';
comments.rect = { left: 100, top: 1050, width: 700, height: 400 };
doc.body.appendChild(comments);

// 一个小的装饰元素（应当被过滤掉）
const dot = doc.createElement('div');
dot.className = 'deco-dot';
dot.rect = { left: 0, top: 0, width: 8, height: 8 };
doc.body.appendChild(dot);

// 页脚
const footer = doc.createElement('footer');
footer.className = 'site-footer';
footer.textContent = '版权所有';
footer.rect = { left: 0, top: 1500, width: 1200, height: 80 };
doc.body.appendChild(footer);

/* ---------------- 搭环境并加载 content.js ---------------- */

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
globalThis.location = { href: 'https://blog.example.com/post/1' };
globalThis.history = { back() {} };
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.PointerEvent = class { constructor(t, o) { Object.assign(this, { type: t }, o || {}); } };
globalThis.MouseEvent = globalThis.PointerEvent;
globalThis.KeyboardEvent = globalThis.PointerEvent;
globalThis.Event = globalThis.PointerEvent;
globalThis.InputEvent = globalThis.PointerEvent;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } };

const src = await readFile(path.join(root, 'src/content/content.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function(src)();

function send(msg, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    for (const fn of listeners) fn(msg, {}, done);
    setTimeout(() => done(null), timeoutMs);
  });
}

/* ---------------- 开测 ---------------- */

console.log('\n结构快照测试\n');

console.log('[1] outline 能找到可改造区块');
const res = await send({ type: 'cs/outline' });
check(res?.ok === true, 'outline 调用成功');
const data = res.data;
check(Array.isArray(data.blocks), '返回区块数组');

const byCls = (needle) => data.blocks.find((b) => (b.cls || '').includes(needle));
check(Boolean(byCls('ad-banner')), '找到广告容器 .ad-banner');
check(Boolean(byCls('post-content')), '找到正文主体 .post-content');
check(Boolean(byCls('sidebar')), '找到侧边栏 .sidebar');
check(Boolean(byCls('comment-section')), '找到评论区 .comment-section');
check(Boolean(byCls('site-header')), '找到页头 header');
check(Boolean(byCls('site-footer')), '找到页脚 footer');

console.log('\n[2] 每个区块都带可操作的信息');
const adBlock = byCls('ad-banner');
check(Boolean(adBlock.id), `广告区块有编号（${adBlock.id}）`);
check(adBlock.tag === 'div', '标签名正确');
check(adBlock.cls.includes('promo-box'), '完整 class 被带出');
check(typeof adBlock.areaPct === 'number' && adBlock.areaPct > 0, `有面积占比（${adBlock.areaPct}%）`);
check(Array.isArray(adBlock.box), '有坐标');
check(Boolean(adBlock.text), '有文字摘要');

console.log('\n[3] 正文面积应排在前列（便于模型识别主体）');
const articleIdx = data.blocks.findIndex((b) => (b.cls || '').includes('post-content'));
check(articleIdx >= 0 && articleIdx < 4, `正文排在前面（第 ${articleIdx + 1} 位）`);
check(data.blocks[0].areaPct >= data.blocks[data.blocks.length - 1].areaPct, '按面积降序');

console.log('\n[4] 过滤装饰性小元素');
const deco = byCls('deco-dot');
check(!deco, '8x8 的装饰元素被过滤掉（不浪费 token）');

console.log('\n[5] 首屏标记');
check(data.blocks.some((b) => b.inView), '有区块被标记为首屏可见');
const footerBlock = byCls('site-footer');
check(footerBlock && !footerBlock.inView, '页脚不在首屏');

console.log('\n[6] 带上页面级 class（写 CSS 时的关键线索）');
check(data.bodyClass?.includes('article-page'), `返回 body class（${data.bodyClass}）`);
check(Boolean(data.htmlClass), '返回 html class');
check(Boolean(data.viewport), '返回视口尺寸');

console.log('\n[7] 拿到的编号真的能用于改造');
const r = await send({ type: 'cs/act', action: { type: 'hide', id: adBlock.id } });
check(r?.ok === true, '用 outline 给的编号直接 hide 成功');
check(ad.style.display === 'none', '广告确实被隐藏了');
const r2 = await send({ type: 'cs/act', action: { type: 'set_style', id: article.id || byCls('post-content').id, styles: { 'font-size': '18px' } } });
check(r2?.ok === true, '用 outline 给的编号改正文样式成功');
check(article.style.getPropertyValue('font-size') === '18px', '正文字号生效');

console.log('\n[8] 可写 CSS 的真实选择器（验证模型能照抄）');
// outline 给出的 class 必须真的是页面上的 class，否则模型写 CSS 必然失败
check(adBlock.cls.split(/\s+/).every((c) => ad.className.split(/\s+/).includes(c)),
  'outline 报告的 class 与真实 class 一致');

console.log('\n[9] 撤销仍然正常');
const rr = await send({ type: 'cs/patch-reset' });
check(rr?.ok === true, '撤销成功');
check(ad.style.display === '', '广告恢复显示');
check(article.style.getPropertyValue('font-size') === '', '正文字号恢复');

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 结构快照测试全部通过。');
