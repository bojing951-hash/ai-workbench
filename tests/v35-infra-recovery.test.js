// SPDX-License-Identifier: Apache-2.0
/** v3.5 P0-3：基础设施中断不得进入产品自动修复/未授权 Agent fallback。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

const NODE = process.execPath;
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); }
async function waitFor(fn, timeout = 30_000) { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > timeout) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } }

test('v3.5 基础设施失败：Agent stalled -> BLOCKED/暂停，不生成产品修复、不 fallback', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-infra-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# p\n');
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 't']); git(repo, ['config', 'user.email', 't@t']); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'g', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'd', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } }, github: { token: '', createPr: false, push: false, autoCreateRepo: false }, budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, minReserveTokens: 0 } });
  const store = openStore(config.paths.dbPath);
  let calls = 0; let agents = [];
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {
      checkAgents: async () => [{ id: 'claude', ok: true }, { id: 'dsh', ok: true }],
      chooseAgent: async () => 'claude',
      runAgent: async (id) => { calls += 1; agents.push(id); return { ok: false, stalled: true, aborted: true, error: 'watchdog stalled', usage: {}, durationMs: 1000, logPath: '/tmp/fake.log' }; },
      runAudit: async () => { throw new Error('audit should not run'); },
    } });
    const project = await o.createProject({ name: 'infra', repo, defaultBranch: 'main', testCommand: `${NODE} -e "process.exit(0)"`, ciRequired: false });
    const started = await o.startRun({ projectId: project.id, goal: '实现 A', mode: 'single', tasks: [{ title: '实现 A', acceptance: ['A 完成'], testCommand: `${NODE} -e "process.exit(0)"` }] });
    const runId = started.runId;
    const loop = await waitFor(() => { const r = store.getRun(runId); return r && ['paused', 'failed', 'interrupted'].includes(r.status) ? r : null; });
    const tasks = store.listTasks({ runId });
    assert.ok(calls >= 1, '基础设施恢复调用必须使用原 Agent');
    assert.ok(agents.every((a) => a === 'claude'), '不得切换到未授权 Agent');
    assert.equal(loop.status, 'paused');
    assert.equal(tasks.length, 1, '基础设施失败不得生成产品修复任务');
    assert.equal(tasks[0].status, 'blocked');
    assert.match(tasks[0].blocked_reason, /基础设施|infrastructure/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.5 基础设施失败：Loop 的 maybeAutoRepair 不得生成产品修复任务', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-loop-infra-'));
  const store = openStore(path.join(root, 'test.db'));
  try {
    store.createProject({ id: 'p-infra-loop', name: 'infra', localPath: root, defaultBranch: 'main' });
    store.createRun({ id: 'r-infra-loop', projectId: 'p-infra-loop', planId: 'pl-infra-loop', goal: 'g', mode: 'single', status: 'paused', stopReason: '基础设施/预算中断（infrastructure_timeout）：Claude Code 执行超时' });
    store.createPlan({ id: 'pl-infra-loop', projectId: 'p-infra-loop', runId: 'r-infra-loop', goal: 'g', title: 't', tasks: [] });
    store.createTasks([{ id: 't-infra-loop', projectId: 'p-infra-loop', planId: 'pl-infra-loop', runId: 'r-infra-loop', seq: 1, title: '实现', acceptance: ['A'], status: 'blocked', blocked_reason: '基础设施/预算中断（infrastructure_timeout）：Claude Code 执行超时' }]);
    store.createLoop({ id: 'l-infra-loop', projectId: 'p-infra-loop', goal: 'g', mode: 'queue', status: 'running', maxRounds: 3 });
    const { LoopManager } = await import('../src/loop.js');
    const { EventBus } = await import('../src/bus.js');
    let repaired = 0;
    const lm = new LoopManager({ config: hcfg(root), store, bus: new EventBus(), orchestrator: { prepareAutoRepair: async () => { repaired += 1; return { ok: true }; }, auditResourcePreflight: () => {}, ensureControlLease: () => {}, releaseProjectLease: () => {} } });
    const loop = store.getLoop('l-infra-loop'); const run = store.getRun('r-infra-loop');
    const result = await lm.maybeAutoRepair(loop, store.getProject('p-infra-loop'), run);
    assert.equal(result, false);
    assert.equal(repaired, 0, '基础设施失败不得调用 prepareAutoRepair');
    assert.equal(store.getLoop('l-infra-loop').queue_json.length, 0);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

function hcfg(root) {
  return getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') } });
}

test('v3.5 基础设施恢复：第一次 Agent 中断后原 Agent 自动续跑并完成任务，不生成产品修复', { timeout: 180_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-auto-recover-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# p\n');
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 't']); git(repo, ['config', 'user.email', 't@t']); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'g', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'd', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } }, github: { token: '', createPr: false, push: false, autoCreateRepo: false }, budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, minReserveTokens: 0, maxAttempts: 2 } });
  const store = openStore(config.paths.dbPath);
  let calls = 0; const agents = [];
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {
      checkAgents: async () => [{ id: 'claude', ok: true }, { id: 'dsh', ok: true }],
      chooseAgent: async () => 'claude',
      runAgent: async (id, ctx) => {
        calls += 1; agents.push(id);
        if (calls === 1) return { ok: false, aborted: true, error: 'temporary infrastructure interruption', usage: {}, durationMs: 100, sessionId: 'sess-recover', logPath: '/tmp/a.log' };
        fs.writeFileSync(path.join(ctx.cwd, 'implemented.txt'), 'ok\n');
        return { ok: true, text: 'done', usage: { input: 1, output: 1 }, durationMs: 100, sessionId: 'sess-recover', logPath: '/tmp/a.log' };
      },
      runAudit: async ({ task, project }) => ({ provider: 'fake', model: 'fake', verdict: 'pass', status: 'PASS', score: 100, criteria: (task.acceptance_json || []).map((c) => ({ criterion: c, status: 'pass', evidence: 'real worktree artifact verified' })), findings: [], requiredFixes: [], summary: 'pass', usage: { input: 1, output: 1 }, costCny: 0, independence: { independent: true } }),
    } });
    const project = await o.createProject({ name: 'auto-recover', repo, defaultBranch: 'main', testCommand: `${NODE} -e "process.exit(0)"`, ciRequired: false });
    const started = await o.startRun({ projectId: project.id, goal: '实现 A', mode: 'single', tasks: [{ title: '实现 A', acceptance: ['A 完成'], testCommand: `${NODE} -e "process.exit(0)"` }] });
    const run = await waitFor(() => { const r = store.getRun(started.runId); return r && ['awaiting_acceptance', 'accepted', 'paused', 'failed'].includes(r.status) ? r : null; }, 120_000);
    const tasks = store.listTasks({ runId: started.runId });
    assert.equal(calls, 2, '第一次中断后必须自动用原 Agent 续跑一次，不应等待人工');
    assert.deepEqual(agents, ['claude', 'claude']);
    assert.equal(tasks.length, 1, '不得生成产品修复任务');
    assert.equal(tasks[0].status, 'passed', `task=${tasks[0].status} ${tasks[0].blocked_reason}`);
    assert.equal(run.status, 'awaiting_acceptance');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
