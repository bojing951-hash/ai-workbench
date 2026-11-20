#!/usr/bin/env node
// 离线工程冻结总验收：六组分别运行；任何失败、跳过、必跑项未执行都返回非零。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const groups = [
  { name: '1-product-completion', files: ['tests/handoff-product-plan.test.js', 'tests/handoff-test-evidence.test.js', 'tests/handoff-audit-chunks.test.js', 'tests/v32-product-gate.test.js', 'tests/v35-product-audit-middiff.test.js', 'tests/freeze-final-evidence.test.js'] },
  { name: '2-billing-unknown', files: ['tests/handoff-billing.test.js', 'tests/v35-loop-planner-ledger.test.js', 'tests/v35-usage-known.test.js', 'tests/v35-unknown-billing.test.js', 'tests/freeze-ledger-upgrade.test.js', 'tests/freeze-unknown-reservation.test.js'] },
  { name: '3-paid-identity', files: ['tests/handoff-identity.test.js', 'tests/v35-paid-admission.test.js', 'tests/v35-audit-chunk-budget.test.js'] },
  { name: '4-checkpoint', files: ['tests/handoff-recovery-checkpoint.test.js', 'tests/v35-checkpoint.test.js', 'tests/v35-checkpoint-staged-rename.test.js', 'tests/v35-checkpoint-prepared-sigkill.test.js', 'tests/v35-checkpoint-publish-sigkill.test.js', 'tests/v35-checkpoint-published-sigkill.test.js', 'tests/v35-checkpoint-renamed-sigkill.test.js', 'tests/freeze-checkpoint-owner.test.js'] },
  { name: '5-git-sqlite', files: ['tests/handoff-recovery-commit.test.js', 'tests/v35-git-db-recovery.test.js'] },
  { name: '6-supervisor-docker-e2e', files: ['tests/handoff-supervisor.test.mjs', 'tests/audit-checkpoint.test.js', 'tests/audit-git-retry.test.js', 'tests/audit-hardening.test.js', 'tests/audit-plan-commit.test.js', 'tests/audit-reopen.test.js', 'tests/audit-supervisor.test.mjs', 'tests/v35-container-recovery.test.js', 'tests/freeze-loop-recovery.test.mjs', 'tests/freeze-git-commit-windows.test.js'] },
];

