/**
 * agent.js —— 智能体核心循环（面板页里跑）。
 *
 * 一轮 = 把「任务 + 页面状态」发给模型 → 模型返回工具调用 → 本地执行 → 结果回灌。
 * 循环直到模型不再调用工具（给出最终回答）或达到步数上限。
 */

import { MSG, ACTIONS, DEFAULT_SETTINGS } from '../shared/messages.js';

/** 工具定义：模型能做的所有事。 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description:
        '获取当前网页状态：页面标题、可交互元素编号列表（按钮/链接/输入框）、视口尺寸。**只在需要点击或输入时才调用**——纯阅读类任务（总结、翻译）请直接用 read_page，不要先 snapshot。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'outline',
      description:
        '查看页面结构骨架：列出各个区块（页头/导航/正文/侧栏/广告位/评论区…）的编号、标签、class、面积占比与位置。**改造页面之前必须先调用它** —— 只有这样你才知道广告容器、正文主体的真实编号和 class，而不是靠猜 CSS 选择器。纯阅读任务不需要它。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description:
        '读取当前页面正文纯文本。翻译、总结、提炼要点、回答问题都用它，不需要先 snapshot。同一次任务里读一次就够。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description:
        '点击某个元素（按钮、链接、复选框等）。会模拟真实鼠标：先移动过去触发 hover，再按下抬起。id 来自最近一次 snapshot。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '元素 id，例如 "e12"' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_at',
      description:
        '按视口坐标点击。当目标没有可识别的元素编号（canvas、自定义控件、被遮挡的按钮）时用它。坐标来自 snapshot 里元素的 box 字段，或 viewport 推断。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '视口 x 坐标（像素，从左边算）' },
          y: { type: 'number', description: '视口 y 坐标（像素，从上边算）' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description:
        '把鼠标悬停在某个元素上但不点击。用于展开下拉菜单、显示悬浮提示、触发 hover 才出现的内容。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '元素 id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_mouse',
      description: '把鼠标指针移动到指定坐标，不点击。用于"指"给用户看某个位置。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '视口 x 坐标' },
          y: { type: 'number', description: '视口 y 坐标' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: '在输入框/文本域中输入文字。设置 enter=true 回车提交（相当于搜索或发送）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '输入框元素 id' },
          value: { type: 'string', description: '要输入的文字' },
          enter: { type: 'boolean', description: '输入后是否按回车，默认 false' },
        },
        required: ['id', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: '在下拉框（select）中选择一个选项。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { type: 'string', description: '选项文本或 value' },
        },
        required: ['id', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: '滚动页面。amount 可以是像素数，也可以是 "top" / "bottom"。',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [{ type: 'string' }, { type: 'number' }],
            description: '像素（正数向下）、"top" 或 "bottom"',
          },
        },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: '跳转到指定网址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整 URL，含 https://' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_back',
      description: '返回上一页。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlight',
      description: '把某个元素高亮出来给用户看，不产生点击。用于指认"就是这里"。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: '等待一段时间，用于等页面加载或异步内容出现。',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'number', description: '毫秒，最大 10000' } },
        required: ['ms'],
      },
    },
  },

  /* ---------- 页面改造（临时，刷新即失效） ---------- */
  {
    type: 'function',
    function: {
      name: 'set_text',
      description:
        '把某个元素的文字替换成新内容。用于改写页面文案、去广告标题、整理想法。刷新页面后自动还原。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '元素 id' },
          value: { type: 'string', description: '新的文字内容' },
        },
        required: ['id', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hide',
      description:
        '隐藏某个元素（display:none）。用于去广告、去弹窗、隐藏侧边栏、隐藏不想看的内容。刷新后还原。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '元素 id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show',
      description: '显示一个被隐藏的元素。用于展开被折叠的内容、关闭遮罩后显示页面。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '元素 id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_style',
      description:
        '修改某个元素的内联样式，如字号、颜色、宽度。用于把页面调成护眼配色、放大字体、加宽正文。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '元素 id' },
          styles: {
            type: 'object',
            description: 'CSS 属性对象，如 {"font-size":"18px","line-height":"1.9"}',
          },
        },
        required: ['id', 'styles'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_style',
      description:
        '注入一段全局 CSS，作用于整个页面。适合批量改造：隐藏所有广告（.ad{display:none}）、统一正文字体、换配色。刷新后失效。',
      parameters: {
        type: 'object',
        properties: {
          css: { type: 'string', description: '完整 CSS 文本，可含多条规则' },
        },
        required: ['css'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_element',
      description: '把某个元素从页面上删掉。用于彻底清除顽固弹窗或广告位。刷新后还原。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '元素 id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inject_js',
      description:
        '执行一段 JavaScript 来改造页面，适合复杂操作：批量处理多个元素、解锁被禁用的按钮、自动展开全部内容。可用的有 document、window。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JS 代码，在页面上下文中以严格模式执行' },
        },
        required: ['code'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'copy_to_clipboard',
      description:
        '把文本写入系统剪贴板。用户说「复制给我」「放到剪贴板」时用它。注意这不会改变页面，只是把内容放到用户能粘贴的地方。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要复制的文本' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_clipboard',
      description:
        '读取系统剪贴板里的文本。用户说「总结我复制的内容」「看看剪贴板」时用它。浏览器首次会弹权限提示，用户拒绝则失败。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_file',
      description:
        '把结果保存成文件。适用于用户要求"导出/保存/下载/生成文件"，或你产出了适合留存的表格、清单、报告。用户可在弹窗里选择写入本地文件夹或直接下载。正文也可以直接放在 summary 里由界面导出，所以只在用户明确要文件时调用。',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: '文件名，含扩展名。支持 md / txt / json / csv',
          },
          content: { type: 'string', description: '文件内容' },
          format: {
            type: 'string',
            enum: ['md', 'txt', 'json', 'csv'],
            description: '内容格式，默认按文件扩展名推断',
          },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '把值得长期记住的信息存进本地记忆库。当用户表达偏好、说明自己的情况，或你发现了某个网站的操作诀窍时调用。不要记密码等敏感信息。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['preference', 'fact', 'site'],
            description: 'preference=用户偏好，fact=关于用户/环境的事实，site=本站操作经验',
          },
          text: { type: 'string', description: '一句话，具体、可执行、不含敏感信息' },
        },
        required: ['kind', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        '任务完成或无法继续时调用，向用户给出最终答复。这是唯一的结束方式，必须调用。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '给用户的最终答复（Markdown）' },
        },
        required: ['summary'],
      },
    },
  },
];


