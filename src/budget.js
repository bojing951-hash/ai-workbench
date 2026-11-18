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
import { installPaidAdmission } from './paid-admission.js';

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
  const reserved = store.reservedBudgetTotals ? store.reservedBudgetTotals() : { tokens: 0, costCny: 0 };
  const remainingTokens = Math.max(0, cfg.maxTotalTokens - budgetTokens - Number(reserved.tokens || 0));
  const remainingCostCny = Math.max(0, cfg.maxCostCny - budgetCostCny - Number(reserved.costCny || 0));
  return {
    maxTokens: cfg.maxTotalTokens,
    reservedTokens: Number(reserved.tokens || 0),
    reservedCostCny: Number(reserved.costCny || 0),
    remainingTokens,
    remainingCostCny,
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

export function assertModelBudget({ config, store, provider, model = '', estimatedTokens = 2000, estimatedCostCny = 0.02, label = '模型调用', reserve = false, requestKey = '', reservationId = '', experimentId = '', experimentScope = '', experimentRole = '', experimentClient = '' }) {
  const identity = resolveLlmIdentity({ config, provider });
  const effectiveModel = model || identity.model || '';
  if (experimentId && experimentRole) {
    const gate = evaluateProviderRiskGate({ store, experimentId, binding: { client: experimentClient || provider, provider, model: effectiveModel, role: experimentRole } });
    if (!gate.ok) throw new PolicyError('BUDGET_RISK_BLOCKED', `${label}: 实验 Provider 风险准入失败（${gate.code}），禁止付费调用`, { experimentId, role: experimentRole });
  }
  const estimate = Math.max(1, Number(estimatedTokens || 0));
  const estCost = Number(estimatedCostCny || 0) || estimateCostCny(identity.provider, model || identity.model, { input: Math.round(estimate * 0.75), output: Math.round(estimate * 0.25) });
  const snap = budgetSnapshot(store, config);
  const glmConfigured = !!(config?.llm?.glm?.apiKey && (config.llm.glm.baseUrl || config.llm.glm.model));
  const identityExempt = !!(glmConfigured && isExemptIdentity(identity, config));
  const scope = experimentScope || (identityExempt ? 'glm' : 'global');
  if (identityExempt && !experimentId) {
    return { identity, exempt: true, snapshot: snap, estimatedTokens: estimate, estimatedCostCny: estCost, reservation: null };
  }
  if (reserve) {
    const id = reservationId || `res_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const result = store.reserveModelBudget({
      id, requestKey: requestKey || id, provider: identity.provider, model: model || identity.model,
      estimatedTokens: estimate, estimatedCostCny: estCost,
      maxTokens: config.budget.maxTotalTokens, maxCostCny: config.budget.maxCostCny,
      minReserveTokens: config.budget.minReserveTokens, cacheTokenWeight: config.budget.cacheTokenWeight,
      exemptProviders: config.budget.exemptProviders || ['glm'], ttlMs: Number(config.budget.reservationTtlMs || 10 * 60 * 1000),
      experimentId, experimentScope: scope, exemptGlobal: identityExempt,
    });
    if (!result.ok) {
      const isExperimentBlock = /^experiment-/.test(String(result.reason || ''));
      const code = isExperimentBlock ? 'EXPERIMENT_BUDGET_BLOCKED' : 'BUDGET_CHAT_TOKENS_EXCEEDED';
      throw new PolicyError(code, `${label}${isExperimentBlock ? `实验硬限制阻止（${result.reason}）` : '预算不足（预留失败）'}：可用额度不足以覆盖本次调用；请授权或降低用量`, result);
    }
    if (result.existing) {
      // settled 不能再次执行付费调用；reserved 并发重复也不能再发一次。
      const status = result.reservation?.status || 'existing';
      throw new PolicyError('MODEL_CALL_DUPLICATE', `${label} 的 requestKey 已存在（${status}），拒绝重复付费调用`, { reservation: result.reservation });
    }
    if (experimentId) installPaidAdmission({ experimentId, role: experimentRole || label, maxSends: 1, requestKey: requestKey || id });
    return { identity, exempt: identityExempt, snapshot: budgetSnapshot(store, config), estimatedTokens: estimate, estimatedCostCny: estCost, reservation: result.reservation, experimentId: result.experimentId || experimentId };
  }
  if (experimentId) {
    const experiment = store.getExperimentContract(experimentId);
    if (!experiment || !['authorized', 'running'].includes(experiment.status)) throw new PolicyError('EXPERIMENT_BUDGET_BLOCKED', `${label}: 没有有效的实验授权契约`, { experimentId });
    if (experiment.deadline_at && Date.now() > Date.parse(experiment.deadline_at)) throw new PolicyError('EXPERIMENT_BUDGET_BLOCKED', `${label}: 实验已超过截止时间`, { experimentId });
    const u = store.experimentUsage(experimentId);
    if (Number(experiment.call_limit || 0) > 0 && Number(u.calls || 0) >= Number(experiment.call_limit)) throw new PolicyError('EXPERIMENT_BUDGET_BLOCKED', `${label}: 实验调用次数已达上限 ${experiment.call_limit}`, { experimentId });
    if (Number(experiment.token_limit || 0) > 0 && Number(u.tokens || 0) + estimate > Number(experiment.token_limit)) throw new PolicyError('EXPERIMENT_BUDGET_BLOCKED', `${label}: 实验 Token 达上限`, { experimentId });
    if (Number(experiment.cost_limit_cny || 0) > 0 && Number(u.costCny || 0) + estCost > Number(experiment.cost_limit_cny)) throw new PolicyError('EXPERIMENT_BUDGET_BLOCKED', `${label}: 实验费用达硬上限`, { experimentId });
    if (Number(experiment.stop_loss_cny || 0) > 0 && Number(u.costCny || 0) + estCost >= Number(experiment.stop_loss_cny)) throw new PolicyError('EXPERIMENT_BUDGET_BLOCKED', `${label}: 实验费用达到提前停止线`, { experimentId });
  }
  const reserveTokens = Number(config.budget.minReserveTokens || 0);
  if (snap.remainingTokens < estimate || snap.remainingTokens <= reserveTokens) {
    throw new PolicyError('BUDGET_CHAT_TOKENS_EXCEEDED', `${label}预算不足：预计 ${estimate} tokens，剩余 ${Math.round(snap.remainingTokens)}（保留 ${reserveTokens}）；请授权或降低用量`, { ...snap, estimatedTokens: estimate });
  }
  if (snap.remainingCostCny < estCost) {
    throw new PolicyError('BUDGET_CHAT_COST_EXCEEDED', `${label}预算不足：预计 ¥${estCost.toFixed(4)}，剩余 ¥${snap.remainingCostCny.toFixed(4)}；请授权或降低用量`, { ...snap, estimatedCostCny: estCost });
  }
  return { identity, exempt: false, snapshot: snap, estimatedTokens: estimate, estimatedCostCny: estCost };
}

export function recordModelUsage({ store, config, source, provider, model = '', usage = {}, usageKnown: usageKnownInput, costCny = 0, sourceId = '', runId = '', taskId = '', projectId = '', conversationId = '', budgetScope = 'global', costSource = 'estimated', reservationId = '' }) {
  const identity = resolveLlmIdentity({ config, provider });
  const u = summarizeUsage(usage || {});
  const usageKnown = typeof usageKnownInput === 'boolean' ? usageKnownInput : !(u.total === 0 && !(usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)));
  const row = store.addLlmUsage({
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
  if (reservationId) {
    store.settleModelReservation(reservationId, { actualTokens: u.total, actualCostCny: Number(costCny || 0), usageKnown: !!usageKnown });
  }
  return row;
}

export function chatBudgetEstimate(provider, model = '') {
  return { estimatedTokens: 1600, estimatedCostCny: Number(estimateCostCny(provider, model, { input: 1200, output: 400 }).toFixed(6)) };
}

/**
 * Provider 是否具备“调用中可执行”的费用/Token 硬边界。
 * 当前真实 Coding/GLM/Claude Code 只能调用后结算，因此返回 false；
 * 只有未来接入网关/供应商硬限额并有测试证明时才可改为 true。
 */
export function providerHasExecutableCostLimit({ client = '', provider = '', model = '' } = {}) {
  return false;
}

/**
 * 无界风险许可必须绑定实验契约（provider_json.risk.unbounded），
 * 精确匹配 client/provider/model，且包含授权人、时间、原因和风险说明。
 * 环境变量或单个配置开关不能成为授权来源。
 */
export function riskAcceptanceFor(experiment, binding = {}) {
  const entries = experiment?.provider_json?.risk?.unbounded;
  if (!Array.isArray(entries)) return null;
  return entries.find((e) => e && String(e.client) === String(binding.client || '') && String(e.provider) === String(binding.provider || '') && String(e.model) === String(binding.model || '') && (!binding.role || String(e.role) === String(binding.role))
    && String(e.acceptedBy || '').trim().length >= 2 && String(e.acceptedAt || '').trim().length >= 10 && String(e.reason || '').trim().length >= 8) || null;
}

/**
 * 统一实验 Provider 风险准入。返回 ok 不是费用硬上限，只表示：
 * - Provider 具备可执行硬边界；或
 * - 冻结实验契约中存在与 client/provider/model 精确匹配且哈希有效的用户风险许可。
 */
export function evaluateProviderRiskGate({ store, experimentId, binding = {} } = {}) {
  const exp = store?.getExperimentContract?.(experimentId);
  if (!exp) return { ok: false, code: 'EXPERIMENT_NOT_FOUND' };
  if (!store.verifyExperimentContractHash(experimentId)) return { ok: false, code: 'EXPERIMENT_CONTRACT_HASH_INVALID' };
  if (!['authorized', 'running'].includes(exp.status)) return { ok: false, code: 'EXPERIMENT_NOT_ACTIVE', status: exp.status };
  if (providerHasExecutableCostLimit(binding)) return { ok: true, mode: 'executable-hard-limit', experiment: exp };
  const accepted = riskAcceptanceFor(exp, binding);
  if (!accepted) return { ok: false, code: 'BUDGET_RISK_UNBOUNDED' };
  return { ok: true, mode: 'contract-risk-accepted', acceptance: accepted, experiment: exp };
}

/**
 * 单次 Coding 调用的确定性预留算法：
 * - perTaskTokens 是任务剩余可用额度；
 * - perCallMaxTokens 是实验契约对单次预留的硬上限；
 * - 预留必须同时满足两者，不能把 per-call 限制用于真实执行硬封顶。
 */
export function resolveCodingReservation({ perTaskTokens = 0, perCallMaxTokens = 0 } = {}) {
  const taskCap = Math.max(0, Number(perTaskTokens || 0));
  const callCap = Math.max(0, Number(perCallMaxTokens || 0));
  const tokens = callCap > 0 ? Math.min(taskCap, callCap) : taskCap;
  return { ok: Number.isFinite(tokens) && tokens > 0, tokens, perTaskTokens: taskCap, perCallMaxTokens: callCap, reason: tokens > 0 ? '' : 'no-remaining-budget' };
}
