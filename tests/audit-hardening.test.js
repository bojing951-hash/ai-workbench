// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/policy.js 审计硬校验 / CI 闸门 / 预算 / 失败签名（纯函数，完全离线）。
 *
 * P0 背景（docs/v2/P0-AUDIT.md §2.3/2.4/2.6）：
 *  - 审计结论必须由代码硬校验，不信任模型自述的 verdict/score；
 *  - PASS 必须有具体证据；验收标准逐条按内容精确匹配，缺证据 / 缺失 / 重复一律 UNKNOWN（不通过）；
 *  - 乱序返回时按内容对齐，不能按下标张冠李戴（旧缺陷是 criteria[idx] 兜底导致错配 PASS）；
 *  - 分块审计保守合并：任一块 fail → fail，任一块 unknown → unknown；
 *  - CI 验收必须绑定 commit SHA；预算有项目/运行硬上限；同签名失败可识别。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  finalizeAuditVerdict,
  mergeAuditChunks,
  modelFamily,
  verificationState,
  assertProjectBudget,
  failureSignature,
  PolicyError,
} from '../src/policy.js';

const EVIDENCE = 'src/pay.js:42 新增金额校验，单测 tests/pay.test.js 通过';

/** 构造审计器返回的 JSON 骨架。 */
function auditOf(criteria, extra = {}) {
  return { score: 100, criteria, findings: [], required_fixes: [], summary: '审计结论', ...extra };
}

function criterion(text, status = 'pass', evidence = EVIDENCE) {
  return { criterion: text, status, evidence };
}

/** 断言抛指定 code 的 PolicyError. */
function throwsPolicy(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof PolicyError, `应为 PolicyError，实际为 ${err?.constructor?.name || typeof err}`);
    assert.equal(err.code, code);
    return true;
  });
}

describe('finalizeAuditVerdict：PASS 必须有具体证据', () => {
  it('全部验收标准 pass 且 evidence 具体 -> PASS / verdict=pass', () => {
    const audit = auditOf([criterion('接口返回 200'), criterion('默认端口 4477')]);
    const final = finalizeAuditVerdict(audit, ['接口返回 200', '默认端口 4477']);

    assert.equal(final.status, 'PASS');
    assert.equal(final.verdict, 'pass');
    assert.equal(final.highFindings.length, 0);
    assert.deepEqual(final.requiredFixes, []);
    assert.deepEqual(final.unknownReasons, []);
    assert.equal(final.criteria.length, 2);
    assert.ok(final.criteria.every((c) => c.status === 'pass' && c.evidence === EVIDENCE));
  });

  it('evidence 为空或泛化（无/unknown/N/A/未验证）-> UNKNOWN，不信任模型 pass 自述', () => {
    for (const evidence of ['', '   ', '无', 'unknown', 'N/A', '---', '未验证']) {
      const audit = auditOf([criterion('接口返回 200', 'pass', evidence)], { verdict: 'pass', score: 100 });
      const final = finalizeAuditVerdict(audit, ['接口返回 200']);
      assert.equal(final.status, 'UNKNOWN', `evidence=${JSON.stringify(evidence)} 不应判 PASS`);
      assert.equal(final.verdict, 'fail');
      assert.equal(final.criteria[0].status, 'unproven');
      assert.ok(final.unknownReasons.some((r) => r.includes('缺少具体证据')));
    }

    // 模型显式标 unproven 时，会生成可执行的 requiredFixes
    const unproven = finalizeAuditVerdict(auditOf([criterion('接口返回 200', 'unproven', '未执行相关测试')]), ['接口返回 200']);
    assert.equal(unproven.status, 'UNKNOWN');
    assert.ok(unproven.requiredFixes.some((f) => f.includes('未证实验收标准：接口返回 200')));
  });

  it('evidence 过短（<4 字符）-> UNKNOWN', () => {
    const audit = auditOf([criterion('接口返回 200', 'pass', 'ok')]);
    const final = finalizeAuditVerdict(audit, ['接口返回 200']);
    assert.equal(final.status, 'UNKNOWN');
    assert.equal(final.criteria[0].status, 'unproven');
  });

  it('大写 PASS 状态归一化后仍按证据校验', () => {
    const passAudit = auditOf([criterion('接口返回 200', 'PASS')]);
    assert.equal(finalizeAuditVerdict(passAudit, ['接口返回 200']).status, 'PASS');

    const passNoEvidence = auditOf([criterion('接口返回 200', 'PASS', '无')]);
    assert.equal(finalizeAuditVerdict(passNoEvidence, ['接口返回 200']).status, 'UNKNOWN');
  });

  it('非法 status（非 pass/fail/unproven）视为 unproven -> UNKNOWN', () => {
    const audit = auditOf([criterion('接口返回 200', 'done')]);
    const final = finalizeAuditVerdict(audit, ['接口返回 200']);
    assert.equal(final.status, 'UNKNOWN');
    assert.equal(final.criteria[0].status, 'unproven');
  });
});

