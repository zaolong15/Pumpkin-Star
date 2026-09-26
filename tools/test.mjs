#!/usr/bin/env node
/**
 * test.mjs —— 一把跑完所有测试。
 *
 * 用法：node tools/test.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

const suites = [
  ['icon-check.mjs', '图标校验'],
  ['icon-lib-test.mjs', '图标库'],
  ['files-test.mjs', '文件输出'],
  ['perf-test.mjs', '提速验证'],
  ['parallel-test.mjs', '并行执行'],
  ['tool-select-test.mjs', '工具预筛'],
  ['upload-test.mjs', '附件读取'],
  ['evolution-test.mjs', '自进化'],
  ['validate.mjs', '清单与接线自检'],
  ['privacy-test.mjs', '隐私政策一致性'],
  ['abort-test.mjs', '停止按钮'],
  ['state-test.mjs', '界面状态机'],
  ['handle-task-test.mjs', '任务状态闭环'],
  ['outline-test.mjs', '结构快照'],
  ['theme-test.mjs', '主题引擎与个性化'],
  ['smoke-test.mjs', '智能体循环冒烟'],
  ['patch-test.mjs', '页面改造与撤销'],
  ['memory-usage-test.mjs', '记忆库与用量'],
  ['e2e-test.mjs', '端到端任务'],
];

const results = [];
for (const [file, label] of suites) {
  process.stdout.write(`\n${'='.repeat(56)}\n${label}  (${file})\n${'='.repeat(56)}\n`);
  const r = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  results.push([label, r.status === 0]);
}

console.log(`\n${'='.repeat(56)}\n汇总\n${'='.repeat(56)}`);
let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${label}`);
  if (!ok) failed += 1;
}
console.log('');
if (failed) {
  console.log(`\u2717 ${failed} 个套件失败`);
  process.exit(1);
}
console.log('\u2713 全部套件通过。');