/* ============================================================
   工具分组：减少无关工具调用
   ------------------------------------------------------------
   实测结论：模型往返是主要耗时（每次 4 秒起），而每次往返它都要
   在一堆工具里选择。24 个工具全塞给它有两个代价：
     1. 提示词里的工具定义占大量 token，增加首字延迟
     2. 选择空间大，更容易选错或做多余动作（比如"总结页面"却先 snapshot）
   所以先判断任务属于哪种，只给它需要的工具子集。
   ============================================================ */

/** 工具名分组。 */
const TOOL_GROUPS = {
  // 只读：总结、翻译、提问、提取 —— 不需要任何改动类工具
  read: ['read_page', 'snapshot', 'outline', 'scroll', 'highlight', 'copy_to_clipboard', 'export_file', 'finish'],

  // 操作：点击、填表、跨页导航
  act: [
    'snapshot', 'read_page', 'outline', 'click', 'click_at', 'hover', 'move_mouse',
    'type_text', 'select_option', 'scroll', 'navigate', 'go_back', 'wait',
    'highlight', 'copy_to_clipboard', 'read_clipboard', 'export_file', 'finish',
  ],

  // 改造：改文字、隐藏、注入样式
  patch: [
    'outline', 'snapshot', 'read_page', 'hide', 'show', 'set_text', 'set_style',
    'add_style', 'remove_element', 'inject_js', 'highlight', 'scroll',
    'export_file', 'finish',
  ],

  // 剪贴板/文件等杂项
  misc: ['read_clipboard', 'copy_to_clipboard', 'export_file', 'read_page', 'finish'],
};

