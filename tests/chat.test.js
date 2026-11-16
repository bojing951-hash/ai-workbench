// SPDX-License-Identifier: Apache-2.0
/** v2.9 Chat-first：对话持久化 + 一键启动复用现有 Loop/Orchestrator，不新增编排系统。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { startDevelopment } from '../src/chat.js';

test('v2.9：对话消息持久化，刷新后可恢复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    const conv = store.createConversation({ title: '消费网站', goal: '开发消费管理网站', acceptance: ['可以记录支出'] });
    store.addConversationMessage({ conversationId: conv.id, role: 'user', content: '开发消费管理网站' });
    store.addConversationMessage({ conversationId: conv.id, role: 'assistant', content: '已整理需求', data: { kind: 'brief', ready: true } });
    const again = store.getConversation(conv.id);
    const messages = store.listConversationMessages(conv.id);
    assert.equal(again.title, '消费网站');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].data_json.kind, 'brief');
  } finally { store.close(); }
});

test('v2.9：一键启动使用现有 LoopManager，关联 conversation/project/loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-start-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    store.createProject({ id: 'p', name: '已有项目', localPath: '/tmp/none', testCommand: 'true' });
    const conv = store.createConversation({ title: '已有项目目标', goal: '实现目标', acceptance: ['验收 A'], projectId: 'p' });
    let created = null;
    const fakeLoops = {
      create: async (input) => { created = input; const loop = store.createLoop({ id: 'loop-chat', projectId: input.projectId, goal: input.goal, mode: input.mode, queue: input.queue }); return { ...loop, project: { id: 'p', name: '已有项目' }, progress: {} }; },
      get: (id) => store.getLoop(id),
    };
    const res = await startDevelopment({ config, store, orchestrator: { createProject: async () => { throw new Error('不应创建新项目'); } }, loops: fakeLoops, conversation: conv, projectId: 'p' });
    assert.equal(res.project.id, 'p');
    assert.equal(res.loop.id, 'loop-chat');
    assert.equal(created.projectId, 'p');
    assert.equal(created.goal, '实现目标');
    const updated = store.getConversation(conv.id);
    assert.equal(updated.status, 'running');
    assert.equal(updated.project_id, 'p');
    assert.equal(updated.loop_id, 'loop-chat');
  } finally { store.close(); }
});

test('v2.9：新项目使用嵌套独立 Git；Loop 创建失败时保留 project 关联，重试不重复建项目', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-orphan-'));
  // 父目录本身是 Git 仓库，强制验证新项目会创建自己的嵌套 .git，而不是落到父仓库。
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    let conv = store.createConversation({ title: '新项目', goal: '做一个本地工具', acceptance: ['验收 A'] });
    conv = store.updateConversation(conv.id, { brief_json: { acceptance: ['验收 A'] }, acceptance_json: ['验收 A'], status: 'ready' });
    let captured = null;
    const fakeOrch = { createProject: async (input) => { captured = input; return store.createProject({ id: 'p-new', name: input.name, localPath: input.repo, defaultBranch: 'main', testCommand: input.testCommand, contractFiles: input.contractFiles, protectedPaths: input.protectedPaths, config: { require_real_tests: input.requireRealTests, test_plan: input.testPlan, contract_baseline: input.contractBaseline } }); } };
    const failingLoops = { create: async () => { throw new Error('LOOP_CREATE_FAILED'); } };
    await assert.rejects(startDevelopment({ config, store, orchestrator: fakeOrch, loops: failingLoops, conversation: conv }), /LOOP_CREATE_FAILED/);
    const after = store.getConversation(conv.id);
    assert.equal(after.project_id, 'p-new');
    const project = store.getProject('p-new');
    assert.ok(fs.existsSync(path.join(project.local_path, '.git')), '新项目必须是独立嵌套 Git 仓库，不能落到 Workbench 父仓库');
    assert.equal(captured.testCommand, '', '新项目不得预置 true 测试命令');
    assert.equal(captured.requireRealTests, true);
    assert.deepEqual(captured.testPlan.acceptance, ['验收 A']);
    assert.ok(fs.existsSync(path.join(project.local_path, 'TEST_PLAN.json')));
    assert.ok(fs.existsSync(path.join(project.local_path, 'tests/acceptance/workbench-contract.test.mjs')));
    assert.ok(captured.contractBaseline['CONTRACT.md']);
    // 重试复用同一 project，不新建第二个
    let reused = '';
    const loops2 = { create: async (input) => { reused = input.projectId; const l = store.createLoop({ id: 'loop-new', projectId: input.projectId, goal: input.goal, mode: 'plan', queue: [] }); return l; } };
    const res = await startDevelopment({ config, store, orchestrator: fakeOrch, loops: loops2, conversation: after });
    assert.equal(reused, 'p-new');
    assert.equal(res.project.id, 'p-new');
  } finally { store.close(); }
});


test('v2.9：崩溃留下的 active loop 被对话重新接管，不报 LOOP_ACTIVE 或重复创建', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-adopt-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    store.createProject({ id: 'p', name: '已有项目', localPath: '/tmp/none', testCommand: 'true' });
    const conv = store.createConversation({ title: '接管', goal: '目标', acceptance: ['a'], projectId: 'p', brief_json: { acceptance: ['a'] } });
    const loop = store.createLoop({ id: 'loop-active', projectId: 'p', goal: '目标', mode: 'plan', queue: [], status: 'paused' });
    let created = 0;
    const res = await startDevelopment({ config, store, orchestrator: { createProject: async () => { throw new Error('no'); } }, loops: { create: async () => { created += 1; throw new Error('must not create'); }, get: () => ({ ...loop, status: 'paused' }) }, conversation: conv, projectId: 'p' });
    assert.equal(res.adopted, true);
    assert.equal(created, 0);
    assert.equal(store.getConversation(conv.id).loop_id, 'loop-active');
    assert.equal(store.getConversation(conv.id).status, 'running');
  } finally { store.close(); }
});
