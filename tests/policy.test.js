// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/policy.js 策略与预算硬校验（完全离线、纯函数）。
 * 重点：审计结论"硬校验"（模型不能自封通过）、预算上限、受保护路径违规检测。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PolicyError,
  finalizeAuditVerdict,
  assertBudgetAllowed,
  remainingBudget,
  protectedViolations,
  protectPathsForProject,
  summarizeUsage,
} from '../src/policy.js';

/** 构造仅包含 policy 所需字段的最小 config（纯对象，不触碰文件系统）. */
function budgetConfig(overrides = {}) {
  return {
    budget: {
      maxTotalTokens: 100_000,
      maxCostCny: 10,
      minReserveTokens: 20_000,
      ...overrides,
    },
  };
}

function auditOf(criteria, extra = {}) {
  return { score: 100, criteria, findings: [], required_fixes: [], summary: 'ok', ...extra };
}

describe('finalizeAuditVerdict：全部验收标准 pass 才 pass', () => {
  it('全部 criteria pass 且无 high finding -> pass', () => {
    const audit = auditOf([
      { criterion: '接口 /health 返回 ok', status: 'pass', evidence: 'src/server.js:20' },
      { criterion: '默认端口 4477', status: 'pass' },
    ]);
    const final = finalizeAuditVerdict(audit, ['接口 /health 返回 ok', '默认端口 4477']);
    assert.equal(final.verdict, 'pass');
    assert.equal(final.highFindings.length, 0);
    assert.deepEqual(final.requiredFixes, []);
    assert.equal(final.score, 100);
    assert.equal(final.criteria.length, 2);
    assert.ok(final.criteria.every((c) => c.status === 'pass'));
  });

  it('unproven 视为不通过，并汇总为 requiredFixes', () => {
    const audit = auditOf([
      { criterion: '验收 A', status: 'pass' },
      { criterion: '验收 B', status: 'unproven', evidence: '无测试覆盖' },
    ]);
    const final = finalizeAuditVerdict(audit, ['验收 A', '验收 B']);
    assert.equal(final.verdict, 'fail');
    assert.equal(final.criteria[1].status, 'unproven');
    assert.ok(final.requiredFixes.some((f) => f.includes('未满足验收标准：验收 B')));
    assert.ok(final.requiredFixes.join('\n').includes('无测试覆盖'));
  });

  it('模型自述 verdict=pass 但存在 fail criteria 时仍判 fail（硬校验，不信任自述）', () => {
    const audit = auditOf([{ criterion: '验收 A', status: 'fail', evidence: '行为缺失' }], {
      verdict: 'pass',
      score: 100,
    });
    const final = finalizeAuditVerdict(audit, ['验收 A']);
    assert.equal(final.verdict, 'fail');
    assert.ok(final.requiredFixes.some((f) => f.includes('未满足验收标准：验收 A')));
  });

  it('high finding 即使全部验收标准 pass 也判 fail，并带文件/行号', () => {
    const audit = auditOf(
      [{ criterion: '验收 A', status: 'pass' }],
      {
        findings: [
          { severity: 'high', file: 'src/auth.js', line: 12, issue: 'Authorization 头未校验' },
          { severity: 'low', file: 'src/x.js', issue: '命名不规范' },
        ],
      },
    );
    const final = finalizeAuditVerdict(audit, ['验收 A']);
    assert.equal(final.verdict, 'fail');
    assert.equal(final.highFindings.length, 1);
    const fixes = final.requiredFixes.join('\n');
    assert.ok(fixes.includes('高风险问题：Authorization 头未校验 @ src/auth.js:12'));
    assert.ok(!fixes.includes('命名不规范'));
  });

  it('required_fixes 汇总并去重：模型修复项 + 失败验收项 + high 问题', () => {
    const audit = auditOf([{ criterion: '验收 A', status: 'fail', evidence: '证据1' }], {
      required_fixes: ['修复登录校验', '补充测试', '修复登录校验'],
      findings: [{ severity: 'high', issue: '空指针' }],
    });
    const final = finalizeAuditVerdict(audit, ['验收 A']);
    assert.equal(final.verdict, 'fail');
    assert.deepEqual(final.requiredFixes, [
      '修复登录校验',
      '补充测试',
      '未满足验收标准：验收 A（证据：证据1）',
      '高风险问题：空指针',
    ]);
    assert.equal(new Set(final.requiredFixes).size, final.requiredFixes.length);
  });

  it('无验收标准且模型未给出 criteria -> fail（不能空标准直接通过）', () => {
    const final = finalizeAuditVerdict(auditOf([]), []);
    assert.equal(final.verdict, 'fail');
    assert.equal(final.criteria.length, 0);
  });

  it('缺少对应 criterion 的验收标准按 unproven 处理', () => {
    const audit = auditOf([{ criterion: '验收 A', status: 'pass' }]);
    const final = finalizeAuditVerdict(audit, ['验收 A', '验收 B']);
    assert.equal(final.verdict, 'fail');
    assert.equal(final.criteria[1].status, 'unproven');
  });

  it('criteria 按原文 trim 匹配；非法 status 归一为 unproven；大写 PASS 归一为 pass', () => {
    const audit = auditOf([
      { criterion: '  验收 A  ', status: 'PASS' },
      { criterion: '验收 B', status: 'maybe' },
    ]);
    // 注意：原实现用严格 trim 相等匹配 + 下标兜底，这里同时覆盖两种路径
    const final = finalizeAuditVerdict(audit, ['验收 A', '验收 B']);
    assert.equal(final.criteria[0].status, 'pass');
    assert.equal(final.criteria[1].status, 'unproven');
    assert.equal(final.verdict, 'fail');
  });

  it('非数值 score 时按 verdict 回退（pass=100 / fail=0），数值 score 保留', () => {
    assert.equal(finalizeAuditVerdict(auditOf([{ criterion: 'A', status: 'pass' }], { score: 'n/a' }), ['A']).score, 100);
    assert.equal(finalizeAuditVerdict(auditOf([{ criterion: 'A', status: 'fail' }], { score: undefined }), ['A']).score, 0);
    assert.equal(finalizeAuditVerdict(auditOf([{ criterion: 'A', status: 'pass' }], { score: 87 }), ['A']).score, 87);
  });

  it('审计返回结构缺失（null / 空对象）时不抛异常且判 fail', () => {
    assert.equal(finalizeAuditVerdict(null, ['A']).verdict, 'fail');
    assert.equal(finalizeAuditVerdict({}, ['A']).verdict, 'fail');
    assert.equal(finalizeAuditVerdict(auditOf([], {}), ['A']).verdict, 'fail');
  });
});

