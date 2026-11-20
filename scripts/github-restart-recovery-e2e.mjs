// SPDX-License-Identifier: Apache-2.0
/** 真实 Supervisor/Workbench 重启后，从 SQLite 持久化动作认领已创建但响应丢失的 Draft。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';

const NODE = process.execPath;
const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.GH_RESTART_EVIDENCE_DIR || 'demo/evidence/github-restart-recovery');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-gh-restart-'));
const worktree = path.join(root, 'wt');
const bare = path.join(root, 'github.com', 'fixture', 'repo.git');
fs.mkdirSync(worktree, { recursive: true }); fs.mkdirSync(path.dirname(bare), { recursive: true });
const git = (args, cwd = worktree) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
spawnSync('git', ['init', '--bare', '-q', bare]);
git(['remote', 'add', 'origin', bare]);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'final\n'); git(['add', '-A']); git(['commit', '-qm', 'final']);
const planHead = git(['rev-parse', 'HEAD']);
const runId = 'run_restart00001'; const branch = `wb/plan-${runId.slice(-6)}`;
git(['branch', branch, planHead]); git(['push', '-q', 'origin', branch]);
let creates = 0; let pulls = 0;
const mock = http.createServer(async (req, res) => {
  req.resume(); for await (const _ of req) { /* drain */ }
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/repos/fixture/repo') return send(200, { default_branch: 'main' });
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'GET') { pulls += 1; return send(200, [{ number: 11, html_url: 'https://example.invalid/pr/11', state: 'open', draft: true, base: { ref: 'main' }, head: { ref: branch, sha: planHead } }]); }
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'POST') { creates += 1; return send(201, { number: 12, html_url: 'https://example.invalid/pr/12', state: 'open', draft: true }); }
  if (u.pathname === '/repos/fixture/repo/actions/runs') { const sha = u.searchParams.get('head_sha') || ''; return send(200, { workflow_runs: [{ id: 2, name: 'ci', status: 'completed', conclusion: 'success', head_sha: sha, html_url: 'https://example.invalid/ci/2' }] }); }
  return send(404, { message: 'not found' });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const envCommon = { ...process.env, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: 'restart-token', WORKBENCH_HOST: '127.0.0.1', GITHUB_TOKEN: 'fixture-token', GITHUB_API_BASE: `http://127.0.0.1:${mock.address().port}`, GITHUB_PUSH: 'true', GITHUB_CREATE_PR: 'true', GITHUB_AUTO_CREATE_REPO: 'false', POLICY_AUTO_PUSH: 'true', MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100', MAX_TOKENS_PER_TASK: '600000' };
for (const f of ['bin', 'src', 'web', 'package.json']) fs.symlinkSync(path.join(REPO, f), path.join(root, f));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data/workbench.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, github: { token: 'fixture-token', apiBase: `http://127.0.0.1:${mock.address().port}`, push: true, createPr: true, autoCreateRepo: false }, policy: { autoPush: true, ciPollAttempts: 1, ciPollIntervalMs: 10 } });
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 300)); } return false; }
async function api(port, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': 'restart-token', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
function startSup(port, tag) { const log = path.join(root, `supervisor-${tag}.log`); const out = fs.openSync(log, 'a'); const proc = spawn(NODE, [path.join(REPO, 'supervisor/workbench-supervisor.mjs'), '--root', root, '--port', String(port), '--max-restarts', '2'], { cwd: root, env: { ...envCommon, WORKBENCH_PORT: String(port) }, stdio: ['ignore', out, out] }); return { proc, log }; }
function killTree(proc) { let child = 0; try { child = Number(JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor/state.json'), 'utf8')).childPid || 0); } catch { /* ignore */ } try { proc.kill('SIGKILL'); } catch { /* ignore */ } if (child > 0) { try { process.kill(child, 'SIGKILL'); } catch { /* ignore */ } } return child; }

let A; let B;
try {
  const pA = await freePort(); A = startSup(pA, 'A'); assert.ok(await waitHealth(pA), fs.readFileSync(A.log, 'utf8'));
  // A 运行中写入“已创建 Draft 但响应丢失”的持久化状态，然后模拟进程崩溃。
  const store = openStore(config.paths.dbPath);
  const project = store.createProject({ id: 'proj_restart', name: 'restart', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: true, config: { publish: true } });
  const plan = store.createPlan({ id: 'plan_restart', projectId: project.id, runId, goal: 'restart', title: 'restart' });
  const run = store.createRun({ id: runId, projectId: project.id, planId: plan.id, goal: 'restart', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  store.updateRun(run.id, { verified_sha: planHead, result_json: { planHead, productAcceptance: 'PASS', productPlanHead: planHead } });
  store.createAction({ id: 'act_restart_pr', runId: run.id, type: 'github-pr', status: 'running', payload: { owner: 'fixture', repo: 'repo', head: branch, base: 'main', sha: planHead } });
  store.close();
  const childA = killTree(A.proc); await new Promise((r) => setTimeout(r, 600));
  const pB = await freePort(); B = startSup(pB, 'B');
  assert.ok(await waitHealth(pB, 120_000), fs.readFileSync(B.log, 'utf8'));
  const storeB = openStore(config.paths.dbPath);
  const action = storeB.getAction('act_restart_pr');
  const runB = storeB.getRun(run.id);
  assert.equal(action.status, 'done', '启动恢复必须认领原 Draft');
  assert.equal(action.result_json?.recovered, true);
  assert.equal(action.result_json?.sha, planHead);
  assert.equal(creates, 0, '真实重启认领不得重复创建 Draft');
  assert.equal(runB.verification_status, 'CI_PASSED');
  const accepted = await api(pB, 'POST', `/api/runs/${run.id}/accept`, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.data.data.status, 'accepted');
  assert.equal(accepted.data.data.result_json?.acceptedSha, planHead);
  storeB.close();
  const evidence = { kind: 'github-restart-recovery', candidateSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(), runId, planHead, branch, a: { supervisorLog: path.relative(EVIDENCE_DIR, A.log), childPid: childA }, b: { supervisorLog: path.relative(EVIDENCE_DIR, B.log) }, draft: { recovered: action.result_json?.recovered, number: action.result_json?.pr?.number, creates, pulls }, ci: { status: runB.verification_status, sha: runB.verified_sha }, accepted: { status: accepted.data.data.status, sha: accepted.data.data.result_json?.acceptedSha }, at: new Date().toISOString() };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), creates, acceptedSha: planHead, recovered: true }));
} finally { try { A?.proc.kill('SIGKILL'); } catch { /* ignore */ } try { B?.proc.kill('SIGKILL'); } catch { /* ignore */ } mock.close(); }
