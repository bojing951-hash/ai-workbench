// SPDX-License-Identifier: Apache-2.0
/** v2.7 P1-A：plan 模式质量修复任务也进入执行队列。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { LoopManager } from '../src/loop.js';

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plan-q-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x'); git('add', '-A'); git('commit', '-qm', 'base'); return { root, repo, git };
}

test('v2.7 P1-A：plan 模式发现 P0 质量缺陷后仍生成修复任务队列', async () => {
  const { root, repo, git } = mkRepo();
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    const repoPath = repo;
    const project = store.createProject({ id: 'p1', name: 'plan quality', localPath: repoPath, testCommand: 'true', ciRequired: false, config: { quality: { quality_command: `node -e "console.log(JSON.stringify({requirements:[{id:'R1',status:'fail',evidence:'hidden regression evidence 123',issues:[{id:'Q1',title:'plan bug',priority:'P0',evidence:'hidden regression evidence 123'}]}]}))"`, max_cycles: 2, requirements: [{ id: 'R1', title: 'must', priority: 'P0', acceptance: ['ok'] }] } } });
    const loop = store.createLoop({ id: 'loop-plan', projectId: project.id, goal: 'plan mode', mode: 'plan', maxRounds: 4, queue: [] });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => ({}) } });
    const commit = git('rev-parse', 'HEAD'); const branch = 'wb/plan-mode'; git('branch', branch, commit);
    const run = store.createRun({ id: 'run-plan', projectId: project.id, planId: 'plan1', goal: 'g', mode: 'single', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
    store.createTasks([{ id: 't-plan', projectId: project.id, planId: 'plan1', runId: run.id, seq: 1, title: 'agent task', acceptance: ['ok'], testCommand: 'true', status: 'passed' }]);
    store.updateTask('t-plan', { branch, head_commit: commit }); store.updateRun(run.id, { result_json: { planBranch: branch, planHead: commit } });
    const fresh = store.getRun(run.id);
    const updated = store.getLoop(loop.id);
    assert.equal(updated.mode, 'plan');
    await manager.completeRound(updated, project, fresh);
    const after = store.getLoop(loop.id);
    assert.equal(after.status, 'running');
    assert.ok((after.queue_json || []).some((t) => t.qualityIssueId === 'Q1'), 'plan 模式必须排队质量修复任务');
    assert.equal(after.history_json.at(-1)?.quality?.allPass, false);
  } finally { store.close(); }
});

test('v2.7 P1-A：tick 启动 run 失败时质量修复任务必须放回队列，不丢失', async () => {
  const { root, repo } = mkRepo();
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    const project = store.createProject({ id: 'p2', name: 'queue loss', localPath: repo, testCommand: 'true', ciRequired: false, config: {} });
    const repair = { title: 'quality repair', qualityIssueId: 'Q1', acceptance: ['a'], agent: 'claude', testCommand: 'true' };
    store.createLoop({ id: 'loop-loss', projectId: project.id, goal: 'g', mode: 'plan', maxRounds: 4, queue: [repair] });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => { throw new Error('PROJECT_LEASE_HELD'); } } });
    await manager.tick('loop-loss');
    const after = store.getLoop('loop-loss');
    assert.equal(after.status, 'paused');
    assert.ok((after.queue_json || []).some((t) => t.qualityIssueId === 'Q1'), '失败后任务必须仍在队列');
    assert.match(after.stop_reason, /启动运行失败|PROJECT_LEASE_HELD/);
  } finally { store.close(); }
});
