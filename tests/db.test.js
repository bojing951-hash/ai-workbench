// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/db.js（node:sqlite 持久化层）。
 * 使用 os.tmpdir() 下的临时 SQLite，不触碰真实 data/；每个用例用独立 id，结束后关闭并删除临时目录。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../src/db.js';

describe('db：SQLite 持久化层', () => {
  let tmpDir;
  let store;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-db-test-'));
    // 嵌套路径：Store 需自行创建父目录
    store = openStore(path.join(tmpDir, 'nested', 'workbench.db'));
  });

  after(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('project CRUD：JSON 字段解析与更新', () => {
    const project = store.createProject({
      id: 'proj_crud',
      name: '演示项目',
      description: 'desc',
      repoUrl: 'https://github.com/acme/demo.git',
      localPath: '/tmp/demo',
      defaultBranch: 'main',
      testCommand: 'npm test',
      language: 'node',
      agentKind: 'auto',
      auditProvider: 'auto',
      protectedPaths: ['tests/**', '.github/**'],
      config: { publish: false },
    });
    assert.equal(project.name, '演示项目');
    assert.deepEqual(project.protected_paths, ['tests/**', '.github/**']);
    assert.deepEqual(project.config_json, { publish: false });
    assert.equal(project.status, 'active');
    assert.ok(project.created_at);

    assert.equal(store.getProject('proj_missing'), null);
    assert.ok(store.listProjects().some((p) => p.id === 'proj_crud'));

    const updated = store.updateProject('proj_crud', { name: '改名项目', test_command: 'node --test' });
    assert.equal(updated.name, '改名项目');
    assert.equal(updated.test_command, 'node --test');
    assert.deepEqual(updated.protected_paths, ['tests/**', '.github/**']);

    const withPaths = store.updateProject('proj_crud', { protected_paths: ['tests/**'] });
    assert.deepEqual(withPaths.protected_paths, ['tests/**']);
    assert.equal(store.updateProject('proj_missing', { name: 'x' }), null);
  });

  it('plan CRUD：tasks / planner_meta JSON 解析与更新', () => {
    const plan = store.createPlan({
      id: 'plan_crud',
      projectId: 'proj_crud',
      runId: 'run_crud',
      goal: '实现演示接口',
      title: '演示计划',
      mode: 'plan',
      tasks: [{ seq: 1, title: '任务一', acceptance: ['可验证'] }],
      plannerMeta: { mode: 'explicit', provider: 'human' },
    });
    assert.equal(plan.title, '演示计划');
    assert.equal(plan.tasks_json.length, 1);
    assert.equal(plan.tasks_json[0].title, '任务一');
    assert.equal(plan.planner_meta_json.mode, 'explicit');

    assert.ok(store.listPlans('proj_crud').some((p) => p.id === 'plan_crud'));
    assert.equal(store.listPlans('proj_missing').length, 0);

    const updated = store.updatePlan('plan_crud', { status: 'done', tasks_json: [] });
    assert.equal(updated.status, 'done');
    assert.deepEqual(updated.tasks_json, []);
    assert.equal(store.updatePlan('plan_missing', { status: 'x' }), null);
  });

  it('run CRUD 与 usage 累加', () => {
    const run = store.createRun({
      id: 'run_crud',
      projectId: 'proj_crud',
      planId: 'plan_crud',
      goal: '目标',
      mode: 'single',
      budget: { maxTokens: 1000 },
    });
    assert.equal(run.status, 'queued');
    assert.deepEqual(run.spent_json, { tokens: 0, costCny: 0 });
    assert.deepEqual(run.budget_json, { maxTokens: 1000 });

    const running = store.updateRun('run_crud', {
      status: 'running',
      current_task_id: 'task_x',
      started_at: '2024-01-01T00:00:00.000Z',
    });
    assert.equal(running.status, 'running');
    assert.equal(running.current_task_id, 'task_x');
    assert.ok(store.listActiveRuns().some((r) => r.id === 'run_crud'));
    assert.ok(store.listRuns('proj_crud').some((r) => r.id === 'run_crud'));
    assert.equal(store.listRuns('proj_missing').length, 0);

    const u1 = store.addRunUsage('run_crud', { tokens: 100, costCny: 0.5 });
    assert.equal(u1.spent_json.tokens, 100);
    assert.equal(u1.spent_json.costCny, 0.5);
    assert.ok(u1.spent_json.updatedAt);
    const u2 = store.addRunUsage('run_crud', { tokens: 50, costCny: 0.25 });
    assert.equal(u2.spent_json.tokens, 150);
    assert.equal(u2.spent_json.costCny, 0.75);
    assert.equal(store.addRunUsage('run_missing', { tokens: 1 }), null);

    const accepted = store.updateRun('run_crud', { status: 'accepted', ended_at: '2024-01-02T00:00:00.000Z' });
    assert.equal(accepted.status, 'accepted');
    assert.equal(store.listActiveRuns().some((r) => r.id === 'run_crud'), false);
    assert.equal(store.getRun('run_missing'), null);
    assert.equal(store.updateRun('run_missing', { status: 'x' }), null);
  });

  it('task CRUD：createTasks / listTasks 过滤与 nextQueuedTask', () => {
    const tasks = store.createTasks([
      {
        id: 'task_a',
        projectId: 'proj_crud',
        planId: 'plan_tasks',
        runId: 'run_tasks',
        seq: 2,
        title: '第二个',
        description: 'd2',
        acceptance: ['验收2'],
        agentKind: 'dsh',
        testCommand: 'node --test',
      },
      {
        id: 'task_b',
        projectId: 'proj_crud',
        planId: 'plan_tasks',
        runId: 'run_tasks',
        seq: 1,
        title: '第一个',
        acceptance: ['验收1'],
        maxAttempts: 3,
      },
    ]);
    // createTasks 返回按 seq 升序
    assert.deepEqual(tasks.map((t) => t.id), ['task_b', 'task_a']);
    assert.deepEqual(tasks[0].acceptance_json, ['验收1']);
    assert.equal(tasks[0].status, 'queued');
    assert.equal(tasks[0].attempt, 0);
    assert.equal(tasks[0].max_attempts, 3);
    assert.equal(tasks[1].agent_kind, 'dsh');
    assert.equal(tasks[1].test_command, 'node --test');

    assert.equal(store.listTasks({ planId: 'plan_tasks' }).length, 2);
    assert.equal(store.listTasks({ runId: 'run_tasks' }).length, 2);
    assert.equal(store.listTasks({ projectId: 'proj_crud' }).length, 2);
    assert.equal(store.listTasks({ status: 'queued' }).length, 2);
    assert.equal(store.listTasks({ planId: 'plan_tasks', status: 'coding' }).length, 0);

    assert.equal(store.nextQueuedTask('plan_tasks').id, 'task_b');
    const coding = store.updateTask('task_b', { status: 'coding', attempt: 1 });
    assert.equal(coding.status, 'coding');
    assert.equal(coding.attempt, 1);
    assert.equal(store.nextQueuedTask('plan_tasks').id, 'task_a');
    assert.deepEqual(store.taskCounts('plan_tasks'), { coding: 1, queued: 1 });

    assert.equal(store.getTask('task_missing'), null);
    assert.equal(store.updateTask('task_missing', { status: 'x' }), null);
    assert.equal(store.nextQueuedTask('plan_missing'), null);
  });

  it('createTasks 事务：中途失败时整体回滚', () => {
    assert.throws(
      () =>
        store.createTasks([
          { id: 'task_rollback_1', projectId: 'proj_crud', planId: 'plan_rollback', runId: 'run_x', seq: 1, title: 'ok' },
          { id: 'task_rollback_2', projectId: 'proj_crud', planId: 'plan_rollback', runId: 'run_x', seq: 2, title: null },
        ]),
      (err) => /NOT NULL|constraint/i.test(String(err.message)),
    );
    assert.equal(store.listTasks({ planId: 'plan_rollback' }).length, 0);
  });

  it('transitionTask CAS：from 状态不匹配时迁移不生效', () => {
    store.createTasks([
      { id: 'task_cas', projectId: 'proj_cas', planId: 'plan_cas', runId: 'run_cas', seq: 1, title: 'CAS 任务' },
    ]);
    // 当前是 queued，按 coding -> testing 迁移必须失败
    assert.equal(store.transitionTask('task_cas', 'coding', 'testing'), false);
    assert.equal(store.getTask('task_cas').status, 'queued');
    // 正确的 from 才生效，并写入 extra
    assert.equal(store.transitionTask('task_cas', 'queued', 'preparing', { attempt: 1, branch: 'wb/x' }), true);
    const after = store.getTask('task_cas');
    assert.equal(after.status, 'preparing');
    assert.equal(after.attempt, 1);
    assert.equal(after.branch, 'wb/x');
    // 同一 from 不能重复迁移（幂等性保护）
    assert.equal(store.transitionTask('task_cas', 'queued', 'coding'), false);
    assert.equal(store.transitionTask('task_missing', 'queued', 'coding'), false);

    const reset = store.resetTaskForRetry('task_cas');
    assert.equal(reset.status, 'queued');
    assert.equal(reset.attempt, 0);
    assert.equal(reset.head_commit, '');
  });

  it('events 游标：after 增量读取、runId 过滤与 limit', () => {
    const e1 = store.appendEvent({ runId: 'run_evt', type: 'a', message: 'first' });
    const e2 = store.appendEvent({ runId: 'run_evt', type: 'b', level: 'warn', message: 'second', data: { n: 2 } });
    const e3 = store.appendEvent({ runId: 'run_evt_2', type: 'c', message: 'third' });
    assert.ok(e1.id < e2.id && e2.id < e3.id);

    const all = store.listEvents({ runId: 'run_evt' });
    assert.deepEqual(all.map((e) => e.type), ['a', 'b']);
    assert.deepEqual(all[1].data_json, { n: 2 });
    assert.equal(all[1].level, 'warn');

    const page = store.listEvents({ runId: 'run_evt', after: e1.id });
    assert.deepEqual(page.map((e) => e.id), [e2.id]);
    assert.deepEqual(store.listEvents({ runId: 'run_evt', after: e3.id }), []);
    assert.equal(store.listEvents({ after: 0, limit: 2 }).length >= 2, true);
    assert.equal(store.listEvents({ after: e1.id, limit: 1 }).length, 1);

    // 超长 message 截断到 4000 字符
    const long = store.appendEvent({ runId: 'run_evt', type: 'long', message: 'x'.repeat(5000) });
    assert.equal(store.listEvents({ after: long.id - 1 })[0].message.length, 4000);
  });

  it('attempts / audits：创建、更新与中断标记', () => {
    const att = store.createAttempt({
      id: 'att_1',
      runId: 'run_att',
      taskId: 'task_att',
      attemptNo: 1,
      stage: 'coding',
      agentKind: 'dsh',
      prompt: '实现功能',
      status: 'running',
    });
    assert.equal(att.status, 'running');
    const updated = store.updateAttempt('att_1', {
      status: 'completed',
      exitCode: 0,
      sessionId: 's1',
      tokensIn: 10,
      tokensOut: 20,
      tokensCache: 5,
      costCny: 0.01,
      durationMs: 100,
    });
    assert.equal(updated.tokens_in, 10);
    assert.equal(updated.tokens_out, 20);
    assert.equal(updated.tokens_cache, 5);

    store.createAttempt({ id: 'att_2', runId: 'run_att', taskId: 'task_att', attemptNo: 2, stage: 'coding', status: 'running' });
    store.createAttempt({ id: 'att_3', runId: 'run_other', taskId: 'task_other', attemptNo: 1, stage: 'coding', status: 'running' });
    assert.equal(store.listAttempts('task_att').length, 2);
    assert.equal(store.getAttempt('att_missing'), null);

    const interrupted = store.markRunningAttemptsInterrupted();
    assert.equal(interrupted, 2);
    assert.equal(store.getAttempt('att_2').status, 'interrupted');
    assert.equal(store.getAttempt('att_1').status, 'completed');

    const audit = store.createAudit({
      id: 'aud_1',
      runId: 'run_att',
      taskId: 'task_att',
      attemptNo: 1,
      provider: 'fake',
      model: 'fake-audit',
      verdict: 'fail',
      score: 40,
      criteria: [{ criterion: '验收', status: 'fail' }],
      findings: [{ severity: 'high', issue: '缺失' }],
      requiredFixes: ['补充实现'],
      summary: '未通过',
    });
    assert.equal(audit.verdict, 'fail');
    assert.equal(store.listAudits('task_att').length, 1);
    assert.deepEqual(store.listAudits('task_att')[0].required_fixes_json, ['补充实现']);
    assert.deepEqual(store.listAudits('task_att')[0].criteria_json, [{ criterion: '验收', status: 'fail' }]);
    assert.deepEqual(store.listAudits('task_att')[0].findings_json, [{ severity: 'high', issue: '缺失' }]);
    assert.equal(store.getAudit('aud_missing'), null);

    const totals = store.usageTotals();
    assert.equal(totals.tokensIn, 10 + 0); // att_1 in=10，audits tokens_in=0
    assert.equal(totals.tokens, 10 + 20 + 5);
    assert.equal(totals.costCny, 0.01);
  });

  it('artifacts / actions / meta 读写', () => {
    store.addArtifact({ id: 'art_1', runId: 'run_att', taskId: 'task_att', kind: 'diff', path: 'run_att/a.diff', meta: { bytes: 3 } });
    const artifacts = store.listArtifacts('task_att');
    assert.equal(artifacts.length, 1);
    assert.deepEqual(artifacts[0].meta_json, { bytes: 3 });

    const action = store.createAction({
      id: 'act_1',
      runId: 'run_att',
      type: 'github-publish',
      payload: { planBranch: 'wb/plan-x' },
      result: { reason: '创建时 result 正常写入' },
    });
    assert.equal(action.status, 'pending');
    assert.deepEqual(store.getAction('act_1').result_json, { reason: '创建时 result 正常写入' });
    // 注意：updateAction 的 result 持久化存在产品缺陷，见文件末尾 skip 用例。
    const updated = store.updateAction('act_1', { status: 'blocked' });
    assert.equal(updated.status, 'blocked');
    assert.equal(store.listActions('run_att').length, 1);
    assert.equal(store.getAction('act_missing'), null);
    assert.equal(store.updateAction('act_missing', { status: 'x' }), null);

    store.setMeta('last_llm', { provider: 'fake', at: 'now' });
    assert.deepEqual(store.getMeta('last_llm'), { provider: 'fake', at: 'now' });
    assert.equal(store.getMeta('missing', 'fallback'), 'fallback');
  });

  // ==========================================================================
  // 回归用例：曾经 updateAction 只读取 merged.result_json，而 orchestrator 调用方
  // 传入 result，导致 GitHub push/PR/CI 结果丢失。该缺陷已修复（兼容两种写法），
  // 此用例用于防止回归。
  // ==========================================================================
  it('updateAction 应持久化传入的 result', () => {
    store.createAction({ id: 'act_bug', runId: 'run_bug', type: 'github-pr', payload: {} });
    store.updateAction('act_bug', { status: 'done', result: { pr: { number: 1, url: 'https://example.com/pr/1' } } });
    assert.deepEqual(store.getAction('act_bug').result_json, { pr: { number: 1, url: 'https://example.com/pr/1' } });
  });
});
