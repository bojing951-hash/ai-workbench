// SPDX-License-Identifier: Apache-2.0
/**
 * 进程执行器：带超时、日志落盘、输出截断、进程组清理。
 * 所有 Agent / 测试 / Git 命令统一走这里，保证可观测与可终止。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, formatDuration } from './util.js';

const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 2 * 1024 * 1024;

/**
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number, logPath:string, signal:string|null}>}
 */
export function execCapture(cmd, args = [], opts = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT,
    stdin = null,
    logPath = '',
    onStdout = null,
    onStderr = null,
    signal = null,
    abortReason = 'aborted',
  } = opts;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let stream = null;
    if (logPath) {
      ensureDir(path.dirname(logPath));
      stream = fs.createWriteStream(logPath, { flags: 'a' });
      stream.write(`\n# ${new Date().toISOString()} exec: ${cmd} ${args.join(' ')}\n# cwd: ${cwd}\n`);
    }
    const append = (buf, isErr) => {
      const text = buf.toString('utf8');
      if (stream) stream.write(text);
      if (isErr) {
        if (stderr.length < MAX_STDERR) stderr += text.slice(0, MAX_STDERR - stderr.length);
        if (onStderr) onStderr(text);
      } else {
        if (stdout.length < MAX_STDOUT) stdout += text.slice(0, MAX_STDOUT - stdout.length);
        if (onStdout) onStdout(text);
      }
    };

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      if (stream) {
        stream.write(`spawn error: ${err.message}\n`);
        stream.end();
      }
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err), timedOut: false, durationMs: Date.now() - startedAt, logPath, signal: null, spawnError: true });
      return;
    }

    // 子进程可能先退出，随后写 stdin 会触发异步 EPIPE；必须消费该错误，不能冒泡杀死 Workbench。
    child.stdin.on('error', () => { /* early close is expected */ });
    if (stdin !== null && stdin !== undefined) {
      try {
        child.stdin.write(stdin);
        child.stdin.end();
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    }

    const killTree = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    };

    let aborted = false;
    if (signal) {
      const onAbort = () => {
        aborted = true;
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 5000).unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree('SIGTERM');
          setTimeout(() => killTree('SIGKILL'), 5000).unref?.();
        }, timeoutMs)
      : null;
    timer?.unref?.();

    child.stdout.on('data', (buf) => append(buf, false));
    child.stderr.on('data', (buf) => append(buf, true));

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (stream) {
        stream.write(`\n# exit=${code ?? 'null'} signal=${signal || ''} duration=${formatDuration(durationMs)}${timedOut ? ' TIMEOUT' : ''}${aborted ? ' ABORTED' : ''}\n`);
        stream.end();
      }
      resolve({ code, stdout, stderr, timedOut, aborted, abortReason, durationMs, logPath, signal: signal || null });
    };

    child.on('error', (err) => {
      append(Buffer.from(`\nspawn error: ${err.message}\n`), true);
      finish(-1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    // 兜底：即便 close 不触发，也在超时后 90s 强制结算
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (!settled) {
          killTree('SIGKILL');
          finish(null, 'SIGKILL');
        }
      }, timeoutMs + 90_000).unref?.();
    }
  });
}

export function execShell(command, opts = {}) {
  return execCapture('/bin/sh', ['-c', command], opts);
}

export function commandExists(bin, env = process.env) {
  if (!bin) return false;
  if (bin.includes('/')) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = env.PATH || '/usr/local/bin:/usr/bin:/bin';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

/** Git 命令封装：默认非零退出码抛错；可通过 opts.allowFail 放宽。 */
export async function git(cwd, args, opts = {}) {
  const { allowFail = false, timeoutMs = 120_000, env = {}, input = null, logPath = '' } = opts;
  const baseEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'AI Workbench',
    GIT_AUTHOR_EMAIL: 'workbench@localhost',
    GIT_COMMITTER_NAME: 'AI Workbench',
    GIT_COMMITTER_EMAIL: 'workbench@localhost',
    GIT_TERMINAL_PROMPT: '0',
    ...env,
  };
  const res = await execCapture('git', args, { cwd, env: baseEnv, timeoutMs, stdin: input, logPath });
  if (res.code !== 0 && !allowFail) {
    const err = new Error(`git ${args.join(' ')} 失败 (code=${res.code}): ${(res.stderr || res.stdout || '').slice(-2000)}`);
    err.code = 'GIT_ERROR';
    err.result = res;
    throw err;
  }
  return res;
}
