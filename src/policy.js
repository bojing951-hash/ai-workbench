// SPDX-License-Identifier: Apache-2.0
/** 策略与预算：硬性上限、保护路径、审计结论校验、敏感信息脱敏。 */
import crypto from 'node:crypto';
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
export function normalizeCriterion(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function evidenceIsConcrete(evidence) {
  const text = String(evidence || '').trim();
  if (text.length < 12) return false;
  if (/^(无|none|n\/a|unknown|不确定|未提供|未验证|-+|—+)$/i.test(text)) return false;
  // 结构化证据：文件/路径:行号、代码符号、测试命令/用例名、命令输出、提交 SHA 等
  const structural = [
    /[\w./-]+\.(js|mjs|ts|tsx|jsx|py|md|json|yml|yaml|sql|sh|java|go|rs|c|cpp|txt)(:\d+)?/i,
    /(npm test|node --test|pytest|python3? -m|go test|cargo test)/i,
    /(test|spec|用例|断言|assert)[^\s]{0,20}/i,
    /\b[0-9a-f]{7,40}\b/i,
    /(命令|退出码|stdout|stderr|输出|行号|line \d+)/i,
    /https?:\/\//i,
  ];
  return structural.some((re) => re.test(text));
}

export function modelFamily(provider, model = '') {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p.includes('openai') || /gpt|o[1-9]|o3|o4/.test(m)) return 'openai';
  if (p.includes('glm') || m.includes('glm')) return 'glm';
  if (p.includes('deepseek') || m.includes('deepseek')) return 'deepseek';
  if (p.includes('anthropic') || m.includes('claude')) return 'anthropic';
  return 'unknown';
}

/**
 * 独立审计结论的硬校验（P0-3）：
 * - 验收标准必须逐条精确匹配（normalize 空白后精确相等），不接受下标兜底/缺失；
 * - PASS 必须有具体证据，缺证据不能 PASS；
 * - 显式 fail 或 high finding -> FAIL；unproven/缺失/证据不足 -> UNKNOWN；
 * - 返回 status（PASS/FAIL/UNKNOWN）供编排器决策；verdict 保留兼容（pass/fail）。
 */
export function finalizeAuditVerdict(audit, acceptance = [], { requireEvidence = true } = {}) {
  const criteriaRaw = Array.isArray(audit?.criteria) ? audit.criteria : [];
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const requiredFixes = [];
  const unknownReasons = [];
  const highFindings = findings.filter((f) => String(f.severity || '').toLowerCase() === 'high');
  const normalized = [];
  const seen = new Map();

  for (const f of Array.isArray(audit?.required_fixes) ? audit.required_fixes : []) {
    const txt = String(f || '').trim();
    if (txt) requiredFixes.push(txt);
  }

  const normalizedAcceptance = acceptance.map(normalizeCriterion).filter(Boolean);
  if (normalizedAcceptance.length === 0) {
    unknownReasons.push('任务没有可核对的验收标准');
  }

  for (const criterion of normalizedAcceptance) {
    const matches = criteriaRaw.filter((c) => normalizeCriterion(c?.criterion) === criterion);
    if (matches.length === 0) {
      normalized.push({ criterion, status: 'unproven', evidence: '', reason: '审计未返回该验收标准' });
      unknownReasons.push(`验收标准缺少审计结果：${criterion}`);
      continue;
    }
    if (matches.length > 1) {
      normalized.push({ criterion, status: 'unproven', evidence: '', reason: '审计结果重复声明该标准' });
      unknownReasons.push(`验收标准被重复声明：${criterion}`);
      continue;
    }
    const item = matches[0];
    const rawStatus = String(item?.status || '').toLowerCase();
    const status = ['pass', 'fail', 'unproven'].includes(rawStatus) ? rawStatus : 'unproven';
    const evidence = String(item?.evidence || '').trim();
    if (status === 'pass' && requireEvidence && !evidenceIsConcrete(evidence)) {
      normalized.push({ criterion, status: 'unproven', evidence, reason: '缺少具体证据，不能判定 PASS' });
      unknownReasons.push(`验收标准缺少具体证据：${criterion}`);
      continue;
    }
    normalized.push({ criterion, status, evidence });
    if (status === 'fail') requiredFixes.push(`未满足验收标准：${criterion}${evidence ? `（证据：${evidence}）` : ''}`);
    if (status === 'unproven') {
      unknownReasons.push(`验收标准未证实：${criterion}${evidence ? `（${evidence}）` : ''}`);
      requiredFixes.push(`未证实验收标准：${criterion}${evidence ? `（证据：${evidence}）` : ''}`);
    }
  }

  for (const f of highFindings) {
    requiredFixes.push(`高风险问题：${f.issue || f.title || '未说明'}${f.file ? ` @ ${f.file}${f.line ? ':' + f.line : ''}` : ''}`);
  }

  const hasFail = normalized.some((c) => c.status === 'fail') || highFindings.length > 0;
  const hasUnknown = normalized.some((c) => c.status !== 'pass') || normalizedAcceptance.length === 0 || unknownReasons.length > 0;
  const status = hasFail ? 'FAIL' : hasUnknown ? 'UNKNOWN' : 'PASS';
  const verdict = status === 'PASS' ? 'pass' : 'fail';
  const score = Number.isFinite(Number(audit?.score)) ? Number(audit.score) : status === 'PASS' ? 100 : 0;
  return {
    status,
    verdict,
    score,
    criteria: normalized,
    findings,
    highFindings,
    requiredFixes: [...new Set(requiredFixes.filter(Boolean))],
    unknownReasons: [...new Set(unknownReasons)],
    summary: String(audit?.summary || ''),
  };
}

