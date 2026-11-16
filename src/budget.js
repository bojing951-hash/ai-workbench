// SPDX-License-Identifier: Apache-2.0
/**
 * v3.0 统一模型预算/用量账本。
 * 所有模型入口（Chat/Planner/Coding/Audit/Quality）在调用前走同一预算口径，
 * 调用后写入 llm_usage；GLM 豁免只基于实际模型身份，不基于调用入口或供应商名称。
 */
import { PolicyError, summarizeUsage } from './policy.js';
import { resolveLlmIdentity, isExemptIdentity } from './model-identity.js';
import { estimateCostCny } from './pricing.js';
import { nowIso } from './util.js';

export function budgetSnapshot(store, config) {
  const used = store.usageTotals();
  const cfg = config.budget;
  const weight = Number(cfg.cacheTokenWeight ?? 0.1);
  const exempt = new Set((cfg.exemptProviders || ['glm']).map((x) => String(x).toLowerCase()));
  let budgetTokens = 0;
  let budgetCostCny = 0;
  for (const [name, agg] of Object.entries(used.byProvider || {})) {
    if (exempt.has(String(name).toLowerCase()) && agg.known !== false) continue;
    budgetTokens += Number(agg.tokensIn || 0) + Number(agg.tokensOut || 0) + Number(agg.tokensCache || 0) * weight;
    budgetCostCny += Number(agg.costCny || 0);
  }
  const projectAudit = used.projectAudit || { tokens: 0, costCny: 0 };
  return {
    maxTokens: cfg.maxTotalTokens,
    remainingTokens: Math.max(0, cfg.maxTotalTokens - budgetTokens),
    remainingCostCny: Math.max(0, cfg.maxCostCny - budgetCostCny),
    usedTokens: used.tokens + Number(projectAudit.tokens || 0),
    usedCostCny: Number((used.costCny + Number(projectAudit.costCny || 0)).toFixed(4)),
    budgetTokens,
    budgetCostCny,
    byProvider: used.byProvider,
    projectAudit,
    glmUnlimited: cfg.glmUnlimited !== false,
    cacheTokenWeight: weight,
    note: 'GLM 仅当实际供应商身份确认时豁免；Chat/Planner/Agent/Audit/Quality 统一统计',
  };
}

export function assertModelBudget({ config, store, provider, model = '', estimatedTokens = 2000, estimatedCostCny = 0.02, label = '模型调用' }) {
  const identity = resolveLlmIdentity({ config, provider });
  const estimate = Math.max(1, Number(estimatedTokens || 0));
  const estCost = Number(estimatedCostCny || 0) || estimateCostCny(identity.provider, model || identity.model, { input: Math.round(estimate * 0.75), output: Math.round(estimate * 0.25) });
  const snap = budgetSnapshot(store, config);
  const glmConfigured = !!(config?.llm?.glm?.apiKey && (config.llm.glm.baseUrl || config.llm.glm.model));
  if (glmConfigured && isExemptIdentity(identity, config)) {
    return { identity, exempt: true, snapshot: snap, estimatedTokens: estimate, estimatedCostCny: estCost };
  }
  const reserve = Number(config.budget.minReserveTokens || 0);
  if (snap.remainingTokens - reserve < estimate) {
    throw new PolicyError('BUDGET_CHAT_TOKENS_EXCEEDED', `${label}预算不足：预计 ${estimate} tokens，剩余 ${Math.round(snap.remainingTokens - reserve)}（保留 ${reserve}）；请授权或降低用量`, { ...snap, estimatedTokens: estimate });
  }
  if (snap.remainingCostCny < estCost) {
    throw new PolicyError('BUDGET_CHAT_COST_EXCEEDED', `${label}预算不足：预计 ¥${estCost.toFixed(4)}，剩余 ¥${snap.remainingCostCny.toFixed(4)}；请授权或降低用量`, { ...snap, estimatedCostCny: estCost });
  }
  return { identity, exempt: false, snapshot: snap, estimatedTokens: estimate, estimatedCostCny: estCost };
}

export function recordModelUsage({ store, config, source, provider, model = '', usage = {}, costCny = 0, sourceId = '', runId = '', taskId = '', projectId = '', conversationId = '', budgetScope = 'global', costSource = 'estimated' }) {
  const identity = resolveLlmIdentity({ config, provider });
  const u = summarizeUsage(usage || {});
  const usageKnown = !(u.total === 0 && !(usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)));
  return store.addLlmUsage({
    id: sourceId ? `usage_${source}_${sourceId.replace(/[^a-zA-Z0-9_:-]/g, '_')}` : undefined,
    sourceId: sourceId || '',
    source,
    runId,
    taskId,
    projectId,
    conversationId,
    provider: identity.known ? identity.provider : 'unknown',
    providerKnown: identity.known,
    providerSource: identity.source,
    model: model || identity.model || '',
    tokensIn: u.input,
    tokensOut: u.output,
    tokensCache: u.cacheRead + u.cacheWrite,
    costCny: Number(costCny || 0),
    costSource: usageKnown ? costSource : 'unknown',
    usageKnown,
    budgetScope,
  });
}

export function chatBudgetEstimate(provider, model = '') {
  return { estimatedTokens: 1600, estimatedCostCny: Number(estimateCostCny(provider, model, { input: 1200, output: 400 }).toFixed(6)) };
}
