// SPDX-License-Identifier: Apache-2.0
/** v2.7 P1-D：控制 API 写所有权单元验证（确定性，不依赖 Agent/HTTP 生命周期）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

test('v2.7 P1-D：非 owner 控制 API 不能 pause/cancel/resume 他人租约内的 run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-control-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    store.createProject({ id: 'p', name: 'control', localPath: '/tmp/none', testCommand: 'true' });
    const holder = `wb:${process.pid}:other-workbench`;
    const lease = store.acquireProjectLeaseFenced('p', holder, 60_000);
    assert.equal(lease.ok, true);
    const run = store.createRun({ id: 'run1', projectId: 'p', planId: 'plan1', goal: 'g', mode: 'single', status: 'running' });
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'claude', runAudit: async () => ({}), checkAgents: async () => [] } });
    assert.throws(() => o.cancelRun(run.id), /PROJECT_LEASE_HELD|写租约/);
    assert.throws(() => o.pauseRun(run.id, 'x'), /PROJECT_LEASE_HELD|写租约/);
    await assert.rejects(o.resumeRun(run.id), /PROJECT_LEASE_HELD|写租约/);
    assert.equal(store.getRun(run.id).status, 'running', '非 owner 控制不得改变 run 状态');
  } finally { store.close(); }
});

test('v2.7 P1-D：失败的控制 API 不得泄漏 30 分钟项目写租约', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-control-leak-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    store.createProject({ id: 'p', name: 'control', localPath: '/tmp/none', testCommand: 'true' });
    store.createRun({ id: 'run1', projectId: 'p', planId: 'plan1', goal: 'g', mode: 'single', status: 'running' });
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'claude', runAudit: async () => ({}), checkAgents: async () => [] } });
    assert.throws(() => o.acceptRun('run1', { confirmLocalOnly: true }), /运行尚未完成/);
    assert.equal(store.getProjectLease('p').write_owner, '', 'acceptRun 失败后必须释放租约');
    store.updateRun('run1', { status: 'accepted' });
    await assert.rejects(async () => o.resumeRun('run1'), /运行已结束/);
    assert.equal(store.getProjectLease('p').write_owner, '', 'resumeRun 失败后必须释放租约');
  } finally { store.close(); }
});
