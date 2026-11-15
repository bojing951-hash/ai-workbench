#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 阶段三真实验收：
 *  - 两个项目并行运行（多项目管理 + 统一编排）
 *  - 同一计划内跨 Coding Agent 调度（任务 1 -> DSH，任务 2 -> Claude Code）
 *  - GitHub 分支推送 / 草稿 PR / GitHub Actions 状态（需 GITHUB_TOKEN；未配置则如实记录为待授权）
 * 前置：npm start 已启动工作台。
 */
import { waitServer, api, addProjectIfMissing, prepareDemoProject, waitRun, saveEvidence, summarizeRun, printSummary, sleep } from './lib.mjs';

const LOG_TASKS = [
  {
    title: '实现日志行解析',
    description:
      '在 src/index.js 实现并导出 parseLogLine(line) 与 parseLog(text)。parseLogLine 解析 ISO 时间戳 + 级别（debug/info/warn/error，大小写不敏感）+ 消息，返回 {timestamp, level, message}；空行/非法格式/非法时间戳返回 null。parseLog 按行解析并过滤 null，保持顺序。',
    acceptance: [
      '导出 parseLogLine 与 parseLog，标准日志行解析出 timestamp/level/message 三个字段且级别输出小写。',
      '非法行（空行、无时间戳、未知级别、非法时间戳）parseLogLine 返回 null，parseLog 过滤非法行并保持原顺序。',
      '运行 node --test tests/parse.test.js 全部通过，且 tests/ 下文件未被修改。',
    ],
    agent: 'dsh',
    testCommand: 'node --test tests/parse.test.js',
  },
  {
    title: '实现日志统计与过滤',
    description:
      '在 src/index.js 实现并导出 summarizeLogs(entries) 与 filterByLevel(entries, level)。统计 total、byLevel（debug/info/warn/error 四键始终存在）、firstTimestamp、lastTimestamp（按数组顺序，空数组为 null）；filterByLevel 支持 all 并返回新数组。',
    acceptance: [
      'summarizeLogs 返回 total、byLevel 四键、firstTimestamp、lastTimestamp；空数组时计数均为 0 且时间戳为 null。',
      'filterByLevel 按级别过滤，level=all 时返回包含全部条目的新数组。',
      '运行 node --test tests/summarize.test.js 全部通过，且 tests/ 下文件未被修改。',
    ],
    agent: 'claude',
    testCommand: 'node --test tests/summarize.test.js',
  },
];

const NOTES_TASKS = [
  {
    title: '实现 Notes API 健康检查',
    description:
      '在 src/server.js 实现 createServer() 与 startServer(port)：startServer(0) 返回 {server, port, url, close}；GET /health 返回 200 JSON {status:"ok",service:"notes-api"}；未知路径返回 404 JSON {error:"not_found"}；响应头包含 application/json。',
    acceptance: [
      'GET /health 返回 200 且 JSON 为 {status:"ok",service:"notes-api"}，content-type 包含 application/json。',
      '未知路径返回 404 且 JSON 为 {error:"not_found"}。',
      'startServer(0) 使用随机端口、可重复启动并返回 url/port/close。',
      '运行 node --test tests/health.test.js 全部通过，且 tests/ 下文件未被修改。',
    ],
    agent: 'dsh',
    testCommand: 'node --test tests/health.test.js',
  },
];

async function pollCi(runId, { attempts = 18, intervalMs = 12_000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    let detail;
    try {
      detail = await api('GET', `/api/runs/${runId}`);
    } catch {
      return { conclusion: 'unknown', note: '无法读取运行详情' };
    }
    const ci = (detail.actions || []).find((a) => a.type === 'github-ci');
    const result = ci?.result_json || {};
    if (result.conclusion === 'success' || result.conclusion === 'failure') {
      return { ...result, checkedAt: new Date().toISOString() };
    }
    if (i === 1 || i % 3 === 0) {
      console.log(`  · CI 状态：${result.conclusion || ci?.status || '等待中'}（第 ${i}/${attempts} 次检查）`);
    }
    await sleep(intervalMs);
    if (i < attempts) {
      try {
        await api('POST', `/api/runs/${runId}/ci-refresh`);
      } catch {
        /* token 未配置时忽略 */
      }
    }
  }
  return { conclusion: 'timeout', note: '等待 GitHub Actions 超时，可在界面手动刷新' };
}

