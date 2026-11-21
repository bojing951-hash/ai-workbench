// SPDX-License-Identifier: Apache-2.0
/** Loop 终态发布门控：终审/质量门/状态/ref 统一检查的确定性回归（裸 Git，无网络）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LoopManager } from '../src/loop.js';

const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.LOOP_EVIDENCE_DIR || 'demo/evidence/loop-terminal');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-loop-terminal-'));
const repo = path.join(root, 'repo');
const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
fs.mkdirSync(repo, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
const base = git(['rev-parse', 'HEAD']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'final\n'); git(['add', '-A']); git(['commit', '-qm', 'final']);
const finalSha = git(['rev-parse', 'HEAD']);
const runId = 'run_terminal00001';
const branch = `wb/plan-${runId.slice(-6)}`;
git(['branch', branch, finalSha]);
const run = { id: runId, status: 'awaiting_acceptance', verified_sha: finalSha, result_json: { productAcceptance: 'PASS', productPlanHead: finalSha, planHead: finalSha } };
const staleRun = { ...run, result_json: {} };
const loop = { id: 'loop_terminal', status: 'running', current_run_id: runId, history_json: [{ runId }] };
const project = { id: 'proj_terminal', local_path: repo, remote_push_authorized: 1, config_json: { publish: true } };
let published = 0;
const store = {
  getRun: (id) => (id === runId ? run : null),
  getLoop: (id) => (id === loop.id ? loop : null),
  listTasks: () => [],
  getProject: () => project,
};
const orchestrator = { publishAcceptedRun: async () => { published += 1; return { pr: { number: 1, url: 'fixture://pr/1', draft: true }, ci: { status: 'passed', sha: finalSha } }; } };
const lm = new LoopManager({ config: {}, store, bus: { emit() {} }, orchestrator });
const results = {};
// 正常：陈旧 run 快照不得阻止，重新读取 Run 后发布一次。
const ok = await lm.publishLoopFinal(loop, project, { run: staleRun });
assert.ok(ok); assert.equal(published, 1); results.normal = 1;
// 终审未过：零发布。
run.result_json = { productAcceptance: 'FAIL', productPlanHead: finalSha };
assert.equal(await lm.publishLoopFinal(loop, project, { run }), null); assert.equal(published, 1); results.finalAuditFail = 0;
// Loop 已取消：零发布。
run.result_json = { productAcceptance: 'PASS', productPlanHead: finalSha };
loop.status = 'cancelled';
assert.equal(await lm.publishLoopFinal(loop, project, { run }), null); assert.equal(published, 1); results.loopCancelled = 0;
// Run 已取消：零发布。
loop.status = 'running'; run.status = 'cancelled';
assert.equal(await lm.publishLoopFinal(loop, project, { run }), null); assert.equal(published, 1); results.runCancelled = 0;
// 实际 ref 被推进到另一 SHA：零发布，安全停止。
run.status = 'awaiting_acceptance';
fs.writeFileSync(path.join(repo, 'a.txt'), 'drift\n'); git(['add', '-A']); git(['commit', '-qm', 'drift']); git(['branch', '-f', branch, 'HEAD']);
assert.equal(await lm.publishLoopFinal(loop, project, { run }), null); assert.equal(published, 1); results.refMismatch = 0;
// 恢复 ref 到审计 SHA：发布一次。
git(['branch', '-f', branch, finalSha]);
assert.ok(await lm.publishLoopFinal(loop, project, { run })); assert.equal(published, 2); results.refRestored = 1;
const evidence = {
  kind: 'loop-terminal-publish-gate', candidateSha: git(['rev-parse', 'HEAD'], REPO), base, auditSha: finalSha, branch,
  negativeCases: { finalAuditFail: 0, loopCancelled: 0, runCancelled: 0, refMismatch: 0 },
  positiveCases: { staleRunSnapshotReread: 1, restoredRef: 1 }, totalPublishCalls: published, at: new Date().toISOString(),
};
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), published, results }));
fs.rmSync(root, { recursive: true, force: true });
