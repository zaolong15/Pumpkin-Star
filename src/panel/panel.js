/**
 * panel.js —— 侧边栏界面的总控。
 * 负责：消息渲染、会话历史、设置读写、记忆库与用量界面、调用 agent 循环。
 */

import { MSG, DEFAULT_SETTINGS, MEMORY_KIND_LABEL, ACCENT_PRESETS, GLASS_MODES } from '../shared/messages.js';
import { costOf, todayCost, balanceView, DEFAULT_PRICES } from '../shared/usage.js';
import { runAgent, callBg } from './agent.js';
import { ICON_LIBRARY, renderIcon, iconSvgString } from './icons.js';
import { readFiles, renderFiles, summarizeFiles, MAX_FILES } from './upload.js';
import {
  sanitizeFilename,
  serialize,
  chooseOutputDir,
  getOutputDir,
  forgetOutputDir,
  writeToOutputDir,
  mimeOf,
  extOf,
  isAllowedExt,
  validateContent,
} from './files.js';

const $ = (id) => document.getElementById(id);
const el = {
  chat: $('chat'),  input: $('input'),
  send: $('btnSend'),
  cancel: $('btnCancel'),
  // 运行条已移除（改用发送/停止键的可用性表达运行状态）
  steps: $('steps'),
  dot: $('statusDot'),
  modelHint: $('modelHint'),
  modelList: $('modelList'),
  modelListHint: $('modelListHint'),
  btnFetchModels: $('btnFetchModels'),
  tokenHint: $('tokenHint'),
  clear: $('btnClear'),
  page: $('btnPage'),
  settings: $('btnSettings'),
  memory: $('btnMemory'),
  usage: $('btnUsage'),
  modal: $('settingsModal'),
  sBaseUrl: $('sBaseUrl'),
  sApiKey: $('sApiKey'),
  sModel: $('sModel'),
  sTemp: $('sTemp'),
  sSteps: $('sSteps'),
  sMemory: $('sMemory'),
  sFloating: $('sFloating'),
  sCdp: $('sCdp'),
  sSave: $('btnSettingsSave'),
  sCancel: $('btnSettingsCancel'),
  sReset: $('btnSettingsReset'),
  // 外观
  sAccentCustom: $('sAccentCustom'),
  sAccentHex: $('sAccentHex'),
  accentSwatches: $('accentSwatches'),
  sMode: $('sMode'),
  sGlass: $('sGlass'),
  glassHint: $('glassHint'),
  sRadius: $('sRadius'),
  radiusVal: $('radiusVal'),
  sDensity: $('sDensity'),
  sMotion: $('sMotion'),
  // 记忆库
  memModal: $('memoryModal'),
  memList: $('memList'),
  memStats: $('memStats'),
  memKind: $('memKind'),
  memText: $('memText'),
  memAddBtn: $('memAddBtn'),
  memClose: $('memClose'),
  memClearAuto: $('memClearAuto'),
  // 用量与余额
  usageModal: $('usageModal'),
  uSource: $('uSource'),
  uBalance: $('uBalance'),
  uBalanceDetail: $('uBalanceDetail'),
  uToday: $('uToday'),
  uTodayDetail: $('uTodayDetail'),
  uSession: $('uSession'),
  uSessionDetail: $('uSessionDetail'),
  uTotal: $('uTotal'),
  uTotalDetail: $('uTotalDetail'),
  uPriceIn: $('uPriceIn'),
  uPriceOut: $('uPriceOut'),
  uPriceSave: $('uPriceSave'),
  uPriceHint: $('uPriceHint'),
  usageHistory: $('usageHistory'),
  uClose: $('uClose'),
  uRefresh: $('uRefresh'),
  uResetSession: $('uResetSession'),
  uResetAll: $('uResetAll'),
  // 计费设置
  sPriceIn: $('sPriceIn'),
  sPriceOut: $('sPriceOut'),
  sBudget: $('sBudget'),
  // 品牌图标
  brandIcon: $('brandIcon'),
  brandIconGrid: $('brandIconGrid'),
  brandIconFile: $('brandIconFile'),
  brandIconClear: $('brandIconClear'),
  brandIconHint: $('brandIconHint'),
  sApplyToolbar: $('sApplyToolbar'),
  // 自进化
  sEvolution: $('sEvolution'),
  sEvolutionInject: $('sEvolutionInject'),
  sFileOutput: $('sFileOutput'),
  btnEvolve: $('btnEvolve'),
  evolveModal: $('evolveModal'),
  evoStats: $('evoStats'),
  evoTabs: $('evoTabs'),
  evoClose: $('evoClose'),
  evoClearAuto: $('evoClearAuto'),
  skillName: $('skillName'),
  skillTrigger: $('skillTrigger'),
  skillSteps: $('skillSteps'),
  skillAddBtn: $('skillAddBtn'),
  skillList: $('skillList'),
  ruleKind: $('ruleKind'),
  ruleText: $('ruleText'),
  ruleAddBtn: $('ruleAddBtn'),
  ruleList: $('ruleList'),
  // 文件输出
  fileModal: $('fileModal'),
  fileDirBox: $('fileDirBox'),
  fileDirName: $('fileDirName'),
  fileDirHint: $('fileDirHint'),
  fileChooseDir: $('fileChooseDir'),
  fileName: $('fileName'),
  fileFormat: $('fileFormat'),
  fileContent: $('fileContent'),
  fileHint: $('fileHint'),
  fileSave: $('fileSave'),
  fileDownload: $('fileDownload'),
  fileForget: $('fileForget'),
  // 附件与剪贴板
  attachBar: $('attachBar'),
  btnAttach: $('btnAttach'),
  btnClip: $('btnClip'),
  fileInput: $('fileInput'),
};

let settings = { ...DEFAULT_SETTINGS };
let history = [];
/**
 * 任务是否在运行。
 *
 * 刻意保持极简：只有一个 busy 标志，**不驱动任何文字提示**。
 * 之前有一整套"运行条"（显示处理中 / 第几步 / 正在停止），
 * 反复出现"任务早已结束但界面仍显示处理中"—— 根因是
 * "要展示的状态"和"真实状态"是两份数据，任何一条异常路径没同步上就卡住。
 *
 * 现在运行中不做文字提示，只改两个控件的可用性：
 * 发送键置灰、停止键点亮。即使偶尔没复位，也不会有假提示挂在那里骗人，
 * 而且停止键任何时候点都有确定行为。
 */
let busy = false;
let cancelled = false;
/** 当前运行的中止函数，由 runAgent 在开始时注入。 */
let abortCurrent = null;
let sessionTokens = 0;
let memFilter = 'all';

/* ---------------- 主题引擎 ----------------
 * 把外观设置映射成 CSS 变量挂在 <html> 上。
 * 样式表只消费变量，不关心当前是什么主题 —— 换肤不需要重写任何 CSS。
 */

