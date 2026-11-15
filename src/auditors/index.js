// SPDX-License-Identifier: Apache-2.0
/**
 * 独立审计器：只读审查代码变更 + 测试证据 + 验收标准，输出结构化结论。
 * 首选 GPT（OPENAI_API_KEY），未配置时按配置降级到 GLM，并在审计记录中如实标注 provider。
 * 结论由代码硬校验（finalizeAuditVerdict），模型不能自封通过。
 */
import { completeJson, availableProviders, providerSpec } from '../llm.js';
import { PolicyError, finalizeAuditVerdict, summarizeUsage } from '../policy.js';
import { truncate } from '../util.js';

const AUDIT_SYSTEM = `你是一名独立的代码审计员与验收官。你没有参与编写代码，任务是对照验收标准审查提交的代码变更与测试证据，判断是否可以交付。

硬性规则：
1. 只输出一个 JSON 对象，禁止 Markdown 围栏与额外解释。
2. 逐条核对验收标准：status 只能取 pass / fail / unproven。若某条验收标准带 [hidden] 前缀，说明它刻意对 Coding Agent 隐藏（防止过拟合），你必须同样严格核对，并在 criteria.criterion 中原样保留该前缀与文本。
   - pass：必须在代码或测试证据中找到直接证据，evidence 写出文件/行为；
   - fail：代码/证据明确违反标准；
   - unproven：证据不足以确认（例如仅声称、无测试覆盖）。unproven 不会被视为通过。
3. 不得臆测未展示的代码；不得因为"看起来差不多"而给 pass。测试通过不等于所有验收标准通过，仍需逐条核对。
4. 发现真实缺陷/安全/性能/兼容性问题时放入 findings，severity 取 high / medium / low。high 会导致整个审计失败。
5. required_fixes 用具体、可执行的指令描述需要 Coding Agent 修复什么（文件、行为、补充文档或测试覆盖），不要空泛。
6. 不要修改代码，不要提供补丁文件，只做审查。

输出 JSON：
{
  "score": 0-100,
  "criteria": [{"criterion": "验收标准原文", "status": "pass|fail|unproven", "evidence": "证据"}],
  "findings": [{"severity": "high|medium|low", "file": "", "line": 0, "issue": "", "required_fix": ""}],
  "required_fixes": ["具体修复指令"],
  "summary": "一句话结论"
}`;

export function resolveAuditProvider(config) {
  const preferred = config.audit.provider || 'auto';
  const specs = availableProviders(config);
  const byName = (name) => specs.find((p) => p.name === name) || null;
  if (preferred === 'openai') return byName('openai');
  if (preferred === 'glm') return byName('glm');
  if (preferred === 'deepseek') return byName('deepseek');
  // auto：GPT 优先，其次 GLM，最后 DeepSeek（降级会标注）
  return byName('openai') || byName('glm') || byName('deepseek') || null;
}

export function auditProviderStatus(config) {
  const preferred = config.audit.provider || 'auto';
  const specs = availableProviders(config);
  const gpt = specs.find((p) => p.name === 'openai') || null;
  const glm = specs.find((p) => p.name === 'glm') || null;
  const deepseek = specs.find((p) => p.name === 'deepseek') || null;
  const active = resolveAuditProvider(config);
  return {
    preferred,
    active: active ? { name: active.name, label: active.label, model: active.model } : null,
    gptConfigured: !!gpt,
    glmConfigured: !!glm,
    deepseekConfigured: !!deepseek,
    note: gpt
      ? '使用 GPT 独立审计'
      : glm
        ? 'GPT Key 未配置，当前使用 GLM-5.3 做独立模型审计（真实执行，非 GPT）'
        : deepseek
          ? 'GPT/GLM Key 未配置，降级为 DeepSeek 审计（建议配置 OPENAI_API_KEY 或 GLM_API_KEY）'
          : '没有可用的审计模型 Key，审计将阻塞',
  };
}

