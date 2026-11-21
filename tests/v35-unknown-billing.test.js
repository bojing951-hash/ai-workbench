// SPDX-License-Identifier: Apache-2.0
/** v3.7 P1：供应商已收到请求但响应前进程退出，reservation/请求键必须保留且不得自动重发。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';

test('v37 UNKNOWN：请求已到达后 SIGKILL，原 reservation/键保留，恢复新增发送为 0', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v37-unknown-'));
  let received = 0;
  let release;
  const server = http.createServer((req, res) => { received += 1; req.resume(); /* 故意不响应 */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 't.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'w'), artifactsDir: path.join(root, 'a'), logsDir: path.join(root, 'l'), agentsDir: path.join(root, 'ag'), dshHome: path.join(root, 'ag/dsh'), claudeHome: path.join(root, 'ag/claude') }, llm: { openai: { apiKey: 'fake-key', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake' }, glm: { apiKey: '', baseUrl: '', model: '' }, deepseek: { apiKey: '', baseUrl: '', model: '' } }, budget: { maxTotalTokens: 1_000_000, maxCostCny: 100, minReserveTokens: 0 } });
    const store = openStore(config.paths.dbPath);
    const exp = store.createExperimentContract({ projectId: 'p-unknown', authorizedBy: 'test', authorizationSource: 'user_chat_approval', authorizationText: 'zero-paid unknown test', tokenLimit: 100000, costLimitCny: 10, stopLossCny: 9, callLimit: 3, deadlineAt: new Date(Date.now() + 3600_000).toISOString(), glmTokenLimit: 0, glmCostLimitCny: 0, dshTokenLimit: 0, dshCostLimitCny: 0, nonGlmCostLimitCny: 10, perCallMaxTokens: 20000, provider: { chat: { client: 'openai', provider: 'openai', model: 'fake' }, planner: { client: 'openai', provider: 'openai', model: 'fake' }, coding: { client: 'claude', provider: 'glm', model: 'glm-5.3' }, audit: { client: 'dsh', provider: 'deepseek', model: 'deepseek' }, risk: { unbounded: [{ role: 'chat', client: 'openai', provider: 'openai', model: 'fake', acceptedBy: 'user', acceptedAt: new Date().toISOString(), reason: 'explicit unknown billing risk' }] } }, isolationMode: 'DOCKER_REQUIRED' });
    store.close();
    const dbUrl = new URL('../src/db.js', import.meta.url).href;
    const code = `import { openStore } from ${JSON.stringify(dbUrl)}; const s=openStore(process.argv[1]); const r=s.reserveModelBudget({id:'unknown-res',requestKey:'unknown-key',provider:'openai',model:'fake',estimatedTokens:1000,estimatedCostCny:0.01,maxTokens:1000000,maxCostCny:100,experimentId:process.argv[2],experimentScope:'global'}); if(!r.ok) process.exit(2); process.stdout.write('reserved\\n'); fetch(process.argv[3],{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{}); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', code, config.paths.dbPath, exp.id, `http://127.0.0.1:${port}/v1/chat/completions`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve, reject) => { let out = ''; child.stdout.on('data', (d) => { out += String(d); if (out.includes('reserved')) resolve(); }); child.on('error', reject); setTimeout(() => reject(new Error('child reserve timeout')), 5000); });
      const end = Date.now() + 5000; while (received === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.equal(received, 1);
      child.kill('SIGKILL'); await new Promise((r) => child.on('close', r));
      const reopened = openStore(config.paths.dbPath);
      try {
        const row = reopened.listModelReservations().find((x) => x.id === 'unknown-res');
        assert.equal(row.status, 'reserved');
        assert.equal(row.request_key, 'unknown-key');
        assert.equal(reopened.experimentUsage(exp.id).calls, 1);
        // 没有新的发送入口被调用；服务端计数保持 1。
        assert.equal(received, 1);
        // 恢复只允许标记 UNKNOWN，不能自动清零或删除。
        reopened.markModelReservationUnknown('unknown-res');
        assert.equal(reopened.listModelReservations().find((x) => x.id === 'unknown-res').status, 'unknown');
        assert.ok(reopened.reservedBudgetTotals().tokens >= 1000);
      } finally { reopened.close(); }
    } finally { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
