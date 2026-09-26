import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const agentSrc = await readFile(join(root, 'src/panel/agent.js'), 'utf8');

// 抽出 pickTools / TOOL_GROUPS / toolsFor 和 TOOLS 定义，单独跑
const toolGroups = agentSrc.match(/const TOOL_GROUPS = \{[\s\S]*?\n\};/)[0];
const pickTools = agentSrc.match(/function pickTools\(task\) \{[\s\S]*?\n\}/)[0];
const toolsFor = agentSrc.match(/function toolsFor\(names\) \{[\s\S]*?\n\}/)[0];

// 只取工具的 name 字段来模拟 TOOLS
const names = [...agentSrc.matchAll(/^\s{6}name: '([a-z_]+)'/gm)].map((m) => m[1]);
const TOOLS = names.map((n) => ({ type: 'function', function: { name: n } }));

const api = new Function(
  'TOOLS',
  `${toolGroups}\n${pickTools}\n${toolsFor}\nreturn { pickTools, toolsFor, TOOL_GROUPS };`,
)(TOOLS);

const failures = [];
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
};

console.log('\n工具分组测试\n');

console.log('[1] 只读任务不应拿到改造类工具');
{
  const cases = [
    '总结这个页面',
    '把页面翻译成中文',
    '这篇文章讲了什么',
    '提取页面上的要点',
    '概括一下内容',
  ];
  let ok = true;
  for (const t of cases) {
    const tools = api.toolsFor(api.pickTools(t)).map((x) => x.function.name);
    const hasPatch = tools.some((n) => ['add_style', 'inject_js', 'set_text', 'hide', 'set_style'].includes(n));
    if (hasPatch) {
      ok = false;
      console.log(`      ! "${t}" 拿到了改造工具`);
    }
  }
  check(ok, '5 种只读表述都不会拿到改造工具');
}

console.log('\n[2] 改造任务应拿到改造工具，且不拿无用的');
{
  const cases = ['把广告去掉', '净化这个页面', '改成深色模式', '隐藏侧边栏', '正文放大一点'];
  let ok = true;
  for (const t of cases) {
    const tools = api.toolsFor(api.pickTools(t)).map((x) => x.function.name);
    const hasPatch = tools.some((n) => ['add_style', 'hide', 'set_text', 'set_style'].includes(n));
    if (!hasPatch) {
      ok = false;
      console.log(`      ! "${t}" 没拿到改造工具`);
    }
  }
  check(ok, '5 种改造表述都能拿到改造工具');
}

console.log('\n[3] 操作类任务保留完整能力');
{
  const tools = api.toolsFor(api.pickTools('在搜索框输入关键词然后点搜索')).map((x) => x.function.name);
  check(tools.includes('type_text'), '有 type_text');
  check(tools.includes('click'), '有 click');
  check(tools.includes('snapshot'), '有 snapshot');
  check(tools.includes('finish'), '有 finish（保证能收尾）');
}

console.log('\n[4] 判断不出来时的兜底');
{
  const weird = ['嗯', '123', '???', '随便做点什么'];
  let ok = true;
  for (const t of weird) {
    const tools = api.toolsFor(api.pickTools(t)).map((x) => x.function.name);
    if (!tools.includes('finish') || tools.length < 5) {
      ok = false;
      console.log(`      ! "${t}" 兜底失败（${tools.length} 个工具）`);
    }
  }
  check(ok, '模糊任务有合理兜底，不会没工具可用');
}

console.log('\n[5] 剪贴板任务');
{
  const tools = api.toolsFor(api.pickTools('把我复制的内容总结一下')).map((x) => x.function.name);
  check(tools.includes('read_clipboard'), '有 read_clipboard');
  check(tools.includes('finish'), '有 finish');

  const copyTools = api.toolsFor(api.pickTools('把结果复制到剪贴板')).map((x) => x.function.name);
  check(copyTools.includes('copy_to_clipboard'), '写剪贴板任务有 copy_to_clipboard');
}

console.log('\n[6] 每组都包含 finish（保证循环能终止）');
{
  let ok = true;
  for (const [name, group] of Object.entries(api.TOOL_GROUPS)) {
    if (!group.includes('finish')) {
      ok = false;
      console.log(`      ! 组 ${name} 缺少 finish`);
    }
  }
  check(ok, '所有分组都含 finish');
}

console.log('\n[7] 分组里的工具名都真实存在');
{
  const all = new Set(names);
  const bad = [];
  for (const [gname, group] of Object.entries(api.TOOL_GROUPS)) {
    for (const t of group) {
      if (!all.has(t)) bad.push(`${gname}:${t}`);
    }
  }
  check(bad.length === 0, `分组引用的工具都存在${bad.length ? `（错误：${bad.join(', ')}）` : ''}`);
}

console.log('\n[8] 工具数量确实减少了');
{
  console.log(`      全集: ${names.length} 个`);
  for (const t of ['总结这个页面', '把广告去掉', '点击登录按钮']) {
    const n = api.toolsFor(api.pickTools(t)).length;
    console.log(`      "${t}" → ${n} 个`);
  }
  const readCount = api.toolsFor(api.pickTools('总结这个页面')).length;
  check(readCount < names.length * 0.6, `只读任务工具数 ${readCount} < 全集的 60%（省 token 与选择成本）`);
}

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  process.exit(1);
}
console.log('✓ 工具分组测试全部通过。');
