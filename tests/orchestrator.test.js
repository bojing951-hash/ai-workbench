// SPDX-License-Identifier: Apache-2.0
/**
 * 编排器集成测试：真实临时 git 仓库 + 真实 SQLite + 依赖注入的假 Agent / 假审计器。
 *
 * 离线承诺：
 *  - 全部 config 的 LLM Key / GITHUB_TOKEN 置空，agents bin 指向不存在路径；
 *  - deps.runAgent / deps.runAudit / deps.chooseAgent / deps.checkAgents 全部注入假实现；
 *  - 测试命令为当前 Node 可执行文件的真实进程（`<node> -e "process.exit(0)"`）；
 *  - 所有文件写入 os.tmpdir() 下的临时目录，after 时清理，不触碰真实 data/ projects/。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

const NODE_BIN = process.execPath;
const TEST_COMMAND = `"${NODE_BIN}" -e "process.exit(0)"`;
const PROTECTED_TEST_REL = 'tests/protected.test.js';
const PROTECTED_TEST_CONTENT = "// 受保护测试：Agent 不得修改\nimport assert from 'node:assert/strict';\nassert.equal(1 + 1, 2);\n";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（避免固定 sleep 造成的慢/抖动）。 */
async function waitFor(check, { label = 'condition', timeoutMs = 60_000, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待超时（${label}），${timeoutMs}ms 内条件未满足`);
    }
    await sleep(intervalMs);
  }
}

/** 等待 run 进入指定状态之一。 */
function waitRunStatus(store, runId, statuses, opts = {}) {
  const wanted = Array.isArray(statuses) ? statuses : [statuses];
  return waitFor(
    () => {
      const run = store.getRun(runId);
      return run && wanted.includes(run.status) ? run : null;
    },
    { label: `run ${runId} -> ${wanted.join('|')}`, ...opts },
  );
}

function waitIdle(orchestrator, timeoutMs = 20_000) {
  return waitFor(() => orchestrator.running.size === 0, { label: '编排器空闲退出', timeoutMs });
}

/** 同步执行 git 命令（测试夹具准备与断言用）。 */
function runGit(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (code=${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function runGitRevParse(cwd, ref) {
  return runGit(cwd, ['rev-parse', '--verify', ref]).trim();
}

/** 创建临时 git 仓库（含 package.json、受保护测试、实现文件），并提交基线。 */
function createFixtureRepo(root) {
  const repo = path.join(root, 'fixture-repo');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: `${NODE_BIN} -e "process.exit(0)"` } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repo, PROTECTED_TEST_REL), PROTECTED_TEST_CONTENT);
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'export const version = 0;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');

  runGit(repo, ['init', '-q', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'Workbench Test']);
  runGit(repo, ['config', 'user.email', 'workbench-test@localhost']);
  runGit(repo, ['config', 'commit.gpgsign', 'false']);
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-qm', 'chore: baseline']);
  return { repo, baselineCommit: runGitRevParse(repo, 'HEAD') };
}

/** 返回一个可在稍后 resolve 的 Promise。 */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function agentOk(overrides = {}) {
  return {
    ok: true,
    text: 'done',
    error: '',
    agentKind: 'dsh',
    sessionId: 's1',
    exitCode: 0,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    costCny: 0.001,
    durationMs: 10,
    logPath: '',
    ...overrides,
  };
}

function auditFail(task) {
  return {
    provider: 'fake',
    providerLabel: 'Fake Auditor',
    model: 'fake-audit-v1',
    verdict: 'fail',
    score: 40,
    criteria: (task.acceptance_json || []).map((c) => ({ criterion: c, status: 'fail', evidence: '实现缺失' })),
    findings: [],
    requiredFixes: ['补齐 src/index.js 的导出实现', '补充 README 说明'],
    summary: '未通过：实现缺失',
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
    costCny: 0.0005,
    rawText: '{"verdict":"fail"}',
  };
}

function auditPass(task) {
  return {
    provider: 'fake',
    providerLabel: 'Fake Auditor',
    model: 'fake-audit-v1',
    verdict: 'pass',
    score: 100,
    criteria: (task.acceptance_json || []).map((c) => ({ criterion: c, status: 'pass', evidence: 'src/index.js 已实现' })),
    findings: [],
    requiredFixes: [],
    summary: '通过',
    usage: { input: 800, output: 80, cacheRead: 0, cacheWrite: 0 },
    costCny: 0.0004,
    rawText: '{"verdict":"pass"}',
  };
}

/** 组装注入依赖；未提供的回调在被意外调用时立即失败（防止测试偷偷联网/调用真实 Agent）。 */
function makeDeps({ runAgent, runAudit, chooseAgent } = {}) {
  return {
    runAgent: runAgent || (async () => {
      throw new Error('runAgent 不应被调用');
    }),
    runAudit: runAudit || (async () => {
      throw new Error('runAudit 不应被调用');
    }),
    chooseAgent: chooseAgent || (async () => 'dsh'),
    checkAgents: async () => [
      { id: 'dsh', label: 'DeepSeek Harness', ok: true, detail: 'fake (test)', capabilities: {} },
    ],
  };
}

function writeInWorktree(cwd, relPath, content) {
  const file = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function runEvents(store, runId) {
  return store.listEvents({ runId, limit: 500 });
}

function eventTypes(store, runId) {
  return runEvents(store, runId).map((e) => e.type);
}

function eventsOfType(store, runId, type) {
  return runEvents(store, runId).filter((e) => e.type === type);
}

/**
 * 搭建一套隔离的编排器测试环境：
 * 临时 config（data/projects/worktrees/... 全部指向 tmp）+ 临时 SQLite + EventBus +
 * 真实临时 git 仓库 + 通过 orchestrator.createProject 注册的项目。
 */
async function createHarness({ deps = {}, budget = {}, projectInput = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-orchestrator-'));
  const dataDir = path.join(root, 'data');
  const config = getConfig({
    root,
    paths: {
      root,
      dataDir,
      dbPath: path.join(dataDir, 'workbench.db'),
      projectsDir: path.join(root, 'projects'),
      worktreesDir: path.join(dataDir, 'worktrees'),
      artifactsDir: path.join(dataDir, 'artifacts'),
      logsDir: path.join(dataDir, 'logs'),
      agentsDir: path.join(dataDir, 'agents'),
      dshHome: path.join(dataDir, 'agents', 'dsh-home'),
      claudeHome: path.join(dataDir, 'agents', 'claude-home'),
    },
    secrets: [],
    budget: {
      maxTotalTokens: 1_000_000,
      maxCostCny: 50,
      maxTokensPerTask: 600_000,
      maxAttempts: 2,
      maxAgentConcurrency: 1,
      minReserveTokens: 20_000,
      ...budget,
    },
    agents: {
      default: 'auto',
      dsh: { bin: '/nonexistent/wb-test-bin/dsh', timeoutMs: 30_000 },
      claude: { bin: '/nonexistent/wb-test-bin/claude', timeoutMs: 30_000 },
    },
    llm: {
      openai: { apiKey: '' },
      glm: { apiKey: '' },
      deepseek: { apiKey: '' },
    },
    github: { token: '', owner: '', createPr: false, push: false, autoCreateRepo: false },
    audit: { provider: 'auto', timeoutMs: 30_000 },
    policy: { protectedPaths: ['acceptance/**', '.github/**'], testTimeoutMs: 60_000, ciPollAttempts: 1, ciPollIntervalMs: 10 },
  });
  for (const dir of [
    config.paths.dataDir,
    config.paths.projectsDir,
    config.paths.worktreesDir,
    config.paths.artifactsDir,
    config.paths.logsDir,
    config.paths.agentsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const store = openStore(config.paths.dbPath);
  const bus = new EventBus();
  const liveEvents = [];
  bus.subscribe((event) => liveEvents.push(event));
  const orchestrator = new Orchestrator({ config, store, bus, deps });

  const fixture = createFixtureRepo(root);
  const project = await orchestrator.createProject({
    name: 'orchestrator-fixture',
    repo: fixture.repo,
    defaultBranch: 'main',
    testCommand: TEST_COMMAND,
    protectTests: true,
    ...projectInput,
  });

  return {
    root,
    config,
    store,
    bus,
    liveEvents,
    orchestrator,
    repoDir: fixture.repo,
    baselineCommit: fixture.baselineCommit,
    project,
    async cleanup() {
      try {
        for (const runId of [...orchestrator.running]) {
          try {
            orchestrator.controllers.get(runId)?.abort();
          } catch {
            /* ignore */
          }
        }
        await waitIdle(orchestrator, 10_000).catch(() => {});
      } finally {
        try {
          store.close();
        } catch {
          /* ignore */
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

// ============================================================================
// 场景 A：完整单任务流水线（编码 -> 测试 -> 审计 fail -> 反馈 -> 修复 -> 审计 pass）
// ============================================================================
test('场景A：单任务完整流水线，审计先 fail 后 pass，第二轮 Agent 收到上一轮反馈', { timeout: 120_000 }, async () => {
  const agentCalls = [];
  let auditCalls = 0;
  const deps = makeDeps({
    runAgent: async (agentId, ctx) => {
      agentCalls.push({ agentId, prompt: ctx.prompt, sessionId: ctx.sessionId, cwd: ctx.cwd });
      writeInWorktree(
        ctx.cwd,
        'src/index.js',
        `export const version = ${agentCalls.length};\nexport function hello() {\n  return 'hello';\n}\n`,
      );
      return agentOk({ sessionId: `s${agentCalls.length}` });
    },
    runAudit: async ({ task }) => {
      auditCalls += 1;
      return auditCalls === 1 ? auditFail(task) : auditPass(task);
    },
  });

  const h = await createHarness({ deps });
  try {
    const started = await h.orchestrator.startRun({
      projectId: h.project.id,
      goal: '实现 hello 函数并导出',
      acceptance: ['src/index.js 导出 hello 函数'],
      mode: 'single',
    });
    assert.ok(started.runId);
    assert.ok(started.planId);
    assert.equal(started.tasks, 1);

    const run = await waitRunStatus(h.store, started.runId, 'awaiting_acceptance', { timeoutMs: 90_000 });
    await waitIdle(h.orchestrator);

    // ---- run 终态 ----
    assert.equal(run.status, 'awaiting_acceptance');
    assert.ok(run.ended_at);
    assert.equal(run.result_json.taskCount, 1);
    const planBranch = `wb/plan-${started.runId.slice(-6)}`;
    assert.equal(run.result_json.planBranch, planBranch);
    assert.equal(run.result_json.publish.localOnly, true);
    assert.ok(run.result_json.publish.blocked.some((r) => r.includes('GITHUB_TOKEN')));

    // ---- 任务 passed / head_commit / 分支 ----
    const tasks = h.store.listTasks({ runId: started.runId });
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.status, 'passed');
    assert.match(task.head_commit, /^[0-9a-f]{40}$/);
    assert.match(task.branch, /^wb\/r[0-9a-z]+\/t1$/);
    assert.equal(run.result_json.planHead, task.head_commit);
    // 计划分支真实存在且指向任务提交
    assert.equal(runGitRevParse(h.repoDir, `refs/heads/${planBranch}`), task.head_commit);
    // 主分支未被推进（工作台永不合并主分支）
    assert.equal(runGitRevParse(h.repoDir, 'refs/heads/main'), h.baselineCommit);

    // ---- 独立审计 2 条：fail -> pass ----
    const audits = h.store.listAudits(task.id);
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map((a) => a.verdict), ['fail', 'pass']);
    assert.equal(auditCalls, 2);
    assert.deepEqual(audits[0].required_fixes_json, ['补齐 src/index.js 的导出实现', '补充 README 说明']);

    // ---- 修复闭环：第二轮 Agent 的 prompt 必须包含上一轮审计反馈 ----
    assert.equal(agentCalls.length, 2);
    const secondPrompt = agentCalls[1].prompt;
    assert.match(secondPrompt, /上一轮失败反馈/);
    assert.match(secondPrompt, /独立审计未通过/);
    assert.match(secondPrompt, /补齐 src\/index\.js 的导出实现/);
    assert.match(secondPrompt, /补充 README 说明/);
    assert.match(secondPrompt, /第 2\/2 轮尝试/);
    // session 复用：第二轮沿用第一轮 sessionId
    assert.equal(agentCalls[0].sessionId, '');
    assert.equal(agentCalls[1].sessionId, 's1');
    assert.equal(task.session_id, 's2');

    // ---- 预算 usage 累加（2 次编码 150x2 + 2 次审计 1100+880）----
    assert.equal(Number(run.spent_json.tokens), 2280);
    assert.ok(Math.abs(Number(run.spent_json.costCny) - (0.001 * 2 + 0.0005 + 0.0004)) < 1e-9);
    assert.equal(h.store.usageTotals().tokens, 2280);

    // ---- 事件流包含关键节点 ----
    const types = eventTypes(h.store, started.runId);
    for (const expected of [
      'run_created',
      'run_started',
      'task_started',
      'worktree_ready',
      'agent_started',
      'agent_finished',
      'test_passed',
      'audit_failed',
      'repair_requested',
      'audit_passed',
      'task_passed',
      'run_awaiting_acceptance',
      'publish_blocked',
    ]) {
      assert.ok(types.includes(expected), `缺少事件：${expected}`);
    }
    const repairEvent = eventsOfType(h.store, started.runId, 'repair_requested');
    assert.equal(repairEvent.length, 1);
    assert.deepEqual(repairEvent[0].data_json.requiredFixes, ['补齐 src/index.js 的导出实现', '补充 README 说明']);

    // ---- 产物落盘 ----
    const artifactKinds = h.store.listArtifacts(task.id).map((a) => a.kind);
    for (const kind of ['prompt', 'diff', 'test', 'audit', 'commit']) {
      assert.ok(artifactKinds.includes(kind), `缺少产物：${kind}`);
    }
    const promptArtifacts = h.store.listArtifacts(task.id).filter((a) => a.kind === 'prompt');
    assert.equal(promptArtifacts.length, 2);

    // ---- 查询接口 ----
    const detail = h.orchestrator.runDetail(started.runId);
    assert.equal(detail.tasks.length, 1);
    assert.equal(detail.tasks[0].audits.length, 2);
    assert.ok(detail.tasks[0].attempts.length >= 2);
    assert.ok(detail.events.length > 0);
    const taskDetail = h.orchestrator.taskDetail(task.id);
    assert.equal(taskDetail.audits.length, 2);
    assert.ok(taskDetail.attempts[0].prompt.includes('hello 函数'));

    // ---- 发布动作：无 GITHUB_TOKEN 时记录为 blocked（不伪造推送/PR）----
    const actions = h.store.listActions(started.runId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'github-publish');
    assert.equal(actions[0].status, 'blocked');
    assert.ok(String(actions[0].result_json.reason || '').includes('GITHUB_TOKEN'));

    // ---- 人工验收：只记录验收，不合并主分支 ----
    const accepted = h.orchestrator.acceptRun(started.runId);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.result_json.merged, false);
    assert.ok(accepted.result_json.acceptedAt);
    assert.ok(eventTypes(h.store, started.runId).includes('run_accepted'));
    // 已结束的运行不允许再 resume
    await assert.rejects(
      () => h.orchestrator.resumeRun(started.runId),
      (err) => err?.code === 'RUN_CLOSED',
    );
    // 主分支仍然只有基线提交
    assert.equal(runGit(h.repoDir, ['log', '--oneline', 'main']).trim().split('\n').length, 1);
  } finally {
    await h.cleanup();
  }
});

// ============================================================================
// 场景 B：Agent 篡改受保护测试文件 -> 违规事件 + 文件还原 + 任务不通过
// ============================================================================
test('场景B：Agent 修改受保护测试文件被拦截、还原，任务最终不通过', { timeout: 120_000 }, async () => {
  let auditCalls = 0;
  const deps = makeDeps({
    runAgent: async (agentId, ctx) => {
      // 模拟 Agent 试图通过删除测试来"通过"
      writeInWorktree(ctx.cwd, PROTECTED_TEST_REL, '// 被 Agent 篡改：删除了原有断言\n');
      return agentOk();
    },
    runAudit: async () => {
      auditCalls += 1;
      throw new Error('保护路径违规时不应进入审计');
    },
  });

  const h = await createHarness({ deps, budget: { maxAttempts: 1 } });
  try {
    const started = await h.orchestrator.startRun({
      projectId: h.project.id,
      goal: '实现任意功能',
      acceptance: ['受保护测试文件保持不变'],
      mode: 'single',
    });
    const run = await waitRunStatus(h.store, started.runId, 'paused', { timeoutMs: 90_000 });
    await waitIdle(h.orchestrator);

    // run 被暂停（不伪造通过）
    assert.equal(run.status, 'paused');
    assert.match(run.stop_reason, /未通过/);

    // 任务 failed，且原因是尝试次数耗尽
    const task = h.store.listTasks({ runId: started.runId })[0];
    assert.equal(task.status, 'failed');
    assert.match(task.blocked_reason, /尝试次数耗尽/);
    assert.equal(task.head_commit, '');

    // 违规事件包含被篡改的保护路径
    const violations = eventsOfType(h.store, started.runId, 'protected_path_violation');
    assert.equal(violations.length, 1);
    assert.deepEqual(violations[0].data_json.violations, [PROTECTED_TEST_REL]);
    assert.match(violations[0].message, /受保护路径/);

    // 测试文件已被还原为基线内容，git 工作区无残留改动
    assert.ok(task.worktree_path, '应保留工作副本用于排查');
    const restored = fs.readFileSync(path.join(task.worktree_path, PROTECTED_TEST_REL), 'utf8');
    assert.equal(restored, PROTECTED_TEST_CONTENT);
    assert.ok(!restored.includes('被 Agent 篡改'));
    const porcelain = runGit(task.worktree_path, ['status', '--porcelain']);
    assert.ok(!porcelain.includes(PROTECTED_TEST_REL), `受保护文件仍有未还原改动：${porcelain}`);

    // 违规后不进入测试/审计，也不产生审计记录
    assert.equal(auditCalls, 0);
    assert.equal(h.store.listAudits(task.id).length, 0);
    assert.equal(eventTypes(h.store, started.runId).includes('audit_started'), false);

    // 计划分支停留在基线，主分支未变
    const planBranch = `wb/plan-${started.runId.slice(-6)}`;
    assert.equal(runGitRevParse(h.repoDir, `refs/heads/${planBranch}`), h.baselineCommit);
    assert.equal(runGitRevParse(h.repoDir, 'refs/heads/main'), h.baselineCommit);
  } finally {
    await h.cleanup();
  }
});

// ============================================================================
// 场景 C：断点恢复（pause -> resume），计划分支保留、任务重新排队并最终 passed
// ============================================================================
test('场景C：暂停后恢复运行，任务重新排队、计划分支保留并最终通过', { timeout: 120_000 }, async () => {
  const startedAgent = deferred();
  const agentCalls = [];
  let phase = 'block';
  const deps = makeDeps({
    runAgent: async (agentId, ctx) => {
      agentCalls.push({ phase, prompt: ctx.prompt });
      if (phase === 'block') {
        startedAgent.resolve();
        // 等待暂停（abort）后返回失败，让编排器进入 paused 断点
        await new Promise((resolve) => {
          if (ctx.signal?.aborted) return resolve();
          ctx.signal?.addEventListener('abort', resolve, { once: true });
        });
        return agentOk({
          ok: false,
          error: '测试：Agent 被暂停中止',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          costCny: 0,
          durationMs: 1,
        });
      }
      writeInWorktree(ctx.cwd, 'src/index.js', 'export const resumed = true;\nexport function hello() { return 1; }\n');
      return agentOk({ sessionId: 's-resume' });
    },
    runAudit: async ({ task }) => auditPass(task),
  });

  const h = await createHarness({ deps });
  try {
    const started = await h.orchestrator.startRun({
      projectId: h.project.id,
      goal: '实现可恢复的功能',
      acceptance: ['src/index.js 有实现'],
      mode: 'single',
    });
    const runId = started.runId;
    const planBranch = `wb/plan-${runId.slice(-6)}`;

    // 等 Agent 真正开始执行后再暂停（模拟运行中断点）
    await startedAgent.promise;
    assert.equal(runGitRevParse(h.repoDir, `refs/heads/${planBranch}`), h.baselineCommit);

    h.orchestrator.pauseRun(runId, '测试：人工暂停');
    const paused = await waitRunStatus(h.store, runId, 'paused');
    assert.match(paused.stop_reason, /人工暂停/);
    await waitIdle(h.orchestrator);
    assert.ok(eventTypes(h.store, runId).includes('run_paused'));

    // 断点：任务处于中间态（未失败），计划分支保留
    const taskAtBreak = h.store.listTasks({ runId })[0];
    assert.ok(
      ['preparing', 'coding', 'testing', 'auditing', 'repairing', 'committing'].includes(taskAtBreak.status),
      `断点任务状态异常：${taskAtBreak.status}`,
    );
    assert.equal(runGitRevParse(h.repoDir, `refs/heads/${planBranch}`), h.baselineCommit);

    // 恢复运行：中间态任务重新排队，计划分支保留
    phase = 'resume';
    const resumed = await h.orchestrator.resumeRun(runId);
    assert.equal(resumed.status, 'running');

    const done = await waitRunStatus(h.store, runId, 'awaiting_acceptance', { timeoutMs: 90_000 });
    await waitIdle(h.orchestrator);
    assert.equal(done.status, 'awaiting_acceptance');

    const task = h.store.listTasks({ runId })[0];
    assert.equal(task.status, 'passed');
    assert.match(task.head_commit, /^[0-9a-f]{40}$/);
    // 计划分支保留并推进到恢复后的提交
    assert.equal(runGitRevParse(h.repoDir, `refs/heads/${planBranch}`), task.head_commit);
    assert.equal(runGitRevParse(h.repoDir, 'refs/heads/main'), h.baselineCommit);

    // 事件：暂停 -> 重新排队 -> 恢复 -> 通过
    const types = eventTypes(h.store, runId);
    for (const expected of ['run_paused', 'task_requeued', 'run_resumed', 'task_passed']) {
      assert.ok(types.includes(expected), `缺少事件：${expected}`);
    }
    // Agent 至少执行 2 次（暂停前 + 恢复后），恢复后成功一次
    assert.ok(agentCalls.length >= 2);
    assert.equal(agentCalls.filter((c) => c.phase === 'resume').length, 1);
  } finally {
    await h.cleanup();
  }
});

// ============================================================================
// 场景 D：预算耗尽 -> run paused，stop_reason 含预算原因
// ============================================================================
test('场景D：预算耗尽时暂停运行并记录预算原因', { timeout: 120_000 }, async () => {
  const deps = makeDeps({
    runAgent: async (agentId, ctx) => {
      writeInWorktree(ctx.cwd, 'src/index.js', 'export const budgeted = true;\n');
      // 单次编码消耗 9000 tokens（仍在单任务校验允许范围内）
      return agentOk({ usage: { input: 9000, output: 0, cacheRead: 0, cacheWrite: 0 }, costCny: 0 });
    },
    runAudit: async ({ task }) => ({
      ...auditPass(task),
      // 审计再累加 6000 tokens，使总用量越过 maxTotalTokens - minReserveTokens
      usage: { input: 6000, output: 0, cacheRead: 0, cacheWrite: 0 },
      costCny: 0,
    }),
  });

  const h = await createHarness({
    deps,
    budget: { maxTotalTokens: 30_000, minReserveTokens: 20_000, maxCostCny: 5 },
  });
  try {
    const started = await h.orchestrator.startRun({
      projectId: h.project.id,
      goal: '预算耗尽测试',
      acceptance: ['实现存在'],
      mode: 'single',
    });
    const run = await waitRunStatus(h.store, started.runId, 'paused', { timeoutMs: 90_000 });
    await waitIdle(h.orchestrator);

    assert.equal(run.status, 'paused');
    assert.match(run.stop_reason, /预算/);
    assert.equal(eventTypes(h.store, started.runId).includes('run_awaiting_acceptance'), false);

    // 预算暂停前任务本身已完成（证明是运行级预算检查触发，而非任务失败）
    const task = h.store.listTasks({ runId: started.runId })[0];
    assert.equal(task.status, 'passed');
    assert.ok(h.store.usageTotals().tokens >= 15_000);

    const pausedEvents = eventsOfType(h.store, started.runId, 'run_paused');
    assert.ok(pausedEvents.some((e) => e.data_json?.kind === 'budget'), 'run_paused 事件应标注 kind=budget');
    // 暂停在 awaiting_acceptance 之前，不允许人工验收
    assert.throws(() => h.orchestrator.acceptRun(started.runId), (err) => err?.code === 'RUN_NOT_READY');
  } finally {
    await h.cleanup();
  }
});
