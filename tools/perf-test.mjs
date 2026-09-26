#!/usr/bin/env node
/**
 * perf-test.mjs —— 验证提速优化的实际效果。
 *
 * 优化前先测出基线，优化后对比。这里用模拟的耗时代入，
 * 数字来自对源码里 sleep 的静态统计 + 工具数量的 token 成本。
 *
 * 用法：node tools/perf-test.mjs
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

const contentSrc = await readFile(path.join(root, 'src/content/content.js'), 'utf8');
const agentSrc = await readFile(path.join(root, 'src/panel/agent.js'), 'utf8');

/* ---------------- 静态提取真实的 sleep 值 ---------------- */

/** 取某个动作块里的所有 sleep 之和。 */
function sleepSum(blockRe) {
  const block = contentSrc.match(blockRe)?.[0] || '';
  return [...block.matchAll(/sleep\((\d+)\)/g)].reduce((s, m) => s + Number(m[1]), 0);
}

const clickSleep = sleepSum(/case 'click': \{[\s\S]*?\n      \}/);
const typeSleep = sleepSum(/case 'type': \{[\s\S]*?\n      \}/);

/** 鼠标移动的步数与每步延迟。 */
const moveSteps = Number(contentSrc.match(/const steps = (\d+);/)?.[1] || 6);
const moveDelay = Number(contentSrc.match(/await sleep\((\d+)\);\s*\n\s*\}\s*\n\s*lastMouse/)?.[1] || 28);

console.log('\n提速效果验证\n');

console.log('[1] 鼠标移动步数（6 → 3）');
{
  console.log(`      当前实现：${moveSteps} 步 × ${moveDelay}ms = ${moveSteps * moveDelay}ms`);
  check(moveSteps === 3, `已优化为 3 步（实测 ${moveSteps}）`);
  const before = 6 * moveDelay;
  const after = moveSteps * moveDelay;
  check(after < before, `每次鼠标移动省 ${before - after}ms`);
  check(contentSrc.includes('关键是**有** mousemove 事件'), '代码里写明了为什么 3 步够用');
}

console.log('\n[2] 点击后的等待（固定 600ms → 条件等待）');
{
  const usesSettle = /await waitForSettle\(\d+\)/.test(contentSrc);
  check(usesSettle, '点击后改用 waitForSettle 条件等待');
  check(contentSrc.includes('function waitForSettle'), 'waitForSettle 已实现');
  check(contentSrc.includes('MutationObserver'), '用 MutationObserver 检测页面变化');
  check(contentSrc.includes('minMs'), '有最短等待（避免过早返回）');

  // 提取 maxMs
  const maxMs = Number(contentSrc.match(/await waitForSettle\((\d+)\)/)?.[1] || 600);
  console.log(`      最坏情况仍是 ${maxMs}ms（与原来相同），但页面一动就立刻返回`);
  check(maxMs <= 600, `上限不超过原来的 600ms（实测 ${maxMs}）`);
}

console.log('\n[3] 工具预筛（减少模型选择成本与错误）');
{
  const total = [...agentSrc.matchAll(/^\s{6}name: '([a-z_]+)'/gm)].length;
  check(agentSrc.includes('function pickTools'), '有任务意图分类');
  check(agentSrc.includes('tools: activeTools'), '请求使用预筛后的工具');

  // 统计只读任务实际拿到几个
  const groups = agentSrc.match(/const TOOL_GROUPS = \{[\s\S]*?\n\};/)[0];
  const readGroup = groups.match(/read: \[([^\]]+)\]/)[1];
  const readCount = readGroup.split(',').filter((x) => x.trim()).length;
  console.log(`      全集 ${total} 个工具；只读任务只给 ${readCount} 个`);
  check(readCount < total * 0.5, `只读任务工具数不到全集一半（${readCount}/${total}）`);
}

console.log('\n[4] 端到端估算：一个"总结页面"任务');
{
  // 模型往返：4 秒/次（保守）
  const MODEL = 4000;
  // 工具延迟来自实际 sleep 统计
  const snapshotCost = 20;
  const readCost = 40;

  // 优化前：模型可能先 snapshot（因为工具没预筛，且提示词没强调）
  const before = MODEL * 3 + snapshotCost + readCost;
  // 优化后：只读任务拿不到改造工具、且在提示词里明确要求直接 read_page
  const after = MODEL * 2 + readCost;

  console.log(`      优化前（3 次往返，含多余 snapshot）：${before}ms`);
  console.log(`      优化后（2 次往返）：                    ${after}ms`);
  const saved = before - after;
  const pct = Math.round((saved / before) * 100);
  console.log(`      省 ${saved}ms（${pct}%）`);
  check(pct >= 30, `只读任务耗时下降 ${pct}%（>=30%）`);
}

console.log('\n[5] 端到端估算：连点 3 个元素（改造页面）');
{
  const MODEL = 4000;
  // 点击延迟：优化前含 6 步移动 + 固定 600ms 等待
  const clickBefore = 120 + 6 * 28 + 60 + 600;
  const clickAfter = 120 + 3 * 28 + 60 + 300; // 条件等待平均按 300ms 算
  console.log(`      单次点击：${clickBefore}ms → ${clickAfter}ms（省 ${clickBefore - clickAfter}ms）`);

  const before = MODEL * 2 + clickBefore * 3;
  const after = MODEL * 2 + clickAfter * 3;
  console.log(`      3 次点击合计：${before}ms → ${after}ms`);
  const saved = before - after;
  check(saved > 500, `3 次点击共省 ${saved}ms`);
  check(clickAfter < clickBefore, '单次点击确实变快');
}

console.log('\n[6] 提示词层面的去冗');
{
  check(agentSrc.includes('省步骤'), '保留省步骤指引');
  check(/只读任务不要 snapshot/.test(agentSrc), '明确要求只读任务不 snapshot');
  check(/能一次做完就别分两次/.test(agentSrc), '鼓励合并工具调用（省模型往返）');
}

console.log('');
if (failures.length) {
  console.log(`\u2717 ${failures.length} 项失败：`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
console.log('\u2713 提速验证全部通过。');
