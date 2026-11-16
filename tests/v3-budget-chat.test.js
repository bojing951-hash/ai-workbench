// SPDX-License-Identifier: Apache-2.0
/** v3.0 P0-4：Chat/Planner/Agent/Audit 使用同一预算账本；Chat 不得绕过预算。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { chatTurn } from '../src/chat.js';
import { assertModelBudget, budgetSnapshot, recordModelUsage } from '../src/budget.js';

function mk(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v3-budget-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: 'fake-key', model: 'deepseek-chat', baseUrl: 'http://127.0.0.1:1' } }, github: { token: '' }, security: { apiToken: 'test' }, budget: { maxTotalTokens: 500_000, maxCostCny: 30, minReserveTokens: 2_000, ...overrides } });
  const store = openStore(config.paths.dbPath);
  return { root, config, store };
}

test('v3.0 P0-4：统一账本包含 attempt/audit/chat 用量，Chat 预检超预算时拒绝调用', async () => {
  const { root, config, store } = mk();
  try {
    // 触发器入账：attempt/audit 用量进入同一账本
    store.createAttempt({ id: 'att-ledger', runId: 'run-x', taskId: 'task-x', attemptNo: 1, stage: 'coding', status: 'completed', tokensIn: 100, tokensOut: 20, costCny: 0.001 });
    store.createAudit({ id: 'aud-ledger', runId: 'run-x', taskId: 'task-x', attemptNo: 1, provider: 'deepseek', verdict: 'pass', score: 100, tokensIn: 30, tokensOut: 10, costCny: 0.0002 });
    const ledger = store.listLlmUsage();
    assert.equal(ledger.length, 2, 'attempt/audit 必须进入统一 llm_usage 账本');
    const totals = store.usageTotals();
    assert.equal(totals.tokensIn, 130);
    assert.equal(totals.tokensOut, 30);

    // 把可计费用量推到超过 chat 预检上限；Chat 不得绕过
    recordModelUsage({ store, config, source: 'test', sourceId: 'fill-budget', provider: 'deepseek', usage: { input: 499_000, output: 1_000 }, costCny: 1 });
    const conv = store.createConversation({ title: '预算测试' });
    store.addConversationMessage({ conversationId: conv.id, role: 'user', content: '你好', requestKey: 'u1' });
    await assert.rejects(chatTurn({ config, store, conversation: conv, userMessage: '你好', project: null }), /预算不足|BUDGET_CHAT/i);
    assert.equal(budgetSnapshot(store, config).remainingTokens < 1600, true);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v3.0 P0-4：GLM 豁免只按实际身份；未知 provider 不豁免', () => {
  const { root, config, store } = mk({ maxTotalTokens: 100_000 });
  try {
    recordModelUsage({ store, config, source: 'test', sourceId: 'unknown-usage', provider: 'unknown', usage: { input: 50_000, output: 10_000 }, costCny: 0.5 });
    assert.throws(() => assertModelBudget({ config, store, provider: 'unknown', estimatedTokens: 50_000, estimatedCostCny: 0.1 }), /预算不足/);
    // claimed GLM 但实际端点/模型无法确认时不豁免（identity unknown）
    assert.throws(() => assertModelBudget({ config, store, provider: 'glm', estimatedTokens: 50_000, estimatedCostCny: 0.1 }), /预算不足/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
