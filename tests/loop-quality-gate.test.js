// SPDX-License-Identifier: Apache-2.0
/** v2.9 可靠性：质量未 PASS/修复队列非空时，达到 max_rounds 也不得 completed。 */
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-qgate-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'true', ciRequired: false, config: { quality: { quality_command: 'true', sandbox: 'off', host_isolation_acknowledged: true, requirements: [{ id: 'R1', title: 'R', priority: 'P0', acceptance: ['a'] }] } } });
  return { config, store };
}

test('v2.9：max_rounds 且质量未 PASS，不得 completed', async () => {
  const { config, store } = mk();
  try {
    const loop = store.createLoop({ id: 'loop', projectId: 'p', goal: 'g', mode: 'plan', maxRounds: 1 });
    store.updateLoop('loop', { round: 1, status: 'running', history_json: [{ round: 1, quality: { allPass: false, coverage: { pass: 0, total: 1 } } }] });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => ({ runId: 'x' }) } });
    await manager.tick('loop');
    const after = store.getLoop('loop');
    assert.equal(after.status, 'blocked');
    assert.match(after.stop_reason, /质量门未完成|不能完成/);
  } finally { store.close(); }
});

test('v2.9：max_rounds 且质量 PASS + 队列空，才 completed', async () => {
  const { config, store } = mk();
  try {
    store.createLoop({ id: 'loop2', projectId: 'p', goal: 'g', mode: 'plan', maxRounds: 1 });
    store.updateLoop('loop2', { round: 1, status: 'running', history_json: [{ round: 1, quality: { allPass: true, coverage: { pass: 1, total: 1 } } }] });
    const manager = new LoopManager({ config, store, bus: new EventBus(), orchestrator: { emit: () => {}, startRun: async () => ({ runId: 'x' }) } });
    await manager.tick('loop2');
    assert.equal(store.getLoop('loop2').status, 'completed');
  } finally { store.close(); }
});
