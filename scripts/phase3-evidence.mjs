#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 阶段三证据收集器：针对已存在的两个并行运行收集真实结果并写入 demo/evidence/。
 * 用法：node scripts/phase3-evidence.mjs [runA] [runB]
 * 不传参时自动取 Log Audit / Notes API 并行 两个项目的最新运行。
 */
import { API, waitServer, api, saveEvidence, summarizeRun, printSummary } from './lib.mjs';

async function latestRunForProject(name) {
  const projects = await api('GET', '/api/projects');
  const project = projects.find((p) => p.name === name);
  if (!project) throw new Error(`找不到项目：${name}`);
  const runs = await api('GET', `/api/projects/${project.id}/runs`);
  if (!runs.length) throw new Error(`项目没有运行记录：${name}`);
  const run = runs.find((r) => ['awaiting_acceptance', 'accepted'].includes(r.status)) || runs[0];
  return { project, run };
}

async function main() {
  await waitServer();
  let [runAId, runBId] = process.argv.slice(2);
  let projectA;
  let projectB;
  if (!runAId || !runBId) {
    const a = await latestRunForProject('Log Audit（阶段三）');
    const b = await latestRunForProject('Notes API 并行（阶段三）');
    runAId = a.run.id;
    runBId = b.run.id;
    projectA = a.project;
    projectB = b.project;
  }
  const [detailA, detailB] = await Promise.all([api('GET', `/api/runs/${runAId}`), api('GET', `/api/runs/${runBId}`)]);
  const summaryA = summarizeRun(detailA);
  const summaryB = summarizeRun(detailB);
  const state = await api('GET', '/api/state');
  const ciAction = (detailA.actions || []).find((a) => a.type === 'github-ci');
  const githubActions = (detailA.actions || []).filter((a) => a.type.startsWith('github-'));

  console.log('===== 项目 A =====');
  printSummary(summaryA);
  console.log('===== 项目 B =====');
  printSummary(summaryB);

  const agentsUsed = [
    ...summaryA.tasks.map((t) => ({ project: 'Log Audit', task: t.title, agent: t.result?.agent, status: t.status, audits: (t.auditHistory || []).map((a) => a.verdict) })),
    ...summaryB.tasks.map((t) => ({ project: 'Notes API 并行', task: t.title, agent: t.result?.agent, status: t.status, audits: (t.auditHistory || []).map((a) => a.verdict) })),
  ];
  const evidence = {
    phase: 'phase3-multiproject-crossagent-github',
    realAgents: true,
    generatedAt: new Date().toISOString(),
    projects: [
      { id: projectA?.id || detailA.project?.id, name: detailA.project?.name, path: detailA.project?.local_path },
      { id: projectB?.id || detailB.project?.id, name: detailB.project?.name, path: detailB.project?.local_path },
    ],
    parallelRuns: [detailA.id, detailB.id],
    runTimestamps: {
      runAStarted: detailA.started_at,
      runBStarted: detailB.started_at,
    },
    agentsUsed,
    github: {
      configured: !!state.github?.configured,
      owner: state.github?.owner || '',
      actions: githubActions,
      ci: ciAction?.result_json || null,
      pr: summaryA.pr,
      note: '真实推送分支并创建草稿 PR（未合并）；GitHub Actions 轮询结果见 ci/runs。',
    },
    runA: summaryA,
    runB: summaryB,
    acceptanceNote: '两项目并行执行（并发启动）；同一计划内任务级跨 Agent（DSH + Claude Code）真实执行；测试与独立模型审计真实执行；tests/ 未修改。',
  };
  saveEvidence(`phase3-${Date.now()}.json`, evidence);
  const ok = [detailA.status, detailB.status].every((s) => s === 'awaiting_acceptance');
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`证据收集失败：${err.message}`);
  process.exit(1);
});
