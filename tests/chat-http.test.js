// SPDX-License-Identifier: Apache-2.0
/** v3.0 P0-1：真实 HTTP 请求下的首条消息、幂等、并发重复与失败重试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { LoopManager } from '../src/loop.js';
import { createApp } from '../src/server.js';

function tempConfig(upstreamBase, budget = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-http-'));
  const paths = { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') };
  return { root, config: getConfig({ root, paths, llm: { deepseek: { apiKey: 'test-key', baseUrl: upstreamBase, model: 'fake-deepseek' }, openai: { apiKey: '' }, glm: { apiKey: '' } }, github: { token: '', owner: '', createPr: false, push: false, autoCreateRepo: false }, security: { apiToken: 'test-token', allowedHosts: [], testEnvAllowlist: [] }, budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, ...budget } }) };
}

async function startServer(config, store) {
  const bus = new EventBus();
  const orch = new Orchestrator({ config, store, bus, deps: { checkAgents: async () => [], runAgent: async () => { throw new Error('no'); }, runAudit: async () => { throw new Error('no'); }, chooseAgent: async () => { throw new Error('no'); } } });
  const loops = new LoopManager({ config, store, bus, orchestrator: orch });
  const server = createApp({ config, store, orchestrator: orch, loops });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
function request(base, method, p, body, token = 'test-token') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-workbench-token': token, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; }); res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function fakeUpstream() {
  const state = { calls: 0, fail: false };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      state.calls += 1;
      if (state.fail) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fake upstream rejection' } })); return; }
      const reply = { reply: `真实HTTP模拟回复 #${state.calls}`, ready: true, missing: [], productName: 'HTTP测试产品', goal: '验证聊天幂等', acceptance: ['A1 可以验证', 'A2 可以验证'], questions: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { server: srv, state, base: `http://127.0.0.1:${srv.address().port}` };
}

test('v3.0 P0-1：真实 HTTP 首条消息只处理一次，重复/并发请求幂等', async () => {
  const fake = await fakeUpstream();
  const { root, config } = tempConfig(fake.base);
  const store = openStore(config.paths.dbPath);
  const { server, base } = await startServer(config, store);
  try {
    const c1 = await request(base, 'POST', '/api/conversations', { title: '首条消息', clientRequestId: 'conv-req-1' });
    const c2 = await request(base, 'POST', '/api/conversations', { title: '首条消息', clientRequestId: 'conv-req-1' });
    assert.equal(c1.status, 201); assert.equal(c2.status, 200);
    const convId = c1.json.data.conversation.id;
    assert.equal(c2.json.data.conversation.id, convId);

    // 并发同 key：只能有一次模型调用、一条用户消息、一条 assistant 回复。
    const [m1, m2] = await Promise.all([
      request(base, 'POST', `/api/conversations/${convId}/messages`, { content: '帮我做一个可验证的本地工具', clientMessageId: 'msg-req-1' }),
      request(base, 'POST', `/api/conversations/${convId}/messages`, { content: '帮我做一个可验证的本地工具', clientMessageId: 'msg-req-1' }),
    ]);
    assert.equal(m1.status, 200); assert.equal(m2.status, 200);
    const messages = store.listConversationMessages(convId);
    assert.equal(messages.filter((m) => m.role === 'user').length, 1, '同一 clientMessageId 只能有一条用户消息');
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 1, '同一 clientMessageId 只能有一条 assistant 回复');
    assert.equal(fake.state.calls, 1, '并发重复发送不得重复调用模型');
    assert.equal(store.usageTotals().byProvider.deepseek.tokens > 0, true, 'Chat 用量必须进入统一账本');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    await new Promise((r) => fake.server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v3.0 P0-1：模型失败后同一 clientMessageId 可安全重试，不重复用户消息', async () => {
  const fake = await fakeUpstream();
  const { root, config } = tempConfig(fake.base);
  const store = openStore(config.paths.dbPath);
  const { server, base } = await startServer(config, store);
  try {
    fake.state.fail = true;
    const c = await request(base, 'POST', '/api/conversations', { title: '失败重试', clientRequestId: 'conv-retry' });
    const convId = c.json.data.conversation.id;
    const bad = await request(base, 'POST', `/api/conversations/${convId}/messages`, { content: '重试目标', clientMessageId: 'msg-retry' });
    assert.notEqual(bad.status, 200);
    assert.equal(store.listConversationMessages(convId).filter((m) => m.role === 'user').length, 1);
    fake.state.fail = false;
    const good = await request(base, 'POST', `/api/conversations/${convId}/messages`, { content: '重试目标', clientMessageId: 'msg-retry' });
    assert.equal(good.status, 200);
    const messages = store.listConversationMessages(convId);
    assert.equal(messages.filter((m) => m.role === 'user').length, 1, '重试不能重复用户消息');
    assert.equal(messages.filter((m) => m.role === 'assistant' && m.data?.kind !== 'error').length, 1, '重试成功后只保留一条有效回复');
  } finally {
    await new Promise((r) => server.close(r)); store.close(); await new Promise((r) => fake.server.close(r)); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v3.0 P1：自然语言进度查询走真实 DB，不调用对话模型，不操作无关项目', async () => {
  const fake = await fakeUpstream();
  const { root, config } = tempConfig(fake.base);
  const store = openStore(config.paths.dbPath);
  const { server, base } = await startServer(config, store);
  try {
    store.createProject({ id: 'p-control', name: '控制项目', localPath: '/tmp/none', testCommand: 'node --test' });
    store.createLoop({ id: 'l-control', projectId: 'p-control', goal: '目标', mode: 'plan', status: 'running' });
    store.createRun({ id: 'r-control', projectId: 'p-control', planId: 'pl-control', goal: '目标', mode: 'single', status: 'running' });
    store.createPlan({ id: 'pl-control', projectId: 'p-control', runId: 'r-control', goal: '目标', title: 't', tasks: [{ title: '当前任务', acceptance: ['a'] }] });
    store.createTasks([{ id: 't-control', projectId: 'p-control', planId: 'pl-control', runId: 'r-control', seq: 1, title: '当前任务', acceptance: ['a'], testCommand: 'node --test', status: 'coding' }]);
    store.updateLoop('l-control', { current_run_id: 'r-control' });
    const conv = store.createConversation({ title: '控制', projectId: 'p-control', loopId: 'l-control', goal: '目标', acceptance: ['a'] });
    const res = await request(base, 'POST', `/api/conversations/${conv.id}/messages`, { content: '现在进度怎么样？', clientMessageId: 'control-msg-1' });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.assistant.data.kind, 'control');
    assert.equal(res.json.data.assistant.data.control.currentTask.title, '当前任务');
    assert.equal(fake.state.calls, 0, '纯状态查询不得调用模型');
    assert.equal(store.listConversationActions(conv.id).length, 1, '控制动作必须持久化');
    const ctl = await request(base, 'POST', `/api/conversations/${conv.id}/control`, { action: 'status' });
    assert.equal(ctl.status, 200);
    assert.equal(ctl.json.data.control.currentTask.title, '当前任务');
  } finally {
    await new Promise((r) => server.close(r)); store.close(); await new Promise((r) => fake.server.close(r)); fs.rmSync(root, { recursive: true, force: true });
  }
});


test('v3.0 P0-4：Chat 接口超预算 fail-closed，不调用模型', async () => {
  const fake = await fakeUpstream();
  const { root, config } = tempConfig(fake.base, { maxTotalTokens: 1_000, maxCostCny: 1 });
  const store = openStore(config.paths.dbPath);
  const { server, base } = await startServer(config, store);
  try {
    const c = await request(base, 'POST', '/api/conversations', { title: '超预算', clientRequestId: 'conv-budget' });
    const convId = c.json.data.conversation.id;
    const res = await request(base, 'POST', `/api/conversations/${convId}/messages`, { content: '帮我开发东西', clientMessageId: 'budget-msg' });
    assert.equal(res.status, 409);
    assert.match(res.json.error.message, /预算不足|BUDGET_CHAT/i);
    assert.equal(fake.state.calls, 0, '超预算时绝不能调用模型');
  } finally {
    await new Promise((r) => server.close(r)); store.close(); await new Promise((r) => fake.server.close(r)); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v3.4 P0-1：Chat-First 实验关联 → 项目 Docker/模型绑定 → 启动前 BLOCKED，零模型调用', { timeout: 30_000 }, async () => {
  const fake = await fakeUpstream();
  // 该失败路径必须稳定模拟 Docker 不可用，不依赖宿主是否安装 Docker；通过构造配置时环境覆盖，避免改写冻结 config。
  const prevDockerBin = process.env.DOCKER_BIN;
  process.env.DOCKER_BIN = '/no/such/docker';
  let root; let config;
  try { ({ root, config } = tempConfig(fake.base)); } finally {
    if (prevDockerBin === undefined) delete process.env.DOCKER_BIN; else process.env.DOCKER_BIN = prevDockerBin;
  }
  const store = openStore(config.paths.dbPath);
  const { server, base } = await startServer(config, store);
  try {
    const conv = store.createConversation({ title: '实验 Chat', goal: '验证 Chat-First 实验关联', acceptance: ['A1', 'A2'], brief: { acceptance: ['A1', 'A2'] } });
    const exp = store.createExperimentContract({
      projectId: '', conversationId: conv.id, authorizedBy: 'user:test', authorizationSource: 'user_cli_tty',
      authorizationText: 'I_AUTHORIZE_E2E_BUDGET_V1 limits', tokenLimit: 3_620_000, costLimitCny: 80, stopLossCny: 72, callLimit: 50,
      deadlineAt: new Date(Date.now() + 3600_000).toISOString(), glmTokenLimit: 4_000_000, glmCostLimitCny: 40,
      dshTokenLimit: 2_000_000, dshCostLimitCny: 30, nonGlmCostLimitCny: 10, perCallMaxTokens: 20_000,
      provider: { chat: { client: 'deepseek', provider: 'deepseek', model: 'fake-deepseek' }, planner: { client: 'deepseek', provider: 'deepseek', model: 'fake-deepseek' }, coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' } },
      isolationMode: 'DOCKER_REQUIRED',
    });
    const msg = await request(base, 'POST', `/api/conversations/${conv.id}/messages`, { content: '开始开发', clientMessageId: 'exp-chat-1' });
    assert.notEqual(msg.status, 200, 'Docker 不可用时 Chat 模型调用必须被阻止');
    assert.equal(fake.state.calls, 0, '不得发生 Chat 模型调用');
    assert.match(msg.text, /ISOLATION|Docker|隔离/);
    // 直接 start 路径（不经过 Chat 模型）：项目应继承 Docker/模型绑定并关联实验。
    const started = await request(base, 'POST', `/api/conversations/${conv.id}/start`, { brief: { goal: '验证关联', acceptance: ['A1', 'A2'] } });
    assert.equal(started.status, 200, started.text);
    const project = store.getProject(started.json.data.project.id);
    assert.equal(project.config_json.agent_isolation, 'docker');
    assert.equal(project.config_json.test_isolation, 'docker');
    assert.equal(project.agent_kind, 'claude');
    assert.equal(project.audit_provider, 'dsh');
    assert.equal(store.getExperimentContract(exp.id).project_id, project.id, '实验必须绑定 Project ID');
    await new Promise((r) => setTimeout(r, 50));
    const loop = store.listLoops({ projectId: project.id })[0];
    assert.ok(loop);
    assert.notEqual(loop.status, 'completed');
    assert.equal(fake.state.calls, 0, '启动失败也必须发生在模型调用前');
  } finally {
    await new Promise((r) => server.close(r)); store.close(); await new Promise((r) => fake.server.close(r)); fs.rmSync(root, { recursive: true, force: true });
  }
});
