// SPDX-License-Identifier: Apache-2.0
/** v2.4：持久化租约、恢复对账、审计资源预检、看门狗事件进度。 */
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

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v24-'));
  const config = getConfig({
    root,
    paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') },
    agents: { fallback: ['claude', 'dsh'], stallTimeoutMs: 1500 },
    budget: { maxTotalTokens: 100_000, maxCostCny: 5, minReserveTokens: 2_000, maxTokensPerRun: 100_000, maxCostCnyPerRun: 5, maxTokensPerTask: 100_000, maxAttempts: 2 },
    llm: { openai: { apiKey: '' }, glm: { apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } },
    github: { token: '' },
  });
  const store = openStore(config.paths.dbPath);
  return { config, store };
}

test('v2.4 项目租约：单写所有权、过期清理', () => {
  const { config, store } = mk();
  try {
    store.createProject({ id: 'p1', name: 'p', localPath: path.join(config.root, 'r'), testCommand: 'true' });
    assert.equal(store.acquireProjectLease('p1', 'owner-a', 30_000), true);
    assert.equal(store.acquireProjectLease('p1', 'owner-b', 30_000), false);
    assert.equal(store.renewProjectLease('p1', 'owner-b', 30_000), false);
    assert.equal(store.renewProjectLease('p1', 'owner-a', 30_000), true);
    store.db.prepare("UPDATE projects SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='p1'").run();
    const cleared = store.clearExpiredLeases();
    assert.ok(cleared.projects >= 1);
    assert.equal(store.acquireProjectLease('p1', 'owner-b', 30_000), true);
  } finally { store.close(); }
});

test('v2.4 恢复对账：passed 任务缺少计划分支 commit 时拒绝续跑', async () => {
  const { config, store } = mk();
  try {
    const repo = path.join(config.root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), 'x');
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    const project = store.createProject({ id: 'p1', name: 'p', localPath: repo, testCommand: 'true' });
    const run = store.createRun({ id: 'run123456', projectId: project.id, planId: 'plan1', goal: 'g', status: 'interrupted' });
    store.createTasks([{ id: 'task1', projectId: project.id, planId: 'plan1', runId: run.id, seq: 1, title: 't', acceptance: ['a'], testCommand: 'true', status: 'passed', headCommit: 'deadbeef', branch: 'wb/x' }]);
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [] } });
    const rec = await o.reconcileInterruptedRun(run.id);
    assert.equal(rec.ok, false);
    assert.ok(rec.failures.length > 0);
  } finally { store.close(); }
});

test('v2.4 审计资源预检：无独立 Provider 时编码前阻塞', () => {
  const { config, store } = mk();
  try {
    store.createProject({ id: 'p1', name: 'p', localPath: path.join(config.root, 'r'), testCommand: 'true' });
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [] } });
    // coder family = deepseek，可用审计只剩 glm/deepseek；glm 独立可预检通过
    const resource = o.auditResourcePreflight({ config_json: {} }, 'deepseek');
    assert.equal(resource.provider, 'glm');
    // 无任何审计 key 时阻塞
    const empty = getConfig({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v24b-')), llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } } });
    const o2 = new Orchestrator({ config: empty, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [] } });
    assert.throws(() => o2.auditResourcePreflight({ config_json: {} }, 'deepseek'), /AUDIT_RESOURCE_UNAVAILABLE|独立审计/);
  } finally { store.close(); }
});

test('v2.4 看门狗：Agent 事件活动（无文件变化）不应误判为卡死', async () => {
  const { config, store } = mk();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v24repo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  const deps = {
    chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [{ id: 'dsh', ok: true }, { id: 'claude', ok: true }],
    runAgent: async (agentId, ctx) => new Promise((resolve) => {
      let n = 0;
      const timer = setInterval(() => { n += 1; try { ctx.onEvent?.({ kind: 'tool_call', tool: 'read', summary: `read ${n}` }); } catch { /* ignore */ } }, 250);
      setTimeout(() => { clearInterval(timer); resolve({ ok: true, text: 'done', usage: {}, durationMs: 2000, sessionId: 's' }); }, 3000);
    }),
  };
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps });
    const { result, stalled } = await o.runAgentWithWatchdog({ agentId: 'dsh', ctx: { config, cwd: repo, prompt: 'x' }, worktree: repo, stallTimeoutMs: 1200 });
    assert.equal(stalled, false);
    assert.equal(result.ok, true);
  } finally { store.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});
