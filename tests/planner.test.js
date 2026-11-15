// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/planner.js 任务规划（不调用 LLM，完全离线）。
 * 只覆盖 explicit / single 两条确定性路径与异常校验；auto 路径需要 LLM，此处只验证
 * "无可用 provider 时明确报错且不发起网络请求"。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getConfig } from '../src/config.js';
import { PolicyError } from '../src/policy.js';
import { planTasks } from '../src/planner.js';

/** 构造隔离到临时目录的 config：不写入真实 data/ 或 projects/。 */
function buildIsolatedConfig(root) {
  const dataDir = path.join(root, 'data');
  return getConfig({
    root,
    paths: {
      root,
      dataDir,
      dbPath: path.join(dataDir, 'workbench.db'),
      projectsDir: path.join(root, 'projects'),
      worktreesDir: path.join(dataDir, 'worktrees'),
      artifactsDir: path.join(dataDir, 'artifacts'),
      logsDir: path.join(dataDir, 'logs'),
      agentsDir: path.join(dataDir, 'agents'),
      dshHome: path.join(dataDir, 'agents', 'dsh-home'),
      claudeHome: path.join(dataDir, 'agents', 'claude-home'),
    },
    // 清空所有密钥：确保任何路径都不可能发起真实 LLM 调用
    secrets: [],
    llm: {
      openai: { apiKey: '' },
      glm: { apiKey: '' },
      deepseek: { apiKey: '' },
    },
    github: { token: '' },
  });
}

describe('planner.planTasks：确定性路径与校验（离线）', () => {
  let tmpDir;
  let config;
  let project;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-planner-test-'));
    config = buildIsolatedConfig(tmpDir);
    // 仓库目录（explicit/single 路径不会读取，但保持字段完整）
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
    project = {
      id: 'proj_planner',
      name: '演示项目',
      local_path: repoDir,
      default_branch: 'main',
      test_command: 'npm test',
      protected_paths: [],
    };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('explicit 模式：规范化任务字段、seq、agent、test_command', async () => {
    const result = await planTasks({
      config,
      project,
      goal: '实现用户登录接口',
      mode: 'plan',
      tasks: [
        {
          title: '任务 A',
          description: '实现 POST /login',
          acceptance: ['返回 200 与 token 字段'],
          agent: 'dsh',
          test_command: 'node --test tests/login.test.js',
        },
        { title: '任务 B', acceptance: ['GET /me 返回用户信息'], agent: '不存在的agent' },
      ],
    });
    assert.equal(result.plannerMeta.mode, 'explicit');
    assert.equal(result.plannerMeta.provider, 'human');
    assert.equal(result.title, '手动计划：实现用户登录接口');
    assert.equal(result.tasks.length, 2);

    assert.deepEqual(result.tasks[0], {
      seq: 1,
      title: '任务 A',
      description: '实现 POST /login',
      acceptance: ['返回 200 与 token 字段'],
      agent: 'dsh',
      testCommand: 'node --test tests/login.test.js',
    });
    assert.equal(result.tasks[1].seq, 2);
    assert.equal(result.tasks[1].agent, 'auto'); // 非法 agent 归一为 auto
    assert.equal(result.tasks[1].description, '任务 B'); // description 缺省回退 title
    assert.equal(result.tasks[1].testCommand, '');
  });

  it('explicit 模式：任务未给验收标准时继承顶层 acceptance', async () => {
    const result = await planTasks({
      config,
      project,
      goal: '目标',
      acceptance: ['顶层验收 A', '顶层验收 B'],
      tasks: [{ title: '只有标题' }],
    });
    assert.deepEqual(result.tasks[0].acceptance, ['顶层验收 A', '顶层验收 B']);
    assert.equal(result.tasks[0].description, '只有标题');
  });

  it('explicit 模式：缺少验收标准时报 PLAN_INVALID（不调用 LLM）', async () => {
    await assert.rejects(
      () => planTasks({ config, project, goal: '目标', tasks: [{ title: '没有验收标准的任务' }] }),
      (err) => err instanceof PolicyError && err.code === 'PLAN_INVALID' && /缺少验收标准/.test(err.message),
    );
  });

  it('explicit 模式：任务数超过 8 个时报 PLAN_INVALID', async () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ title: `任务 ${i + 1}`, acceptance: ['可验证标准'] }));
    await assert.rejects(
      () => planTasks({ config, project, goal: '目标', tasks }),
      (err) => err instanceof PolicyError && err.code === 'PLAN_INVALID' && /任务过多/.test(err.message),
    );
  });

  it('explicit 模式：标题缺省兜底为「任务 N」，验收标准最多保留 6 条', async () => {
    const result = await planTasks({
      config,
      project,
      goal: '目标',
      tasks: [{ title: '', acceptance: ['1', '2', '3', '4', '5', '6', '7'] }],
    });
    assert.equal(result.tasks[0].title, '任务 1');
    assert.deepEqual(result.tasks[0].acceptance, ['1', '2', '3', '4', '5', '6']);
  });

  it('single 模式：生成单任务，acceptance 缺省回退 goal，不调用 LLM', async () => {
    const result = await planTasks({ config, project, goal: '实现健康检查接口', mode: 'single', acceptance: ['GET /health 返回 ok'] });
    assert.equal(result.plannerMeta.mode, 'single');
    assert.equal(result.plannerMeta.provider, 'user');
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].seq, 1);
    assert.equal(result.tasks[0].title, '实现健康检查接口');
    assert.equal(result.tasks[0].description, '实现健康检查接口');
    assert.deepEqual(result.tasks[0].acceptance, ['GET /health 返回 ok']);
    assert.equal(result.tasks[0].agent, 'auto');
    assert.equal(result.tasks[0].testCommand, '');
    assert.equal(result.title, '实现健康检查接口');

    const noAcceptance = await planTasks({ config, project, goal: '只有目标', mode: 'single' });
    assert.deepEqual(noAcceptance.tasks[0].acceptance, ['只有目标']);
  });

  it('tasks 为空数组 / 非数组时回退 single 模式', async () => {
    const empty = await planTasks({ config, project, goal: '目标', mode: 'single', tasks: [] });
    assert.equal(empty.plannerMeta.mode, 'single');
    assert.equal(empty.tasks.length, 1);

    const notArray = await planTasks({ config, project, goal: '目标', mode: 'single', tasks: 'not-an-array' });
    assert.equal(notArray.plannerMeta.mode, 'single');
  });

  it('plan 模式且没有可用 LLM Key 时抛出 PLANNER_UNAVAILABLE（无网络调用）', async () => {
    await assert.rejects(
      () => planTasks({ config, project, goal: '自动规划一个完整功能', mode: 'plan' }),
      (err) => err instanceof PolicyError && err.code === 'PLANNER_UNAVAILABLE',
    );
  });
});
