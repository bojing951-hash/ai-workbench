// SPDX-License-Identifier: Apache-2.0
/** v3.5 P0-2：恢复不得删除有效 Worktree/检查点，原 Session 保留。 */
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

test('v3.5 恢复保留有效 worktree、文件与 session/checkpoint，不重新清零代码', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-worktree-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# p\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); spawnSync('git', ['config', 'user.name', 't'], { cwd: repo }); spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo }); spawnSync('git', ['add', '-A'], { cwd: repo }); spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'g', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'd', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } }, github: { token: '', createPr: false, push: false }, budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, minReserveTokens: 0 } });
  const store = openStore(config.paths.dbPath);
  const worktree = path.join(dataDir, 'preserved-worktree');
  const add = spawnSync('git', ['worktree', 'add', '-b', 'wb/preserve', worktree, 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  fs.writeFileSync(path.join(worktree, 'partial.js'), 'const partial = true;\n');
  let orch;
  try {
    orch = new Orchestrator({ config, store, bus: new EventBus(), deps: { checkAgents: async () => [], chooseAgent: async () => 'claude', runAgent: async () => new Promise(() => {}), runAudit: async () => ({}) } });
    const project = await orch.createProject({ name: 'worktree', repo, defaultBranch: 'main', testCommand: `${process.execPath} -e "process.exit(0)"`, ciRequired: false });
    store.createRun({ id: 'r-wt', projectId: project.id, planId: 'pl-wt', goal: 'g', mode: 'single', status: 'paused' });
    store.createPlan({ id: 'pl-wt', projectId: project.id, runId: 'r-wt', goal: 'g', title: 't', tasks: [] });
    store.createTasks([{ id: 't-wt', projectId: project.id, planId: 'pl-wt', runId: 'r-wt', seq: 1, title: '实现', acceptance: ['A'], testCommand: `${process.execPath} -e "process.exit(0)"`, status: 'blocked', worktree_path: worktree, branch: 'wb/rx/t1', base_commit: 'HEAD', session_id: 'sess-preserve', verification_json: { checkpoint: { head: 'abc123', tree: 'def456' } }, blocked_reason: '基础设施中断' }]);
    store.updateTask('t-wt', { worktree_path: worktree, branch: 'wb/rx/t1', base_commit: 'HEAD', session_id: 'sess-preserve', verification_json: { checkpoint: { head: 'abc123', tree: 'def456' } } });
    await orch.resumeRun('r-wt', { retryFailed: true });
    assert.ok(fs.existsSync(worktree), '有效 worktree 不得被删除');
    assert.equal(fs.readFileSync(path.join(worktree, 'partial.js'), 'utf8'), 'const partial = true;\n');
    const task = store.getTask('t-wt');
    assert.equal(task.status, 'queued');
    assert.equal(task.worktree_path, worktree);
    assert.equal(task.session_id, 'sess-preserve');
    assert.ok(task.verification_json.checkpoint?.archive, '必须保存可校验检查点归档');
    assert.ok(fs.existsSync(task.verification_json.checkpoint.manifestFile), '检查点 manifest 必须存在');
  } finally {
    try { await orch?.cancelRun('r-wt'); } catch { /* ignore */ }
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v3.5 旧 Checkpoint 不得覆盖较新的有效 Worktree 文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-stale-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# p\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); spawnSync('git', ['config', 'user.name', 't'], { cwd: repo }); spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo }); spawnSync('git', ['add', '-A'], { cwd: repo }); spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'g', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'd', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } }, github: { token: '', createPr: false, push: false }, budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, minReserveTokens: 0 } });
  const store = openStore(config.paths.dbPath); let o;
  try {
    o = new Orchestrator({ config, store, bus: new EventBus(), deps: { checkAgents: async () => [], chooseAgent: async () => 'claude', runAgent: async () => new Promise(() => {}), runAudit: async () => ({}) } });
    const project = await o.createProject({ name: 'stale', repo, defaultBranch: 'main', testCommand: `${process.execPath} -e "process.exit(0)"`, ciRequired: false });
    const wt = path.join(dataDir, 'wt'); spawnSync('git', ['worktree', 'add', '-b', 'wb/t1', wt, 'HEAD'], { cwd: repo });
    fs.writeFileSync(path.join(wt, 'partial.js'), 'old\n');
    const run = { id: 'r-stale' }; const task = { id: 't-stale', branch: 'wb/t1', session_id: 's1' };
    const old = await o.saveWorktreeCheckpoint({ run, task, project, worktree: wt });
    fs.writeFileSync(path.join(wt, 'partial.js'), 'newer\n');
    store.createRun({ id: 'r-stale', projectId: project.id, planId: 'pl-stale', goal: 'g', mode: 'single', status: 'paused' });
    store.createPlan({ id: 'pl-stale', projectId: project.id, runId: 'r-stale', goal: 'g', title: 't', tasks: [] });
    store.createTasks([{ id: 't-stale', projectId: project.id, planId: 'pl-stale', runId: 'r-stale', seq: 1, title: 't', acceptance: ['A'], status: 'blocked' }]);
    store.updateTask('t-stale', { worktree_path: wt, branch: 'wb/t1', base_commit: 'HEAD', session_id: 's1', verification_json: { checkpoint: old } });
    const p = store.getProject(project.id); // createProject above may return existing; ensure same id
    await o.resumeRun('r-stale', { retryFailed: true });
    assert.equal(fs.readFileSync(path.join(wt, 'partial.js'), 'utf8'), 'newer\n', '旧归档不得覆盖较新文件');
  } finally { try { await o?.cancelRun('r-stale'); } catch { /* ignore */ } store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
