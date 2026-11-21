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
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { LoopManager } from '../src/loop.js';
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
  const store = openStore(config.paths.dbPath);
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

test('one Planner receipt with 8 input + 5 output adds exactly 13 to global, project and experiment totals', async t => {
  const { store, sent, config, experiment } = await runOne(t, { usage: { prompt_tokens: 8, completion_tokens: 5 } });
  assert.deepEqual(sent, [{ path: '/v1/chat/completions', model }], 'count requests at the endpoint');
  const reservations = store.listModelReservations();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, 'settled');
  const totals = {
    reservation: reservations[0].actual_tokens,
    experiment: store.experimentUsage(experiment.id).tokens,
    project: store.usageForProject(projectId).tokens,
    global: store.usageTotals().tokens,
    budget: budgetSnapshot(store, config).budgetTokens,
  };
  assert.deepEqual(totals, { reservation: 13, experiment: 13, project: 13, global: 13, budget: 13 });
});

test('Planner with missing usage keeps the original reservation unknown and retains a nonzero budget hold', async t => {
  const { store, sent, config, experiment } = await runOne(t, {});
  assert.equal(sent.length, 1);
  const reservations = store.listModelReservations();
  assert.equal(reservations.length, 1);
  const reservation = reservations[0];
  assert.equal(reservation.status, 'unknown');
  assert.equal(reservation.usage_known, 0);
  assert.ok(reservation.request_key && reservation.estimated_tokens > 0);
  assert.equal(store.experimentUsage(experiment.id).calls, 1);
  assert.equal(budgetSnapshot(store, config).reservedTokens, reservation.estimated_tokens);
});

test('Planner without matching risk consent sends zero HTTP requests', async t => {
  const { store, sent, experiment } = await runOne(t, { consent: false });
  assert.equal(sent.length, 0);
  assert.equal(store.experimentUsage(experiment.id).calls, 0);
  assert.equal(store.usageTotals().tokens, 0);
});
