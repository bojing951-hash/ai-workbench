#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 人工 E2E 预算授权（必须由用户在真实 TTY 中执行）。
 * 该脚本只写入 experiment_contracts，不触发任何模型调用。
 */
import process from 'node:process';
import readline from 'node:readline/promises';
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
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const typed = (await rl.question(`请在终端逐字输入授权确认语 ${expected}\n> `)).trim();
rl.close();
if (typed !== expected) {
  console.error('AUTHORIZATION_REQUIRED: 终端确认语不匹配');
  process.exit(3);
}
const projectId = val('--project-id');
const conversationId = val('--conversation-id');
const authorizedBy = val('--authorized-by');
if (!projectId && !conversationId) { console.error('必须指定 --project-id 或 --conversation-id'); process.exit(4); }
if (!authorizedBy) { console.error('必须指定 --authorized-by 实名'); process.exit(5); }
const hours = Number(val('--hours', '6'));
const now = Date.now();
const riskClient = val('--risk-client', '');
const riskProvider = val('--risk-provider', '');
const riskModel = val('--risk-model', '');
const riskRole = val('--risk-role', '');
const riskReason = val('--risk-reason', '');
const riskAcceptedBy = val('--risk-accepted-by', authorizedBy);
const riskMaxTokens = Number(val('--risk-max-tokens', '0'));
const riskSpecs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--risk-spec') continue;
  try {
    const parsed = JSON.parse(String(args[i + 1] || '[]'));
    if (!Array.isArray(parsed)) throw new Error('--risk-spec 必须是 JSON 数组');
    riskSpecs.push(...parsed);
  } catch (err) { console.error('风险许可 JSON 无法解析：' + err.message); process.exit(6); }
}
if (riskClient || riskProvider || riskModel || riskRole) {
  if (!(riskClient && riskProvider && riskModel && riskRole && riskReason)) {
    console.error('风险许可必须同时提供 --risk-role --risk-client --risk-provider --risk-model --risk-reason');
    process.exit(6);
  }
  riskSpecs.push({ role: riskRole, client: riskClient, provider: riskProvider, model: riskModel, reason: riskReason, acceptedBy: riskAcceptedBy, maxRiskTokens: riskMaxTokens });
}
for (const r of riskSpecs) {
  if (!r || !r.role || !r.client || !r.provider || !r.model || !r.reason) {
    console.error('每组风险许可必须包含 role/client/provider/model/reason：' + JSON.stringify(r));
    process.exit(6);
  }
}
const riskEntries = riskSpecs.map((r) => ({ role: String(r.role), client: String(r.client), provider: String(r.provider), model: String(r.model), acceptedBy: String(r.acceptedBy || riskAcceptedBy), acceptedAt: new Date(now).toISOString(), reason: String(r.reason), maxRiskTokens: Number(r.maxRiskTokens || riskMaxTokens || 0) }));
const config = getConfig();
const store = openStore(config.paths.dbPath);
try {
  const contract = store.createExperimentContract({
    projectId, conversationId, authorizedBy,
    authorizationSource: 'user_cli_tty',
    authorizationText: `${expected} project=${projectId} conversation=${conversationId} at=${new Date(now).toISOString()} tokenLimit=${val('--token-limit', '3620000')} costLimit=${val('--cost-limit', '80')} stopLoss=${val('--stop-loss', '72')} callLimit=${val('--call-limit', '50')} deadlineHours=${hours} glmTokens=${val('--glm-tokens', '4000000')} glmCost=${val('--glm-cost', '40')} dshTokens=${val('--dsh-tokens', '2000000')} dshCost=${val('--dsh-cost', '30')} nonGlmCost=${val('--non-glm-cost', '10')} perCallTokens=${val('--per-call-tokens', '20000')} risk=${riskEntries.length ? riskEntries.map((r) => `${r.role}/${r.client}/${r.provider}/${r.model}`).join(',') : 'none'} isolation=${val('--isolation', 'BLOCKED_UNLESS_APPROVED')}`,
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
    nonGlmCostLimitCny: Number(val('--non-glm-cost', '10')),
    perCallMaxTokens: Number(val('--per-call-tokens', '20000')),
    provider: {
      chat: { client: 'deepseek', provider: 'deepseek', model: 'deepseek-chat' },
      planner: { client: 'deepseek', provider: 'deepseek', model: 'deepseek-chat' },
      coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' },
      audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' },
      ...(riskEntries.length ? { risk: { unbounded: riskEntries } } : {}),
    },
    isolationMode: val('--isolation', 'BLOCKED_UNLESS_APPROVED'),
    stopConditions: ['product acceptance PASS', 'stopLoss', 'callLimit', 'deadline', 'budget exhausted', 'unrecoverable BLOCKED', 'user cancel'],
  });
  console.log(JSON.stringify({ ok: true, experimentId: contract.id, contractHash: contract.contract_hash, status: contract.status, deadlineAt: contract.deadline_at }, null, 2));
} finally { store.close(); }
