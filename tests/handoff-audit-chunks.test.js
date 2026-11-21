// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../src/db.js';
import { getConfig } from '../src/config.js';
import { runAudit } from '../src/auditors/index.js';

const criterion = 'Each supplied add function must add both inputs.';
const model = 'fixture-audit';
const identity = { client: 'openai', provider: 'openai', model };

const cases = [
  { label: 'one complete chunk', ops: ['+'], expected: 'PASS' },
  { label: 'two complete passing chunks', ops: ['+', '+'], expected: 'PASS' },
  { label: 'a failure reported only in the later chunk', ops: ['+', '-'], expected: 'FAIL' },
  { label: 'neither chunk supplies evidence', ops: ['?', '?'], expected: 'UNKNOWN' },
];

for (const { label, ops, expected } of cases) {
  test('formal runAudit aggregates ' + label, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'wb-handoff-audit-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const calls = [];
    const blocks = ops.map((op, i) => {
      const name = 'part' + i + '.js';
      const expression = op === '?' ? 'opaque(a,b)' : 'a' + op + 'b';
      const line = '+export const add = (a,b) => ' + expression + ';';
      const diff = ['diff --git a/' + name + ' b/' + name, '@@ -0,0 +1 @@', line, ''].join('\n');
      return { op, name, line, diff };
    });

    const server = http.createServer(async (req, res) => {
      try {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const request = JSON.parse(Buffer.concat(buffers).toString());
        const prompt = request.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
        const visible = blocks.filter((b) => prompt.includes(b.diff.trimEnd()));
        if (req.url !== '/v1/chat/completions' || request.model !== model ||
            !prompt.includes(criterion) || visible.length !== 1) {
          res.writeHead(400).end('unexpected audit request');
          return;
        }
        const { name, op, line } = visible[0];
        calls.push(name);
        const status = { '+': 'pass', '-': 'fail', '?': 'unproven' }[op];
        const evidence = name + ':1 ' + line.slice(1);
        const report = {
          criteria: [{ criterion, status, evidence }],
          findings: [], required_fixes: [], summary: 'Reviewed ' + name,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(report) } }],
          usage: { prompt_tokens: 7, completion_tokens: 6 },
        }));
      } catch (err) {
        res.writeHead(400).end(String(err));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));

    // getConfig creates directories while building defaults. Use the fixture root even there.
    const mockEnv = (key, value) => {
      const before = process.env[key];
      process.env[key] = value;
      t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    };
    mockEnv('WORKBENCH_ROOT', root);
    mockEnv('WORKBENCH_DATA_DIR', path.join(root, 'data'));
    mockEnv('WORKBENCH_PROJECTS_DIR', path.join(root, 'projects'));
    const config = getConfig({
      llm: {
        openai: { apiKey: 'fixture-only', model, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' },
        deepseek: { apiKey: '' }, glm: { apiKey: '' },
      },
      audit: { provider: 'openai', requireIndependent: true, allowSameFamily: false,
        maxDiffChars: 100, maxChunks: 2, maxTokens: 1000, timeoutMs: 5000, resourceEstimateTokens: 100 },
    });
    const store = openStore(config.paths.dbPath);
    t.after(() => store.close());
    const experiment = store.createExperimentContract({
      projectId: 'fixture', authorizedBy: 'fixture', authorizationSource: 'user_chat_approval',
      authorizationText: 'Synthetic fixture restricted to loopback', tokenLimit: 100000,
      costLimitCny: 10, stopLossCny: 9, callLimit: 3, perCallMaxTokens: 20000,
      deadlineAt: new Date(Date.now() + 3600_000).toISOString(), nonGlmCostLimitCny: 10,
      provider: {
        chat: identity, planner: identity, audit: identity,
        coding: { client: 'claude', provider: 'glm', model: 'fixture-coder' },
        risk: { unbounded: [{ ...identity, role: 'audit', acceptedBy: 'fixture',
          acceptedAt: new Date().toISOString(), reason: 'Loopback-only synthetic test' }] },
      }, isolationMode: 'DOCKER_REQUIRED',
    });
    const result = await runAudit({
      config, project: { id: 'fixture', name: 'fixture', audit_provider: 'openai', local_path: root },
      task: { id: 'fixture-task', title: 'Verify additions', acceptance_json: [criterion], agent_kind: 'claude' },
      diff: blocks.map((b) => b.diff).join(''), diffStat: '', coderFamily: 'glm',
      worktree: root, versionInfo: { worktreeHash: 'fixture-tree', testedHash: 'fixture-tree' },
      budget: { config, store, ...identity, estimatedTokens: 100, experimentId: experiment.id,
        experimentScope: 'global', requestKey: 'fixture-audit' },
    });
    assert.deepEqual([...calls].sort(), blocks.map((b) => b.name).sort());
    assert.equal(store.experimentUsage(experiment.id).calls, blocks.length);
    assert.equal(result.status, expected, 'final verdict for ' + label);
    if (expected === 'UNKNOWN') return;
    const item = result.criteria.find((c) => c.criterion === criterion && c.status === expected.toLowerCase());
    assert.ok(item, 'final criteria must preserve the decisive result');
    if (expected === 'FAIL') assert.match(item.evidence, /part1\.js/);
  });
}
