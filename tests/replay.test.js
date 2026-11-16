// SPDX-License-Identifier: Apache-2.0
/** v2.6：研发实况 / 历史回放的只读查询与空数据行为。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { buildLive, buildReplay, eligibleProjects, readProductCommit, isExcludedProject } from '../src/replay.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-replay-'));
  const config = getConfig({
    root,
    paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') },
    llm: { openai: { apiKey: '' }, glm: { apiKey: 'k' }, deepseek: { apiKey: 'k' } },
    github: { token: '' },
  });
  const store = openStore(config.paths.dbPath);
  return { config, store, root };
}

test('v2.6 历史回放空数据：明确返回不可用，不造演示记录', () => {
  const { store } = mk();
  try {
    const replay = buildReplay(store);
    assert.equal(replay.available, false);
    assert.equal(replay.project, null);
    const live = buildLive(store);
    assert.equal(live.project, null);
    assert.deepEqual(live.projects, []);
    assert.equal(live.active, false);
  } finally { store.close(); }
});

test('v2.6 研发实况：选择真实项目/当前任务并返回空状态说明', () => {
  const { config, store } = mk();
  try {
    const project = store.createProject({ id: 'p1', name: 'Consumption Decision Lab', localPath: path.join(config.root, 'repo'), testCommand: 'true', description: '真实项目' });
    store.createProject({ id: 'p2', name: 'Investment Agent（B）', localPath: path.join(config.root, 'b'), testCommand: 'true' });
    assert.equal(eligibleProjects(store).some((p) => p.id === 'p1'), true);
    assert.equal(eligibleProjects(store).some((p) => p.id === 'p2'), false);
    assert.equal(isExcludedProject({ name: 'Investment Agent（B）' }), true);
    const empty = buildLive(store);
    assert.equal(empty.project.id, project.id);
    assert.equal(empty.run, null);
    assert.match(empty.reason, /还没有运行记录/);
    const run = store.createRun({ id: 'run1', projectId: project.id, planId: 'plan1', goal: '构建产品', mode: 'single', status: 'running' });
    store.createTasks([{ id: 'task1', projectId: project.id, planId: 'plan1', runId: run.id, seq: 1, title: '实现核心功能', description: '写代码', acceptance: ['测试通过'], testCommand: 'true', status: 'coding', agentKind: 'claude' }]);
    store.appendEvent({ runId: run.id, projectId: project.id, taskId: 'task1', type: 'agent_started', message: 'Claude Code 开始编码' });
    const live = buildLive(store);
    assert.equal(live.active, true);
    assert.equal(live.task.title, '实现核心功能');
    assert.equal(live.agent, 'claude');
    assert.equal(live.events.length, 1);
    assert.match(live.nextStep, /Claude Code/);
    const selected = buildLive(store, project.id);
    assert.equal(selected.project.id, project.id);
  } finally { store.close(); }
});

test('v2.6 历史回放：从任务/attempt/audit/事件重建，缺失字段保留未记录', () => {
  const { config, store } = mk();
  try {
    const repo = path.join(config.root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const project = store.createProject({ id: 'p1', name: 'Consumption Decision Lab', localPath: repo, testCommand: 'true', description: '消费决策实验室' });
    const run = store.createRun({ id: 'run1', projectId: project.id, planId: 'plan1', goal: '实现产品', mode: 'single', status: 'awaiting_acceptance' });
    store.createTasks([{ id: 'task1', projectId: project.id, planId: 'plan1', runId: run.id, seq: 1, title: '实现领域模型', description: 'domain', acceptance: ['单测通过', '证据可追溯'], testCommand: 'true', status: 'passed' }]);
    store.createAttempt({ id: 'a1', runId: run.id, taskId: 'task1', attemptNo: 1, stage: 'coding', agentKind: 'claude', status: 'completed', prompt: '实现 domain.ts', tokensIn: 100, tokensOut: 50, costCny: 1.2, provider: 'glm', model: 'glm-5.3', providerKnown: true, providerSource: 'vendor' });
    store.createAudit({ id: 'au1', runId: run.id, taskId: 'task1', attemptNo: 1, provider: 'deepseek', model: 'deepseek', verdict: 'pass', score: 100, criteria: [{ criterion: '单测通过', status: 'pass', evidence: 'vitest 9/9' }], findings: [], requiredFixes: [], summary: '通过', tokensIn: 20, tokensOut: 10, costCny: 0.1, verificationStatus: 'PASS', providerSource: 'dsh-cli' });
    store.appendEvent({ runId: run.id, projectId: project.id, taskId: 'task1', type: 'task_passed', message: '任务通过' });
    const replay = buildReplay(store);
    assert.equal(replay.available, true);
    assert.equal(replay.project.name, 'Consumption Decision Lab');
    assert.equal(replay.tasks.length, 1);
    assert.equal(replay.attempts.length, 1);
    assert.equal(replay.audits.length, 1);
    assert.equal(replay.audits[0].criteria[0].status, 'pass');
    assert.equal(replay.stats.passedTasks, 1);
    assert.equal(replay.stats.attemptCalls, 1);
    assert.equal(replay.stats.auditCalls, 1);
    assert.equal(replay.stats.humanProductCodeEdits, 'UNKNOWN');
    assert.equal(replay.stats.provenanceStatus, 'UNRECORDED');
    assert.ok(replay.stats.requiredFixes.length === 0);
    assert.match(replay.origin.note, /原始聊天消息未写入/);
    assert.equal(replay.commits.length, 0);
    assert.equal(readProductCommit(store, project.id, 'not-a-sha'), null);
  } finally { store.close(); }
});


test('v2.6 空事件不崩溃，且不会跨项目回放 CDL 素材', () => {
  const { config, store } = mk();
  try {
    const repo = path.join(config.root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const project = store.createProject({ id: 'p1', name: 'Consumption Decision Lab', localPath: repo, testCommand: 'true' });
    store.createRun({ id: 'run1', projectId: project.id, planId: 'plan1', goal: 'g', status: 'running' });
    const replay = buildReplay(store);
    assert.equal(replay.available, true);
    assert.equal(replay.stats.durationMs, 0); // no events: 不抛 RangeError
    store.createProject({ id: 'w1', name: 'AI Workbench（W）', localPath: path.join(config.root, 'w'), testCommand: 'true' });
    const other = buildReplay(store, 'w1');
    assert.equal(other.available, false); // 只允许 CDL 历史，不能混用截图/commit
  } finally { store.close(); }
});

test('v2.6 研发实况：paused/interrupted 不算正在运行', () => {
  const { config, store } = mk();
  try {
    const project = store.createProject({ id: 'p1', name: 'Consumption Decision Lab', localPath: path.join(config.root, 'repo'), testCommand: 'true' });
    const run = store.createRun({ id: 'run1', projectId: project.id, planId: 'plan1', goal: 'g', status: 'paused', mode: 'single' });
    store.createTasks([{ id: 'task1', projectId: project.id, planId: 'plan1', runId: run.id, seq: 1, title: 't', acceptance: ['a'], testCommand: 'true', status: 'coding', agentKind: 'claude' }]);
    const live = buildLive(store);
    assert.equal(live.active, false);
    assert.equal(live.agent, '');
    assert.match(live.reason, /暂停|中断/);
  } finally { store.close(); }
});

test('v2.6 研发实况：读取最近 60 条事件而不是最旧 60 条', () => {
  const { config, store } = mk();
  try {
    const project = store.createProject({ id: 'p1', name: 'Consumption Decision Lab', localPath: path.join(config.root, 'repo'), testCommand: 'true' });
    const run = store.createRun({ id: 'run1', projectId: project.id, planId: 'plan1', goal: 'g', status: 'running' });
    store.createTasks([{ id: 'task1', projectId: project.id, planId: 'plan1', runId: run.id, seq: 1, title: 't', acceptance: ['a'], testCommand: 'true', status: 'coding', agentKind: 'claude' }]);
    for (let i = 0; i < 70; i += 1) store.appendEvent({ runId: run.id, projectId: project.id, type: 'agent_progress', message: `e${i}` });
    const live = buildLive(store);
    assert.equal(live.events.length, 60);
    assert.equal(live.events.at(-1).message, 'e69');
    assert.notEqual(live.events[0].message, 'e0');
  } finally { store.close(); }
});