/** #rrggbb → {r,g,b}，非法输入返回 null。 */
function parseHex(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** RGB → HSL，用于推导 hover/active 等派生色。 */
function rgbToHsl({ r, g, b }) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 调整明度，返回 CSS 颜色串。 */
function shade(hsl, dl, ds = 0) {
  return `hsl(${hsl.h.toFixed(1)} ${clamp(hsl.s + ds, 0, 100).toFixed(1)}% ${clamp(hsl.l + dl, 0, 100).toFixed(1)}%)`;
}

/** 判断主题色偏亮还是偏暗，决定按钮上的文字用黑还是白。 */
function isLightColor({ r, g, b }) {
  // W3C 相对亮度
  const lin = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55;
}

/** 解析出最终生效的深浅模式（system 时看系统偏好）。 */
function resolveMode(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** 把外观设置写到根元素的 CSS 变量上。 */
function applyTheme(theme) {
  const t = { ...DEFAULT_SETTINGS.theme, ...(theme || {}) };
  const root = document.documentElement;
  const mode = resolveMode(t.mode);

  root.setAttribute('data-mode', mode);
  root.setAttribute('data-glass', t.glass || 'tint');
  root.setAttribute('data-density', t.density || 'normal');
  root.setAttribute('data-motion', t.motion === false ? 'off' : 'on');

  // 圆角：0..1 → 4..18px，其余尺寸按比例派生
  const r = clamp(Number(t.radius ?? 0.55), 0, 1);
  root.style.setProperty('--radius', `${(4 + r * 8).toFixed(1)}px`);
  root.style.setProperty('--radius-sm', `${(3 + r * 4).toFixed(1)}px`);
  root.style.setProperty('--radius-lg', `${(6 + r * 10).toFixed(1)}px`);

  // accent === 'neutral' 表示不指定颜色：清掉 inline 覆盖，
  // 让样式表里按深浅模式定义的中性主色生效（这是 DSH 的默认观感）
  if (!t.accent || t.accent === 'neutral') {
    for (const v of ['--accent', '--accent-hover', '--accent-active', '--accent-soft', '--accent-on', '--accent-line']) {
      root.style.removeProperty(v);
    }
    root.setAttribute('data-accent', 'neutral');
    root.style.setProperty('color-scheme', mode);
    syncFloatTheme({ ...t, accent: 'neutral' });
    return;
  }

  const rgb = parseHex(t.accent) || parseHex('#4f8cff');
  const hsl = rgbToHsl(rgb);
  root.setAttribute('data-accent', 'custom');

  // 主题色及其派生（hover / 按下 / 浅底 / 描边）
  const hex = `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-hover', shade(hsl, mode === 'light' ? -8 : 6));
  root.style.setProperty('--accent-active', shade(hsl, mode === 'light' ? -14 : -6));
  root.style.setProperty(
    '--accent-soft',
    mode === 'light' ? shade(hsl, 38, -12) : shade(hsl, -26, 4),
  );
  root.style.setProperty('--accent-on', isLightColor(rgb) ? '#0d0f14' : '#ffffff');
  root.style.setProperty('--accent-line', shade(hsl, mode === 'light' ? -6 : 4, -8));

  root.style.setProperty('color-scheme', mode);

  // 同步给页面悬浮窗
  syncFloatTheme({ ...t, accent: hex });
}

/** 把主题推给所有标签页的悬浮窗。 */
function syncFloatTheme(theme) {
  chrome.runtime
    .sendMessage({ type: 'panel/theme', theme: { ...theme, resolvedMode: resolveMode(theme.mode) } })
    .catch(() => {});
}

/** 系统深浅模式变化时，若设置为跟随则重新应用。 */
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if ((settings.theme?.mode || 'system') === 'system') applyTheme(settings.theme);
});

/* ---------------- Markdown 轻量渲染 ---------------- */

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 够用就好的 Markdown：代码块、标题、列表、表格、粗体、行内代码、链接。 */
function renderMarkdown(src) {
  const blocks = [];
  let text = String(src || '');

  // 1. 先把围栏代码块摘出来，避免被后续规则破坏
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(code.trim())}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  // 2. 行内代码
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 3. 标题
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // 4. 粗体 / 斜体
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // 5. 链接
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );

  // 6. 表格
  text = text.replace(
    /(^\|.+\|\s*$\n^\|[\s:|-]+\|\s*$\n(?:^\|.*\|\s*$\n?)*)/gm,
    (table) => {
      const rows = table.trim().split('\n');
      const cells = (line) =>
        line
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      return [
        '<table><thead><tr>',
        ...head.map((h) => `<th>${h}</th>`),
        '</tr></thead><tbody>',
        ...body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`),
        '</tbody></table>',
      ].join('');
    },
  );

  // 7. 列表
  text = text.replace(/(?:^[-*+]\s+.+$\n?)+/gm, (list) => {
    const items = list
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^[-*+]\s+/, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });
  text = text.replace(/(?:^\d+\.\s+.+$\n?)+/gm, (list) => {
    const items = list
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`)
      .join('');
    return `<ol>${items}</ol>`;
  });

  // 8. 段落
  text = text
    .split(/\n{2,}/)
    .map((p) => (/^\s*<(h\d|ul|ol|table|pre|blockquote)/.test(p.trim()) || !p.trim() ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`))
    .join('\n');

  // 9. 还原代码块
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return text;
}

/* ---------------- 渲染 ---------------- */

