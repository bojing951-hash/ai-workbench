// SPDX-License-Identifier: Apache-2.0
/** Loop 终态发布→裸 Git→回环 GitHub Draft/CI→正式 /accept 的端到端恢复回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { Orchestrator } from '../src/orchestrator.js';
import { EventBus } from '../src/bus.js';

const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.GITHUB_EVIDENCE_DIR || 'demo/evidence/github-publish');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-gh-publish-'));
const worktree = path.join(root, 'wt');
const bare = path.join(root, 'github.com', 'fixture', 'repo.git');
const remoteBranchSha=(b)=>{const r=spawnSync('git',['rev-parse',`refs/heads/${b}`],{cwd:bare,encoding:'utf8'});return (r.stdout||'').trim();};
fs.mkdirSync(worktree, { recursive: true });
const git = (args, cwd = worktree) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
fs.mkdirSync(path.dirname(bare), { recursive: true });
spawnSync('git', ['init', '--bare', '-q', bare]);
git(['remote', 'add', 'origin', bare]);
fs.writeFileSync(path.join(worktree, 'a.txt'), 'final\n'); git(['add', '-A']); git(['commit', '-qm', 'final']);
const planHead = git(['rev-parse', 'HEAD']);
const runId = 'run_ghpub00001'; const branch = `wb/plan-${runId.slice(-6)}`;
git(['branch', branch, planHead]);
git(['push', '-q', 'origin', branch]);
let pulls = 0; let creates = 0; let existingSha = planHead; let draftExists = false; let draftCreated = 0; let ciShaOverride = ''; let existingDraft = true;
let delayNextPull = false; let releasePull = null; let pullStartedResolve = null; let pullStarted = Promise.resolve();
const mock = http.createServer(async (req, res) => {
  let bodyText='';
  for await (const c of req) bodyText+=c;
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/repos/fixture/repo') return send(200, { default_branch: 'main' });
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'GET') {
    pulls += 1;
    if (delayNextPull) { delayNextPull = false; if (pullStartedResolve) pullStartedResolve(); await new Promise((r) => { releasePull = r; }); }
    if (!draftExists) return send(200, []);
    const qhead = String(u.searchParams.get('head') || 'fixture:');
    const ref = qhead.includes(':') ? qhead.slice(qhead.indexOf(':') + 1) : qhead;
    return send(200, [{ number: 7, html_url: 'https://example.invalid/pr/7', state: 'open', draft: existingDraft, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref, sha: existingSha, repo: { full_name: 'fixture/repo' } } }]);
  }
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'POST') { creates += 1; draftCreated += 1; draftExists = true; const body=JSON.parse(bodyText||'{}'); return send(201, { number: 8, html_url: 'https://example.invalid/pr/8', state: 'open', draft: true, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref: body.head || '', sha: remoteBranchSha(body.head), repo: { full_name: 'fixture/repo' } } }); }
  if (u.pathname === '/repos/fixture/repo/pulls/7' && req.method === 'GET') return send(200, { number: 7, html_url: 'https://example.invalid/pr/7', state: 'open', draft: true, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref: branch, sha: planHead, repo: { full_name: 'fixture/repo' } } });
  if (u.pathname === '/repos/fixture/repo/actions/runs') {
    const sha = u.searchParams.get('head_sha') || '';
    return send(200, { workflow_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', head_sha: ciShaOverride || sha, html_url: 'https://example.invalid/ci/1' }] });
  }
  if (u.pathname === '/repos/fixture/repo/pulls/7') return send(200, { number: 7, draft: true, base: { ref: 'main' }, head: { ref: branch, sha: planHead } });
  return send(404, { message: 'not found ' + u.pathname });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const config = getConfig({ paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data/workbench.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, github: { token: 'fixture-token', apiBase: `http://127.0.0.1:${mock.address().port}`, push: true, createPr: true, autoCreateRepo: false }, policy: { autoPush: true, ciPollAttempts: 1, ciPollIntervalMs: 10 } });
const store = openStore(config.paths.dbPath);
const project = store.createProject({ id: 'proj_gh', name: 'gh', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: true, ciRequired: true, config: { publish: true } });
const plan = store.createPlan({ id: 'plan_gh', projectId: project.id, runId, goal: 'publish', title: 'publish' });
const run = store.createRun({ id: runId, projectId: project.id, planId: plan.id, goal: 'publish', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
store.updateRun(run.id, { verified_sha: planHead, result_json: { planHead, productAcceptance: 'PASS', productPlanHead: planHead } });
const prAction = store.createAction({ id: 'act_pr_crash', runId: run.id, type: 'github-pr', status: 'running', payload: { owner: 'fixture', repo: 'repo', head: branch, base: 'main', sha: planHead } });
const orch = new Orchestrator({ config, store, bus: new EventBus() });
try {
  // 0) 正常发布只创建一个 Draft；模拟响应丢失后重启认领，不重复 POST。
  draftExists = false;
  const run0 = store.createRun({ id: 'run_ghpub00000', projectId: project.id, planId: plan.id, goal: 'publish0', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  const branch0 = `wb/plan-${run0.id.slice(-6)}`; git(['branch', branch0, planHead]);
  store.updateRun(run0.id, { verified_sha: planHead, result_json: { planHead, productAcceptance: 'PASS', productPlanHead: planHead } });
  const firstPublish = await orch.publishRun(store.getRun(run0.id), project, branch0, planHead, []);
  assert.equal(draftCreated, 1, 'normal publish must create exactly one Draft');
  assert.equal(firstPublish.pr?.number, 8);
  const prAction0 = store.listActions(run0.id).find((a) => a.type === 'github-pr');
  store.updateAction(prAction0.id, { status: 'running', result: {} });
  existingSha = planHead;
  const recovered = await orch.publishRun(store.getRun(run0.id), project, branch0, planHead, []);
  assert.equal(draftCreated, 1, 'lost PR response recovery must not create a second Draft');
  assert.equal(recovered.pr?.recovered, true);
  draftExists = true; existingSha = planHead;

  // 1) 上一次进程在创建 Draft 后崩溃：重启后的 publishRun 必须按 head 认领，不重复 POST。
  const publish = await orch.publishRun(store.getRun(run.id), project, branch, planHead, []);
  assert.equal(creates, 1, 'recovery must not create a second Draft');
  assert.equal(draftCreated, 1, 'only one Draft create request total');
  assert.equal(publish.pr?.number, 7);
  assert.equal(publish.pr?.recovered, true);
  const action = store.getAction(prAction.id);
  assert.equal(action.status, 'done');
  assert.equal(action.result_json?.recovered, true);
  assert.equal(action.result_json?.sha, planHead);
  // 2) 同 SHA CI 绿灯进入正式验收。
  const refreshed = await orch.refreshCi(run.id);
  assert.equal(refreshed.conclusion, 'success');
  assert.equal(refreshed.requiredSha, planHead);
  assert.equal(refreshed.mismatched.length, 0);
  const afterRefresh = store.getRun(run.id);
  assert.equal(afterRefresh.verification_status, 'CI_PASSED');
  const accepted = await orch.acceptRun(run.id, {});
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.result_json?.acceptedSha, planHead);
  // 2b) 异 SHA 绿灯不得流入 CI_PASSED。
  const runCiBad = store.createRun({ id: 'run_ghpub00003', projectId: project.id, planId: plan.id, goal: 'ci-bad', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  store.updateRun(runCiBad.id, { verified_sha: planHead, result_json: { planHead } });
  store.createAction({ id: 'act_ci_bad', runId: runCiBad.id, type: 'github-ci', status: 'done', payload: { owner: 'fixture', repo: 'repo', sha: planHead } });
  ciShaOverride = 'e'.repeat(40);
  const badCi = await orch.refreshCi(runCiBad.id);
  assert.ok(badCi.mismatched.length > 0, 'mismatched green must be reported');
  assert.notEqual(store.getRun(runCiBad.id).verification_status, 'CI_PASSED');
  ciShaOverride = '';

  // 3) 已有 PR 的 head SHA 不匹配：拒绝重复创建并保持未验收。
  const run2 = store.createRun({ id: 'run_ghpub00002', projectId: project.id, planId: plan.id, goal: 'publish2', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  const branch2 = `wb/plan-${run2.id.slice(-6)}`; git(['branch', branch2, planHead]);
  store.updateRun(run2.id, { verified_sha: planHead, result_json: { planHead, productAcceptance: 'PASS', productPlanHead: planHead } });
  store.createAction({ id: 'act_pr_bad', runId: run2.id, type: 'github-pr', status: 'running', payload: { owner: 'fixture', repo: 'repo', head: branch2, base: 'main', sha: planHead } });
  existingSha = 'f'.repeat(40);
  const bad = await orch.publishRun(store.getRun(run2.id), project, branch2, planHead, []);
  assert.ok(bad.blocked.length > 0, 'mismatched existing PR must block');
  assert.equal(creates, 1, 'mismatch must not create a Draft');
  assert.notEqual(store.getRun(run2.id).status, 'accepted');
  existingSha = planHead;
  // 3a) 慢 GET 后撤权：实际 Draft POST 前紧邻 guard 必须阻断。
  const run5 = store.createRun({ id: 'run_ghpub00005', projectId: project.id, planId: plan.id, goal: 'revoke-gap', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  const branch5 = `wb/plan-${run5.id.slice(-6)}`; git(['branch', branch5, planHead]);
  store.updateRun(run5.id, { verified_sha: planHead, result_json: { planHead, productAcceptance: 'PASS', productPlanHead: planHead } });
  draftExists = false; delayNextPull = true; pullStarted = new Promise((r) => { pullStartedResolve = r; });
  const publishPromise = orch.publishRun(store.getRun(run5.id), project, branch5, planHead, []);
  await pullStarted;
  store.db.prepare('UPDATE projects SET remote_push_authorized=0 WHERE id=?').run(project.id);
  releasePull(); const revoked = await publishPromise;
  assert.ok(revoked.blocked.length > 0, 'revoked during GET must block before POST');
  assert.equal(creates, 1, 'revoked during GET must not create Draft');
  store.db.prepare('UPDATE projects SET remote_push_authorized=1 WHERE id=?').run(project.id);
  draftExists = true;
  // 3b) 已存在 PR 非 Draft：拒绝认领、零创建。
  const run4 = store.createRun({ id: 'run_ghpub00004', projectId: project.id, planId: plan.id, goal: 'nondraft', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  const branch4 = `wb/plan-${run4.id.slice(-6)}`; git(['branch', branch4, planHead]);
  store.updateRun(run4.id, { verified_sha: planHead, result_json: { planHead, productAcceptance: 'PASS', productPlanHead: planHead } });
  store.createAction({ id: 'act_pr_nondraft', runId: run4.id, type: 'github-pr', status: 'running', payload: { owner: 'fixture', repo: 'repo', head: branch4, base: 'main', sha: planHead } });
  draftExists = true; existingDraft = false;
  const nonDraft = await orch.publishRun(store.getRun(run4.id), project, branch4, planHead, []);
  assert.ok(nonDraft.blocked.length > 0, 'non-draft existing PR must block');
  assert.equal(creates, 1, 'non-draft must not create a Draft');
  existingDraft = true;
  // 3c) GITHUB_CREATE_PR=false：允许推送，但必须零 Draft POST。
  const run6 = store.createRun({ id: 'run_ghpub00006', projectId: project.id, planId: plan.id, goal: 'no-pr', status: 'awaiting_acceptance', verificationStatus: 'LOCAL_VERIFIED' });
  const branch6 = `wb/plan-${run6.id.slice(-6)}`; git(['branch', branch6, planHead]);
  store.updateRun(run6.id, { verified_sha: planHead, result_json: { planHead } });
  const configNoPr = { ...config, github: { ...config.github, createPr: false } };
  const orchNoPr = new Orchestrator({ config: configNoPr, store, bus: new EventBus() });
  const noPr = await orchNoPr.publishRun(store.getRun(run6.id), project, branch6, planHead, []);
  assert.ok(noPr.blocked.length > 0, 'GITHUB_CREATE_PR=false must block Draft');
  assert.equal(creates, 1, 'GITHUB_CREATE_PR=false must not POST Draft');
  assert.ok(store.listActions(run6.id).some((a) => a.type === 'github-push' && a.status === 'done'));
  const evidence = {
    kind: 'github-publish-ci-accept-recovery', creates: draftCreated, candidateSha: git(['rev-parse', 'HEAD'], REPO), runId, verifiedSha: planHead,
    pushRef: { branch, sha: git(['rev-parse', `refs/heads/${branch}`]) }, bareRemoteRef: git(['rev-parse', `refs/heads/${branch}`], bare),
    draft: { recovered: true, number: 7, creates, pulls, expectedOne: draftCreated === 1 }, ci: { conclusion: refreshed.conclusion, requiredSha: refreshed.requiredSha, mismatched: refreshed.mismatched }, acceptedSha: accepted.result_json.acceptedSha,
    mismatchNegative: { blocked: true, creates }, nonDraftRejected: { blocked: true, creates }, revokedDuringGet: { blocked: true, creates }, createPrDisabled: { blocked: noPr.blocked.join('；'), creates },
    action: { status: action.status, recovered: action.result_json?.recovered, sha: action.result_json?.sha }, at: new Date().toISOString(),
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), creates, pulls, acceptedSha: planHead, ci: refreshed.conclusion }));
} finally { try { store.close(); } catch { /* ignore */ } mock.close(); }
