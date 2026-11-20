// SPDX-License-Identifier: Apache-2.0
/** 固定候选干净环境安装验收：从 HEAD 导出干净树 → npm install → 启动 → 首个项目 → 首个 Draft → CI → /accept。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const EVIDENCE_DIR = path.resolve(process.env.INSTALL_EVIDENCE_DIR || 'demo/evidence/install-acceptance');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-install-'));
const clean = path.join(root, 'ai-workbench');
fs.mkdirSync(clean, { recursive: true });
const candidateSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const archive = spawnSync('git', ['archive', candidateSha], { cwd: REPO, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
assert.equal(archive.status, 0, String(archive.stderr || '').slice(0, 500));
const untar = spawnSync('tar', ['-x', '-C', clean], { input: archive.stdout });
assert.equal(untar.status, 0, String(untar.stderr || ''));
const install = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: clean, encoding: 'utf8', timeout: 300_000, env: { ...process.env, npm_config_update_notifier: 'false' } });
assert.equal(install.status, 0, `${install.stdout || ''}\n${install.stderr || ''}`.slice(-1000));
const evidencePath = path.join(clean, 'install-loop-evidence');
const run = spawnSync(process.execPath, [path.join(clean, 'scripts/loop-rest-publish-e2e.mjs')], { cwd: clean, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LOOP_REST_EVIDENCE_DIR: evidencePath, CANDIDATE_SHA: candidateSha } });
assert.equal(run.status, 0, `${run.stdout || ''}\n${run.stderr || ''}`.slice(-2000));
const loopEvidence = JSON.parse(fs.readFileSync(path.join(evidencePath, 'run.json'), 'utf8'));
assert.equal(loopEvidence.candidateSha, candidateSha);
assert.equal(loopEvidence.status, 'completed');
assert.equal(loopEvidence.prCreates, 1);
assert.equal(loopEvidence.acceptedSha, loopEvidence.finalSha);
const packageJson = JSON.parse(fs.readFileSync(path.join(clean, 'package.json'), 'utf8'));
const evidence = { kind: 'clean-install-first-draft-acceptance', candidateSha, packageVersion: packageJson.version, cleanRoot: root, commands: { export: `git archive ${candidateSha} | tar -x -C <clean>`, install: 'npm install --ignore-scripts --no-audit --no-fund', launch: 'node scripts/loop-rest-publish-e2e.mjs (starts Supervisor/Workbench)' }, installExitCode: install.status, installOutput: `${install.stdout || ''}${install.stderr || ''}`.slice(-1000), firstProject: loopEvidence.projectId, firstLoop: loopEvidence.loopId, firstDraft: { creates: loopEvidence.prCreates, number: loopEvidence.prNumber }, finalSha: loopEvidence.finalSha, acceptedSha: loopEvidence.acceptedSha, runs: loopEvidence.runIds, at: new Date().toISOString() };
fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), candidateSha, installExit: install.status, acceptedSha: evidence.acceptedSha }));
fs.rmSync(root, { recursive: true, force: true });
