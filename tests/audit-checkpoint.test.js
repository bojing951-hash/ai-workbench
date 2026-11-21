// SPDX-License-Identifier: Apache-2.0
/** v3.8：Checkpoint 发布在 backed-up 边界真实 SIGKILL 后，由新进程恢复到完整新版。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

test('backed-up SIGKILL and two actual starts preserve staged/unstaged or block with evidence', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v38-ckptkill-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; };
  fs.writeFileSync(path.join(repo, 'item.txt'), 'old\n'); git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const paths = { root, dataDir, dbPath: path.join(dataDir, 'workbench.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(dataDir, 'w'), artifactsDir: path.join(dataDir, 'a'), logsDir: path.join(dataDir, 'l'), agentsDir: path.join(dataDir, 'ag'), dshHome: path.join(dataDir, 'ag/dsh'), claudeHome: path.join(dataDir, 'ag/claude') };
  const config = getConfig({ root, paths });
  const store = openStore(config.paths.dbPath);
  const oldWt = path.join(dataDir, 'old'); const newWt = path.join(dataDir, 'new');
  git(['worktree', 'add', '-b', 'wb/old', oldWt, 'HEAD']); git(['worktree', 'add', '-b', 'wb/new', newWt, 'HEAD']);
  fs.writeFileSync(path.join(newWt, 'item.txt'), 'B-staged\n'); git(['add', '-A'], newWt); fs.writeFileSync(path.join(newWt, 'item.txt'), 'C-workfile\n');
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
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', childCode, root, JSON.stringify(paths), JSON.stringify(meta), oldWt], { cwd: path.join(root), env: { ...process.env, CHECKPOINT_TEST_PAUSE_STATE: 'backed-up', CHECKPOINT_TEST_MARKER: marker }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const end = Date.now() + 15_000; while (!fs.existsSync(marker) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(marker), '必须到达 backed-up 边界');
    child.kill('SIGKILL'); await new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('close', r); });
    const journalDir = path.join(dataDir, 'checkpoints', '.publish');
    const journalFile = path.join(journalDir, fs.readdirSync(journalDir).find(n => n.endsWith('.json')));
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    assert.ok(fs.existsSync(journal.backup));
    assert.ok(!fs.existsSync(oldWt));
    fs.unlinkSync(journal.stagingIndex);
    const results = [];
    for (let restart = 1; restart <= 2; restart++) {
      const serve = spawn(process.execPath, [fileURLToPath(new URL('../bin/workbench.js', import.meta.url)), 'serve', '--port', '0'], {cwd: root,env:{PATH:process.env.PATH,LANG:'C',WORKBENCH_ROOT:root,WORKBENCH_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
      let stdout='', stderr='';
      serve.stdout.on('data',b=>{stdout+=b}); serve.stderr.on('data',b=>{stderr+=b});
      try {
        const until=Date.now()+8000;
        while(!stdout.includes('127.0.0.1:') && serve.exitCode===null && Date.now()<until) await new Promise(r=>setTimeout(r,20));
        const port = Number(stdout.match(/127[.]0[.]0[.]1:(\d+)/)?.[1]);
        assert.ok(port, [stdout,stderr].join(' '));
        const health=await fetch('http://127.0.0.1:'+port+'/api/health');
        assert.equal(health.status,200);
        results.push({restart,health:health.status,reportedRecovery:stdout.includes('未完成 Checkpoint 发布'),disk:fs.existsSync(path.join(oldWt,'item.txt')) ? fs.readFileSync(path.join(oldWt,'item.txt'),'utf8').trim() : null,index:fs.existsSync(oldWt) ? git(['show',':item.txt'],oldWt).stdout.trim() : null,backup:fs.existsSync(journal.backup),journal:fs.existsSync(journalFile)});
      } finally {
        if(serve.exitCode===null){const onexit=new Promise(r=>serve.once('exit',r));serve.kill('SIGTERM');await onexit;}
      }
    }
    console.log('RECOVERY_AUDIT', JSON.stringify(results));
    for (const row of results) {
      const consistent = row.disk === 'C-workfile' && row.index === 'B-staged';
      assert.ok(consistent || (row.backup && row.journal), 'incomplete index must preserve checkpoint recovery material');
    }
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
