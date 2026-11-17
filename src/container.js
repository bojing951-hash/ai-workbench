// SPDX-License-Identifier: Apache-2.0
/**
 * Docker 容器执行适配器（v2.2）。
 *
 * 安全默认值：
 *  - 只挂载任务 worktree 到 /workspace（rw）和必要的只读配置目录；
 *  - 不挂载宿主根目录、HOME、Docker socket；
 *  - --network none（测试默认）、--cap-drop ALL、no-new-privileges、只读 rootfs、tmpfs /tmp；
 *  - 非 root 宿主用户运行、pids/memory/cpu 限制、--rm + 超时清理；
 *  - 环境变量通过 --env-file（0600 临时文件）传入，避免 docker inspect 泄露密钥。
 * Docker 不可用或镜像不存在时 fail-closed，不自动降级。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { execCapture } from './runner.js';
import { PolicyError } from './policy.js';

export const DEFAULT_IMAGE = 'ai-workbench-runtime:2.2';
const RUN_LABEL = 'ai-workbench.container';

export function containerConfig(config) {
  const c = config?.isolation?.container || {};
  return {
    image: c.image || config?.isolation?.testImage || DEFAULT_IMAGE,
    dockerBin: c.dockerBin || config?.isolation?.dockerBin || process.env.DOCKER_BIN || 'docker',
    memory: c.memory || '2g',
    cpus: c.cpus || '2',
    pidsLimit: Number(c.pidsLimit || 512),
    networkTest: c.networkTest || 'none',
    networkAgent: c.networkAgent || 'bridge',
    timeoutMs: Number(c.timeoutMs || 900_000),
  };
}

export function dockerAvailable({ dockerBin = 'docker' } = {}) {
  try {
    const res = execCaptureSync(dockerBin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
    return { available: res.code === 0, version: res.stdout.trim(), reason: res.code === 0 ? '' : res.stderr.slice(0, 300) };
  } catch (err) {
    return { available: false, version: '', reason: String(err?.message || err).slice(0, 300) };
  }
}

function execCaptureSync(cmd, args, { timeout = 5_000 } = {}) {
  // 轻量同步探测；仅在创建隔离能力时调用，不用于任务执行
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout, env: dockerEnv() });
  return { code: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || res.error?.message || '' };
}

export function imageAvailable({ dockerBin = 'docker', image = DEFAULT_IMAGE } = {}) {
  try {
    const res = execCaptureSync(dockerBin, ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 5_000 });
    return { available: res.code === 0, id: (res.stdout || '').trim(), reason: res.code === 0 ? '' : (res.stderr || '').slice(0, 300) };
  } catch (err) {
    return { available: false, id: '', reason: String(err?.message || err).slice(0, 300) };
  }
}

/**
 * 构造 docker run 参数。纯函数，便于单测核对安全边界。
 */
