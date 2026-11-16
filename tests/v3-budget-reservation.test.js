// SPDX-License-Identifier: Apache-2.0
/** v3.1 P1-2：预算原子预留；并发预留不能超过可用额度，结算/释放状态可审计。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { assertModelBudget, budgetSnapshot, recordModelUsage } from '../src/budget.js';

function mk(maxTokens = 10_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v31-reserve-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' }, budget: { maxTotalTokens: maxTokens, maxCostCny: 30, minReserveTokens: 0 } });
  return { root, config, store: openStore(config.paths.dbPath) };
}
test('v3.1 P1-2：并发预留受 SQLite 事务硬限制，结算后释放预留空间', () => {
  const { root, config, store } = mk(10_000);
  try {
    const a = store.reserveModelBudget({ id: 'res-a', requestKey: 'key-a', provider: 'deepseek', estimatedTokens: 6_000, estimatedCostCny: 0.01, maxTokens: 10_000, maxCostCny: 30, cacheTokenWeight: 0.1 });
    const b = store.reserveModelBudget({ id: 'res-b', requestKey: 'key-b', provider: 'deepseek', estimatedTokens: 6_000, estimatedCostCny: 0.01, maxTokens: 10_000, maxCostCny: 30, cacheTokenWeight: 0.1 });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false, '第二笔 6000 预留不得越过 10000 总额');
    assert.equal(store.reservedBudgetTotals().tokens, 6_000);
    assert.equal(budgetSnapshot(store, config).reservedTokens, 6_000);
    store.settleModelReservation('res-a', { actualTokens: 1_000, actualCostCny: 0.001, usageKnown: true });
    assert.equal(store.reservedBudgetTotals().tokens, 0);
    assert.equal(store.listModelReservations()[0].status, 'settled');
    // 预留请求键幂等
    const again = store.reserveModelBudget({ id: 'res-a2', requestKey: 'key-a', provider: 'deepseek', estimatedTokens: 6_000, maxTokens: 10_000, maxCostCny: 30 });
    assert.equal(again.existing, true);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.1 P1-2：Chat 使用原子预留并在成功后结算；未知卖家身份不享受 GLM 豁免', async () => {
  const { root, config, store } = mk(100_000);
  try {
    const b = assertModelBudget({ config, store, provider: 'deepseek', estimatedTokens: 1600, estimatedCostCny: 0.01, reserve: true, requestKey: 'chat-res-1' });
    assert.ok(b.reservation?.id);
    assert.equal(store.listModelReservations()[0].status, 'reserved');
    recordModelUsage({ store, config, source: 'chat', sourceId: 'chat-res-usage', provider: 'deepseek', usage: { input: 10, output: 5 }, costCny: 0.0001, reservationId: b.reservation.id });
    const row = store.listModelReservations().find((x) => x.id === b.reservation.id);
    assert.equal(row.status, 'settled');
    assert.equal(Number(row.actual_tokens), 15);
    assert.throws(() => assertModelBudget({ config, store, provider: 'glm', estimatedTokens: 200_000, estimatedCostCny: 1 }), /预算不足|预留失败/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.1 P0-1：预算/超时暂停不能被“继续开发”自动解除；必须显式授权', async () => {
  const { config, store, root } = mk(100_000);
  const { EventBus } = await import('../src/bus.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  try {
    store.createProject({ id: 'p-budget-pause', name: 'budget pause', localPath: '/tmp/none', testCommand: 'true' });
    store.createRun({ id: 'r-budget-pause', projectId: 'p-budget-pause', planId: 'pl', goal: 'g', mode: 'single', status: 'paused', pauseKind: 'budget' });
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => { throw new Error('no'); }, runAudit: async () => { throw new Error('no'); }, chooseAgent: async () => 'dsh', checkAgents: async () => [] } });
    await assert.rejects(o.resumeRun('r-budget-pause'), /RUN_PAUSED_BY_BUDGET|预算/);
    assert.equal(store.getRun('r-budget-pause').status, 'paused');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});


test('v3.1 P1-2：两个独立 Node 进程并发预留，硬额度内只能一个成功', { timeout: 30_000 }, async () => {
  const { root, store } = mk(10_000);
  const dbPath = store.dbPath; store.close();
  const dbUrl = new URL('../src/db.js', import.meta.url).href;
  const code = `import { openStore } from ${JSON.stringify(dbUrl)}; const s = openStore(process.argv[1]); const r = s.reserveModelBudget({ id: process.argv[2], requestKey: process.argv[2], provider: 'deepseek', estimatedTokens: 6000, estimatedCostCny: 0.01, maxTokens: 10000, maxCostCny: 30 }); console.log(JSON.stringify(r)); s.close();`;
  const run = (id) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', code, dbPath, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err=''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; }); child.on('close', (code) => resolve({ code, out, err }));
  });
  try {
    const [a, b] = await Promise.all([run('proc-a'), run('proc-b')]);
    if (!a.out.trim() || !b.out.trim()) throw new Error(JSON.stringify({a,b}));
    const ra = JSON.parse(a.out.trim().split('\n').pop()); const rb = JSON.parse(b.out.trim().split('\n').pop());
    assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, '并发进程只能有一个预留成功');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
