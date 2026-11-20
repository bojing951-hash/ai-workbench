// SPDX-License-Identifier: Apache-2.0
/** 正式 REST+Supervisor：无任务终态但质量门缺证 → 零远端写入、Loop blocked。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const NODE = process.execPath; const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.LOOP_QUALITY_EVIDENCE_DIR || 'demo/evidence/loop-quality-gate');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-loop-quality-'));
const worktree = path.join(root, 'product'); const bare = path.join(root, 'github.com', 'fixture', 'repo.git');
fs.mkdirSync(worktree, { recursive: true }); fs.mkdirSync(path.dirname(bare), { recursive: true });
const git = (args, cwd = worktree) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(worktree, 'README.md'), '# q\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
spawnSync('git', ['init', '--bare', '-q', bare]); git(['remote', 'add', 'origin', bare]);
let prCreates = 0;
const ghApi = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const u = new URL(req.url, 'http://x'); const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/repos/fixture/repo') return send(200, { default_branch: 'main' });
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'GET') return send(200, []);
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'POST') { prCreates += 1; return send(201, { number: 1 }); }
  return send(404, { message: 'not found' });
});
await new Promise((r) => ghApi.listen(0, '127.0.0.1', r));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 300)); } return false; }
async function api(port, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': 'loop-quality-token', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
for (const f of ['bin', 'src', 'web', 'package.json']) fs.symlinkSync(path.join(REPO, f), path.join(root, f));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const port = await freePort();
const env = { ...process.env, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: 'loop-quality-token', WORKBENCH_HOST: '127.0.0.1', WORKBENCH_PORT: String(port), GITHUB_TOKEN: 'fixture-token', GITHUB_API_BASE: `http://127.0.0.1:${ghApi.address().port}`, GITHUB_PUSH: 'true', GITHUB_CREATE_PR: 'true', GITHUB_AUTO_CREATE_REPO: 'false', POLICY_AUTO_PUSH: 'true', MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100', MAX_TOKENS_PER_TASK: '600000' };
const sup = spawn(NODE, [path.join(REPO, 'supervisor/workbench-supervisor.mjs'), '--root', root, '--port', String(port), '--max-restarts', '2'], { cwd: root, env, stdio: ['ignore', fs.openSync(path.join(root, 'sup.log'), 'a'), fs.openSync(path.join(root, 'sup.log'), 'a')] });
try {
  assert.ok(await waitHealth(port), fs.readFileSync(path.join(root, 'sup.log'), 'utf8'));
  const reg = await api(port, 'POST', '/api/projects', { name: 'quality-gate', repo: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', ciRequired: true, remotePushAuthorized: true, publish: true, quality: { requirements: [{ id: 'R1', title: '质量条款', required: true }], quality_command: 'true', require_clause_evidence: true } });
  assert.equal(reg.status, 201, JSON.stringify(reg)); const projectId = reg.data.data.id;
  const loop = await api(port, 'POST', `/api/projects/${projectId}/loops`, { goal: 'no task quality gate', mode: 'queue', maxRounds: 1, queue: [] });
  assert.equal(loop.status, 201, JSON.stringify(loop)); const loopId = loop.data.data.id;
  const end = Date.now() + 60_000; let snap;
  while (Date.now() < end) { snap = (await api(port, 'GET', `/api/loops/${loopId}`)).data.data; if (['blocked', 'paused', 'completed', 'cancelled'].includes(snap.status)) break; await new Promise((r) => setTimeout(r, 300)); }
  assert.equal(snap.status, 'blocked', JSON.stringify(snap));
  assert.equal(prCreates, 0, '质量门缺证不得创建 Draft');
  const branches = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/wb/'], { cwd: bare, encoding: 'utf8' }).stdout.trim();
  assert.equal(branches, '', '质量门缺证不得推送发布分支');
  const evidence = { kind: 'loop-quality-gate-zero-publish', candidateSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(), projectId, loopId, loopStatus: snap.status, stopReason: snap.stop_reason, prCreates, bareBranches: branches, at: new Date().toISOString() };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), loopStatus: snap.status, prCreates }));
} finally { try { sup.kill('SIGKILL'); } catch { /* ignore */ } try { const s = JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor/state.json'), 'utf8')); if (s.childPid) process.kill(s.childPid, 'SIGKILL'); } catch { /* ignore */ } ghApi.close(); }
