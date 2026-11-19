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

test('v3.1 P1-2：released 预留用同 key 重试必须重新做完整额度检查', () => {
  const { root, store } = mk(1_000);
  try {
    const first = store.reserveModelBudget({ id: 'res-released', requestKey: 'retry-key', provider: 'deepseek', estimatedTokens: 400, maxTokens: 1_000, maxCostCny: 30 });
    assert.equal(first.ok, true);
    store.releaseModelReservation('res-released');
    store.addLlmUsage({ source: 'test', sourceId: 'used-900', provider: 'deepseek', providerKnown: true, tokensIn: 900, tokensOut: 0, budgetScope: 'global' });
    const retry = store.reserveModelBudget({ id: 'res-released-2', requestKey: 'retry-key', provider: 'deepseek', estimatedTokens: 400, maxTokens: 1_000, maxCostCny: 30, minReserveTokens: 0 });
    assert.equal(retry.ok, false, '已释放的 400 预留不能在仅剩 100 额度时无检查重新占用');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.1 P1-2：未知用量保留估算额度，不被视为免费', () => {
  const { root, store } = mk(10_000);
  try {
    const r = store.reserveModelBudget({ id: 'res-unknown', requestKey: 'unknown-key', provider: 'deepseek', estimatedTokens: 2_000, maxTokens: 10_000, maxCostCny: 30 });
    assert.equal(r.ok, true);
    store.markModelReservationUnknown('res-unknown');
    assert.equal(store.listModelReservations().find((x) => x.id === 'res-unknown').status, 'unknown');
    assert.equal(store.reservedBudgetTotals().tokens, 2_000);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.1 P1-2：settled 同 key 不重复付费；过期预留转 unknown；DSH 专项不占全局', () => {
  const { root, store } = mk(10_000);
  try {
    const a = store.reserveModelBudget({ id: 'settle-a', requestKey: 'settle-key', provider: 'deepseek', estimatedTokens: 1_000, maxTokens: 10_000, maxCostCny: 30 });
    store.settleModelReservation(a.reservation.id, { actualTokens: 500, actualCostCny: 0.01, usageKnown: true });
    const before = store.listModelReservations().length;
    const again = store.reserveModelBudget({ id: 'settle-b', requestKey: 'settle-key', provider: 'deepseek', estimatedTokens: 1_000, maxTokens: 10_000, maxCostCny: 30 });
    assert.equal(again.existing, true);
    assert.equal(store.listModelReservations().length, before, 'settled 同 key 不能插入新付费调用');
    // 过期：转 unknown，不自动当作零成本
    const b = store.reserveModelBudget({ id: 'expire-a', requestKey: 'expire-key', provider: 'deepseek', estimatedTokens: 700, maxTokens: 10_000, maxCostCny: 30 });
    store.db.prepare("UPDATE model_reservations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(b.reservation.id);
    store.reserveModelBudget({ id: 'trigger-clean', requestKey: 'trigger-clean', provider: 'deepseek', estimatedTokens: 10, maxTokens: 10_000, maxCostCny: 30 });
    assert.equal(store.listModelReservations().find((x) => x.id === 'expire-a').status, 'unknown');
    // project_audit 不进入全局 reservation 分母
    store.addLlmUsage({ source: 'audit', sourceId: 'dsh-global-check', provider: 'deepseek', providerKnown: true, tokensIn: 9_000, tokensOut: 0, budgetScope: 'project_audit' });
    const afterDsh = store.reserveModelBudget({ id: 'global-after-dsh', requestKey: 'global-after-dsh', provider: 'deepseek', estimatedTokens: 5_000, maxTokens: 10_000, maxCostCny: 30 });
    assert.equal(afterDsh.ok, true, 'DSH project_audit 不应污染全局额度');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.2 P0-2：UNKNOWN 历史调用不被重试覆盖；新付费请求拥有独立预留 ID 且历史风险继续占额', () => {
  const { root, store } = mk(20_000);
  try {
    const first = store.reserveModelBudget({ id: 'unknown-call-1', requestKey: 'paid-key', provider: 'deepseek', estimatedTokens: 4_000, maxTokens: 20_000, maxCostCny: 30 });
    store.markModelReservationUnknown(first.reservation.id);
    const beforeRows = store.listModelReservations().length;
    const retry = store.reserveModelBudget({ id: 'unknown-call-2', requestKey: 'paid-key', provider: 'deepseek', estimatedTokens: 4_000, maxTokens: 20_000, maxCostCny: 30 });
    assert.equal(retry.ok, false, 'UNKNOWN 无新授权不得自动创建第二笔预留');
    assert.equal(retry.reason, 'unknown-retry-not-authorized');
    assert.equal(store.listModelReservations().length, beforeRows);
    const old = store.listModelReservations().find((x) => x.id === first.reservation.id);
    assert.equal(old.status, 'unknown', '旧 UNKNOWN 不得被覆盖或删除');
    assert.equal(store.reservedBudgetTotals().tokens, 4_000, '旧 UNKNOWN 4k 继续保守占额');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.2 P0-2：DB 关闭重开后未结算预留仍占额；超时转 UNKNOWN 后新调用独立计费', () => {
  const { root, config, store } = mk(10_000);
  const dbPath = store.dbPath;
  try {
    store.reserveModelBudget({ id: 'crash-res', requestKey: 'crash-key', provider: 'deepseek', estimatedTokens: 3_000, maxTokens: 10_000, maxCostCny: 30 });
  } finally { store.close(); }
  const reopened = openStore(dbPath);
  try {
    assert.equal(reopened.listModelReservations().find((x) => x.id === 'crash-res').status, 'reserved');
    assert.equal(reopened.reservedBudgetTotals().tokens, 3_000, '崩溃后未结算预留必须继续占额');
    reopened.db.prepare("UPDATE model_reservations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='crash-res'").run();
    const retry = reopened.reserveModelBudget({ id: 'after-timeout', requestKey: 'crash-key', provider: 'deepseek', estimatedTokens: 3_000, maxTokens: 10_000, maxCostCny: 30 });
    assert.equal(retry.ok, false, 'TTL 到期后的 UNKNOWN 同样必须显式新授权');
    assert.equal(retry.reason, 'unknown-retry-not-authorized');
    assert.equal(reopened.listModelReservations().find((x) => x.id === 'crash-res').status, 'unknown');
    assert.equal(reopened.reservedBudgetTotals().tokens, 3_000);
  } finally { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.2 P0-1：同一 Provider 的 confirmed/unknown 混合用量逐调用计算，未知 GLM 不豁免', () => {
  const { root, config, store } = mk(5_000);
  const configG = { ...config, llm: { ...config.llm, glm: { apiKey: 'test-glm-key', baseUrl: 'https://glm.example/v1', model: 'glm-4' } } };
  try {
    // 已确认 GLM：豁免；未知 GLM：不得因同 Provider 有 confirmed 记录而豁免。
    store.addLlmUsage({ source: 'test', sourceId: 'glm-known', provider: 'glm', providerKnown: true, tokensIn: 1_000, tokensOut: 500, tokensCache: 200, costCny: 0.01, budgetScope: 'global' });
    store.addLlmUsage({ source: 'test', sourceId: 'glm-unknown', provider: 'glm', providerKnown: false, tokensIn: 300, tokensOut: 100, tokensCache: 100, costCny: 0.02, budgetScope: 'global' });
    store.addLlmUsage({ source: 'test', sourceId: 'deepseek-unknown', provider: 'deepseek', providerKnown: false, tokensIn: 200, tokensOut: 100, tokensCache: 0, costCny: 0.03, budgetScope: 'global' });
    store.addLlmUsage({ source: 'test', sourceId: 'dsh-project', provider: 'deepseek', providerKnown: true, tokensIn: 9_000, tokensOut: 1_000, tokensCache: 0, costCny: 1, budgetScope: 'project_audit' });
    const raw = store.usageTotals();
    assert.ok(raw.byProvider.glm, 'confirmed GLM 应存在独立已知身份桶');
    assert.ok(raw.byProvider['glm@unknown'], 'unknown GLM 应存在独立未知身份桶');
    assert.equal(raw.byProvider['glm@unknown'].known, false);
    const snap = budgetSnapshot(store, configG);
    // 非豁免：glm unknown 300+100+100*0.1=410；deepseek 200+100=300 => 710
    assert.equal(snap.budgetTokens, 710);
    assert.equal(snap.budgetCostCny, 0.05);
    assert.equal(snap.usedTokens, 1_000 + 500 + 200 + 500 + 300 + 10_000);
    assert.equal(snap.projectAudit.tokens, 10_000);
    assert.equal(snap.remainingTokens, 5_000 - 710);
    // 预留检查也使用同一逐调用口径，已确认 GLM 不占全局额度。
    const r = store.reserveModelBudget({ id: 'glm-mixed-res', requestKey: 'glm-mixed', provider: 'deepseek', estimatedTokens: 4_000, estimatedCostCny: 0.01, maxTokens: 5_000, maxCostCny: 30, minReserveTokens: 0 });
    assert.equal(r.ok, true);
    const tooLarge = store.reserveModelBudget({ id: 'glm-mixed-res-2', requestKey: 'glm-mixed-2', provider: 'deepseek', estimatedTokens: 4_500, estimatedCostCny: 0.01, maxTokens: 5_000, maxCostCny: 30, minReserveTokens: 0 });
    assert.equal(tooLarge.ok, false, 'unknown GLM/DeepSeek 已占 710，剩余不足以再预留 4500');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.2 P0-2：settled/reserved 的 assertModelBudget 不会再次发起付费调用', () => {
  const { root, config, store } = mk(20_000);
  try {
    const first = assertModelBudget({ config, store, provider: 'deepseek', estimatedTokens: 1000, estimatedCostCny: 0.01, reserve: true, requestKey: 'dup-paid' });
    store.settleModelReservation(first.reservation.id, { actualTokens: 10, usageKnown: true });
    assert.throws(() => assertModelBudget({ config, store, provider: 'deepseek', estimatedTokens: 1000, estimatedCostCny: 0.01, reserve: true, requestKey: 'dup-paid' }), /MODEL_CALL_DUPLICATE|重复付费/);
    assert.equal(store.listModelReservations().length, 1);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.3 P0-2：结算不可重复；二次结算不得覆盖首次数额', () => {
  const { root, store } = mk(10_000);
  try {
    const r = store.reserveModelBudget({ id: 'settle-once', requestKey: 'settle-once', provider: 'deepseek', estimatedTokens: 1_000, maxTokens: 10_000, maxCostCny: 30 });
    store.settleModelReservation(r.reservation.id, { actualTokens: 10, actualCostCny: 0.01, usageKnown: true });
    store.settleModelReservation(r.reservation.id, { actualTokens: 999, actualCostCny: 9, usageKnown: true });
    const row = store.listModelReservations().find((x) => x.id === 'settle-once');
    assert.equal(Number(row.actual_tokens), 10, '二次结算不得覆盖');
    assert.equal(Number(row.actual_cost_cny), 0.01);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.3 P0-2：真实子进程 SIGKILL 后预留仍占额，重启恢复不丢账', { timeout: 30_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { root, store } = mk(10_000);
  const dbPath = store.dbPath; store.close();
  const dbUrl = new URL('../src/db.js', import.meta.url).href;
  const code = `import { openStore } from ${JSON.stringify(dbUrl)}; const s=openStore(process.argv[1]); const r=s.reserveModelBudget({id:'sigkill-res',requestKey:'sigkill-key',provider:'deepseek',estimatedTokens:3000,maxTokens:10000,maxCostCny:30}); console.log(JSON.stringify({ok:r.ok,id:r.reservation.id})); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', code, dbPath], { stdio: ['ignore','pipe','pipe'] });
  try {
    await new Promise((resolve, reject) => { let out=''; child.stdout.on('data',(d)=>{out+=d;if(out.includes('"ok":true')) resolve();}); child.on('error',reject); setTimeout(()=>reject(new Error('child reserve timeout')),5000); });
    child.kill('SIGKILL');
    await new Promise((resolve)=>child.on('close',resolve));
    const reopened = openStore(dbPath);
    try {
      const row = reopened.listModelReservations().find((x) => x.id === 'sigkill-res');
      assert.equal(row.status, 'reserved', 'SIGKILL 后未结算预留必须保留');
      assert.equal(reopened.reservedBudgetTotals().tokens, 3_000, '重启后必须继续占额');
    } finally { reopened.close(); }
  } finally { try { child.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.3 P0-1：历史推断身份重启迁移后降级为 unknown，不自动豁免', () => {
  const { root, store } = mk(10_000);
  const dbPath = store.dbPath;
  try {
    // 模拟旧库：历史上按 agentKind 推断为 glm 且被标成 known=1。
    store.db.prepare(`INSERT INTO attempts (id,run_id,task_id,attempt_no,stage,agent_kind,session_id,prompt,exit_code,status,error,feedback,tokens_in,tokens_out,tokens_cache,cost_cny,duration_ms,log_path,created_at,updated_at,provider,provider_known,provider_source,model)
      VALUES ('legacy-a','r','t',1,'coding','claude','','',0,'ok','','',1300,600,100,0.05,1,'','2026-01-01','2026-01-01','glm',1,'legacy_inferred','glm-4')`).run();
  } finally { store.close(); }
  const reopened = openStore(dbPath);
  try {
    const row = reopened.db.prepare("SELECT provider_known,provider_source FROM attempts WHERE id='legacy-a'").get();
    assert.equal(Number(row.provider_known), 0, '历史推断不得自动升级');
    assert.equal(row.provider_source, 'legacy_inferred');
    const raw = reopened.usageTotals();
    assert.equal(raw.byProvider['glm@unknown']?.tokensIn, 1300);
    assert.equal(raw.byProvider['glm@unknown']?.known, false);
    assert.equal(raw.byProvider.glm === undefined || raw.byProvider.glm.tokensIn === 0, true, '历史推断不得进入 confirmed GLM 豁免桶');
  } finally { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