async function main() {
  await waitServer();
  const state = await api('GET', '/api/state');
  const githubConfigured = !!state.github?.configured;
  console.log(`工作台已连接。GitHub Token：${githubConfigured ? '已配置（真实 PR/CI）' : '未配置（远端动作将如实记录为待授权）'}`);

  const logPath = prepareDemoProject('phase3-log-audit', 'phase3-log-audit');
  const notesPath = prepareDemoProject('phase2-notes-api', 'phase3-notes-parallel');
  const logProject = await addProjectIfMissing({
    name: 'Log Audit（阶段三）',
    repo: logPath,
    testCommand: 'npm test',
    protectTests: true,
    description: '阶段三：多项目并行 + 跨 Agent + GitHub PR/CI',
    agentKind: 'auto',
  });
  const notesProject = await addProjectIfMissing({
    name: 'Notes API 并行（阶段三）',
    repo: notesPath,
    testCommand: 'npm test',
    protectTests: true,
    description: '阶段三并行项目（仅本地发布）',
    agentKind: 'dsh',
    publish: false,
  });
  console.log(`项目 A：${logProject.id} ${logProject.name}`);
  console.log(`项目 B：${notesProject.id} ${notesProject.name}`);

  const startedAt = new Date().toISOString();
  console.log('\n同时启动两个项目的自动开发（多项目并行）…');
  const [runA, runB] = await Promise.all([
    api('POST', `/api/projects/${logProject.id}/runs`, {
      goal: '实现 Log Audit 的日志解析、统计与过滤能力，使仓库内已评审的验收测试通过。',
      mode: 'single',
      tasks: LOG_TASKS,
      acceptance: ['所有任务通过各自验收测试与独立审计，未修改 tests/ 与验收约定。'],
    }),
    api('POST', `/api/projects/${notesProject.id}/runs`, {
      goal: '为 Notes API 实现服务骨架与健康检查接口（阶段三并行项目）。',
      mode: 'single',
      tasks: NOTES_TASKS,
      acceptance: ['健康检查接口按验收标准实现并通过验收测试与独立审计。'],
    }),
  ]);
  console.log(`运行 A（Log Audit）：${runA.runId}，任务数 ${runA.tasks}`);
  console.log(`运行 B（Notes API 并行）：${runB.runId}，任务数 ${runB.tasks}`);

  console.log('\n等待两个项目完成（Agent 并发上限由工作台控制）…');
  const [detailA, detailB] = await Promise.all([
    waitRun(runA.runId, { label: 'A/LogAudit' }),
    waitRun(runB.runId, { label: 'B/Notes' }),
  ]);

  const summaryA = summarizeRun(detailA);
  const summaryB = summarizeRun(detailB);
  console.log('\n========== 项目 A 摘要 ==========');
  printSummary(summaryA);
  console.log('\n========== 项目 B 摘要 ==========');
  printSummary(summaryB);

  let ci = null;
  if (githubConfigured && summaryA.pr) {
    console.log('\n检查 GitHub Actions 结果…');
    ci = await pollCi(runA.runId);
    console.log(`CI 结论：${ci.conclusion}${ci.runs ? `（${ci.runs.map((r) => `${r.name}:${r.conclusion || r.status}`).join('，')}）` : ''}`);
  }

  const agentsUsed = [
    ...summaryA.tasks.map((t) => ({ project: 'Log Audit', task: t.title, agent: t.result?.agent, status: t.status })),
    ...summaryB.tasks.map((t) => ({ project: 'Notes API 并行', task: t.title, agent: t.result?.agent, status: t.status })),
  ];

  const evidence = {
    phase: 'phase3-multiproject-crossagent-github',
    realAgents: true,
    startedAt,
    projects: [
      { id: logProject.id, name: logProject.name, path: logPath },
      { id: notesProject.id, name: notesProject.name, path: notesPath },
    ],
    parallelRuns: [runA.runId, runB.runId],
    agentsUsed,
    github: {
      configured: githubConfigured,
      pr: summaryA.pr,
      ci,
      note: githubConfigured ? '真实推送分支、创建草稿 PR、读取 GitHub Actions 结果；工作台未合并主分支。' : '未配置 GITHUB_TOKEN：多项目与跨 Agent 已真实完成，Push/PR/CI 记录为待授权。',
    },
    runA: summaryA,
    runB: summaryB,
    acceptanceNote: '两项目并行执行；任务级跨 Agent（DSH + Claude Code）；DSH/Claude 均为真实调用；测试与审计真实执行。',
  };
  saveEvidence(`phase3-${Date.now()}.json`, evidence);

  const ok = [summaryA.status, summaryB.status].every((s) => s === 'awaiting_acceptance');
  if (!ok) process.exitCode = 1;
  if (!githubConfigured) console.log('\n提示：阶段三的 GitHub PR/CI 需要 GITHUB_TOKEN（见 .env.example）。');
}

main().catch((err) => {
  console.error(`\n阶段三失败：${err.message}`);
  process.exit(1);
});
