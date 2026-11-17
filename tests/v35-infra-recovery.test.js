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
    assert.equal(calls, 1, '不得 fallback/重复调用 Agent');
    assert.deepEqual(agents, ['claude'], '不得切换到未授权 Agent');
    assert.equal(loop.status, 'paused');
    assert.equal(tasks.length, 1, '基础设施失败不得生成产品修复任务');
    assert.equal(tasks[0].status, 'blocked');
    assert.match(tasks[0].blocked_reason, /基础设施|infrastructure/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