export function buildDockerArgs({
  image = DEFAULT_IMAGE,
  worktree,
  command,
  args = [],
  env = {},
  mounts = [],
  user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  network = 'none',
  memory = '2g',
  cpus = '2',
  pidsLimit = 512,
  envFile = '',
  name = '',
  stdin = false,
  entrypoint = 'sh',
  commandArgs = null,
  labels = {},
} = {}) {
  if (!worktree || !path.isAbsolute(worktree)) throw new PolicyError('CONTAINER_WORKTREE_INVALID', '容器执行需要绝对 worktree 路径');
  const mountTargets = [
    { source: path.resolve(worktree), target: '/workspace', mode: 'rw' },
    ...mounts.map((m) => ({ source: path.resolve(m.source), target: m.target, mode: m.mode || 'ro' })),
  ];
  for (const m of mountTargets) {
    if (m.source === '/' || m.source === os.homedir() || /docker\.sock$/.test(m.source)) {
      throw new PolicyError('CONTAINER_MOUNT_FORBIDDEN', `禁止挂载宿主敏感路径：${m.source}`);
    }
    if (!m.target.startsWith('/workspace') && !m.target.startsWith('/run/') && !m.target.startsWith('/config')) {
      throw new PolicyError('CONTAINER_MOUNT_FORBIDDEN', `挂载目标必须位于 /workspace、/run 或 /config：${m.target}`);
    }
  }
  const dockerArgs = [
    'run', '--rm', '-i',
    '--name', name || `${RUN_LABEL}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    '--label', `${RUN_LABEL}=1`,
    ...Object.entries(labels || {}).flatMap(([k, v]) => (v === undefined || v === null || v === '' ? [] : ['--label', `${k}=${String(v).replace(/[\r\n]/g, ' ').slice(0, 256)}`])),
    '--network', network,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--tmpfs', '/run:rw,nosuid,nodev,size=64m',
    '--pids-limit', String(pidsLimit),
    '--memory', String(memory),
    '--cpus', String(cpus),
    '--user', user,
    '--workdir', '/workspace',
  ];
  for (const m of mountTargets) dockerArgs.push('-v', `${m.source}:${m.target}:${m.mode}`);
  if (envFile) dockerArgs.push('--env-file', envFile);
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    dockerArgs.push('-e', `${key}=${value}`);
  }
  if (Array.isArray(commandArgs)) {
    dockerArgs.push('--entrypoint', entrypoint, image, ...commandArgs);
  } else {
    dockerArgs.push('--entrypoint', 'sh', image, '-c', command || '');
  }
  return dockerArgs;
}

function dockerEnv() {
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || os.tmpdir() };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function safeDockerEnv() {
  return dockerEnv();
}

export { dockerEnv, imageAvailable as probeImage };

export function writeEnvFile(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-container-env-'));
  const file = path.join(dir, 'env');
  const lines = Object.entries(env || {})
    .filter(([k, v]) => /^[A-Z][A-Z0-9_]*$/.test(k) && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return { file, dir };
}

/**
 * 在容器内执行测试命令。strict：Docker/镜像不可用直接阻塞，不降级。
 */
export async function runTestInContainer({
  config,
  worktree,
  command,
  env = {},
  timeoutMs = 0,
  logPath = '',
  signal = null,
  image = '',
  mounts = [],
  metadata = null,
} = {}) {
  const cc = containerConfig(config);
  const bin = cc.dockerBin;
  if (!dockerAvailable({ dockerBin: bin }).available) throw new PolicyError('CONTAINER_UNAVAILABLE', 'Docker daemon 不可用，容器测试已阻塞（fail-closed，不降级）');
  const img = image || cc.image;
  const imgState = imageAvailable({ dockerBin: bin, image: img });
  if (!imgState.available) throw new PolicyError('CONTAINER_IMAGE_MISSING', `容器镜像不存在：${img}（请先构建 docker/runtime.Dockerfile）`);
  const tmp = writeEnvFile({ ...env, HOME: '/tmp/home', TMPDIR: '/tmp', CI: '1' });
  let args;
  try {
    args = buildDockerArgs({
      image: img,
      worktree,
      command: 'mkdir -p "$HOME" && ' + String(command || ''),
      network: cc.networkTest,
      memory: cc.memory,
      cpus: cc.cpus,
      pidsLimit: cc.pidsLimit,
      envFile: tmp.file,
      mounts: Array.isArray(mounts) ? mounts : [],
    });
  } catch (err) {
    cleanupEnvFile(tmp);
    throw err;
  }
  const name = args[args.indexOf('--name') + 1];
  try {
    const startedAt = Date.now();
    const res = await execCapture(bin, args, {
      cwd: worktree,
      env: safeDockerEnv(),
      timeoutMs: timeoutMs || cc.timeoutMs,
      logPath,
      signal,
    });
    return {
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
      durationMs: res.durationMs || Date.now() - startedAt,
      logPath,
      isolation: { backend: 'docker', image: img, network: cc.networkTest, readOnlyRoot: true, capDropAll: true, pidsLimit: cc.pidsLimit, memory: cc.memory, cpus: cc.cpus },
      containerName: name,
    };
  } finally {
    cleanupEnvFile(tmp);
    // --rm 已处理正常退出；超时/abort 时强制清理可能残留的容器
    try {
      execCapture(bin, ['rm', '-f', name], { env: safeDockerEnv(), timeoutMs: 10_000 }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

export function cleanupEnvFile({ file, dir }) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}


/**
 * 在容器内执行 Claude Code Agent。
 * 只挂载 worktree（rw）与隔离的 Claude 配置目录（/config），不挂载宿主 HOME/Docker socket。
 * 网络：默认 bridge（模型端点需要网络）；测试执行默认 none。网络白名单由 Docker 网络策略负责。
 */
export async function runAgentInContainer({
  config,
  worktree,
  agentHome,
  cliArgs = [],
  env = {},
  timeoutMs = 0,
  logPath = '',
  signal = null,
  stdin = null,
  image = '',
  network = '',
  metadata = null,
} = {}) {
  const cc = containerConfig(config);
  const bin = cc.dockerBin;
  if (!dockerAvailable({ dockerBin: bin }).available) throw new PolicyError('CONTAINER_UNAVAILABLE', 'Docker daemon 不可用，容器 Agent 已阻塞（fail-closed）');
  const img = image || cc.image;
  if (!imageAvailable({ dockerBin: bin, image: img }).available) throw new PolicyError('CONTAINER_IMAGE_MISSING', `容器镜像不存在：${img}`);
  const tmp = writeEnvFile({ ...env, HOME: '/tmp/home', TMPDIR: '/tmp', CI: '1', CLAUDE_CONFIG_DIR: '/config' });
  let args;
  try {
    args = buildDockerArgs({
      image: img, worktree, command: '', commandArgs: cliArgs, entrypoint: '/usr/local/bin/claude',
      mounts: [{ source: agentHome, target: '/config', mode: 'rw' }],
      network: network || cc.networkAgent,
      memory: cc.memory, cpus: cc.cpus, pidsLimit: cc.pidsLimit, envFile: tmp.file,
      labels: metadata ? { 'ai-workbench.run-id': metadata.runId, 'ai-workbench.task-id': metadata.taskId, 'ai-workbench.project-id': metadata.projectId, 'ai-workbench.owner': metadata.owner, 'ai-workbench.fence': metadata.fence } : {},
    });
  } catch (err) { cleanupEnvFile(tmp); throw err; }
  const name = args[args.indexOf('--name') + 1];
  try {
    const startedAt = Date.now();
    const res = await execCapture(bin, args, {
      cwd: worktree, env: safeDockerEnv(), timeoutMs: timeoutMs || cc.timeoutMs, stdin, logPath, signal,
    });
    return {
      code: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut, aborted: res.aborted,
      durationMs: res.durationMs || Date.now() - startedAt, logPath, containerName: name,
      isolation: { backend: 'docker', image: img, network: network || cc.networkAgent, readOnlyRoot: true, capDropAll: true, mounts: ['worktree:/workspace:rw', 'claude-config:/config:rw'], noHostHome: true },
    };
  } finally {
    cleanupEnvFile(tmp);
    try { execCapture(bin, ['rm', '-f', name], { env: safeDockerEnv(), timeoutMs: 10_000 }).catch(() => {}); } catch { /* ignore */ }
  }
}

export function containerCapabilities(config) {
  const cc = containerConfig(config);
  const docker = dockerAvailable({ dockerBin: cc.dockerBin });
  const image = docker.available ? imageAvailable({ dockerBin: cc.dockerBin, image: cc.image }) : { available: false, id: '', reason: 'docker unavailable' };
  return {
    docker,
    image: { name: cc.image, available: image.available, id: image.id || '', reason: image.reason || '' },
    testExecution: docker.available && image.available,
    agentExecution: docker.available && image.available,
    agentBackends: ['claude'],
    network: { test: cc.networkTest, agent: cc.networkAgent },
    security: ['--network none(test)', '--cap-drop ALL', 'no-new-privileges', 'read-only rootfs', 'tmpfs /tmp /run', 'minimal worktree mount', 'no docker.sock', 'non-root host uid', 'pids/memory/cpu limits', '--rm + timeout cleanup'],
    note: docker.available && image.available ? 'Docker 容器执行可用（测试/Claude Agent）' : 'Docker 或运行时镜像不可用：容器执行 BLOCKED，不得降级',
  };
}


/**
 * 启动恢复：只清理确认属于 Workbench 且失去有效执行权的容器。
 * 标签由 buildDockerArgs 注入；无标签旧容器视为历史孤儿（Workbench label 仍存在）。
 */
export async function cleanupOrphanContainers({ config, store, log = () => {} } = {}) {
  const cc = containerConfig(config);
  const bin = cc.dockerBin;
  if (!dockerAvailable({ dockerBin: bin }).available) return { checked: 0, removed: [], skipped: [] };
  let out = '';
  try {
    const res = await execCapture(bin, ['ps', '-a', '--filter', `label=${RUN_LABEL}=1`, '--format', '{{.ID}}	{{.Label "ai-workbench.run-id"}}	{{.Label "ai-workbench.project-id"}}	{{.Label "ai-workbench.owner"}}'], { env: safeDockerEnv(), timeoutMs: 15_000 });
    if (res.code !== 0) return { checked: 0, removed: [], skipped: [], error: (res.stderr || '').slice(0, 300) };
    out = res.stdout;
    if (!String(out || '').trim()) {
      const byName = await execCapture(bin, ['ps', '-a', '--filter', `name=${RUN_LABEL}`, '--format', '{{.ID}}\t{{.Label "ai-workbench.run-id"}}\t{{.Label "ai-workbench.project-id"}}\t{{.Label "ai-workbench.owner"}}\t{{.Label "ai-workbench.fence"}}'], { env: safeDockerEnv(), timeoutMs: 15_000 });
      out = byName.stdout;
    }
  } catch (err) {
    return { checked: 0, removed: [], skipped: [], error: String(err?.message || err) };
  }
  const removed = []; const skipped = [];
  for (const raw of String(out || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    const [id, runId, projectId, owner, fence] = raw.split('\t');
    if (!id) continue;
    let keep = false;
    if (runId && projectId) {
      const run = store?.getRun?.(runId);
      const lease = store?.getProjectLease?.(projectId);
      const ownerAlive = (() => { const m = String(owner || '').match(/wb:(\d+):/); if (!m) return false; try { process.kill(Number(m[1]), 0); return true; } catch (err) { return err.code !== 'ESRCH'; } })();
      if (run && ['running', 'queued'].includes(run.status) && lease?.write_owner === owner && Number(lease.lease_fence || 0) === Number(fence || 0) && lease.lease_expires_at > new Date().toISOString() && ownerAlive) keep = true;
    }
    if (keep) { skipped.push({ id, runId, projectId, owner }); continue; }
    try {
      await execCapture(bin, ['rm', '-f', id], { env: safeDockerEnv(), timeoutMs: 20_000 });
      removed.push({ id, runId, projectId, owner });
      log(`[container-recover] 已清理孤儿容器 ${id} run=${runId || '—'} project=${projectId || '—'}`);
    } catch (err) {
      skipped.push({ id, runId, projectId, owner, error: String(err?.message || err) });
    }
  }
  return { checked: String(out || '').split('\n').filter(Boolean).length, removed, skipped };
}
