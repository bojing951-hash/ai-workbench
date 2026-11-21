// SPDX-License-Identifier: Apache-2.0
/** v3.5：真实 Coding Agent 看门狗进度指纹与基础设施失败边界。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-watch-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') } });
  const store = openStore(config.paths.dbPath);
  return { root, config, store, worktree: path.join(root, 'worktree') };
}
function orchestrator({ config, store, deps }) { return new Orchestrator({ config, store, bus: new EventBus(), deps }); }

test('v3.5 看门狗：未跟踪新文件及同大小内容更新都会改变进度指纹', async () => {
  const h = mk();
  try {
    const o = orchestrator({ ...h, deps: {} });
    fs.mkdirSync(path.join(h.worktree, 'js'), { recursive: true });
    const f = path.join(h.worktree, 'js', 'new.js');
    const a = await o.worktreeProgressSignal(h.worktree);
    fs.writeFileSync(f, 'const a = 1;\n');
    const b = await o.worktreeProgressSignal(h.worktree);
    fs.writeFileSync(f, 'const a = 2;\n');
    const c = await o.worktreeProgressSignal(h.worktree);
    assert.notEqual(a, b);
    assert.notEqual(b, c, '同大小 untracked 文件内容更新也必须被发现');
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v3.5 看门狗：持续写新文件不得被误杀', { timeout: 20_000 }, async () => {
  const h = mk();
  fs.mkdirSync(h.worktree, { recursive: true });
  let stopped = false;
  try {
    const deps = { runAgent: async (id, ctx) => {
      const timer = setInterval(() => { try { fs.writeFileSync(path.join(h.worktree, `f-${Date.now()}.js`), 'x'); ctx.onEvent?.({ kind: 'tool_call', tool: 'Write', summary: 'write' }); } catch { /* ignore */ } }, 100);
      await new Promise((r) => setTimeout(r, 6500));
      clearInterval(timer); stopped = true;
      return { ok: true, text: 'done', usage: {}, durationMs: 6500, sessionId: 's' };
    } };
    const o = orchestrator({ ...h, deps });
    const { result, stalled } = await o.runAgentWithWatchdog({ agentId: 'claude', ctx: { config: h.config, cwd: h.worktree, prompt: 'x' }, worktree: h.worktree, stallTimeoutMs: 1200 });
    assert.equal(stalled, false);
    assert.equal(result.ok, true);
    assert.equal(stopped, true);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v3.5 看门狗：容器内长时间模型响应不被短阈值误杀', { timeout: 15_000 }, async () => {
  const h = mk(); fs.mkdirSync(h.worktree, { recursive: true });
  try {
    const deps = { runAgent: async () => { await new Promise((r) => setTimeout(r, 6000)); return { ok: true, text: 'done', usage: {}, durationMs: 6000 }; } };
    const o = orchestrator({ ...h, deps });
    const { result, stalled } = await o.runAgentWithWatchdog({ agentId: 'claude', ctx: { config: h.config, cwd: h.worktree, prompt: 'x', container: { network: 'bridge' } }, worktree: h.worktree, stallTimeoutMs: 1200 });
    assert.equal(stalled, false);
    assert.equal(result.ok, true);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v3.5 看门狗：真正死锁中止并保留已写文件/日志', { timeout: 15_000 }, async () => {
  const h = mk(); fs.mkdirSync(h.worktree, { recursive: true });
  try {
    let aborted = false;
    const deps = { runAgent: async (id, ctx) => new Promise((resolve) => {
      fs.writeFileSync(path.join(h.worktree, 'checkpoint.js'), 'preserve me\n');
      ctx.signal.addEventListener('abort', () => { aborted = true; resolve({ ok: false, aborted: true, stalled: true, error: 'stalled abort', usage: {}, durationMs: 6000, logPath: 'abort.log' }); });
      setTimeout(() => resolve({ ok: true, text: 'late', usage: {}, durationMs: 30_000 }), 30_000);
    }) };
    const o = orchestrator({ ...h, deps });
    const { result, stalled } = await o.runAgentWithWatchdog({ agentId: 'claude', ctx: { config: h.config, cwd: h.worktree, prompt: 'x' }, worktree: h.worktree, stallTimeoutMs: 1200 });
    assert.equal(stalled, true);
    assert.equal(aborted, true);
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(h.worktree, 'checkpoint.js'), 'utf8'), 'preserve me\n');
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v3.5 失败分类：stalled/timeout/容器错误归基础设施，不进入产品修复', async () => {
  const h = mk();
  try {
    const o = orchestrator({ ...h, deps: {} });
    assert.equal(o.classifyAgentFailure({ stalled: true }), 'infrastructure_stalled');
    assert.equal(o.classifyAgentFailure({ timedOut: true }), 'infrastructure_timeout');
    assert.equal(o.classifyAgentFailure({ aborted: true }), 'infrastructure_aborted');
    assert.equal(o.classifyAgentFailure({ error: 'CONTAINER_UNAVAILABLE docker ENOENT' }), 'infrastructure');
    assert.equal(o.classifyAgentFailure({ error: '普通解析失败' }), 'agent_error');
    assert.equal(o.isInfrastructureFailure('infrastructure_stalled', {}), true);
    assert.equal(o.isInfrastructureFailure('agent_error', { error: 'lease lost' }), true);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});
