// SPDX-License-Identifier: Apache-2.0
/** v2.8 P0-1：真实审计/测试失败自动形成修复任务（无需人工新建 Run/提示词）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { LoopManager } from '../src/loop.js';
import { Orchestrator } from '../src/orchestrator.js';
import { spawnSync } from 'node:child_process';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auto-repair-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  const project = store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'npm test', ciRequired: false, config: { auto_repair_max: 2 } });
  return { config, store, project };
}

function fixture(store) {
  const loop = store.createLoop({ id: 'loop-ar', projectId: 'p', goal: '实现产品目标', mode: 'plan', maxRounds: 4, queue: [] });
  const run = store.createRun({ id: 'run-ar', projectId: 'p', planId: 'plan-ar', goal: 'round', mode: 'single', status: 'paused' });
  store.createTasks([{ id: 'task-ar', projectId: 'p', planId: 'plan-ar', runId: 'run-ar', seq: 1, title: '实现核心功能', description: 'd', acceptance: ['原始验收 A', '原始验收 B'], testCommand: 'npm test', status: 'blocked', blockedReason: 'DSH 审计 FAIL：缺少边界处理', headCommit: 'abc123' }]);
  store.createAudit({ id: 'aud-ar', runId: 'run-ar', taskId: 'task-ar', provider: 'deepseek', model: 'deepseek', verdict: 'fail', score: 80, criteria: [], requiredFixes: ['补充边界处理和测试证据'], verificationStatus: 'FAIL', evidenceHash: 'abc123' });
  return { loop, run };
}

test('v2.8 P0-1：审计 FAIL 自动生成优先修复任务，保留原始目标/验收/失败证据', async () => {
  const { config, store, project } = mk();
  try {
    const { loop, run } = fixture(store);
    let prepared = false;
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: {
      emit: () => {},
      prepareAutoRepair: async () => { prepared = true; return { ok: true, branch: 'wb/auto-repair-x', head: 'def456' }; },
    } });
    const ok = await manager.maybeAutoRepair(store.getLoop('loop-ar'), project, store.getRun('run-ar'));
    assert.equal(ok, true);
    assert.equal(prepared, true);
    const after = store.getLoop('loop-ar');
    assert.equal(after.status, 'running');
    assert.equal(after.current_run_id, '');
    assert.equal(after.auto_repair_count, 1);
    assert.equal(store.getRun('run-ar').status, 'failed', '失败 Run 必须进入终态，否则下一次 startRun 会 PROJECT_BUSY');
    assert.equal(store.activeRunForProject('p'), null);
    const repair = (after.queue_json || [])[0];
    assert.equal(repair.autoRepair, true);
    assert.equal(repair.repairOfTaskId, 'task-ar');
    assert.match(repair.title, /Auto Repair 1\/2/);
    assert.match(repair.description, /原始目标：实现产品目标/);
    assert.match(repair.description, /补充边界处理和测试证据/);
    assert.ok(repair.acceptance.includes('原始验收 A'));
    assert.equal(repair.testCommand, 'npm test');
  } finally { store.close(); }
});

test('v2.8 P1-2：审计 UNKNOWN 优先自动重试验证，不生成产品修复任务', async () => {
  const { config, store, project } = mk();
  try {
    fixture(store);
    store.updateTask('task-ar', { worktree_path: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ar-wt-')) });
    // 覆盖为 UNKNOWN 审计
    store.createAudit({ id: 'aud-unknown', runId: 'run-ar', taskId: 'task-ar', provider: 'deepseek', model: 'deepseek', verdict: 'fail', score: 0, criteria: [], requiredFixes: ['DSH 审计超时'], verificationStatus: 'UNKNOWN', evidenceHash: 'abc123' });
    let retried = false;
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: {
      emit: () => {}, retryVerification: async () => { retried = true; return { ok: true }; },
      prepareAutoRepair: async () => ({ ok: true, branch: 'x', head: 'y' }),
    } });
    const ok = await manager.maybeAutoRepair(store.getLoop('loop-ar'), project, store.getRun('run-ar'));
    assert.equal(ok, true);
    assert.equal(retried, true);
    assert.equal(store.getLoop('loop-ar').queue_json.length, 0);
    assert.equal(store.getLoop('loop-ar').auto_retry_count, 1);
  } finally { store.close(); }
});

test('v2.8 P0-1：自动修复达到上限后不再生成任务，保留 BLOCKED 现场', async () => {
  const { config, store, project } = mk();
  try {
    fixture(store);
    store.updateLoop('loop-ar', { auto_repair_count: 2 });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, prepareAutoRepair: async () => ({ ok: true, branch: 'x', head: 'y' }) } });
    const ok = await manager.maybeAutoRepair(store.getLoop('loop-ar'), project, store.getRun('run-ar'));
    assert.equal(ok, false);
    assert.equal(store.getLoop('loop-ar').queue_json.length, 0);
  } finally { store.close(); }
});


test('v2.8 P0-1 回归：自动修复后真实 startRun 不再被 paused run 阻塞', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auto-restart-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t'); fs.writeFileSync(path.join(repo, 'README.md'), 'x'); git('add', '-A'); git('commit', '-qm', 'base');
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    const project = store.createProject({ id: 'p', name: 'p', localPath: repo, testCommand: 'true', ciRequired: false });
    const loop = store.createLoop({ id: 'loop', projectId: 'p', goal: 'g', mode: 'queue', maxRounds: 3, queue: [] });
    const run = store.createRun({ id: 'run-old', projectId: 'p', planId: 'plan-old', goal: 'g', mode: 'single', status: 'paused' });
    store.createTasks([{ id: 'task-old', projectId: 'p', planId: 'plan-old', runId: 'run-old', seq: 1, title: '实现', acceptance: ['a'], testCommand: 'true', status: 'blocked', blockedReason: 'DSH 审计 FAIL：缺少测试', headCommit: git('rev-parse', 'HEAD') }]);
    store.createAudit({ id: 'aud-old', runId: 'run-old', taskId: 'task-old', provider: 'deepseek', model: 'deepseek', verdict: 'fail', score: 80, criteria: [], requiredFixes: ['补充真实测试'], verificationStatus: 'FAIL', evidenceHash: 'abc' });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, prepareAutoRepair: async () => ({ ok: true, branch: 'wb/repair', head: git('rev-parse', 'HEAD') }) } });
    assert.equal(await manager.maybeAutoRepair(store.getLoop('loop'), project, run), true);
    assert.equal(store.activeRunForProject('p'), null);
    const orch = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({ ok: false, error: 'test stub' }), chooseAgent: async () => 'claude', runAudit: async () => ({ verdict: 'unknown', criteria: [] }), checkAgents: async () => [] } });
    const started = await orch.startRun({ projectId: 'p', goal: 'repair run', mode: 'single', tasks: [{ title: '修复', description: 'd', acceptance: ['a'], testCommand: 'true', agent: 'custom' }], requestKey: 'repair-key-1' });
    assert.ok(started.runId);
    assert.notEqual(started.runId, 'run-old');
    store.updateRun(started.runId, { status: 'cancelled' });
  } finally { store.close(); }
});