function addMessage(role, content, { markdown = false, error = false } = {}) {
  document.querySelector('.welcome')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}${error ? ' error' : ''}`;
  if (markdown) div.innerHTML = renderMarkdown(content);
  else div.textContent = content;
  el.chat.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  el.chat.scrollTop = el.chat.scrollHeight;
}

function setStatus(state, title) {
  el.dot.className = `dot${state === 'busy' ? ' busy' : state === 'err' ? ' err' : ''}`;
  el.dot.title = title || '就绪';
}

function addStepLine(name, args, result) {
  el.steps.hidden = false;
  const ok = result?.ok !== false && !result?.error;
  const div = document.createElement('div');
  div.className = 'step-line';

  const argText = (() => {
    if (!args || !Object.keys(args).length) return '';
    if (args.value) return `"${String(args.value).slice(0, 40)}"`;
    if (args.id) return args.id;
    if (args.amount) return String(args.amount);
    if (args.url) return String(args.url).slice(0, 40);
    if (args.text) return `"${String(args.text).slice(0, 40)}"`;
    if (args.css) return `CSS ${String(args.css).length} 字`;
    if (args.code) return `JS ${String(args.code).length} 字`;
    if (args.styles) return Object.keys(args.styles).join(',');
    return '';
  })();

  const resultText = (() => {
    if (result?.error) return result.error;
    if (name === 'snapshot') return `${result?.elements?.length ?? 0} 个元素`;
    if (name === 'read_page') return `读到 ${result?.text?.length ?? 0} 字`;
    if (name === 'remember') return result?.saved ? '已记住' : '已有相同记忆';
    if (result?.clicked) return `点击了 ${result.clicked}`;
    if (result?.typed) return `输入了 "${result.typed}"`;
    if (result?.moved !== undefined) return `滚动 ${result.moved}px`;
    if (result?.hidden) return '已隐藏';
    if (result?.shown) return '已显示';
    if (result?.set_text) return '已改文字';
    if (result?.styled) return '已改样式';
    if (result?.injected === 'style') return '已注入 CSS';
    if (result?.injected === 'js') return '已执行脚本';
    if (result?.removed) return '已删除元素';
    return '完成';
  })();

  // 用 DOM 节点拼装而不是 innerHTML：模型返回的文本直接进 textContent，天然免疫注入
  const span = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };

  div.append(
    span('tool', String(name)),
    span('body', argText),
    span(`status ${ok ? 'ok' : 'bad'}`, ok ? '✓' : '✕'),
    span('body', String(resultText).slice(0, 70)),
  );
  el.steps.appendChild(div);
  el.steps.scrollTop = el.steps.scrollHeight;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function updateModelHint() {
  if (!settings.apiKey) {
    el.modelHint.textContent = '⚠ 未配置 API Key';
    setStatus('err', '未配置 API Key');
  } else {
    el.modelHint.textContent = settings.model;
    setStatus('idle', '就绪');
  }
  el.tokenHint.textContent = sessionTokens ? `${fmtTokens(sessionTokens)} tokens` : '';
}

/**
 * 设置运行中状态。
 * 只做两件事：置位 busy、切换发送键与停止键的可用性。
 * 不显示任何文字提示 —— 没有"要展示的状态"，就没有会卡住的显示状态。
 */
function setBusy(on) {
  busy = on;
  el.send.disabled = on;
  el.cancel.disabled = !on;
  setStatus(on ? 'busy' : 'idle', on ? '运行中' : '就绪');
  updateModelHint();
}

/* ---------------- 主流程 ---------------- */

async function handleTask(task) {
  const raw = String(task || '').trim();
  // 允许"只发文件不发文字"：有附件时任务描述可以留空
  if (!raw && !attachments.length && !clipContext) return;

  const text = raw || '（见附带的文件）';

  // 附件与剪贴板内容拼进上下文。
  // 这里拼在任务文本里而不是单独的消息，是为了让它们和任务强绑定 ——
  // 否则模型可能把附件内容当成历史对话的一部分而忽略。
  const extraParts = [];
  if (attachments.length) {
    const rendered = renderFiles(attachments);
    if (rendered) extraParts.push(`以下是用户附带的文件：\n\n${rendered}`);
  }
  if (clipContext) {
    extraParts.push(`以下是用户剪贴板里的内容：\n\n<clipboard>\n${clipContext}\n</clipboard>`);
  }
  const taskWithContext = extraParts.length ? `${text}\n\n${extraParts.join('\n\n')}` : text;

  // 已经在跑就忽略这次提交（正常的并发保护）。
  // 注意：这里不再需要"卡死自愈"逻辑 —— busy 已经不驱动任何
  // 可见提示，即使异常残留也只是发送键灰着，而停止键一点就恢复。
  if (busy) return;

  if (!settings.apiKey) {
    addMessage('assistant', '还没有配置 API Key。点击右上角 ⚙ 填入你的模型服务信息即可开始。', {
      error: true,
    });
    openSettings();
    return;
  }

  // 从这一行起，任何异常都必须经过 finally 收尾。
  // 注意：addMessage 与 setBusy(true) 都放进 try 里 ——
  // 放在 try 外面的话，它们自己抛错就没人负责把 busy 复位。
  let replyEl = null;
  let result = null;
  try {
    addMessage('user', text);
    el.input.value = '';
    autoGrow();
    el.steps.innerHTML = '';
    el.steps.hidden = true;
    cancelled = false;
    sessionTokens = 0;
    setBusy(true);

    replyEl = addMessage('assistant', '…');

    // 附件已经交出去了，清空避免下次任务重复带上
    if (attachments.length || clipContext) {
      const desc = summarizeFiles(attachments);
      if (desc) addStepLine('attach', { text: desc }, { ok: true });
      attachments = [];
      clipContext = '';
      renderAttachBar();
    }

    result = await runAgent({
      task: taskWithContext,
      history,
      settings,
      isCancelled: () => cancelled,
      onAbortReady: (fn) => {
        abortCurrent = fn;
      },
      onEvent: (evt) => {
        // 渲染出错不该让整个任务卡死
        try {
          handleAgentEvent(evt, replyEl);
        } catch (err) {
          console.error('渲染事件失败', err);
        }
      },
    });
  } catch (err) {
    // 注意：这里不要再调用可能抛错的渲染函数，否则错误会二次逃逸
    try {
      replyEl?.remove();
      addMessage('assistant', `运行出错：${err?.message || err}`, { error: true });
    } catch {
      /* 连错误提示都渲染不出来就算了，关键是 finally 会把界面复位 */
    }
    return;
  } finally {
    // 无论成功、失败、中止还是渲染崩溃，都在这里解除忙碌状态。
    // 这是"发送键不会一直灰着"的最后一道保证。
    abortCurrent = null;
    setBusy(false);
    scrollToBottom();
  }

  // ── 以下是收尾渲染 ──
  // 整段包在 try 里：finally 已经让界面恢复可用，
  // 这里再抛错绝不能把异常抛给调用方（那会造成 unhandled rejection）。
  try {
    if (!result) return;

    if (result.aborted) {
      replyEl?.remove();
      addMessage('assistant', '已停止。');
    } else if (result.error) {
      replyEl?.remove();
    } else {
      // 记录进历史，保证多轮上下文
      history.push({ role: 'user', content: raw || text });
      history.push({ role: 'assistant', content: result.summary || '(完成)' });
      if (history.length > 16) history = history.slice(-16);
    }

    // 达到步数上限时给一句明确的话，而不是只留个没下文的答复
    if (result.exhausted && !result.aborted) {
      addMessage(
        'assistant',
        '⚠️ 已达到最大步数上限，任务未完成。可以让我继续，或在设置里调高「最大步数」。',
        { error: true },
      );
    }
  } catch (err) {
    console.error('收尾渲染失败', err);
  }

  // 下面的收尾（记用量、提炼记忆）都是尽力而为，
  // 全部包在 try 里 —— 它们抛错绝不能把已经恢复的界面再次弄乱。
  try {
    await callBg('usage/task-record', {
      record: {
        task: text,
        model: settings.model,
        usage: result.usage && result.usage.calls
          ? {
              prompt_tokens: result.usage.prompt,
              completion_tokens: result.usage.completion,
              total_tokens: result.usage.total,
            }
          : null,
        steps: result.steps?.length || 0,
        ok: !result.error && !result.aborted,
      },
    });
  } catch {
    /* 忽略 */
  }

  // 自进化复盘：从这次执行里提炼技能与规则。
  // 与记忆提炼一样后台跑，不阻塞界面；失败也不影响任何东西。
  if (
    !result.aborted &&
    !result.error &&
    settings.evolutionEnabled !== false &&
    result.summary &&
    result.steps?.length
  ) {
    callBg(MSG.SKILL_DISTILL, {
      payload: {
        task: text,
        summary: result.summary,
        steps: result.steps,
        ok: !result.error,
      },
    })
      .then((r) => {
        if (r?.added) {
          el.steps.hidden = false;
          addStepLine('evolve', { text: `学到 ${r.skillsAdded || 0} 技能 / ${r.rulesAdded || 0} 规则` }, { ok: true });
        }
      })
      .catch(() => {});
  }

  // 自动提炼记忆（后台跑，不阻塞界面）
  if (!result.aborted && !result.error && settings.memoryEnabled !== false && result.summary) {
    callBg(MSG.MEM_DISTILL, {
      payload: { task: text, summary: result.summary, url: undefined },
    })
      .then((r) => {
        if (r?.added) {
          el.steps.hidden = false;
          addStepLine('memory', { text: `新增 ${r.added} 条记忆` }, { ok: true });
        }
      })
      .catch(() => {});
  }
}

/** 处理智能体事件（拆出来是为了在 onEvent 里包一层 try）。 */
function handleAgentEvent(evt, replyEl) {
  switch (evt.type) {
    // step / tool 事件不再改变任何界面文字 —— 运行中不显示"第几步""正在做什么"。
    // 步骤时间线（下面的 result 分支）仍然会记录每一次工具调用。
    case 'step':
    case 'tool':
      break;
    case 'memory':
      if (evt.count) {
        el.steps.hidden = false;
        addStepLine('memory', { text: `${evt.count} 条相关记忆` }, { ok: true });
      }
      break;
    case 'memory-added':
      addStepLine('remember', { text: evt.text }, { ok: true, saved: true });
      break;
    case 'file':
      // Agent 想导出文件：打开弹窗让用户确认保存位置，不静默写盘
      addStepLine('export_file', { text: evt.filename }, { ok: true });
      openFileModal({
        filename: evt.filename || 'output.md',
        content: evt.content || '',
      });
      break;
    case 'skills':
      if (evt.count) {
        el.steps.hidden = false;
        addStepLine('skills', { text: `复用 ${evt.names?.join('、') || evt.count + ' 条技能'}` }, { ok: true });
      }
      break;
    case 'rules':
      if (evt.count) {
        el.steps.hidden = false;
        addStepLine('rules', { text: `遵循 ${evt.count} 条自我规则` }, { ok: true });
      }
      break;
    case 'usage':
      sessionTokens = evt.usage.total;
      el.tokenHint.textContent = sessionTokens ? `${fmtTokens(sessionTokens)} tokens` : '';
      break;
    case 'result':
      addStepLine(evt.name, evt.args, evt.result);
      break;
    case 'done':
      replyEl.innerHTML = renderMarkdown(evt.summary || '完成。');
      scrollToBottom();
      break;
    case 'error':
      // 不在这里删 replyEl：后续还可能继续渲染，统一在收尾处处理
      replyEl.dataset.failed = '1';
      addMessage('assistant', `出错了：${evt.message}`, { error: true });
      break;
    default:
      break;
  }
}

/* ---------------- 附件与剪贴板 ---------------- */

/** 已附加的文件（本轮的上下文）。发送后清空。 */
let attachments = [];
/** 从剪贴板读来的文本，作为额外上下文。 */
let clipContext = '';

/** 刷新附件条显示。 */
function renderAttachBar() {
  const bar = el.attachBar;
  if (!bar) return;
  bar.textContent = '';

  const items = [];
  for (const [i, f] of attachments.entries()) {
    items.push({
      label: f.name,
      size: f.kind === 'text' ? '文本' : f.kind === 'image' ? '图片' : '文件',
      cls: f.kind === 'image' ? 'image' : '',
      onRemove: () => {
        attachments.splice(i, 1);
        renderAttachBar();
      },
    });
  }
  if (clipContext) {
    items.push({
      label: `剪贴板 ${clipContext.length} 字`,
      size: '',
      cls: 'clip',
      onRemove: () => {
        clipContext = '';
        renderAttachBar();
      },
    });
  }

  if (!items.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  for (const it of items) {
    const chip = document.createElement('span');
    chip.className = `attach-chip ${it.cls}`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.label;
    nm.title = it.label;
    chip.appendChild(nm);
    if (it.size) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = it.size;
      chip.appendChild(sz);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = '移除';
    rm.addEventListener('click', it.onRemove);
    chip.appendChild(rm);
    bar.appendChild(chip);
  }
}

// 选文件
el.btnAttach?.addEventListener('click', () => {
  el.fileInput?.click();
});

el.fileInput?.addEventListener('change', async (e) => {
  const picked = e.target.files;
  if (!picked?.length) return;

  const remain = MAX_FILES - attachments.length;
  if (remain <= 0) {
    addMessage('assistant', `最多附加 ${MAX_FILES} 个文件。`, { error: true });
    e.target.value = '';
    return;
  }

  el.btnAttach.classList.add('busy');
  try {
    const read = await readFiles(Array.from(picked).slice(0, remain));
    attachments.push(...read);
    renderAttachBar();
  } catch (err) {
    addMessage('assistant', `读取文件失败：${err.message}`, { error: true });
  } finally {
    el.btnAttach.classList.remove('busy');
    e.target.value = '';
  }
});

// 读剪贴板
el.btnClip?.addEventListener('click', async () => {
  el.btnClip.classList.add('busy');
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      addMessage('assistant', '剪贴板是空的。');
      return;
    }
    clipContext = text.slice(0, 50000);
    renderAttachBar();
  } catch (err) {
    addMessage(
      'assistant',
      `读取剪贴板失败：${err?.message || err}。浏览器会要求剪贴板权限，请允许后重试。`,
      { error: true },
    );
  } finally {
    el.btnClip.classList.remove('busy');
  }
});

/* ---------------- 输入框 ---------------- */

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 140)}px`;
}

