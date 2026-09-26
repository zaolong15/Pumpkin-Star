/**
 * 消息协议常量 —— background / content / panel 三方共用。
 * 保持纯常量，方便被 content script（非 module）复用同一份约定。
 */

export const MSG = {
  // panel -> background
  RUN_STEP: 'agent/run-step',
  ABORT: 'agent/abort',
  GET_PAGE: 'agent/get-page',
  GET_PAGE_TEXT: 'agent/get-page-text',
  GET_OUTLINE: 'agent/get-outline',
  EXEC_ACTION: 'agent/exec-action',
  GET_SETTINGS: 'settings/get',
  SET_SETTINGS: 'settings/set',

  // 模型列表
  MODELS_GET: 'models/get',

  // panel -> background（页面改造）
  PAGE_PATCH: 'page/patch',
  PAGE_RESET: 'page/reset',

  // 记忆库
  MEM_LIST: 'memory/list',
  MEM_ADD: 'memory/add',
  MEM_UPDATE: 'memory/update',
  MEM_DELETE: 'memory/delete',
  MEM_CLEAR: 'memory/clear',
  MEM_DISTILL: 'memory/distill',

  // 用量统计
  USAGE_GET: 'usage/get',
  USAGE_ADD: 'usage/add',
  USAGE_RESET: 'usage/reset',

  // 余额
  BALANCE_GET: 'balance/get',

  // 技能库（自进化）
  SKILL_LIST: 'skill/list',
  SKILL_ADD: 'skill/add',
  SKILL_UPDATE: 'skill/update',
  SKILL_DELETE: 'skill/delete',
  SKILL_CLEAR: 'skill/clear',
  SKILL_DISTILL: 'skill/distill',

  // 规则库（自进化）
  RULE_LIST: 'rule/list',
  RULE_ADD: 'rule/add',
  RULE_UPDATE: 'rule/update',
  RULE_DELETE: 'rule/delete',
  RULE_CLEAR: 'rule/clear',
  RULE_DISTILL: 'rule/distill',


  // 自定义图标
  ICON_APPLY: 'icon/apply',
  ICON_RESET: 'icon/reset',

  // background -> content
  CS_PING: 'cs/ping',
  CS_SNAPSHOT: 'cs/snapshot',
  CS_OUTLINE: 'cs/outline',
  CS_READ: 'cs/read',
  CS_ACT: 'cs/act',
  CS_HIGHLIGHT: 'cs/highlight',
  CS_PATCH: 'cs/patch',
  CS_PATCH_RESET: 'cs/patch-reset',
  CS_FLOAT: 'cs/float',
  CS_FLOAT_THEME: 'cs/float-theme',
};

/** 智能体可调用的动作白名单（content script 中实现）。 */
export const ACTIONS = [
  'click',
  'click_at',
  'hover',
  'move_mouse',
  'type',
  'select',
  'scroll',
  'navigate',
  'back',
  'wait',
  'extract',
  'highlight',
  // 页面改造（临时，刷新即失效）
  'set_text',
  'hide',
  'show',
  'set_style',
  'add_style',
  'remove',
  'inject_js',
  // 剪贴板
  'copy',
  'paste',
];

/** 页面改造类动作：统一记录，便于一键撤销。 */
export const PATCH_ACTIONS = ['set_text', 'hide', 'show', 'set_style', 'add_style', 'remove', 'inject_js'];

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxSteps: 12,
  language: 'zh',
  /** 是否启用本地记忆库 */
  memoryEnabled: true,
  /** 页面悬浮窗 */
  floatingEnabled: false,
  /**
   * 真实输入模式：用 chrome.debugger + CDP 派发输入事件。
   * 产生的事件 isTrusted=true，能过部分风控；代价是需要 debugger 权限，
   * 且页面顶部会出现调试横幅。默认关闭。
   */
  cdpEnabled: false,
  /** 计费单价（元 / 百万 token），用于估算花费 */
  prices: { input: 2, output: 8 },
  /** 手动预算（元）。没有余额接口的服务商靠它估算剩余；null 表示不启用 */
  budget: null,
  /** 外观个性化 */
  theme: {
    /** 主题色：'neutral'（中性灰，DSH 风格）或 #rrggbb */
    accent: 'neutral',
    /** 深浅模式：system | light | dark */
    mode: 'system',
    /** 玻璃效果：tint（半透明）| off（不透明） */
    glass: 'tint',
    /** 圆角：0..1，映射到 4..18px */
    radius: 0.55,
    /** 界面密度：compact | normal | relaxed */
    density: 'normal',
    /** 动效开关 */
    motion: true,
    /** 品牌图标：内置图标 id、'upload'（用上传的图片）、'default'（默认南瓜星） */
    brandIcon: 'default',
    /** 上传的图标（data URL）；仅当 brandIcon === 'upload' 时生效 */
    brandIconData: '',
    /** 是否把品牌图标同时应用到浏览器工具栏 */
    applyToToolbar: false,
  },

  /** 自进化：从执行中积累技能与规则 */
  evolutionEnabled: true,
  /** 是否把学到的技能/规则注入上下文 */
  evolutionInject: true,

  /** 文件输出：是否启用"写入本地文件夹"（需用户单独授权目录） */
  fileOutputEnabled: false,
};

/**
 * 主题色预置色板。
 * 第一项是中性灰（null 表示不指定颜色，由深浅模式决定主色），
 * 与 DeepSeek Harness 的克制配色一致；其余是可选的点缀色。
 */
export const ACCENT_PRESETS = [
  { name: '中性', value: 'neutral' },
  { name: '海蓝', value: '#4f8cff' },
  { name: '靛青', value: '#6366f1' },
  { name: '紫罗兰', value: '#a855f7' },
  { name: '玫红', value: '#ec4899' },
  { name: '赤橙', value: '#f97316' },
  { name: '翠绿', value: '#10b981' },
  { name: '石墨', value: '#64748b' },
];

/**
 * 玻璃效果档位。
 * 已移除 backdrop-filter 真模糊档：它会实时模糊背后网页，
 * 大面积使用的性能开销不值得，视觉上也容易喧宾夺主。
 */
export const GLASS_MODES = [
  { value: 'tint', label: '半透明', hint: '背景轻微透出，几乎零开销（默认）' },
  { value: 'off', label: '不透明', hint: '完全不透明，最快最清晰' },
];

/** 记忆条目类型。 */
export const MEMORY_KINDS = {
  PREFERENCE: 'preference', // 用户偏好
  FACT: 'fact', // 关于用户/环境的事实
  SITE: 'site', // 某个网站的操作经验
};

export const MEMORY_KIND_LABEL = {
  preference: '偏好',
  fact: '事实',
  site: '站点经验',
};

/** 技能库容量上限。 */
export const SKILL_LIMIT = 120;
/** 每次注入上下文的技能条数上限。 */
export const SKILL_INJECT_LIMIT = 3;

/** 规则库容量上限。 */
export const RULE_LIMIT = 120;
/** 每次注入上下文的规则条数上限。 */
export const RULE_INJECT_LIMIT = 10;

/** 记忆库容量上限，避免无限增长拖慢上下文。 */
export const MEMORY_LIMIT = 200;
/** 每次注入上下文的记忆条数上限。 */
export const MEMORY_INJECT_LIMIT = 12;