const results = [];
let hardFailure = false;
for (const group of groups) {
  const missing = group.files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    results.push({ name: group.name, status: 'UNEXECUTED', missing });
    hardFailure = true;
    continue;
  }
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...group.files], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${run.stdout || ''}\n${run.stderr || ''}`;
  const num = (key) => { const m = out.match(new RegExp('^ℹ ' + key + ' (\\d+)$', 'm')); return m ? Number(m[1]) : 0; };
  const tests = num('tests'); const pass = num('pass'); const fail = num('fail'); const skipped = num('skipped');
  const ok = run.status === 0 && tests > 0 && fail === 0 && skipped === 0;
  if (!ok) hardFailure = true;
  results.push({ name: group.name, status: ok ? 'PASS' : 'FAIL', tests, pass, fail, skipped });
}
// 独立 DSH 版本绑定脚本必须自动判定；不能只打印观测。
{
  const dsh = spawnSync(process.execPath, ['audit-dsh.mjs'], { encoding: 'utf8', timeout: 120_000 });
  const ok = dsh.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6a-dsh-version-binding', status: ok ? 'PASS' : 'FAIL', code: dsh.status, stderr: (dsh.stderr || '').slice(-500) });
}
// 独立审计包的 8 项补充回归（含升级/Checkpoint owner/Loop 恢复）。
{
  const independent = spawnSync(process.execPath, ['scripts/independent-b506.mjs'], { encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
  const ok = independent.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6a-independent-b506', status: ok ? 'PASS' : 'FAIL', code: independent.status, output: `${independent.stdout || ''}${independent.stderr || ''}`.slice(-800) });
}
// Loop 发布等待中取消：GET 挂起期间 REST cancel Run 及其父 Loop，Draft POST=0 且 Loop 保持 cancelled。
{
  const run = spawnSync(process.execPath, ['scripts/loop-cancel-publish-e2e.mjs'], { encoding: 'utf8', timeout: 420_000 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6m-loop-cancel-publish', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1000) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/loop-cancel-publish/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && e.loopStatus === 'cancelled' && e.runStatus === 'cancelled' && e.prCreates === 0;
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6m-loop-cancel-publish-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/loop-cancel-publish/run.json' });
  }
}
// 质量门缺证终态：零 Draft、零发布分支、Loop blocked。
{
  const run = spawnSync(process.execPath, ['scripts/loop-quality-gate-e2e.mjs'], { encoding: 'utf8', timeout: 180_000 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6n-loop-quality-gate', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1000) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/loop-quality-gate/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && e.loopStatus === 'blocked' && e.prCreates === 0 && e.bareBranches === '';
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6n-loop-quality-gate-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/loop-quality-gate/run.json' });
  }
}
// GitHub 发布/CI/正式验收恢复：裸 Git + 回环 GitHub API，重复 Draft 创建=0。
{
  const run = spawnSync(process.execPath, ['scripts/github-publish-recovery-e2e.mjs'], { encoding: 'utf8', timeout: 180_000 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6g-github-publish-recovery', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1000) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/github-publish/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && e.creates === 1 && e.ci?.conclusion === 'success' && e.acceptedSha === e.verifiedSha && e.action?.recovered === true && e.mismatchNegative?.blocked === true && e.nonDraftRejected?.blocked === true && e.revokedDuringGet?.blocked === true && typeof e.createPrDisabled?.blocked === 'string' && e.createPrDisabled.creates === 1;
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6g-github-publish-recovery-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/github-publish/run.json' });
  }
}
// Loop 终态发布门控：裸 Git + 陈旧 Run 快照 + 终审失败/取消/ref 漂移零发布。
{
  const run = spawnSync(process.execPath, ['scripts/loop-terminal-e2e.mjs'], { encoding: 'utf8', timeout: 120_000 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6f-loop-terminal', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-800) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/loop-terminal/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && Object.values(e.negativeCases).every((v) => v === 0) && e.positiveCases.staleRunSnapshotReread === 1 && e.totalPublishCalls === 2;
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6f-loop-terminal-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/loop-terminal/run.json' });
  }
}
// Chat 旧库升级专项：fc5fbce 正式 HTTP 生成旧库，当前版本升级后四步物理发送 1/0/1/0。
{
  const run = spawnSync(process.execPath, ['scripts/chat-upgrade-e2e.mjs'], { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6e-chat-upgrade', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1000) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/chat-upgrade/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && Array.isArray(e.increments) && e.increments.join(',') === '1,0,1,0' && Number(e.legacyUnknownPreserved) === 0 && e.reservationsBefore === e.reservationsAfter;
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6e-chat-upgrade-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/chat-upgrade/run.json' });
  }
}
// 固定候选干净环境安装：HEAD 导出 → npm install → 启动 → 首个项目/Draft → CI → /accept。
{
  const run = spawnSync(process.execPath, ['scripts/install-acceptance-e2e.mjs'], { encoding: 'utf8', timeout: 360_000, maxBuffer: 32 * 1024 * 1024 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6l-install-acceptance', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1200) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/install-acceptance/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && e.installExitCode === 0 && e.firstDraft?.creates === 1 && e.acceptedSha === e.finalSha && e.packageVersion === '3.3.0';
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6l-install-acceptance-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/install-acceptance/run.json' });
  }
}
// 同 SHA CI 统一证据与 /accept：绿/红/待定转绿/缺必需检查/异 SHA/历史无证据 + 审计 SHA 推送源。
{
  const run = spawnSync(process.execPath, ['scripts/ci-evidence-accept-e2e.mjs'], { encoding: 'utf8', timeout: 240_000 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6k-ci-evidence-accept', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1200) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/ci-evidence/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      const r = e.results || {};
      ok = e.candidateSha === head && r.sameShaGreen === 'accepted' && r.redRejected === true && r.pendingToGreen === 'accepted' && r.missingCheckRejected === true && r.foreignShaRejected === true && r.staleCiPassedRejected === true && r.auditedShaPushed?.remote === e.planHead && r.auditedShaPushed?.remote !== r.auditedShaPushed?.drift;
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6k-ci-evidence-accept-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/ci-evidence/run.json' });
  }
}
// 正式 REST+Supervisor+裸 Git+回环 GitHub：Loop 队列耗尽终态只发布审计 SHA、单 Draft、同 SHA CI、/accept。
{
  const run = spawnSync(process.execPath, ['scripts/loop-rest-publish-e2e.mjs'], { encoding: 'utf8', timeout: 240_000 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6j-loop-rest-publish', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1000) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/loop-rest-publish/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && e.status === 'completed' && e.bareHead === e.finalSha && e.prCreates === 1 && e.acceptedSha === e.finalSha;
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6j-loop-rest-publish-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/loop-rest-publish/run.json' });
  }
}
// 真实 Supervisor/Workbench 重启后认领原 Draft：A 运行中持久化动作，杀死 A 后 B 启动恢复并 /accept。
{
  const run = spawnSync(process.execPath, ['scripts/github-restart-recovery-e2e.mjs'], { encoding: 'utf8', timeout: 240_000 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6i-github-restart-recovery', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1000) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/github-restart-recovery/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      ok = e.candidateSha === head && e.draft?.creates === 0 && e.draft?.recovered === true && e.ci?.status === 'CI_PASSED' && e.accepted?.status === 'accepted' && e.accepted?.sha === e.planHead && e.ciActionRebuildWindow?.creates === 0 && e.ciActionRebuildWindow?.ciStatus === 'CI_PASSED' && e.ciActionRebuildWindow?.acceptedStatus === 'accepted';
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6i-github-restart-recovery-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/github-restart-recovery/run.json' });
  }
}
// 生产路径 Docker 交接：A 正式 REST/容器 writer，杀死 A 后 B 经 Supervisor cleanup/recovery 接管。
{
  const run = spawnSync(process.execPath, ['scripts/docker-production-handoff-e2e.mjs'], { encoding: 'utf8', timeout: 360_000, maxBuffer: 32 * 1024 * 1024 });
  let ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: '6h-docker-production-handoff', status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1200) });
  if (ok) {
    try {
      const e = JSON.parse(fs.readFileSync('demo/evidence/docker-production-handoff/run.json', 'utf8'));
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      const n = e.scenarios?.normal || {}; const c = e.scenarios?.cleanupFailure || {};
      ok = e.candidateSha === head && n.oldStillAliveAfterAKill === true && n.ordering?.oldExitBeforeNewFirstWrite === true && Number(n.b?.fence) > Number(n.a?.fence) && n.a?.container?.labels?.['ai-workbench.run-id'] === n.b?.container?.labels?.['ai-workbench.run-id'] && c.blocked === true && c.secondWriterWrites === 0 && c.oldContainerStillRunning === true && (c.healthB === false || ['paused','blocked'].includes(c.runStatus));
    } catch { ok = false; }
    if (!ok) hardFailure = true;
    results.push({ name: '6h-docker-production-handoff-evidence', status: ok ? 'PASS' : 'FAIL', evidence: 'demo/evidence/docker-production-handoff/run.json' });
  }
}
// 真实 Docker 两项专项：每次冻结都实际执行，不接受手填摘要或仅 daemon 在线。
for (const spec of [
  { name: '6c-docker-two-process-handoff', script: 'scripts/docker-handoff-e2e.mjs', evidence: 'demo/evidence/docker-handoff/run.json' },
  { name: '6d-docker-product-e2e', script: 'scripts/docker-product-e2e.mjs', evidence: 'demo/evidence/offline-e2e/run.json' },
]) {
  if (!fs.existsSync(spec.script)) { results.push({ name: spec.name, status: 'UNEXECUTED', missing: spec.script }); hardFailure = true; continue; }
  const run = spawnSync(process.execPath, [spec.script], { encoding: 'utf8', timeout: 360_000, maxBuffer: 32 * 1024 * 1024 });
  const ok = run.status === 0;
  if (!ok) hardFailure = true;
  results.push({ name: spec.name, status: ok ? 'PASS' : 'FAIL', code: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-1200) });
  if (!ok) continue;
  try {
    const e = JSON.parse(fs.readFileSync(spec.evidence, 'utf8'));
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    let valid = e.candidateSha === head;
    if (spec.name.includes('handoff')) valid = valid && e.ordering?.oldLastWriteBeforeExit === true && e.ordering?.oldExitBeforeNewFirstWrite === true && e.cleanupFailure?.secondWriterStarted === false && e.processes?.length === 2 && e.processes[0].fence < e.processes[1].fence;
    else valid = valid && e.productSha && e.runIds?.length === 2 && e.contractHash && e.initialFailure === true && e.finalAudit === 'PASS' && e.status === 'awaiting_acceptance' && (e.cleanClone?.initial === 'FAIL_AS_EXPECTED' || e.cleanClone?.initialBehavior === 'FAIL_AS_EXPECTED') && (e.cleanClone?.final === 'PASS' || e.cleanClone?.finalBehavior === 'PASS') && fs.existsSync(path.join('demo/evidence/offline-e2e','product.bundle'));
    if (!valid) hardFailure = true;
    results.push({ name: spec.name + '-evidence', status: valid ? 'PASS' : 'FAIL', evidence: spec.evidence, reason: valid ? '' : '证据未绑定当前候选 SHA 或字段/时序/clean-clone 不符' });
  } catch (err) { hardFailure = true; results.push({ name: spec.name + '-evidence', status: 'FAIL', reason: err.message }); }
}
// 真实 Docker 与连续离线产品 E2E 是第六组必跑项；未提供证据时明确标 UNEXECUTED，不得静默通过。
try {
  const docker = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 10_000 });
  const dockerOk = docker.status === 0;
  results.push({ name: '6a-real-docker', status: dockerOk ? 'AVAILABLE' : 'UNEXECUTED', reason: dockerOk ? '' : 'docker info failed' });
  if (!dockerOk) hardFailure = true;
} catch (err) { results.push({ name: '6a-real-docker', status: 'UNEXECUTED', reason: err.message }); hardFailure = true; }
const e2eEvidence = ['demo/evidence/offline-e2e/run.json', 'demo/evidence/offline-e2e/report.json'].find((f) => fs.existsSync(f));
if (!e2eEvidence) { results.push({ name: '6b-offline-product-e2e', status: 'UNEXECUTED', reason: '缺少同一候选 SHA 的连续离线产品 E2E 证据' }); hardFailure = true; }
else {
  try {
    const e = JSON.parse(fs.readFileSync(e2eEvidence, 'utf8'));
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const ok = e.candidateSha === head && e.productSha && e.projectId && e.contractHash && e.status === 'awaiting_acceptance' && e.runIds?.length > 0 && e.initialFailure && e.finalAudit === 'PASS';
    if (!ok) hardFailure = true;
    results.push({ name: '6b-offline-product-e2e', status: ok ? 'PASS' : 'FAIL', path: e2eEvidence, candidateSha: e.candidateSha, productSha: e.productSha, reason: ok ? '' : '证据未绑定当前候选 SHA/项目/契约/产品 SHA/awaiting_acceptance' });
  } catch (err) { hardFailure = true; results.push({ name: '6b-offline-product-e2e', status: 'FAIL', reason: err.message }); }
}

for (const r of results) console.log(JSON.stringify(r));
console.log(JSON.stringify({ ok: !hardFailure, groups: results.length, at: new Date().toISOString() }));
process.exitCode = hardFailure ? 1 : 0;
