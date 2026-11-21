// SPDX-License-Identifier: Apache-2.0
/** v3.8：缺失 usage 与明确零 usage 必须区分；业务有效但 usage 缺失时保留 UNKNOWN。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { complete, completeJson } from '../src/llm.js';
import { recordModelUsage, assertModelBudget } from '../src/budget.js';

async function serverWith(body) {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}
function config(root, port) { return getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 't.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(root, 'w'), artifactsDir: path.join(root, 'a'), logsDir: path.join(root, 'l'), agentsDir: path.join(root, 'ag'), dshHome: path.join(root, 'ag/dsh'), claudeHome: path.join(root, 'ag/claude') }, llm: { openai: { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake' }, glm: { apiKey: '', baseUrl: '', model: '' }, deepseek: { apiKey: '', baseUrl: '', model: '' } } }); }
const content = { choices: [{ message: { role: 'assistant', content: '{"reply":"ok","goal":"g","acceptance":["a"]}' } }] };

test('v38 usage：缺失 usage → usageKnown=false；明确零 usage → true', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v38-usage-'));
  const a = await serverWith(content);
  const b = await serverWith({ ...content, usage: { prompt_tokens: 0, completion_tokens: 0 } });
  try {
    const ca = config(path.join(root, 'a'), a.port); const cb = config(path.join(root, 'b'), b.port);
    const r1 = await completeJson({ config: ca, provider: 'openai', model: 'fake', messages: [{ role: 'user', content: 'x' }] });
    const r2 = await completeJson({ config: cb, provider: 'openai', model: 'fake', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r1.usageKnown, false); assert.equal(r2.usageKnown, true);
    const store = openStore(ca.paths.dbPath);
    try {
      const row = recordModelUsage({ store, config: ca, source: 'planner', sourceId: 'missing-usage', provider: 'openai', model: 'fake', usage: r1.usage, usageKnown: r1.usageKnown, costCny: 0, costSource: 'unknown' });
      assert.equal(Number(row.usage_known), 0);
      assert.equal(row.cost_source, 'unknown');
    } finally { store.close(); }
    const known = await complete({ config: cb, provider: 'openai', model: 'fake', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(known.usageKnown, true);
  } finally { a.srv.close(); b.srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('v38 usage：8+5 已知；null/部分字段保持 UNKNOWN；明确 0+0 已知', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v38-usage2-'));
  const bodies = [
    { name: 'full', body: { ...content, usage: { prompt_tokens: 8, completion_tokens: 5 } }, known: true, total: 13 },
    { name: 'null', body: { ...content, usage: { prompt_tokens: null, completion_tokens: null } }, known: false, total: 0 },
    { name: 'partial', body: { ...content, usage: { prompt_tokens: 8 } }, known: false, total: 8 },
    { name: 'zero', body: { ...content, usage: { prompt_tokens: 0, completion_tokens: 0 } }, known: true, total: 0 },
  ];
  const servers = [];
  try {
    for (const b of bodies) {
      const s = await serverWith(b.body); servers.push(s);
      const r = await completeJson({ config: config(path.join(root, b.name), s.port), provider: 'openai', model: 'fake', messages: [{ role: 'user', content: 'x' }] });
      assert.equal(r.usageKnown, b.known, b.name);
      assert.equal(r.usage.input + r.usage.output, b.total, b.name);
    }
  } finally { for (const s of servers) s.srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
