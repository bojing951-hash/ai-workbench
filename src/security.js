// SPDX-License-Identifier: Apache-2.0
/**
 * P0 安全边界：
 * - Agent / 测试进程的最小环境变量（不继承宿主全部凭据）
 * - 测试命令 allowlist（防止 planner/LLM 注入任意 shell）
 * - 本地 HTTP API 的 Host / Origin / CSRF / 可选 Token 校验
 * - 文件路径（含 symlink）越界防护
 * - Agent 权限策略（危险权限必须显式开启，默认失败关闭）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PolicyError, redact } from './policy.js';

const BASE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SHELL'];

export function safeBaseEnv() {
  const env = {};
  for (const key of BASE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  env.SHELL = '/bin/sh';
  env.NO_COLOR = '1';
  return env;
}

/**
 * 构造 Agent 子进程环境：只给该 Agent 运行所必需的模型凭据，绝不继承 GITHUB_TOKEN 等。
 */
export function buildAgentEnv({ config, agentId, homeDir }) {
  const home = homeDir || path.join(config.paths.agentsDir, `${agentId}-home`);
  fs.mkdirSync(home, { recursive: true });
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...safeBaseEnv(), HOME: home, TMPDIR: tmp, CI: '1' };
  if (agentId === 'dsh') {
    env.DSH_HOME = config.agents.dsh.home;
    if (config.llm.deepseek.apiKey) env.DEEPSEEK_API_KEY = config.llm.deepseek.apiKey;
  } else if (agentId === 'claude') {
    env.CLAUDE_CONFIG_DIR = config.agents.claude.home;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (config.agents.claude.baseUrl) env.ANTHROPIC_BASE_URL = config.agents.claude.baseUrl;
    if (config.agents.claude.apiKey) env.ANTHROPIC_API_KEY = config.agents.claude.apiKey;
    if (config.agents.claude.model) env.ANTHROPIC_MODEL = config.agents.claude.model;
    env.CLAUDE_CODE_DISABLE_THINKING = '1';
  } else if (agentId === 'custom') {
    // 自定义 Agent 不获得任何模型凭据；如需请通过 CUSTOM_AGENT_* 显式白名单
    const extra = String(config.agents.custom.envAllowlist || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const key of extra) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * 构造测试进程环境：只允许项目声明的 test_env_allowlist，绝不传递 API Key / GitHub Token。
 */
export function buildTestEnv({ config, project, homeDir, extraEnv = {} }) {
  const home = homeDir || path.join(config.paths.dataDir, 'sandbox-home');
  fs.mkdirSync(home, { recursive: true });
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = {
    ...safeBaseEnv(),
    HOME: home,
    TMPDIR: tmp,
    CI: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
  const projectConfig = project?.config_json || {};
  const allow = new Set(
    [...(projectConfig.test_env_allowlist || []), ...(config.security.testEnvAllowlist || [])]
      .map((s) => String(s).trim())
      .filter(Boolean),
  );
  for (const key of allow) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value !== undefined) env[key] = String(value);
  }
  return env;
}

/** 测试命令 allowlist：项目只能执行显式配置的命令（精确匹配，防 LLM/任务注入）。 */
export function assertSafeTestCommand(command, project) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new PolicyError('TEST_COMMAND_EMPTY', '测试命令为空');
  if (cmd.length > 800 || /[\n\r]/.test(cmd)) throw new PolicyError('TEST_COMMAND_INVALID', '测试命令包含非法字符');
  const projectConfig = project?.config_json || {};
  const allowed = new Set(
    [project?.test_command, ...(projectConfig.allowed_test_commands || [])].map((s) => String(s || '').trim()).filter(Boolean),
  );
  if (allowed.size === 0) throw new PolicyError('TEST_COMMAND_NOT_CONFIGURED', '项目未配置测试命令 allowlist');
  if (!allowed.has(cmd)) {
    throw new PolicyError(
      'TEST_COMMAND_NOT_ALLOWED',
      `测试命令不在项目 allowlist 中，已拒绝执行：${cmd}`,
      { allowed: [...allowed] },
    );
  }
  return cmd;
}

