// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Every Workbench operation runs in a fresh process, with one disposable Git/SQLite fixture.
// Recovery invokes the publication reconciler used by "workbench serve", without starting Docker.
const configURL = new URL('../src/config.js', import.meta.url).href;
const dbURL = new URL('../src/db.js', import.meta.url).href;
const busURL = new URL('../src/bus.js', import.meta.url).href;
const orchestratorURL = new URL('../src/orchestrator.js', import.meta.url).href;
const imports = `
  import { getConfig } from ${JSON.stringify(configURL)};
  import { openStore } from ${JSON.stringify(dbURL)};
  import { EventBus } from ${JSON.stringify(busURL)};
  import { Orchestrator } from ${JSON.stringify(orchestratorURL)};
  import fs from 'node:fs';
  const config = getConfig();
  const store = openStore(config.paths.dbPath);
  const o = new Orchestrator({config, store, bus: new EventBus(), deps: {}});
  const [repo, source, target, archive] = process.argv.slice(1);
`;
for (const missingIndex of [false, true]) {
  test('checkpoint publication after rename, staged index ' + (missingIndex ? 'missing' : 'present'), {timeout: 45_000}, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-accept-checkpoint-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const repo = path.join(root, 'repo');
    const target = path.join(root, 'target');
    const source = path.join(root, 'source');
    const archive = path.join(root, 'archive.json');
    const data = path.join(root, 'data');
    const marker = path.join(root, 'paused');
    const env = {PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: data, WORKBENCH_PROJECTS_DIR: path.join(root, 'projects')};
    function git(cwd, ...args) {
      const r = spawnSync('git', args, {cwd, env, encoding: 'utf8'});
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    }
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repo, 'item.txt'), 'A\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    git(repo, 'worktree', 'add', '-qb', 'wb/source', source);
    git(repo, 'worktree', 'add', '-qb', 'wb/target', target);
    fs.writeFileSync(path.join(source, 'item.txt'), 'B\n');
    git(source, 'add', 'item.txt');
    fs.writeFileSync(path.join(source, 'item.txt'), 'C\n');
    const args = (body) => ['--input-type=module', '-e', imports + body, repo, source, target, archive];
    function run(body) {
      const r = spawnSync(process.execPath, args(body), {cwd: root, env, encoding: 'utf8', timeout: 12_000});
      assert.equal(r.status, 0, String(r.error || r.stderr)); return r.stdout;
    }
    run(`
      const m = await o.saveWorktreeCheckpoint({run:{id:'r'},task:{id:'t',branch:'wb/source'},project:{id:'p',local_path:repo},worktree:source});
      fs.writeFileSync(archive, JSON.stringify(m)); store.close();
    `);
    const child = spawn(process.execPath, args('await o.verifyAndRestoreCheckpoint(JSON.parse(fs.readFileSync(archive)),target);'),
      {cwd:root, env:{...env, CHECKPOINT_TEST_PAUSE_STATE:'renamed', CHECKPOINT_TEST_MARKER:marker}, stdio:'ignore'});
    const exited = once(child, 'close');
    try {
      const deadline = Date.now() + 12_000;
      while (!fs.existsSync(marker) && child.exitCode === null && Date.now() < deadline) await delay(20);
      assert.ok(fs.existsSync(marker), 'publisher must reach the existing post-rename crash hook');
    } finally {
      child.kill('SIGKILL'); await exited;
    }
    const dir = path.join(data, 'checkpoints', '.publish');
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const journalPath = path.join(dir, files[0]);
    const journal = JSON.parse(fs.readFileSync(journalPath));
    assert.equal(git(target, 'show', ':item.txt'), 'A');
    assert.equal(fs.readFileSync(path.join(target, 'item.txt'), 'utf8'), 'C\n');
    if (missingIndex) fs.unlinkSync(journal.stagingIndex);
    for (let start = 0; start < 2; start++) {
      const report = JSON.parse(run('console.log(JSON.stringify(o.recoverCheckpointPublications())); store.close();').trim());
      const index = git(target, 'show', ':item.txt');
      const disk = fs.readFileSync(path.join(target, 'item.txt'), 'utf8');
      if (missingIndex && report.blocked.length) {
        assert.ok(fs.existsSync(journalPath) && fs.existsSync(journal.backup), 'unresolved publication must preserve recovery evidence');
      } else {
        assert.equal(report.blocked.length, 0);
        assert.equal(disk, 'C\n');
        assert.equal(index, 'B', 'cleared publication must have the verified staged version, even after a second start');
        assert.ok(!fs.existsSync(journalPath), 'a fully recovered publication clears the journal');
      }
    }
  });
}
