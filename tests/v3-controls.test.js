// SPDX-License-Identifier: Apache-2.0
/** v3.0 P1：受限自然语言控制只走白名单、真实状态、持久化且幂等。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { parseControlIntent, executeConversationControl, CONTROL_ACTIONS } from '../src/controls.js';

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v3-control-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  store.createProject({ id: 'p', name: 'P', localPath: '/tmp/none', testCommand: 'node --test' });
  store.createLoop({ id: 'l', projectId: 'p', goal: '目标', mode: 'plan', status: 'paused' });
  store.createRun({ id: 'r', projectId: 'p', planId: 'plan', goal: '目标', mode: 'single', status: 'paused' });
  store.createPlan({ id: 'plan', projectId: 'p', runId: 'r', goal: '目标', title: 't', tasks: [{ title: '任务一', acceptance: ['a'] }] });
  store.createTasks([{ id: 't1', projectId: 'p', planId: 'plan', runId: 'r', seq: 1, title: '任务一', acceptance: ['a'], testCommand: 'node --test', status: 'blocked' }]);
  store.createAudit({ id: 'a1', runId: 'r', taskId: 't1', provider: 'fake', verdict: 'fail', score: 30, summary: '缺少实现', tokensIn: 10, tokensOut: 5, costCny: 0 });
  store.updateLoop('l', { current_run_id: 'r', stop_reason: '测试失败', history_json: [] });
  const conv = store.createConversation({ title: 'C', projectId: 'p', loopId: 'l', goal: '目标', acceptance: ['a'] });
  const calls = [];
  const loops = { pause: async (id, reason) => { calls.push(['pause', id, reason]); return { id, status: 'paused' }; }, resume: async (id) => { calls.push(['resume', id]); return { id, status: 'running' }; } };
  return { root, config, store, conv, loops, calls };
}

test('v3.0 P1：白名单意图解析，不做自由命令', () => {
  assert.equal(parseControlIntent('开始开发'), 'start');
  assert.equal(parseControlIntent('暂停'), 'pause');
  assert.equal(parseControlIntent('继续开发'), 'resume');
  assert.equal(parseControlIntent('现在进度怎么样'), 'status');
  assert.equal(parseControlIntent('查看成本'), 'cost');
  assert.equal(parseControlIntent('rm -rf /'), '');
  assert.equal(parseControlIntent('git push --force'), '');
  assert.ok(CONTROL_ACTIONS.includes('delivery'));
});

test('v3.0 P1：查询真实状态、暂停/继续都持久化且幂等，且拒绝跨项目 Loop', async () => {
  const h = harness();
  try {
    const status = await executeConversationControl({ config: h.config, store: h.store, orchestrator: {}, loops: h.loops, conversation: h.conv, intent: 'status', requestKey: 'action:status:1' });
    assert.equal(status.runStatus, 'paused');
    assert.equal(status.currentTask.title, '任务一');
    assert.equal(status.audits[0].provider, 'fake');
    assert.equal(h.store.listConversationActions(h.conv.id).length, 1);
    const again = await executeConversationControl({ config: h.config, store: h.store, orchestrator: {}, loops: h.loops, conversation: h.conv, intent: 'status', requestKey: 'action:status:1' });
    assert.equal(again.idempotent, true);
    assert.equal(h.store.listConversationActions(h.conv.id).length, 1, '同一 requestKey 不得重复产生 action');

    await executeConversationControl({ config: h.config, store: h.store, orchestrator: {}, loops: h.loops, conversation: h.conv, intent: 'pause', requestKey: 'action:pause:1' });
    assert.deepEqual(h.calls.at(-1).slice(0, 2), ['pause', 'l']);
    await executeConversationControl({ config: h.config, store: h.store, orchestrator: {}, loops: h.loops, conversation: h.conv, intent: 'resume', requestKey: 'action:resume:1' });
    assert.deepEqual(h.calls.at(-1).slice(0, 2), ['resume', 'l']);

    h.store.createProject({ id: 'p2', name: 'P2', localPath: '/tmp/none2', testCommand: 'node --test' });
    h.store.createLoop({ id: 'l2', projectId: 'p2', goal: 'x', mode: 'plan' });
    const bad = h.store.updateConversation(h.conv.id, { loop_id: 'l2' });
    await assert.rejects(executeConversationControl({ config: h.config, store: h.store, orchestrator: {}, loops: h.loops, conversation: bad, intent: 'pause', requestKey: 'action:bad' }), /不属于/);
    // 跨对话重放同一 requestKey 必须拒绝
    const conv2 = h.store.createConversation({ title: '另一个对话', projectId: 'p' });
    await assert.rejects(executeConversationControl({ config: h.config, store: h.store, orchestrator: {}, loops: h.loops, conversation: conv2, intent: 'status', requestKey: 'action:status:1' }), /请求键|其他对话|重放/);
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});
