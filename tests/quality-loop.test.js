// SPDX-License-Identifier: Apache-2.0
/** v2.7：质量闭环真实 LoopManager 集成（隐藏质量命令 → 自动修复任务 → 重新评估 → 通过停止）。 */
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quality-loop-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'quality-test');
  git('config', 'user.email', 'quality@test');
  fs.writeFileSync(path.join(repo, 'quality-check.cjs'), `const fs=require('fs');const pass=fs.existsSync('QUALITY_PASS');const out={requirements:[{id:'R1',status:pass?'pass':'fail',evidence:pass?'隐藏测试 R1 通过':'隐藏测试 R1 失败：expected 3 got 2',issues:pass?[]:[{id:'I1',title:'核心计算错误',priority:'P0',evidence:'隐藏测试 R1 失败：expected 3 got 2'}]},{id:'R2',status:pass?'pass':'unproven',evidence:pass?'隐藏测试 R2 通过':''}]};console.log(JSON.stringify(out));`);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# quality fixture\n');
  git('add', '-A'); git('commit', '-qm', 'freeze');
  return { root, repo, git };
}

test('v2.7 质量闭环：有证据失败自动排队修复；全部需求 PASS 后完成', async () => {
  const { root, repo, git } = mkRepo();
  const config = getConfig({
    root,
    paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') },
    llm: { openai: { apiKey: '' }, glm: { apiKey: 'k' }, deepseek: { apiKey: 'k' } }, github: { token: '' },
  });
  const store = openStore(config.paths.dbPath);
  try {
    const project = store.createProject({
      id: 'p1', name: 'quality integration', localPath: repo, testCommand: 'true', ciRequired: false,
      config: { quality: { quality_command: 'node quality-check.cjs', sandbox: 'off', host_isolation_acknowledged: true, require_clause_evidence: false, max_cycles: 2, requirements: [
        { id: 'R1', title: '核心计算', priority: 'P0', acceptance: ['隐藏测试通过'] },
        { id: 'R2', title: '边界', priority: 'P1', acceptance: ['边界通过'] },
      ] } },
    });
    const loop = store.createLoop({ id: 'loop1', projectId: project.id, goal: 'quality', mode: 'queue', maxRounds: 3, queue: [] });
    const bus = new EventBus();
    const manager = new LoopManager({ config, store, bus, orchestrator: { emit: () => {}, startRun: async () => ({}) } });
    const commit = git('rev-parse', 'HEAD');
    const branch = 'wb/plan-quality';
    git('branch', branch, commit);
    const run = store.createRun({ id: 'run1', projectId: project.id, planId: 'plan1', goal: 'round1', mode: 'single', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
    store.createTasks([{ id: 't1', projectId: project.id, planId: 'plan1', runId: run.id, seq: 1, title: '初版', acceptance: ['a'], testCommand: 'true', status: 'passed', branch, headCommit: commit }]);
    store.updateTask('t1', { branch, head_commit: commit });
    store.updateRun(run.id, { result_json: { planBranch: branch, planHead: commit } });
    const runFresh = store.getRun(run.id);
    store.createAudit({ id: 'aud1', runId: run.id, taskId: 't1', provider: 'deepseek', model: 'deepseek', verdict: 'pass', score: 100, criteria: [{ criterion: 'a', status: 'pass', evidence: 'x' }], verificationStatus: 'PASS' });
    const first = await manager.completeRound(loop, project, runFresh);
    assert.equal(first, undefined);
    let updated = store.getLoop(loop.id);
    assert.equal(updated.status, 'running');
    assert.ok(updated.queue_json.some((t) => /Quality P0/.test(t.title)), '有证据 P0 应生成修复任务');
    assert.equal(updated.history_json.at(-1).quality.allPass, false);
    assert.ok(updated.history_json.at(-1).quality.issues.some((i) => i.id === 'I1' && i.evidence));
    // 模拟 Claude Code 修复后重跑：写入质量通过标记和新的 commit
    fs.writeFileSync(path.join(repo, 'QUALITY_PASS'), '1\n');
    git('add', '-A'); git('commit', '-qm', 'quality fix');
    const commit2 = git('rev-parse', 'HEAD');
    const branch2 = 'wb/plan-quality2';
    git('branch', branch2, commit2);
    const run2 = store.createRun({ id: 'run2', projectId: project.id, planId: 'plan2', goal: 'round2', mode: 'single', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
    store.createTasks([{ id: 't2', projectId: project.id, planId: 'plan2', runId: run2.id, seq: 1, title: '修复', acceptance: ['a'], testCommand: 'true', status: 'passed', branch: branch2, headCommit: commit2 }]);
    store.updateTask('t2', { branch: branch2, head_commit: commit2 });
    store.updateRun(run2.id, { result_json: { planBranch: branch2, planHead: commit2 } });
    const run2Fresh = store.getRun(run2.id);
    // 模拟下一轮 tick：修复任务已被消费，第二轮后达到 max_rounds。
    updated = store.updateLoop(loop.id, { max_rounds: 2, queue_json: [] });
    await manager.completeRound(updated, project, run2Fresh);
    updated = store.getLoop(loop.id);
    assert.equal(updated.status, 'completed');
    assert.equal(updated.history_json.at(-1).quality.allPass, true);
  } finally { store.close(); }
});
