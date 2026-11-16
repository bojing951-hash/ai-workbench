// SPDX-License-Identifier: Apache-2.0
/** v2.7：两个独立 Workbench 编排器实例竞争同一项目，只允许一个写入。 */
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

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fence-wb-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x'); git('add', '-A'); git('commit', '-qm', 'base');
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') },
    llm: { openai: { apiKey: '' }, glm: { apiKey: 'k' }, deepseek: { apiKey: 'k' } }, github: { token: '' }, budget: { maxTotalTokens: 1_000_000, maxCostCny: 5, minReserveTokens: 0, maxTokensPerRun: 100_000, maxCostCnyPerRun: 5, maxTokensPerTask: 100_000, maxAttempts: 1, maxAgentConcurrency: 1 } });
  const store = openStore(config.paths.dbPath);
  const project = store.createProject({ id: 'p1', name: 'fence project', localPath: repo, testCommand: 'true', ciRequired: false, auditProvider: 'glm', agentKind: 'claude' });
  const deps = {
    chooseAgent: async () => 'claude',
    checkAgents: async () => [],
    runAgent: async () => { await new Promise((resolve) => setTimeout(resolve, 2500)); return { text: 'done', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costCny: 0 }; },
    runAudit: async ({ task }) => ({ provider: 'deepseek', providerLabel: 'audit', model: 'deepseek', status: 'PASS', verdict: 'pass', score: 100, criteria: task.acceptance_json.map((a) => ({ criterion: a, status: 'pass', evidence: 'injected-test' })), findings: [], requiredFindings: [], requiredFixes: [], unknownReasons: [], summary: 'ok', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costCny: 0, independence: { independent: true }, chunks: 1 }),
  };
  return { root, repo, config, store, project, deps };
}

test('v2.7 两个编排器实例并发 startRun：只有一个得到项目写租约', async () => {
  const { store, project, config, deps } = mkRoot();
  try {
    const a = new Orchestrator({ config, store, bus: new EventBus(), deps });
    const b = new Orchestrator({ config, store, bus: new EventBus(), deps });
    const payload = { projectId: project.id, goal: '并发测试', mode: 'single', tasks: [{ title: 't1', description: 'd', acceptance: ['a'], agent: 'claude', testCommand: 'true' }] };
    const results = await Promise.allSettled([a.startRun(payload), b.startRun(payload)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, `只能一个成功：${JSON.stringify(results.map((r) => r.status))}`);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0].reason?.code || rejected[0].reason?.message || rejected[0].reason), /PROJECT_LEASE_HELD|PROJECT_BUSY|租约/);
    const runs = store.db.prepare('SELECT id,status FROM runs WHERE project_id=?').all(project.id);
    assert.equal(runs.length, 1, '竞争失败者不得创建重复 run');
    // 清理 winner（不等待 agent 完成）
    a.cancelRun?.(runs[0].id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally { store.close(); }
});
