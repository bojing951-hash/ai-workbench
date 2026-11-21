// SPDX-License-Identifier: Apache-2.0
/** v3.6 P0：单次实验预留只允许一次实际 HTTP 发送，JSON/HTTP 重试不得越过调用上限。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { assertModelBudget } from '../src/budget.js';
import { completeJson } from '../src/llm.js';

test('v36 付费准入：call limit=1 时 JSON 重试/HTTP 重试实际发送不超过 1 次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v36-paid-'));
  let received = 0;
  const server = http.createServer((req, res) => {
    received += 1; req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'not-json-first-response' } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 't.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'w'), artifactsDir: path.join(root, 'a'), logsDir: path.join(root, 'l'), agentsDir: path.join(root, 'ag'), dshHome: path.join(root, 'ag/dsh'), claudeHome: path.join(root, 'ag/claude') }, llm: { openai: { apiKey: 'fake-key', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake' }, glm: { apiKey: '', baseUrl: '', model: '' }, deepseek: { apiKey: '', baseUrl: '', model: '' } }, budget: { maxTotalTokens: 1_000_000, maxCostCny: 100, minReserveTokens: 0, maxTokensPerTask: 100_000 } });
    const store = openStore(config.paths.dbPath);
    try {
      const exp = store.createExperimentContract({
        projectId: 'p-paid', authorizedBy: 'test', authorizationSource: 'user_chat_approval', authorizationText: 'zero-paid admission test',
        tokenLimit: 100_000, costLimitCny: 10, stopLossCny: 9, callLimit: 1, deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
        glmTokenLimit: 0, glmCostLimitCny: 0, dshTokenLimit: 0, dshCostLimitCny: 0, nonGlmCostLimitCny: 10, perCallMaxTokens: 20_000,
        provider: { chat: { client: 'openai', provider: 'openai', model: 'fake' }, planner: { client: 'openai', provider: 'openai', model: 'fake' }, coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' }, risk: { unbounded: [{ role: 'chat', client: 'openai', provider: 'openai', model: 'fake', acceptedBy: 'user', acceptedAt: new Date().toISOString(), reason: 'explicit test risk acceptance' }] } },
        isolationMode: 'DOCKER_REQUIRED',
      });
      assertModelBudget({ config, store, provider: 'openai', model: 'fake', estimatedTokens: 100, estimatedCostCny: 0.01, label: 'chat', reserve: true, requestKey: 'paid-send-1', experimentId: exp.id, experimentRole: 'chat', experimentClient: 'openai' });
      await assert.rejects(() => completeJson({ config, provider: 'openai', model: 'fake', messages: [{ role: 'user', content: 'return JSON' }], maxTokens: 20 }), /PAID_SEND_LIMIT|单次预留/);
      assert.equal(received, 1, `实际发送必须为 1，实际=${received}`);
      const u = store.experimentUsage(exp.id);
      assert.equal(u.calls, 1);
    } finally { store.close(); }
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
