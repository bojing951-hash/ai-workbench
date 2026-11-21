// SPDX-License-Identifier: Apache-2.0
/** 同 SHA CI 证据统一入口：首次轮询/刷新/重启恢复 + /accept 判定 + 审计 SHA 推送源。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { EventBus } from '../src/bus.js';

const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.CI_EVIDENCE_DIR || 'demo/evidence/ci-evidence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ci-evidence-'));
const worktree = path.join(root, 'wt'); const bare = path.join(root, 'github.com', 'fixture', 'repo.git');
const remoteBranchSha=(b)=>{const r=spawnSync('git',['rev-parse',`refs/heads/${b}`],{cwd:bare,encoding:'utf8'});return (r.stdout||'').trim();};
fs.mkdirSync(worktree, { recursive: true }); fs.mkdirSync(path.dirname(bare), { recursive: true });
const git = (args, cwd = worktree) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']); spawnSync('git', ['init', '--bare', '-q', bare]); git(['remote', 'add', 'origin', bare]);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'final\n'); git(['add', '-A']); git(['commit', '-qm', 'final']); const planHead = git(['rev-parse', 'HEAD']);
const runId = 'run_cievidence01'; const branch = `wb/plan-${runId.slice(-6)}`; git(['branch', branch, planHead]); git(['push', '-q', 'origin', branch]);
let mode = 'green'; let foreign = false; let checkName = 'build'; let pendingOnce = false; let draftHeadSha = planHead; let draftBase = 'main'; let prGets = 0;
const mock = http.createServer(async (req, res) => {
  let bodyText=''; for await (const c of req) bodyText+=c;
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/repos/fixture/repo') return send(200, { default_branch: 'main' });
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'GET') return send(200, []);
  if (u.pathname === '/repos/fixture/repo/pulls/31' && req.method === 'GET') { prGets += 1; return send(200, { number: 31, html_url: 'https://example.invalid/pr/31', state: 'open', draft: true, base: { ref: draftBase, repo: { full_name: 'fixture/repo' } }, head: { ref: 'wb/plan', sha: draftHeadSha, repo: { full_name: 'fixture/repo' } } }); }
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'POST') { const body=JSON.parse(bodyText||'{}'); return send(201, { number: 31, html_url: 'https://example.invalid/pr/31', state: 'open', draft: true, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref: body.head || '', sha: remoteBranchSha(body.head), repo: { full_name: 'fixture/repo' } } }); }
  if (u.pathname === '/repos/fixture/repo/actions/runs') {
    const sha = u.searchParams.get('head_sha') || '';
    if (pendingOnce) { pendingOnce = false; return send(200, { workflow_runs: [{ id: 31, name: checkName, status: 'in_progress', conclusion: null, head_sha: sha, html_url: 'https://example.invalid/ci/31' }] }); }
    if (mode === 'red') return send(200, { workflow_runs: [{ id: 31, name: 'test', status: 'completed', conclusion: 'failure', head_sha: sha, html_url: 'https://example.invalid/ci/31' }] });
    return send(200, { workflow_runs: [{ id: 31, name: checkName, status: 'completed', conclusion: 'success', head_sha: foreign ? 'f'.repeat(40) : sha, html_url: 'https://example.invalid/ci/31' }] });
  }
  return send(404, { message: 'not found' });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const config = getConfig({ paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data/workbench.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, github: { token: 'fixture-token', apiBase: `http://127.0.0.1:${mock.address().port}`, push: true, createPr: true, autoCreateRepo: false }, policy: { autoPush: true, ciPollAttempts: 2, ciPollIntervalMs: 10 } });
const store = openStore(config.paths.dbPath);
const project = store.createProject({ id: 'proj_ci', name: 'ci', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: true, config: { publish: true, required_checks: ['build'] } });
const plan = store.createPlan({ id: 'plan_ci', projectId: project.id, runId, goal: 'ci', title: 'ci' });
const mkRun = (id) => { const run = store.createRun({ id, projectId: project.id, planId: plan.id, goal: 'ci', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' }); store.updateRun(id, { verified_sha: planHead, result_json: { planHead, loopId: 'loop_ci', productAcceptance: 'PASS', productPlanHead: planHead } }); return store.createAction({ id: 'ci_' + id, runId: id, type: 'github-ci', status: 'done', payload: { owner: 'fixture', repo: 'repo', sha: planHead } }); };
const orch = new Orchestrator({ config, store, bus: new EventBus() });
const results = {};
try {
  // 1) 同 SHA 真实必需检查绿（'build'）→ CI_PASSED → /accept 200。
  checkName = 'build'; mode = 'green'; foreign = false;
  const run1 = store.getRun(runId); mkRun(runId);
  const r1 = await orch.refreshCi(runId); assert.equal(r1.status, 'passed', JSON.stringify(r1));
  assert.equal(store.getRun(runId).verification_status, 'CI_PASSED');
  const acc1 = await orch.acceptRun(runId, {}); assert.equal(acc1.status, 'accepted'); results.sameShaGreen = 'accepted';
  // 2) 红拒绝。
  const run2id = 'run_cired000002'; mode = 'red'; foreign = false; mkRun(run2id);
  const r2 = await orch.refreshCi(run2id); assert.equal(r2.status, 'failed');
  await assert.rejects(() => orch.acceptRun(run2id, {}), /CI_FAILED|不能验收/); results.redRejected = true;
  // 3) 待定转同 SHA 绿。
  const run3id = 'run_cipending03'; mode = 'green'; pendingOnce = true; mkRun(run3id);
  const r3a = await orch.refreshCi(run3id); assert.equal(r3a.status, 'pending');
  const r3b = await orch.refreshCi(run3id); assert.equal(r3b.status, 'passed');
  assert.equal((await orch.acceptRun(run3id, {})).status, 'accepted'); results.pendingToGreen = 'accepted';
  // 4) 缺必需检查拒绝。
  const run4id = 'run_cimissing04'; mode = 'green'; foreign = false;
  checkName = 'test'; mkRun(run4id); // project 必需 'build'，mock 返回 test
  const r4 = await orch.refreshCi(run4id); assert.equal(r4.status, 'failed'); assert.ok(r4.missingChecks.includes('build'));
  await assert.rejects(() => orch.acceptRun(run4id, {}), /CI_FAILED|CI_EVIDENCE_MISSING|不能验收/); results.missingCheckRejected = true;
  // 5) 异 SHA 绿在刷新/首次轮询均拒绝。
  const run5id = 'run_ciforeign05'; foreign = true; mode = 'green'; checkName = 'build'; mkRun(run5id);
  const r5 = await orch.refreshCi(run5id); assert.equal(r5.status, 'failed'); assert.ok(r5.mismatched.length > 0);
  await assert.rejects(() => orch.acceptRun(run5id, {}), /CI_FAILED|CI_EVIDENCE_MISSING|不能验收/); results.foreignShaRejected = true;
  foreign = false;
  // 6) 历史无证据的 CI_PASSED 不能自动过 /accept。
  const run6id = 'run_cistale00006'; const pr = store.createProject({ id: 'proj_stale', name: 'stale', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: true, config: { publish: true } });
  const stalePlan = store.createPlan({ id: 'plan_stale', projectId: pr.id, runId: run6id, goal: 'stale', title: 'stale' });
  const stale = store.createRun({ id: run6id, projectId: pr.id, planId: stalePlan.id, goal: 'stale', status: 'awaiting_acceptance', verificationStatus: 'CI_PASSED' });
  store.updateRun(run6id, { verified_sha: planHead, result_json: { planHead } });
  await assert.rejects(() => orch.acceptRun(run6id, {}), /CI_PASSED 缺少|CI_EVIDENCE_MISSING/); results.staleCiPassedRejected = true;
  // 7) 审计 SHA 推送源：本地 ref 被推进后，远端仍只收到审计 SHA。
  // 6b) 当前 Draft head 已变化：旧 SHA 的绿不得通过，/accept 拒绝。
  const run8id = 'run_cidraft00008'; mkRun(run8id);
  store.createAction({ id: 'pr_' + run8id, runId: run8id, type: 'github-pr', status: 'done', payload: { owner: 'fixture', repo: 'repo', head: 'wb/plan', base: 'main', sha: planHead }, result: { pr: { number: 31, url: 'https://example.invalid/pr/31', draft: true, head: 'wb/plan', base: 'main', sha: planHead }, sha: planHead } });
  draftHeadSha = 'a'.repeat(40); mode = 'green'; checkName = 'build';
  const r8 = await orch.refreshCi(run8id);
  assert.equal(store.getRun(run8id).verification_status, 'CI_FAILED', JSON.stringify(r8));
  assert.ok(r8.evidence?.draftMismatch?.currentHeadSha === draftHeadSha);
  let draftHeadRejectReason=''; try { await orch.acceptRun(run8id, {}); } catch (err) { draftHeadRejectReason=err.message; } assert.ok(/CI_FAILED|不能验收|验收拒绝|DRAFT_IDENTITY/.test(draftHeadRejectReason), draftHeadRejectReason); results.draftHeadChangedRejected = true;
  // 同一 Draft 同一 SHA：刷新通过、/accept 正常。
  const run9id = 'run_cidraft00009'; mkRun(run9id);
  store.createAction({ id: 'pr_' + run9id, runId: run9id, type: 'github-pr', status: 'done', payload: { owner: 'fixture', repo: 'repo', head: 'wb/plan', base: 'main', sha: planHead }, result: { pr: { number: 31, url: 'https://example.invalid/pr/31', draft: true, head: 'wb/plan', base: 'main', sha: planHead }, sha: planHead } });
  draftHeadSha = planHead;
  const r9 = await orch.refreshCi(run9id); assert.equal(r9.status, 'passed', JSON.stringify(r9));
  assert.equal((await orch.acceptRun(run9id, {})).status, 'accepted'); results.sameDraftSameShaAccepted = true;
  // 6c) CI 已绿后 Draft head 变化，用户直接点验收 → 拒绝。
  const run10id = 'run_cidraft00010'; mkRun(run10id);
  store.createAction({ id: 'pr_' + run10id, runId: run10id, type: 'github-pr', status: 'done', payload: { owner: 'fixture', repo: 'repo', head: 'wb/plan', base: 'main', sha: planHead }, result: { pr: { number: 31, url: 'https://example.invalid/pr/31', draft: true, head: 'wb/plan', base: 'main', sha: planHead }, sha: planHead } });
  draftHeadSha = planHead;
  assert.equal((await orch.refreshCi(run10id)).status, 'passed');
  draftHeadSha = 'b'.repeat(40);
  let acceptHeadReason=''; try { await orch.acceptRun(run10id, {}); } catch (err) { acceptHeadReason=err.message; } assert.ok(/DRAFT_IDENTITY_MISMATCH|验收拒绝|DRAFT_IDENTITY/.test(acceptHeadReason), acceptHeadReason); results.acceptAfterHeadChangeRejected = true; results.acceptHeadChangeReason=acceptHeadReason;
  // 6d) CI pending 时 Draft 目标分支变化、head SHA 相同；重启恢复必须拒绝。
  const run11id = 'run_cidraft00011'; mkRun(run11id);
  store.createAction({ id: 'pr_' + run11id, runId: run11id, type: 'github-pr', status: 'done', payload: { owner: 'fixture', repo: 'repo', head: 'wb/plan', base: 'main', sha: planHead }, result: { pr: { number: 31, url: 'https://example.invalid/pr/31', draft: true, head: 'wb/plan', base: 'main', sha: planHead }, sha: planHead } });
  store.updateAction('ci_' + run11id, { status: 'pending' });
  draftHeadSha = planHead; draftBase = 'release';
  const orchRestart = new Orchestrator({ config, store, bus: new EventBus() });
  const rec = await orchRestart.recoverPublishActions();
  assert.equal(store.getRun(run11id).verification_status, 'CI_FAILED', JSON.stringify(rec));
  let restartBaseReason=''; try { await orchRestart.acceptRun(run11id, {}); } catch (err) { restartBaseReason=err.message; } assert.ok(/CI_FAILED|不能验收|验收拒绝|DRAFT_IDENTITY/.test(restartBaseReason), restartBaseReason); results.restartBaseChangedRejected = true; results.restartBaseChangeReason=restartBaseReason; results.prGets=prGets;
  draftBase = 'main';
  const run7id = 'run_cipush00007'; const p7 = store.createProject({ id: 'proj_push', name: 'push', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: false, config: { publish: true } });
  const plan7 = store.createPlan({ id: 'plan_push', projectId: p7.id, runId: run7id, goal: 'push', title: 'push' });
  store.createRun({ id: run7id, projectId: p7.id, planId: plan7.id, goal: 'push', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  store.updateRun(run7id, { verified_sha: planHead, result_json: { planHead } });
  const branch7 = `wb/plan-${run7id.slice(-6)}`; git(['branch', branch7, planHead]);
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'drift-after-audit\n'); git(['add', '-A']); git(['commit', '-qm', 'drift']); const drift = git(['rev-parse', 'HEAD']); git(['branch', '-f', branch7, drift]);
  mode = 'green'; checkName = 'build';
  const pub7 = await orch.publishRun(store.getRun(run7id), p7, branch7, planHead, []);
  assert.ok(pub7.pr, JSON.stringify(pub7));
  const remote7 = git(['rev-parse', `refs/heads/${branch7}`], bare); assert.equal(remote7, planHead, '远端必须只收到审计 SHA'); assert.notEqual(remote7, drift);
  results.auditedShaPushed = { remote: remote7, drift };
  const evidence = { kind: 'ci-evidence-accept', candidateSha: git(['rev-parse', 'HEAD'], REPO), results, planHead, requiredChecks: ['build'], at: new Date().toISOString() };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), results }));
} finally { store.close(); mock.close(); }
