#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * AI 开发工作台 CLI。
 * 用法：
 *   workbench serve [--port 4477]
 *   workbench agents
 *   workbench status
 *   workbench project add --name 名称 --repo 路径或URL [--test "npm test"] [--protect "tests/**"] [--agent dsh]
 *   workbench run --project <id|名称> --goal "..." [--acceptance "a,b"] [--mode plan|single] [--tasks tasks.json]
 *   workbench resume <runId> [--retry-failed]
 *   workbench accept <runId>
 *   workbench events <runId>
 *   workbench loop list [--project <项目ID>] [--json]
 *   workbench loop status <loopId> [--json]
 *   workbench loop pause|resume|cancel <loopId> [--reason "..."] [--json]
 *   workbench isolation [--json] [--url http://host:port]
 *   workbench isolation [--json] [--url http://host:port]
 *
 * loop / isolation 子命令复用工作台 HTTP API（/api/loops、/api/executor，
 * data/api-token 认证），因此需要先启动服务（npm start 或 workbench serve）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { startServer } from '../src/server.js';
import { LoopManager } from '../src/loop.js';
import { detectIsolationCapabilities } from '../src/isolation.js';
import { containerCapabilities, cleanupOrphanContainers } from '../src/container.js';
import { checkAllAgents } from '../src/agents/index.js';
import { auditProviderStatus } from '../src/auditors/index.js';
import { formatCny, formatTokens } from '../src/pricing.js';

const config = getConfig();
const store = openStore(config.paths.dbPath);
const bus = new EventBus();
const orchestrator = new Orchestrator({ config, store, bus });
const loops = new LoopManager({ config, store, bus, orchestrator });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const wantsHelp = !!(args.help || args.h);
const cmd = args._[0] || (wantsHelp ? 'help' : 'serve');

const API_TIMEOUT_MS = 10_000;
const LOOP_ACTION_LABELS = { pause: '暂停', resume: '恢复', cancel: '取消' };

function printRootHelp() {
  console.log('AI 开发工作台 CLI');
  console.log('');
  console.log('用法：node bin/workbench.js <命令> [选项]');
  console.log('');
  console.log('原有命令：');
  console.log('  serve [--host 127.0.0.1] [--port 4477]              启动 Web 工作台（默认命令）');
  console.log('  agents                                              查看 Agent 可用性 / 审计提供方');
  console.log('  status                                              预算、项目、最近运行');
  console.log('  project add --name 名称 --repo 路径或URL [--test "npm test"] [--protect "tests/**"] [--agent dsh]');
  console.log('  run --project <id|名称> --goal "..." [--acceptance "a,b"] [--mode plan|single] [--tasks tasks.json]');
  console.log('  resume <runId> [--retry-failed]                     恢复运行并跟踪进度');
  console.log('  accept <runId>                                      人工验收（不会合并主分支）');
  console.log('  events <runId>                                      查看运行事件');
  console.log('');
  console.log('研发循环命令：');
  console.log('  loop list|status|pause|resume|cancel ...            通过 HTTP API 查看/控制研发循环');
  console.log('  help                                                显示本帮助');
  console.log('');
  console.log('提示：loop 子命令需要工作台服务已启动，用法见 `node bin/workbench.js loop --help`。');
}

function printLoopHelp() {
  console.log('研发循环（loop）子命令');
  console.log('');
  console.log('通过工作台 HTTP API（/api/loops 系列）查看与控制持续研发循环，');
  console.log('认证沿用 data/api-token（CLI 自动读取；服务需先启动：npm start 或 node bin/workbench.js serve）。');
  console.log('');
  console.log('用法：');
  console.log('  node bin/workbench.js loop list [--project <项目ID>] [--json]');
  console.log('  node bin/workbench.js loop status <loopId> [--json]');
  console.log('  node bin/workbench.js loop pause  <loopId> [--reason "说明"] [--json]');
  console.log('  node bin/workbench.js loop resume <loopId> [--retry-current] [--json]');
  console.log('  node bin/workbench.js loop cancel <loopId> [--reason "说明"] [--json]');
  console.log('');
  console.log('子命令：');
  console.log('  list     列出研发循环（可按项目过滤），显示状态、轮次、当前运行与停止原因');
  console.log('  status   查看单个循环的详细状态（轮次进度、当前/最近运行、历史）');
  console.log('  pause    暂停循环（POST /api/loops/<id>/pause）');
  console.log('  resume   恢复循环（POST /api/loops/<id>/resume，可 --retry-current 重试当前运行）');
  console.log('  cancel   取消循环（POST /api/loops/<id>/cancel）');
  console.log('');
  console.log('选项：');
  console.log('  --url <http://host:port>   指定工作台服务地址（默认取配置的 host/port）');
  console.log('  --host <host> --port <port> 覆盖服务主机与端口');
  console.log('  --json                     输出原始 JSON，便于脚本处理');
}

/** 工作台 HTTP API 基地址：--url 优先，否则用配置中的 host/port。 */
function apiBaseUrl() {
  if (args.url) return String(args.url).replace(/\/+$/, '');
  const host = args.host ? String(args.host) : config.server.host;
  const port = args.port ? Number(args.port) : config.server.port;
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostPart}:${port}`;
}

/** 读取 data/api-token（0600）；若未生成则回退到环境变量中的显式 Token。 */
function readApiToken() {
  try {
    const tokenFile = path.join(config.paths.dataDir, 'api-token');
    if (fs.existsSync(tokenFile)) {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      if (token) return token;
    }
  } catch {
    /* ignore */
  }
  return config.security?.apiToken || '';
}

/** 调用工作台 JSON API，返回 data；网络/认证/业务错误统一转成可读错误。 */
async function apiRequest(method, pathname, body) {
  const base = apiBaseUrl();
  const url = `${base}${pathname}`;
  const headers = { Accept: 'application/json' };
  const token = readApiToken();
  if (token) headers['x-workbench-token'] = token;
  const init = { method, headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const detail = err?.cause?.code || err?.code || err?.message || String(err);
    const error = new Error(`无法连接工作台服务 ${base}（${detail}）。请先启动服务：npm start 或 node bin/workbench.js serve`);
    error.code = 'API_UNREACHABLE';
    throw error;
  }
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok || !payload || payload.ok === false) {
    const info = payload?.error || {};
    const hint = res.status === 401 ? '（请确认工作台服务已启动，data/api-token 为最新 Token）' : '';
    const error = new Error(`工作台 API 返回 ${res.status}${info.code ? ` ${info.code}` : ''}：${info.message || text.slice(0, 200) || res.statusText}${hint}`);
    error.code = info.code || `HTTP_${res.status}`;
    throw error;
  }
  return payload.data;
}

function truncateText(value, max = 40) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function printLoopTable(list) {
  console.table(
    list.map((loop) => ({
      id: loop.id,
      project: loop.project?.name || loop.project_id || '—',
      status: loop.status || 'unknown',
      round: `${loop.round ?? 0}/${loop.max_rounds ?? loop.progress?.maxRounds ?? '—'}`,
      currentRun: loop.current_run_id || '—',
      lastRun: loop.last_run_id || '—',
      goal: truncateText(loop.goal),
      stopReason: truncateText(loop.stop_reason, 30),
    })),
  );
}

function printLoopDetail(loop) {
  const maxRounds = loop.max_rounds ?? loop.progress?.maxRounds ?? '—';
  const percent = loop.progress?.percent;
  const history = Array.isArray(loop.history_json) ? loop.history_json : Array.isArray(loop.history) ? loop.history : [];
  console.log(`循环 ID：${loop.id}`);
  console.log(`项目：${loop.project?.name || '—'}${loop.project?.id ? `（${loop.project.id}）` : loop.project_id ? `（${loop.project_id}）` : ''}`);
  console.log(`目标：${loop.goal || '—'}`);
  console.log(`模式：${loop.mode || '—'}`);
  console.log(`状态：${loop.status || 'unknown'}`);
  console.log(`轮次：${loop.round ?? 0}/${maxRounds}${Number.isFinite(percent) ? `（${percent}%）` : ''}`);
  console.log(`当前运行：${loop.current_run_id || '—'}`);
  console.log(`最近运行：${loop.last_run_id || '—'}`);
  console.log(`停止原因：${loop.stop_reason || '—'}`);
  if (!history.length) {
    console.log('历史：暂无');
    return;
  }
  console.log(`历史（最近 ${Math.min(history.length, 10)} 条，共 ${history.length} 条）：`);
  for (const item of history.slice(-10)) {
    const task = item?.task?.title || item?.task?.description || '';
    const commit = item?.commit ? ` commit ${String(item.commit).slice(0, 8)}` : '';
    const run = item?.runId ? ` run ${item.runId}` : '';
    console.log(` - 第 ${item?.round ?? '?'} 轮 [${item?.status || 'unknown'}] ${truncateText(task, 50)}${commit}${run}`);
  }
}

/** `loop` 子命令组：全部通过 HTTP API 访问，不直接读写本地数据库。 */
async function runLoopCommand() {
  const sub = args._[1] || '';
  if (!sub || sub === 'help' || wantsHelp) {
    printLoopHelp();
    return;
  }
  if (!['list', 'status', 'pause', 'resume', 'cancel'].includes(sub)) {
    throw new Error(`未知 loop 子命令：${sub}\n可用：list | status | pause | resume | cancel（用法见 loop --help）`);
  }

  if (sub === 'list') {
    const projectId = args.project ? String(args.project) : '';
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const data = await apiRequest('GET', `/api/loops${query}`);
    const list = Array.isArray(data) ? data : [];
    if (args.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (!list.length) {
      console.log(`暂无研发循环${projectId ? `（项目 ${projectId}）` : ''}`);
      return;
    }
    console.log(`共 ${list.length} 个研发循环${projectId ? `（项目 ${projectId}）` : ''}：`);
    printLoopTable(list);
    return;
  }

  const loopId = args._[2];
  if (!loopId) throw new Error(`用法：workbench loop ${sub} <loopId>（用法见 loop --help）`);

  if (sub === 'status') {
    const loop = await apiRequest('GET', `/api/loops/${encodeURIComponent(loopId)}`);
    if (!loop) throw new Error(`循环不存在：${loopId}`);
    if (args.json) {
      console.log(JSON.stringify(loop, null, 2));
      return;
    }
    printLoopDetail(loop);
    return;
  }

  // 写操作：pause / resume / cancel
  const body = {};
  if (sub === 'pause' || sub === 'cancel') body.reason = args.reason ? String(args.reason) : undefined;
  if (sub === 'resume') body.retryCurrent = !!(args['retry-current'] || args['retry-failed']);
  const loop = await apiRequest('POST', `/api/loops/${encodeURIComponent(loopId)}/${sub}`, body);
  if (args.json) {
    console.log(JSON.stringify(loop, null, 2));
    return;
  }
  console.log(`循环 ${loop?.id || loopId} 已${LOOP_ACTION_LABELS[sub]}：${loop?.status || 'unknown'}`);
  if (loop?.stop_reason) console.log(`说明：${loop.stop_reason}`);
  if (loop?.current_run_id) console.log(`当前运行：${loop.current_run_id}`);
}

/** `isolation` 子命令：通过 HTTP API 展示执行隔离与容器能力。 */
async function runIsolationCommand() {
  if (wantsHelp) {
    console.log([
      '用法：workbench isolation [--json] [--url http://127.0.0.1:4477]',
      '',
      '展示当前执行隔离能力：内核隔离（docker/sandbox-exec/BLOCKED）、受限运行环境、',
      'Docker 容器测试/Claude Agent 可用性与镜像状态。只读，不改变任何运行。',
    ].join('\n'));
    return;
  }
  const info = await apiRequest('GET', '/api/isolation');
  if (args.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  const container = info.container || {};
  console.log(`内核隔离：${info.kernelIsolation || 'unknown'}${info.kernelAvailable ? '（可用）' : '（不可用）'}`);
  console.log(`受限运行环境：${info.restrictedRuntime?.available ? '可用（无内核级强隔离）' : '不可用'}`);
  console.log(`Docker：${container.docker?.available ? `可用（${container.docker.version || ''}）` : '不可用'}`);
  console.log(`运行时镜像：${container.image?.name || '—'} ${container.image?.available ? '已就绪' : '缺失'}`);
  console.log(`容器测试执行：${container.testExecution ? '可用' : 'BLOCKED'}；容器 Agent：${container.agentExecution ? '可用（Claude）' : 'BLOCKED'}`);
  console.log(`网络：测试=${container.network?.test || '—'}；Agent=${container.network?.agent || '—'}`);
  if (container.note) console.log(`说明：${container.note}`);
}

async function main() {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printRootHelp();
    return;
  }

  if (cmd === 'loop') {
    await runLoopCommand();
    return;
  }

  if (cmd === 'isolation') {
    await runIsolationCommand();
    return;
  }

  if (cmd === 'serve') {
    process.env.WORKBENCH_SERVING = '1';
    const serveConfig = {
      ...config,
      server: {
        host: args.host ? String(args.host) : config.server.host,
        port: args.port ? Number(args.port) : config.server.port,
      },
    };
    const orphanContainers = await cleanupOrphanContainers({ config: serveConfig, store, log: console.log });
    if (orphanContainers.removed.length) console.log(`[recover] 已清理 ${orphanContainers.removed.length} 个 Workbench 孤儿容器`);
    if (orphanContainers.skipped.length) console.log(`[recover] ${orphanContainers.skipped.length} 个容器仍由有效执行者持有，已保留`);
    if (orphanContainers.failed?.length) {
      console.error(`[recover] BLOCKED：${orphanContainers.failed.length} 个容器无法确认已退出；拒绝启动 Workbench/新 Agent：${JSON.stringify(orphanContainers.failed.slice(0, 5))}`);
      store.close();
      process.exitCode = 1;
      return;
    }
    if (orphanContainers.error) {
      console.error(`[recover] BLOCKED：容器状态探测失败，拒绝启动 Workbench/新 Agent：${orphanContainers.error}`);
      store.close();
      process.exitCode = 1;
      return;
    }
    const checkpointPublish = orchestrator.recoverCheckpointPublications();
    if (checkpointPublish.recovered.length) console.log(`[recover] 已恢复 ${checkpointPublish.recovered.length} 个未完成 Checkpoint 发布`);
    // 已验证完成且清理 journal 的发布，才解除其所属 Run 的 checkpoint 暂停；Task 仍保留原 attempt/session。
    const recoveredTargets = new Set(checkpointPublish.recovered.filter((r) => ['completed-publish', 'completed-index-after-rename'].includes(r.result)).map((r) => r.target));
    if (recoveredTargets.size) {
      for (const task of store.listTasks({})) {
        if (!task.worktree_path || !recoveredTargets.has(task.worktree_path)) continue;
        const run = task.run_id ? store.getRun(task.run_id) : null;
        if (run && (run.result_json?.checkpointBlocked || run.pause_kind === 'checkpoint_blocked')) {
          const { checkpointBlocked, checkpointBlockedTarget, checkpointPrevPauseKind, checkpointPrevStopReason, ...rest } = run.result_json || {};
          if (checkpointPrevPauseKind) {
            // 原有预算/人工暂停不能被 Checkpoint 恢复覆盖。
            store.updateRun(run.id, { status: 'paused', pause_kind: checkpointPrevPauseKind, stop_reason: checkpointPrevStopReason || run.stop_reason, result_json: { ...rest, checkpointResolvedAt: new Date().toISOString() } });
          } else {
            store.updateRun(run.id, { status: 'paused', pause_kind: '', stop_reason: 'Checkpoint 发布已对账，等待普通 resume', result_json: { ...rest, checkpointResolvedAt: new Date().toISOString() } });
            // 恢复原任务到可调度阶段，attempt/session/worktree 保持不变。
            if (task.worktree_path && fs.existsSync(task.worktree_path)) store.updateTask(task.id, { status: 'queued', blocked_reason: '' });
          }
        }
      }
    }
    if (checkpointPublish.blocked.length) {
      // 保持服务可启动以便读取/人工恢复；但不得清理恢复材料，也不得把发布视为成功。
      console.error(`[recover] BLOCKED：${checkpointPublish.blocked.length} 个 Checkpoint 发布状态无法对账，保留备份与 journal：${JSON.stringify(checkpointPublish.blocked.slice(0, 5))}`);
      // 把阻断持久化到所属 Task/Run，阻止自动 Supervisor 或手工 resume 重新派发。
      const blockedTargets = new Set();
      for (const b of checkpointPublish.blocked) {
        try { const j = JSON.parse(fs.readFileSync(b.file, 'utf8')); if (j.target) blockedTargets.add(j.target); } catch { /* journal already logged */ }
      }
      for (const task of store.listTasks({})) {
        if (!task.worktree_path || !blockedTargets.has(task.worktree_path)) continue;
        store.updateTask(task.id, {
          status: 'blocked',
          blocked_reason: `CHECKPOINT_BLOCKED：发布状态未对账，保留工作树/备份/journal，禁止重新派发（${task.worktree_path}）`,
        });
        const run = task.run_id ? store.getRun(task.run_id) : null;
        if (run) {
          store.updateRun(run.id, {
            status: 'paused', pause_kind: 'checkpoint_blocked',
            stop_reason: `Checkpoint 发布未对账，所属任务 ${task.id} 已阻断`,
            result_json: { ...(run.result_json || {}), checkpointBlocked: true, checkpointBlockedTarget: task.worktree_path, checkpointPrevPauseKind: run.pause_kind || '', checkpointPrevStopReason: run.stop_reason || '' },
          });
        }
      }
    }
    const recovered = orchestrator.recoverOrphans();
    const recoveredLoops = loops.recover();
    if (recoveredLoops.recovered?.length) console.log(`[recover] ${recoveredLoops.recovered.length} 个研发循环已标记中断`);
    if (recoveredLoops.skipped?.length) console.log(`[recover] ${recoveredLoops.skipped.length} 个研发循环由其他活 Workbench 持有，已跳过`);
    if (recovered.recoveredRuns.length) console.log(`[recover] ${recovered.recoveredRuns.length} 个中断运行已标记`);
    // 自动恢复 supervised 项目的运行/循环，不需要人工点击 resume。
    try {
      const autoRuns = await orchestrator.recoverSupervisedRuns();
      const resumedRuns = autoRuns.filter((x) => x.resumed).length;
      if (resumedRuns) console.log(`[recover] ${resumedRuns} 个 supervised 运行已自动续跑`);
      const interruptedLoops = store.listLoops({ status: 'interrupted' });
      const pausedInfraLoops = store.listLoops({ status: 'paused' }).filter((lp) => /Docker|docker|镜像|隔离|基础设施|infrastructure/i.test(String(lp.stop_reason || '')));
      let loopResumed = 0;
      for (const lp of [...interruptedLoops, ...pausedInfraLoops]) {
        const pj = store.getProject(lp.project_id);
        if (!pj?.config_json?.supervisor_managed) continue;
        try { await loops.resume(lp.id, { retryCurrent: true }); loopResumed += 1; } catch (err) { console.log(`[recover] 循环 ${lp.id} 自动恢复失败：${err.message}`); }
      }
      if (loopResumed) console.log(`[recover] ${loopResumed} 个 supervised 循环已自动续跑`);
    } catch (err) { console.log(`[recover] supervised 自动恢复跳过：${err.message}`); }
    const server = await startServer({ config: serveConfig, store, orchestrator, loops });
    const shutdown = () => {
      console.log('\n正在关闭工作台…');
      server.close(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 3000).unref?.();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'agents') {
    const agents = await checkAllAgents(config);
    console.table(agents.map((a) => ({ id: a.id, label: a.label, ok: a.ok, detail: a.detail })));
    console.log('独立审计：', JSON.stringify(auditProviderStatus(config), null, 2));
    return;
  }

  if (cmd === 'status') {
    const state = await orchestrator.state();
    console.log(`预算：tokens ${formatTokens(state.budget.usedTokens)}/${formatTokens(state.budget.maxTokens)}，成本 ${formatCny(state.budget.usedCostCny)}/${formatCny(state.budget.maxCostCny)}`);
    console.log(`审计：${state.audit.active?.label || '不可用'}（${state.audit.note}）`);
    console.table(state.projects.map((p) => ({ id: p.id, name: p.name, branch: p.default_branch, test: p.test_command, latestRun: p.latestRun?.status || '—' })));
    return;
  }

  if (cmd === 'project' && args._[1] === 'add') {
    const project = await orchestrator.createProject({
      name: args.name,
      repo: args.repo,
      testCommand: args.test,
      protectedPaths: args.protect ? String(args.protect).split(',').map((s) => s.trim()) : [],
      protectTests: !!args['protect-tests'],
      agentKind: args.agent || 'auto',
      auditProvider: args.audit || 'auto',
    });
    console.log(JSON.stringify(project, null, 2));
    return;
  }

  if (cmd === 'run') {
    let project = store.getProject(args.project);
    if (!project) {
      project = store.listProjects().find((p) => p.name === args.project || p.id === args.project);
    }
    if (!project) throw new Error(`找不到项目：${args.project}`);
    let tasks = undefined;
    if (args.tasks) tasks = JSON.parse(fs.readFileSync(args.tasks, 'utf8'));
    const acceptance = args.acceptance ? String(args.acceptance).split(',').map((s) => s.trim()) : [];
    const { runId } = await orchestrator.startRun({
      projectId: project.id,
      goal: args.goal,
      acceptance,
      mode: args.mode || 'single',
      tasks,
    });
    console.log(`运行已创建：${runId}`);
    await watchRun(runId);
    return;
  }

  if (cmd === 'resume') {
    const runId = args._[1];
    if (!runId) throw new Error('用法：workbench resume <runId>');
    await orchestrator.resumeRun(runId, { retryFailed: !!args['retry-failed'] });
    await watchRun(runId);
    return;
  }

  if (cmd === 'accept') {
    const runId = args._[1];
    if (!runId) throw new Error('用法：workbench accept <runId>');
    const run = orchestrator.acceptRun(runId);
    console.log(`已验收：${run.id}（工作台未合并主分支）`);
    return;
  }

  if (cmd === 'events') {
    const runId = args._[1];
    const events = store.listEvents({ runId, limit: 500 });
    for (const e of events) console.log(`[${e.created_at}] ${e.type} ${e.message}`);
    return;
  }

  console.log(`未知命令：${cmd}\n可用命令：serve | agents | status | project add | run | resume | accept | events | loop | help`);
}

async function watchRun(runId) {
  let lastEvent = 0;
  let lastStatus = '';
  for (;;) {
    const run = store.getRun(runId);
    if (!run) break;
    if (run.status !== lastStatus) {
      console.log(`\n[${run.status}] ${run.goal}${run.stop_reason ? `（${run.stop_reason}）` : ''}`);
      lastStatus = run.status;
    }
    const events = store.listEvents({ runId, after: lastEvent, limit: 100 });
    for (const e of events) {
      lastEvent = Math.max(lastEvent, e.id);
      console.log(` - ${e.type}: ${e.message}`);
    }
    if (['awaiting_acceptance', 'accepted', 'failed', 'cancelled'].includes(run.status)) {
      const detail = orchestrator.runDetail(runId);
      console.log('\n===== 运行结果 =====');
      for (const task of detail?.tasks || []) {
        console.log(`#${task.seq} ${task.title} -> ${task.status}${task.head_commit ? ` (${task.head_commit.slice(0, 8)})` : ''}`);
      }
      if (run.status === 'awaiting_acceptance') console.log(`请在可视化界体验收：http://${config.server.host}:${config.server.port}`);
      break;
    }
    if (run.status === 'paused') {
      console.log(`运行已暂停：${run.stop_reason}`);
      console.log(`可执行：workbench resume ${runId} --retry-failed`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

main()
  .then(() => {
    if (cmd !== 'serve') {
      store.close();
      process.exit(0);
    }
  })
  .catch((err) => {
    console.error(`错误：${err?.message || err}`);
    store.close();
    process.exit(1);
  });
