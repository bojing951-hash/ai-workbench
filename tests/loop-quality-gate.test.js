// SPDX-License-Identifier: Apache-2.0
/** v2.9 可靠性：质量未 PASS/修复队列非空时，达到 max_rounds 也不得 completed。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { LoopManager } from '../src/loop.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-qgate-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'true', ciRequired: false, config: { quality: { quality_command: 'true', sandbox: 'off', host_isolation_acknowledged: true, requirements: [{ id: 'R1', title: 'R', priority: 'P0', acceptance: ['a'] }] } } });
  return { config, store };
}

test('v2.9：max_rounds 且质量未 PASS，不得 completed', async () => {
  const { config, store } = mk();
  try {
    const loop = store.createLoop({ id: 'loop', projectId: 'p', goal: 'g', mode: 'plan', maxRounds: 1 });
    store.updateLoop('loop', { round: 1, status: 'running', history_json: [{ round: 1, quality: { allPass: false, coverage: { pass: 0, total: 1 } } }] });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => ({ runId: 'x' }) } });
    await manager.tick('loop');
    const after = store.getLoop('loop');
    assert.equal(after.status, 'blocked');
    assert.match(after.stop_reason, /质量门未完成|不能完成/);
  } finally { store.close(); }
});

test('v2.9：max_rounds 且质量 PASS + 队列空，才 completed', async () => {
  const { config, store } = mk();
  try {
    store.createLoop({ id: 'loop2', projectId: 'p', goal: 'g', mode: 'plan', maxRounds: 1 });
    store.updateLoop('loop2', { round: 1, status: 'running', history_json: [{ round: 1, quality: { allPass: true, coverage: { pass: 1, total: 1 } } }] });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => ({ runId: 'x' }) } });
    await manager.tick('loop2');
    assert.equal(store.getLoop('loop2').status, 'completed');
  } finally { store.close(); }
});

test('v3.0：重复轮次通知也不能绕过质量门标记 completed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v3-dup-quality-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'node --test', config: { quality: { quality_command: 'node --test', requirements: [{ id: 'R1', title: 'must', priority: 'P0', acceptance: ['a'] }], require_clause_evidence: true } } });
    const history = [{ runId: 'run-dup', quality: { allPass: false, coverage: { pass: 0, total: 1 } } }];
    store.createLoop({ id: 'loop-dup', projectId: 'p', goal: 'g', mode: 'plan', maxRounds: 1 });
    store.updateLoop('loop-dup', { round: 1, history_json: history, current_run_id: 'run-dup' });
    store.createRun({ id: 'run-dup', projectId: 'p', planId: 'plan-dup', goal: 'g', mode: 'single', status: 'awaiting_acceptance', verification_status: 'LOCAL_VERIFIED' });
    store.createTasks([{ id: 'task-dup', projectId: 'p', planId: 'plan-dup', runId: 'run-dup', seq: 1, title: 't', acceptance: ['a'], testCommand: 'node --test', status: 'passed', head_commit: 'abc' }]);
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => ({ runId: 'x' }) } });
    await manager.completeRound(store.getLoop('loop-dup'), store.getProject('p'), store.getRun('run-dup'));
    assert.notEqual(store.getLoop('loop-dup').status, 'completed');
    assert.equal(store.getLoop('loop-dup').status, 'blocked');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
