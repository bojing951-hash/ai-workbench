// SPDX-License-Identifier: Apache-2.0
/** v3.1：审计 UNKNOWN 的安全验证重试不得因未定义变量失败；复用原 worktree 重新测试/审计。 */
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

const NODE = process.execPath;
const CMD = `"${NODE}" -e "process.exit(0)"`;
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); }

test('v3.1：retryVerification 真实复用 worktree，不抛 ReferenceError 并完成', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v31-reverify-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: `${NODE} -e "process.exit(0)"` } }));
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'export const x=1;\n');
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 'wb']); git(repo, ['config', 'user.email', 'wb@test']); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, secrets: [], llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '', createPr: false, push: false, autoCreateRepo: false }, budget: { maxTotalTokens: 1_000_000, maxCostCny: 50, maxAttempts: 1, minReserveTokens: 10_000 }, agents: { dsh: { bin: '/no', timeoutMs: 1000 } } });
  const store = openStore(config.paths.dbPath);
  try {
    const project = await new Orchestrator({ config, store, bus: new EventBus(), deps: { checkAgents: async () => [], runAgent: async () => { throw new Error('no'); }, runAudit: async () => ({ provider: 'fake', model: 'fake', verdict: 'pass', score: 100, criteria: [{ criterion: '实现存在', status: 'pass', evidence: 'src/index.js 存在且测试通过' }], findings: [], requiredFixes: [], summary: 'pass', usage: { input: 1, output: 1 }, costCny: 0 }), chooseAgent: async () => 'dsh' } }).createProject({ name: 'reverify', repo, defaultBranch: 'main', testCommand: CMD, ciRequired: false });
    store.createRun({ id: 'r-reverify', projectId: project.id, planId: 'pl-reverify', goal: 'g', mode: 'single', status: 'paused' });
    store.createPlan({ id: 'pl-reverify', projectId: project.id, runId: 'r-reverify', goal: 'g', title: 't', tasks: [] });
    store.createTasks([{ id: 't-reverify', projectId: project.id, planId: 'pl-reverify', runId: 'r-reverify', seq: 1, title: '实现', acceptance: ['实现存在'], testCommand: CMD, status: 'blocked', worktree_path: repo, base_commit: 'HEAD', branch: 'main' }]);
    store.updateTask('t-reverify', { worktree_path: repo, base_commit: git(repo, ['rev-parse', 'HEAD']), branch: 'main' });
    const orch = new Orchestrator({ config, store, bus: new EventBus(), deps: { checkAgents: async () => [], runAgent: async () => { throw new Error('no'); }, runAudit: async () => ({ provider: 'fake', model: 'fake', verdict: 'pass', score: 100, criteria: [{ criterion: '实现存在', status: 'pass', evidence: 'src/index.js 存在且测试通过' }], findings: [], requiredFixes: [], summary: 'pass', usage: { input: 1, output: 1 }, costCny: 0 }), chooseAgent: async () => 'dsh' } });
    const result = await orch.retryVerification('t-reverify');
    assert.equal(result.ok, true, result.reason);
    assert.equal(store.getTask('t-reverify').status, 'passed');
    assert.ok(store.getTask('t-reverify').head_commit);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
