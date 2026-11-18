#!/usr/bin/env node
// 离线工程冻结总验收：六组分别运行；任何失败、跳过、必跑项未执行都返回非零。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const groups = [
  { name: '1-product-completion', files: ['tests/handoff-product-plan.test.js', 'tests/handoff-test-evidence.test.js', 'tests/handoff-audit-chunks.test.js', 'tests/v32-product-gate.test.js', 'tests/v35-product-audit-middiff.test.js'] },
  { name: '2-billing-unknown', files: ['tests/handoff-billing.test.js', 'tests/v35-loop-planner-ledger.test.js', 'tests/v35-usage-known.test.js', 'tests/v35-unknown-billing.test.js'] },
  { name: '3-paid-identity', files: ['tests/handoff-identity.test.js', 'tests/v35-paid-admission.test.js', 'tests/v35-audit-chunk-budget.test.js'] },
  { name: '4-checkpoint', files: ['tests/handoff-recovery-checkpoint.test.js', 'tests/v35-checkpoint.test.js', 'tests/v35-checkpoint-staged-rename.test.js', 'tests/v35-checkpoint-prepared-sigkill.test.js', 'tests/v35-checkpoint-publish-sigkill.test.js', 'tests/v35-checkpoint-published-sigkill.test.js', 'tests/v35-checkpoint-renamed-sigkill.test.js'] },
  { name: '5-git-sqlite', files: ['tests/handoff-recovery-commit.test.js', 'tests/v35-git-db-recovery.test.js'] },
  { name: '6-supervisor-docker-e2e', files: ['tests/handoff-supervisor.test.mjs', 'tests/v35-container-recovery.test.js'] },
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
// 真实 Docker 与连续离线产品 E2E 是第六组必跑项；未提供证据时明确标 UNEXECUTED，不得静默通过。
try {
  const docker = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 10_000 });
  const dockerOk = docker.status === 0;
  results.push({ name: '6a-real-docker', status: dockerOk ? 'AVAILABLE' : 'UNEXECUTED', reason: dockerOk ? '' : 'docker info failed' });
  if (!dockerOk) hardFailure = true;
} catch (err) { results.push({ name: '6a-real-docker', status: 'UNEXECUTED', reason: err.message }); hardFailure = true; }
const e2eEvidence = ['demo/evidence/offline-e2e/run.json', 'demo/evidence/offline-e2e/report.json'].find((f) => fs.existsSync(f));
if (!e2eEvidence) { results.push({ name: '6b-offline-product-e2e', status: 'UNEXECUTED', reason: '缺少同一候选 SHA 的连续离线产品 E2E 证据' }); hardFailure = true; }
else results.push({ name: '6b-offline-product-e2e', status: 'AVAILABLE', path: e2eEvidence });

for (const r of results) console.log(JSON.stringify(r));
console.log(JSON.stringify({ ok: !hardFailure, groups: results.length, at: new Date().toISOString() }));
process.exitCode = hardFailure ? 1 : 0;