describe('finalizeAuditVerdict：验收标准逐条精确匹配', () => {
  const acceptance = ['验收 A：返回 200', '验收 B：写入数据库'];

  it('缺少某条验收标准 -> 该条 unproven，整体 UNKNOWN 且 verdict=fail', () => {
    const audit = auditOf([criterion(acceptance[0])]);
    const final = finalizeAuditVerdict(audit, acceptance);
    assert.equal(final.status, 'UNKNOWN');
    assert.equal(final.verdict, 'fail');
    assert.equal(final.criteria.length, 2);
    assert.equal(final.criteria[1].criterion, acceptance[1]);
    assert.equal(final.criteria[1].status, 'unproven');
    assert.ok(final.unknownReasons.some((r) => r.includes('缺少审计结果')));
  });

  it('重复声明同一条验收标准 -> unproven，整体 UNKNOWN 且 verdict=fail', () => {
    const audit = auditOf([criterion('验收 A：返回 200'), criterion('  验收   A：返回   200 ')]);
    const final = finalizeAuditVerdict(audit, ['验收 A：返回 200']);
    assert.equal(final.status, 'UNKNOWN');
    assert.equal(final.verdict, 'fail');
    assert.equal(final.criteria[0].status, 'unproven');
    assert.ok(final.unknownReasons.some((r) => r.includes('重复声明')));
  });

  it('乱序返回时按内容对齐，不按下标错配：B=pass、A=fail -> criteria[0] 为 A 且 FAIL', () => {
    // 旧实现按 criteria[idx] 兜底会把 B 的 pass 错配给 A（张冠李戴 -> 伪造通过）；
    // 新实现只按 normalizeCriterion 后的文本精确匹配。
    const audit = auditOf([
      criterion('验收 B：写入数据库', 'pass'),
      criterion('验收 A：返回 200', 'fail', 'src/routes.js:10 未返回 200，实际返回 500'),
    ]);
    const final = finalizeAuditVerdict(audit, acceptance);
    assert.equal(final.criteria[0].criterion, acceptance[0]);
    assert.equal(final.criteria[0].status, 'fail');
    assert.equal(final.criteria[1].criterion, acceptance[1]);
    assert.equal(final.criteria[1].status, 'pass');
    assert.equal(final.status, 'FAIL');
    assert.equal(final.verdict, 'fail');
  });

  it('乱序但内容逐字匹配且全部有证据 -> PASS（匹配按内容而非下标）', () => {
    const audit = auditOf([criterion(acceptance[1]), criterion(acceptance[0])]);
    const final = finalizeAuditVerdict(audit, acceptance);
    assert.equal(final.status, 'PASS');
    assert.deepEqual(
      final.criteria.map((c) => [c.criterion, c.status]),
      [
        [acceptance[0], 'pass'],
        [acceptance[1], 'pass'],
      ],
    );
  });

  it('改写验收标准文本（非逐字一致）-> unproven / UNKNOWN', () => {
    const audit = auditOf([criterion('接口应该返回 200', 'pass')]);
    const final = finalizeAuditVerdict(audit, ['接口返回 200']);
    assert.equal(final.status, 'UNKNOWN');
    assert.equal(final.criteria[0].status, 'unproven');
    assert.ok(final.unknownReasons.some((r) => r.includes('缺少审计结果')));
  });

  it('没有可核对的验收标准 -> UNKNOWN 且 verdict=fail', () => {
    const final = finalizeAuditVerdict(auditOf([criterion('验收 A')]), []);
    assert.equal(final.status, 'UNKNOWN');
    assert.equal(final.verdict, 'fail');
    assert.deepEqual(final.criteria, []);
    assert.ok(final.unknownReasons.some((r) => r.includes('没有可核对的验收标准')));
  });
});

