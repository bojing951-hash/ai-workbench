// SPDX-License-Identifier: Apache-2.0
/** v3.7：审计分块必须逐块预留；上限 3 允许两块，上限 1 第二块被阻断。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { runAudit } from '../src/auditors/index.js';

function mkConfig(root, port) {
  return getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 't.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'w'), artifactsDir: path.join(root, 'a'), logsDir: path.join(root, 'l'), agentsDir: path.join(root, 'ag'), dshHome: path.join(root, 'ag/dsh'), claudeHome: path.join(root, 'ag/claude') }, llm: { openai: { apiKey: 'fake-key', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-audit' }, glm: { apiKey: '', baseUrl: '', model: '' }, deepseek: { apiKey: '', baseUrl: '', model: '' } }, audit: { provider: 'openai', maxDiffChars: 80, maxChunks: 2, maxTokens: 1000, timeoutMs: 30000, resourceEstimateTokens: 100, requireIndependent: false, allowSameFamily: true } });
}
function mkExperiment(store, callLimit) {
  const accepted = { role: 'audit', client: 'openai', provider: 'openai', model: 'fake-audit', acceptedBy: 'user', acceptedAt: new Date().toISOString(), reason: 'test audit risk acceptance' };
  return store.createExperimentContract({ projectId: 'p-audit', authorizedBy: 'test', authorizationSource: 'user_chat_approval', authorizationText: 'zero-paid audit chunk test', tokenLimit: 100000, costLimitCny: 10, stopLossCny: 9, callLimit, deadlineAt: new Date(Date.now() + 3600_000).toISOString(), glmTokenLimit: 0, glmCostLimitCny: 0, dshTokenLimit: 0, dshCostLimitCny: 0, nonGlmCostLimitCny: 10, perCallMaxTokens: 20000, provider: { chat: { client: 'openai', provider: 'openai', model: 'fake-audit' }, planner: { client: 'openai', provider: 'openai', model: 'fake-audit' }, coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'openai', provider: 'openai', model: 'fake-audit' }, risk: { unbounded: [accepted] } }, isolationMode: 'DOCKER_REQUIRED' });
}
async function startServer(responses) {
  let count = 0;
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += String(d); }); req.on('end', () => { count += 1; const body = responses[Math.min(count - 1, responses.length - 1)]; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, count: () => count };
}
const AUDIT_BODY = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ score: 100, criteria: [{ criterion: 'A 完成', status: 'pass', evidence: 'verified product code' }], findings: [], required_fixes: [], summary: 'PASS' }) } }], usage: { prompt_tokens: 8, completion_tokens: 8 } };

test('v37 审计分块：上限 3 时两块分别预留、服务端 2 次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v37-audit-a-'));
  const srv = await startServer([AUDIT_BODY, AUDIT_BODY]);
  try {
    const config = mkConfig(root, srv.port); const store = openStore(config.paths.dbPath);
    try {
      const exp = mkExperiment(store, 3);
      const project = { id: 'p', name: 'p', local_path: root, audit_provider: 'openai' };
      const task = { id: 't', title: 't', acceptance_json: ['A 完成'], agent_kind: 'claude' };
      const budget = { config, store, provider: 'openai', model: 'fake-audit', estimatedTokens: 100, experimentId: exp.id, experimentScope: 'global', client: 'openai', requestKey: 'audit:test:a' };
      const result = await runAudit({ config, project, task, diff: 'diff --git a/a b/a\n' + 'x\n'.repeat(20) + 'diff --git a/b b/b\n' + 'y\n'.repeat(20), diffStat: '', testResult: { code: 0, stdout: 'ok' }, repoFiles: [], contextFiles: [], coderFamily: 'glm', versionInfo: { baseCommit: 'base', testedHash: 'tree' }, worktree: root, budget });
      assert.ok(result);
      assert.equal(srv.count(), 2, '两块必须各发送一次');
      assert.equal(store.experimentUsage(exp.id).calls, 2, '账本必须对应两笔预留');
    } finally { store.close(); }
  } finally { srv.srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v37 审计分块：上限 1 时第二块被预留拒绝，服务端最多 1 次且不得完整 PASS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v37-audit-b-'));
  const srv = await startServer([AUDIT_BODY, AUDIT_BODY]);
  try {
    const config = mkConfig(root, srv.port); const store = openStore(config.paths.dbPath);
    try {
      const exp = mkExperiment(store, 1);
      const project = { id: 'p', name: 'p', local_path: root, audit_provider: 'openai' };
      const task = { id: 't', title: 't', acceptance_json: ['A 完成'], agent_kind: 'claude' };
      const budget = { config, store, provider: 'openai', model: 'fake-audit', estimatedTokens: 100, experimentId: exp.id, experimentScope: 'global', client: 'openai', requestKey: 'audit:test:b' };
      await assert.rejects(() => runAudit({ config, project, task, diff: 'diff --git a/a b/a\n' + 'x\n'.repeat(20) + 'diff --git a/b b/b\n' + 'y\n'.repeat(20), diffStat: '', testResult: { code: 0, stdout: 'ok' }, repoFiles: [], contextFiles: [], coderFamily: 'glm', versionInfo: { baseCommit: 'base', testedHash: 'tree' }, worktree: root, budget }), /EXPERIMENT_BUDGET_BLOCKED|实验调用次数|experiment-call-limit/);
      assert.equal(srv.count(), 1, '最多只能发送一块');
    } finally { store.close(); }
  } finally { srv.srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v37 审计分块：身份不匹配默认阻断，服务端 0 次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v37-audit-c-'));
  const srv = await startServer([AUDIT_BODY]);
  try {
    const config = mkConfig(root, srv.port); const store = openStore(config.paths.dbPath);
    try {
      const exp = mkExperiment(store, 3);
      const project = { id: 'p', name: 'p', local_path: root, audit_provider: 'openai' };
      const task = { id: 't', title: 't', acceptance_json: ['A 完成'], agent_kind: 'claude' };
      const budget = { config, store, provider: 'openai', model: 'other-model', estimatedTokens: 100, experimentId: exp.id, experimentScope: 'global', client: 'openai', requestKey: 'audit:test:c' };
      await assert.rejects(() => runAudit({ config, project, task, diff: 'diff --git a/a b/a\n' + 'x\n'.repeat(20) + 'diff --git a/b b/b\n' + 'y\n'.repeat(20), diffStat: '', testResult: { code: 0, stdout: 'ok' }, repoFiles: [], contextFiles: [], coderFamily: 'glm', versionInfo: { baseCommit: 'base', testedHash: 'tree' }, worktree: root, budget }), /BUDGET_RISK_UNBOUNDED|BUDGET_RISK_BLOCKED/);
      assert.equal(srv.count(), 0);
    } finally { store.close(); }
  } finally { srv.srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
