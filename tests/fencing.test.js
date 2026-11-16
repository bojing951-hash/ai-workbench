// SPDX-License-Identifier: Apache-2.0
/** v2.7：单写租约 + 单调 Fencing Token（真实多进程竞争/崩溃/接管）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fencing-'));
  const config = getConfig({
    root,
    paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') },
    llm: { openai: { apiKey: '' }, glm: { apiKey: 'k' }, deepseek: { apiKey: 'k' } },
    github: { token: '' },
  });
  const store = openStore(config.paths.dbPath);
  return { config, store, root };
}

test('v2.7 fencing：单调 token、过期接管、旧执行者不能续租/写/释放', () => {
  const { store } = mk();
  try {
    store.createProject({ id: 'p1', name: 'p', localPath: '/tmp/none', testCommand: 'true' });
    const first = store.acquireProjectLeaseFenced('p1', 'wb:A', 60_000);
    assert.equal(first.ok, true);
    assert.ok(first.fence >= 1);
    const second = store.acquireProjectLeaseFenced('p1', 'wb:B', 60_000);
    assert.equal(second.ok, false, '有效租约期间第二个执行者必须失败');
    assert.equal(store.renewProjectLeaseFenced('p1', 'wb:A', first.fence + 1, 60_000), false, '错误 token 不能续租');
    // 模拟崩溃：过期后不释放，新执行者接管并得到更高 token
    store.db.prepare("UPDATE projects SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='p1'").run();
    const takeover = store.acquireProjectLeaseFenced('p1', 'wb:B', 60_000);
    assert.equal(takeover.ok, true);
    assert.ok(takeover.fence > first.fence, 'fence 必须单调递增');
    assert.equal(store.renewProjectLeaseFenced('p1', 'wb:A', first.fence, 60_000), false, '旧执行者续租必须失败');
    assert.equal(store.releaseProjectLeaseFenced('p1', 'wb:A', first.fence), false, '旧执行者不能释放新租约');
    // Run 租约不能被旧 fence 覆盖
    store.createRun({ id: 'run1', projectId: 'p1', planId: 'plan1', goal: 'g', status: 'running' });
    const runThird = store.setRunLeaseFenced('run1', 'wb:B', takeover.fence, 60_000);
    assert.equal(runThird.ok, true);
    const stale = store.setRunLeaseFenced('run1', 'wb:A', first.fence, 60_000);
    assert.equal(stale.ok, false, '旧 fence 不得覆盖 Run 租约');
    assert.equal(store.releaseProjectLeaseFenced('p1', 'wb:B', takeover.fence), true);
  } finally { store.close(); }
});

function acquireScript(dbPath, owner, ttlMs) {
  return `import { openStore } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src', 'db.js')).href)};
const store = openStore(${JSON.stringify(dbPath)});
const r = store.acquireProjectLeaseFenced('p1', ${JSON.stringify(owner)}, ${ttlMs});
console.log(JSON.stringify(r));
store.close();`;
}

function runChild(root, source) {
  const file = path.join(root, `child-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, source);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', file], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: out.trim(), err }));
  });
}

test('v2.7 fencing：两个独立进程竞争同一项目，只有一个获得写权', async () => {
  const { config, store, root } = mk();
  try {
    store.createProject({ id: 'p1', name: 'p', localPath: '/tmp/none', testCommand: 'true' });
    const source = acquireScript(config.paths.dbPath, 'wb:child', 60_000).replace("acquireProjectLeaseFenced('p1', \"wb:child\", 60000)", "acquireProjectLeaseFenced('p1', process.argv[2], 60000)");
    // 用两个不同 owner 并发启动；均只读输出自己的结果，不写业务表。
    const a = runChild(root, source.replace(/process\.argv\[2\]/g, '"wb:proc-A"'));
    const b = runChild(root, source.replace(/process\.argv\[2\]/g, '"wb:proc-B"'));
    const results = await Promise.all([a, b]);
    for (const r of results) assert.equal(r.code, 0, r.err);
    const parsed = results.map((r) => JSON.parse(r.out));
    assert.equal(parsed.filter((x) => x.ok).length, 1, '两个独立进程只能有一个取得租约');
    const winner = parsed.find((x) => x.ok);
    assert.ok(winner.fence >= 1);
  } finally { store.close(); }
});
