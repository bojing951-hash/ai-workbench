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
    // 过期 run 租约必须能被新 fence 接管，否则恢复会永久卡住。
    store.db.prepare("UPDATE runs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='run1'").run();
    const runTakeover = store.setRunLeaseFenced('run1', 'wb:C', takeover.fence + 1, 60_000);
    assert.equal(runTakeover.ok, true, '过期 run 租约应可被更高 fence 接管');
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

test('v2.7 故障注入：启动恢复只清死亡进程租约，不抢活进程租约', () => {
  const { store } = mk();
  try {
    store.createProject({ id: 'pdead', name: 'dead', localPath: '/tmp/none', testCommand: 'true' });
    store.createProject({ id: 'plive', name: 'live', localPath: '/tmp/none2', testCommand: 'true' });
    const dead = store.acquireProjectLeaseFenced('pdead', 'wb:999999:mwiw:dead', 30 * 60 * 1000);
    const live = store.acquireProjectLeaseFenced('plive', `wb:${process.pid}:mwiw:live`, 30 * 60 * 1000);
    assert.equal(dead.ok, true); assert.equal(live.ok, true);
    const cleaned = store.clearLeasesFromDeadProcesses();
    assert.equal(cleaned.projects, 1);
    assert.equal(store.getProjectLease('pdead').write_owner, '', '死亡进程租约必须清理');
    assert.equal(store.getProjectLease('plive').write_owner, `wb:${process.pid}:mwiw:live`, '活进程租约不得被清理');
  } finally { store.close(); }
});

test('v2.7 故障注入：启动恢复不得把另一个活 Workbench 进程的 running run 标成 interrupted', async () => {
  const { config, store } = mk();
  try {
    const { Orchestrator } = await import('../src/orchestrator.js');
    const { EventBus } = await import('../src/bus.js');
    store.createProject({ id: 'plive2', name: 'live2', localPath: '/tmp/none3', testCommand: 'true' });
    const lease = store.acquireProjectLeaseFenced('plive2', `wb:${process.pid}:other-live`, 60_000);
    assert.equal(lease.ok, true);
    store.createRun({ id: 'run-live', projectId: 'plive2', planId: 'pl1', goal: 'g', mode: 'single', status: 'running' });
    store.createTasks([{ id: 't-live', projectId: 'plive2', planId: 'pl1', runId: 'run-live', seq: 1, title: 't', acceptance: ['a'], testCommand: 'true', status: 'coding' }]);
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'claude', runAudit: async () => ({}), checkAgents: async () => [] } });
    const res = o.recoverOrphans();
    assert.ok(res.skippedLiveOwners.includes('run-live'), '必须跳过活 owner 的 run');
    assert.equal(store.getRun('run-live').status, 'running', '活 owner 的 run 不得被标 interrupted');
  } finally { store.close(); }
});

test('v2.7 故障注入：启动恢复不得把另一个活 Workbench 进程的 running loop 标成 interrupted', async () => {
  const { config, store } = mk();
  try {
    const { LoopManager } = await import('../src/loop.js');
    const { EventBus } = await import('../src/bus.js');
    store.createProject({ id: 'plive3', name: 'live3', localPath: '/tmp/none4', testCommand: 'true' });
    store.acquireProjectLeaseFenced('plive3', `wb:${process.pid}:other-live-loop`, 60_000);
    store.createLoop({ id: 'loop-live', projectId: 'plive3', goal: 'g', mode: 'plan', maxRounds: 2 });
    const m = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => ({}) } });
    const res = m.recover();
    assert.ok(res.skipped.includes('loop-live'));
    assert.equal(store.getLoop('loop-live').status, 'running');
  } finally { store.close(); }
});