describe('finalizeAuditVerdict：显式 fail 与 high finding 硬失败', () => {
  it('存在 fail criteria -> FAIL，并生成具体 requiredFixes', () => {
    const audit = auditOf([criterion('验收 A：返回 200', 'fail', 'src/routes.js:10 实际返回 500')]);
    const final = finalizeAuditVerdict(audit, ['验收 A：返回 200']);
    assert.equal(final.status, 'FAIL');
    assert.equal(final.verdict, 'fail');
    assert.ok(final.requiredFixes.some((f) => f.includes('未满足验收标准：验收 A：返回 200')));
    assert.ok(final.requiredFixes.some((f) => f.includes('实际返回 500')));
    assert.ok(final.criteria.every((c) => c.status !== 'pass'));
  });

  it('high finding 即使全部验收标准 pass 也判 FAIL，并记录文件/行号', () => {
    const audit = auditOf([criterion('验收 A：返回 200')], {
      findings: [
        { severity: 'high', file: 'src/pay.js', line: 42, issue: '金额未做上限校验', required_fix: '补充上限校验' },
      ],
    });
    const final = finalizeAuditVerdict(audit, ['验收 A：返回 200']);
    assert.equal(final.status, 'FAIL');
    assert.equal(final.verdict, 'fail');
    assert.equal(final.highFindings.length, 1);
    assert.ok(final.requiredFixes.some((f) => f.includes('高风险问题：金额未做上限校验 @ src/pay.js:42')));
  });

  it('模型自述 verdict=pass / score=100 不能覆盖结构化的 fail 结论', () => {
    const audit = auditOf([criterion('验收 A：返回 200', 'fail', 'src/routes.js:10 未实现')], {
      verdict: 'pass',
      status: 'PASS',
      score: 100,
      summary: '全部通过',
    });
    const final = finalizeAuditVerdict(audit, ['验收 A：返回 200']);
    assert.equal(final.status, 'FAIL');
    assert.equal(final.verdict, 'fail');
  });

  it('模型自述 verdict=pass 但证据不足时仍为 UNKNOWN', () => {
    const audit = auditOf([criterion('验收 A：返回 200', 'pass', '无')], { verdict: 'pass', score: 100 });
    const final = finalizeAuditVerdict(audit, ['验收 A：返回 200']);
    assert.equal(final.status, 'UNKNOWN');
    assert.equal(final.verdict, 'fail');
  });
});

describe('mergeAuditChunks：分块审计保守合并', () => {
  it('任一分块 FAIL -> 整体 FAIL', () => {
    const merged = mergeAuditChunks([
      { status: 'PASS', score: 100, criteria: [], findings: [], requiredFixes: [], unknownReasons: [] },
      { status: 'FAIL', score: 20, criteria: [], findings: [{ severity: 'high', issue: '越界写入' }], requiredFixes: ['修复 A'], unknownReasons: [] },
    ]);
    assert.equal(merged.status, 'FAIL');
    assert.equal(merged.verdict, 'fail');
    assert.equal(merged.findings.length, 1);
    assert.ok(merged.requiredFixes.includes('修复 A'));
  });

  it('存在 UNKNOWN（或缺失状态）-> 整体 UNKNOWN', () => {
    assert.equal(mergeAuditChunks([{ status: 'PASS', score: 80 }, { status: 'UNKNOWN', score: 0 }]).status, 'UNKNOWN');
    assert.equal(mergeAuditChunks([{ status: 'PASS', score: 80 }, { score: 0 }]).status, 'UNKNOWN');
  });

  it('全部分块 PASS -> PASS，criteria 去重、findings 合并、分数取平均', () => {
    const merged = mergeAuditChunks([
      {
        status: 'PASS',
        score: 80,
        criteria: [{ criterion: '验收 A', status: 'pass', evidence: 'src/a.js:1' }],
        findings: [],
        requiredFixes: ['优化 X'],
        unknownReasons: [],
        summary: '第一块通过',
      },
      {
        status: 'PASS',
        score: 100,
        criteria: [{ criterion: '  验收   A ', status: 'pass', evidence: 'src/a.js:2' }],
        findings: [{ severity: 'low', issue: '命名' }],
        requiredFixes: ['优化 X', '优化 Y'],
        unknownReasons: [],
        summary: '第二块通过',
      },
    ]);
    assert.equal(merged.status, 'PASS');
    assert.equal(merged.verdict, 'pass');
    assert.equal(merged.score, 90);
    assert.equal(merged.criteria.length, 1);
    assert.equal(merged.findings.length, 1);
    assert.deepEqual(merged.requiredFixes, ['优化 X', '优化 Y']);
    assert.equal(merged.summary, '第一块通过 第二块通过');
  });

  it('空分块列表 -> UNKNOWN 且给出不可审计原因', () => {
    const merged = mergeAuditChunks([]);
    assert.equal(merged.status, 'UNKNOWN');
    assert.equal(merged.verdict, 'fail');
    assert.ok(merged.requiredFixes.length > 0);
    assert.ok(merged.unknownReasons.length > 0);
  });
});

