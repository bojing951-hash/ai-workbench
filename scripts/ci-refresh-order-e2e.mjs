// SPDX-License-Identifier: Apache-2.0
/** 正式 REST+Supervisor：验收后过期 CI 刷新不覆盖 accepted；同 SHA 乱序刷新不覆盖较新失败。 */
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
const EVIDENCE_DIR = path.resolve(process.env.CI_REFRESH_EVIDENCE_DIR || 'demo/evidence/ci-refresh-order');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cirefresh-'));
const worktree = path.join(root, 'wt'); fs.mkdirSync(worktree, { recursive: true });
const git = (args, cwd = worktree) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
const planHead = git(['rev-parse', 'HEAD']);
let call = 0; let aStartedResolve = null; let releaseA = null; let aStarted = Promise.resolve();
const resetCalls = () => { call = 0; aStarted = new Promise((r) => { aStartedResolve = r; }); };
const mock = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const u = new URL(req.url, 'http://x'); const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/repos/fixture/repo/pulls/31' && req.method === 'GET') return send(200, { number: 31, html_url: 'https://example.invalid/pr/31', state: 'open', draft: true, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref: 'wb/plan', sha: planHead, repo: { full_name: 'fixture/repo' } } });
  if (u.pathname === '/repos/fixture/repo/actions/runs') {
    call += 1;
    if (call === 1) { aStartedResolve(); await new Promise((r) => { releaseA = r; }); return send(200, { workflow_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', head_sha: planHead, html_url: 'https://example.invalid/ci/1' }] }); }
    if (call === 2) return send(200, { workflow_runs: [{ id: 2, name: 'build', status: 'completed', conclusion: 'failure', head_sha: planHead, html_url: 'https://example.invalid/ci/2' }] });
    return send(200, { workflow_runs: [{ id: 3, name: 'build', status: 'completed', conclusion: 'success', head_sha: planHead, html_url: 'https://example.invalid/ci/3' }] });
  }
  if (u.pathname === '/repos/fixture/repo') return send(200, { default_branch: 'main' });
  return send(404, { message: 'not found' });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 300)); } return false; }