/**
 * 根据任务描述挑选工具子集。
 * 判断不出来时给 act 组（覆盖面最广），保证不会因为分类失误导致做不了事。
 */
function pickTools(task) {
  const t = String(task || '').toLowerCase();

  // 改造意图
  const patchy = /改|美化|净化|隐藏|去掉|删除|屏蔽|去广告|深色|暗色|护眼|放大|字号|样式|css|净化|清理|布局|主题|改造|变色|高亮显示|折叠|展开全部/;
  // 只读意图
  const ready = /总结|摘要|概括|翻译|译成|讲了什么|什么意思|是什么|提取|列出|要点|解释|说明一下|reading|summar/;
  // 剪贴板意图
  const clipy = /剪贴板|复制|粘贴|clipboard/;
  // 明确的文件产出意图
  const filey = /导出|保存为|下载|生成文件|存成|写成文件/;

  if (clipy.test(t)) return TOOL_GROUPS.misc;
  if (filey.test(t) && !/页面|网页/.test(t)) return TOOL_GROUPS.misc;

  const hasPatch = patchy.test(t);
  const hasRead = ready.test(t);

  // 两者都有（如"总结这个页面并改成深色"）：给 act 组，它同时包含读与操作；
  // 改造类工具会通过后续的追加逻辑补上
  if (hasPatch && hasRead) return TOOL_GROUPS.act;
  if (hasPatch) return TOOL_GROUPS.patch;
  if (hasRead) return TOOL_GROUPS.read;

  // 判断不出来：给覆盖面最广的
  return TOOL_GROUPS.act;
}

/** 按名字取出完整工具定义。 */
function toolsFor(names) {
  const set = new Set(names);
  const picked = TOOLS.filter((t) => set.has(t.function.name));
  // 兜底：如果过滤后不足 5 个（说明分组名写错了），返回全部
  return picked.length >= 5 ? picked : TOOLS;
}