/** 合并多段 diff 的审计结果（diff 过大时分块审计，避免把截断当完整审查）。 */
export function mergeAuditChunks(chunks = []) {
  if (!chunks.length) return { status: 'UNKNOWN', verdict: 'fail', score: 0, criteria: [], findings: [], highFindings: [], requiredFixes: ['没有可审计的变更分段'], unknownReasons: ['没有可审计的变更分段'], summary: '' };
  const status = chunks.some((c) => c.status === 'FAIL') ? 'FAIL' : chunks.some((c) => c.status !== 'PASS') ? 'UNKNOWN' : 'PASS';
  const mergedCriteria = [];
  const seen = new Set();
  for (const chunk of chunks) {
    for (const c of chunk.criteria || []) {
      const key = normalizeCriterion(c.criterion);
      if (seen.has(key)) continue;
      seen.add(key);
      mergedCriteria.push(c);
    }
  }
  return {
    status,
    verdict: status === 'PASS' ? 'pass' : 'fail',
    score: Math.round(chunks.reduce((sum, c) => sum + Number(c.score || 0), 0) / chunks.length),
    criteria: mergedCriteria,
    findings: chunks.flatMap((c) => c.findings || []),
    highFindings: chunks.flatMap((c) => c.highFindings || []),
    requiredFixes: [...new Set(chunks.flatMap((c) => c.requiredFixes || []))],
    unknownReasons: [...new Set(chunks.flatMap((c) => c.unknownReasons || []))],
    summary: chunks.map((c) => c.summary).filter(Boolean).join(' '),
  };
}

/** 失败签名：同签名连续失败可用于停止无限重试。 */
export function failureSignature(parts = {}) {
  const text = [
    parts.testCode,
    String(parts.testTail || '').slice(-3000),
    String(parts.auditSummary || '').slice(0, 2000),
    (parts.failedCriteria || []).join('|'),
  ].join('\n');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 项目/运行预算硬校验。 */
export function assertProjectBudget({ config, project, run, totals, estimatedTokens = 0, estimatedCostCny = 0 }) {
  const projectBudget = project?.budget_json || {};
  const runBudget = run?.budget_json || {};
  const maxTokens = Math.min(
    Number(projectBudget.max_tokens_per_run || Infinity),
    Number(projectBudget.max_tokens_total || Infinity),
    Number(runBudget.maxTokens || config.budget.maxTokensPerRun || Infinity),
    config.budget.maxTotalTokens,
  );
  const usedTokens = Number(totals?.tokens || 0);
  if (usedTokens + estimatedTokens > maxTokens) {
    throw new PolicyError('PROJECT_BUDGET_EXCEEDED', `项目/运行 token 预算超限（${usedTokens} + ${estimatedTokens} > ${maxTokens}）`);
  }
  const maxCost = Math.min(
    Number(projectBudget.max_cost_cny_per_run || Infinity),
    Number(runBudget.maxCostCny || config.budget.maxCostCnyPerRun || Infinity),
    config.budget.maxCostCny,
  );
  const usedCost = Number(totals?.costCny || 0);
  if (usedCost + estimatedCostCny > maxCost) {
    throw new PolicyError('PROJECT_BUDGET_COST_EXCEEDED', `项目/运行成本预算超限（${usedCost} + ${estimatedCostCny} > ${maxCost}）`);
  }
  return { maxTokens, usedTokens, maxCost, usedCost };
}

export function assertRunWallClock(run, limitMs) {
  const deadline = run?.wall_deadline ? Date.parse(run.wall_deadline) : NaN;
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    throw new PolicyError('RUN_WALL_CLOCK_EXCEEDED', `运行超过最大时长限制（截止 ${run.wall_deadline}）`);
  }
}

export function verificationState({ ciRequired, ciStatus, ciConclusion, ciSha, verifiedSha }) {
  if (!ciRequired) return { status: 'LOCAL_VERIFIED', note: '项目未要求远端 CI，本地验证完成' };
  if (!ciStatus || ciStatus === 'pending' || ciStatus === 'in_progress' || ciStatus === 'queued') {
    return { status: 'CI_PENDING', note: 'GitHub CI 尚未完成，不能宣布远端验收' };
  }
  if (ciStatus === 'failed' || ciConclusion === 'failure') {
    return { status: 'CI_FAILED', note: 'GitHub CI 失败，不能验收' };
  }
  if (ciConclusion === 'success') {
    if (ciSha && verifiedSha && ciSha !== verifiedSha) {
      return { status: 'CI_FAILED', note: `CI 结论绑定的 commit（${ciSha.slice(0, 8)}）与验证 commit（${verifiedSha.slice(0, 8)}）不一致` };
    }
    return { status: 'CI_PASSED', note: 'GitHub CI 通过，绑定 commit ' + String(verifiedSha || ciSha || '').slice(0, 8) };
  }
  return { status: 'CI_PENDING', note: 'CI 状态不明确' };
}

export function summarizeUsage(usage = {}) {
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheWrite = Number(usage.cacheWrite || 0);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