/**
 * 执行一次独立审计。
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.project
 * @param {object} args.task
 * @param {string} args.diff 代码变更 diff
 * @param {string} args.diffStat
 * @param {object} args.testResult {command, code, stdout, stderr, durationMs}
 * @param {string} args.repoFiles 仓库文件列表
 * @returns audit record (含 verdict / criteria / findings / requiredFixes / usage / provider)
 */
export async function runAudit({ config, project, task, diff, diffStat, testResult, repoFiles = [], signal = null }) {
  const providerInfo = resolveAuditProvider(config);
  if (!providerInfo) {
    throw new PolicyError('AUDIT_UNAVAILABLE', '没有可用的独立审计模型：请配置 OPENAI_API_KEY（GPT）或 GLM_API_KEY');
  }
  const acceptance = Array.isArray(task.acceptance_json) ? task.acceptance_json : [];
  if (acceptance.length === 0) {
    throw new PolicyError('AUDIT_NO_CRITERIA', '任务没有验收标准，无法进行独立审计');
  }

  const testEvidence = testResult
    ? [
        `命令：${testResult.command}`,
        `退出码：${testResult.code}`,
        testResult.durationMs ? `耗时：${Math.round(testResult.durationMs / 1000)}s` : '',
        `输出（截断）：\n${truncate(testResult.stdout || '', 6000)}`,
        testResult.stderr ? `stderr（截断）：\n${truncate(testResult.stderr, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '（无测试证据）';

  const userPrompt = [
    `## 项目\n${project.name}（${project.local_path}）`,
    `## 任务\n${task.title}\n${task.description}`,
    `## 验收标准（必须逐条核对）\n${acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
    `## 代码变更统计\n${diffStat || '（无统计）'}`,
    `## 代码变更 diff\n${truncate(diff || '（无变更）', config.audit.maxDiffChars)}`,
    `## 测试证据\n${testEvidence}`,
    `## 仓库文件（只读参考）\n${repoFiles.slice(0, 120).join('\n') || '（不可用）'}`,
    '请独立审查并输出 JSON 结论。',
  ].join('\n\n');

  const providerName = providerInfo.name;
  const result = await completeJson({
    config,
    provider: providerName,
    model: providerInfo.model,
    system: AUDIT_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 3500,
    temperature: 0,
    timeoutMs: config.audit.timeoutMs,
    signal,
  });

  const parsed = result.json || {};
  const final = finalizeAuditVerdict(parsed, acceptance);
  return {
    provider: result.provider,
    providerLabel: result.providerLabel,
    model: result.model,
    verdict: final.verdict,
    score: final.score,
    criteria: final.criteria,
    findings: final.findings,
    requiredFixes: final.requiredFixes,
    summary: final.summary,
    rawText: result.text,
    usage: result.usage,
    tokens: summarizeUsage(result.usage),
    costCny: result.costCny,
    prompt: userPrompt,
  };
}

export function auditSummaryText(audit) {
  if (!audit) return '';
  const failed = (audit.criteria || []).filter((c) => c.status !== 'pass');
  const high = (audit.findings || []).filter((f) => String(f.severity || '').toLowerCase() === 'high');
  const lines = [
    `审计结论：${audit.verdict === 'pass' ? '通过' : '未通过'}（${audit.provider}/${audit.model}，得分 ${audit.score}）`,
    `验收标准：${(audit.criteria || []).filter((c) => c.status === 'pass').length}/${(audit.criteria || []).length} 通过`,
  ];
  if (failed.length) lines.push(`未通过标准：${failed.map((c) => c.criterion).join('；')}`);
  if (high.length) lines.push(`高风险问题：${high.map((f) => f.issue).join('；')}`);
  if (audit.requiredFixes?.length) lines.push(`需修复：${audit.requiredFixes.slice(0, 6).join('；')}`);
  return lines.join('\n');
}
