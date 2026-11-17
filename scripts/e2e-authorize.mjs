#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 人工 E2E 预算授权（必须由用户在真实 TTY 中执行）。
 * 该脚本只写入 experiment_contracts，不触发任何模型调用。
 */
import process from 'node:process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const val = (k, d = '') => { const i = args.indexOf(k); return i >= 0 ? String(args[i + 1] || '') : d; };
if (!process.stdin.isTTY) {
  console.error('AUTHORIZATION_REQUIRED: 必须在交互式 TTY 中由用户本人执行；禁止 Agent/脚本自动授权。');
  process.exit(2);
}
const expected = 'I_AUTHORIZE_E2E_BUDGET_V1';
if (val('--confirm') !== expected) {
  console.error(`AUTHORIZATION_REQUIRED: 必须显式提供 --confirm ${expected}`);
  process.exit(3);
}
const projectId = val('--project-id');
const conversationId = val('--conversation-id');
const authorizedBy = val('--authorized-by');
if (!projectId && !conversationId) { console.error('必须指定 --project-id 或 --conversation-id'); process.exit(4); }
if (!authorizedBy) { console.error('必须指定 --authorized-by 实名'); process.exit(5); }
const hours = Number(val('--hours', '6'));
const now = Date.now();
const config = getConfig();
const store = openStore(config.paths.dbPath);
try {
  const contract = store.createExperimentContract({
    projectId, conversationId, authorizedBy,
    authorizationSource: 'user_cli_tty',
    authorizationText: `I authorize AI Workbench E2E budget ${expected} project=${projectId} conversation=${conversationId} at=${new Date(now).toISOString()}`,
    contractVersion: val('--contract-version', 'e2e-budget-v1'),
    tokenLimit: Number(val('--token-limit', '3620000')),
    costLimitCny: Number(val('--cost-limit', '80')),
    stopLossCny: Number(val('--stop-loss', '72')),
    callLimit: Number(val('--call-limit', '50')),
    deadlineAt: new Date(now + hours * 3600_000).toISOString(),
    glmTokenLimit: Number(val('--glm-tokens', '4000000')),
    glmCostLimitCny: Number(val('--glm-cost', '40')),
    dshTokenLimit: Number(val('--dsh-tokens', '2000000')),
    dshCostLimitCny: Number(val('--dsh-cost', '30')),
    provider: { chat: 'deepseek/deepseek-chat', planner: 'deepseek/deepseek-chat', coding: 'Claude Code/GLM-5.3', audit: 'DSH/DeepSeek' },
    isolationMode: val('--isolation', 'BLOCKED_UNLESS_APPROVED'),
    stopConditions: ['product acceptance PASS', 'stopLoss', 'callLimit', 'deadline', 'budget exhausted', 'unrecoverable BLOCKED', 'user cancel'],
  });
  console.log(JSON.stringify({ ok: true, experimentId: contract.id, contractHash: contract.contract_hash, status: contract.status, deadlineAt: contract.deadline_at }, null, 2));
} finally { store.close(); }
