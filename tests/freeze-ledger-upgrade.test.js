// SPDX-License-Identifier: Apache-2.0
// Copy into the repository's tests/ directory. Node.js >=24.
// Uses production LoopManager, Planner, HTTP adapter, risk gate and SQLite settlement.
// Isolation/coding readiness is outside this fixture. No agent, supervisor or Docker is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
// WB_PRIOR_REPO must be a clean snapshot of dd68e7916e3aa6f4a72403dc400604e02170717e.
// 独立脚本用 git archive 生成 dd68 源码；普通 npm test 无该环境时用当前源码做同库幂等回归。
const previousRoot = process.env.WB_PRIOR_REPO || process.cwd();
const oldModule = filename => import(pathToFileURL(path.join(previousRoot, 'src', filename)).href);
const { getConfig } = await oldModule('config.js');
import { openStore } from '../src/db.js';
const { openStore: createPreviousStore } = await oldModule('db.js');
const { EventBus } = await oldModule('bus.js');
const { LoopManager } = await oldModule('loop.js');
import { budgetSnapshot } from '../src/budget.js';

const projectId = 'isolated-planner-project';
const model = 'offline-ledger-model';
const binding = { client: 'openai', provider: 'openai', model };

function createContract(store, consent) {
  const unbounded = consent ? [{
    ...binding, role: 'planner', acceptedBy: 'offline-fixture',
    acceptedAt: new Date().toISOString(), reason: 'Only loopback test traffic',
  }] : [];
  return store.createExperimentContract({
    projectId, authorizedBy: 'offline-fixture', authorizationSource: 'user_chat_approval',
    authorizationText: 'Synthetic contract in temporary SQLite, local HTTP stub only',
    tokenLimit: 100000, costLimitCny: 10, stopLossCny: 9, callLimit: 2,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    perCallMaxTokens: 10000, nonGlmCostLimitCny: 10, isolationMode: 'DOCKER_REQUIRED',
    provider: {
      chat: binding, planner: binding,
      coding: { client: 'claude', provider: 'glm', model: 'glm-fixture' },
      audit: { client: 'dsh', provider: 'deepseek', model: 'audit-fixture' },
      risk: { unbounded },
    },
  });
}

async function runOne(t, { usage, consent = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-handoff-billing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sent = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent.push({ path: req.url, model: JSON.parse(Buffer.concat(chunks).toString()).model });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"action":"no_task","rationale":"done"}' } }],
      usage,
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(new URL(url).origin, origin, 'fixture accepts only its own local HTTP destination');
    return originalFetch(url, options);
  });

  // getConfig creates directories before applying overrides. Use temporary paths from the outset.
  const env = { WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let config;
  try {
    Object.assign(process.env, env);
    config = getConfig({
      llm: {
        openai: { apiKey: 'local-fixture', baseUrl: origin + '/v1', model },
        glm: { apiKey: '' }, deepseek: { apiKey: '' },
      },
      planner: { provider: 'openai', model, timeoutMs: 5000 },
      budget: { maxTotalTokens: 100000, maxCostCny: 10, minReserveTokens: 0 },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const store = createPreviousStore(config.paths.dbPath);
  t.after(() => store.close());
  store.createProject({ id: projectId, name: 'ledger fixture', localPath: root, defaultBranch: 'main' });
  const experiment = createContract(store, consent);
  const loopId = 'offline-loop';
  store.createLoop({ id: loopId, projectId, goal: 'finish', mode: 'plan', maxRounds: 2, status: 'running' });
  const loops = new LoopManager({
    config, store, bus: new EventBus(),
    orchestrator: {
      experimentIdForProject: id => store.getExperimentForProject(id)?.id,
      emit() {},
    },
  });
  await loops.tick(loopId);
  return { store, sent, config, experiment };
}


for (const [kind, usage] of [['known', {prompt_tokens:8,completion_tokens:5}], ['missing', undefined]]) {
  test(kind + ' on upgrade from dd68 and two database opens', async t => {
    const {store, sent, config, experiment} = await runOne(t, { usage });
    function snapshot(s) {
      return {total:s.usageTotals().tokens,budget:budgetSnapshot(s,config).budgetTokens,
        reserved:budgetSnapshot(s,config).reservedTokens,project:s.usageForProject(projectId).tokens,
        expTokens:s.experimentUsage(experiment.id).tokens,rows:s.listLlmUsage().map(r=>[r.source,r.usage_known])}; }
    const live=snapshot(store); store.close();
    const s1=openStore(config.paths.dbPath), reopened=snapshot(s1); s1.close();
    const s2=openStore(config.paths.dbPath), twice=snapshot(s2); s2.close();
    console.log(JSON.stringify({kind,sends:sent.length,live,reopened,twice}));
    assert.deepEqual(twice,live);
  });
}
