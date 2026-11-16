// SPDX-License-Identifier: Apache-2.0
/** v3.1 P0-1：Loop 暂停/恢复只有在真实 Run 状态确认后改变 Loop 状态。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { LoopManager } from '../src/loop.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v31-loopctl-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'node --test' });
  store.createRun({ id: 'r', projectId: 'p', planId: 'pl', goal: 'g', mode: 'single', status: 'running' });
  store.createLoop({ id: 'l', projectId: 'p', goal: 'g', mode: 'plan', status: 'running' });
  store.updateLoop('l', { current_run_id: 'r' });
  return { root, config, store };
}
test('v3.1 P0-1：Loop pause 调用真实 Run pause；Run 未确认暂停则 Loop 不显示暂停', async () => {
  const h = mk();
  try {
    let pauseCalled = 0;
    const manager = new LoopManager({ config: h.config, store: h.store, bus: new EventBus(), orchestrator: { pauseRun: async (id) => { pauseCalled += 1; h.store.updateRun(id, { status: 'paused', pause_kind: 'manual' }); return h.store.getRun(id); }, resumeRun: async (id) => { resumeCalled += 1; return { id, status: 'running' }; } } });
    await manager.pause('l', '用户暂停');
    assert.equal(pauseCalled, 1);
    assert.equal(h.store.getLoop('l').status, 'paused');
    // 失败恢复必须显示真实异常，不能把 Loop 改成 running
    let resumeCalled = 0;
    manager.orchestrator.resumeRun = async () => { resumeCalled += 1; throw new Error('RUN_PAUSED_BY_BUDGET'); };
    await assert.rejects(manager.resume('l'), /RUN_PAUSED_BY_BUDGET/);
    assert.equal(resumeCalled, 1);
    assert.equal(h.store.getLoop('l').status, 'paused');
    manager.orchestrator.resumeRun = async () => { resumeCalled += 1; return { id: 'r', status: 'running' }; };
    await manager.resume('l');
    assert.equal(h.store.getLoop('l').status, 'running');
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});