describe('modelFamily：编码/审计模型族识别', () => {
  it('按 provider 识别 deepseek / glm / openai / anthropic', () => {
    assert.equal(modelFamily('deepseek', 'deepseek-chat'), 'deepseek');
    assert.equal(modelFamily('glm', 'glm-5.3'), 'glm');
    assert.equal(modelFamily('openai', 'gpt-4.1'), 'openai');
    assert.equal(modelFamily('azure-openai', 'gpt-4.1'), 'openai');
    assert.equal(modelFamily('anthropic', 'claude-3-5-sonnet'), 'anthropic');
  });

  it('provider 缺失时按 model 名兜底识别', () => {
    assert.equal(modelFamily('', 'deepseek-chat'), 'deepseek');
    assert.equal(modelFamily('', 'GLM-5.3'), 'glm');
    assert.equal(modelFamily('', 'gpt-4.1'), 'openai');
    assert.equal(modelFamily('', 'o3-mini'), 'openai');
    assert.equal(modelFamily('', 'claude-3-5-sonnet'), 'anthropic');
  });

  it('未知 provider/model -> unknown', () => {
    assert.equal(modelFamily('mistral', 'mixtral-8x7b'), 'unknown');
    assert.equal(modelFamily('', ''), 'unknown');
  });
});

describe('verificationState：CI 闸门与 SHA 绑定', () => {
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);

  it('项目未要求 CI -> LOCAL_VERIFIED', () => {
    assert.equal(verificationState({ ciRequired: false }).status, 'LOCAL_VERIFIED');
  });

  it('CI pending / in_progress / queued / 缺失 -> CI_PENDING', () => {
    for (const ciStatus of [undefined, '', 'pending', 'in_progress', 'queued']) {
      assert.equal(verificationState({ ciRequired: true, ciStatus }).status, 'CI_PENDING', `ciStatus=${ciStatus}`);
    }
  });

  it('CI failed 或 conclusion=failure -> CI_FAILED', () => {
    assert.equal(verificationState({ ciRequired: true, ciStatus: 'failed' }).status, 'CI_FAILED');
    assert.equal(verificationState({ ciRequired: true, ciStatus: 'completed', ciConclusion: 'failure' }).status, 'CI_FAILED');
  });

  it('CI success 但 SHA 不一致 -> CI_FAILED', () => {
    const state = verificationState({
      ciRequired: true,
      ciStatus: 'completed',
      ciConclusion: 'success',
      ciSha: shaA,
      verifiedSha: shaB,
    });
    assert.equal(state.status, 'CI_FAILED');
    assert.ok(state.note.includes('不一致'));
  });

  it('CI success 且 SHA 一致 -> CI_PASSED', () => {
    const state = verificationState({
      ciRequired: true,
      ciStatus: 'completed',
      ciConclusion: 'success',
      ciSha: shaA,
      verifiedSha: shaA,
    });
    assert.equal(state.status, 'CI_PASSED');
    assert.ok(state.note.includes(shaA.slice(0, 8)));
  });

  it('CI 状态不明确（completed + neutral）-> CI_PENDING', () => {
    assert.equal(verificationState({ ciRequired: true, ciStatus: 'completed', ciConclusion: 'neutral' }).status, 'CI_PENDING');
  });
});

