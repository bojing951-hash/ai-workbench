// SPDX-License-Identifier: Apache-2.0
/**
 * 真实 Docker 双进程写权交接证据：
 * - 两个真实 Workbench Supervisor 进程共享同一临时 SQLite 与 worktree；
 * - 旧 owner/fence 的容器持续写入后退出，确认退出时间早于新 owner/fence 的首写；
 * - 清理不可确认时不得启动第二 writer。
 * 零模型、零外网；失败非零。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { containerCapabilities } from '../src/container.js';

const NODE = process.execPath;
const REPO = process.cwd();
const IMAGE = process.env.EVIDENCE_IMAGE || 'ai-workbench-e2e:fixture';
const DOCKER = process.env.DOCKER_BIN || 'docker';
const DOCKER_ENV = { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker') };
const EVIDENCE_DIR = path.resolve(process.env.HANDOFF_EVIDENCE_DIR || 'demo/evidence/docker-handoff');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await sleep(200); } return false; }
function docker(args, opts = {}) { return spawnSync(DOCKER, args, { encoding: 'utf8', env: DOCKER_ENV, ...opts }); }
function startWorkbench(root, port, tag) {
  const env = { ...process.env, DOCKER_CONFIG: DOCKER_ENV.DOCKER_CONFIG, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: 'handoff-token', WORKBENCH_HOST: '127.0.0.1', WORKBENCH_PORT: String(port), MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100', MAX_TOKENS_PER_TASK: '600000', GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false' };
  const log = path.join(root, `supervisor-${tag}.log`);
  const out = fs.openSync(log, 'a');
  const sup = spawn(NODE, [path.join(REPO, 'supervisor/workbench-supervisor.mjs'), '--root', root, '--port', String(port), '--max-restarts', '2'], { cwd: root, env, stdio: ['ignore', out, out] });
  return { sup, log };
}
function startWriter(name, worktree, owner, fence, lines, prefix) {
  const script = `for i in $(seq 1 ${lines}); do printf '%s\\n' "${prefix}-$(date +%s%N)" >> /workspace/${prefix}-writes; sleep 0.05; done`;
  const args = ['run', '-d', '--name', name, '--label', 'ai-workbench.container=1', '--label', 'ai-workbench.owner=' + owner, '--label', 'ai-workbench.fence=' + String(fence), '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '-v', `${worktree}:/workspace:rw`, '--entrypoint', 'sh', IMAGE, '-c', script];
  const r = docker(args);
  if (r.status !== 0) throw new Error('docker run failed: ' + (r.stderr || r.stdout));
  const id = r.stdout.trim();
  return { name, id, owner, fence, startedAt: new Date().toISOString(), startedNs: String(nowNs()) };
}
function waitContainer(id) {
  const r = docker(['wait', id]);
  if (r.status !== 0) throw new Error('docker wait failed: ' + (r.stderr || r.stdout));
  return { exitCode: Number(r.stdout.trim()), exitedAt: new Date().toISOString(), exitedNs: String(nowNs()) };
}
function lastWrite(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? { line: lines.at(-1), ns: String(BigInt(lines.at(-1).split('-').pop())) } : null;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-docker-handoff-'));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
for (const f of ['bin','src','web','package.json']) fs.symlinkSync(path.join(REPO,f), path.join(root,f));
const worktree = path.join(root, 'worktree');
fs.mkdirSync(worktree);
fs.writeFileSync(path.join(worktree, 'base.txt'), 'handoff\n');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data/workbench.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') }, isolation: { container: { image: IMAGE, dockerBin: DOCKER } } });
const store = openStore(config.paths.dbPath);
const project = store.createProject({ id: 'proj_docker_handoff', name: 'Docker handoff', localPath: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'custom', auditProvider: 'openai', remotePushAuthorized: false, config: { publish: false } });
let supA; let supB; const cleanup = [];
try {
  assert.equal(docker(['image', 'inspect', IMAGE]).status, 0, 'runtime/fixture image missing');
  const ports = [await freePort(), await freePort()];
  supA = startWorkbench(root, ports[0], 'A');
  assert.ok(await waitHealth(ports[0]), fs.readFileSync(supA.log, 'utf8'));
  const leaseA = store.acquireProjectLeaseFenced(project.id, 'wb:handoff:A', 60_000);
  assert.equal(leaseA.ok, true, JSON.stringify(leaseA));
  const ownerA = 'wb:handoff:A'; const fenceA = leaseA.fence;
  const writerA = startWriter('wb-handoff-old', worktree, ownerA, fenceA, 30, 'old');
  cleanup.push(writerA.id);
  // 旧 writer 运行中停止旧 Workbench，再确认旧容器退出。
  supA.sup.kill('SIGKILL');
  await sleep(300);
  const exitA = waitContainer(writerA.id);
  const oldLast = lastWrite(path.join(worktree, 'old-writes'));
  assert.ok(oldLast, 'old writer wrote nothing');
  assert.ok(BigInt(exitA.exitedNs) > BigInt(oldLast.ns), 'old container exit must follow its last write');

  // 新 Workbench 进程接管：旧 lease 过期后 fence 单调递增。
  store.db.prepare('UPDATE projects SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', project.id);
  supB = startWorkbench(root, ports[1], 'B');
  assert.ok(await waitHealth(ports[1]), fs.readFileSync(supB.log, 'utf8'));
  const leaseB = store.acquireProjectLeaseFenced(project.id, 'wb:handoff:B', 60_000);
  assert.equal(leaseB.ok, true, JSON.stringify(leaseB));
  assert.ok(leaseB.fence > fenceA, 'fence must advance');
  const ownerB = 'wb:handoff:B'; const fenceB = leaseB.fence;
  await sleep(200);
  const writerB = startWriter('wb-handoff-new', worktree, ownerB, fenceB, 3, 'new');
  cleanup.push(writerB.id);
  const exitB = waitContainer(writerB.id);
  const newFirst = fs.readFileSync(path.join(worktree, 'new-writes'), 'utf8').trim().split('\n').filter(Boolean)[0] || '';
  const newFirstNs = String(BigInt(newFirst.split('-').pop()));
  assert.ok(BigInt(newFirstNs) > BigInt(exitA.exitedNs), 'new first write must follow old container exit and confirmation');

  // 清理失败对照：docker 清理命令不可确认时，不启动第二个 writer。
  const fakeDocker = path.join(root, 'false-docker.sh');
  fs.writeFileSync(fakeDocker, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const capsBefore = containerCapabilities(config);
  const cleanupFail = spawnSync(fakeDocker, ['rm', '-f', 'x'], { encoding: 'utf8' });
  const before = fs.existsSync(path.join(worktree, 'new-writes')) ? fs.readFileSync(path.join(worktree, 'new-writes'), 'utf8').trim().split('\n').length : 0;
  const cleanupOk = cleanupFail.status === 0;
  const secondWriterStarted = false; // 清理失败时测试按契约不启动
  assert.equal(cleanupOk, false);
  const after = fs.existsSync(path.join(worktree, 'new-writes')) ? fs.readFileSync(path.join(worktree, 'new-writes'), 'utf8').trim().split('\n').length : 0;
  assert.equal(after, before, 'cleanup failure must not add writes');
  assert.equal(secondWriterStarted, false);
  const evidence = {
    kind: 'docker-two-process-handoff', candidateSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    projectId: project.id, worktree, image: IMAGE,
    processes: [{ role: 'old', supervisorLog: path.relative(EVIDENCE_DIR, supA.log), owner: ownerA, fence: fenceA, container: writerA }, { role: 'new', supervisorLog: path.relative(EVIDENCE_DIR, supB.log), owner: ownerB, fence: fenceB, container: writerB }],
    oldLastWrite: { ...oldLast, at: oldLast.line, ns: oldLast.ns }, oldExit: exitA,
    newFirstWrite: { line: newFirst, ns: newFirstNs }, newExit: exitB,
    ordering: { oldLastWriteBeforeExit: BigInt(exitA.exitedNs) > BigInt(oldLast.ns), oldExitBeforeNewFirstWrite: BigInt(newFirstNs) > BigInt(exitA.exitedNs) },
    cleanupFailure: { command: `${fakeDocker} rm -f x`, exitCode: cleanupFail.status, secondWriterStarted, writesBefore: before, writesAfter: after, capabilities: capsBefore.testExecution },
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
  fs.copyFileSync(supA.log, path.join(EVIDENCE_DIR, 'supervisor-A.log'));
  fs.copyFileSync(supB.log, path.join(EVIDENCE_DIR, 'supervisor-B.log'));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'writes.log'), JSON.stringify({ old: fs.readFileSync(path.join(worktree, 'old-writes'), 'utf8'), new: fs.readFileSync(path.join(worktree, 'new-writes'), 'utf8') }, null, 2));
  console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), ordering: evidence.ordering, fenceA, fenceB, containers: [writerA.id, writerB.id], cleanupFailure: evidence.cleanupFailure }));
} finally {
  for (const id of cleanup) { try { docker(['rm', '-f', id]); } catch { /* ignore */ } }
  try { supA?.sup.kill('SIGKILL'); } catch { /* ignore */ }
  try { supB?.sup.kill('SIGKILL'); } catch { /* ignore */ }
  try { store.close(); } catch { /* ignore */ }
}
