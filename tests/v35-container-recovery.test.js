// SPDX-License-Identifier: Apache-2.0
/** v3.5：容器生命周期登记/孤儿回收（真实 Docker，若不可用则跳过）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { buildDockerArgs, containerCapabilities, cleanupOrphanContainers } from '../src/container.js';
import { execCapture } from '../src/runner.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-container-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') } });
  return { root, config, store: openStore(config.paths.dbPath) };
}

test('v3.5 容器参数包含 Run/Task/Project/Owner/Fence 标签', () => {
  const h = mk();
  try {
    const args = buildDockerArgs({
      image: 'ai-workbench-runtime:2.2', worktree: h.root, command: 'true',
      labels: { 'ai-workbench.run-id': 'run-1', 'ai-workbench.task-id': 'task-1', 'ai-workbench.project-id': 'p-1', 'ai-workbench.owner': 'wb:1:x', 'ai-workbench.fence': '3' },
    });
    const joined = args.join(' ');
    for (const x of ['ai-workbench.run-id=run-1', 'ai-workbench.task-id=task-1', 'ai-workbench.project-id=p-1', 'ai-workbench.owner=wb:1:x', 'ai-workbench.fence=3']) assert.ok(joined.includes(x), x);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v3.5 启动恢复清理无有效执行者的 Workbench 容器，保留未知标签容器', { timeout: 180_000, skip: !containerCapabilities(getConfig()).testExecution }, async () => {
  const h = mk();
  const cc = { dockerBin: getConfig().isolation.container.dockerBin, image: getConfig().isolation.container.image };
  let orphan;
  try {
    const run = await execCapture(cc.dockerBin, ['run', '-d', '--label', 'ai-workbench.container=1', '--label', 'ai-workbench.run-id=missing-run', '--label', 'ai-workbench.project-id=missing-project', '--label', 'ai-workbench.owner=wb:999999:dead', '--name', `wb-v35-orphan-${Date.now()}`, cc.image, 'sleep', '60'], { timeoutMs: 120_000 });
    assert.equal(run.code, 0, run.stderr);
    orphan = run.stdout.trim();
    assert.ok(orphan);
    const res = await cleanupOrphanContainers({ config: h.config, store: h.store });
    assert.ok(res.removed.some((x) => orphan.startsWith(x.id)), `应清理孤儿容器 ${orphan}`);
    const check = await execCapture(cc.dockerBin, ['inspect', orphan], { timeoutMs: 10_000 });
    assert.notEqual(check.code, 0, '孤儿容器必须已被移除');
  } finally {
    if (orphan) { try { await execCapture(cc.dockerBin, ['rm', '-f', orphan], { timeoutMs: 10_000 }); } catch { /* ignore */ } }
    h.store.close(); fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('v3.5 启动恢复不得清理仍有有效 owner+fence 的活执行者容器', { timeout: 60_000, skip: !containerCapabilities(getConfig()).testExecution }, async () => {
  const h = mk();
  const cfg = getConfig();
  const cc = { dockerBin: cfg.isolation.container.dockerBin, image: cfg.isolation.container.image };
  const owner = `wb:${process.pid}:live`;
  h.store.createProject({ id: 'p-live', name: 'live', localPath: h.root, defaultBranch: 'main' });
  h.store.createRun({ id: 'r-live', projectId: 'p-live', planId: 'pl-live', goal: 'g', mode: 'single', status: 'running' });
  const lease = h.store.acquireProjectLeaseFenced('p-live', owner, 60 * 60 * 1000);
  let cid;
  try {
    const run = await execCapture(cc.dockerBin, ['run', '-d', '--label', 'ai-workbench.container=1', '--label', 'ai-workbench.run-id=r-live', '--label', 'ai-workbench.project-id=p-live', '--label', `ai-workbench.owner=${owner}`, '--label', `ai-workbench.fence=${lease.fence}`, '--name', `wb-v35-live-${Date.now()}`, cc.image, 'sleep', '60'], { timeoutMs: 120_000 });
    assert.equal(run.code, 0, run.stderr); cid = run.stdout.trim();
    const res = await cleanupOrphanContainers({ config: h.config, store: h.store });
    assert.ok(res.skipped.some((x) => cid.startsWith(x.id)), '活执行者的容器必须被保留');
    const check = await execCapture(cc.dockerBin, ['inspect', cid], { timeoutMs: 10_000 });
    assert.equal(check.code, 0, '活容器不得被删除');
  } finally {
    if (cid) { try { await execCapture(cc.dockerBin, ['rm', '-f', cid], { timeoutMs: 10_000 }); } catch { /* ignore */ } }
    h.store.close(); fs.rmSync(h.root, { recursive: true, force: true });
  }
});
