// SPDX-License-Identifier: Apache-2.0
/** v3.1 P0-2：冻结验收条款必须由独立审计 PASS 证据覆盖，否则自动修复/阻塞，不能 awaiting。 */
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

const NODE = process.execPath;
const TEST_COMMAND = `"${NODE}" -e "process.exit(0)"`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 60_000, label = 'condition') { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > timeoutMs) throw new Error(`timeout ${label}`); await sleep(20); } }
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout; }

test('v3.1 P0-2：审计只覆盖部分冻结验收条款 => 自动修复任务，最终 BLOCKED 而非 waiting_acceptance', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v31-accept-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'accept', private: true, scripts: { test: `${NODE} -e "process.exit(0)"` } }, null, 2));
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'export const feature = () => 1;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# accept\n');
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 'WB']); git(repo, ['config', 'user.email', 'wb@test']); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, secrets: [], llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '', createPr: false, push: false, autoCreateRepo: false }, budget: { maxTotalTokens: 1_000_000, maxCostCny: 50, maxTokensPerTask: 600_000, maxAttempts: 2, maxAgentConcurrency: 1, minReserveTokens: 20_000 }, agents: { default: 'auto', dsh: { bin: '/nonexistent/dsh', timeoutMs: 30_000, permissionMode: 'workspace-write' }, claude: { bin: '/nonexistent/claude', timeoutMs: 30_000, permissionMode: 'acceptEdits' } }, policy: { protectedPaths: ['acceptance/**', '.github/**'], testTimeoutMs: 30_000, ciPollAttempts: 1, ciPollIntervalMs: 10 } });
  const store = openStore(config.paths.dbPath);
  let agentCalls = 0;
  const orch = new Orchestrator({ config, store, bus: new EventBus(), deps: {
    checkAgents: async () => [{ id: 'dsh', label: 'fake', ok: true, capabilities: {} }], chooseAgent: async () => 'dsh',
    runAgent: async (id, ctx) => { agentCalls += 1; fs.writeFileSync(path.join(ctx.cwd, 'src', 'index.js'), `export const feature = () => ${agentCalls};\n`); return { ok: true, text: 'done', agentKind: 'dsh', sessionId: `s${agentCalls}`, exitCode: 0, usage: { input: 1, output: 1 }, costCny: 0, durationMs: 1, logPath: '' }; },
    // 只返回 A1 的 PASS 证据，故意遗漏 A2；真实 gate 必须发现缺失并自动修复/阻塞。
    runAudit: async ({ task }) => ({ provider: 'fake', model: 'fake', verdict: 'pass', score: 100, criteria: [{ criterion: 'A1 可验证', status: 'pass', evidence: 'src/index.js feature 测试通过' }], findings: [], requiredFixes: [], summary: '只覆盖 A1', usage: { input: 1, output: 1 }, costCny: 0 }),
  } });
  try {
    const project = await orch.createProject({ name: 'acceptance-gate', repo, defaultBranch: 'main', testCommand: TEST_COMMAND, ciRequired: false, requireRealTests: false, testPlan: { acceptance: ['A1 可验证', 'A2 必须缺少'], minTests: 1 } });
    const started = await orch.startRun({ projectId: project.id, goal: '实现功能', mode: 'single' });
    const final = await waitFor(() => { const r = store.getRun(started.runId); return r && ['awaiting_acceptance', 'paused', 'failed', 'blocked'].includes(r.status) ? r : null; }, 90_000, 'final');
    assert.equal(final.status, 'paused', '缺失验收条款不能进入 awaiting_acceptance');
    assert.match(final.stop_reason, /冻结验收条款未完成|A2/);
    const tasks = store.listTasks({ runId: started.runId });
    assert.ok(tasks.length >= 2, '应自动生成至少一个验收修复任务');
    assert.ok(agentCalls >= 2, '应实际调用 Agent 尝试修复缺失验收');
    assert.equal(store.getRun(started.runId).pause_kind, 'acceptance_incomplete');
  } finally {
    for (const runId of [...orch.running]) { try { orch.controllers.get(runId)?.abort(); } catch {} }
    await waitFor(() => orch.running.size === 0, 10_000).catch(() => {});
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
