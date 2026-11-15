// SPDX-License-Identifier: Apache-2.0
/**
 * 预留的通用 Coding Agent 接口：通过命令模板接入任意模型/CLI（如 Codex、Aider、自研 Agent）。
 *
 * 配置：
 *   CUSTOM_AGENT_BIN=/path/to/agent
 *   CUSTOM_AGENT_ARGS=--prompt-file {prompt_file} --cwd {cwd}
 *   CUSTOM_AGENT_LABEL=My Agent
 *
 * 约定：agent 把最终结果以 JSON 输出到 stdout（可含其他日志行，取最后一个 JSON）：
 *   {"result":"...", "session_id":"可选", "usage":{"input_tokens":0,"output_tokens":0,
 *    "cache_read_input_tokens":0,"cache_creation_input_tokens":0}, "cost_cny":0}
 * 若未提供 JSON，则视为纯文本结果，token/成本按 0 计并明确记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { commandExists, execCapture } from '../runner.js';
import { ensureDir } from '../util.js';

export const meta = {
  id: 'custom',
  label: '自定义 Agent',
  kind: 'coding',
  capabilities: { resume: false, jsonResult: true, extensible: true },
};

export async function check(config) {
  const bin = config.agents.custom.bin;
  const ok = !!bin && commandExists(bin);
  return {
    id: meta.id,
    label: config.agents.custom.label || meta.label,
    ok,
    detail: ok ? '自定义命令可用' : '未配置 CUSTOM_AGENT_BIN',
    capabilities: meta.capabilities,
  };
}

export async function run(ctx) {
  const { config, prompt, cwd, timeoutMs = 600_000, signal = null, logPath = '' } = ctx;
  const custom = config.agents.custom;
  if (!custom.bin || !commandExists(custom.bin)) {
    return { ok: false, error: '自定义 Agent 未配置或不可用', agentKind: 'custom', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, logPath };
  }
  const promptFile = path.join(config.paths.artifactsDir, 'custom-prompts', `${Date.now()}.md`);
  ensureDir(path.dirname(promptFile));
  fs.writeFileSync(promptFile, prompt);
  const args = String(custom.args || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((a) => a.replaceAll('{prompt_file}', promptFile).replaceAll('{cwd}', cwd).replaceAll('{prompt}', ''));
  const startedAt = Date.now();
  const res = await execCapture(custom.bin, args, { cwd, timeoutMs, stdin: prompt, logPath, signal });
  const durationMs = Date.now() - startedAt;
  let data = null;
  const lines = String(res.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      data = JSON.parse(lines[i]);
      break;
    } catch {
      /* continue */
    }
  }
  const u = data?.usage || {};
  const usage = {
    input: Number(u.input_tokens || 0),
    output: Number(u.output_tokens || 0),
    cacheRead: Number(u.cache_read_input_tokens || 0),
    cacheWrite: Number(u.cache_creation_input_tokens || 0),
  };
  const error = res.timedOut ? '自定义 Agent 超时' : res.aborted ? '自定义 Agent 被取消' : res.code !== 0 ? `自定义 Agent 退出码 ${res.code}` : '';
  return {
    ok: !error,
    text: data ? String(data.result || '') : String(res.stdout || '').trim(),
    error,
    agentKind: 'custom',
    sessionId: data?.session_id || '',
    exitCode: res.code,
    timedOut: res.timedOut,
    aborted: res.aborted,
    durationMs,
    usage,
    tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    costCny: Number(data?.cost_cny || 0),
    logPath,
  };
}