el.input.addEventListener('input', autoGrow);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    handleTask(el.input.value.trim());
  }
});

el.send.addEventListener('click', () => handleTask(el.input.value.trim()));

/**
 * 停止当前任务。
 *
 * 由于不再有"处理中"提示，这个按钮不需要处理任何显示状态，
 * 只做两件确定的事：置取消标志、掐断在途的模型请求。
 * 任务收尾时 handleTask 的 finally 会把 busy 复位。
 */
function stopTask() {
  cancelled = true;
  Promise.resolve(abortCurrent?.()).catch(() => {});
  // 立即解除忙碌：让用户马上能继续输入。
  // 后台的收尾（历史记录、用量、记忆提炼）不依赖界面状态。
  setBusy(false);
}

el.cancel.addEventListener('click', stopTask);

// 快捷键：Esc 也能停
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stopTask();
});

el.clear.addEventListener('click', () => {
  history = [];
  sessionTokens = 0;
  el.chat.innerHTML = '';
  el.steps.innerHTML = '';
  el.steps.hidden = true;
  location.reload();
});

/* ---------------- 页面信息面板 ---------------- */

el.page.addEventListener('click', async () => {
  try {
    const snap = await callBg(MSG.GET_PAGE);
    const lines = [
      `**${snap.title}**`,
      snap.url,
      '',
      `可交互元素 ${snap.elements.length} 个：`,
      ...snap.elements.slice(0, 20).map((e) => {
        const label = e.text || e.name || e.placeholder || e.type || e.tag;
        return `- \`${e.id}\` ${e.tag} — ${String(label).slice(0, 50)}`;
      }),
    ];
    if (snap.elements.length > 20) lines.push(`- …还有 ${snap.elements.length - 20} 个`);
    addMessage('assistant', lines.join('\n'), { markdown: true });
  } catch (err) {
    addMessage('assistant', `读取页面失败：${err.message}`, { error: true });
  }
});

/* ---------------- 设置 ---------------- */

/** 外观草稿：在弹窗里改动即时预览，点保存才落盘。 */
let themeDraft = { ...DEFAULT_SETTINGS.theme };

/** 构建预设色板按钮。 */
function buildSwatches() {
  el.accentSwatches.textContent = '';
  for (const preset of ACCENT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.value = preset.value;
    b.title = preset.name;
    if (preset.value === 'neutral') {
      // 中性项用一枚灰阶小圆表示（用渐变暗示"无色"）
      b.classList.add('neutral');
    } else {
      b.style.setProperty('--sw', preset.value);
    }
    b.addEventListener('click', () => {
      themeDraft.accent = preset.value;
      if (preset.value !== 'neutral') {
        el.sAccentHex.value = preset.value;
        el.sAccentCustom.value = preset.value;
      }
      applyTheme(themeDraft);
      syncAppearanceUI();
    });
    el.accentSwatches.appendChild(b);
  }
}

/** 分段选择器的选中态。 */
function setSegmented(container, value) {
  container.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.value === value);
  });
}

/** 把 themeDraft 同步到外观面板的控件上。 */
function syncAppearanceUI() {
  const isNeutral = !themeDraft.accent || themeDraft.accent === 'neutral';
  el.sAccentHex.value = isNeutral ? '' : themeDraft.accent;
  el.sAccentHex.placeholder = isNeutral ? '中性' : '';
  if (!isNeutral) el.sAccentCustom.value = themeDraft.accent;
  setSegmented(el.sMode, themeDraft.mode);
  setSegmented(el.sGlass, themeDraft.glass);
  setSegmented(el.sDensity, themeDraft.density);
  el.sRadius.value = String(themeDraft.radius);
  el.radiusVal.textContent = `${Math.round(4 + Number(themeDraft.radius) * 8)}px`;
  el.sMotion.checked = themeDraft.motion !== false;
  el.accentSwatches.querySelectorAll('.swatch').forEach((b) => {
    const v = b.dataset.value;
    const active = v === 'neutral' ? isNeutral : v.toLowerCase() === String(themeDraft.accent).toLowerCase();
    b.classList.toggle('active', active);
  });
  const g = GLASS_MODES.find((m) => m.value === themeDraft.glass);
  el.glassHint.textContent = g ? g.hint : '';
}

/** 切换设置弹窗的分页。 */
function showTab(name) {
  document.querySelectorAll('#settingsTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach((p) => {
    p.hidden = p.dataset.pane !== name;
  });
}

document.querySelectorAll('#settingsTabs .tab').forEach((t) => {
  t.addEventListener('click', () => showTab(t.dataset.tab));
});

function openSettings() {
  el.sBaseUrl.value = settings.baseUrl;
  el.sApiKey.value = settings.apiKey;
  el.sModel.value = settings.model;
  el.sTemp.value = settings.temperature;
  el.sSteps.value = settings.maxSteps;
  el.sMemory.checked = settings.memoryEnabled !== false;
  el.sFloating.checked = settings.floatingEnabled !== false;
  el.sCdp.checked = Boolean(settings.cdpEnabled);
  if (el.sEvolution) el.sEvolution.checked = settings.evolutionEnabled !== false;
  if (el.sEvolutionInject) el.sEvolutionInject.checked = settings.evolutionInject !== false;
  if (el.sFileOutput) el.sFileOutput.checked = Boolean(settings.fileOutputEnabled);
  if (el.sApplyToolbar) el.sApplyToolbar.checked = Boolean(themeDraft.applyToToolbar);
  buildIconGrid();
  syncIconGrid();
  syncBrandHint();
  const prices = settings.prices || DEFAULT_PRICES;
  el.sPriceIn.value = String(prices.input ?? '');
  el.sPriceOut.value = String(prices.output ?? '');
  el.sBudget.value = Number.isFinite(settings.budget) ? String(settings.budget) : '';

  themeDraft = { ...DEFAULT_SETTINGS.theme, ...(settings.theme || {}) };
  syncAppearanceUI();
  showTab('model');
  el.modal.hidden = false;
  el.sBaseUrl.focus();
}

// 外观控件：改动即时预览
el.sAccentCustom.addEventListener('input', () => {
  themeDraft.accent = el.sAccentCustom.value;
  el.sAccentHex.value = el.sAccentCustom.value;
  applyTheme(themeDraft);
  syncAppearanceUI();
});

el.sAccentHex.addEventListener('input', () => {
  const v = el.sAccentHex.value.trim();
  if (parseHex(v)) {
    themeDraft.accent = v.startsWith('#') ? v : `#${v}`;
    el.sAccentCustom.value = themeDraft.accent;
    applyTheme(themeDraft);
    syncAppearanceUI();
  }
});

