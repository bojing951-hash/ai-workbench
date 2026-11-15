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
import { estimateCostCny, usdToCny } from '../pricing.js';

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
  const { config, prompt, cwd, sessionId = '', timeoutMs, maxTokens = 0, signal = null, onEvent = null, logPath = '' } = ctx;
  const cc = config.agents.claude;
  if (!commandExists(cc.bin)) {
    return { ok: false, error: `Claude Code CLI 不可用：${cc.bin}`, agentKind: 'claude', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, logPath };
  }
  ensureDir(cc.home);

  const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--max-turns', '30'];
  if (cc.model) args.push('--model', cc.model);
  if (sessionId) args.push('--resume', sessionId);

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: cc.home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NO_COLOR: '1',
    CI: '1',
  };
  if (cc.baseUrl) env.ANTHROPIC_BASE_URL = cc.baseUrl;
  if (cc.apiKey) env.ANTHROPIC_API_KEY = cc.apiKey;
  if (cc.model) env.ANTHROPIC_MODEL = cc.model;

  const startedAt = Date.now();
  const res = await execCapture(cc.bin, args, {
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
  const costCny = Number.isFinite(Number(data.total_cost_usd))
    ? usdToCny(Number(data.total_cost_usd))
    : estimateCostCny('anthropic', cc.model || 'claude', usage);

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
    sessionId: data.session_id || sessionId,
    exitCode: res.code,
    timedOut: res.timedOut,
    aborted: res.aborted,
    durationMs,
    usage,
    tokens,
    costCny,
    logPath,
    numTurns: data.num_turns,
    reportedCostUsd: data.total_cost_usd,
  };
}
