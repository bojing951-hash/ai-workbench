// SPDX-License-Identifier: Apache-2.0
/** v3.9：正式 Planner 入口经 Reservation → llm_usage → 实验账本的一致用量语义。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { assertModelBudget, recordModelUsage } from '../src/budget.js';
import { summarizeUsage } from '../src/policy.js';
import { planTasks } from '../src/planner.js';

function mkConfig(root, port) {
  return getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 't.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(root, 'w'), artifactsDir: path.join(root, 'a'), logsDir: path.join(root, 'l'), agentsDir: path.join(root, 'ag'), dshHome: path.join(root, 'ag/dsh'), claudeHome: path.join(root, 'ag/claude') }, llm: { openai: { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-planner' }, glm: { apiKey: '', baseUrl: '', model: '' }, deepseek: { apiKey: '', baseUrl: '', model: '' } }, planner: { provider: 'openai', model: 'fake-planner', timeoutMs: 30000, maxTokens: 2000 }, budget: { maxTotalTokens: 1000000, maxCostCny: 100, minReserveTokens: 0 } });
}
function mkExperiment(store) {
  const accepted = { role: 'planner', client: 'openai', provider: 'openai', model: 'fake-planner', acceptedBy: 'user', acceptedAt: new Date().toISOString(), reason: 'test planner risk acceptance' };
  return store.createExperimentContract({ projectId: 'p-planner', authorizedBy: 'test', authorizationSource: 'user_chat_approval', authorizationText: 'zero-paid planner ledger test', tokenLimit: 100000, costLimitCny: 10, stopLossCny: 9, callLimit: 20, deadlineAt: new Date(Date.now() + 3600_000).toISOString(), glmTokenLimit: 0, glmCostLimitCny: 0, dshTokenLimit: 0, dshCostLimitCny: 0, nonGlmCostLimitCny: 10, perCallMaxTokens: 20000, provider: { chat: { client: 'openai', provider: 'openai', model: 'fake-planner' }, planner: { client: 'openai', provider: 'openai', model: 'fake-planner' }, coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' }, risk: { unbounded: [accepted] } }, isolationMode: 'DOCKER_REQUIRED' });
}
function bodyFor(usage) {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify({ title: 'P', tasks: [{ title: 'T1', description: 'implement T1', acceptance: ['A 完成'], testCommand: 'node -e "process.exit(0)"' }] }) } }], ...(usage === undefined ? {} : { usage }) };
}
test('v39 Planner 入口：8+5→13、0+0→已知零、缺失/null/部分→UNKNOWN 且保留 5000 占额', { timeout: 120_000 }, async () => {
  const cases = [
    { name: 'full', usage: { prompt_tokens: 8, completion_tokens: 5 }, known: true, total: 13 },
    { name: 'zero', usage: { prompt_tokens: 0, completion_tokens: 0 }, known: true, total: 0 },
    { name: 'missing', usage: undefined, known: false, total: 0 },
    { name: 'null', usage: { prompt_tokens: null, completion_tokens: null }, known: false, total: 0 },
    { name: 'partial', usage: { prompt_tokens: 8 }, known: false, total: 8 },
  ];
  for (const c of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wb-v39-planner-${c.name}-`));
    let received = 0;
    const server = http.createServer((req, res) => { received += 1; req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodyFor(c.usage))); }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const config = mkConfig(root, server.address().port);
    const store = openStore(config.paths.dbPath);
    try {
      const exp = mkExperiment(store);
      const reserved = assertModelBudget({ config, store, provider: 'openai', model: 'fake-planner', estimatedTokens: 5000, estimatedCostCny: 0.01, label: 'planner', reserve: true, requestKey: `planner:${c.name}`, experimentId: exp.id, experimentRole: 'planner', experimentClient: 'openai' });
      const planned = await planTasks({ config, project: { id: 'p-planner', name: 'p', local_path: root, default_branch: 'main' }, goal: 'g', acceptance: ['A 完成'], mode: 'auto', tasks: [] });
      const u = summarizeUsage(planned.usage || {});
      store.settleModelReservation(reserved.reservation.id, { actualTokens: u.total, actualCostCny: planned.costCny || 0, usageKnown: planned.usageKnown !== false });
      recordModelUsage({ store, config, source: 'planner', sourceId: `planner-${c.name}`, provider: 'openai', model: 'fake-planner', usage: planned.usage, usageKnown: planned.usageKnown, costCny: planned.costCny || 0, experimentId: exp.id, reservationId: reserved.reservation.id, costSource: c.known ? 'estimated' : 'unknown' });
      assert.equal(received, 1, c.name);
      const row = store.listLlmUsage().find((x) => x.source_id === `planner-${c.name}`);
      assert.ok(row, `${c.name} llm_usage missing`);
      assert.equal(Number(row.tokens_in) + Number(row.tokens_out), c.total, `${c.name} token total`);
      assert.equal(Number(row.usage_known), c.known ? 1 : 0, `${c.name} usage_known`);
      const resv = store.listModelReservations().find((x) => x.id === reserved.reservation.id);
      if (c.known) assert.equal(resv.status, 'settled', c.name);
      else assert.equal(resv.status, 'unknown', c.name);
      if (!c.known) assert.ok(store.reservedBudgetTotals().tokens >= 5000, `${c.name} must retain 5000 occupancy`);
    } finally { store.close(); server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
