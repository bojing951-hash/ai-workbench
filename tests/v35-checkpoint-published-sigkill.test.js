// SPDX-License-Identifier: Apache-2.0
/** v3.8：Checkpoint 发布在 backed-up 边界真实 SIGKILL 后，由新进程恢复到完整新版。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

test('v38 Checkpoint：published 边界 SIGKILL 后保持完整新版', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v38-ckptkill-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; };
  fs.writeFileSync(path.join(repo, 'item.txt'), 'old\n'); git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const paths = { root, dataDir, dbPath: path.join(dataDir, 't.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(dataDir, 'w'), artifactsDir: path.join(dataDir, 'a'), logsDir: path.join(dataDir, 'l'), agentsDir: path.join(dataDir, 'ag'), dshHome: path.join(dataDir, 'ag/dsh'), claudeHome: path.join(dataDir, 'ag/claude') };
  const config = getConfig({ root, paths });
  const store = openStore(config.paths.dbPath);
  const oldWt = path.join(dataDir, 'old'); const newWt = path.join(dataDir, 'new');
  git(['worktree', 'add', '-b', 'wb/old', oldWt, 'HEAD']); git(['worktree', 'add', '-b', 'wb/new', newWt, 'HEAD']);
  fs.writeFileSync(path.join(newWt, 'item.txt'), 'new-workfile\n'); git(['add', '-A'], newWt);
  const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {} });
  const meta = await o.saveWorktreeCheckpoint({ run: { id: 'r-kill' }, task: { id: 't-kill', branch: 'wb/new' }, project: { id: 'p-kill', local_path: repo }, worktree: newWt });
  const marker = path.join(root, 'paused');
  const childCode = `
import { getConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
import { openStore } from ${JSON.stringify(new URL('../src/db.js', import.meta.url).href)};
import { EventBus } from ${JSON.stringify(new URL('../src/bus.js', import.meta.url).href)};
import { Orchestrator } from ${JSON.stringify(new URL('../src/orchestrator.js', import.meta.url).href)};
const config=getConfig({root:process.argv[1],paths:JSON.parse(process.argv[2])});
const store=openStore(config.paths.dbPath);
const o=new Orchestrator({config,store,bus:new EventBus(),deps:{}});
await o.verifyAndRestoreCheckpoint(JSON.parse(process.argv[3]),process.argv[4]);
`;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', childCode, root, JSON.stringify(paths), JSON.stringify(meta), oldWt], { cwd: path.join(root), env: { ...process.env, CHECKPOINT_TEST_PAUSE_STATE: 'published', CHECKPOINT_TEST_MARKER: marker }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const end = Date.now() + 15_000; while (!fs.existsSync(marker) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(marker), '必须到达 backed-up 边界');
    child.kill('SIGKILL'); await new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('close', r); });
    const store2 = openStore(config.paths.dbPath);
    try {
      const o2 = new Orchestrator({ config, store: store2, bus: new EventBus(), deps: {} });
      const rec = o2.recoverCheckpointPublications();
      assert.equal(rec.blocked.length, 0, JSON.stringify(rec.blocked));
      assert.equal(fs.readFileSync(path.join(oldWt, 'item.txt'), 'utf8'), 'new-workfile\n');
      const idx = spawnSync('git', ['show', ':item.txt'], { cwd: oldWt, encoding: 'utf8' });
      assert.equal(idx.status, 0, idx.stderr);
      assert.equal(idx.stdout, 'new-workfile\n', 'Index 必须是完整新版');
    } finally { store2.close(); }
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