for (const [container, key] of [
  [el.sMode, 'mode'],
  [el.sGlass, 'glass'],
  [el.sDensity, 'density'],
]) {
  container.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      themeDraft[key] = b.dataset.value;
      applyTheme(themeDraft);
      syncAppearanceUI();
    });
  });
}

el.sRadius.addEventListener('input', () => {
  themeDraft.radius = Number(el.sRadius.value);
  applyTheme(themeDraft);
  syncAppearanceUI();
});

el.sMotion.addEventListener('change', () => {
  themeDraft.motion = el.sMotion.checked;
  applyTheme(themeDraft);
});

el.settings.addEventListener('click', openSettings);

/* ---------- 自动获取模型列表 ---------- */

/**
 * 拉取账号可用模型，填进 datalist。
 * 需要 Base URL 与 Key 已填（用当前输入框的值，不必先保存）。
 */
async function fetchModelList() {
  const baseUrl = el.sBaseUrl.value.trim();
  const apiKey = el.sApiKey.value.trim();
  if (!apiKey) {
    el.modelListHint.textContent = '请先填写 API Key。';
    el.modelListHint.classList.add('warn');
    return;
  }

  el.btnFetchModels.disabled = true;
  el.btnFetchModels.textContent = '获取中…';
  el.modelListHint.classList.remove('warn');
  el.modelListHint.textContent = '正在读取模型列表…';

  try {
    // 临时把当前输入写进设置，这样后台能用到最新的 URL/Key
    await callBg(MSG.SET_SETTINGS, { settings: { baseUrl: baseUrl || settings.baseUrl, apiKey } });

    const res = await callBg(MSG.MODELS_GET, { force: true });
    if (res?.error) throw new Error(res.error);

    const models = res.models || [];
    el.modelList.textContent = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      el.modelList.appendChild(opt);
    }

    el.modelListHint.textContent = `读取到 ${models.length} 个模型，点输入框下拉选择。${
      res.cached ? '（缓存）' : ''
    }`;
    // 当前模型不在列表里时提示一下（多半是拼错了）
    const cur = el.sModel.value.trim();
    if (cur && !models.includes(cur)) {
      el.modelListHint.textContent += ` 注意：当前填的「${cur}」不在列表里。`;
      el.modelListHint.classList.add('warn');
    }
    // 没填模型就用第一个
    if (!cur && models.length) el.sModel.value = models[0];
  } catch (err) {
    el.modelListHint.textContent = `获取失败：${err.message}`;
    el.modelListHint.classList.add('warn');
  } finally {
    el.btnFetchModels.disabled = false;
    el.btnFetchModels.textContent = '获取列表';
  }
}

el.btnFetchModels.addEventListener('click', fetchModelList);

/* ---------- 真实输入模式（CDP）的权限申请 ---------- */

/**
 * debugger 是 optional_permissions，必须在用户手势里申请。
 * 勾选时立刻弹权限框，用户拒绝就把开关拨回去。
 */
el.sCdp.addEventListener('change', async () => {
  if (!el.sCdp.checked) return; // 关闭不需要权限
  try {
    const granted = await chrome.permissions.request({ permissions: ['debugger'] });
    if (!granted) {
      el.sCdp.checked = false;
      addMessage(
        'assistant',
        '没有获得调试权限，已保持默认模式。默认模式的点击对绝大多数网站够用，只是风控严格的站点可能不响应。',
      );
    }
  } catch (err) {
    el.sCdp.checked = false;
    addMessage('assistant', `申请权限失败：${err.message}`, { error: true });
  }
});

// 取消：把预览回滚成已保存的外观
el.sCancel.addEventListener('click', () => {
  themeDraft = { ...DEFAULT_SETTINGS.theme, ...(settings.theme || {}) };
  applyTheme(themeDraft);
  el.modal.hidden = true;
});
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) {
    themeDraft = { ...DEFAULT_SETTINGS.theme, ...(settings.theme || {}) };
    applyTheme(themeDraft);
    el.modal.hidden = true;
  }
});

// 恢复默认外观（只重置外观，不动模型配置）
el.sReset.addEventListener('click', () => {
  themeDraft = { ...DEFAULT_SETTINGS.theme };
  applyTheme(themeDraft);
  syncAppearanceUI();
});

el.sSave.addEventListener('click', async () => {
  settings = await callBg(MSG.SET_SETTINGS, {
    settings: {
      baseUrl: el.sBaseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
      apiKey: el.sApiKey.value.trim(),
      model: el.sModel.value.trim() || DEFAULT_SETTINGS.model,
      temperature: Math.max(0, Math.min(2, Number(el.sTemp.value) || 0.2)),
      maxSteps: Math.max(1, Math.min(30, Number(el.sSteps.value) || 12)),
      memoryEnabled: el.sMemory.checked,
      floatingEnabled: el.sFloating.checked,
      cdpEnabled: el.sCdp.checked,
      evolutionEnabled: el.sEvolution ? el.sEvolution.checked : true,
      evolutionInject: el.sEvolutionInject ? el.sEvolutionInject.checked : true,
      fileOutputEnabled: el.sFileOutput ? el.sFileOutput.checked : false,
      prices: {
        input: Math.max(0, Number(el.sPriceIn.value) || 0),
        output: Math.max(0, Number(el.sPriceOut.value) || 0),
      },
      budget: el.sBudget.value.trim() === '' ? null : Math.max(0, Number(el.sBudget.value) || 0),
      theme: { ...themeDraft },
    },
  });
  balanceCache = null; // 预算/单价变了，余额视图要重算
  themeDraft = { ...DEFAULT_SETTINGS.theme, ...(settings.theme || {}) };
  applyTheme(settings.theme);
  applyBrandIcon(settings.theme);
  if (themeDraft.applyToToolbar) await pushToolbarIcon(themeDraft);
  el.modal.hidden = true;
  updateModelHint();
  addMessage('assistant', '设置已保存。悬浮窗相关的改动需要刷新网页后生效。');
});

/* ---------------- 记忆库 ---------------- */

async function renderMemories() {
  let data;
  try {
    data = await callBg(MSG.MEM_LIST);
  } catch (err) {
    el.memList.textContent = `读取失败：${err.message}`;
    return;
  }

  const { stats } = data;
  el.memStats.textContent = `共 ${stats.total} 条 · 偏好 ${stats.byKind.preference || 0} / 事实 ${stats.byKind.fact || 0} / 站点 ${stats.byKind.site || 0}`;

  const items = (data.items || []).filter((m) => memFilter === 'all' || m.kind === memFilter);
  el.memList.textContent = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mem-empty';
    empty.textContent = memFilter === 'all'
      ? '还没有记忆。跟 AI 聊天时它会自动记住你的偏好，你也可以在上面手动添加。'
      : '这个分类下还没有内容。';
    el.memList.appendChild(empty);
    return;
  }

  for (const m of items) {
    const row = document.createElement('div');
    row.className = 'mem-item';

    const kind = document.createElement('span');
    kind.className = `kind ${m.kind}`;
    kind.textContent = MEMORY_KIND_LABEL[m.kind] || m.kind;

    const body = document.createElement('div');
    body.className = 'body';
    const text = document.createElement('span');
    text.textContent = m.text; // textContent：记忆内容可能来自网页，绝不拼 HTML
    const meta = document.createElement('span');
    meta.className = 'meta';
    const when = new Date(m.updatedAt || m.createdAt || Date.now());
    meta.textContent = [
      m.site ? `@${m.site}` : '',
      m.source === 'auto' ? '自动' : '手动',
      `${when.getMonth() + 1}月${when.getDate()}日`,
      m.hits ? `命中${m.hits}次` : '',
    ].filter(Boolean).join(' · ');
    body.append(text, meta);

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      try {
        await callBg(MSG.MEM_DELETE, { id: m.id });
        renderMemories();
      } catch (err) {
        addMessage('assistant', `删除失败：${err.message}`, { error: true });
      }
    });

    row.append(kind, body, del);
    el.memList.appendChild(row);
  }
}

el.memory.addEventListener('click', async () => {
  el.memModal.hidden = false;
  await renderMemories();
});

el.memClose.addEventListener('click', () => {
  el.memModal.hidden = true;
});
el.memModal.addEventListener('click', (e) => {
  if (e.target === el.memModal) el.memModal.hidden = true;
});

