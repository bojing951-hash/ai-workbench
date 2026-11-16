// SPDX-License-Identifier: Apache-2.0
/** v2.7 P1-E：验收证据文件一致性校验，防止旧状态残留/字段矛盾。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }

test('v2.7 P1-E：Reading Queue 证据状态、成本、任务、矩阵、commit、24h 相互一致', () => {
  const ev = readJson('demo/evidence/v2.7-evidence.json');
  const e2e = readJson('demo/evidence/reading-queue-e2e.json');
  const matrix = readJson('demo/evidence/reading-queue-coverage-matrix.json');
  const clauses = readJson('demo/evidence/reading-queue-clause-coverage.json');
  const hasProductRepo = fs.existsSync(path.join(root, 'projects/v2.7/reading-queue'));
  // 产品/E2E 状态一致
  assert.equal(ev.acceptanceProject.status, 'PRODUCT_E2E_VERIFIED');
  assert.equal(e2e.finalStatus.product, 'PRODUCT_E2E_VERIFIED');
  assert.equal(ev.acceptanceProject.loopId, e2e.project.loopId);
  assert.equal(e2e.project.loopStatus, 'completed');
  // 需求矩阵
  assert.equal(matrix.allPass, true);
  assert.equal(matrix.coverage.total, 4);
  assert.equal(matrix.coverage.pass, 4);
  assert.equal(matrix.coverage.fail + matrix.coverage.unknown + matrix.coverage.blocked, 0);
  assert.ok(matrix.requirements.every((r) => r.status === 'PASS' && r.evidence));
  assert.equal(clauses.uncovered.length, 0);
  assert.equal(clauses.clauses.length, 8);
  assert.ok(clauses.clauses.every((c) => c.status === 'PASS' && c.evidence && c.artifacts.length));
  for (const c of clauses.clauses) for (const a of c.artifacts) {
    const target = a.includes('/') ? path.join(root, a) : path.join(root, 'demo/evidence', a);
    if (a.startsWith('projects/') && !hasProductRepo) continue;
    assert.ok(fs.existsSync(target), `clause ${c.id} artifact 不存在：${a}`);
  }
  for (const id of ['R1','R2','R3','R4']) assert.ok(clauses.clauses.some((c) => c.requirementId === id));
  // 成本/调用数一致
  assert.equal(ev.acceptanceProject.agentAttempts, e2e.attempts.count);
  assert.equal(ev.acceptanceProject.agentSuccess, e2e.attempts.completed);
  assert.equal(ev.acceptanceProject.agentTimeout, e2e.attempts.timeout);
  assert.equal(ev.auditBudget.calls, e2e.audits.count);
  assert.ok(Math.abs(ev.acceptanceProject.codingCostCny - e2e.attempts.costCny) < 1e-9);
  assert.ok(Math.abs(ev.acceptanceProject.auditCostCny - e2e.audits.costCny) < 1e-9);
  assert.ok(Math.abs(ev.acceptanceProject.totalCostCny - (e2e.attempts.costCny + e2e.audits.costCny)) < 1e-9);
  // 时间一致且合理
  const start = Date.parse(e2e.duration.start); const end = Date.parse(e2e.duration.end);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start);
  assert.equal(Math.round((end - start) / 1000), e2e.duration.seconds);
  assert.equal(e2e.duration.seconds, 7694);
  // commit 真实存在
  const commit = e2e.project.codeCommit;
  assert.match(commit, /^[0-9a-f]{40}$/);
  if (hasProductRepo) {
    const check = spawnSync('git', ['-C', path.join(root, 'projects/v2.7/reading-queue'), 'cat-file', '-e', `${commit}^{commit}`], { encoding: 'utf8' });
    assert.equal(check.status, 0, `code commit 不存在：${commit}`);
  } else {
    assert.ok(fs.existsSync(path.join(root, 'demo/evidence/reading-queue-planner-final.bundle')), '缺少产品源码 bundle');
  }
  // 24h 必须是 NOT_VERIFIED，不能冒充 24H_VERIFIED
  assert.equal(ev.longRun.status, '24H_NOT_VERIFIED');
  assert.equal(e2e.longRun.status, '24H_NOT_VERIFIED');
  assert.ok(!JSON.stringify(ev).includes('24H_VERIFIED"'));
  // 旧 BLOCKED/UNKNOWN 字段不得残留为当前状态
  assert.notEqual(ev.qualityLoop.realE2E, 'BLOCKED');
  assert.notEqual(ev.fencing.fullWorkbenchHttpProcesses, 'UNKNOWN');
  assert.notEqual(ev.acceptanceProject.status, 'E2E_BLOCKED');
});
