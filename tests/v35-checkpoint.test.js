// SPDX-License-Identifier: Apache-2.0
/** v3.5 P0-2：真实 Git Worktree 的完整未提交检查点与恢复校验。 */
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

test('v3.5 Checkpoint：tracked/untracked/staged/unstaged 全部保存并可校验恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-checkpoint-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'v1\n'); fs.writeFileSync(path.join(repo, 'README.md'), '# p\n');
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const wt = path.join(root, 'wt'); git(['worktree', 'add', '-b', 'wb/t1', wt, 'HEAD']);
  fs.writeFileSync(path.join(wt, 'tracked.js'), 'v2 tracked change\n');
  fs.writeFileSync(path.join(wt, 'staged.js'), 'staged content\n'); git(['add', 'staged.js'], wt);
  fs.writeFileSync(path.join(wt, 'untracked.js'), 'untracked content\n');
  fs.mkdirSync(path.join(wt, 'dir'), { recursive: true }); fs.writeFileSync(path.join(wt, 'dir', 'nested.txt'), 'nested\n');
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') } });
  const store = openStore(config.paths.dbPath);
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {} });
    const project = { id: 'p-checkpoint', local_path: repo };
    const run = { id: 'r-checkpoint' }; const task = { id: 't-checkpoint', attempt: 2, session_id: 'sess-1', branch: 'wb/t1' };
    const meta = await o.saveWorktreeCheckpoint({ run, task, project, worktree: wt });
    assert.ok(meta.archive && fs.existsSync(meta.manifestFile));
    assert.ok(meta.files >= 4, `files=${meta.files}`);
    const restored = path.join(root, 'restored'); fs.mkdirSync(restored);
    const v = o.verifyAndRestoreCheckpoint(meta, restored);
    assert.equal(v.manifestHash, meta.manifestHash);
    assert.equal(fs.readFileSync(path.join(restored, 'tracked.js'), 'utf8'), 'v2 tracked change\n');
    assert.equal(fs.readFileSync(path.join(restored, 'staged.js'), 'utf8'), 'staged content\n');
    assert.equal(fs.readFileSync(path.join(restored, 'untracked.js'), 'utf8'), 'untracked content\n');
    assert.equal(fs.readFileSync(path.join(restored, 'dir', 'nested.txt'), 'utf8'), 'nested\n');
    // listTasks 必须解析 verification_json.checkpoint，恢复路径才能读取归档。
    store.createProject({ id: 'p-ckpt', name: 'ckpt', localPath: repo, defaultBranch: 'main' });
    store.createRun({ id: 'r-ckpt', projectId: 'p-ckpt', planId: 'pl-ckpt', goal: 'g', mode: 'single', status: 'paused' });
    store.createPlan({ id: 'pl-ckpt', projectId: 'p-ckpt', runId: 'r-ckpt', goal: 'g', title: 't', tasks: [] });
    store.createTasks([{ id: 't-ckpt', projectId: 'p-ckpt', planId: 'pl-ckpt', runId: 'r-ckpt', seq: 1, title: 't', acceptance: ['a'], status: 'blocked' }]);
    store.updateTask('t-ckpt', { worktree_path: wt, branch: 'wb/t1', session_id: 'sess-1', verification_json: { checkpoint: meta, keep_field: 42 } });
    const parsed = store.listTasks({ runId: 'r-ckpt' })[0];
    assert.equal(parsed.verification_json.checkpoint.archive, meta.archive);
    assert.equal(parsed.verification_json.keep_field, 42);
    // 篡改归档 -> 必须拒绝，不得静默恢复
    const target = path.join(meta.archive, 'untracked.js'); fs.writeFileSync(target, 'tampered\n');
    assert.throws(() => o.verifyAndRestoreCheckpoint(meta, path.join(root, 'restored2')), /CHECKPOINT_CORRUPT|哈希/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
