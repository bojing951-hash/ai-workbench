// SPDX-License-Identifier: Apache-2.0
/** 按用户可复制命令在干净克隆中安装、启动 Supervisor、检查 health，并跑离线首个 Draft/验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const NODE = process.execPath; const REPO = process.cwd();
const SHA = String(process.env.CANDIDATE_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim());
const EVIDENCE_DIR = path.resolve(process.env.TRIAL_EVIDENCE_DIR || 'demo/evidence/fixed-sha-trial');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-trial-'));
const clean = path.join(root, 'ai-workbench');
const commands = {
  clone: `git clone ${REPO} ${clean}`,
  checkout: `git checkout ${SHA}`,
  verify: `test "$(git rev-parse HEAD)" = "${SHA}"`,
  install: 'npm install --ignore-scripts --no-audit --no-fund',
  test: 'npm test (covered by CI test job; omitted in trial script for time)',
  trial: 'node scripts/install-acceptance-e2e.mjs',
  start: 'npm start',
  health: 'curl -fsS http://127.0.0.1:<port>/api/health',
};
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 90_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return { ok: true, status: r.status, body: await r.text() }; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } return { ok: false }; }
try {
  const clone = spawnSync('git', ['clone', '--no-local', REPO, clean], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(clone.status, 0, `${clone.stdout || ''}${clone.stderr || ''}`.slice(-1000));
  const checkout = spawnSync('git', ['checkout', SHA], { cwd: clean, encoding: 'utf8', timeout: 60_000 });
  assert.equal(checkout.status, 0, `${checkout.stdout || ''}${checkout.stderr || ''}`.slice(-1000));
  const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: clean, encoding: 'utf8' }).stdout.trim();
  assert.equal(actual, SHA, 'clean clone must checkout exact candidate SHA');
  const install = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: clean, encoding: 'utf8', timeout: 300_000, env: { ...process.env, npm_config_update_notifier: 'false' } });
  assert.equal(install.status, 0, `${install.stdout || ''}${install.stderr || ''}`.slice(-1200));
  const packageJson = JSON.parse(fs.readFileSync(path.join(clean, 'package.json'), 'utf8'));
  // 用户启动命令：npm start → Supervisor/Workbench，检查 /api/health。
  const port = await freePort();
  const startLog = fs.openSync(path.join(root, 'start.log'), 'a');
  const start = spawn('npm', ['start'], { cwd: clean, env: { ...process.env, WORKBENCH_ROOT: clean, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1' }, stdio: ['ignore', startLog, startLog] });
  let health;
  try { health = await waitHealth(port); } finally { try { start.kill('SIGKILL'); } catch { /* ignore */ } }
  assert.equal(health.ok, true, fs.readFileSync(path.join(root, 'start.log'), 'utf8').slice(-1200));
  // 离线首个 Draft + 同 SHA 验收（install-acceptance 会从干净树再安装并启动 Supervisor）。
  const trialEvidence = path.join(root, 'trial-evidence');
  const trial = spawnSync(NODE, [path.join(clean, 'scripts/install-acceptance-e2e.mjs')], { cwd: clean, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, INSTALL_EVIDENCE_DIR: trialEvidence, CANDIDATE_SHA: SHA } });
  assert.equal(trial.status, 0, `${trial.stdout || ''}${trial.stderr || ''}`.slice(-2000));
  const installEvidence = JSON.parse(fs.readFileSync(path.join(trialEvidence, 'run.json'), 'utf8'));
  assert.equal(installEvidence.candidateSha, SHA);
  assert.equal(installEvidence.installExitCode, 0);
  assert.equal(installEvidence.firstDraft?.creates, 1);
  assert.ok(installEvidence.acceptedSha);
  assert.equal(installEvidence.acceptedSha, installEvidence.finalSha);
  const evidence = {
    kind: 'fixed-sha-trial', candidateSha: SHA, actualCheckout: actual, packageVersion: packageJson.version,
    commands, cleanRoot: root, installExitCode: install.status, startExitObserved: start.exitCode, health: { status: health.status, body: String(health.body || '').slice(0, 500) },
    firstDraft: installEvidence.firstDraft, productSha: installEvidence.finalSha, acceptedSha: installEvidence.acceptedSha,
    runs: installEvidence.runs, at: new Date().toISOString(),
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), candidateSha: SHA, health: health.status, acceptedSha: installEvidence.acceptedSha, productSha: installEvidence.finalSha }));
  fs.rmSync(root, { recursive: true, force: true });
} catch (err) { console.error(err?.stack || err); process.exitCode = 1; }
