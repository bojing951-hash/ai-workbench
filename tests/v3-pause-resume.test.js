// SPDX-License-Identifier: Apache-2.0
/** v3.0 P0-1：人工暂停必须等待 Agent 停止；恢复从检查点继续且不重复已完成任务。 */
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
async function waitFor(fn, timeoutMs = 30_000, label = 'condition') {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeoutMs) throw new Error(`timeout ${label}`); await sleep(20); }
}
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout; }

test('v3.0 P0-1：暂停等待 Agent 真正停止；继续恢复原 Run 并完成', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v3-pause-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'pause-fixture', private: true, scripts: { test: `${NODE} -e "process.exit(0)"` } }, null, 2));
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'export const version = 0;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# pause fixture\n');
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 'Workbench Test']); git(repo, ['config', 'user.email', 'wb@test']);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({
    root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') },
    secrets: [], llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '', createPr: false, push: false, autoCreateRepo: false },
    budget: { maxTotalTokens: 1_000_000, maxCostCny: 50, maxTokensPerTask: 600_000, maxAttempts: 1, maxAgentConcurrency: 1, minReserveTokens: 20_000 },
    agents: { default: 'auto', dsh: { bin: '/nonexistent/dsh', timeoutMs: 120_000, permissionMode: 'workspace-write' }, claude: { bin: '/nonexistent/claude', timeoutMs: 120_000, permissionMode: 'acceptEdits' } },
    policy: { protectedPaths: ['acceptance/**', '.github/**'], testTimeoutMs: 30_000, ciPollAttempts: 1, ciPollIntervalMs: 10 },
  });
  const store = openStore(config.paths.dbPath);
  let agentCalls = 0;
  let firstAbortedAt = 0;
  let signalAgentReady; const agentReady = new Promise((r) => { signalAgentReady = r; });
  let pauseReturnedAt = 0;
  const deps = {
    checkAgents: async () => [{ id: 'dsh', label: 'fake', ok: true, capabilities: {} }],
    chooseAgent: async () => 'dsh',
    runAgent: async (id, ctx) => {
      agentCalls += 1;
      if (agentCalls === 1) {
        return new Promise((resolve) => {
          if (ctx.signal.aborted) { firstAbortedAt = Date.now(); resolve({ ok: false, aborted: true, error: 'aborted', agentKind: 'dsh', sessionId: 's1', usage: {}, costCny: 0, durationMs: 0, logPath: '' }); return; }
          ctx.signal.addEventListener('abort', () => {
            firstAbortedAt = Date.now();
            // 模拟 Agent 进程收到中断后的清理延迟，确保 pause 真的等待。
            setTimeout(() => { resolve({ ok: false, aborted: true, error: 'aborted', agentKind: 'dsh', sessionId: 's1', usage: {}, costCny: 0, durationMs: 1000, logPath: '' }); }, 1000);
          }, { once: true });
          signalAgentReady();
        });
      }
      fs.writeFileSync(path.join(ctx.cwd, 'src', 'index.js'), 'export const version = 2;\nexport function feature() { return 2; }\n');
      return { ok: true, text: 'done', error: '', agentKind: 'dsh', sessionId: 's2', exitCode: 0, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, costCny: 0.0001, durationMs: 10, logPath: '' };
    },
    runAudit: async ({ task }) => ({ provider: 'fake', model: 'fake-audit', verdict: 'pass', score: 100, criteria: (task.acceptance_json || []).map((c) => ({ criterion: c, status: 'pass', evidence: 'src/index.js 已实现 feature 并测试' })), findings: [], requiredFixes: [], summary: '通过', usage: { input: 1, output: 1 }, costCny: 0.0001 }),
  };
  const orch = new Orchestrator({ config, store, bus: new EventBus(), deps });
  try {
    const project = await orch.createProject({ name: 'pause', repo, defaultBranch: 'main', testCommand: TEST_COMMAND, ciRequired: false });
    const started = await orch.startRun({ projectId: project.id, goal: '实现 feature', acceptance: ['src/index.js 导出 feature'], mode: 'single' });
    await waitFor(() => store.listEvents({ runId: started.runId, limit: 100 }).some((e) => e.type === 'agent_started'), 20_000, 'agent_started');
    await agentReady;
    const p = orch.pauseRun(started.runId, '人工暂停', 'manual');
    pauseReturnedAt = Date.now();
    const paused = await p;
    pauseReturnedAt = Date.now();
    assert.ok(firstAbortedAt > 0, 'Agent 应收到中断');
    assert.ok(pauseReturnedAt - firstAbortedAt >= 800, 'pause 必须在 Agent 实际停止后才返回');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pause_kind, 'manual');
    assert.equal(orch.running.has(started.runId), false);
    // 恢复：原 Run 重新进入 running，并再次调用 Agent 完成
    const resumed = await orch.resumeRun(started.runId, { retryFailed: false });
    assert.ok(['running', 'queued'].includes(resumed.status), `resume 状态 ${resumed.status}`);
    const final = await waitFor(() => { const r = store.getRun(started.runId); return r && ['awaiting_acceptance', 'paused', 'failed', 'blocked'].includes(r.status) ? r : null; }, 60_000, 'final');
    assert.equal(final.status, 'awaiting_acceptance', final.stop_reason);
    assert.equal(agentCalls, 2, '暂停后只应再启动一次 Agent，不重复已完成任务');
    const task = store.listTasks({ runId: started.runId })[0];
    assert.equal(task.status, 'passed');
    assert.ok(task.head_commit, '完成必须有真实 commit');
  } finally {
    for (const runId of [...orch.running]) { try { orch.controllers.get(runId)?.abort(); } catch {} }
    await waitFor(() => orch.running.size === 0, 10_000).catch(() => {});
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
