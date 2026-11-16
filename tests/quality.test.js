// SPDX-License-Identifier: Apache-2.0
/** v2.7：需求覆盖矩阵、证据门槛、自动修复任务、质量闭环停止条件。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { buildCoverageMatrix, deriveClausePlan, repairTasksFromQuality, qualityConfig } from '../src/quality.js';

function project(extra = {}) {
  return {
    id: 'p1', name: 'quality fixture', local_path: os.tmpdir(),
    config_json: {
      quality: {
        require_clause_evidence: false,
        max_cycles: 2,
        requirements: [
          { id: 'R1', title: '核心功能可验证', priority: 'P0', acceptance: ['隐藏测试通过'], tests: ['hidden:R1'] },
          { id: 'R2', title: '边界条件', priority: 'P1', acceptance: ['空输入不崩溃'], tests: ['hidden:R2'] },
          { id: 'R3', title: '非关键增强', priority: 'P2', acceptance: ['可选'] },
        ],
      },
      ...extra,
    },
  };
}

test('v2.7 质量矩阵：任务通过但没有质量证据不能 PASS', () => {
  const m = buildCoverageMatrix({ project: project(), qualityRun: { requirements: [], issues: [], reason: '未运行' }, audits: [] });
  assert.equal(m.requirements.find((r) => r.id === 'R1').status, 'UNKNOWN');
  assert.equal(m.requirements.find((r) => r.id === 'R3').status, 'UNKNOWN');
  assert.equal(m.allPass, false);
  assert.ok(m.issues.some((i) => i.priority === 'P0'));
});

test('v2.7 质量矩阵：有证据的 FAIL/P0 生成修复任务；无证据只记假设', () => {
  const q = {
    requirements: [
      { id: 'R1', status: 'fail', evidence: 'hidden:R1 断言失败：expected 2 got 1', issues: [{ id: 'I1', title: 'R1 边界计算错误', priority: 'P0', evidence: 'hidden:R1 断言失败' }] },
      { id: 'R2', status: 'unproven', evidence: '', issues: [{ id: 'I2', title: '疑似边界问题', priority: 'P1', evidence: '' }] },
      { id: 'R3', status: 'pass', evidence: 'hidden:R3 pass' },
    ], issues: [],
  };
  const m = buildCoverageMatrix({ project: project(), qualityRun: q, audits: [] });
  assert.equal(m.requirements[0].status, 'FAIL');
  assert.equal(m.requirements[1].status, 'UNKNOWN');
  assert.equal(m.allPass, false);
  const tasks = repairTasksFromQuality(m);
  assert.equal(tasks.length, 1, '只有有证据 P0/P1 能生成修复任务');
  assert.match(tasks[0].description, /hidden:R1/);
  assert.equal(tasks[0].qualityPriority, 'P0');
  assert.ok(tasks[0].acceptance.some((a) => /质量命令/.test(a)));
  assert.equal(m.issues.find((i) => i.id === 'I2').hypothesis, true, '无证据问题必须是假设');
});

test('v2.7 质量矩阵：全部需求有证据 PASS 才 allPass；P2 不阻塞', () => {
  const q = {
    requirements: [
      { id: 'R1', status: 'pass', evidence: 'hidden:R1 通过' },
      { id: 'R2', status: 'pass', evidence: 'hidden:R2 通过' },
      { id: 'R3', status: 'fail', evidence: 'P2 可选未做', issues: [{ id: 'I3', title: '可选改进', priority: 'P2', evidence: 'hidden:R3' }] },
    ], issues: [],
  };
  const m = buildCoverageMatrix({ project: project(), qualityRun: q, audits: [] });
  assert.equal(m.requirements[0].status, 'PASS');
  assert.equal(m.allPass, true, 'P2 不应阻塞必须需求全部 PASS');
  assert.equal(m.p0p1.length, 0);
});

test('v2.7 质量配置：未配置 quality_command/需求时关闭质量闭环，不伪造矩阵', () => {
  const p = project({ quality: undefined });
  assert.equal(qualityConfig(p), null);
  const m = buildCoverageMatrix({ project: p, qualityRun: { requirements: [] }, audits: [] });
  assert.equal(m.requirements.length, 0);
  assert.equal(m.allPass, false);
});

test('v2.7 质量矩阵：占位证据不得 PASS；质量命令失败不是产品缺陷', () => {
  const placeholder = buildCoverageMatrix({ project: project(), qualityRun: { requirements: [{ id: 'R1', status: 'pass', evidence: 'N/A' }, { id: 'R2', status: 'pass', evidence: 'x' }], issues: [] }, audits: [] });
  assert.equal(placeholder.requirements.find((r) => r.id === 'R1').status, 'UNKNOWN');
  assert.equal(placeholder.allPass, false);
  const commandFail = buildCoverageMatrix({ project: project(), qualityRun: { ok: false, commandFailed: true, reason: 'quality command exit=7 timeout', requirements: [], issues: [{ id: 'cmd', title: 'quality command failed', priority: 'P1', evidence: 'exit=7', hypothesis: true }] }, audits: [] });
  assert.equal(commandFail.allPass, false);
  assert.equal(commandFail.p0p1.length, 0);
  assert.equal(repairTasksFromQuality(commandFail).length, 0, '基础设施失败不得生成产品修复任务');
  assert.match(commandFail.qualityCommandError, /exit=7/);
});

test('v2.8 P1-1：同一需求多个验收子条款必须分别有证据，缺失条款不得 PASS', () => {
  const project = {
    id: 'p',
    name: 'clause',
    config_json: {
      quality: {
        require_clause_evidence: true,
        quality_command: 'true',
        requirements: [
          { id: 'R1', title: '多条款', priority: 'P0', acceptance: ['条款A', '条款B'], tests: [] },
          { id: 'R2', title: '三条款', priority: 'P0', acceptance: ['C1', 'C2', 'C3'], tests: [] },
        ],
      },
    },
  };
  const partial = buildCoverageMatrix({
    project,
    qualityRun: { ok: true, requirements: [
      { id: 'R1', status: 'pass', evidence: '独立的聚合验证证据已记录', criteria: [{ criterion: '条款A', status: 'pass', evidence: '实际测试 A 通过并记录输出' }] },
      { id: 'R2', status: 'pass', evidence: '独立的聚合验证证据已记录', criteria: [
        { criterion: 'C1', status: 'pass', evidence: 'C1 实际测试通过并记录输出' },
        { criterion: 'C2', status: 'pass', evidence: 'C2 实际测试通过并记录输出' },
        { criterion: 'C3', status: 'pass', evidence: 'C3 实际测试通过并记录输出' },
      ] },
    ] },
    audits: [],
  });
  const r1 = partial.requirements.find((r) => r.id === 'R1');
  assert.equal(r1.status, 'UNKNOWN');
  assert.equal(r1.clauses.find((c) => c.id === 'R1.2').status, 'UNKNOWN');
  assert.equal(partial.requirements.find((r) => r.id === 'R2').status, 'PASS');
  assert.equal(partial.allPass, false);
  assert.equal(partial.coverage.clauses.total, 5);
  assert.equal(partial.coverage.clauses.pass, 4);

  const complete = buildCoverageMatrix({
    project,
    qualityRun: { ok: true, requirements: [
      { id: 'R1', status: 'pass', evidence: '独立的聚合验证证据已记录', criteria: [
        { criterion: '条款A', status: 'pass', evidence: '实际测试 A 通过并记录输出' },
        { criterion: '条款B', status: 'pass', evidence: '实际测试 B 通过并记录输出' },
      ] },
      { id: 'R2', status: 'pass', evidence: '独立的聚合验证证据已记录', criteria: [
        { criterion: 'C1', status: 'pass', evidence: 'C1 实际测试通过并记录输出' },
        { criterion: 'C2', status: 'pass', evidence: 'C2 实际测试通过并记录输出' },
        { criterion: 'C3', status: 'pass', evidence: 'C3 实际测试通过并记录输出' },
      ] },
    ] },
    audits: [],
  });
  assert.equal(complete.allPass, true);
  assert.equal(complete.coverage.clauses.pass, 5);
});


test('v2.8 P1-1：冻结契约 Markdown 自动生成条款级质量计划', () => {
  const contract = [
    '# 产品验收契约',
    '## R1 核心计算',
    '- 月自由现金流必须可核对',
    '- 负现金流不得判为可购买',
    '## R2 本地持久化',
    '- 刷新后数据保留',
    '- 清除后不得写回',
  ].join('\n');
  const plan = deriveClausePlan(contract);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].id, 'R1');
  assert.equal(plan[0].acceptance.length, 2);
  assert.match(plan[0].acceptance[1], /负现金流/);
  assert.equal(plan[1].acceptance.length, 2);
});

test('v2.8 P1-1：错位 criteria 不能位置回退冒充缺失条款', () => {
  const project = {
    id: 'p', name: 'misaligned', config_json: { quality: { require_clause_evidence: true, quality_command: 'true', requirements: [{ id: 'R1', title: 'R', priority: 'P0', acceptance: ['条款A', '条款B'] }] } },
  };
  const m = buildCoverageMatrix({ project, qualityRun: { ok: true, requirements: [{ id: 'R1', status: 'pass', evidence: '聚合证据足够长', criteria: [
    { criterion: '条款A', status: 'pass', evidence: '条款A 真实测试通过并记录' },
    { criterion: '条款A', status: 'pass', evidence: '重复的条款A 证据' },
  ] }] }, audits: [] });
  assert.equal(m.requirements[0].clauses.find((c) => c.id === 'R1.2').status, 'UNKNOWN');
  assert.notEqual(m.requirements[0].status, 'PASS');
  assert.equal(m.allPass, false);
});

test('v2.9 可靠性：同一 Requirement ID 的冲突结果不得互相覆盖', () => {
  const project = {
    id: 'p', name: 'conflict', config_json: { quality: { quality_command: 'true', require_clause_evidence: false, requirements: [{ id: 'R1', title: '冲突需求', priority: 'P0', acceptance: ['a'] }] } },
  };
  const m = buildCoverageMatrix({ project, qualityRun: { ok: true, requirements: [
    { id: 'R1', status: 'pass', evidence: '第一个结果证据足够长' },
    { id: 'R1', status: 'fail', evidence: '第二个结果证据足够长' },
  ] }, audits: [] });
  assert.equal(m.requirements[0].status, 'UNKNOWN');
  assert.equal(m.allPass, false);
  assert.ok(m.p0p1.some((i) => i.id === 'requirement-conflict-R1' && i.evidence));
});
