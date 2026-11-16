// SPDX-License-Identifier: Apache-2.0
/**
 * 执行隔离能力探测与策略（v2.1，fail-closed）。
 *
 * 目标：优先使用 Docker/容器；本机不可用时退回"受限独立运行环境"：
 *  - 每个 run/task 独立 HOME/TMPDIR（不在 Git 仓库内）
 *  - 测试/Agent 最小环境变量（不继承宿主密钥）
 *  - Agent 工具白名单、测试命令 allowlist、项目/运行目录边界
 *  - 不提供内核级文件/网络隔离；如果项目声明 require_kernel / docker 而环境不满足，直接阻塞。
 *
 * 不得因为隔离不可用而自动提高权限（例如 danger-full-access 或 bypass）。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { PolicyError } from './policy.js';

export function probeDocker({ dockerBin = process.env.DOCKER_BIN || 'docker', timeout = 4000 } = {}) {
  try {
    const out = execFileSync(dockerBin, ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { available: true, engine: 'docker', version: out || 'unknown', reason: '' };
  } catch (err) {
    return { available: false, engine: 'docker', version: '', reason: (err?.stderr || err?.message || 'docker daemon unavailable').toString().slice(0, 300) };
  }
}

function probeSandboxExec() {
  const bin = '/usr/bin/sandbox-exec';
  if (process.platform !== 'darwin' || !fs.existsSync(bin)) return { available: false, engine: 'sandbox-exec', reason: 'sandbox-exec 不存在' };
  try {
    // 实际执行一次最小策略；嵌套沙箱/受限会话中会被拒绝，不能只看文件存在
    execFileSync(bin, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { available: true, engine: 'sandbox-exec', reason: '' };
  } catch (err) {
    return { available: false, engine: 'sandbox-exec', reason: (err?.stderr || err?.message || 'sandbox-exec 不可用').toString().slice(0, 300) };
  }
}

export function detectIsolationCapabilities({ dockerProbe = probeDocker } = {}) {
  const docker = dockerProbe();
  const sandbox = probeSandboxExec();
  const kernel = docker.available ? 'docker' : sandbox.available ? 'sandbox-exec' : 'BLOCKED';
  return {
    platform: process.platform,
    docker,
    sandboxExec: sandbox,
    kernelIsolation: kernel,
    kernelAvailable: kernel !== 'BLOCKED',
    restrictedRuntime: {
      available: true,
      controls: [
        'per-run/task 独立 HOME 与 TMPDIR（位于仓库外）',
        'Agent/测试最小环境变量；不继承 GITHUB_TOKEN/无关模型 Key',
        'Claude Code 工具白名单；DSH workspace-write；危险权限需显式开关',
        '测试命令 allowlist；工作副本/产物路径边界校验',
        '每次运行独立 Git worktree + 计划分支；不同项目独立目录',
      ],
      limitations: [
        '无内核级文件系统/网络隔离',
        'DSH/Claude 仍以宿主用户身份运行；无法阻止读取宿主同用户可读文件',
        'Docker/sandbox-exec 不可用时不能宣称强隔离',
      ],
    },
    note: docker.available
      ? '检测到 Docker daemon，可在配置允许时使用容器执行'
      : 'Docker daemon 不可用；使用受限独立运行环境，强隔离能力标记 BLOCKED',
  };
}

export function isolationModeForProject(config, project) {
  const cfg = project?.config_json || {};
  return String(cfg.isolation_mode || config?.isolation?.mode || 'restricted');
}

/**
 * 在启动 Agent/测试前调用：要求 docker / require_kernel 的项目，如果环境不满足必须阻塞。
 * restricted 模式允许运行，但不得对外宣称强隔离。
 */
export function assertIsolationForProject(config, project, caps) {
  const mode = isolationModeForProject(config, project);
  if (mode === 'docker' || mode === 'require_kernel') {
    if (!caps?.docker?.available) {
      throw new PolicyError('ISOLATION_UNAVAILABLE', `项目要求 ${mode} 隔离，但 Docker daemon 不可用；按 fail-closed 阻塞，禁止降级到危险权限`);
    }
  }
  if (mode === 'sandbox-exec' && !caps?.sandboxExec?.available) {
    throw new PolicyError('ISOLATION_UNAVAILABLE', '项目要求 sandbox-exec 隔离，但沙箱不可用；按 fail-closed 阻塞');
  }
  return {
    mode,
    kernelIsolation: caps?.kernelIsolation || 'BLOCKED',
    strong: !!caps?.kernelAvailable,
    warning: caps?.kernelAvailable ? '' : '当前为受限运行环境（无内核级隔离），该限制已记录并对外披露',
  };
}
