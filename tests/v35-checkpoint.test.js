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
  fs.writeFileSync(path.join(wt, 'exec.sh'), '#!/bin/sh\necho hi\n'); fs.chmodSync(path.join(wt, 'exec.sh'), 0o755);
  fs.symlinkSync('tracked.js', path.join(wt, 'safe-link.js'));
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
    const v = await o.verifyAndRestoreCheckpoint(meta, restored);
    assert.equal(v.manifestHash, meta.manifestHash);
    assert.equal(fs.readFileSync(path.join(restored, 'tracked.js'), 'utf8'), 'v2 tracked change\n');
    assert.equal(fs.readFileSync(path.join(restored, 'staged.js'), 'utf8'), 'staged content\n');
    assert.equal(fs.readFileSync(path.join(restored, 'untracked.js'), 'utf8'), 'untracked content\n');
    assert.equal(fs.readFileSync(path.join(restored, 'dir', 'nested.txt'), 'utf8'), 'nested\n');
    assert.equal(fs.statSync(path.join(restored, 'exec.sh')).mode & 0o777, 0o755);
    assert.equal(fs.readlinkSync(path.join(restored, 'safe-link.js')), 'tracked.js');
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
    await assert.rejects(() => o.verifyAndRestoreCheckpoint(meta, path.join(root, 'restored2')), /CHECKPOINT_CORRUPT|哈希|大小不匹配/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v35 Checkpoint：Git Index 恢复到新 Worktree，且路径穿越/陈旧归档被阻断', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-index-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; };
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'v1\n'); fs.writeFileSync(path.join(repo, 'README.md'), '# p\n');
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const wt = path.join(root, 'wt'); git(['worktree', 'add', '-b', 'wb/t1', wt, 'HEAD']);
  fs.writeFileSync(path.join(wt, 'tracked.js'), 'v2\n'); fs.writeFileSync(path.join(wt, 'staged.js'), 'staged\n'); git(['add', 'staged.js'], wt);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') } });
  const store = openStore(config.paths.dbPath);
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {} });
    const meta = await o.saveWorktreeCheckpoint({ run: { id: 'r-index' }, task: { id: 't-index' }, project: { id: 'p-index', local_path: repo }, worktree: wt });
    assert.ok(meta.indexTree, '必须保存 Git index tree');
    const wt2 = path.join(root, 'wt2'); git(['worktree', 'add', '-b', 'wb/t2', wt2, 'HEAD']);
    await o.verifyAndRestoreCheckpoint(meta, wt2);
    const staged = git(['diff', '--cached', '--name-only'], wt2).stdout.trim();
    assert.match(staged, /staged\.js/);
    // 路径穿越：篡改 manifest 并重算 meta hash，仍必须拒绝。
    const parsed = JSON.parse(fs.readFileSync(meta.manifestFile, 'utf8'));
    parsed.manifest.push({ type: 'file', path: '../escape.txt', size: 1, mode: 420, sha256: '0'.repeat(64) });
    fs.writeFileSync(meta.manifestFile, JSON.stringify(parsed));
    const badMeta = { ...meta, manifestHash: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(parsed.manifest)).digest('hex') };
    await assert.rejects(() => o.verifyAndRestoreCheckpoint(badMeta, path.join(root, 'restore-bad')), /PATH_TRAVERSAL|越界|路径非法/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v35 Checkpoint：目标父目录符号链接/目标符号链接禁止恢复，外部无写入', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-escape-'));
  try {
    const { getConfig } = await import('../src/config.js');
    const { openStore } = await import('../src/db.js');
    const { EventBus } = await import('../src/bus.js');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x'); spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const wt = path.join(root, 'wt'); fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, 'a.txt'), 'x');
    const dataDir = path.join(root, 'data');
    const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 't.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(dataDir, 'w'), artifactsDir: path.join(dataDir, 'a'), logsDir: path.join(dataDir, 'l'), agentsDir: path.join(dataDir, 'ag'), dshHome: path.join(dataDir, 'ag/dsh'), claudeHome: path.join(dataDir, 'ag/claude') } });
    const store = openStore(config.paths.dbPath);
    try {
      const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {} });
      const meta = await o.saveWorktreeCheckpoint({ run: { id: 'r' }, task: { id: 't' }, project: { id: 'p' }, worktree: wt });
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      const linkParent = path.join(root, 'link'); fs.symlinkSync(outside, linkParent);
      await assert.rejects(() => o.verifyAndRestoreCheckpoint(meta, path.join(linkParent, 'target')), /PARENT_SYMLINK|符号链接/);
      assert.equal(fs.existsSync(path.join(outside, 'a.txt')), false);
      const targetLink = path.join(root, 'target-link'); fs.symlinkSync(outside, targetLink);
      await assert.rejects(() => o.verifyAndRestoreCheckpoint(meta, targetLink), /TARGET_SYMLINK|符号链接/);
      assert.equal(fs.existsSync(path.join(outside, 'a.txt')), false);
    } finally { store.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('v35 Checkpoint：未完成发布可由新进程恢复（完整新版/回滚旧版）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-journal-'));
  const dataDir = path.join(root, 'data');
  const { getConfig } = await import('../src/config.js');
  const { openStore } = await import('../src/db.js');
  const { EventBus } = await import('../src/bus.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 't.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(dataDir, 'w'), artifactsDir: path.join(dataDir, 'a'), logsDir: path.join(dataDir, 'l'), agentsDir: path.join(dataDir, 'ag'), dshHome: path.join(dataDir, 'ag/dsh'), claudeHome: path.join(dataDir, 'ag/claude') } });
  const store = openStore(config.paths.dbPath);
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {} });
    const target = path.join(root, 'target'); const staging = path.join(root, 'staging'); const backup = path.join(root, 'backup');
    fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'new.txt'), 'new');
    fs.mkdirSync(backup); fs.writeFileSync(path.join(backup, 'old.txt'), 'old');
    const jdir = path.join(dataDir, 'checkpoints', '.publish'); fs.mkdirSync(jdir, { recursive: true });
    const jfile = path.join(jdir, 'j1.json'); fs.writeFileSync(jfile, JSON.stringify({ target, staging, backup, state: 'backed-up' }));
    const rec = o.recoverCheckpointPublications();
    assert.equal(rec.blocked.length, 0);
    assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.existsSync(backup), false);
    // 回滚：target 不存在，staging 缺失，backup 完整
    const target2 = path.join(root, 'target2'); const backup2 = path.join(root, 'backup2'); fs.mkdirSync(backup2); fs.writeFileSync(path.join(backup2, 'old.txt'), 'old');
    fs.writeFileSync(path.join(jdir, 'j2.json'), JSON.stringify({ target: target2, staging: path.join(root, 'staging2'), backup: backup2, state: 'backed-up' }));
    const rec2 = o.recoverCheckpointPublications();
    assert.equal(rec2.blocked.length, 0);
    assert.equal(fs.readFileSync(path.join(target2, 'old.txt'), 'utf8'), 'old');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