el.memAddBtn.addEventListener('click', async () => {
  const text = el.memText.value.trim();
  if (!text) return;
  try {
    await callBg(MSG.MEM_ADD, { item: { kind: el.memKind.value, text } });
    el.memText.value = '';
    await renderMemories();
  } catch (err) {
    addMessage('assistant', `添加失败：${err.message}`, { error: true });
  }
});

el.memText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    el.memAddBtn.click();
  }
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    memFilter = btn.dataset.kind;
    renderMemories();
  });
});

el.memClearAuto.addEventListener('click', async () => {
  try {
    // 只清自动提炼的，手动添加的保留
    const data = await callBg(MSG.MEM_LIST);
    const autos = (data.items || []).filter((m) => m.source === 'auto');
    for (const m of autos) await callBg(MSG.MEM_DELETE, { id: m.id });
    await renderMemories();
    addMessage('assistant', `已清除 ${autos.length} 条自动记忆。`);
  } catch (err) {
    addMessage('assistant', `清除失败：${err.message}`, { error: true });
  }
});

/* ---------------- 用量 ---------------- */

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 缓存最近一次余额查询结果，避免每次开弹窗都打接口。 */
let balanceCache = null;

function fmtMoney(v, symbol = '¥') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  // 金额小的保留更多小数位，否则显示不出来
  if (n !== 0 && Math.abs(n) < 0.01) return `${symbol}${n.toFixed(4)}`;
  return `${symbol}${n.toFixed(2)}`;
}

async function refreshBalance(force = false) {
  if (!force && balanceCache && Date.now() - balanceCache.at < 60000) return balanceCache.data;
  try {
    const res = await callBg(MSG.BALANCE_GET, { force });
    balanceCache = { at: Date.now(), data: res };
    return res;
  } catch (err) {
    balanceCache = { at: Date.now(), data: { supported: false, reason: err.message } };
    return balanceCache.data;
  }
}

async function renderUsage() {
  let data;
  try {
    data = await callBg(MSG.USAGE_GET);
  } catch (err) {
    el.usageHistory.textContent = `读取失败：${err.message}`;
    return;
  }

  const prices = settings.prices || DEFAULT_PRICES;
  const { session, totals, history: records } = data;

  // 花费：按单价把 token 折算成钱
  const sessionCost = costOf(session, prices);
  const totalCost = costOf(totals, prices);
  const today = todayCost(records, prices);

  el.uSession.textContent = fmtTokens(session.total);
  el.uSessionDetail.textContent = `${fmtMoney(sessionCost)} · 入${fmtTokens(session.prompt)}/出${fmtTokens(session.completion)}`;

  el.uTotal.textContent = fmtTokens(totals.total);
  el.uTotalDetail.textContent = `${fmtMoney(totalCost)} · ${totals.calls || 0} 次调用`;

  el.uToday.textContent = today.cost > 0 ? fmtMoney(today.cost) : '¥0.00';
  el.uTodayDetail.textContent = today.calls
    ? `${fmtTokens(today.tokens)} tokens · ${today.calls} 次`
    : '今天还没有消耗';

  // 余额：官方接口优先，否则用手动预算估
  const bal = await refreshBalance(false);
  const view = balanceView({
    official: bal?.balance || null,
    budget: Number.isFinite(settings.budget) ? settings.budget : null,
    spent: totalCost,
    today: today.cost,
  });

  el.uSource.textContent = view.label;
  if (view.source === 'official') {
    el.uBalance.textContent = `${view.symbol}${view.total.toFixed(2)}`;
    el.uBalanceDetail.textContent = view.detail || (view.available ? '账户可用' : '账户不可用');
  } else if (view.source === 'budget') {
    el.uBalance.textContent = `${view.symbol}${view.total.toFixed(2)}`;
    el.uBalanceDetail.textContent = view.detail;
  } else if (bal?.error) {
    el.uBalance.textContent = '—';
    el.uBalanceDetail.textContent = bal.error.slice(0, 40);
  } else {
    el.uBalance.textContent = '—';
    el.uBalanceDetail.textContent = view.detail;
  }

  // 单价输入框
  el.uPriceIn.value = String(prices.input ?? '');
  el.uPriceOut.value = String(prices.output ?? '');
  el.uPriceHint.textContent =
    `按 ¥${prices.input}/百万 输入、¥${prices.output}/百万 输出估算。` +
    '不同服务商价格差异很大，请按你实际用的模型填写。';

  // 历史列表
  el.usageHistory.textContent = '';
  if (!records?.length) {
    const empty = document.createElement('div');
    empty.className = 'mem-empty';
    empty.textContent = '还没有任务记录。';
    el.usageHistory.appendChild(empty);
    return;
  }

  for (const r of records.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'usage-row';

    const task = document.createElement('span');
    task.className = 'task';
    task.textContent = r.task || '(无标题)';
    task.title = r.task || '';

    const cost = document.createElement('span');
    cost.className = 'tk';
    cost.textContent = fmtMoney(costOf({ prompt: r.prompt, completion: r.completion }, prices));

    const tk = document.createElement('span');
    tk.className = 'tk';
    tk.textContent = r.tokens ? `${fmtTokens(r.tokens)} tok` : '—';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(r.at);

    row.append(task, cost, tk, time);
    el.usageHistory.appendChild(row);
  }
}

el.usage.addEventListener('click', async () => {
  el.usageModal.hidden = false;
  await renderUsage();
});

el.uClose.addEventListener('click', () => {
  el.usageModal.hidden = true;
});
el.usageModal.addEventListener('click', (e) => {
  if (e.target === el.usageModal) el.usageModal.hidden = true;
});

el.uRefresh.addEventListener('click', async () => {
  balanceCache = null;
  await renderUsage();
});

el.uPriceSave.addEventListener('click', async () => {
  const input = Math.max(0, Number(el.uPriceIn.value) || 0);
  const output = Math.max(0, Number(el.uPriceOut.value) || 0);
  settings = await callBg(MSG.SET_SETTINGS, { settings: { prices: { input, output } } });
  await renderUsage();
});

el.uResetSession.addEventListener('click', async () => {
  await callBg(MSG.USAGE_RESET, { scope: 'session' });
  await renderUsage();
});

el.uResetAll.addEventListener('click', async () => {
  await callBg(MSG.USAGE_RESET, { scope: 'all' });
  await renderUsage();
});

/* ---------------- 悬浮窗联动 ---------------- */

// 悬浮窗点了快捷指令 → 侧边栏来取任务
async function pollFloatTask() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'panel/float-pending' });
    if (res?.task?.prompt) {
      // 超过 30 秒的陈旧指令丢弃
      if (Date.now() - (res.task.at || 0) < 30000) {
        handleTask(res.task.prompt);
      }
    }
  } catch {
    /* 忽略 */
  }
}

