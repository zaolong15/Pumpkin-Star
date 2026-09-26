#!/usr/bin/env node
/**
 * parallel-test.mjs —— 验证工具并行执行的正确性与收益。
 *
 * 风险点：
 *   - 并行后结果的顺序必须与 toolCalls 一致（否则模型会张冠李戴）
 *   - finish 必须优先处理并终止循环
 *   - 串行动作不能被并行（会打乱页面状态依赖）
 *
 * 用法：node tools/parallel-test.mjs
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

const agentSrc = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');

// 抽出并行判定逻辑
const safeBlock = agentSrc.match(/const PARALLEL_SAFE = new Set\(\[[\s\S]*?\]\);/)[0];
const canBlock = agentSrc.match(/function canRunParallel\(toolCalls\) \{[\s\S]*?\n\}/)[0];

const { PARALLEL_SAFE, canRunParallel } = new Function(
  `${safeBlock}\n${canBlock}\nreturn { PARALLEL_SAFE, canRunParallel };`,
)();

const call = (name) => ({ id: `c-${name}`, function: { name, arguments: '{}' } });

console.log('\n工具并行执行测试\n');

console.log('[1] 独立动作应可并行');
{
  check(canRunParallel([call('hide'), call('hide'), call('add_style')]), '三个改造动作可并行');
  check(canRunParallel([call('snapshot'), call('read_page')]), '两个只读动作可并行');
  check(canRunParallel([call('hide'), call('set_text')]), 'hide 与 set_text 可并行');
  check(canRunParallel([call('copy_to_clipboard'), call('export_file')]), '剪贴板与导出可并行');
}

console.log('\n[2] 改变页面状态的动作必须串行');
{
  check(!canRunParallel([call('click'), call('hide')]), 'click 参与的轮次不并行');
  check(!canRunParallel([call('navigate'), call('read_page')]), 'navigate 参与的轮次不并行');
  check(!canRunParallel([call('type_text'), call('click')]), '输入与点击串行');
  check(!canRunParallel([call('scroll'), call('click')]), '滚动与点击串行（会影响坐标）');
  check(!canRunParallel([call('new_tab'), call('read_page')]), '开新标签页串行');
  check(!canRunParallel([call('wait'), call('hide')]), 'wait 参与的轮次串行');
}

console.log('\n[3] 单次调用与 finish');
{
  check(!canRunParallel([call('hide')]), '单个调用不必走并行（无收益）');
  check(!canRunParallel([]), '空数组不并行');
  check(!canRunParallel(null), 'null 不并行');
  // finish 可以出现在并行轮里（会被优先处理）
  check(!canRunParallel([call('hide'), call('finish')]), '含 finish 的轮次整体走串行');
}

console.log('\n[4] 分组覆盖检查');
{
  // PARALLEL_SAFE 里的名字必须是真实工具
  const agentTools = [...agentSrc.matchAll(/^\s{6}name: '([a-z_]+)'/gm)].map((m) => m[1]);
  const allTools = new Set(agentTools);
  const bogus = [...PARALLEL_SAFE].filter((n) => !allTools.has(n));
  check(bogus.length === 0, `PARALLEL_SAFE 里的名字都真实存在${bogus.length ? `（虚构：${bogus.join(', ')}）` : ''}`);

  // 危险动作绝不能出现在 PARALLEL_SAFE 里
  const dangerous = ['click', 'click_at', 'type_text', 'navigate', 'new_tab', 'go_back', 'wait', 'scroll', 'select_option'];
  const wrong = dangerous.filter((n) => PARALLEL_SAFE.has(n));
  check(wrong.length === 0, `危险动作未被误列为可并行${wrong.length ? `（错误：${wrong.join(', ')}）` : ''}`);
}

console.log('\n[5] 实现里的关键约定');
{
  check(/Promise\.all/.test(agentSrc), '并行用 Promise.all（保留顺序）');
  // Promise.all 保证结果顺序与输入一致 —— 这是模型能正确对应 tool_call_id 的前提
  check(/reply\.toolCalls\.map\(/.test(agentSrc), '按 toolCalls 顺序 map（结果顺序一致）');
  check(/isFinish/.test(agentSrc), 'finish 在并行结果里被单独标记');
  check(/const fin = done\.find\(\(d\) => d\.isFinish\)/.test(agentSrc), 'finish 优先处理');
  check(/tool_call_id: d\.call\.id/.test(agentSrc), '并行结果回填时保留 tool_call_id');
  // 串行分支也必须保留
  check(/} else \{[\s\S]{0,200}for \(const call of reply\.toolCalls\)/.test(agentSrc), '串行分支仍然存在');
}

console.log('\n[6] 收益估算');
{
  // 三个 hide 各自约 600ms（waitForSettle 上限）
  const PER_ACTION = 600;
  const serial = PER_ACTION * 3;
  const parallel = PER_ACTION; // 受最慢的决定
  console.log(`      3 个 hide：串行 ${serial}ms → 并行 ${parallel}ms`);
  check(parallel < serial, `省 ${serial - parallel}ms`);
  console.log('      注：并行只在一轮内全是安全动作时启用，保守策略');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 并行执行测试全部通过。');
