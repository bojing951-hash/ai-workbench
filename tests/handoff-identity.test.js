// SPDX-License-Identifier: Apache-2.0
// Three offline comparisons across the same Planner budget gate and HTTP client.
// The independent coding/isolation gates are outside this test. Its contract and DB are temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { LoopManager } from '../src/loop.js';

const model = 'deepseek-chat';
const roleBinding = { client: 'deepseek', provider: 'deepseek', model };

async function observePlanner(t, { duplicateModelSetting, hasPermission }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'offline fixture'], { cwd: root });

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push(JSON.parse(Buffer.concat(body).toString()).model);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model,
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'blocked', blocked_reason: 'offline fixture received' }) } }],
      usage: { prompt_tokens: 8, completion_tokens: 5 },
    }));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // buildConfig creates default directories before applying path overrides.
  // Pin the builder's environment too, even when run from an operator's checkout.
  const env = { WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'd'), WORKBENCH_PROJECTS_DIR: path.join(root, 'p'), PLANNER_MODEL: model };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let config;
  try {
    Object.assign(process.env, env);
    config = getConfig({
      planner: { provider: 'deepseek', timeoutMs: 3000, ...(duplicateModelSetting ? { model } : {}) },
      llm: {
        deepseek: { model, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'offline-fixture' },
        openai: { apiKey: '', baseUrl: '', model: '' }, glm: { apiKey: '', baseUrl: '', model: '' },
      },
      budget: { maxTotalTokens: 100_000, maxCostCny: 10, minReserveTokens: 0 },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const store = openStore(config.paths.dbPath);
  t.after(() => store.close());
  const projectId = 'identity-fixture';
  store.createProject({ id: projectId, name: projectId, localPath: root, defaultBranch: 'main' });
  const contract = store.createExperimentContract({
    projectId, authorizedBy: 'offline-fixture', authorizationSource: 'user_chat_approval', authorizationText: 'Synthetic contract for local transport in an isolated temporary DB.',
    tokenLimit: 50_000, costLimitCny: 5, stopLossCny: 4, callLimit: 1, perCallMaxTokens: 12_000, nonGlmCostLimitCny: 4,
    deadlineAt: new Date(Date.now() + 3600_000).toISOString(), isolationMode: 'DOCKER_REQUIRED',
    provider: {
      planner: roleBinding, chat: roleBinding, coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' },
      risk: { unbounded: [{ ...roleBinding, role: hasPermission ? 'planner' : 'chat', reason: 'Loopback fixture only', acceptedBy: 'offline-fixture', acceptedAt: new Date().toISOString() }] },
    },
  });
  assert.ok(store.verifyExperimentContractHash(contract.id));
  store.createLoop({ id: 'loop-id', projectId, goal: 'Exercise the regular Planner request', mode: 'plan', maxRounds: 2, status: 'running' });
  const loops = new LoopManager({ config, store, bus: new EventBus(), orchestrator: {
    experimentIdForProject: id => store.getExperimentForProject(id)?.id || '',
    emit() {},
  } });
  await loops.tick('loop-id');
  return { requests, reason: store.getLoop('loop-id').stop_reason };
}

for (const scenario of [
  { title: 'explicit Planner model and exact consent reach that model once', duplicateModelSetting: true, hasPermission: true },
  { title: 'default Planner slot and exact consent reach that model once', duplicateModelSetting: false, hasPermission: true },
  { title: 'Chat-only consent does not dispatch Planner', duplicateModelSetting: true, hasPermission: false },
]) {
  test('Paid identity / ' + scenario.title, async t => {
    const { requests, reason } = await observePlanner(t, scenario);
    assert.deepEqual(requests, scenario.hasPermission ? [model] : [], reason);
  });
}