const SYSTEM_PROMPT = (lang, maxSteps) => `你是一个在浏览器侧边栏里运行的网页智能体。你能"看见"当前标签页并直接操作它。

你可以做：回答问题、总结页面、翻译成${lang === 'zh' ? '中文' : lang}、查找信息、填写表单、点击按钮、滚动浏览、跨页面完成多步任务，以及直接改造当前页面的外观与内容。

## 工作方式
- 需要操作元素时，先调用 snapshot 拿到元素编号，再用编号调用动作。**元素编号只在当次 snapshot 后有效**，页面跳转或内容变化后必须重新 snapshot。
- 一次只做必要的动作。已经足够回答用户时，立刻调用 finish。
- 每次动作后系统会返回执行结果，请根据结果判断成功与否；失败就换一种方式，不要重复同样的失败动作。
- 最多 ${maxSteps} 步。如果反复失败，就用 finish 说明卡在哪一步、你观察到了什么。

## 省步骤（重要）
每一步都要花时间和 token，请用最少的步数完成任务：
- **只读任务不要 snapshot。** 总结、翻译、提问、提取内容 —— 直接 read_page 就够。
  snapshot 只在需要**点击或输入**时才有必要。
- **能一次做完就别分两次。** 一轮里可以同时返回多个工具调用，
  比如「隐藏 A、隐藏 B、注入一段 CSS」应当一起发，而不是一步一个。
- **不要重复读取。** 同一页面的 read_page 调一次就够；不要为了"确认"再读一遍。
- **别做用户没要求的事。** 不要顺手高亮、不要额外滚动、不要"先看看页面结构"。
- **早点收尾。** 信息够了立刻 finish，不要为了周全再多走一步。
- **明显做不到就直说。** 如果目标在 iframe 里、或需要登录/验证码，直接 finish 说明原因，
  不要反复尝试到耗尽步数。

## 鼠标操作
你控制的是一个会显示在页面上的鼠标指针，用户能看见它移动和点击。
- 优先用 click（按元素编号），它最稳。
- 当目标没有编号时（canvas、自定义控件、被遮挡的元素），用 click_at 按视口坐标点。
  snapshot 会给每个元素返回 center=(x,y)，直接拿来用即可；viewport 字段告诉你坐标范围。
- 要展开 hover 才出现的菜单，用 hover 而不是 click。
- 想"指"给用户看而不触发动作，用 move_mouse。
- 坐标都是**视口坐标**（相对当前可见区域左上角），不是文档坐标。
  如果目标不在当前视口内，先 scroll 再 snapshot，然后用新坐标。

## 页面改造（用户要求"改页面/去广告/净化/换样式"时）
- 改造是**临时的**，刷新页面即还原，所以可以大胆尝试。
- **第一步必须调用 outline。** 它会告诉你页面上每个区块的真实编号与 class。
  不要凭想象写 CSS 选择器 —— 那正是改造失败的常见原因。
- 拿到编号后：
  - 针对单个区块：用 hide / set_text / set_style / remove_element（按编号）
  - 批量统一处理：用 add_style 注入 CSS，**选择器要用 outline 里看到的真实 class**
- 删除元素时优先用 hide 而不是 remove_element——后者更难恢复。
- 改完用 highlight 指出你动了哪里，让用户看得见效果。
- 如果 outline 里找不到目标（比如广告在 iframe 里），如实说明，不要硬猜。

## 翻译规则（用户要求翻译时）
- 用 read_page 读取正文，然后**直接输出译文**，不要调用 finish 之外的额外工具。
- 保留原文的段落结构与列表格式。专有名词、代码、URL 保持原样。
- 不要逐句中英对照，除非用户明确要求。

## 记忆
- 用户表达稳定偏好（"以后都…"）、说明自己的情况，或你发现了某网站的操作诀窍时，调用 remember 存下来。
- 不要记密码、身份证、银行卡等敏感信息，也不要记一次性的临时信息。

## 安全底线
- 不要点击"删除""支付""下单""发送给所有人""确认退订"这类会造成不可逆后果的按钮，除非用户在本次任务中明确要求。
- 不要输入密码，不要绕过登录、验证码或任何访问控制。
- 涉及提交表单、发送消息等对外动作前，如果动作不可撤销，先用 finish 向用户确认。

## 输出
- 用中文回复（除非用户使用其他语言）。
- 简洁。不要复述工具调用过程，直接给结论。
- 最终答复通过 finish 工具提交。`;

/** 把模型返回的工具调用转换成 content script 能执行的动作。 */
function toAction(name, args) {
  switch (name) {
    case 'click':
      return { type: 'click', id: args.id };
    case 'click_at':
      return { type: 'click_at', x: args.x, y: args.y };
    case 'hover':
      return { type: 'hover', id: args.id };
    case 'move_mouse':
      return { type: 'move_mouse', x: args.x, y: args.y };
    case 'type_text':
      return { type: 'type', id: args.id, value: args.value, enter: Boolean(args.enter) };
    case 'select_option':
      return { type: 'select', id: args.id, value: args.value };
    case 'scroll':
      return { type: 'scroll', amount: args.amount };
    case 'navigate':
      return { type: 'navigate', url: args.url };
    case 'go_back':
      return { type: 'back' };
    case 'highlight':
      return { type: 'highlight', id: args.id };
    case 'wait':
      return { type: 'wait', ms: args.ms };
    // 页面改造
    case 'set_text':
      return { type: 'set_text', id: args.id, value: args.value };
    case 'hide':
      return { type: 'hide', id: args.id };
    case 'show':
      return { type: 'show', id: args.id };
    case 'set_style':
      return { type: 'set_style', id: args.id, styles: args.styles };
    case 'add_style':
      return { type: 'add_style', css: args.css };
    case 'remove_element':
      return { type: 'remove', id: args.id };
    case 'inject_js':
      return { type: 'inject_js', code: args.code };
    case 'copy_to_clipboard':
      return { type: 'copy', value: args.text };
    case 'read_clipboard':
      return { type: 'paste' };
    default:
      return null;
  }
}

