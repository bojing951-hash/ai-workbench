// SPDX-License-Identifier: Apache-2.0
/** v2.8 P0-2：Loop pending/requestKey 原子认领与崩溃恢复。 */
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-loop-recover-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'true' });
  return { store };
}

test('v2.8 P0-2：startRun 前崩溃，pending 任务恢复回队列，不丢失', () => {
  const { store } = mk();
  try {
    const task = { title: '必须执行的任务', qualityIssueId: 'Q1', testCommand: 'true' };
    store.createLoop({ id: 'loop', projectId: 'p', goal: 'g', mode: 'queue', maxRounds: 3, queue: [task] });
    store.setLoopPending('loop', { task, queueIndex: 0, requestKey: 'claim-crash-before-run' });
    const rec = store.recoverLoopPending('loop');
    assert.equal(rec.restored, true);
    const loop = store.getLoop('loop');
    assert.equal(loop.queue_json.length, 1);
    assert.equal(loop.queue_json[0].title, '必须执行的任务');
    assert.deepEqual(store.getLoopPending('loop'), {});
  } finally { store.close(); }
});

test('v2.8 P0-2：startRun 后崩溃，恢复按 requestKey 绑定同一 Run，不重复创建/不重复入队', () => {
  const { store } = mk();
  try {
    const task = { title: '修复任务', qualityIssueId: 'Q2', testCommand: 'true' };
    store.createLoop({ id: 'loop2', projectId: 'p', goal: 'g', mode: 'queue', maxRounds: 3, queue: [task] });
    store.setLoopPending('loop2', { task, queueIndex: 0, requestKey: 'claim-crash-after-run' });
    store.createRun({ id: 'run-existing', projectId: 'p', planId: 'plan1', goal: 'g', mode: 'single', status: 'queued', requestKey: 'claim-crash-after-run' });
    store.createTasks([{ id: 'task-existing', projectId: 'p', planId: 'plan1', runId: 'run-existing', seq: 1, title: '已创建任务', acceptance: ['a'], testCommand: 'true', status: 'queued' }]);
    const rec = store.recoverLoopPending('loop2');
    assert.equal(rec.linked, true);
    assert.equal(rec.runId, 'run-existing');
    const loop = store.getLoop('loop2');
    assert.equal(loop.current_run_id, 'run-existing');
    assert.equal(loop.queue_json.length, 0);
    assert.deepEqual(store.getLoopPending('loop2'), {});
    assert.equal(store.getRunByRequestKey('claim-crash-after-run').id, 'run-existing');
  } finally { store.close(); }
});

test('v2.8 P0-2：陈旧 requestKey 不能误认领新 pending，队列任务不被误删', () => {
  const { store } = mk();
  try {
    const task = { title: '任务X' };
    store.createLoop({ id: 'loop3', projectId: 'p', goal: 'g', queue: [task] });
    store.setLoopPending('loop3', { task, queueIndex: 0, requestKey: 'new-key' });
    const result = store.claimLoopTask({ loopId: 'loop3', requestKey: 'old-key', runId: 'run1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale-pending-key');
    assert.equal(store.getLoop('loop3').queue_json.length, 1);
  } finally { store.close(); }
});

test('v2.9 可靠性：半创建 Run（无 tasks）不能吞掉 pending 任务，恢复时清 Run 并回队列', () => {
  const { store } = mk();
  try {
    const task = { title: '半创建恢复任务', qualityIssueId: 'Q3' };
    store.createLoop({ id: 'loop4', projectId: 'p', goal: 'g', queue: [task] });
    store.setLoopPending('loop4', { task, queueIndex: 0, requestKey: 'half-created-key' });
    store.createRun({ id: 'run-half', projectId: 'p', planId: 'plan-half', goal: 'g', mode: 'single', status: 'queued', requestKey: 'half-created-key' });
    const rec = store.recoverLoopPending('loop4');
    assert.equal(rec.restored, true);
    assert.equal(rec.orphanRunId, 'run-half');
    assert.equal(store.getRun('run-half').status, 'failed');
    assert.equal(store.getLoop('loop4').queue_json.length, 1);
    assert.equal(store.getLoop('loop4').queue_json[0].title, '半创建恢复任务');
  } finally { store.close(); }
});

test('v2.9：plan 模式恢复/队列中的任务会被实际消费，而不是永远遗留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plan-recover-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'true' });
    store.createLoop({ id: 'plan-recover', projectId: 'p', goal: 'g', mode: 'plan', maxRounds: 3, queue: [{ title: '恢复的规划任务' }] });
    let startedTask = '';
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async (input) => { startedTask = input.tasks?.[0]?.title || ''; return { runId: 'run-plan-recover' }; } } });
    await manager.tick('plan-recover');
    assert.equal(startedTask, '恢复的规划任务');
    assert.equal(store.getLoop('plan-recover').queue_json.length, 0);
  } finally { store.close(); }
});
