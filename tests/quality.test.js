// SPDX-License-Identifier: Apache-2.0
/** v2.7：需求覆盖矩阵、证据门槛、自动修复任务、质量闭环停止条件。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { buildCoverageMatrix, repairTasksFromQuality, qualityConfig } from '../src/quality.js';

function project(extra = {}) {
  return {
    id: 'p1', name: 'quality fixture', local_path: os.tmpdir(),
    config_json: {
      quality: {
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