// 悬浮窗点了停止
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'panel/float-stop') {
    // 直接复用 stopTask：它只是置取消标志 + 掐断在途请求 + 解除忙碌，
    // 不依赖任何显示状态，所以在任何情况下调用都是安全的。
    stopTask();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'panel/float-task') {
    if (msg.task?.prompt) handleTask(msg.task.prompt);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 侧边栏打开时主动取一次暂存指令
pollFloatTask();
// 侧边栏长期开着时，靠轮询接收悬浮窗新指令
setInterval(pollFloatTask, 1500);

/* ---------------- 初始化 ---------------- */

(async () => {
  try {
    settings = await callBg(MSG.GET_SETTINGS);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  // 主题先落地，避免首屏闪一下默认配色
  applyTheme(settings.theme);
  applyBrandIcon(settings.theme);
  buildSwatches();
  themeDraft = { ...DEFAULT_SETTINGS.theme, ...(settings.theme || {}) };
  syncAppearanceUI();
  updateModelHint();
  autoGrow();
  if (!settings.apiKey) {
    addMessage('assistant', '第一次使用：点右上角 ⚙ 填写 API Base URL、API Key 和模型名，然后就能让我操作网页了。');
  }
  el.input.focus();
})();


/* ============================================================
   品牌图标：内置图标库 + 上传图片
   ============================================================ */

/** 把当前品牌图标画到顶栏（以及可选的浏览器工具栏）。 */
function applyBrandIcon(theme) {
  const t = { ...DEFAULT_SETTINGS.theme, ...(theme || {}) };
  const host = el.brandIcon;
  if (!host) return;
  host.textContent = '';

  if (t.brandIcon === 'upload' && t.brandIconData) {
    const img = document.createElement('img');
    img.src = t.brandIconData;
    img.alt = 'Pumpkin Star';
    host.appendChild(img);
  } else {
    // 'default' 用南瓜星，其余是图标库 id
    const id = t.brandIcon && t.brandIcon !== 'default' ? t.brandIcon : 'pumpkin';
    host.appendChild(renderIcon(id, { size: 18 }));
  }
}

/** 把图标渲染成 ImageData（工具栏 setIcon 需要）。 */
function iconToImageData(source, size) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('无法创建画布'));

    const draw = (img) => {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      resolve({ width: size, height: size, data: Array.from(ctx.getImageData(0, 0, size, size).data) });
    };

    if (typeof source === 'string') {
      // 内置图标：先转成 SVG data URL，再进 Image
      const svg = iconSvgString(source, { size: 128, stroke: '#ffffff' });
      // 内置图标是描边风格，放在透明底上会看不清 —— 给个圆角底
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, size, size);
        // 画圆角蓝底
        const r = size * 0.22;
        ctx.fillStyle = '#3a72e8';
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.arcTo(size, 0, size, size, r);
        ctx.arcTo(size, size, 0, size, r);
        ctx.arcTo(0, size, 0, 0, r);
        ctx.arcTo(0, 0, size, 0, r);
        ctx.closePath();
        ctx.fill();
        ctx.drawImage(img, 0, 0, size, size);
        resolve({ width: size, height: size, data: Array.from(ctx.getImageData(0, 0, size, size).data) });
      };
      img.onerror = () => reject(new Error('图标渲染失败'));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      return;
    }

    // 上传的图片：data URL
    const img = new Image();
    img.onload = () => draw(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = source;
  });
}

/** 把图标同时应用到浏览器工具栏。 */
async function pushToolbarIcon(theme) {
  const t = { ...DEFAULT_SETTINGS.theme, ...(theme || {}) };
  if (!t.applyToToolbar) return { skipped: true };
  try {
    const useUpload = t.brandIcon === 'upload' && t.brandIconData;
    const src = useUpload ? t.brandIconData : t.brandIcon && t.brandIcon !== 'default' ? t.brandIcon : 'pumpkin';
    const [i16, i32] = await Promise.all([iconToImageData(src, 16), iconToImageData(src, 32)]);
    await callBg(MSG.ICON_APPLY, { images: { 16: i16, 32: i32 } });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/** 构建图标选择网格。 */
function buildIconGrid() {
  const grid = el.brandIconGrid;
  if (!grid) return;
  grid.textContent = '';

  // 每一项：默认闪电 + 图标库
  const items = [{ id: 'default', name: '默认（南瓜星）' }, ...ICON_LIBRARY];
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-cell';
    b.dataset.icon = item.id;
    b.title = item.name;
    b.appendChild(renderIcon(item.id === 'default' ? 'pumpkin' : item.id, { size: 16 }));
    b.addEventListener('click', () => {
      themeDraft.brandIcon = item.id === 'default' ? 'default' : item.id;
      applyBrandIcon(themeDraft);
      syncIconGrid();
      syncBrandHint();
    });
    grid.appendChild(b);
  }

  // 如果已上传过图片，额外加一个"已上传"项
  if (themeDraft.brandIconData) addUploadedCell();
}

/** 上传项单独加，避免每次重建都丢。 */
function addUploadedCell() {
  const grid = el.brandIconGrid;
  if (!grid || grid.querySelector('[data-icon="upload"]')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-cell';
  b.dataset.icon = 'upload';
  b.title = '我上传的图片';
  const img = document.createElement('img');
  img.src = themeDraft.brandIconData;
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'contain';
  img.style.borderRadius = '3px';
  b.appendChild(img);
  b.addEventListener('click', () => {
    themeDraft.brandIcon = 'upload';
    applyBrandIcon(themeDraft);
    syncIconGrid();
    syncBrandHint();
  });
  grid.insertBefore(b, grid.firstChild);
}

function syncIconGrid() {
  const grid = el.brandIconGrid;
  if (!grid) return;
  grid.querySelectorAll('.icon-cell').forEach((c) => {
    const v = c.dataset.icon;
    const active =
      v === 'upload' ? themeDraft.brandIcon === 'upload' : (themeDraft.brandIcon || 'default') === v;
    c.classList.toggle('active', active);
  });
}

function syncBrandHint() {
  if (!el.brandIconHint) return;
  if (themeDraft.brandIcon === 'upload' && themeDraft.brandIconData) {
    el.brandIconHint.textContent = '正在使用你上传的图片。';
  } else {
    el.brandIconHint.textContent = '选一个内置图标，或上传自己的图片（PNG/JPG/WebP/SVG）。';
  }
}

// 上传图片
el.brandIconFile?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 512 * 1024) {
    el.brandIconHint.textContent = '图片过大（上限 512KB），请先压缩。';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    themeDraft.brandIconData = String(reader.result || '');
    themeDraft.brandIcon = 'upload';
    addUploadedCell();
    applyBrandIcon(themeDraft);
    syncIconGrid();
    syncBrandHint();
  };
  reader.onerror = () => {
    el.brandIconHint.textContent = '图片读取失败。';
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // 允许重复选同一个文件
});

el.brandIconClear?.addEventListener('click', () => {
  themeDraft.brandIconData = '';
  if (themeDraft.brandIcon === 'upload') themeDraft.brandIcon = 'default';
  el.brandIconGrid?.querySelector('[data-icon="upload"]')?.remove();
  applyBrandIcon(themeDraft);
  syncIconGrid();
  syncBrandHint();
});

el.sApplyToolbar?.addEventListener('change', async () => {
  themeDraft.applyToToolbar = el.sApplyToolbar.checked;
  if (el.sApplyToolbar.checked) {
    const r = await pushToolbarIcon(themeDraft);
    if (r?.error) el.brandIconHint.textContent = `应用到工具栏失败：${r.error}`;
    else el.brandIconHint.textContent = '已应用到浏览器工具栏。';
  }
});

/* ============================================================
   自进化：技能与规则
   ============================================================ */

let evoPane = 'skills';

function showEvoPane(name) {
  evoPane = name;
  el.evoTabs?.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.evo === name);
  });
  document.querySelectorAll('.evo-pane').forEach((pane) => {
    pane.hidden = pane.dataset.evoPane !== name;
  });
}

el.evoTabs?.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => showEvoPane(t.dataset.evo));
});

/** 构造空态提示节点（用 DOM 而不是 innerHTML）。 */
function emptyHint(text) {
  const d = document.createElement('div');
  d.className = 'mem-empty';
  d.textContent = text;
  return d;
}