describe('assertProjectBudget：项目 / 运行预算硬上限', () => {
  function budgetConfig(overrides = {}) {
    return {
      budget: {
        maxTotalTokens: 1_000_000,
        maxCostCny: 50,
        maxTokensPerRun: 100_000,
        maxCostCnyPerRun: 10,
        ...overrides,
      },
    };
  }

  it('未超限时通过，并返回生效的 token/成本上限', () => {
    const result = assertProjectBudget({
      config: budgetConfig(),
      project: { budget_json: {} },
      run: { budget_json: {} },
      totals: { tokens: 0, costCny: 0 },
    });
    assert.equal(result.maxTokens, 100_000);
    assert.equal(result.maxCost, 10);
    assert.equal(result.usedTokens, 0);
    assert.equal(result.usedCost, 0);
  });

  it('恰好等于上限时允许（边界不误杀）', () => {
    const result = assertProjectBudget({
      config: budgetConfig(),
      project: { budget_json: {} },
      run: { budget_json: {} },
      totals: { tokens: 99_998, costCny: 9.8 },
      estimatedTokens: 2,
      estimatedCostCny: 0.2,
    });
    assert.equal(result.maxTokens, 100_000);
  });

  it('预计消耗导致 token 超限 -> PROJECT_BUDGET_EXCEEDED', () => {
    throwsPolicy(
      () =>
        assertProjectBudget({
          config: budgetConfig(),
          project: { budget_json: {} },
          run: { budget_json: {} },
          totals: { tokens: 99_999, costCny: 0 },
          estimatedTokens: 2,
        }),
      'PROJECT_BUDGET_EXCEEDED',
    );
  });

  it('项目预算更严格时以较小值为准，超限 -> PROJECT_BUDGET_EXCEEDED', () => {
    throwsPolicy(
      () =>
        assertProjectBudget({
          config: budgetConfig(),
          project: { budget_json: { max_tokens_per_run: 100 } },
          run: { budget_json: {} },
          totals: { tokens: 100, costCny: 0 },
          estimatedTokens: 1,
        }),
      'PROJECT_BUDGET_EXCEEDED',
    );
    throwsPolicy(
      () =>
        assertProjectBudget({
          config: budgetConfig(),
          project: { budget_json: {} },
          run: { budget_json: { maxTokens: 500 } },
          totals: { tokens: 400, costCny: 0 },
          estimatedTokens: 200,
        }),
      'PROJECT_BUDGET_EXCEEDED',
    );
  });

  it('成本超限 -> PROJECT_BUDGET_COST_EXCEEDED', () => {
    throwsPolicy(
      () =>
        assertProjectBudget({
          config: budgetConfig(),
          project: { budget_json: {} },
          run: { budget_json: {} },
          totals: { tokens: 0, costCny: 9.9 },
          estimatedCostCny: 0.2,
        }),
      'PROJECT_BUDGET_COST_EXCEEDED',
    );
    throwsPolicy(
      () =>
        assertProjectBudget({
          config: budgetConfig(),
          project: { budget_json: { max_cost_cny_per_run: 1 } },
          run: { budget_json: {} },
          totals: { tokens: 0, costCny: 0.9 },
          estimatedCostCny: 0.2,
        }),
      'PROJECT_BUDGET_COST_EXCEEDED',
    );
  });
});

describe('failureSignature：失败签名稳定且可区分', () => {
  const baseParts = {
    testCode: 1,
    testTail: 'Error: expected 200, got 500',
    auditSummary: '验收 A 未通过：实际返回 500',
    failedCriteria: ['验收 A'],
  };

  it('相同失败输入得到相同的 16 位十六进制签名', () => {
    const a = failureSignature(baseParts);
    const b = failureSignature({ ...baseParts });
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b);
  });

  it('退出码 / 测试输出 / 审计摘要 / 失败标准任一变化都会改变签名', () => {
    const base = failureSignature(baseParts);
    assert.notEqual(failureSignature({ ...baseParts, testCode: 2 }), base);
    assert.notEqual(failureSignature({ ...baseParts, testTail: 'TypeError: x is undefined' }), base);
    assert.notEqual(failureSignature({ ...baseParts, auditSummary: '验收 B 未通过' }), base);
    assert.notEqual(failureSignature({ ...baseParts, failedCriteria: ['验收 B'] }), base);
  });

  it('空输入也有稳定的 16 位签名', () => {
    const empty = failureSignature();
    assert.match(empty, /^[0-9a-f]{16}$/);
    assert.equal(empty, failureSignature({}));
  });
});
