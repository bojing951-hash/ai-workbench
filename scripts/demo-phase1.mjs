#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 阶段一真实验收：单项目自动开发 -> 测试 -> 独立审计 -> 失败修复 -> 通过 -> 等待人工验收。
 * 使用真实 DSH Coding Agent、真实测试命令、真实独立模型审计（GLM/GPT）。
 * 前置：npm start 已启动工作台。
 */
import { prepareDemoProject, waitServer, api, addProjectIfMissing, waitRun, saveEvidence, summarizeRun, printSummary } from './lib.mjs';

const GOAL = '完成 TaskVault 任务存储模块，使既有验收测试全部通过，并按验收标准补全 API 文档。';
const ACCEPTANCE = [
  '运行项目测试命令 npm test（node --test）全部用例通过，且 tests/ 与 package.json 未被修改。',
  'src/store.js 导出 TaskStore 类，实现 addTask、completeTask、listTasks、stats 四个方法，行为与 tests/store.test.js 的验收测试一致。',
  'new TaskStore(filePath) 支持 JSON 文件持久化：新增/完成任务后重新加载仍能恢复数据与完成状态。',
  '不引入第三方依赖（package.json 中 dependencies 为空），不修改 tests/ 验收测试。',
  'README.md 新增 "## API" 章节，逐条说明四个方法的参数与返回值（此条为文档验收，测试未覆盖）。',
  // 隐藏验收：对 Coding Agent 隐藏，用于验证“独立审计发现真实缺失 -> 自动反馈修复”闭环，避免按标准过拟合。
  '[hidden] 仓库根目录新增 CHANGELOG.md，包含 "v1.0.0" 条目并描述本次实现的四个方法，且 README.md 中提供指向 CHANGELOG.md 的链接。',
];

async function main() {
  await waitServer();
  console.log('工作台已连接：' + (process.env.WORKBENCH_URL || 'http://127.0.0.1:4477'));

  const localPath = prepareDemoProject('phase1-taskvault', 'phase1-taskvault');
  console.log(`演示项目已准备：${localPath}`);

  const project = await addProjectIfMissing({
    name: 'TaskVault（阶段一）',
    repo: localPath,
    testCommand: 'npm test',
    protectTests: true,
    description: '阶段一真实验收项目：任务存储库 + 预置验收测试',
    agentKind: 'auto',
    auditProvider: 'auto',
  });
  console.log(`项目：${project.id} ${project.name}`);

  const run = await api('POST', `/api/projects/${project.id}/runs`, {
    goal: GOAL,
    acceptance: ACCEPTANCE,
    mode: 'single',
  });
  console.log(`\n运行已创建：${run.runId}（模式 single，任务数 ${run.tasks}）\n`);

  const detail = await waitRun(run.runId, { label: '阶段一' });
  const summary = summarizeRun(detail);
  printSummary(summary);

  const evidence = {
    phase: 'phase1-single-project',
    realAgents: true,
    provider: summary.tasks[0]?.audit?.provider,
    startedAt: new Date().toISOString(),
    projectId: project.id,
    run: summary,
    acceptanceCriteria: ACCEPTANCE,
    note: '真实执行：DSH Coding Agent + 项目测试 + 独立模型审计；包含 [hidden] 隐藏验收（防止按标准过拟合），预期第一轮审计失败、反馈修复后第二轮通过；未修改测试文件。',
  };
  saveEvidence(`phase1-${Date.now()}.json`, evidence);

  console.log('\n下一步：在可视化界面 http://127.0.0.1:4477 查看并人工验收。');
  if (summary.status !== 'awaiting_acceptance') process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n阶段一失败：${err.message}`);
  process.exit(1);
});
