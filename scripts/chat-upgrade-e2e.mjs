// SPDX-License-Identifier: Apache-2.0
/** fc5fbce 正式 HTTP 旧库 → 当前版本升级的 Chat 四步发送回归（零付费本地 GLM 替身）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { openStore } from '../src/db.js';
import { getConfig } from '../src/config.js';

const NODE = process.execPath;
const REPO = process.cwd();
const OLD_SHA = 'fc5fbce19bad7542170b39f063317d9281b5eb03';
const EVIDENCE_DIR = path.resolve(process.env.CHAT_EVIDENCE_DIR || 'demo/evidence/chat-upgrade');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await sleep(200); } return false; }
async function api(port, token, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-upgrade-'));
const oldTree = path.join(root, 'old-code');
fs.mkdirSync(oldTree, { recursive: true });
let arc = spawnSync('git', ['archive', OLD_SHA], { cwd: REPO, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
if (arc.status !== 0) {
  spawnSync('git', ['fetch', '--depth=1', 'origin', OLD_SHA], { cwd: REPO, stdio: 'inherit' });
  arc = spawnSync('git', ['archive', OLD_SHA], { cwd: REPO, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}
assert.equal(arc.status, 0, String(arc.stderr || '').slice(0, 500));
const tar = spawnSync('tar', ['-x', '-C', oldTree], { input: arc.stdout });
assert.equal(tar.status, 0, String(tar.stderr || ''));
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
let requests = 0; let failMode = true;
const mock = http.createServer((req, res) => {
  req.resume();
  requests += 1;
  if (failMode) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture GLM 400 before upgrade' } })); return; }
  const content = JSON.stringify({ reply: '本地替身回复', productName: '', goal: '', acceptance: [], readyToStart: false });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ content: [{ type: 'text', text: content }], usage: { input_tokens: 8, output_tokens: 5 } }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;
const token = 'chat-upgrade-token';
function serverEnv(port) {
  return { ...process.env, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: token, WORKBENCH_HOST: '127.0.0.1', WORKBENCH_PORT: String(port), GLM_API_KEY: 'fixture-glm', GLM_BASE_URL: mockBase, GLM_AUDIT_MODEL: 'glm-5.3', PLANNER_PROVIDER: 'glm', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false', MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100', MAX_TOKENS_PER_TASK: '600000' };
}
function startServer(codeRoot, port, tag) {
  const log = path.join(root, `server-${tag}.log`);
  const out = fs.openSync(log, 'a');
  const proc = spawn(NODE, [path.join(codeRoot, 'bin/workbench.js'), 'serve'], { cwd: codeRoot, env: serverEnv(port), stdio: ['ignore', out, out] });
  return { proc, log };
}
let oldSrv; let newSrv;
try {
  const p1 = await freePort();
  oldSrv = startServer(oldTree, p1, 'old');
  assert.ok(await waitHealth(p1), fs.readFileSync(oldSrv.log, 'utf8'));
  const conv = await api(p1, token, 'POST', '/api/conversations', { title: 'upgrade fixture' });
  assert.equal(conv.status, 201, JSON.stringify(conv));
  const convId = conv.data.data.conversation.id;
  const first = await api(p1, token, 'POST', `/api/conversations/${convId}/messages`, { content: '请回复一句', clientMessageId: 'upgrade-msg-1' });
  assert.equal(first.status, 400, JSON.stringify(first));
  assert.equal(requests, 1, 'old first attempt must be one physical send');
  oldSrv.proc.kill('SIGKILL'); await sleep(500);

  const p2 = await freePort();
  newSrv = startServer(REPO, p2, 'new');
  assert.ok(await waitHealth(p2), fs.readFileSync(newSrv.log, 'utf8'));
  const dbPath = path.join(root, 'data/workbench.db');
  const store = openStore(dbPath);
  const convs = store.listConversations(5);
  const user = store.listConversationMessages(convs[0].id).find((m) => m.role === 'user');
  assert.ok(user, 'old user message must survive upgrade');
  const failures = store.listLlmUsage().filter((x) => x.source === 'chat' && String(x.source_id).startsWith('chatfail:'));
  assert.ok(failures.length >= 1, 'old chatfail usage must be preserved');
  assert.equal(Number(failures[0].usage_known), 0, 'old UNKNOWN must remain UNKNOWN');
  const reservationsBefore = store.listModelReservations().length;
  const permits = store.db.prepare('SELECT key FROM chat_sends').all();
  assert.ok(permits.length >= 1, 'legacy failed send must migrate to consumed permit');
  store.close();

  failMode = false;
  const replay = await api(p2, token, 'POST', `/api/conversations/${convId}/messages`, { content: '请回复一句', clientMessageId: 'upgrade-msg-1' });
  assert.notEqual(replay.status, 200, JSON.stringify(replay));
  assert.equal(requests, 1, 'ordinary replay after upgrade must send zero');
  const retry = await api(p2, token, 'POST', `/api/conversations/${convId}/messages`, { content: '请回复一句', clientMessageId: 'upgrade-msg-1', retryAuthorized: true });
  assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.equal(requests, 2, 'explicit new permission must send exactly one');
  const sameGrant = await api(p2, token, 'POST', `/api/conversations/${convId}/messages`, { content: '请回复一句', clientMessageId: 'upgrade-msg-1', retryAuthorized: true });
  // 成功回复已存在时服务端直接幂等返回，不产生物理发送；这里只以发送计数为断言。
  assert.ok([200, 400, 409].includes(sameGrant.status), JSON.stringify(sameGrant));
  assert.equal(requests, 2, 'reusing the same permission must send zero');
  const store2 = openStore(dbPath);
  const reservationsAfter = store2.listModelReservations().length;
  const unknownRows = store2.listLlmUsage().filter((x) => Number(x.usage_known) === 0);
  store2.close();
  assert.equal(reservationsAfter, reservationsBefore, 'upgrade replay must not add reservations');
  assert.ok(unknownRows.length >= 1, 'historical UNKNOWN row must remain');
  const evidence = { kind: 'chat-upgrade-four-step', candidateSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(), oldSha: OLD_SHA, conversationId: convId, messageId: user.id, physicalSends: { initialOld: 1, ordinaryReplayAfterUpgrade: 0, explicitNewPermission: 1, samePermissionReplay: 0 }, increments: [1, 0, 1, 0], requestsTotal: requests, legacyUnknownPreserved: failures[0].usage_known, chatSendPermits: permits.map((x) => x.key), reservationsBefore, reservationsAfter, at: new Date().toISOString() };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), increments: evidence.increments, requestsTotal: requests, legacyUnknownPreserved: failures[0].usage_known }));
} finally {
  try { oldSrv?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { newSrv?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  mock.close();
}
