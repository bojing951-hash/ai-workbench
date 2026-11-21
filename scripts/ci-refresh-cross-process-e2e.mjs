// SPDX-License-Identifier: Apache-2.0
/** 两个正式 Workbench 进程共享 SQLite：原子取号 + 乱序刷新不覆盖新失败。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { pathToFileURL } from 'node:url';
import { openStore } from '../src/db.js';

const NODE = process.execPath; const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.CI_REFRESH_XPROC_EVIDENCE_DIR || 'demo/evidence/ci-refresh-cross-process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cirefresh-x-'));
const worktree = path.join(root, 'wt'); fs.mkdirSync(worktree, { recursive: true });
const git = (args, cwd = worktree) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
const planHead = git(['rev-parse', 'HEAD']);
let call = 0; let releaseA = null; let aStartedResolve = null; let aStarted = new Promise((r) => { aStartedResolve = r; });
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
async function api(port, method, p) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': 'xproc-token', 'content-type': 'application/json' } }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
const env = { ...process.env, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: 'xproc-token', WORKBENCH_HOST: '127.0.0.1', GITHUB_TOKEN: 'fixture-token', GITHUB_API_BASE: `http://127.0.0.1:${mock.address().port}`, GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false', MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100' };
for (const f of ['bin', 'src', 'web', 'package.json']) fs.symlinkSync(path.join(REPO, f), path.join(root, f));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const config = getConfig({ paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data/workbench.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, github: { token: 'fixture-token', apiBase: `http://127.0.0.1:${mock.address().port}`, push: false, createPr: false, autoCreateRepo: false } });
async function concurrentSeqProbe(dbPath, id, iterations = 150) {
  const mod = pathToFileURL(path.join(REPO, 'src/db.js')).href;
  const code = `import { openStore } from ${JSON.stringify(mod)}; const s=openStore(process.argv[1]); const out=[]; for(let i=0;i<Number(process.argv[3]);i++) out.push(s.beginCiRefresh(process.argv[2])); s.close(); console.log(JSON.stringify(out));`;
  const one = () => new Promise((resolve) => { const c = spawn(NODE, ['--input-type=module', '-e', code, dbPath, id, String(iterations)], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', (status) => resolve({ status, out: o })); });
  const rs = await Promise.all([one(), one()]);
  const seqs = rs.flatMap((r) => JSON.parse(r.out.trim() || '[]'));
  const counts = new Map(); for (const v of seqs) counts.set(v, (counts.get(v) || 0) + 1);
  return { seqs, distinct: counts.size, duplicates: [...counts].filter(([, n]) => n > 1).length };
}

function seedFixtures() {
const store = openStore(config.paths.dbPath);
const project = store.createProject({ id: 'proj_xproc', name: 'xproc', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: true, config: { publish: true, required_checks: ['build'] } });
const plan = store.createPlan({ id: 'plan_xproc', projectId: project.id, runId: 'seed', goal: 'xproc', title: 'xproc' });
const runId = 'run_xproc_refresh';
const ciEvidence = { status: 'passed', conclusion: 'success', sha: planHead, requiredSha: planHead, mismatched: [], missingChecks: [], runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', headSha: planHead }] };
store.createRun({ id: runId, projectId: project.id, planId: plan.id, goal: 'xproc', status: 'awaiting_acceptance', verificationStatus: 'CI_PASSED' });
store.updateRun(runId, { verified_sha: planHead, result_json: { planHead, ciEvidence } });
store.createAction({ id: 'pr_' + runId, runId, type: 'github-pr', status: 'done', payload: { owner: 'fixture', repo: 'repo', head: 'wb/plan', base: 'main', sha: planHead }, result: { pr: { number: 31, url: 'https://example.invalid/pr/31', draft: true, head: 'wb/plan', base: 'main', sha: planHead }, sha: planHead } });
store.createAction({ id: 'ci_' + runId, runId, type: 'github-ci', status: 'done', payload: { owner: 'fixture', repo: 'repo', sha: planHead }, result: { status: 'passed', conclusion: 'success', sha: planHead } });
store.close();
  return { runId };
}
const ports = [await freePort(), await freePort()];
const proc = (port, i) => spawn(NODE, [path.join(REPO, 'bin/workbench.js'), 'serve'], { cwd: root, env: { ...env, WORKBENCH_PORT: String(port) }, stdio: ['ignore', fs.openSync(path.join(root, `serve${i}.log`), 'a'), fs.openSync(path.join(root, `serve${i}.log`), 'a')] });
const procs = [];
let currentRunId = '';
const results = {};
try {
  procs.push(proc(ports[0], 0));
  assert.ok(await waitHealth(ports[0]), fs.readFileSync(path.join(root, 'serve0.log'), 'utf8'));
  procs.push(proc(ports[1], 1));
  assert.ok(await waitHealth(ports[1]), fs.readFileSync(path.join(root, 'serve1.log'), 'utf8'));
  const { runId } = seedFixtures(); currentRunId = runId;
  const seqProbe = await concurrentSeqProbe(config.paths.dbPath, runId);
  assert.equal(seqProbe.duplicates, 0, `duplicate refresh seq in two processes: ${seqProbe.duplicates}`);
  assert.equal(seqProbe.distinct, 300);
  const oldRefresh = api(ports[0], 'POST', `/api/runs/${runId}/ci-refresh`);
  await aStarted;
  const newRefresh = await api(ports[1], 'POST', `/api/runs/${runId}/ci-refresh`);
  assert.equal(newRefresh.status, 200, JSON.stringify(newRefresh));
  assert.equal(store2Run().verification_status, 'CI_FAILED');
  releaseA();
  const oldRes = await oldRefresh;
  // 修前此处会被旧成功覆盖为 CI_PASSED / action passed。
  assert.equal(store2Run().verification_status, 'CI_FAILED', 'stale success must not overwrite newer failure');
  const ciAction = store2Actions().filter((a) => a.type === 'github-ci').at(-1);
  assert.equal(ciAction?.result_json?.status, 'failed', 'stale refresh must not rewrite CI action receipt');
  const seqA = oldRes.data?.data?.refreshSeq; const seqB = newRefresh.data?.data?.refreshSeq;
  assert.ok(Number(seqA) > 0 && Number(seqB) > 0 && seqA !== seqB, `cross-process seq must differ: ${seqA}/${seqB}`);
  assert.equal(oldRes.data?.data?.applied, false); assert.equal(oldRes.data?.data?.reason, 'out-of-order');
  const acceptFail = await api(ports[0], 'POST', `/api/runs/${runId}/accept`);
  assert.equal(acceptFail.status, 400, JSON.stringify(acceptFail));
  assert.equal(store2Run().result_json?.acceptedSha, undefined);
  assert.equal(store2Run().result_json?.acceptedAt, undefined);
  assert.equal(store2Events().filter((e) => e.type === 'run_accepted').length, 0);
  results.atomicSeq = { distinct: seqProbe.distinct, duplicates: seqProbe.duplicates, total: seqProbe.seqs.length };
  results.outOfOrder = { newStatus: 'CI_FAILED', staleApplied: false, staleReason: 'out-of-order', ciActionStatus: ciAction?.result_json?.status, seqA, seqB, acceptStatus: acceptFail.status, acceptedShaAbsent: true, acceptedAtAbsent: true, acceptedEvents: 0 };
  // 有效新绿后同一 Draft/SHA 可验收。
  const green = await api(ports[1], 'POST', `/api/runs/${runId}/ci-refresh`);
  assert.equal(green.status, 200, JSON.stringify(green));
  assert.equal(store2Run().verification_status, 'CI_PASSED');
  const acceptOk = await api(ports[1], 'POST', `/api/runs/${runId}/accept`);
  assert.equal(acceptOk.status, 200, JSON.stringify(acceptOk));
  assert.equal(store2Run().status, 'accepted');
  assert.equal(store2Run().result_json?.acceptedSha, planHead);
  results.greenAccepted = { status: 'accepted', acceptedSha: store2Run().result_json?.acceptedSha };
  const evidence = { kind: 'ci-refresh-cross-process', candidateSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(), planHead, results, at: new Date().toISOString() };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), results }));
} finally { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } } mock.close(); }
function openDb() { return openStore(config.paths.dbPath); }
function store2Run() { const s = openDb(); try { return s.getRun(currentRunId); } finally { s.close(); } }
function store2Actions() { const s = openDb(); try { return s.listActions(currentRunId); } finally { s.close(); } }
function store2Events() { const s = openDb(); try { return s.listEvents({ runId: currentRunId }); } finally { s.close(); } }
