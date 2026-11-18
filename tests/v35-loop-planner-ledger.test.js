// SPDX-License-Identifier: Apache-2.0
/** v3.9：从 LoopManager.tick 正式 Planner 入口触发；测试只喂回执和读账，不手工结算。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { LoopManager } from '../src/loop.js';

function mkConfig(root, port) {
  return getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 't.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(root, 'w'), artifactsDir: path.join(root, 'a'), logsDir: path.join(root, 'l'), agentsDir: path.join(root, 'ag'), dshHome: path.join(root, 'ag/dsh'), claudeHome: path.join(root, 'ag/claude') }, llm: { openai: { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-planner' }, glm: { apiKey: '', baseUrl: '', model: '' }, deepseek: { apiKey: '', baseUrl: '', model: '' } }, planner: { provider: 'openai', model: 'fake-planner', timeoutMs: 30000, maxTokens: 2000 }, budget: { maxTotalTokens: 1000000, maxCostCny: 100, minReserveTokens: 0 } });
}
const PLANNER_NO_TASK = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'no_task', rationale: 'no more work' }) } }] };

test('v39 LoopManager.tick：Planner 缺失 null 用量→Reservation 与 llm_usage 均 UNKNOWN，不手工结算', { timeout: 60_000 }, async () => {
  for (const [name, usage] of [['missing', undefined], ['null', { prompt_tokens: null, completion_tokens: null }], ['full', { prompt_tokens: 8, completion_tokens: 5 }]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wb-v39-loop-${name}-`));
    let received = 0;
    const server = http.createServer((req, res) => { received += 1; req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...PLANNER_NO_TASK, ...(usage === undefined ? {} : { usage }) })); }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const config = mkConfig(root, server.address().port);
    const store = openStore(config.paths.dbPath);
    try {
      store.createProject({ id: 'p-loop', name: 'loop-project', localPath: root, defaultBranch: 'main' });
      store.createLoop({ id: 'loop1', projectId: 'p-loop', goal: 'g', mode: 'plan', maxRounds: 2, status: 'running' });
      const orchestrator = { assertExperimentIsolation() {}, assertExperimentModelBinding() {}, experimentIdForProject() { return ''; }, emit() {}, ensureControlLease() { return true; }, releaseProjectLease() {}, listProjectLeases() { return []; } };
      const loops = new LoopManager({ config, store, bus: new EventBus(), orchestrator, deps: {} });
      loops.productGate = async () => ({ required: false, ok: true, cancelled: false });
      await loops.tick('loop1');
      const usageRows = store.listLlmUsage().filter((x) => x.source === 'planner');
      const reservations = store.listModelReservations().filter((x) => String(x.request_key || '').startsWith('planner:loop1:'));
      assert.equal(received, 1, `${name}: planner request count`);
      assert.equal(usageRows.length, 1, `${name}: global llm_usage must be written by production code`);
      assert.equal(reservations.length, 1, `${name}: planner reservation missing`);
      if (name === 'full') {
        assert.equal(Number(usageRows[0].tokens_in) + Number(usageRows[0].tokens_out), 13);
        assert.equal(Number(usageRows[0].usage_known), 1);
        assert.equal(reservations[0].status, 'settled');
      } else {
        assert.equal(Number(usageRows[0].usage_known), 0, `${name}: llm_usage must be UNKNOWN`);
        assert.equal(usageRows[0].cost_source, 'unknown');
        assert.equal(reservations[0].status, 'unknown', `${name}: reservation must stay UNKNOWN`);
      }
    } finally { store.close(); server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
