// SPDX-License-Identifier: Apache-2.0
/** v3.2 P0-1：任务级 Run 与产品级验收分离；离线模型模拟明确标注。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { LoopManager } from '../src/loop.js';

const NODE = process.execPath;
const TEST_COMMAND = `"${NODE}" -e "process.exit(0)"`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 60_000, label = 'condition') { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > timeoutMs) throw new Error(`timeout ${label}`); await sleep(25); } }
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout; }
function setup({ acceptance = ['A 功能完成', 'B 功能完成', 'C 功能完成'], queue, mutateAOnB = false, planNextTask = null, slowProductAuditMs = 0 }) {
  let productAuditStartedResolve; const productAuditStarted = new Promise((r) => { productAuditStartedResolve = r; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v32-product-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { test: `${NODE} -e "process.exit(0)"` } }));
  fs.writeFileSync(path.join(repo, 'src', 'base.js'), 'export const base=1;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# p\n');
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 'wb']); git(repo, ['config', 'user.email', 'wb@test']); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, secrets: [], llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '', createPr: false, push: false, autoCreateRepo: false }, budget: { maxTotalTokens: 1_000_000, maxCostCny: 50, maxAttempts: 1, maxAgentConcurrency: 1, minReserveTokens: 10_000 }, agents: { default: 'auto', dsh: { bin: '/no', timeoutMs: 10_000 }, claude: { bin: '/no', timeoutMs: 10_000 } }, policy: { protectedPaths: ['acceptance/**', '.github/**'], testTimeoutMs: 30_000, ciPollAttempts: 1, ciPollIntervalMs: 10 } });
  const store = openStore(config.paths.dbPath);
  const featureFiles = { A: 'feature-a.txt', B: 'feature-b.txt', C: 'feature-c.txt' };
  const deps = {
    checkAgents: async () => [{ id: 'dsh', label: 'fake', ok: true, capabilities: {} }], chooseAgent: async () => 'dsh',
    runAgent: async (id, ctx) => {
      // 离线模拟 Agent：根据当前任务标题写入对应功能文件。
      const title = String(ctx.prompt.match(/^## 任务 \d+\/\d+：(.+)$/m)?.[1] || '');
      const letter = /功能\s*([ABC])/.exec(title)?.[1] || (title.includes('A') ? 'A' : title.includes('B') ? 'B' : title.includes('C') ? 'C' : 'A');
      fs.writeFileSync(path.join(ctx.cwd, 'src', featureFiles[letter]), `feature ${letter}\n`);
      if (mutateAOnB && letter === 'B') fs.writeFileSync(path.join(ctx.cwd, 'src', 'feature-a.txt'), 'feature A mutated after audit\n');
      return { ok: true, text: 'done', agentKind: 'dsh', sessionId: `s-${letter}`, exitCode: 0, usage: { input: 5, output: 2 }, costCny: 0, durationMs: 1, logPath: '' };
    },
    runAudit: async ({ task, project, diff }) => {
      const isProduct = task.title === 'Product acceptance';
      if (isProduct) { productAuditStartedResolve(); if (slowProductAuditMs) await new Promise((r) => setTimeout(r, slowProductAuditMs)); }
      const criteria = isProduct
        ? acceptance.map((c, i) => { const files = ['feature-a.txt', 'feature-b.txt', 'feature-c.txt']; const abs = path.join(project.local_path, 'src', files[i]); const good = fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === `feature ${['A','B','C'][i]}\n`; return { criterion: c, status: good ? 'pass' : 'fail', evidence: good ? `final commit feature ${['A','B','C'][i]} verified; diff ${diff.length} bytes` : 'missing or modified feature file' }; })
        : (task.acceptance_json || []).map((c) => ({ criterion: c, status: 'pass', evidence: `task ${task.title} implementation verified by test` }));
      const status = criteria.every((c) => c.status === 'pass') ? 'PASS' : 'FAIL';
      return { provider: 'fake', model: 'fake', verdict: status === 'PASS' ? 'pass' : 'fail', score: status === 'PASS' ? 100 : 30, criteria, findings: [], requiredFixes: status === 'PASS' ? [] : criteria.filter((c) => c.status !== 'pass').map((c) => c.criterion), summary: status, usage: { input: 1, output: 1 }, costCny: 0 };
    },
  };
  const orchestrator = new Orchestrator({ config, store, bus: new EventBus(), deps });
  const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator, deps: planNextTask ? { planNextTask } : {} });
  return { root, repo, store, orchestrator, manager, config, productAuditStarted };
}
async function cleanup(h) { for (const t of h.manager.timers.values()) clearTimeout(t); h.manager.timers.clear(); for (const runId of [...h.orchestrator.running]) { try { h.orchestrator.controllers.get(runId)?.abort(); } catch {} } await new Promise((r) => setTimeout(r, 200)); h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
async function createProject(h, acceptance) {
  return h.orchestrator.createProject({ name: 'three-feature', repo: h.repo, defaultBranch: 'main', testCommand: TEST_COMMAND, ciRequired: false, testPlan: { acceptance, minTests: 1 } });
}
const queueTasks = [
  { title: '功能 A', acceptance: ['A 功能完成'], testCommand: TEST_COMMAND },
  { title: '功能 B', acceptance: ['B 功能完成'], testCommand: TEST_COMMAND },
  { title: '功能 C', acceptance: ['C 功能完成'], testCommand: TEST_COMMAND },
];

test('v3.2 P0-1：三阶段任务 A→B→C 正常完成，Planner no_task 后产品级验收 PASS', { timeout: 120_000 }, async () => {
  const h = setup({ queue: queueTasks }); const acceptance = ['A 功能完成', 'B 功能完成', 'C 功能完成'];
  try {
    const project = await createProject(h, acceptance);
    const loop = await h.manager.create({ projectId: project.id, goal: '实现 A/B/C', mode: 'queue', maxRounds: 4, queue: queueTasks });
    await waitFor(() => { const l = h.store.getLoop(loop.id); return l && (l.status === 'completed' || l.status === 'blocked' || l.status === 'paused'); }, 90_000, 'loop final');
    const finalLoop = h.store.getLoop(loop.id);
    assert.equal(finalLoop.status, 'completed', finalLoop.stop_reason);
    const run = h.store.getRun(finalLoop.last_run_id);
    assert.ok(run, '必须有最终 run');
    assert.equal(run.status, 'awaiting_acceptance');
    assert.equal(run.result_json.productAcceptance, 'PASS');
    assert.equal(finalLoop.history_json.length >= 3, true);
    assert.equal(finalLoop.round >= 3, true);
    const latestTaskId = h.store.listTasks({ runId: run.id }).at(-1)?.id;
    assert.ok(h.store.listAudits(latestTaskId).some((a) => a.evidence_hash === run.verified_sha && a.verification_status === 'PASS'), '产品验收审计必须绑定最终 SHA');
    assert.equal(h.store.getRun(run.id).status, 'awaiting_acceptance');
  } finally { await cleanup(h); }
});

test('v3.2 P0-1：缺失功能 B 时产品级验收拒绝交付，并生成产品修复任务', { timeout: 120_000 }, async () => {
  const h = setup({ queue: queueTasks }); const acceptance = ['A 功能完成', 'B 功能完成', 'C 功能完成'];
  try {
    const project = await createProject(h, acceptance);
    // 只排队 A、C，模拟 Planner/实现遗漏 B；产品审计必须发现 B 缺失而不是交付。
    const loop = await h.manager.create({ projectId: project.id, goal: '实现 A/C', mode: 'queue', maxRounds: 4, queue: [queueTasks[0], queueTasks[2]] });
    const final = await waitFor(() => { const l = h.store.getLoop(loop.id); const ok = l && (l.status === 'paused' || l.status === 'blocked' || (l.status === 'running' && l.queue_json.some((t) => t.productAcceptanceRepair)) || l.status === 'completed'); return ok ? l : null; }, 90_000, 'product gate');
    assert.ok(['paused', 'blocked', 'running'].includes(final.status));
    assert.notEqual(final.status, 'completed');
    assert.ok(final.product_repair_count >= 1, '产品级缺失必须生成产品修复任务');
    const run = final.last_run_id ? h.store.getRun(final.last_run_id) : null;
    assert.equal(run?.result_json?.productAcceptance === 'PASS', false);
  } finally { await cleanup(h); }
});


test('v3.2 P0-1：后续任务修改已验证功能 A，历史 PASS 不能代替最终代码验收', { timeout: 120_000 }, async () => {
  const h = setup({ queue: queueTasks, mutateAOnB: true }); const acceptance = ['A 功能完成', 'B 功能完成', 'C 功能完成'];
  try {
    const project = await createProject(h, acceptance);
    const loop = await h.manager.create({ projectId: project.id, goal: '实现 A/B/C', mode: 'queue', maxRounds: 4, queue: queueTasks });
    const final = await waitFor(() => { const l = h.store.getLoop(loop.id); const ok = l && (l.status === 'completed' || l.status === 'blocked' || l.status === 'paused' || (l.status === 'running' && l.queue_json.some((t) => t.productAcceptanceRepair))); return ok ? l : null; }, 90_000, 'stale audit gate');
    assert.notEqual(final.status, 'completed', '修改 A 后不能因为历史 A audit PASS 而交付');
    assert.ok(final.product_repair_count >= 1 || final.status === 'blocked');
    const latest = final.last_run_id ? h.store.getRun(final.last_run_id) : null;
    assert.notEqual(latest?.result_json?.productAcceptance, 'PASS');
  } finally { await cleanup(h); }
});


test('v3.2 P0-1：真实 Planner no_task 触发产品级验收，而不是无条件完成/阻塞', { timeout: 120_000 }, async () => {
  const tasks = [
    { title: '功能 A', description: 'A', acceptance: ['A 功能完成'], agent: 'auto', testCommand: TEST_COMMAND },
    { title: '功能 B', description: 'B', acceptance: ['B 功能完成'], agent: 'auto', testCommand: TEST_COMMAND },
    { title: '功能 C', description: 'C', acceptance: ['C 功能完成'], agent: 'auto', testCommand: TEST_COMMAND },
  ];
  let plannerCalls = 0;
  const planner = async () => {
    const idx = plannerCalls;
    plannerCalls += 1;
    if (idx >= tasks.length) return { action: 'no_task', rationale: '无更多功能', usage: { input: 1, output: 1 }, costCny: 0, provider: 'fake', model: 'fake' };
    return { action: 'task', task: tasks[idx], rationale: `plan ${idx}`, usage: { input: 1, output: 1 }, costCny: 0, provider: 'fake', model: 'fake' };
  };
  const h = setup({ planNextTask: planner });
  const acceptance = ['A 功能完成', 'B 功能完成', 'C 功能完成'];
  try {
    const project = await createProject(h, acceptance);
    const loop = await h.manager.create({ projectId: project.id, goal: '实现 A/B/C', mode: 'plan', maxRounds: 5, queue: [] });
    const final = await waitFor(() => { const l = h.store.getLoop(loop.id); return l && ['completed', 'blocked', 'paused'].includes(l.status) ? l : null; }, 90_000, 'planner final');
    assert.equal(final.status, 'completed', final.stop_reason);
    assert.equal(plannerCalls, 4, '应规划 A/B/C + 第 4 次 no_task');
    const lastRun = h.store.getRun(final.last_run_id);
    assert.equal(lastRun.result_json.productAcceptance, 'PASS');
    assert.equal(lastRun.status, 'awaiting_acceptance');
  } finally { await cleanup(h); }
});

test('v3.2 P0-1：无冻结验收的 Loop 末轮 Run 标记 NOT_CONFIGURED 并可验收', { timeout: 120_000 }, async () => {
  const h = setup({ queue: queueTasks });
  try {
    const project = await createProject(h, []);
    const loop = await h.manager.create({ projectId: project.id, goal: '实现 A', mode: 'queue', maxRounds: 4, queue: [queueTasks[0]] });
    const final = await waitFor(() => { const l = h.store.getLoop(loop.id); return l && ['completed', 'blocked', 'paused'].includes(l.status) ? l : null; }, 90_000, 'no contract final');
    assert.equal(final.status, 'completed', final.stop_reason);
    const run = h.store.getRun(final.last_run_id);
    assert.equal(run.result_json.productAcceptance, 'NOT_CONFIGURED');
    const accepted = h.orchestrator.acceptRun(run.id, { confirmLocalOnly: true });
    assert.equal(accepted.status, 'accepted');
  } finally { await cleanup(h); }
});

test('v3.2 P0-1：max_rounds 耗尽且产品验收未通过 => BLOCKED，不产生永不执行的修复任务', { timeout: 120_000 }, async () => {
  const h = setup({ queue: queueTasks }); const acceptance = ['A 功能完成', 'B 功能完成', 'C 功能完成'];
  try {
    const project = await createProject(h, acceptance);
    const loop = await h.manager.create({ projectId: project.id, goal: '只做 A', mode: 'queue', maxRounds: 1, queue: [queueTasks[0]] });
    const final = await waitFor(() => { const l = h.store.getLoop(loop.id); return l && ['completed', 'blocked', 'paused'].includes(l.status) ? l : null; }, 90_000, 'max final');
    assert.equal(final.status, 'blocked', final.stop_reason);
    assert.equal(final.product_repair_count || 0, 0, 'max_rounds 边界不应生成无法执行的修复任务');
    assert.equal(final.queue_json.length, 0);
  } finally { await cleanup(h); }
});


test('v3.2 P0-R：产品级审计 await 期间 cancel/pause 不会被产品 gate 覆盖为 completed', { timeout: 120_000 }, async () => {
  const h = setup({ queue: queueTasks, slowProductAuditMs: 1500 });
  try {
    const project = await createProject(h, ['A 功能完成', 'B 功能完成', 'C 功能完成']);
    const loop = await h.manager.create({ projectId: project.id, goal: '实现 A/B/C', mode: 'queue', maxRounds: 4, queue: queueTasks });
    await h.productAuditStarted;
    await h.manager.cancel(loop.id, '用户取消');
    await new Promise((r) => setTimeout(r, 2200));
    const final = h.store.getLoop(loop.id);
    assert.equal(final.status, 'cancelled', '产品审计返回后不得覆盖 cancel 为 completed/running');
  } finally { await cleanup(h); }
});
