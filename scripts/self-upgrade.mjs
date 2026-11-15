#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 工作台自我升级验证脚本（P3）：
 *   1. 创建候选版本副本（不含 .env/data/projects/.git）
 *   2. 候选版本跑完整离线测试
 *   3. 在隔离端口 + 独立数据目录启动候选实例，做健康/状态/API 冒烟
 *   4. 可选：在候选实例上跑一个真实 DSH 小任务（会消耗真实 token，需 --real-e2e）
 *   5. 证据写入 demo/evidence/upgrade-*.json；失败时稳定版继续运行，不自动替换
 *
 * 用法：
 *   node scripts/self-upgrade.mjs                     # 离线测试 + 隔离实例冒烟
 *   node scripts/self-upgrade.mjs --real-e2e          # 再加一个真实任务（消耗模型 token）
 *   node scripts/self-upgrade.mjs --skip-server       # 只跑测试
 * 约束：不会合并主分支、不会自动替换当前运行实例、不会推送代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { createCandidate, verifyCandidate, startCandidateInstance, stopCandidateInstance, smokeInstalledApi } from '../src/upgrade.js';
import { sleep } from '../src/util.js';

const args = process.argv.slice(2);
const REAL_E2E = args.includes('--real-e2e');
const SKIP_SERVER = args.includes('--skip-server');

function sh(cmd, argv, cwd) {
  const res = spawnSync(cmd, argv, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} 失败：${res.stderr || res.stdout}`);
  return res.stdout;
}

function prepareDemoProject(candidateDir) {
  const src = path.join(candidateDir, 'demo', 'phase1-taskvault');
  const dest = path.join(candidateDir, 'projects', 'phase1-taskvault');
  if (!fs.existsSync(src)) throw new Error('候选目录缺少 demo/phase1-taskvault');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], dest);
  sh('git', ['config', 'user.name', 'Candidate E2E'], dest);
  sh('git', ['config', 'user.email', 'candidate@localhost'], dest);
  sh('git', ['add', '-A'], dest);
  sh('git', ['commit', '-qm', 'chore: candidate baseline'], dest);
  return dest;
}

async function api(port, method, apiPath, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-workbench-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(`${method} ${apiPath}: ${data?.error?.message || res.status}`);
  return data.data;
}

async function runRealE2E({ config, candidateDir, port, dataDir, instance }) {
  const tokenFile = path.join(dataDir, 'api-token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const projectPath = prepareDemoProject(candidateDir);
  const project = await api(port, 'POST', '/api/projects', token, {
    name: 'Candidate E2E TaskVault',
    repo: projectPath,
    testCommand: 'npm test',
    protectTests: true,
    remotePushAuthorized: false,
    ciRequired: false,
    auditProvider: 'glm',
  });
  const started = await api(port, 'POST', `/api/projects/${project.id}/runs`, token, {
    goal: '完成候选版本实例上的真实冒烟任务：实现 TaskVault 任务存储，使既有验收测试通过。',
    acceptance: [
      '运行项目测试命令 npm test 全部通过，且 tests/ 未被修改。',
      'src/store.js 导出 TaskStore 并实现 addTask/completeTask/listTasks/stats。',
    ],
    mode: 'single',
  });
  const deadline = Date.now() + 20 * 60 * 1000;
  let detail = null;
  while (Date.now() < deadline) {
    detail = await api(port, 'GET', `/api/runs/${started.runId}`, token);
    if (['awaiting_acceptance', 'paused', 'failed', 'cancelled', 'accepted'].includes(detail.status)) break;
    await sleep(3000);
  }
  return {
    runId: started.runId,
    status: detail?.status,
    verificationStatus: detail?.verification_status,
    tasks: (detail?.tasks || []).map((t) => ({ seq: t.seq, status: t.status, attempts: (t.attempts || []).length, audits: (t.audits || []).map((a) => a.verdict) })),
    stopReason: detail?.stop_reason || '',
  };
}

async function main() {
  const config = getConfig();
  console.log('创建候选版本副本…');
  const candidate = createCandidate({ config, sourceRoot: config.paths.root, label: 'v2-self-upgrade' });
  console.log(`候选目录：${candidate.dir}`);
  const result = await verifyCandidate({ config, candidateDir: candidate.dir, skipServer: SKIP_SERVER });
  console.log(`离线测试：${result.tests.ok ? 'PASS' : 'FAIL'}（${result.tests.durationMs}ms）`);
  if (result.smoke) console.log(`候选实例冒烟：${result.smoke.ok ? 'PASS' : 'FAIL'}（version=${result.smoke.version}, port=${result.smoke.port}）`);

  let realE2E = null;
  if (REAL_E2E && result.tests.ok) {
    console.log('在候选实例上执行真实 End-to-End 任务（消耗真实模型 token）…');
    const port = result.smoke?.port || (await import('../src/upgrade.js')).findFreePort();
    const instance = await startCandidateInstance({ config, candidateDir: candidate.dir, port: await port, allowModelKeys: true });
    try {
      if (!instance.healthy) throw new Error('候选实例启动失败，无法执行真实 E2E');
      realE2E = await runRealE2E({ config, candidateDir: candidate.dir, port: instance.port, dataDir: instance.dataDir, instance });
      console.log(`真实 E2E：${realE2E.status} / verification=${realE2E.verificationStatus}`);
    } finally {
      await stopCandidateInstance(instance);
    }
  }

  const evidence = {
    type: 'self-upgrade-candidate-validation',
    at: new Date().toISOString(),
    candidateId: candidate.id,
    candidateDir: candidate.dir,
    sourceRoot: config.paths.root,
    tests: { ok: result.tests.ok, code: result.tests.code, durationMs: result.tests.durationMs, logPath: result.tests.logPath },
    smoke: result.smoke,
    realE2E,
    passed: !!result.tests.ok && (SKIP_SERVER || !!result.smoke?.ok) && (!REAL_E2E || realE2E?.status === 'awaiting_acceptance'),
    stableInstanceUnaffected: true,
    note: '候选版本验证通过后才允许创建升级 PR；当前脚本不自动替换运行实例、不合并主分支。',
  };
  const evidenceDir = path.join(config.paths.root, 'demo', 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `upgrade-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`升级候选验证${evidence.passed ? '通过' : '未通过'}；证据：${path.relative(config.paths.root, file)}`);
  if (!evidence.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`自我升级验证失败：${err.message}`);
  process.exit(1);
});
