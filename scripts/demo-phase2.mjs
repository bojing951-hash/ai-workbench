#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 阶段二真实验收：多任务自动规划 -> 顺序自动推进 -> 进程级中断 -> 重启恢复 -> 继续至完成。
 *
 * 该脚本会自己启动并杀死工作台服务，用于验证"进程中断后能继续"。
 * 前置：4477 端口没有正在运行的工作台（请先停止 npm start）。
 * 用法：node scripts/demo-phase2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, API, waitServer, api, addProjectIfMissing, prepareDemoProject, waitRun, saveEvidence, summarizeRun, printSummary, sleep } from './lib.mjs';

const PORT = Number(new URL(API).port || 4477);
const serverLog = path.join(ROOT, 'data', 'logs', 'phase2-server.log');
let serverProc = null;

function startServer(tag) {
  fs.mkdirSync(path.dirname(serverLog), { recursive: true });
  const logStream = fs.createWriteStream(serverLog, { flags: 'a' });
  logStream.write(`\n\n===== [${new Date().toISOString()}] 启动工作台（${tag}） =====\n`);
  serverProc = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'bin', 'workbench.js'), 'serve', '--port', String(PORT)],
    { cwd: ROOT, env: { ...process.env, WORKBENCH_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  serverProc.stdout.pipe(logStream);
  serverProc.stderr.pipe(logStream);
  return serverProc;
}

async function stopServer(signal = 'SIGKILL', { waitMs = 10_000 } = {}) {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill(signal);
  } catch {
    /* ignore */
  }
  await Promise.race([exited, sleep(waitMs)]);
  // 等待端口释放
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    try {
      await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1000) });
      await sleep(300);
    } catch {
      return;
    }
  }
}

async function isServerUp() {
  try {
    const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForFirstTaskPassed(runId, timeoutMs = 30 * 60 * 1000) {
  const started = Date.now();
  let lastEventId = 0;
  for (;;) {
    const detail = await api('GET', `/api/runs/${runId}`);
    for (const e of (detail.events || []).filter((x) => x.id > lastEventId)) {
      lastEventId = e.id;
      console.log(`  · [${new Date(e.createdAt || e.created_at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}] ${e.type}  ${e.message}`);
    }
    if (detail.status === 'paused' || ['awaiting_acceptance', 'accepted', 'failed', 'cancelled'].includes(detail.status)) {
      throw new Error(`在首个任务完成前运行已结束：${detail.status} ${detail.stop_reason || ''}`);
    }
    const first = (detail.tasks || [])[0];
    if (first && first.status === 'passed') return detail;
    if (Date.now() - started > timeoutMs) throw new Error('等待首个任务通过超时');
    await sleep(1200);
  }
}

async function main() {
  if (await isServerUp()) {
    throw new Error(`端口 ${PORT} 上已有工作台在运行。阶段二需要真实重启进程，请先停止现有服务（Ctrl+C / 关闭 npm start 终端）后重试。`);
  }

  console.log('启动工作台（阶段二，脚本托管）…');
  startServer('initial');
  await waitServer();

  const localPath = prepareDemoProject('phase2-notes-api', 'phase2-notes-api');
  console.log(`演示项目已准备：${localPath}`);
  const project = await addProjectIfMissing({
    name: 'Notes API（阶段二）',
    repo: localPath,
    testCommand: 'npm test',
    protectTests: true,
    description: '阶段二真实验收：多任务规划 + 顺序执行 + 进程中断恢复',
    agentKind: 'auto',
  });

  const run = await api('POST', `/api/projects/${project.id}/runs`, {
    goal: '为 Notes API 实现服务骨架与健康检查、笔记 CRUD、搜索能力三个功能；必须通过仓库内已评审的验收测试，不得修改测试。',
    mode: 'plan',
  });
  console.log(`\n运行已创建（自动规划模式）：${run.runId}，规划任务数：${run.tasks}\n`);

  // 打印规划结果，证明是多任务自动规划
  const initial = await api('GET', `/api/runs/${run.runId}`);
  const planned = (initial.tasks || []).map((t) => ({ seq: t.seq, title: t.title, acceptance: t.acceptance_json, testCommand: t.test_command, agent: t.agent_kind }));
  console.log('规划器生成的任务计划：');
  for (const t of planned) console.log(`  ${t.seq}. ${t.title}（测试：${t.testCommand || '项目默认'}，Agent：${t.agent}）`);
  for (const t of planned) for (const a of t.acceptance) console.log(`      验收：${a}`);

  console.log('\n等待首个任务通过后，模拟进程崩溃…');
  const beforeCrash = await waitForFirstTaskPassed(run.runId);
  const checkpoint = {
    at: new Date().toISOString(),
    serverPid: serverProc?.pid || null,
    runStatus: beforeCrash.status,
    tasks: (beforeCrash.tasks || []).map((t) => ({ seq: t.seq, title: t.title, status: t.status, commit: t.head_commit, attempts: t.attempts?.length || 0 })),
  };
  console.log(`\n首个任务已通过。当前任务状态：${checkpoint.tasks.map((t) => `#${t.seq}=${t.status}`).join('，')}`);
  console.log('发送 SIGKILL 模拟工作台进程崩溃…');
  await stopServer('SIGKILL');
  console.log('进程已终止，端口已释放。片刻后重启工作台…');
  await sleep(2000);

  startServer('restart-after-crash');
  await waitServer();
  console.log('工作台已重启。检查恢复状态…');
  const afterRestart = await api('GET', `/api/runs/${run.runId}`);
  console.log(`重启后运行状态：${afterRestart.status}（${afterRestart.stop_reason || '无说明'}）`);
  const restartEvent = (afterRestart.events || []).find((e) => e.type === 'run_interrupted');
  console.log(`中断事件：${restartEvent ? `#${restartEvent.id} ${restartEvent.message}` : '未记录'}`);

  console.log('\n从断点恢复运行…');
  await api('POST', `/api/runs/${run.runId}/resume`, { retryFailed: false });
  const finalDetail = await waitRun(run.runId, { label: '阶段二恢复' });
  const summary = summarizeRun(finalDetail);
  printSummary(summary);

  const evidence = {
    phase: 'phase2-multitask-recovery',
    realAgents: true,
    plannedByLLM: true,
    startedAt: checkpoint.at,
    projectId: project.id,
    plan: planned,
    interruption: {
      method: 'SIGKILL workbench server process',
      checkpoint,
      restartRunStatus: afterRestart.status,
      restartStopReason: afterRestart.stop_reason,
      recoveredEvent: restartEvent || null,
    },
    run: summary,
    acceptanceNote: '真实进程崩溃 + 重启 + 断点恢复；跨任务自动推进；未修改验收测试。',
  };
  saveEvidence(`phase2-${Date.now()}.json`, evidence);

  await stopServer('SIGINT');
  console.log('\n阶段二完成。启动主服务查看界面：npm start');
  if (summary.status !== 'awaiting_acceptance') process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error(`\n阶段二失败：${err.message}`);
    await stopServer('SIGKILL').catch(() => {});
    process.exit(1);
  });
