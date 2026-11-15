// SPDX-License-Identifier: Apache-2.0
/**
 * Coding Agent 适配器：DeepSeek Harness headless。
 * 通过 `dsh headless --json -` 在隔离工作副本中执行真实编码任务；
 * 支持 session 复用（修复循环）、权限模式、token 用量统计与预算中止。
 */
import fs from 'node:fs';
import { commandExists, execCapture } from '../runner.js';
import { ensureDir } from '../util.js';
import { buildAgentEnv, resolveAgentPermission } from '../security.js';
import { estimateCostCny } from '../pricing.js';

export const meta = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  kind: 'coding',
  capabilities: { resume: true, jsonEvents: true, permissionModes: true },
};

export async function check(config) {
  const bin = config.agents.dsh.bin;
  const ok = commandExists(bin);
  return {
    id: meta.id,
    label: meta.label,
    ok,
    detail: ok ? 'CLI 可用（headless）' : `未找到 DSH CLI：${bin}`,
    capabilities: meta.capabilities,
  };
}

/**
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {string} ctx.prompt
 * @param {string} ctx.cwd
 * @param {string} [ctx.sessionId]
 * @param {number} [ctx.timeoutMs]
 * @param {number} [ctx.maxTokens]
 * @param {AbortSignal} [ctx.signal]
 * @param {function} [ctx.onEvent] 实时事件（tool_call / thinking / status）
 * @param {string} [ctx.logPath]
 */
export async function run(ctx) {
  const { config, project = null, prompt, cwd, sessionId = '', timeoutMs, maxTokens = 0, signal = null, onEvent = null, logPath = '' } = ctx;
  const dsh = config.agents.dsh;
  if (!commandExists(dsh.bin)) {
    return { ok: false, error: `DSH CLI 不可用：${dsh.bin}`, agentKind: 'dsh', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, logPath };
  }
  ensureDir(dsh.home);
  let permission;
  try {
    permission = resolveAgentPermission(config, 'dsh', project);
  } catch (err) {
    return { ok: false, error: err.message, agentKind: 'dsh', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, logPath, permissionBlocked: true };
  }

  const local = new AbortController();
  let overBudget = false;
  const onParentAbort = () => local.abort();
  if (signal) {
    if (signal.aborted) local.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const args = [
    'headless',
    '--json',
    '--permission-mode',
    permission.mode,
    '--approval-policy',
    dsh.approvalPolicy,
  ];
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-');

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let newSessionId = sessionId;
  let finalText = '';
  let finalReason = null;
  let parseBuffer = '';
  let toolEvents = 0;
  let sawError = '';

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (evt.type === 'session' && evt.sessionId) newSessionId = evt.sessionId;
    else if (evt.type === 'status' && evt.usage) {
      usage.input += Number(evt.usage.inputTokens || 0);
      usage.output += Number(evt.usage.outputTokens || 0);
      usage.cacheRead += Number(evt.usage.cacheReadTokens || 0);
      usage.cacheWrite += Number(evt.usage.cacheWriteTokens || 0);
      const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (maxTokens > 0 && total > maxTokens) {
        overBudget = true;
        try {
          local.abort();
        } catch {
          /* ignore */
        }
      }
    } else if (evt.type === 'tool_call' && onEvent) {
      toolEvents += 1;
      const input = evt.input || {};
      const summary = String(
        input.command || input.file_path || input.path || input.query || input.description || input.pattern || '',
      ).slice(0, 240);
      onEvent({ kind: 'tool_call', tool: evt.tool || 'unknown', summary, callId: evt.callId || '' });
    } else if (evt.type === 'tool_result' && evt.status === 'error' && onEvent && toolEvents <= 8) {
      onEvent({ kind: 'tool_error', tool: '', summary: String(evt.result || '').slice(0, 300) });
    } else if (evt.type === 'final') {
      finalText = String(evt.text || '');
      finalReason = evt.reason || null;
      if (evt.reason?.kind === 'error') {
        sawError = String(evt.reason?.error?.message || 'Agent 返回错误');
        if (onEvent) onEvent({ kind: 'error', summary: sawError.slice(0, 300) });
      }
    }
  };

  const startedAt = Date.now();
  const res = await execCapture(dsh.bin, args, {
    cwd,
    env: buildAgentEnv({ config, agentId: 'dsh', homeDir: ctx.agentHome }),
    timeoutMs: timeoutMs || dsh.timeoutMs,
    stdin: prompt,
    logPath,
    signal: local.signal,
    onStdout: (chunk) => {
      parseBuffer += chunk;
      const lines = parseBuffer.split('\n');
      parseBuffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    },
  });
  if (parseBuffer.trim()) handleLine(parseBuffer);
  if (signal) signal.removeEventListener('abort', onParentAbort);

  const durationMs = Date.now() - startedAt;
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const costCny = estimateCostCny('deepseek', 'deepseek-flash', usage);
  const completed = finalReason?.kind === 'completed';
  let error = '';
  if (overBudget) error = `Agent 超出单任务 token 预算（${totalTokens} > ${maxTokens}），已中止`;
  else if (res.aborted) error = 'Agent 执行被取消';
  else if (res.timedOut) error = `Agent 执行超时（${Math.round((timeoutMs || dsh.timeoutMs) / 1000)}s）`;
  else if (sawError) error = sawError;
  else if (!completed) error = `Agent 未正常完成（exit=${res.code ?? 'null'}${res.signal ? `, signal=${res.signal}` : ''}）`;

  return {
    ok: !error,
    text: finalText,
    error,
    agentKind: 'dsh',
    provider: 'deepseek',
    model: 'deepseek',
    canRunShell: permission.allowShell,
    costReported: false,
    costSource: 'estimated',
    sessionId: newSessionId,
    exitCode: res.code,
    timedOut: res.timedOut,
    aborted: res.aborted || overBudget,
    durationMs,
    usage,
    tokens: totalTokens,
    costCny,
    logPath,
    toolEvents,
  };
}
