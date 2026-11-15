// SPDX-License-Identifier: Apache-2.0
/**
 * 工作台自我升级（P0/P3）：
 * 稳定控制进程不直接加载未验证代码；升级必须经过：
 *   1) 在独立目录创建候选版本
 *   2) 候选版本跑完整离线测试
 *   3) 在隔离端口 + 独立数据目录启动候选实例，做健康/状态/API 冒烟
 *   4) （可选）在候选实例上跑一个真实小任务
 *   5) 保存证据与候选 commit；通过后才推送候选分支并创建草稿 PR
 * 失败时稳定版本继续运行，不自动替换。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ensureDir, newId, nowIso, readJson, writeJson } from './util.js';
import { execCapture } from './runner.js';
import { buildTestEnv } from './security.js';

const EXCLUDE = new Set(['.git', 'data', 'projects', 'node_modules', '.env', 'docs/images', 'demo/evidence']);

export function createCandidate({ config, sourceRoot = config.paths.root, label = '' }) {
  const id = `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(config.paths.dataDir, 'candidates', id);
  ensureDir(dir);
  copyTree(sourceRoot, dir, new Set(), '');
  const meta = {
    id,
    label: label || `candidate-${id}`,
    sourceRoot,
    dir,
    createdAt: nowIso(),
  };
  writeJson(path.join(dir, 'candidate.json'), meta);
  return meta;
}

function copyTree(src, dest, seen, prefix = '') {
  const real = fs.realpathSync(src);
  if (seen.has(real)) return;
  seen.add(real);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (EXCLUDE.has(entry.name) || EXCLUDE.has(rel)) continue;
    if (entry.name === '.DS_Store') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      ensureDir(to);
      copyTree(from, to, seen, rel);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

export async function runCandidateTests({ config, candidateDir, timeoutMs = 15 * 60 * 1000 }) {
  const startedAt = Date.now();
  const logPath = path.join(candidateDir, 'candidate-tests.log');
  const res = await execCapture(process.execPath, ['--no-warnings=ExperimentalWarning', '--test', ...listTestFiles(candidateDir)], {
    cwd: candidateDir,
    env: buildTestEnv({ config, project: { config_json: {} }, homeDir: path.join(candidateDir, '.test-home') }),
    timeoutMs,
    logPath,
  });
  return {
    ok: res.code === 0 && !res.timedOut,
    code: res.code,
    timedOut: res.timedOut,
    durationMs: Date.now() - startedAt,
    stdoutTail: String(res.stdout || '').slice(-4000),
    stderrTail: String(res.stderr || '').slice(-2000),
    logPath,
  };
}

function listTestFiles(candidateDir) {
  const dir = path.join(candidateDir, 'tests');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join('tests', f));
}

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startCandidateInstance({ config, candidateDir, port, timeoutMs = 20_000, allowModelKeys = false }) {
  const dataDir = path.join(candidateDir, 'candidate-data');
  ensureDir(dataDir);
  const logPath = path.join(candidateDir, 'candidate-server.log');
  const out = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(candidateDir, 'bin', 'workbench.js'), 'serve', '--port', String(port)], {
    cwd: candidateDir,
    env: {
      ...buildTestEnv({ config, project: { config_json: {} }, homeDir: path.join(candidateDir, '.runtime-home') }),
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_ROOT: candidateDir,
      WORKBENCH_PORT: String(port),
      WORKBENCH_PROJECTS_DIR: path.join(candidateDir, 'projects'),
      ...(allowModelKeys ? {
        DEEPSEEK_API_KEY: config.llm.deepseek.apiKey || '',
        GLM_API_KEY: config.llm.glm.apiKey || '',
        OPENAI_API_KEY: config.llm.openai.apiKey || '',
        GLM_BASE_URL: config.llm.glm.baseUrl || '',
        GLM_AUDIT_MODEL: config.llm.glm.model || '',
        DEEPSEEK_BASE_URL: config.llm.deepseek.baseUrl || '',
        PLANNER_MODEL: config.llm.deepseek.model || '',
      } : { DEEPSEEK_API_KEY: '', GLM_API_KEY: '', OPENAI_API_KEY: '' }),
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const started = Date.now();
  let healthy = false;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { child, port, dataDir, logPath, healthy };
}

export async function stopCandidateInstance(instance) {
  if (!instance?.child) return;
  const child = instance.child;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

export async function smokeInstalledApi(instance) {
  const tokenFile = path.join(instance.dataDir, 'api-token');
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  const headers = token ? { 'x-workbench-token': token } : {};
  const stateRes = await fetch(`http://127.0.0.1:${instance.port}/api/state`, { headers, signal: AbortSignal.timeout(5000) });
  const state = await stateRes.json();
  const agentsRes = await fetch(`http://127.0.0.1:${instance.port}/api/agents`, { headers, signal: AbortSignal.timeout(5000) });
  return {
    ok: stateRes.ok && state.ok === true && agentsRes.ok,
    httpStatus: stateRes.status,
    version: state.data?.version,
    projects: state.data?.projects?.length ?? null,
    agents: (await agentsRes.json()).data?.map?.((a) => a.id) || [],
    dataDir: instance.dataDir,
    port: instance.port,
  };
}

/** 完整候选验证：测试 + 隔离实例 + API 冒烟；返回证据对象（不修改稳定版本）。 */
export async function verifyCandidate({ config, candidateDir, skipServer = false }) {
  const tests = await runCandidateTests({ config, candidateDir });
  let instance = null;
  let smoke = null;
  try {
    if (tests.ok && !skipServer) {
      const port = await findFreePort();
      instance = await startCandidateInstance({ config, candidateDir, port });
      if (!instance.healthy) throw new Error('候选实例健康检查失败');
      smoke = await smokeInstalledApi(instance);
    }
  } finally {
    await stopCandidateInstance(instance);
  }
  const result = {
    candidateDir,
    at: nowIso(),
    tests,
    smoke,
    passed: !!tests.ok && (skipServer ? true : !!smoke?.ok),
  };
  writeJson(path.join(candidateDir, 'candidate-evidence.json'), result);
  return result;
}

export function readCandidateEvidence(candidateDir) {
  return readJson(path.join(candidateDir, 'candidate-evidence.json'), null);
}

export function candidateList(config) {
  const base = path.join(config.paths.dataDir, 'candidates');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .map((id) => readJson(path.join(base, id, 'candidate.json'), null))
    .filter(Boolean);
}

export function newCandidateId() {
  return newId('cand');
}

export { os };
