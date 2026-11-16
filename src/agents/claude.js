// SPDX-License-Identifier: Apache-2.0
/**
 * Coding Agent 适配器：Claude Code（headless -p）。
 * 使用隔离的 CLAUDE_CONFIG_DIR，避免写入用户全局配置；
 * 支持第三方 Anthropic 兼容端点（如 GLM-5.3）、session 复用、成本统计。
 */
import fs from 'node:fs';
import path from 'node:path';
import { commandExists, execCapture } from '../runner.js';
import { ensureDir } from '../util.js';
import { buildAgentEnv, resolveAgentPermission } from '../security.js';
import { estimateCostCny, usdToCny } from '../pricing.js';
import { resolveAgentIdentity } from '../model-identity.js';
import { runAgentInContainer } from '../container.js';

export const meta = {
  id: 'claude',
  label: 'Claude Code',
  kind: 'coding',
  capabilities: { resume: true, jsonResult: true, costReport: true },
};

export async function check(config) {
  const bin = config.agents.claude.bin;
  const ok = commandExists(bin);
  const model = config.agents.claude.model || process.env.ANTHROPIC_MODEL || '默认模型';
  return {
    id: meta.id,
    label: meta.label,
    ok,
    detail: ok ? `CLI 可用（${model}）` : `未找到 claude CLI：${bin}`,
    capabilities: meta.capabilities,
  };
}

function parseResultJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* 可能包含多行日志，取最后一个 JSON 对象行 */
  }
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* continue */
    }
  }
  return null;
}

export async function run(ctx) {
  const { config, project = null, prompt, cwd, sessionId = '', timeoutMs, maxTokens = 0, signal = null, onEvent = null, logPath = '' } = ctx;
  const cc = config.agents.claude;
  if (!commandExists(cc.bin)) {
    return { ok: false, error: `Claude Code CLI 不可用：${cc.bin}`, agentKind: 'claude', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, logPath };
  }
  ensureDir(cc.home);
  let permission;
  try {
    permission = resolveAgentPermission(config, 'claude', project);
  } catch (err) {
    return { ok: false, error: err.message, agentKind: 'claude', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, logPath, permissionBlocked: true };
  }

  // P0-1：隔离配置目录首次运行时，Claude 会因“自定义 API Key 未批准/未完成 onboarding”等待交互而挂起。
  // 在隔离目录中写入最小 onboarding 状态与该 Key 的批准记录（仅本地），避免使用 bypass 权限。
  try {
    const stateFile = path.join(cc.home, '.claude.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    const key = cc.apiKey || '';
    const suffix = key.length > 20 ? key.slice(-20) : key;
    const approved = new Set([...(state.customApiKeyResponses?.approved || [])]);
    if (suffix) approved.add(suffix);
    state.hasCompletedOnboarding = true;
    state.customApiKeyResponses = { approved: [...approved], rejected: state.customApiKeyResponses?.rejected || [] };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    /* 状态写入失败时继续，让 CLI 自己报错 */
  }

  const args = ['-p', '--output-format', 'json', '--max-turns', '30'];
  if (permission.mode) args.push('--permission-mode', permission.mode);
  if (permission.allowedTools) args.push('--allowedTools', permission.allowedTools);
  if (permission.disallowedTools) args.push('--disallowedTools', permission.disallowedTools);
  if (cc.model) args.push('--model', cc.model);
  if (sessionId) args.push('--resume', sessionId);

  const identity = resolveAgentIdentity({ config, agentId: 'claude', project });
  const env = buildAgentEnv({ config, agentId: 'claude', homeDir: ctx.agentHome });
  const containerEnv = {
    ANTHROPIC_BASE_URL: cc.baseUrl || '',
    ANTHROPIC_API_KEY: cc.apiKey || '',
    ANTHROPIC_MODEL: cc.model || '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_THINKING: '1',
  };

  const startedAt = Date.now();
  let res;
  if (ctx.container) {
    res = await runAgentInContainer({
      config, worktree: cwd, agentHome: cc.home, cliArgs: args, env: containerEnv,
      timeoutMs: timeoutMs || cc.timeoutMs, stdin: prompt, logPath, signal,
      network: ctx.container.network || '',
    });
  } else {
    res = await execCapture(cc.bin, args, {
      cwd,
      env,
      timeoutMs: timeoutMs || cc.timeoutMs,
      stdin: prompt,
      logPath,
      signal,
      onStderr: (chunk) => {
        if (onEvent && chunk.trim()) onEvent({ kind: 'stderr', summary: chunk.slice(0, 200) });
      },
    });
  }
  const durationMs = Date.now() - startedAt;
  const data = parseResultJson(res.stdout);
  if (!data) {
    let error = res.timedOut ? 'Claude Code 执行超时' : res.aborted ? 'Claude Code 执行被取消' : 'Claude Code 未返回可解析的 JSON 结果';
    if (res.stderr) error += `：${res.stderr.slice(-600)}`;
    return {
      ok: false,
      error,
      agentKind: 'claude',
      sessionId,
      exitCode: res.code,
      timedOut: res.timedOut,
      aborted: res.aborted,
      durationMs,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costCny: 0,
      logPath,
    };
  }
  const u = data.usage || {};
  const usage = {
    input: Number(u.input_tokens || 0),
    output: Number(u.output_tokens || 0),
    cacheRead: Number(u.cache_read_input_tokens || 0),
    cacheWrite: Number(u.cache_creation_input_tokens || 0),
  };
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const costReported = Number.isFinite(Number(data.total_cost_usd));
  const costProvider = identity.known ? identity.provider : 'unknown';
  const costCny = costReported ? usdToCny(Number(data.total_cost_usd)) : estimateCostCny(costProvider, cc.model || identity.model || 'unknown', usage);

  let error = '';
  if (res.timedOut) error = 'Claude Code 执行超时';
  else if (res.aborted) error = 'Claude Code 执行被取消';
  else if (maxTokens > 0 && tokens > maxTokens) error = `Claude Code 超出单任务 token 预算（${tokens} > ${maxTokens}）`;
  else if (data.is_error) error = `Claude Code 返回错误：${String(data.result || data.subtype || '').slice(0, 500)}`;
  else if (data.permission_denials?.length) error = `Claude Code 存在被拒绝的权限请求：${JSON.stringify(data.permission_denials).slice(0, 300)}`;

  if (onEvent && data.result && !data.is_error) {
    onEvent({ kind: 'result', summary: String(data.result).slice(0, 300) });
  }

  return {
    ok: !error,
    text: String(data.result || ''),
    error,
    agentKind: 'claude',
    provider: identity.known ? identity.provider : 'unknown',
    providerKnown: identity.known,
    providerSource: identity.source,
    providerNote: identity.note,
    model: cc.model || identity.model || '',
    exempt: identity.exempt,
    canRunShell: false,
    costReported,
    costSource: costReported ? 'vendor' : 'estimated',
    sessionId: data.session_id || sessionId,
    exitCode: res.code,
    timedOut: res.timedOut,
    aborted: res.aborted,
    durationMs,
    usage,
    tokens,
    costCny,
    logPath,
    container: ctx.container ? res.isolation : null,
    numTurns: data.num_turns,
    reportedCostUsd: data.total_cost_usd,
  };
}