describe('assertBudgetAllowed：预算上限硬校验', () => {
  it('预算充足时返回剩余额度', () => {
    const remaining = assertBudgetAllowed(budgetConfig(), { tokens: 10_000, costCny: 1 }, { estimatedTokens: 5_000 });
    assert.deepEqual(remaining, { tokens: 90_000, costCny: 9 });
  });

  it('剩余 token 不足以保留 minReserveTokens 时抛 BUDGET_TOKENS_EXHAUSTED', () => {
    const config = budgetConfig();
    let thrown = null;
    try {
      assertBudgetAllowed(config, { tokens: 85_000, costCny: 0 });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof PolicyError);
    assert.equal(thrown.code, 'BUDGET_TOKENS_EXHAUSTED');
    assert.equal(thrown.details.tokens, 15_000);
    assert.match(thrown.message, /token 预算不足/);
  });

  it('预计消耗超过剩余 token 时抛 BUDGET_TOKENS_EXCEEDED', () => {
    assert.throws(
      () => assertBudgetAllowed(budgetConfig(), { tokens: 0, costCny: 0 }, { estimatedTokens: 120_000 }),
      (err) => err instanceof PolicyError && err.code === 'BUDGET_TOKENS_EXCEEDED' && /超过剩余预算/.test(err.message),
    );
  });

  it('预计成本超过剩余成本时抛 BUDGET_COST_EXCEEDED', () => {
    assert.throws(
      () => assertBudgetAllowed(budgetConfig(), { tokens: 0, costCny: 9.5 }, { estimatedCostCny: 0.6 }),
      (err) => err instanceof PolicyError && err.code === 'BUDGET_COST_EXCEEDED' && /超过剩余预算/.test(err.message),
    );
  });

  it('remainingBudget 计算与参数缺省容错', () => {
    assert.deepEqual(remainingBudget(budgetConfig(), {}), { tokens: 100_000, costCny: 10 });
    assert.deepEqual(remainingBudget(budgetConfig(), { tokens: '250', costCny: '2.5' }), { tokens: 99_750, costCny: 7.5 });
    assert.doesNotThrow(() => assertBudgetAllowed(budgetConfig()));
  });
});

describe('protectedViolations：受保护路径违规检测', () => {
  const patterns = ['tests/**', 'test/**', '**/*.test.js', '.github/**', 'acceptance/**'];

  it('命中 tests/** 与 **/*.test.js 的文件被判为违规', () => {
    const files = ['tests/a.test.js', 'tests/unit/deep.js', 'src/x.test.js', '.github/workflows/ai-verify.yml', 'acceptance/case.md'];
    assert.deepEqual(protectedViolations(files, patterns), files);
  });

  it('只修改实现文件不算违规', () => {
    assert.deepEqual(protectedViolations(['src/index.js', 'README.md', 'package.json'], patterns), []);
  });

  it('同时支持 {file} 对象与字符串，忽略空项', () => {
    const changed = [
      { status: 'M', file: 'tests/a.test.js' },
      { status: 'A', file: 'src/impl.js' },
      { status: 'D', file: 'acceptance/x.md' },
      { status: 'A' },
    ];
    assert.deepEqual(protectedViolations(changed, patterns), ['tests/a.test.js', 'acceptance/x.md']);
  });

  it('无保护路径时永不违规', () => {
    assert.deepEqual(protectedViolations(['tests/a.test.js'], []), []);
  });
});

describe('protectPathsForProject：配置路径与项目路径合并去重', () => {
  it('合并 config.policy.protectedPaths 与 project.protected_paths 并去重', () => {
    const config = { policy: { protectedPaths: ['.github/**', 'acceptance/**'] } };
    const project = { protected_paths: ['acceptance/**', 'tests/**'] };
    assert.deepEqual(protectPathsForProject(project, config), ['.github/**', 'acceptance/**', 'tests/**']);
  });

  it('项目缺失或字段缺失时回退到配置路径', () => {
    const config = { policy: { protectedPaths: ['tests/**'] } };
    assert.deepEqual(protectPathsForProject(null, config), ['tests/**']);
    assert.deepEqual(protectPathsForProject({}, config), ['tests/**']);
  });
});

describe('summarizeUsage：token 用量归一化', () => {
  it('四项相加得到 total，缺省为 0，字符串数字可转换', () => {
    assert.deepEqual(summarizeUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }), {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      total: 165,
    });
    assert.deepEqual(summarizeUsage({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.equal(summarizeUsage({ input: '3', output: '4' }).total, 7);
  });
});
