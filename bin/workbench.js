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
 */
import fs from 'node:fs';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { startServer } from '../src/server.js';
import { checkAllAgents } from '../src/agents/index.js';
import { auditProviderStatus } from '../src/auditors/index.js';
import { formatCny, formatTokens } from '../src/pricing.js';

const config = getConfig();
const store = openStore(config.paths.dbPath);
const bus = new EventBus();
const orchestrator = new Orchestrator({ config, store, bus });

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
const cmd = args._[0] || 'serve';

async function main() {
  if (cmd === 'serve') {
    process.env.WORKBENCH_SERVING = '1';
    const serveConfig = {
      ...config,
      server: {
        host: args.host ? String(args.host) : config.server.host,
        port: args.port ? Number(args.port) : config.server.port,
      },
    };
    const recovered = orchestrator.recoverOrphans();
    if (recovered.recoveredRuns.length) console.log(`[recover] ${recovered.recoveredRuns.length} 个中断运行已标记，可在界面恢复`);
    const server = await startServer({ config: serveConfig, store, orchestrator });
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

  console.log(`未知命令：${cmd}\n可用命令：serve | agents | status | project add | run | resume | accept | events`);
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