const safeParse = (raw) => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

/** 压缩页面状态，避免一次塞给模型太多 token。 */
function compactSnapshot(snap) {
  return {
    url: snap.url,
    title: snap.title,
    scroll: snap.scroll,
    // 视口尺寸：click_at / move_mouse 的坐标都按视口算，得让模型知道范围
    viewport: snap.viewport,
    truncated: snap.truncated ? '元素过多，仅列出前 150 个' : undefined,
    elements: snap.elements.map((e) => {
      const parts = [`[${e.id}]`, `<${e.tag}>`];
      if (e.text) parts.push(`"${e.text}"`);
      if (e.name) parts.push(`name="${e.name}"`);
      if (e.type) parts.push(`type=${e.type}`);
      if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`);
      if (e.value) parts.push(`value="${e.value}"`);
      if (e.href) parts.push(`href=${e.href}`);
      if (e.checked !== undefined) parts.push(`checked=${e.checked}`);
      if (e.disabled) parts.push('disabled');
      // 中心点坐标，供 click_at 直接使用（元素编号失效时的兜底）
      if (Array.isArray(e.box)) {
        const [x, y, w, h] = e.box;
        parts.push(`center=(${Math.round(x + w / 2)},${Math.round(y + h / 2)})`);
      }
      return parts.join(' ');
    }),
  };
}

/**
 * 把结构快照压成紧凑文本。
 * 每行形如：[e12] <div> .ad-banner 面积18% 首屏 "限时优惠"
 */
function compactOutline(data) {
  return {
    url: data.url,
    title: data.title,
    viewport: data.viewport,
    bodyClass: data.bodyClass,
    truncated: data.truncated ? '区块过多，仅列出前 120 个' : undefined,
    blocks: (data.blocks || []).map((b) => {
      const parts = [`[${b.id}]`, `<${b.tag}>`];
      if (b.cls) parts.push(`class="${b.cls}"`);
      if (b.role) parts.push(`role=${b.role}`);
      parts.push(`面积${b.areaPct}%`);
      if (b.inView) parts.push('首屏');
      if (b.text) parts.push(`"${b.text}"`);
      return parts.join(' ');
    }),
  };
}

/**
 * 运行智能体。
 * @param {object} opts
 * @param {string} opts.task 用户的任务
 * @param {Array} opts.history 之前的对话（[{role, content}]）
 * @param {object} opts.settings
 * @param {(evt: object) => void} opts.onEvent 事件回调：step / tool / result / token / done
 * @param {() => boolean} opts.isCancelled
 */
export async function runAgent({ task, history = [], settings = DEFAULT_SETTINGS, onEvent, isCancelled, onAbortReady }) {
  const lang = settings.language || 'zh';
  const maxSteps = Math.max(1, Math.min(Number(settings.maxSteps) || 12, 30));

  // 按任务意图预筛工具：这是"减少无关工具调用"的第一道关
  const activeTools = toolsFor(pickTools(task));

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(lang, maxSteps) },
    ...history.slice(-10),
    { role: 'user', content: task },
  ];

  // 长期记忆注入（关闭时跳过）
  let memoryCount = 0;
  if (settings.memoryEnabled !== false) {
    try {
      const mem = await callBg('panel/memory-context');
      if (mem?.text) {
        memoryCount = mem.count || 0;
        messages.splice(1, 0, {
          role: 'system',
          content: `【长期记忆】以下是之前积累的、与本次任务相关的信息，请自然地运用，不要生硬复述：\n${mem.text}`,
        });
        onEvent?.({ type: 'memory', count: memoryCount });
      }
    } catch {
      /* 记忆读取失败不影响主流程 */
    }
  }

  // 自进化内容注入：命中的技能 + 积累的自我提醒。
  // 这是"自进化"的落地环节 —— 之前学到的经验在这里影响本次行为。
  let skillCount = 0;
  let ruleCount = 0;
  if (settings.evolutionEnabled !== false && settings.evolutionInject !== false) {
    try {
      const evo = await callBg('evolution/context', { task });
      if (evo?.ruleText) {
        ruleCount = evo.ruleCount || 0;
        messages.splice(messages.length, 0, {
          role: 'system',
          content:
            '【自我提醒】以下是你从过去的执行中总结的经验，请在本任务中遵循：\n' +
            evo.ruleText,
        });
        onEvent?.({ type: 'rules', count: ruleCount });
      }
      if (evo?.skillText) {
        skillCount = evo.skillCount || 0;
        messages.push({
          role: 'system',
          content:
            '【可复用技能】检测到与当前任务相关的既有方法，参考它来减少试错（但不必照搬，情况不同就随机应变）：\n' +
            evo.skillText,
        });
        onEvent?.({ type: 'skills', count: skillCount, names: evo.matched || [] });
      }
    } catch {
      /* 自进化读取失败不影响主流程 */
    }
  }

  // 给模型一个初始的页面视角
  let pageContext = '';
  try {
    const snap = await callBg(MSG.GET_PAGE);
    pageContext = `当前标签页：${snap.title} — ${snap.url}\n可交互元素 ${snap.elements.length} 个。`;
  } catch (err) {
    pageContext = `当前标签页无法读取：${err.message}`;
  }
  messages.push({
    role: 'system',
    content: `【当前环境】${pageContext}\n需要元素编号时调用 snapshot。`,
  });

  const steps = [];
  const usageTotal = { prompt: 0, completion: 0, total: 0, reasoning: 0, calls: 0 };
  /** 本轮运行的唯一后缀，用于拼出请求 id。 */
  const runSeed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  /** 当前在途请求 id；没有在途请求时为 null。 */
  let currentRequestId = null;

  /**
   * 中止在途的模型请求。面板点「停止」时立刻调用 ——
   * 否则用户点了停止，界面还要干等 fetch 返回（可能几十秒）。
   */
  const abortInFlight = async () => {
    if (!currentRequestId) return false;
    try {
      await chrome.runtime.sendMessage({ type: MSG.ABORT, requestId: currentRequestId });
      return true;
    } catch {
      return false;
    }
  };

  // 把中止入口交给面板，让「停止」按钮能立即掐断在途请求
  onAbortReady?.(abortInFlight);

  /** 累积一次模型调用的用量，并通知界面。 */
  const trackUsage = (reply) => {
    const u = reply?.usage;
    if (!u) return;
    const prompt = Number(u.prompt_tokens) || 0;
    const completion = Number(u.completion_tokens) || 0;
    const reasoning = Number(u.completion_tokens_details?.reasoning_tokens) || 0;
    usageTotal.prompt += prompt;
    usageTotal.completion += completion;
    usageTotal.total += Number(u.total_tokens) || prompt + completion;
    usageTotal.reasoning += reasoning;
    usageTotal.calls += 1;
    onEvent?.({ type: 'usage', usage: { ...usageTotal }, last: u });
  };

  for (let i = 0; i < maxSteps; i += 1) {
    if (isCancelled?.()) return { aborted: true, steps, usage: usageTotal };

    onEvent?.({ type: 'step', index: i + 1, total: maxSteps });

    // 每轮用独立的请求 id，方便精确中止
    const requestId = `r${i}-${runSeed}`;
    currentRequestId = requestId;

    let reply;
    try {
      reply = await callBg(MSG.RUN_STEP, {
        payload: { messages, tools: activeTools, toolChoice: 'auto', requestId },
      });
    } catch (err) {
      currentRequestId = null;
      // 用户主动中止：不算错误，安静退出
      if (err.message === '__ABORTED__' || isCancelled?.()) {
        return { aborted: true, steps, usage: usageTotal };
      }
      onEvent?.({ type: 'error', message: err.message });
      return { error: err.message, steps, usage: usageTotal };
    }
    currentRequestId = null;

    // 请求返回后可能已经被取消：别再继续跑工具
    if (isCancelled?.()) return { aborted: true, steps, usage: usageTotal };

    trackUsage(reply);

    const assistantMessage = {
      role: 'assistant',
      content: reply.content || '',
      tool_calls: reply.toolCalls,
    };
    messages.push(assistantMessage);

    if (!reply.toolCalls?.length) {
      // 模型没走工具就答完了，直接当最终回复
      onEvent?.({ type: 'done', summary: reply.content || '(空回复)' });
      return { summary: reply.content, steps, usage: usageTotal, memoryCount, skillCount, ruleCount };
    }

    for (const call of reply.toolCalls) {
      if (isCancelled?.()) return { aborted: true, steps, usage: usageTotal };

      const name = call.function?.name;
      const args = safeParse(call.function?.arguments);

      if (name === 'finish') {
        onEvent?.({ type: 'done', summary: args.summary || '完成。' });
        return { summary: args.summary, steps, usage: usageTotal, memoryCount, skillCount, ruleCount };
      }

      onEvent?.({ type: 'tool', name, args });

      let result;
      try {
        if (name === 'snapshot') {
          result = compactSnapshot(await callBg(MSG.GET_PAGE));
        } else if (name === 'outline') {
          result = compactOutline(await callBg(MSG.GET_OUTLINE));
        } else if (name === 'read_page') {
          const data = await callBg(MSG.GET_PAGE_TEXT);
          result = {
            url: data.url,
            title: data.title,
            truncated: data.truncated,
            text: data.text,
          };
        } else if (name === 'export_file') {
          // 文件写入需要 DOM（Blob / File System Access），只能在面板里做。
          // 这里把内容交给界面，由用户确认写到哪儿 —— 不静默写盘。
          onEvent?.({
            type: 'file',
            filename: args.filename,
            content: args.content,
            format: args.format,
          });
          result = {
            ok: true,
            note: '已把文件内容交给界面，用户可在弹窗里选择保存位置',
            filename: args.filename,
            chars: String(args.content || '').length,
          };
        } else if (name === 'remember') {
          // 记忆库关闭时静默跳过，避免模型反复尝试
          if (settings.memoryEnabled === false) {
            result = { ok: true, note: '记忆库已关闭，本条未保存' };
          } else {
            const saved = await callBg(MSG.MEM_ADD, {
              item: { kind: args.kind, text: args.text, url: undefined },
            });
            result = { ok: true, saved: saved.added, text: saved.item?.text };
            onEvent?.({ type: 'memory-added', text: saved.item?.text, kind: saved.item?.kind });
          }
        } else if (ACTIONS.includes(toAction(name, args)?.type)) {
          const action = toAction(name, args);
          result = await callBg(MSG.EXEC_ACTION, { action });
        } else {
          result = { ok: false, error: `不支持的工具 ${name}` };
        }
      } catch (err) {
        result = { ok: false, error: err.message };
      }

      steps.push({ step: i + 1, tool: name, args, result });
      onEvent?.({ type: 'result', name, result });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 20000),
      });
    }
  }

  const summary = `⚠️ 已达到最大步数（${maxSteps} 步）仍未完成。可以告诉我继续，或把任务拆得更具体一些。`;
  onEvent?.({ type: 'done', summary, truncated: true });
  return { summary, steps, exhausted: true, usage: usageTotal, memoryCount, skillCount, ruleCount };
}

/** 统一封装的 background 调用：解包 {ok,data} 并抛错。 */
export async function callBg(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res) throw new Error('后台没有响应，请重新加载扩展');
  if (res.ok === false) throw new Error(res.error || '操作失败');
  return res.data;
}