async function api(port, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': 'refresh-token', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
const env = { ...process.env, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: 'refresh-token', WORKBENCH_HOST: '127.0.0.1', GITHUB_TOKEN: 'fixture-token', GITHUB_API_BASE: `http://127.0.0.1:${mock.address().port}`, GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false', MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100' };
for (const f of ['bin', 'src', 'web', 'package.json']) fs.symlinkSync(path.join(REPO, f), path.join(root, f));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const config = getConfig({ paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data/workbench.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, github: { token: 'fixture-token', apiBase: `http://127.0.0.1:${mock.address().port}`, push: false, createPr: false, autoCreateRepo: false } });
const store = openStore(config.paths.dbPath);
const project = store.createProject({ id: 'proj_refresh', name: 'refresh', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: true, config: { publish: true, required_checks: ['build'] } });
const plan = store.createPlan({ id: 'plan_refresh', projectId: project.id, runId: 'seed', goal: 'refresh', title: 'refresh' });
const ciEvidence = { status: 'passed', conclusion: 'success', sha: planHead, requiredSha: planHead, mismatched: [], missingChecks: [], runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', headSha: planHead }] };
function seedRun(id) {
  store.createRun({ id, projectId: project.id, planId: plan.id, goal: 'refresh', status: 'awaiting_acceptance', verificationStatus: 'CI_PASSED' });
  store.updateRun(id, { verified_sha: planHead, result_json: { planHead, ciEvidence } });
  store.createAction({ id: 'pr_' + id, runId: id, type: 'github-pr', status: 'done', payload: { owner: 'fixture', repo: 'repo', head: 'wb/plan', base: 'main', sha: planHead }, result: { pr: { number: 31, url: 'https://example.invalid/pr/31', draft: true, head: 'wb/plan', base: 'main', sha: planHead }, sha: planHead } });
  store.createAction({ id: 'ci_' + id, runId: id, type: 'github-ci', status: 'done', payload: { owner: 'fixture', repo: 'repo', sha: planHead }, result: { status: 'passed', conclusion: 'success', sha: planHead } });
}
const port = await freePort();
const sup = spawn(NODE, [path.join(REPO, 'supervisor/workbench-supervisor.mjs'), '--root', root, '--port', String(port), '--max-restarts', '2'], { cwd: root, env: { ...env, WORKBENCH_PORT: String(port) }, stdio: ['ignore', fs.openSync(path.join(root, 'sup.log'), 'a'), fs.openSync(path.join(root, 'sup.log'), 'a')] });
const results = {};
try {
  assert.ok(await waitHealth(port), fs.readFileSync(path.join(root, 'sup.log'), 'utf8'));
  // A) 验收成功后过期刷新返回，不得覆盖 accepted。
  const runA = 'run_refresh_accepted'; seedRun(runA); resetCalls();
  const refreshA = api(port, 'POST', `/api/runs/${runA}/ci-refresh`);
  await aStarted;
  const acceptA = await api(port, 'POST', `/api/runs/${runA}/accept`);
  assert.equal(acceptA.status, 200, JSON.stringify(acceptA));
  const acceptedBefore = store.getRun(runA);
  const acceptedFields = { status: acceptedBefore.status, sha: acceptedBefore.result_json?.acceptedSha, at: acceptedBefore.result_json?.acceptedAt };
  releaseA(); const staleA = await refreshA;
  const acceptedAfter = store.getRun(runA);
  assert.equal(acceptedAfter.status, 'accepted');
  assert.equal(acceptedAfter.result_json?.acceptedSha, acceptedFields.sha);
  assert.equal(acceptedAfter.result_json?.acceptedAt, acceptedFields.at);
  assert.equal(acceptedAfter.verification_status, 'CI_PASSED');
  const eventsA = store.listEvents({ runId: runA }).filter((e) => e.type === 'run_accepted').length;
  assert.equal(eventsA, 1);
  results.acceptedRefresh = { acceptedStatus: acceptedAfter.status, acceptedShaSame: true, acceptedAtSame: true, successEvents: eventsA, staleRefreshApplied: staleA.data?.data?.applied ?? null, staleReason: staleA.data?.data?.reason ?? null };
  // B) 同 SHA 刷新乱序：新失败先落库，旧成功后返回不得覆盖。
  const runB = 'run_refresh_order'; seedRun(runB); resetCalls();
  const refreshOld = api(port, 'POST', `/api/runs/${runB}/ci-refresh`);
  await aStarted;
  const refreshNew = await api(port, 'POST', `/api/runs/${runB}/ci-refresh`);
  assert.equal(refreshNew.status, 200, JSON.stringify(refreshNew));
  assert.equal(store.getRun(runB).verification_status, 'CI_FAILED');
  releaseA(); const oldRes = await refreshOld;
  assert.equal(store.getRun(runB).verification_status, 'CI_FAILED');
  const acceptDuringFail = await api(port, 'POST', `/api/runs/${runB}/accept`);
  assert.notEqual(acceptDuringFail.status, 200, JSON.stringify(acceptDuringFail));
  results.outOfOrder = { newRefreshStatus: store.getRun(runB).verification_status, oldRefreshApplied: oldRes.data?.data?.applied ?? null, oldRefreshReason: oldRes.data?.data?.reason ?? null, acceptAfterFailStatus: acceptDuringFail.status, acceptRejectedReason: acceptDuringFail.data?.error?.code || null };
  // 之后真实新绿可让同一 Draft/SHA 正常验收。
  const refreshGreen = await api(port, 'POST', `/api/runs/${runB}/ci-refresh`);
  assert.equal(refreshGreen.status, 200, JSON.stringify(refreshGreen));
  assert.equal(store.getRun(runB).verification_status, 'CI_PASSED');
  const acceptB = await api(port, 'POST', `/api/runs/${runB}/accept`);
  assert.equal(acceptB.status, 200, JSON.stringify(acceptB));
  assert.equal(store.getRun(runB).status, 'accepted');
  assert.equal(store.getRun(runB).result_json?.acceptedSha, planHead);
  results.greenAfterOrder = { status: 'accepted', acceptedSha: store.getRun(runB).result_json?.acceptedSha };
  const evidence = { kind: 'ci-refresh-order', candidateSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(), planHead, results, at: new Date().toISOString() };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), results }));
} finally { try { sup.kill('SIGKILL'); } catch { /* ignore */ } try { const s = JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor/state.json'), 'utf8')); if (s.childPid) process.kill(s.childPid, 'SIGKILL'); } catch { /* ignore */ } store.close(); mock.close(); }