/** Agent 权限策略：危险权限必须显式配置开启，否则失败关闭。 */
export function resolveAgentPermission(config, agentId, project = null) {
  const projectConfig = project?.config_json || {};
  const requested = String(
    projectConfig.agent_permission || (agentId === 'dsh' ? config.agents.dsh.permissionMode : config.agents.claude.permissionMode) || '',
  ).toLowerCase();

  if (agentId === 'dsh') {
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(requested)) {
      throw new PolicyError('AGENT_PERMISSION_INVALID', `不支持的 DSH 权限模式：${requested}`);
    }
    if (requested === 'danger-full-access' && !config.security.allowUnsafeAgentPermissions) {
      throw new PolicyError(
        'AGENT_UNSAFE_PERMISSION_BLOCKED',
        '工作台默认禁止 DSH danger-full-access。若宿主机 sandbox 不可用，请改用受限模式或由人工明确开启 WORKBENCH_ALLOW_UNSAFE_AGENT=1',
      );
    }
    return { mode: requested, allowShell: requested !== 'read-only' && requested !== 'workspace-write' ? true : false };
  }

  if (agentId === 'claude') {
    // requested 已统一 lower-case；这里映射回 Claude CLI 的驼峰模式名
    const modeMap = {
      default: 'default',
      acceptedits: 'acceptEdits',
      auto: 'auto',
      dontask: 'dontAsk',
      plan: 'plan',
      bypasspermissions: 'bypassPermissions',
      'dangerously-skip-permissions': 'dangerously-skip-permissions',
    };
    const requestedClaude = modeMap[requested] || (requested ? requested : 'acceptEdits');
    const allowedModes = ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions', 'dangerously-skip-permissions'];
    if (!allowedModes.includes(requestedClaude)) {
      throw new PolicyError('AGENT_PERMISSION_INVALID', `不支持的 Claude Code 权限模式：${requestedClaude}`);
    }
    if (['bypassPermissions', 'dangerously-skip-permissions'].includes(requestedClaude) && !config.security.allowUnsafeAgentPermissions) {
      throw new PolicyError(
        'AGENT_UNSAFE_PERMISSION_BLOCKED',
        '工作台默认禁止 Claude Code bypassPermissions；请使用 acceptEdits + 工具白名单，或由人工明确开启 WORKBENCH_ALLOW_UNSAFE_AGENT=1',
      );
    }
    return { mode: requestedClaude, allowedTools: config.agents.claude.allowedTools, disallowedTools: config.agents.claude.disallowedTools, allowShell: false };
  }

  return { mode: 'restricted', allowShell: false };
}

/** 允许的 Host 列表（防 DNS rebinding 读取本地 API）。 */
export function isAllowedHost(hostHeader, config) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end > 0 ? host.slice(1, end) : host;
  } else if (/^[^:]+:\d+$/.test(host)) {
    host = host.replace(/:\d+$/, '');
  }
  const allowed = new Set(['127.0.0.1', 'localhost', '::1']);
  if (config.server?.host && config.server.host !== '0.0.0.0') {
    let h = String(config.server.host).toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    allowed.add(h);
  }
  for (const item of config.security?.allowedHosts || []) {
    let h = String(item).toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    allowed.add(h);
  }
  return allowed.has(host);
}

/**
 * 校验写操作的 CSRF / Origin / 可选 Token。
 * 非浏览器客户端（curl/脚本）通常无 Origin，允许；浏览器跨站请求会被拒绝。
 */
export function assertSafeWriteRequest(req, config) {
  const token = config.security?.apiToken;
  if (token) {
    const auth = String(req.headers.authorization || '');
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-workbench-token'];
    if (provided !== token) throw new PolicyError('API_AUTH_REQUIRED', '缺少或错误的 API Token');
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      throw new PolicyError('ORIGIN_INVALID', '非法 Origin');
    }
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(originHost)) {
      throw new PolicyError('ORIGIN_FORBIDDEN', `拒绝跨站写请求：Origin=${origin}`);
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(String(site))) {
    throw new PolicyError('CSRF_BLOCKED', `拒绝跨站请求：Sec-Fetch-Site=${site}`);
  }
  return true;
}

/** realpath 包含检查：防止 symlink / ../ 越界。 */
export function resolveWithin(baseDir, relPath) {
  const base = fs.realpathSync(path.resolve(baseDir));
  let candidate = path.resolve(base, relPath);
  // 允许目标尚不存在：解析父目录的真实路径
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  if (!realExisting.startsWith(base + path.sep) && realExisting !== base) {
    throw new PolicyError('PATH_OUTSIDE_ROOT', '路径越界或符号链接指向工作台数据目录之外');
  }
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync(candidate);
    if (!real.startsWith(base + path.sep) && real !== base) {
      throw new PolicyError('PATH_OUTSIDE_ROOT', '符号链接越界');
    }
  }
  return candidate;
}

/** 路径指纹：用于审计/测试版本一致性。 */
export function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

/** 已知密钥值脱敏（供错误响应/日志使用）。 */
export function redactForResponse(text, config) {
  const raw = typeof text === 'string' ? text : String(text?.message || text);
  return redact(raw, config);
}

/** 受限请求体大小与简单限流（内存级，local-only 场景）。 */
export class WriteRateLimiter {
  constructor({ windowMs = 60_000, max = 120 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = [];
  }

  check() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) throw new PolicyError('RATE_LIMITED', '写操作过于频繁，请稍后再试');
    this.hits.push(now);
  }
}

export function tmpHomeFor(config, runId, taskId) {
  const dir = path.join(config.paths.dataDir, 'sandboxes', runId || 'run', taskId || 'task', 'home');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { os };
