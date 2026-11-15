// SPDX-License-Identifier: Apache-2.0
/** 策略与预算：硬性上限、保护路径、审计结论校验、敏感信息脱敏。 */
import { matchesAny, redactSecrets } from './util.js';

export class PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const TaskStatus = Object.freeze({
  QUEUED: 'queued',
  PREPARING: 'preparing',
  CODING: 'coding',
  TESTING: 'testing',
  AUDITING: 'auditing',
  REPAIRING: 'repairing',
  COMMITTING: 'committing',
  PASSED: 'passed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

export const RunStatus = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  INTERRUPTED: 'interrupted',
  AWAITING_ACCEPTANCE: 'awaiting_acceptance',
  ACCEPTED: 'accepted',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export function remainingBudget(config, spent = {}) {
  const tokens = config.budget.maxTotalTokens - Number(spent.tokens || 0);
  const costCny = config.budget.maxCostCny - Number(spent.costCny || 0);
  return { tokens, costCny };
}

export function assertBudgetAllowed(config, spent, { estimatedTokens = 0, estimatedCostCny = 0 } = {}) {
  const remaining = remainingBudget(config, spent);
  if (remaining.tokens - config.budget.minReserveTokens <= 0) {
    throw new PolicyError('BUDGET_TOKENS_EXHAUSTED', `token 预算不足：剩余 ${Math.max(0, remaining.tokens)}，需保留 ${config.budget.minReserveTokens} 以内结算`, remaining);
  }
  if (remaining.tokens - estimatedTokens < 0) {
    throw new PolicyError('BUDGET_TOKENS_EXCEEDED', `预计消耗 ${estimatedTokens} tokens 超过剩余预算 ${remaining.tokens}`, remaining);
  }
  if (remaining.costCny - estimatedCostCny < 0) {
    throw new PolicyError('BUDGET_COST_EXCEEDED', `预计成本 ¥${estimatedCostCny} 超过剩余预算 ¥${remaining.costCny.toFixed(2)}`, remaining);
  }
  return remaining;
}

export function protectPathsForProject(project, config) {
  const projectPaths = Array.isArray(project?.protected_paths) ? project.protected_paths : [];
  return [...new Set([...(config.policy.protectedPaths || []), ...projectPaths])];
}

/** 返回被 Agent 非法修改的保护文件列表。 */
export function protectedViolations(changedFiles, protectedPaths) {
  const files = changedFiles.map((f) => (typeof f === 'string' ? f : f.file)).filter(Boolean);
  return files.filter((file) => matchesAny(file, protectedPaths));
}

export function redact(text, config) {
  return redactSecrets(text, config?.secrets || []);
}

export function assertNeverMerge(config) {
  if (!config.policy.neverMerge) return;
  // 防御式：拒绝任何合并主分支配置
  if (config.policy.allowMergeMain === true) {
    throw new PolicyError('MERGE_FORBIDDEN', '工作台策略禁止合并主分支');
  }
}

/**
 * 独立审计结论的"硬校验"：以结构化 criteria 为准，不信任模型自述 verdict。
 * 规则：所有 acceptance criterion 必须 pass；存在 high 级 finding 则 fail；任何 unproven 视为 fail。
 */
export function finalizeAuditVerdict(audit, acceptance = []) {
  const criteria = Array.isArray(audit?.criteria) ? audit.criteria : [];
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const requiredFixes = Array.isArray(audit?.required_fixes) ? audit.required_fixes : [];
  const normalizedCriteria = acceptance.map((criterion, idx) => {
    const found =
      criteria.find((c) => String(c.criterion || '').trim() === String(criterion).trim()) ||
      criteria[idx] ||
      null;
    const status = String(found?.status || 'unproven').toLowerCase();
    return {
      criterion,
      status: ['pass', 'fail', 'unproven'].includes(status) ? status : 'unproven',
      evidence: String(found?.evidence || ''),
    };
  });
  const highFindings = findings.filter((f) => String(f.severity || '').toLowerCase() === 'high');
  const allCriteriaPass = normalizedCriteria.length > 0 && normalizedCriteria.every((c) => c.status === 'pass');
  const verdict = allCriteriaPass && highFindings.length === 0 ? 'pass' : 'fail';
  const failedCriteria = normalizedCriteria.filter((c) => c.status !== 'pass');
  const autoFixes = [
    ...requiredFixes.map((f) => String(f)),
    ...failedCriteria.map((c) => `未满足验收标准：${c.criterion}${c.evidence ? `（证据：${c.evidence}）` : ''}`),
    ...highFindings.map((f) => `高风险问题：${f.issue || f.title || '未说明'}${f.file ? ` @ ${f.file}${f.line ? ':' + f.line : ''}` : ''}`),
  ];
  return {
    verdict,
    score: Number.isFinite(Number(audit?.score)) ? Number(audit.score) : verdict === 'pass' ? 100 : 0,
    criteria: normalizedCriteria,
    findings,
    requiredFixes: [...new Set(autoFixes.filter(Boolean))],
    summary: String(audit?.summary || ''),
    highFindings,
  };
}

export function summarizeUsage(usage = {}) {
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheWrite = Number(usage.cacheWrite || 0);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
