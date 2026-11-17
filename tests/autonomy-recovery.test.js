// SPDX-License-Identifier: Apache-2.0
/** v2.3：无进展看门狗、Agent 失败分类与备选 Agent 选择。 */
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

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-autonomy-'));
  return getConfig({
    root,
    paths: {
      root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'),
      artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'),
      dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home'),
    },
    agents: { fallback: ['claude', 'dsh'], stallTimeoutMs: 1500 },
    llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } },
    github: { token: '' },
  });
}

test('Agent 失败分类：stalled/timeout/budget/no-output/infrastructure', () => {
  const config = tempConfig(); const store = openStore(config.paths.dbPath);
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [] } });
    assert.equal(o.classifyAgentFailure({ stalled: true }), 'infrastructure_stalled');
    assert.equal(o.classifyAgentFailure({ timedOut: true }), 'infrastructure_timeout');
    assert.equal(o.classifyAgentFailure({ aborted: true }), 'infrastructure_aborted');
    assert.equal(o.classifyAgentFailure({ error: 'Agent 超出单任务 token 预算' }), 'budget');
    assert.equal(o.classifyAgentFailure({ error: '未返回可解析的 JSON 结果' }), 'agent_no_output');
    assert.equal(o.classifyAgentFailure({ error: '权限策略拒绝执行' }), 'infrastructure');
    assert.equal(o.classifyAgentFailure({ error: '普通失败' }), 'agent_error');
  } finally { store.close(); }
});

test('备选 Agent：按配置顺序且过滤不可用 Agent', async () => {
  const config = tempConfig(); const store = openStore(config.paths.dbPath);
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {
      runAgent: async () => ({}), runAudit: async () => ({}),
      chooseAgent: async () => 'dsh',
      checkAgents: async () => [{ id: 'dsh', ok: true }, { id: 'claude', ok: false }],
    } });
    const candidates = await o.resolveAgentCandidates({ config_json: {} }, {});
    assert.deepEqual(candidates, ['dsh']);
    const o2 = new Orchestrator({ config, store, bus: new EventBus(), deps: {
      runAgent: async () => ({}), runAudit: async () => ({}),
      chooseAgent: async () => 'dsh',
      checkAgents: async () => [{ id: 'dsh', ok: true }, { id: 'claude', ok: true }],
    } });
    assert.deepEqual(await o2.resolveAgentCandidates({ config_json: {} }, {}), ['dsh', 'claude']);
  } finally { store.close(); }
});

test('无进展看门狗：工作树无变化则 abort Agent 并标记 stalled', async () => {
  const config = tempConfig(); const store = openStore(config.paths.dbPath);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-watch-'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  let aborted = false;
  const deps = {
    chooseAgent: async () => 'dsh', runAudit: async () => ({}), checkAgents: async () => [{ id: 'dsh', ok: true }, { id: 'claude', ok: true }],
    runAgent: async (agentId, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => { aborted = true; resolve({ ok: false, aborted: true, error: 'stalled abort', usage: {}, durationMs: 1000 }); });
      setTimeout(() => resolve({ ok: true, usage: {}, durationMs: 30000 }), 30_000);
    }),
  };
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps });
    const { result, stalled } = await o.runAgentWithWatchdog({ agentId: 'dsh', ctx: { config, cwd: repo, prompt: 'x' }, worktree: repo, stallTimeoutMs: 1200 });
    assert.equal(stalled, true);
    assert.equal(aborted, true);
    assert.equal(result.ok, false);
  } finally { store.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});
