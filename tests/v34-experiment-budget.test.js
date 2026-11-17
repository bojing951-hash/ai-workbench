// SPDX-License-Identifier: Apache-2.0
/** v3.4：E2E 实验级硬预算契约；所有付费调用必须先原子预留。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { assertModelBudget } from '../src/budget.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v34-exp-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'test-glm-key', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'test-deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } }, github: { token: '' }, agents: { ...getConfig().agents, claude: { ...getConfig().agents.claude, bin: process.execPath, baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'test-glm-key', model: 'glm-5.3' }, dsh: { ...getConfig().agents.dsh, bin: process.execPath } }, budget: { maxTotalTokens: 10_000_000, maxCostCny: 1000, minReserveTokens: 0 } });
  const store = openStore(config.paths.dbPath);
  store.createProject({ id: 'p-exp', name: 'exp', localPath: root, defaultBranch: 'main' });
  return { root, config, store };
}
function contract(store, patch = {}) {
  return store.createExperimentContract({
    projectId: 'p-exp', authorizedBy: 'user:test', authorizationSource: 'user_cli_tty', authorizationText: 'I_AUTHORIZE_E2E_BUDGET_V1', provider: { coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' } },
    tokenLimit: 10_000, costLimitCny: 80, stopLossCny: 72, callLimit: 50,
    deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
    glmTokenLimit: 4_000_000, glmCostLimitCny: 40, dshTokenLimit: 2_000_000, dshCostLimitCny: 30,
    isolationMode: 'DOCKER_REQUIRED', ...patch,
  });
}
const reserve = (store, exp, id, tokens, cost = 0.01, extra = {}) => store.reserveModelBudget({ id, requestKey: id, provider: 'deepseek', estimatedTokens: tokens, estimatedCostCny: cost, maxTokens: 10_000_000, maxCostCny: 1000, minReserveTokens: 0, experimentId: exp.id, ...extra });

test('v3.4 实验：无授权/无效契约阻止任何预留', () => {
  const { root, store } = mk();
  try {
    const r = reserve(store, { id: 'missing' }, 'x1', 100);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'experiment-not-authorized');
    assert.equal(store.listModelReservations().length, 0);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.4 实验：Token 上限、未知用量历史占额、费用止损和调用次数硬阻止', () => {
  const { root, store } = mk();
  try {
    const exp = contract(store, { tokenLimit: 1000, callLimit: 3, costLimitCny: 1, stopLossCny: 0.5 });
    assert.equal(reserve(store, exp, 'a', 600, 0.1).ok, true);
    const second = reserve(store, exp, 'b', 600, 0.1);
    assert.equal(second.ok, false); assert.equal(second.reason, 'experiment-token-limit');
    store.markModelReservationUnknown(store.listModelReservations()[0].id);
    assert.equal(reserve(store, exp, 'c', 600, 0.1).ok, false, 'UNKNOWN 必须继续占额');
    const exp2 = contract(store, { projectId: '', conversationId: 'c2', tokenLimit: 100_000, callLimit: 10, costLimitCny: 1, stopLossCny: 0.5 });
    assert.equal(reserve(store, exp2, 'd', 100, 0.2).ok, true);
    const stop = reserve(store, exp2, 'e', 100, 0.3);
    assert.equal(stop.ok, false); assert.equal(stop.reason, 'experiment-stop-loss');
    const exp3 = contract(store, { projectId: '', conversationId: 'c3', tokenLimit: 100_000, costLimitCny: 10, stopLossCny: 0.5, callLimit: 2 });
    assert.equal(reserve(store, exp3, 'f', 100, 0.1).ok, true);
    assert.equal(reserve(store, exp3, 'g', 100, 0.1).ok, true);
    const call = reserve(store, exp3, 'h', 100, 0.1);
    assert.equal(call.ok, false); assert.equal(call.reason, 'experiment-call-limit');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.4 实验：GLM 独立上限与全局预算隔离，DSH 独立上限', () => {
  const { root, store } = mk();
  try {
    const exp = contract(store, { projectId: '', conversationId: 'glm-c', tokenLimit: 10_000, costLimitCny: 80, stopLossCny: 72, glmTokenLimit: 500, glmCostLimitCny: 40, dshTokenLimit: 300, dshCostLimitCny: 30, callLimit: 50 });
    assert.equal(reserve(store, exp, 'glm1', 300, 0.1, { provider: 'glm', experimentScope: 'glm', exemptGlobal: true }).ok, true);
    const g2 = reserve(store, exp, 'glm2', 300, 0.1, { provider: 'glm', experimentScope: 'glm', exemptGlobal: true });
    assert.equal(g2.ok, false); assert.equal(g2.reason, 'experiment-glm-token-limit');
    assert.equal(reserve(store, exp, 'dsh1', 200, 0.1, { provider: 'deepseek', experimentScope: 'dsh', exemptGlobal: false }).ok, true);
    const d2 = reserve(store, exp, 'dsh2', 200, 0.1, { provider: 'deepseek', experimentScope: 'dsh', exemptGlobal: false });
    assert.equal(d2.ok, false); assert.equal(d2.reason, 'experiment-dsh-token-limit');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.4 实验：超过截止时间阻止新付费调用', () => {
  const { root, store } = mk();
  try {
    const exp = contract(store, { projectId: '', conversationId: 'deadline-c', deadlineAt: '2000-01-01T00:00:00.000Z' });
    const r = reserve(store, exp, 'late', 100);
    assert.equal(r.ok, false); assert.equal(r.reason, 'experiment-time-exceeded');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.4 实验：assertModelBudget 在模型请求前执行实验硬限制，GLM 不再直接豁免', () => {
  const { root, config, store } = mk();
  try {
    const exp = contract(store, { projectId: '', conversationId: 'budget-c', tokenLimit: 1000, callLimit: 1, costLimitCny: 80, stopLossCny: 72 });
    const first = assertModelBudget({ config, store, provider: 'deepseek', estimatedTokens: 100, estimatedCostCny: 0.01, reserve: true, requestKey: 'first', experimentId: exp.id });
    assert.ok(first.reservation?.id);
    assert.throws(() => assertModelBudget({ config, store, provider: 'deepseek', estimatedTokens: 100, estimatedCostCny: 0.01, reserve: true, requestKey: 'second', experimentId: exp.id }), /实验|EXPERIMENT|BUDGET/);
    const exp2 = contract(store, { projectId: '', conversationId: 'glm-c2', glmTokenLimit: 100, tokenLimit: 10_000, callLimit: 10, costLimitCny: 80, stopLossCny: 72 });
    const glm = assertModelBudget({ config, store, provider: 'glm', model: 'glm-5.3', estimatedTokens: 100, estimatedCostCny: 0.01, reserve: true, requestKey: 'glm-first', experimentId: exp2.id });
    assert.ok(glm.reservation?.id);
    assert.throws(() => assertModelBudget({ config, store, provider: 'glm', model: 'glm-5.3', estimatedTokens: 100, estimatedCostCny: 0.01, reserve: true, requestKey: 'glm-second', experimentId: exp2.id }), /实验|EXPERIMENT|BUDGET/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.4 实验：多进程并发预留共同受实验上限约束', { timeout: 30_000 }, async () => {
  const { root, store, config } = mk();
  const dbPath = config.paths.dbPath;
  try {
    const exp = contract(store, { tokenLimit: 1000, callLimit: 10 });
    const dbUrl = new URL('../src/db.js', import.meta.url).href;
    const code = `import { openStore } from ${JSON.stringify(dbUrl)}; const s=openStore(process.argv[1]); const r=s.reserveModelBudget({id:process.argv[2],requestKey:process.argv[2],provider:'deepseek',estimatedTokens:600,estimatedCostCny:0.1,maxTokens:10000000,maxCostCny:1000,minReserveTokens:0,experimentId:process.argv[3]}); console.log(JSON.stringify(r)); s.close();`;
    const run = (id) => new Promise((resolve) => { const c=spawn(process.execPath,['--no-warnings=ExperimentalWarning','--input-type=module','-e',code,dbPath,id,exp.id],{stdio:['ignore','pipe','pipe']}); let out=''; c.stdout.on('data',(d)=>{out+=d;}); c.on('close',()=>resolve(out)); });
    const results = await Promise.all([run('proc-a'), run('proc-b')]);
    const parsed = results.map((x) => JSON.parse(x.trim().split('\n').pop()));
    assert.equal(parsed.filter((r) => r.ok).length, 1, '实验硬险：并发只能一个成功');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('v3.4 实验：同 requestKey settled 不产生新调用；旧 UNKNOWN 新重试占新 ID', () => {
  const { root, store } = mk();
  try {
    const exp = contract(store, { tokenLimit: 100_000, callLimit: 50 });
    const a = reserve(store, exp, 'same', 100);
    store.settleModelReservation(a.reservation.id, { actualTokens: 10, usageKnown: true });
    const again = reserve(store, exp, 'same', 100);
    assert.equal(again.existing, true);
    assert.equal(store.experimentUsage(exp.id).calls, 1);
    const exp2 = contract(store, { projectId: '', conversationId: 'unk-c', tokenLimit: 100_000, callLimit: 50 });
    const old = reserve(store, exp2, 'unk', 100);
    store.markModelReservationUnknown(old.reservation.id);
    const retried = reserve(store, exp2, 'unk-retry', 100);
    assert.equal(retried.ok, true);
    assert.notEqual(retried.reservation.id, old.reservation.id);
    assert.equal(store.experimentUsage(exp2.id).calls, 2);
    assert.equal(store.experimentUsage(exp2.id).tokens, 200);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.4 实验：隔离方案未批准/Docker不可用时在规划前 BLOCKED，不发起模型调用', async () => {
  const { root, config, store } = mk();
  try {
    const exp = contract(store, { isolationMode: 'DOCKER_REQUIRED' });
    const { EventBus } = await import('../src/bus.js');
    const { Orchestrator } = await import('../src/orchestrator.js');
    let calls = 0;
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { chooseAgent: async () => 'claude', checkAgents: async () => [], runAgent: async () => { calls += 1; throw new Error('must not run'); }, runAudit: async () => { calls += 1; throw new Error('must not run'); } } });
    await assert.rejects(o.startRun({ projectId: 'p-exp', goal: 'test', mode: 'single', tasks: [] }), /EXPERIMENT_ISOLATION_BLOCKED|Docker|隔离/);
    assert.equal(calls, 0, '隔离阻塞必须发生在任何模型调用之前');
    assert.equal(store.listModelReservations().length, 0);
    assert.equal(store.getExperimentContract(exp.id).contract_hash.length, 64);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.4 实验：真实 SIGKILL 后实验占用不重置，重启恢复保留调用次数', { timeout: 30_000 }, async () => {
  const { root, store, config } = mk();
  const dbPath = config.paths.dbPath;
  try {
    const exp = contract(store, { tokenLimit: 100_000, callLimit: 50 });
    const dbUrl = new URL('../src/db.js', import.meta.url).href;
    const code = `import { openStore } from ${JSON.stringify(dbUrl)}; const s=openStore(process.argv[1]); const r=s.reserveModelBudget({id:'crash-exp',requestKey:'crash-exp',provider:'deepseek',estimatedTokens:3000,estimatedCostCny:0.1,maxTokens:10000000,maxCostCny:1000,minReserveTokens:0,experimentId:process.argv[2]}); console.log(JSON.stringify({ok:r.ok})); setInterval(()=>{},1000);`;
    const c = spawn(process.execPath, ['--no-warnings=ExperimentalWarning','--input-type=module','-e',code,dbPath,exp.id], { stdio: ['ignore','pipe','pipe'] });
    await new Promise((resolve, reject) => { let out=''; c.stdout.on('data',(d)=>{out+=d;if(out.includes('"ok":true')) resolve();}); c.on('error',reject); setTimeout(()=>reject(new Error('child timeout')),5000); });
    c.kill('SIGKILL'); await new Promise((r)=>c.on('close',r));
    const reopened = openStore(dbPath);
    try {
      const u = reopened.experimentUsage(exp.id);
      assert.equal(u.calls, 1);
      assert.equal(u.tokens, 3000);
      assert.equal(reopened.listModelReservations().find((x) => x.id === 'crash-exp').status, 'reserved');
    } finally { reopened.close(); }
  } finally { try { store.close(); } catch {} fs.rmSync(root,{recursive:true,force:true}); }
});

test('v3.4 实验：settle 实际越线后 stop/overspent 状态仍被解析，后续调用与隔离门不失效', async () => {
  const { root, config, store } = mk();
  try {
    const exp = contract(store, { tokenLimit: 100_000, costLimitCny: 10, stopLossCny: 0.5, callLimit: 50, isolationMode: 'DOCKER_REQUIRED' });
    const r = store.reserveModelBudget({ id: 'over-1', requestKey: 'over-1', provider: 'deepseek', estimatedTokens: 100, estimatedCostCny: 0.3, maxTokens: 10_000_000, maxCostCny: 1000, minReserveTokens: 0, experimentId: exp.id });
    store.settleModelReservation(r.reservation.id, { actualTokens: 100, actualCostCny: 0.9, usageKnown: true });
    const stopped = store.getExperimentForProject('p-exp');
    assert.equal(stopped.status, 'stop_loss_reached', '实际越线后必须落状态');
    const next = store.reserveModelBudget({ id: 'over-2', requestKey: 'over-2', provider: 'deepseek', estimatedTokens: 100, estimatedCostCny: 0.1, maxTokens: 10_000_000, maxCostCny: 1000, minReserveTokens: 0, experimentId: stopped.id });
    assert.equal(next.ok, false, 'stop 后仍必须拒绝新调用（不能因 status 不在 authorized/running 就失去契约）');
    const { EventBus } = await import('../src/bus.js');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { chooseAgent: async () => 'claude', checkAgents: async () => [] } });
    await assert.rejects(o.startRun({ projectId: 'p-exp', goal: 'x', mode: 'single', tasks: [] }), /ISOLATION|Docker|隔离/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.4 隔离：执行值必须是 docker 而非 container；容器请求标志与契约门一致', async () => {
  const { root, config, store } = mk();
  try {
    store.createProject({ id: 'p-docker', name: 'docker', localPath: root, defaultBranch: 'main', config: { agent_isolation: 'docker', test_isolation: 'docker' } });
    const { EventBus } = await import('../src/bus.js');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {} });
    const p = store.getProject('p-docker');
    assert.equal(o.agentContainerRequested(p), true);
    assert.equal(o.containerTestRequested(p), true);
    store.createProject({ id: 'p-container', name: 'container', localPath: root, defaultBranch: 'main', config: { agent_isolation: 'container', test_isolation: 'container' } });
    const wrong = store.getProject('p-container');
    assert.equal(o.agentContainerRequested(wrong), false, 'container 不是执行器识别的值');
    const exp = contract(store, { projectId: 'p-container', isolationMode: 'DOCKER_REQUIRED' });
    await assert.rejects(o.startRun({ projectId: wrong.id, goal: 'x', mode: 'single', tasks: [] }), /EXPERIMENT_ISOLATION_BLOCKED|Docker|docker|隔离/);
    assert.equal(store.getExperimentContract(exp.id).status, 'authorized');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.4 P1：实验完成后终态持久化，Chat/Planner/Coding/Audit 新预留全部拒绝，历史不删除', () => {
  const { root, store } = mk();
  try {
    const exp = contract(store, { tokenLimit: 100_000, callLimit: 50 });
    const r = reserve(store, exp, 'done-1', 100);
    store.settleModelReservation(r.reservation.id, { actualTokens: 100, usageKnown: true });
    store.endExperiment(exp.id, 'completed', 'product PASS');
    const terminal = store.getExperimentForProject('p-exp');
    assert.equal(terminal.status, 'completed');
    assert.ok(terminal.ended_at);
    for (const [id, scope] of [['chat-after', 'global'], ['planner-after', 'global'], ['coding-after', 'glm'], ['audit-after', 'dsh']]) {
      const x = reserve(store, exp, id, 100, 0.01, { experimentScope: scope, provider: scope === 'glm' ? 'glm' : 'deepseek', exemptGlobal: scope === 'glm' });
      assert.equal(x.ok, false, `${id} 必须被实验终态拒绝`);
    }
    assert.equal(store.listModelReservations().length, 1, '历史预留不得删除');
    assert.equal(store.experimentUsage(exp.id).calls, 1, '历史用量不得清空');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.4 P0-3：非 GLM 新增费用 ¥10 分项限制与单次最大输出 Token', () => {
  const { root, store } = mk();
  try {
    const exp = contract(store, { tokenLimit: 1_000_000, costLimitCny: 80, stopLossCny: 72, callLimit: 50, nonGlmCostLimitCny: 10, perCallMaxTokens: 1000 });
    const a = reserve(store, exp, 'ng-1', 100, 9.90);
    assert.equal(a.ok, true);
    const b = reserve(store, exp, 'ng-2', 100, 0.20);
    assert.equal(b.ok, false); assert.equal(b.reason, 'experiment-non-glm-cost-limit');
    const c = reserve(store, exp, 'ng-3', 1001, 0.01);
    assert.equal(c.ok, false); assert.equal(c.reason, 'experiment-per-call-token-limit');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.4 P0-2：Coding/Audit 模型身份必须与授权契约一致，禁止同族与不可用 CLI', async () => {
  const { root, config, store } = mk();
  try {
    const { EventBus } = await import('../src/bus.js');
    const { Orchestrator } = await import('../src/orchestrator.js');
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {} });
    // 身份不匹配：授权 GLM，实际配置也是 GLM；但声明 provider=deepseek 应拒绝。
    const exp = contract(store, { provider: { coding: { client: 'claude', provider: 'deepseek', model: 'deepseek-chat' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' } } });
    await assert.rejects(o.startRun({ projectId: 'p-exp', goal: 'x', mode: 'single', tasks: [] }), /EXPERIMENT_MODEL_MISMATCH|不匹配/);
    // 同模型族：Coding GLM + Audit GLM 拒绝。
    store.createProject({ id: 'p-same', name: 'same', localPath: root, defaultBranch: 'main' });
    const exp2 = contract(store, { projectId: 'p-same', conversationId: 'same-family', provider: { coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'glm', provider: 'glm', model: 'glm-5.3' } } });
    await assert.rejects(o.startRun({ projectId: 'p-same', goal: 'x', mode: 'single', tasks: [] }), /SAME_FAMILY|同模型族|MISMATCH/);
    // CLI 不可用：DSH bin 指向不存在路径。
    const badCfg = { ...config, agents: { ...config.agents, dsh: { ...config.agents.dsh, bin: '/no/such/dsh' } } };
    const o2 = new Orchestrator({ config: badCfg, store, bus: new EventBus(), deps: {} });
    store.createProject({ id: 'p-nocli', name: 'nocli', localPath: root, defaultBranch: 'main' });
    const exp3 = contract(store, { projectId: 'p-nocli', conversationId: 'no-cli', provider: { coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' } } });
    await assert.rejects(o2.startRun({ projectId: 'p-nocli', goal: 'x', mode: 'single', tasks: [] }), /DSH|MODEL_MISMATCH|不可用/);
    assert.equal(store.listModelReservations().length, 0, '模型绑定错误必须发生在任何付费预留之前');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
