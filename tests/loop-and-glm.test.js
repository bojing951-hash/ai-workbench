// SPDX-License-Identifier: Apache-2.0
/** v2.1：GLM 预算豁免/分离统计 + 研发循环持久化 的离线回归测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { LoopManager } from '../src/loop.js';

function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v21-test-'));
  const config = getConfig({
    root,
    paths: {
      root,
      dataDir: path.join(root, 'data'),
      projectsDir: path.join(root, 'projects'),
      worktreesDir: path.join(root, 'worktrees'),
      artifactsDir: path.join(root, 'artifacts'),
      logsDir: path.join(root, 'logs'),
      agentsDir: path.join(root, 'agents'),
      dbPath: path.join(root, 'data', 'test.db'),
      dshHome: path.join(root, 'agents', 'dsh-home'),
      claudeHome: path.join(root, 'agents', 'claude-home'),
    },
    budget: { maxTotalTokens: 1000, maxCostCny: 1, maxTokensPerRun: 1000, maxCostCnyPerRun: 1, cacheTokenWeight: 0.1, glmUnlimited: true, exemptProviders: ['glm'] },
    github: { token: '' },
  });
  const store = openStore(config.paths.dbPath);
  return { root, config, store };
}

test('GLM 与其它 provider 分开统计，且 GLM 不计入预算上限', () => {
  const { config, store } = tempEnv();
  try {
    store.createRun({ id: 'run1', projectId: 'p1', goal: 'g', status: 'running' });
    store.createAttempt({ id: 'a1', runId: 'run1', taskId: 't1', attemptNo: 1, stage: 'coding', agentKind: 'claude', provider: 'glm', providerKnown: true, providerSource: 'test', model: 'glm-5.3', tokensIn: 100, tokensOut: 50, tokensCache: 1000, costCny: 1.5 });
    store.createAttempt({ id: 'a2', runId: 'run1', taskId: 't1', attemptNo: 2, stage: 'coding', agentKind: 'dsh', provider: 'deepseek', providerKnown: true, providerSource: 'test', model: 'deepseek', tokensIn: 100, tokensOut: 50, tokensCache: 1000, costCny: 0.1 });
    const raw = store.usageTotals();
    assert.ok(raw.byProvider.glm);
    assert.ok(raw.byProvider.deepseek);
    assert.equal(raw.byProvider.glm.tokens, 1150);
    assert.equal(raw.byProvider.deepseek.tokens, 1150);
    const orchestrator = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [] } });
    const weighted = orchestrator.weightUsage(raw);
    assert.equal(weighted.glmUnlimited, true);
    assert.equal(weighted.budgetTokens, 100 + 50 + 1000 * 0.1); // 仅 deepseek 计入
    assert.ok(Math.abs(weighted.budgetCostCny - 0.1) < 1e-9);
    const budget = orchestrator.budget();
    assert.equal(budget.usedBudgetTokens, 250);
    assert.equal(budget.glm.tokens, 1150);
    assert.equal(budget.remainingTokens, 750);
  } finally {
    store.close();
  }
});

test('研发循环持久化：创建/更新/列表/状态', () => {
  const { store } = tempEnv();
  try {
    const loop = store.createLoop({ id: 'loop1', projectId: 'p1', goal: 'g', mode: 'plan', maxRounds: 3, contractFiles: ['README.md'] });
    assert.equal(loop.round, 0);
    assert.equal(loop.max_rounds, 3);
    assert.deepEqual(loop.contract_files_json, ['README.md']);
    const updated = store.updateLoop('loop1', { round: 1, history_json: [{ round: 1 }], status: 'paused', stop_reason: 'x' });
    assert.equal(updated.round, 1);
    assert.equal(updated.history_json.length, 1);
    assert.equal(updated.status, 'paused');
    assert.equal(store.listLoops({ projectId: 'p1' }).length, 1);
    assert.equal(store.listLoops({ status: 'paused' }).length, 1);
    assert.equal(store.listLoops({ status: 'running' }).length, 0);
  } finally {
    store.close();
  }
});

test('LoopManager：队列模式在队列为空时停止，不制造任务', async () => {
  const { config, store } = tempEnv();
  try {
    const started = [];
    const fakeOrchestrator = {
      emit: () => {},
      startRun: async (args) => { started.push(args); return { runId: 'r1' }; },
    };
    store.createProject({ id: 'p1', name: 'p', localPath: path.join(config.root, 'repo'), testCommand: 'node --test' });
    const loops = new LoopManager({ config, store, bus: new EventBus(), orchestrator: fakeOrchestrator });
    const loop = store.createLoop({ id: 'loop-q', projectId: 'p1', goal: 'g', mode: 'queue', maxRounds: 3, queue: [] });
    await loops.tick(loop.id);
    const after = store.getLoop(loop.id);
    assert.equal(after.status, 'completed');
    assert.match(after.stop_reason, /队列已空/);
    assert.equal(started.length, 0);
  } finally {
    store.close();
  }
});


test('未知供应商不获得 GLM 预算豁免（即使 provider 字段缺失/未知）', () => {
  const { config, store } = tempEnv();
  try {
    store.createRun({ id: 'run-unknown', projectId: 'p1', goal: 'g', status: 'running' });
    store.createAttempt({ id: 'au1', runId: 'run-unknown', taskId: 't1', attemptNo: 1, stage: 'coding', agentKind: 'custom', provider: 'unknown', providerKnown: false, tokensIn: 100, tokensOut: 50, tokensCache: 1000, costCny: 0.2 });
    const orchestrator = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [] } });
    const weighted = orchestrator.weightUsage(store.usageTotals());
    assert.equal(weighted.glmUnlimited, true);
    assert.equal(weighted.budgetTokens, 100 + 50 + 1000 * 0.1); // unknown 计入，不豁免
    assert.ok(Math.abs(weighted.budgetCostCny - 0.2) < 1e-9);
  } finally {
    store.close();
  }
});

test('任务验证 JSON 重复更新不会指数膨胀（Invalid string length 回归）', () => {
  const { config, store } = tempEnv();
  try {
    store.createRun({ id: 'run-json', projectId: 'p1', goal: 'g', status: 'running' });
    store.createTasks([{ id: 'task-json', projectId: 'p1', runId: 'run-json', planId: 'plan-json', seq: 1, title: 't', acceptance: ['x'], testCommand: 'true' }]);
    for (let i = 0; i < 20; i += 1) {
      store.updateTask('task-json', { status: 'coding', attempt: i, verification_json: { baseCommit: 'a', testedHash: `h${i}` } });
    }
    const row = store.db.prepare("SELECT length(verification_json) len FROM tasks WHERE id='task-json'").get();
    assert.ok(row.len < 2000, `verification_json 膨胀：${row.len}`);
    const fresh = store.getTask('task-json');
    assert.equal(typeof fresh.verification_json, 'object');
    assert.equal(fresh.verification_json.testedHash, 'h19');
  } finally { store.close(); }
});
