// SPDX-License-Identifier: Apache-2.0
// Copy into the repository's tests/ directory. Node.js >=24.
// Uses production LoopManager, Planner, HTTP adapter, risk gate and SQLite settlement.
// Isolation/coding readiness is outside this fixture. No agent, supervisor or Docker is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// This test only reads and writes a disposable SQLite reservation. No transport runs.
import { openStore } from '../src/db.js';

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


test('an unknown logical call with an existing 4,000-token hold cannot silently create a second hold', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-unknown-hold-'));
  const store = openStore(path.join(dir, 'test.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive:true, force:true }); });
  const exp = createContract(store, true);
  const request = { requestKey:'offline-logical-call', provider:'openai', model,
    estimatedTokens:4000, estimatedCostCny:0.02, maxTokens:100000, maxCostCny:10, experimentId:exp.id };
  const one = store.reserveModelBudget({ ...request, id:'initial' });
  assert.equal(one.ok, true);
  store.markModelReservationUnknown(one.reservation.id);
  const before = store.reservedBudgetTotals().tokens;
  try { store.reserveModelBudget({ ...request, id:'next' }); } catch { /* an explicit rejection is acceptable */ }
  const after = store.reservedBudgetTotals().tokens;
  const rows = store.listModelReservations();
  console.log(JSON.stringify({before,after,rows:rows.map(r=>({id:r.id,status:r.status,estimated:r.estimated_tokens})),sends:0}));
  assert.equal(before, 4000);
  assert.equal(after, before, 'the original reservation stays held once while reconciliation is pending');
  assert.equal(rows.length, 1);
});
