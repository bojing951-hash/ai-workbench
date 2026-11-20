// SPDX-License-Identifier: Apache-2.0
/**
 * 生产路径 Docker 双进程交接：
 * A 经正式 REST → Loop → 生产容器适配器启动持续 writer；
 * 杀死 A Supervisor+子进程后旧容器仍在；B 启动走官方 cleanup/recovery 接管同一 Run/worktree；
 * 记录真实 lease/fence、容器退出确认和新 writer 首写时序；清理失败对照阻止第二 writer。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const NODE = process.execPath;
const REPO = process.cwd();
const IMAGE = process.env.PROD_HANDOFF_IMAGE || 'ai-workbench-e2e:longwriter';
const DOCKER = process.env.DOCKER_BIN || 'docker';
const DOCKER_CONFIG = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');
const EVIDENCE_DIR = path.resolve(process.env.PROD_HANDOFF_EVIDENCE_DIR || 'demo/evidence/docker-production-handoff');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await sleep(300); } return false; }
async function api(port, token, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
function docker(args, opts = {}) { const e = { ...process.env, DOCKER_CONFIG }; return spawnSync(DOCKER, args, { encoding: 'utf8', env: e, ...opts }); }
function dockerIdByProject(projectId) {
  const r = docker(['ps', '--filter', 'label=ai-workbench.container=1', '--filter', `label=ai-workbench.project-id=${projectId}`, '--format', '{{.ID}}']);
  return (r.stdout || '').trim().split('\n').filter(Boolean)[0] || '';
}
function containerInfo(id) {
  const f = docker(['inspect', '-f', '{{json .Config.Labels}}|{{.State.Running}}|{{.State.StartedAt}}|{{json .Mounts}}', id]);
  if (f.status !== 0) return null;
  const [labelsJson, running, started, mountsJson] = String(f.stdout).trim().split('|');
  let labels = {}; let mounts = []; try { labels = JSON.parse(labelsJson); } catch { /* ignore */ } try { mounts = JSON.parse(mountsJson); } catch { /* ignore */ }
  const workspace = mounts.find((m) => m.Destination === '/workspace')?.Source || '';
  return { id, labels, running: running === 'true', startedAt: started, workspace };
}
function writesFor(worktree, hostPrefix) {
  const f = path.join(worktree, 'writer-writes');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter((x) => x.startsWith(hostPrefix + '-')).map((line) => ({ line, ns: line.split('-').at(-1) }));
}
function startSupervisor(root, port, tag, extraEnv = {}) {
  const env = { ...process.env, DOCKER_CONFIG, HOME: root, WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'), WORKBENCH_API_TOKEN: 'prod-handoff-token', WORKBENCH_HOST: '127.0.0.1', WORKBENCH_PORT: String(port), CONTAINER_IMAGE: IMAGE, CLAUDE_BIN: '/usr/bin/true', CLAUDE_API_KEY: 'fixture', CLAUDE_BASE_URL: 'http://127.0.0.1:9', GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false', GITHUB_AUTO_CREATE_REPO: 'false', MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100', MAX_TOKENS_PER_TASK: '600000', AUTO_RESUME_ON_BOOT: 'true', ...extraEnv };
  const log = path.join(root, `supervisor-${tag}.log`); const out = fs.openSync(log, 'a');
  const sup = spawn(NODE, [path.join(REPO, 'supervisor/workbench-supervisor.mjs'), '--root', root, '--port', String(port), '--max-restarts', '2'], { cwd: root, env, stdio: ['ignore', out, out] });
  return { sup, log, env };
}
function prepareRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wb-prod-handoff-${tag}-`));
  for (const f of ['bin', 'src', 'web', 'package.json']) fs.symlinkSync(path.join(REPO, f), path.join(root, f));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const worktree = path.join(root, 'product'); fs.mkdirSync(worktree);
  const git = (args) => { const r = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(worktree, 'README.md'), '# writer\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
  return { root, worktree, git };
}
async function startWriterRun(port, root, worktree, name) {
  const reg = await api(port, 'prod-handoff-token', 'POST', '/api/projects', { name, repo: worktree, defaultBranch: 'main', testCommand: 'true', agentKind: 'claude', agentIsolation: 'docker', auditProvider: 'openai', ciRequired: false, supervisorManaged: true, contractFiles: [], testPlan: { acceptance: [] }, publish: false, allowLocalAcceptance: true });
  assert.equal(reg.status, 201, JSON.stringify(reg)); const projectId = reg.data.data.id;
  const loop = await api(port, 'prod-handoff-token', 'POST', `/api/projects/${projectId}/loops`, { goal: '持续写入直到被清理停止', mode: 'queue', maxRounds: 1, queue: [{ title: '持续 writer', description: 'writer', agent: 'claude', acceptance: ['写入'], testCommand: 'true' }] });
  assert.equal(loop.status, 201, JSON.stringify(loop)); const loopId = loop.data.data.id;
  const end = Date.now() + 90_000; let id = '';
  while (Date.now() < end) { id = dockerIdByProject(projectId); if (id) break; await sleep(300); }
  assert.ok(id, '生产容器 writer 未启动');
  const info = containerInfo(id); assert.ok(info && info.running);
  assert.ok(info.workspace, '容器 workspace 挂载点缺失');
  const wend = Date.now() + 30_000;
  while (Date.now() < wend) { const f = path.join(info.workspace, 'writer-writes'); if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim().length) break; await sleep(200); }
  const runs = (await api(port, 'prod-handoff-token', 'GET', '/api/state')).data.data.runs.filter((r) => r.project_id === projectId);
  assert.ok(runs.length > 0); const runId = runs[0].id;
  return { projectId, loopId, runId, containerId: id, container: info, agentWorktree: info.workspace, owner: info.labels['ai-workbench.owner'], fence: Number(info.labels['ai-workbench.fence']) };
}
function killA(sup, root) {
  const stateFile = path.join(root, 'data/supervisor/state.json');
  let childPid = 0; try { childPid = Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).childPid || 0); } catch { /* ignore */ }
  try { sup.kill('SIGKILL'); } catch { /* ignore */ }
  if (childPid > 0) { try { process.kill(childPid, 'SIGKILL'); } catch { /* ignore */ } }
  return { childPid };
}
function waitDockerExit(id) { return new Promise((resolve) => { const p = spawn(DOCKER, ['wait', id], { env: { ...process.env, DOCKER_CONFIG } }); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', () => resolve({ id, exitCode: Number(String(out).trim()), at: new Date().toISOString(), ns: String(BigInt(Date.now()) * 1_000_000n) })); }); }

const evidence = { kind: 'docker-production-handoff', candidateSha: '', image: IMAGE, scenarios: {} };
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
// 场景 1：正常接管
{
  const { root, worktree } = prepareRoot('normal');
  const portA = await freePort();
  const A = startSupervisor(root, portA, 'A');
  assert.ok(await waitHealth(portA), fs.readFileSync(A.log, 'utf8'));
  const w = await startWriterRun(portA, root, worktree, 'production handoff normal');
  const oldHost = (() => { const f = path.join(w.agentWorktree, 'writer-writes'); const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []; return lines.at(-1)?.split('-')[0] || ''; })();
  assert.ok(oldHost, 'old writer host unknown');
  const exitPromise = waitDockerExit(w.containerId);
  const killed = killA(A.sup, root);
  await sleep(800);
  const still = containerInfo(w.containerId);
  assert.ok(still?.running, '旧容器在杀死 A 后必须仍活着');
  const portB = await freePort();
  const B = startSupervisor(root, portB, 'B');
  const healthB = await waitHealth(portB, 120_000);
  assert.ok(healthB, fs.readFileSync(B.log, 'utf8'));
  const oldExit = await exitPromise;
  // B 恢复：若 Run 被暂停，走正式 REST resume。
  let resumed = false;
  for (let i = 0; i < 30; i += 1) {
    const st = await api(portB, 'prod-handoff-token', 'GET', '/api/state');
    const run = (st.data?.data?.runs || []).find((r) => r.id === w.runId);
    if (run?.status === 'paused' || run?.status === 'interrupted') { await api(portB, 'prod-handoff-token', 'POST', `/api/runs/${w.runId}/resume`, {}); resumed = true; }
    const id = dockerIdByProject(w.projectId); if (id && id !== w.containerId) break;
    await sleep(500);
  }
  const newId = dockerIdByProject(w.projectId);
  assert.ok(newId && newId !== w.containerId, fs.readFileSync(B.log, 'utf8'));
  const newInfo = containerInfo(newId);
  assert.ok(newInfo?.running);
  let newFirst = null; const end = Date.now() + 30_000;
  while (Date.now() < end) { const lines = fs.readFileSync(path.join(w.agentWorktree, 'writer-writes'), 'utf8').trim().split('\n').filter(Boolean); const candidate = lines.find((l) => l.split('-')[0] !== oldHost); if (candidate) { newFirst = { line: candidate, ns: candidate.split('-').at(-1) }; break; } await sleep(200); }
  assert.ok(newFirst, '新 writer 首写缺席');
  assert.ok(BigInt(newFirst.ns) > BigInt(oldExit.ns), '新 writer 首写必须晚于旧容器退出确认');
  evidence.scenarios.normal = { a: { supervisorLog: path.relative(EVIDENCE_DIR, A.log), childPid: killed.childPid, container: w.container, owner: w.owner, fence: w.fence }, b: { supervisorLog: path.relative(EVIDENCE_DIR, B.log), container: newInfo, owner: newInfo.labels['ai-workbench.owner'], fence: Number(newInfo.labels['ai-workbench.fence']), resumed }, oldStillAliveAfterAKill: !!still?.running, oldExit, newFirstWrite: newFirst, ordering: { oldExitBeforeNewFirstWrite: BigInt(newFirst.ns) > BigInt(oldExit.ns) }, db: await (async () => { const st = await api(portB, 'prod-handoff-token', 'GET', `/api/runs/${w.runId}`); return { status: st.data?.data?.status, runId: w.runId, loopId: w.loopId, projectId: w.projectId }; })() };
  try { B.sup.kill('SIGKILL'); } catch { /* ignore */ }
  try { const s = JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor/state.json'), 'utf8')); if (s.childPid) process.kill(s.childPid, 'SIGKILL'); } catch { /* ignore */ }
  docker(['rm', '-f', newId]);
}
// 场景 2：B 清理失败 -> 正式状态阻断且无第二 writer
{
  const { root, worktree } = prepareRoot('cleanupfail');
  const portA = await freePort(); const A = startSupervisor(root, portA, 'A');
  assert.ok(await waitHealth(portA), fs.readFileSync(A.log, 'utf8'));
  const w = await startWriterRun(portA, root, worktree, 'production handoff cleanup fail');
  const oldHost = fs.readFileSync(path.join(w.agentWorktree, 'writer-writes'), 'utf8').trim().split('\n').filter(Boolean).at(-1).split('-')[0];
  killA(A.sup, root); await sleep(800);
  assert.ok(containerInfo(w.containerId)?.running, '旧容器必须仍活着');
  const wrapper = path.join(root, 'fail-docker.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in rm|inspect) echo "injected cleanup failure" >&2; exit 1;; esac\nexec ${JSON.stringify(DOCKER)} "$@"\n`, { mode: 0o755 });
  const portB = await freePort(); const B = startSupervisor(root, portB, 'B', { DOCKER_BIN: wrapper });
  const healthB = await waitHealth(portB, 60_000);
  await sleep(1500);
  const newId = dockerIdByProject(w.projectId);
  const blocked = !healthB || !newId;
  assert.ok(blocked, '清理失败时不得启动第二 writer/健康 B');
  const writes = fs.readFileSync(path.join(w.agentWorktree, 'writer-writes'), 'utf8').trim().split('\n').filter(Boolean);
  const secondHostWrites = writes.filter((l) => l.split('-')[0] !== oldHost);
  assert.equal(secondHostWrites.length, 0, '清理失败时不得有第二 writer 写入');
  evidence.scenarios.cleanupFailure = { supervisorLog: path.relative(EVIDENCE_DIR, B.log), wrapper, healthB, newContainer: newId || null, oldContainerStillRunning: !!containerInfo(w.containerId)?.running, secondWriterWrites: secondHostWrites.length, blocked };
  try { B.sup.kill('SIGKILL'); } catch { /* ignore */ }
  try { const s = JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor/state.json'), 'utf8')); if (s.childPid) process.kill(s.childPid, 'SIGKILL'); } catch { /* ignore */ }
  docker(['rm', '-f', w.containerId]);
}
evidence.candidateSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
evidence.at = new Date().toISOString();
fs.writeFileSync(path.join(EVIDENCE_DIR, 'run.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, evidence: path.relative(REPO, path.join(EVIDENCE_DIR, 'run.json')), normal: evidence.scenarios.normal.ordering, cleanup: evidence.scenarios.cleanupFailure.blocked }));