/** 渲染技能列表。 */
async function renderSkills() {
  let data;
  try {
    data = await callBg(MSG.SKILL_LIST);
  } catch (err) {
    el.skillList.textContent = `读取失败：${err.message}`;
    return;
  }
  const st = data.stats || {};
  el.evoStats.textContent = `技能 ${st.total || 0} · 规则 ${evoRuleTotal}`;

  const list = el.skillList;
  list.textContent = '';
  if (!data.items?.length) {
    list.appendChild(emptyHint('还没有技能。完成一个任务后它会自动总结，你也可以在上面手动添加。'));
    return;
  }

  for (const s of data.items) {
    const row = document.createElement('div');
    row.className = 'evo-item';

    const body = document.createElement('div');
    body.className = 'body';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = s.name;

    const trigger = document.createElement('span');
    trigger.className = 'trigger';
    trigger.textContent = `适用：${s.trigger}`;

    const steps = document.createElement('ol');
    steps.className = 'steps';
    for (const st2 of s.steps || []) {
      const li = document.createElement('li');
      li.textContent = st2;
      steps.appendChild(li);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [
      s.site ? `@${s.site}` : '',
      s.hits ? `用过 ${s.hits} 次` : '未用过',
      s.tools?.length ? `工具：${s.tools.join('、')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    body.append(title, trigger, steps, meta);

    const badge = document.createElement('span');
    badge.className = `badge ${s.source === 'auto' ? 'auto' : ''}`;
    badge.textContent = s.source === 'auto' ? '自动' : '手动';

    const ops = document.createElement('div');
    ops.className = 'ops';
    const del = document.createElement('button');
    del.type = 'button';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      try {
        await callBg(MSG.SKILL_DELETE, { id: s.id });
        await renderSkills();
      } catch (err) {
        addMessage('assistant', `删除失败：${err.message}`, { error: true });
      }
    });
    ops.appendChild(del);

    row.append(body, badge, ops);
    list.appendChild(row);
  }
}

let evoRuleTotal = 0;

/** 渲染规则列表。 */
async function renderRules() {
  let data;
  try {
    data = await callBg(MSG.RULE_LIST);
  } catch (err) {
    el.ruleList.textContent = `读取失败：${err.message}`;
    return;
  }
  const st = data.stats || {};
  evoRuleTotal = st.total || 0;
  el.evoStats.textContent = `技能 ${evoSkillTotal} · 规则 ${evoRuleTotal}`;

  const list = el.ruleList;
  list.textContent = '';
  if (!data.items?.length) {
    list.appendChild(emptyHint('还没有自我规则。Agent 会从执行过程里总结该注意什么。'));
    return;
  }

  const KIND = { efficiency: '效率', reliability: '可靠性', preference: '偏好' };
  for (const r of data.items) {
    const row = document.createElement('div');
    row.className = 'evo-item';

    const body = document.createElement('div');
    body.className = 'body';
    const text = document.createElement('div');
    text.className = 'title';
    text.textContent = r.text;
    text.style.fontWeight = '400';
    text.style.fontSize = 'var(--fs-sm)';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [
      KIND[r.kind] || r.kind,
      `出现 ${r.occurrences || 1} 次`,
      `置信度 ${Math.round((r.confidence || 0) * 100)}%`,
      r.source === 'auto' ? '自动' : '手动',
    ].join(' · ');
    body.append(text, meta);

    const badge = document.createElement('span');
    badge.className = `badge ${r.enabled === false ? 'off' : ''}`;
    badge.textContent = r.enabled === false ? '已停用' : '生效中';

    const ops = document.createElement('div');
    ops.className = 'ops';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'toggle';
    toggle.title = r.enabled === false ? '启用' : '停用';
    toggle.textContent = r.enabled === false ? '○' : '●';
    toggle.addEventListener('click', async () => {
      await callBg(MSG.RULE_UPDATE, { id: r.id, patch: { enabled: r.enabled === false } });
      await renderRules();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await callBg(MSG.RULE_DELETE, { id: r.id });
      await renderRules();
    });
    ops.append(toggle, del);

    row.append(body, badge, ops);
    list.appendChild(row);
  }
}

let evoSkillTotal = 0;

// 打开进化面板
el.btnEvolve?.addEventListener('click', async () => {
  el.evolveModal.hidden = false;
  showEvoPane('skills');
  try {
    const d = await callBg(MSG.SKILL_LIST);
    evoSkillTotal = d.stats?.total || 0;
  } catch { /* 忽略 */ }
  await Promise.all([renderSkills(), renderRules()]);
});

el.evoClose?.addEventListener('click', () => {
  el.evolveModal.hidden = true;
});
el.evolveModal?.addEventListener('click', (e) => {
  if (e.target === el.evolveModal) el.evolveModal.hidden = true;
});

// 手动添加技能
el.skillAddBtn?.addEventListener('click', async () => {
  const name = el.skillName.value.trim();
  const trigger = el.skillTrigger.value.trim();
  const steps = el.skillSteps.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!name || !trigger || !steps.length) {
    addMessage('assistant', '添加技能需要：名称、适用条件、至少一步。', { error: true });
    return;
  }
  try {
    await callBg(MSG.SKILL_ADD, { skill: { name, trigger, steps, source: 'manual' } });
    el.skillName.value = '';
    el.skillTrigger.value = '';
    el.skillSteps.value = '';
    evoSkillTotal += 1;
    await renderSkills();
  } catch (err) {
    addMessage('assistant', `添加失败：${err.message}`, { error: true });
  }
});

// 手动添加规则
el.ruleAddBtn?.addEventListener('click', async () => {
  const text = el.ruleText.value.trim();
  if (!text) return;
  try {
    await callBg(MSG.RULE_ADD, { rule: { text, kind: el.ruleKind.value, source: 'manual' } });
    el.ruleText.value = '';
    evoRuleTotal += 1;
    await renderRules();
  } catch (err) {
    addMessage('assistant', `添加失败：${err.message}`, { error: true });
  }
});

el.ruleText?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    el.ruleAddBtn.click();
  }
});

// 清除自动积累的
el.evoClearAuto?.addEventListener('click', async () => {
  try {
    await callBg(MSG.SKILL_CLEAR, { onlyAuto: true });
    await callBg(MSG.RULE_CLEAR, { onlyAuto: true });
    await Promise.all([renderSkills(), renderRules()]);
    addMessage('assistant', '已清除自动积累的技能与规则（手动添加的保留）。');
  } catch (err) {
    addMessage('assistant', `清除失败：${err.message}`, { error: true });
  }
});

/* ============================================================
   文件输出
   ============================================================ */

let outputDir = null;

/** 刷新目录状态显示。 */
async function refreshFileDir() {
  try {
    outputDir = await getOutputDir();
  } catch {
    outputDir = null;
  }
  const box = el.fileDirBox;
  if (!box) return;
  if (outputDir) {
    box.classList.add('ok');
    el.fileDirName.textContent = outputDir.name;
    el.fileDirHint.textContent = '已授权，可以写入文件了';
  } else {
    box.classList.remove('ok');
    el.fileDirName.textContent = '未选择目录';
    el.fileDirHint.textContent = '选一个本地文件夹，之后写入的文件都会放在那里';
  }
}

// 选择目录
el.fileChooseDir?.addEventListener('click', async () => {
  try {
    const r = await chooseOutputDir();
    await refreshFileDir();
    el.fileHint.textContent = `已选择文件夹「${r.name}」。`;
  } catch (err) {
    el.fileHint.textContent = `选择失败：${err.message}`;
  }
});

// 忘记目录
el.fileForget?.addEventListener('click', async () => {
  await forgetOutputDir();
  await refreshFileDir();
  el.fileHint.textContent = '已忘记之前选择的目录。';
});

// 写入文件夹
el.fileSave?.addEventListener('click', async () => {
  const raw = el.fileName.value.trim() || 'output.md';
  const name = sanitizeFilename(raw);
  try {
    const content = serialize(el.fileContent.value, extOf(name));
    const r = await writeToOutputDir(name, content);
    el.fileHint.textContent = `已写入 ${r.dir}/${r.name}（${r.chars} 字符）`;
    addMessage('assistant', `已保存文件：**${r.name}**（${r.chars} 字符）`);
  } catch (err) {
    el.fileHint.textContent = `写入失败：${err.message}`;
  }
});

// 直接下载
el.fileDownload?.addEventListener('click', () => {
  try {
    const name = sanitizeFilename(el.fileName.value.trim() || 'output.md');
    const content = validateContent(serialize(el.fileContent.value, extOf(name)));
    downloadText(name, content);
    el.fileHint.textContent = `已开始下载 ${name}`;
  } catch (err) {
    el.fileHint.textContent = `下载失败：${err.message}`;
  }
});

/** 用 Blob + a[download] 触发下载（不需要额外权限）。 */
function downloadText(filename, content) {
  const name = sanitizeFilename(filename);
  const blob = new Blob([content], { type: mimeOf(name) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 稍后释放，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 打开文件弹窗（预填内容）。 */
function openFileModal({ filename = 'output.md', content = '' } = {}) {
  el.fileModal.hidden = false;
  el.fileName.value = filename;
  el.fileContent.value = content;
  el.fileFormat.value = extOf(filename) === 'txt' ? 'txt' : extOf(filename);
  el.fileHint.textContent = '';
  refreshFileDir();
}

el.fileModal?.addEventListener('click', (e) => {
  if (e.target === el.fileModal) el.fileModal.hidden = true;
});

// 格式切换时同步文件扩展名
el.fileFormat?.addEventListener('change', () => {
  const fmt = el.fileFormat.value;
  const base = (el.fileName.value.trim() || 'output').replace(/\.[a-z0-9]+$/i, '');
  el.fileName.value = `${base}.${fmt}`;
});
