// SPDX-License-Identifier: Apache-2.0
// Single-tick regression. The planner transport is local HTTP. Only the product
// auditor is a test double. Cross-run repair and delivery need a separate E2E.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../src/bus.js';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { LoopManager } from '../src/loop.js';
import { Orchestrator } from '../src/orchestrator.js';

const clause = 'product.txt must contain ready';
for (const scenario of ['ready', 'defect', 'unavailable', 'missing-head']) {
  test(`plan/no_task resolves a frozen product contract: ${scenario}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plan-gate-'));
    const repo = path.join(root, 'product');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    let server, store, loop;
    const oldRoot = process.env.WORKBENCH_ROOT;
    process.env.WORKBENCH_ROOT = root;
    t.after(async () => {
      if (loop) for (const timer of loop.timers.values()) clearTimeout(timer);
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      store?.close();
      if (oldRoot === undefined) delete process.env.WORKBENCH_ROOT;
      else process.env.WORKBENCH_ROOT = oldRoot;
      fs.rmSync(root, { recursive: true, force: true });
    });

    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Offline acceptance');
    git('config', 'user.email', 'fixture@example.invalid');
    const commit = (value) => {
      fs.writeFileSync(path.join(repo, 'product.txt'), value + '\n');
      git('add', 'product.txt');
      git('-c', 'commit.gpgSign=false', 'commit', '-qm', value);
      return git('rev-parse', 'HEAD');
    };
    const base = commit('baseline');
    const head = commit(scenario === 'ready' ? 'ready' : 'defective');

    let plannerCalls = 0;
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        plannerCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'no_task', rationale: 'done' }) } }],
          usage: { prompt_tokens: 8, completion_tokens: 5 },
        }));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (input, init) => {
      const url = new URL(input?.url ?? input);
      assert.equal(url.origin, origin, 'all model traffic must stay on the fixture server');
      return nativeFetch(input, init);
    });
    const config = getConfig({
      root,
      paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: root, worktreesDir: dataDir, artifactsDir: dataDir, logsDir: dataDir, agentsDir: dataDir, dshHome: dataDir, claudeHome: dataDir },
      planner: { provider: 'openai', model: 'fixture' },
      llm: { openai: { apiKey: 'offline-only', model: 'fixture', baseUrl: origin + '/v1' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } },
      github: { token: '', createPr: false, push: false, autoCreateRepo: false },
      budget: { maxTotalTokens: 100_000, maxCostCny: 100, minReserveTokens: 0 },
    });
    store = openStore(config.paths.dbPath);
    const bus = new EventBus();
    let auditCalls = 0;
    const audit = async ({ diff }) => {
      auditCalls++;
      if (scenario === 'unavailable') throw Error('offline auditor unavailable');
      const good = diff.split('\n').includes('+ready');
      return {
        status: good ? 'PASS' : 'FAIL', verdict: good ? 'pass' : 'fail', provider: 'fixture', model: 'fixture',
        criteria: [{ criterion: clause, status: good ? 'pass' : 'fail', evidence: 'Checked the committed product.txt line against the acceptance requirement.' }],
      };
    };
    const orchestrator = new Orchestrator({ config, store, bus, deps: { runAudit: audit } });
    loop = new LoopManager({ config, store, bus, orchestrator });
    store.createProject({ id: 'product', name: 'product', localPath: repo, config: { test_plan: { acceptance: [clause] } } });
    // Omit mode so the public method selects the usual plan mode.
    const { id, mode } = await loop.create({ projectId: 'product', goal: clause, maxRounds: 3 });
    assert.equal(mode, 'plan');
    if (scenario !== 'missing-head') store.updateLoop(id, { history_json: [{ baseCommit: base, commit: head }] });
    // Drive the initial timer deterministically. Leave any subsequent timer set by tick intact.
    clearTimeout(loop.timers.get(id));
    loop.timers.delete(id);
    await loop.tick(id);
    const row = store.getLoop(id);
    const repairs = row.queue_json.filter(task => task.productAcceptanceRepair);
    const events = store.listEvents({ projectId: 'product' }).map(event => event.type);
    assert.equal(plannerCalls, 1);
    assert.equal(auditCalls, scenario === 'missing-head' ? 0 : 1);
    if (scenario === 'ready') {
      assert.equal(row.status, 'completed');
      assert.ok(events.includes('product_acceptance_passed'));
      assert.equal(repairs.length, 0);
    } else if (scenario === 'defect') {
      assert.equal(row.status, 'running', 'a confirmed defect with repair budget must continue');
      assert.equal(repairs.length, 1);
      assert.equal(repairs[0].productRepairOfPlanHead, head);
      assert.ok(loop.timers.has(id), 'a queued repair needs a scheduled next tick');
      assert.ok(!events.includes('loop_completed'));
    } else {
      assert.equal(row.status, 'blocked', 'missing commit or unavailable audit must block delivery');
      assert.equal(repairs.length, 0);
      assert.ok(!loop.timers.has(id));
      assert.ok(!events.includes('loop_completed'));
    }
  });
}
