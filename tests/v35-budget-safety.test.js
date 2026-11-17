// SPDX-License-Identifier: Apache-2.0
/** v3.5 P0-1：实验预算原子预留、实际用量越线、UNKNOWN、重复请求与分项上限。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { providerHasExecutableCostLimit, riskAcceptanceFor } from '../src/budget.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-budget-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') } });
  return { root, config, store: openStore(config.paths.dbPath) };
}
function contract(store, over = {}) {
  return store.createExperimentContract({
    projectId: 'p', authorizedBy: 'test', authorizationSource: 'user_chat_approval', authorizationText: 'zero-paid budget test',
    tokenLimit: 1000, costLimitCny: 1, stopLossCny: 0.9, callLimit: 5, deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
    glmTokenLimit: 800, glmCostLimitCny: 0.8, dshTokenLimit: 500, dshCostLimitCny: 0.5, nonGlmCostLimitCny: 0.5, perCallMaxTokens: 500,
    provider: { chat: { client: 'deepseek', provider: 'deepseek', model: 'deepseek-chat' }, planner: { client: 'deepseek', provider: 'deepseek', model: 'deepseek-chat' }, coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' } },
    isolationMode: 'DOCKER_REQUIRED', ...over,
  });
}
function reserve(store, contractId, key, est = 100, scope = 'global') {
  return store.reserveModelBudget({ id: `res_${key}_${Math.random().toString(36).slice(2, 8)}`, requestKey: key, provider: scope === 'glm' ? 'glm' : 'deepseek', model: 'm', estimatedTokens: est, estimatedCostCny: 0.01, maxTokens: 1e9, maxCostCny: 1e9, experimentId: contractId, experimentScope: scope, exemptGlobal: scope === 'glm' });
}

test('v35 预算：实际用量超过实验上限后立即 overspent，并阻断后续调用', () => {
  const h = mk();
  try {
    const c = contract(h.store);
    const r = reserve(h.store, c.id, 'k1', 100);
    assert.equal(r.ok, true);
    h.store.settleModelReservation(r.reservation.id, { actualTokens: 2000, actualCostCny: 0.02, usageKnown: true });
    assert.equal(h.store.getExperimentContract(c.id).status, 'overspent');
    const next = reserve(h.store, c.id, 'k2', 100);
    assert.equal(next.ok, false);
    assert.match(String(next.reason), /not-authorized|token-limit|cost/);
    h.store.endExperiment(c.id, 'completed', 'must not mask overspend');
    assert.equal(h.store.getExperimentContract(c.id).status, 'overspent');
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 预算：per-call 上限在执行前阻断', () => {
  const h = mk();
  try {
    const c = contract(h.store);
    const r = reserve(h.store, c.id, 'too-big', 600);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'experiment-per-call-token-limit');
    assert.equal(h.store.experimentUsage(c.id).calls, 0);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 预算：UNKNOWN 保守占额，重复请求不重复计费', () => {
  const h = mk();
  try {
    const c = contract(h.store);
    const r1 = reserve(h.store, c.id, 'unknown-1', 200);
    assert.equal(r1.ok, true);
    h.store.markModelReservationUnknown(r1.reservation.id);
    const u = h.store.experimentUsage(c.id);
    assert.equal(u.calls, 1);
    assert.ok(u.tokens >= 200);
    const r2 = reserve(h.store, c.id, 'settled-dup', 200);
    h.store.settleModelReservation(r2.reservation.id, { actualTokens: 200, actualCostCny: 0.01 });
    const r3 = reserve(h.store, c.id, 'settled-dup', 200);
    assert.equal(r3.ok, true);
    assert.equal(r3.existing, true);
    assert.equal(h.store.experimentUsage(c.id).calls, 2);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 预算：GLM 分项 Token 上限独立阻断', () => {
  const h = mk();
  try {
    const c = contract(h.store);
    const grant = reserve(h.store, c.id, 'glm-lim', 450, 'glm');
    assert.equal(grant.ok, true);
    const next = reserve(h.store, c.id, 'glm-lim-2', 400, 'glm');
    assert.equal(next.ok, false);
    assert.match(String(next.reason), /glm/);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 预算：实际用量超过预留但未越线，下一预留按实际占用拒绝', () => {
  const h = mk();
  try {
    const c = contract(h.store);
    const r = reserve(h.store, c.id, 'actual-high', 100);
    h.store.settleModelReservation(r.reservation.id, { actualTokens: 900, actualCostCny: 0.1 });
    const next = reserve(h.store, c.id, 'after-high', 200);
    assert.equal(next.ok, false);
    assert.match(String(next.reason), /token-limit/);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});


test('v35 风险准入：默认无边界 Provider 被拒绝，风险许可必须精确绑定契约', () => {
  const h = mk();
  try {
    assert.equal(providerHasExecutableCostLimit({ client: 'claude', provider: 'glm', model: 'glm-5.3' }), false);
    const base = contract(h.store);
    assert.equal(riskAcceptanceFor(base, { client: 'claude', provider: 'glm', model: 'glm-5.3' }), null);
    const accepted = { client: 'claude', provider: 'glm', model: 'glm-5.3', acceptedBy: 'user', acceptedAt: new Date().toISOString(), reason: 'user accepted unbounded risk for this frozen experiment', maxRiskTokens: 250000 };
    const c2 = contract(h.store, { projectId: 'p2', provider: { ...base.provider_json, risk: { unbounded: [accepted] } } });
    assert.ok(riskAcceptanceFor(c2, { client: 'claude', provider: 'glm', model: 'glm-5.3' }));
    assert.equal(riskAcceptanceFor(c2, { client: 'claude', provider: 'anthropic', model: 'claude' }), null);
    assert.equal(riskAcceptanceFor(c2, { client: 'claude', provider: 'openai', model: 'gpt' }), null);
    // 环境变量不是授权来源：contract 没 risk 时仍为 null
    assert.equal(riskAcceptanceFor(base, { client: 'claude', provider: 'glm', model: 'glm-5.3' }), null);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});
