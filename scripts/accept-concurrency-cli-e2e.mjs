// SPDX-License-Identifier: Apache-2.0
/** /accept 并发取消、父 Loop 取消、CLI 退出码与持久化验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';

const NODE = process.execPath; const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.ACCEPT_EVIDENCE_DIR || 'demo/evidence/accept-concurrency-cli');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-accept-'));
const worktree = path.join(root, 'wt'); fs.mkdirSync(worktree, { recursive: true });
const git = (args, cwd = worktree) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
const planHead = git(['rev-parse', 'HEAD']);
let pullStartedResolve = null; let releasePull = null; let pullStarted = Promise.resolve(); let delayNextPull = false; let ciConclusion = 'success';
const mock = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const u = new URL(req.url, 'http://x'); const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/repos/fixture/repo/pulls/31' && req.method === 'GET') {
    if (delayNextPull) { delayNextPull = false; pullStartedResolve(); await new Promise((r) => { releasePull = r; }); }
    return send(200, { number: 31, html_url: 'https://example.invalid/pr/31', state: 'open', draft: true, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref: 'wb/plan', sha: planHead, repo: { full_name: 'fixture/repo' } } });
  }
  if (u.pathname === '/repos/fixture/repo/actions/runs') return send(200, { workflow_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: ciConclusion, head_sha: planHead, html_url: 'https://example.invalid/ci/1' }] });
  if (u.pathname === '/repos/fixture/repo') return send(200, { default_branch: 'main' });
  return send(404, { message: 'not found' });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 300)); } return false; }
async function api(port, method, p) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': 'accept-token', 'content-type': 'application/json' } }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
const env = { ...process.env, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: 'accept-token', WORKBENCH_HOST: '127.0.0.1', GITHUB_TOKEN: 'fixture-token', GITHUB_API_BASE: `http://127.0.0.1:${mock.address().port}`, GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false', MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100' };
for (const f of ['bin', 'src', 'web', 'package.json']) fs.symlinkSync(path.join(REPO, f), path.join(root, f));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const config = getConfig({ paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data/workbench.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, github: { token: 'fixture-token', apiBase: `http://127.0.0.1:${mock.address().port}`, push: false, createPr: false, autoCreateRepo: false } });
const store = openStore(config.paths.dbPath);
const project = store.createProject({ id: 'proj_accept', name: 'accept', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: true, config: { publish: true } });
const plan = store.createPlan({ id: 'plan_accept', projectId: project.id, runId: 'seed', goal: 'accept', title: 'accept' });
const ciEvidence = { status: 'passed', conclusion: 'success', sha: planHead, requiredSha: planHead, mismatched: [], missingChecks: [], runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', headSha: planHead }] };
function seedRun(id, { loopId = '', verification = 'CI_PASSED', withPr = true } = {}) {
  const run = store.createRun({ id, projectId: project.id, planId: plan.id, goal: 'accept', status: 'awaiting_acceptance', verificationStatus: verification });
  store.updateRun(id, { verified_sha: planHead, result_json: { planHead, loopId, productAcceptance: loopId ? 'PASS' : undefined, productPlanHead: loopId ? planHead : undefined, ciEvidence: verification === 'CI_PASSED' ? ciEvidence : null } });
  if (withPr) { store.createAction({ id: 'pr_' + id, runId: id, type: 'github-pr', status: 'done', payload: { owner: 'fixture', repo: 'repo', head: 'wb/plan', base: 'main', sha: planHead }, result: { pr: { number: 31, url: 'https://example.invalid/pr/31', draft: true, head: 'wb/plan', base: 'main', sha: planHead }, sha: planHead } }); store.createAction({ id: 'ci_' + id, runId: id, type: 'github-ci', status: 'done', payload: { owner: 'fixture', repo: 'repo', sha: planHead }, result: { status: 'passed', conclusion: 'success', runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', headSha: planHead }], sha: planHead } }); }
  return run;
}
const port = await freePort();
const sup = spawn(NODE, [path.join(REPO, 'supervisor/workbench-supervisor.mjs'), '--root', root, '--port', String(port), '--max-restarts', '2'], { cwd: root, env: { ...env, WORKBENCH_PORT: String(port) }, stdio: ['ignore', fs.openSync(path.join(root, 'sup.log'), 'a'), fs.openSync(path.join(root, 'sup.log'), 'a')] });
const results = {};
try {
  assert.ok(await waitHealth(port), fs.readFileSync(path.join(root, 'sup.log'), 'utf8'));
  // 1) /accept 等待 Draft 详情期间取消 Run。
  const runCancel = 'run_accept_cancel'; seedRun(runCancel);
  delayNextPull = true; pullStarted = new Promise((r) => { pullStartedResolve = r; });
  const acceptPromise = fetch(`http://127.0.0.1:${port}/api/runs/${runCancel}/accept`, { method: 'POST', headers: { 'x-workbench-token': 'accept-token', 'content-type': 'application/json' }, body: '{}' });
  await pullStarted;
  const cancelRes = await api(port, 'POST', `/api/runs/${runCancel}/cancel`);
  assert.equal(cancelRes.status, 200, JSON.stringify(cancelRes));
  assert.equal(store.getRun(runCancel).status, 'cancelled');
  releasePull();
  const acceptHttp = await acceptPromise; const acceptStatus = acceptHttp.status; let acceptBody = null; try { acceptBody = await acceptHttp.json(); } catch { /* ignore */ }
  results.concurrentCancel = { cancelStatus: cancelRes.status, acceptStatus, acceptRejected: acceptStatus !== 200, body: acceptBody?.error?.code || null, finalRunStatus: store.getRun(runCancel).status, acceptedShaAbsent: store.getRun(runCancel).result_json?.acceptedSha === undefined, successEventCount: store.listEvents({ runId: runCancel }).filter((e) => e.type === 'run_accepted').length };
  assert.equal(store.getRun(runCancel).status, 'cancelled');
  assert.equal(store.getRun(runCancel).result_json?.acceptedSha, undefined);
  assert.ok(!store.listEvents({ runId: runCancel }).some((e) => e.type === 'run_accepted'));
  // 1b) /accept 等待 Draft 时正式 ci-refresh 写成 CI_FAILED，旧验收必须拒绝。
  const runCiFail = 'run_accept_cifail'; seedRun(runCiFail);
  ciConclusion = 'failure'; delayNextPull = true; pullStarted = new Promise((r) => { pullStartedResolve = r; });
  const acceptCiPromise = fetch(`http://127.0.0.1:${port}/api/runs/${runCiFail}/accept`, { method: 'POST', headers: { 'x-workbench-token': 'accept-token', 'content-type': 'application/json' }, body: '{}' });
  await pullStarted;
  const refresh = await api(port, 'POST', `/api/runs/${runCiFail}/ci-refresh`);
  assert.equal(refresh.status, 200, JSON.stringify(refresh));
  assert.equal(store.getRun(runCiFail).verification_status, 'CI_FAILED');
  releasePull();
  const acceptCiHttp = await acceptCiPromise; const acceptCiStatus = acceptCiHttp.status; let acceptCiBody = null; try { acceptCiBody = await acceptCiHttp.json(); } catch { /* ignore */ }
  assert.notEqual(acceptCiStatus, 200, JSON.stringify(acceptCiBody));
  const runCiFailNow = store.getRun(runCiFail);
  assert.equal(runCiFailNow.status, 'awaiting_acceptance');
  assert.equal(runCiFailNow.verification_status, 'CI_FAILED');
  assert.equal(runCiFailNow.result_json?.acceptedSha, undefined);
  assert.equal(store.listEvents({ runId: runCiFail }).filter((e) => e.type === 'run_accepted').length, 0);
  results.staleCiDuringAccept = { refreshStatus: refresh.status, acceptStatus: acceptCiStatus, acceptBody: acceptCiBody?.error?.code || null, finalStatus: runCiFailNow.status, verification: runCiFailNow.verification_status, acceptedShaAbsent: true, successEventCount: 0 };
  ciConclusion = 'success';
  // 2) 父 Loop 已取消 → 拒绝验收。
  const loop = store.createLoop({ id: 'loop_cancelled', projectId: project.id, goal: 'g', mode: 'queue', maxRounds: 1, queue: [], status: 'cancelled' });
  const runLoop = 'run_accept_loopcancelled'; seedRun(runLoop, { loopId: loop.id });
  const loopAcc = await api(port, 'POST', `/api/runs/${runLoop}/accept`);
  assert.notEqual(loopAcc.status, 200, JSON.stringify(loopAcc));
  assert.equal(store.getRun(runLoop).status, 'awaiting_acceptance'); results.loopCancelledRejected = true; results.loopCancelledRunStatus = store.getRun(runLoop).status;
  // 3) 正例：同 Draft 同 SHA，HTTP 验收成功。
  const runOk = 'run_accept_ok'; seedRun(runOk);
  const okAcc = await api(port, 'POST', `/api/runs/${runOk}/accept`);
  assert.equal(okAcc.status, 200, JSON.stringify(okAcc));
  assert.equal(store.getRun(runOk).status, 'accepted');
  assert.equal(store.getRun(runOk).result_json?.acceptedSha, planHead); results.httpPositive = 'accepted'; results.httpPositiveSha = store.getRun(runOk).result_json?.acceptedSha;
  // 4) CLI：不存在/不合格非零，正例 exit0 并持久化。
  const cliEnv = { ...env };
  const cli = (id) => spawnSync(NODE, [path.join(REPO, 'bin/workbench.js'), 'accept', id], { cwd: root, env: cliEnv, encoding: 'utf8', timeout: 120_000 });
  const cliMissing = cli('run_missing_cli');
  assert.notEqual(cliMissing.status, 0); assert.ok(!/已验收/.test(cliMissing.stdout));
  const runBad = 'run_accept_bad'; seedRun(runBad, { verification: 'LOCAL_VERIFIED' });
  const cliBad = cli(runBad); assert.notEqual(cliBad.status, 0); assert.ok(!/已验收/.test(cliBad.stdout));
  const runCli = 'run_accept_cli'; seedRun(runCli, { withPr: false });
  const cliOk = cli(runCli);
  assert.equal(cliOk.status, 0, cliOk.stdout + cliOk.stderr);
  assert.match(cliOk.stdout, new RegExp(runCli));
  assert.match(cliOk.stdout, new RegExp(planHead));
  assert.equal(store.getRun(runCli).status, 'accepted');
  assert.equal(store.getRun(runCli).result_json?.acceptedSha, planHead); results.cli = { missingExit: cliMissing.status, badExit: cliBad.status, okExit: cliOk.status, okMentionsRun: true, okMentionsSha: true, persistedStatus: store.getRun(runCli).status, persistedSha: store.getRun(runCli).result_json?.acceptedSha };
  const evidence = { kind: 'accept-concurrency-cli', candidateSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(), planHead, results, at: new Date().toISOString() };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), results }));
} finally { try { sup.kill('SIGKILL'); } catch { /* ignore */ } try { const s = JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor/state.json'), 'utf8')); if (s.childPid) process.kill(s.childPid, 'SIGKILL'); } catch { /* ignore */ } store.close(); mock.close(); }
