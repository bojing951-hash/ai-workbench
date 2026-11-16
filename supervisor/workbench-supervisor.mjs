// SPDX-License-Identifier: Apache-2.0
/**
 * 独立 Supervisor（v2.4）
 *
 * 与 Workbench 主进程相互独立：启动 Workbench、健康检查、进程退出/无响应检测、
 * 有界指数退避重启、熔断、崩溃记录，并在健康恢复后调用受管项目的恢复对账 API。
 *
 * 用法：
 *   node supervisor/workbench-supervisor.mjs --root /path/to/ai-workbench [--port 4477] [--max-restarts 6]
 *   node supervisor/workbench-supervisor.mjs --status --root ...
 *
 * macOS launchd 模板：supervisor/com.aiworkbench.supervisor.plist
 * Linux systemd 模板：supervisor/ai-workbench-supervisor.service
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
function flag(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
}
function has(name) { return args.includes(`--${name}`); }

const root = path.resolve(flag('root', process.cwd()));
const port = Number(flag('port', '4477'));
const maxRestarts = Number(flag('max-restarts', '6'));
const restartWindowMs = Number(flag('restart-window-ms', String(10 * 60 * 1000)));
const supervisorDir = path.join(root, 'data', 'supervisor');
fs.mkdirSync(supervisorDir, { recursive: true });
const statePath = path.join(supervisorDir, 'state.json');
const pidPath = path.join(supervisorDir, 'supervisor.pid');
const logPath = path.join(supervisorDir, 'supervisor.log');
const childLogPath = path.join(supervisorDir, 'workbench.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { fs.appendFileSync(logPath, `${line}\n`); } catch { /* ignore */ }
  console.log(line);
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch { /* ignore */ } }
function state() { return readJson(statePath, { restarts: [], crashes: [], recoveries: [], startedAt: new Date().toISOString(), circuitOpen: false, childPid: 0 }); }
function saveState(next) { writeJson(statePath, next); }

if (has('status')) {
  const s = state();
  console.log(JSON.stringify({ supervisorPid: readText(pidPath), ...s }, null, 2));
  process.exit(0);
}

function readText(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }

function token() {
  try { return fs.readFileSync(path.join(root, 'data', 'api-token'), 'utf8').trim(); } catch { return ''; }
}

async function fetchJson(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 4000);
  try {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    const tk = token();
    if (tk) headers['x-workbench-token'] = tk;
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...options, headers, signal: controller.signal });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

let child = null;
let stopping = false;
let failures = 0;
let restartScheduled = false;
let healthTimer = null;

function startWorkbench() {
  const out = fs.openSync(childLogPath, 'a');
  child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'bin/workbench.js', 'serve', '--port', String(port)], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', out, out],
    detached: false,
  });
  const s = state();
  s.childPid = child.pid || 0;
  s.lastStartAt = new Date().toISOString();
  s.circuitOpen = false;
  saveState(s);
  restartScheduled = false;
  failures = 0;
  log(`Workbench 启动 pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    const s2 = state();
    s2.crashes = [...(s2.crashes || []), { at: new Date().toISOString(), code, signal, pid: child?.pid || 0 }].slice(-100);
    saveState(s2);
    log(`Workbench 退出 code=${code} signal=${signal}`);
    scheduleRestart('process-exit');
  });
  child.on('error', (err) => {
    log(`Workbench spawn 错误：${err.message}`);
    scheduleRestart('spawn-error');
  });
}

function stopWorkbench() {
  if (!child || child.killed) return;
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

function scheduleRestart(reason) {
  if (stopping || restartScheduled) return;
  restartScheduled = true;
  clearInterval(healthTimer);
  healthTimer = null;
  const s = state();
  const now = Date.now();
  const recent = (s.restarts || []).filter((r) => now - new Date(r.at).getTime() <= restartWindowMs);
  if (recent.length >= maxRestarts) {
    s.circuitOpen = true;
    s.circuitReason = `最近 ${Math.round(restartWindowMs / 60000)} 分钟内重启 ${recent.length} 次，超过上限 ${maxRestarts}`;
    saveState(s);
    log(`熔断：${s.circuitReason}；停止自动重启，保留任务历史`);
    restartScheduled = false;
    return;
  }
  const attempt = recent.length + 1;
  const delayMs = Math.min(300_000, Math.max(5_000, 5_000 * 2 ** (attempt - 1)));
  s.restarts = [...(s.restarts || []), { at: new Date(now).toISOString(), reason, attempt, delayMs }].slice(-100);
  s.nextRestartAt = new Date(now + delayMs).toISOString();
  saveState(s);
  log(`计划重启 #${attempt}（${reason}），${Math.round(delayMs / 1000)}s 后`);
  setTimeout(() => {
    if (stopping) return;
    startWorkbench();
    monitor();
  }, delayMs);
}

let restoreInFlight = false;
async function recoverAfterHealth() {
  if (restoreInFlight) return;
  restoreInFlight = true;
  try {
    const res = await fetchJson('/api/supervisor/recover', { method: 'POST', timeoutMs: 20_000 });
    const s = state();
    s.recoveries = [...(s.recoveries || []), { at: new Date().toISOString(), ok: res.ok, result: res.data?.data || res.error || null }].slice(-100);
    saveState(s);
    if (res.ok) log(`健康恢复后对账/续跑完成：${JSON.stringify(res.data?.data || {})}`);
    else log(`恢复 API 失败：${res.error || res.status}`);
  } finally {
    restoreInFlight = false;
  }
}

let recoveredForThisStart = false;
function monitor() {
  clearInterval(healthTimer);
  failures = 0;
  recoveredForThisStart = false;
  healthTimer = setInterval(async () => {
    if (stopping || !child) return;
    const health = await fetchJson('/api/health', { timeoutMs: 3000 });
    if (health.ok) {
      failures = 0;
      if (!recoveredForThisStart) {
        recoveredForThisStart = true;
        // 给 Workbench 启动后恢复逻辑一点时间，再调用受管项目恢复
        setTimeout(() => recoverAfterHealth(), 1500);
      }
      return;
    }
    failures += 1;
    log(`健康检查失败 ${failures}/3：${health.error || health.status}`);
    if (failures >= 3) {
      log('Workbench 存活但服务无响应，强制终止并重启');
      clearInterval(healthTimer);
      healthTimer = null;
      stopWorkbench();
      scheduleRestart('health-unresponsive');
    }
  }, 5000);
}

process.on('SIGTERM', () => { stopping = true; clearInterval(healthTimer); stopWorkbench(); try { fs.rmSync(pidPath, { force: true }); } catch { /* ignore */ } process.exit(0); });
process.on('SIGINT', () => { stopping = true; clearInterval(healthTimer); stopWorkbench(); try { fs.rmSync(pidPath, { force: true }); } catch { /* ignore */ } process.exit(0); });

const initial = state();
initial.startedAt = initial.startedAt || new Date().toISOString();
initial.supervisorPid = process.pid;
initial.circuitOpen = false;
saveState(initial);
fs.writeFileSync(pidPath, String(process.pid));
log(`Supervisor 启动 pid=${process.pid} root=${root} port=${port}`);
startWorkbench();
monitor();

// 保持进程存活
setInterval(() => { const s = state(); s.heartbeatAt = new Date().toISOString(); saveState(s); }, 30_000).unref?.();
