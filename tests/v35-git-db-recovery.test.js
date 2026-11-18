// SPDX-License-Identifier: Apache-2.0
/** v3.6 P1：Git commit 已成功、SQLite 仍 committing 的崩溃窗口幂等补账。 */
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

test('v36 Git-DB：已生成 commit 但 SQLite 未 passed 时按原 SHA 补账，不重跑 Agent/Audit/Commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v36-gitdb-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; };
  fs.writeFileSync(path.join(repo, 'README.md'), '# p\n'); git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'g', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'd', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } }, github: { token: '', createPr: false, push: false }, budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, minReserveTokens: 0 } });
  const store = openStore(config.paths.dbPath);
  try {
    const wt = path.join(dataDir, 'wt'); git(['worktree', 'add', '-b', 'wb/rgit/t1', wt, 'HEAD']); git(['branch', 'wb/plan--gitdb', 'HEAD']);
    fs.writeFileSync(path.join(wt, 'implemented.js'), 'ok\n'); git(['add', '-A'], wt); git(['commit', '-qm', 'feat: implemented'], wt);
    const head = git(['rev-parse', 'HEAD'], wt).stdout.trim();
    const tree = git(['rev-parse', 'HEAD^{tree}'], wt).stdout.trim();
    store.createProject({ id: 'p-gitdb', name: 'p', localPath: repo, defaultBranch: 'main' });
    store.createRun({ id: 'r-gitdb', projectId: 'p-gitdb', planId: 'pl-gitdb', goal: 'g', mode: 'single', status: 'interrupted' });
    store.createPlan({ id: 'pl-gitdb', projectId: 'p-gitdb', runId: 'r-gitdb', goal: 'g', title: 't', tasks: [] });
    store.createTasks([{ id: 't-gitdb', projectId: 'p-gitdb', planId: 'pl-gitdb', runId: 'r-gitdb', seq: 1, title: 't', acceptance: ['A'], status: 'committing' }]);
    store.updateTask('t-gitdb', { worktree_path: wt, branch: 'wb/rgit/t1', base_commit: 'HEAD', head_commit: '', verification_json: { testedHash: tree, planBranch: 'wb/rgit/t1', auditId: 'aud-gitdb', auditStatus: 'PASS' } });
    store.createAudit({ id: 'aud-gitdb', runId: 'r-gitdb', taskId: 't-gitdb', provider: 'mock', model: 'mock', verdict: 'pass', score: 100, verificationStatus: 'PASS', criteria: [{ criterion: 'A', status: 'pass', evidence: 'tested tree verified' }] });
    let agents = 0; let audits = 0;
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { checkAgents: async () => [], chooseAgent: async () => 'claude', runAgent: async () => { agents += 1; throw new Error('must not rerun'); }, runAudit: async () => { audits += 1; throw new Error('must not reaudit'); } } });
    await o.resumeRun('r-gitdb', { retryFailed: true });
    const task = store.getTask('t-gitdb');
    assert.equal(task.status, 'passed');
    assert.equal(task.head_commit, head, '必须沿用原 Git commit SHA');
    assert.equal(agents, 0);
    assert.equal(audits, 0);
    assert.equal(git(['rev-parse', 'wb/rgit/t1'], repo).stdout.trim(), head);
    const pb = git(['rev-parse', 'wb/plan--gitdb'], repo).stdout.trim(); if (pb !== head) console.error('BRANCHES', git(['branch', '-vv'], repo).stdout);
    assert.equal(pb, head, '必须推进计划分支而不是检出的任务分支；branches=' + git(['branch', '-vv'], repo).stdout);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
