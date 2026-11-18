// SPDX-License-Identifier: Apache-2.0
/**
 * DeepSeekHarnessAuditAdapter（v2.5）
 *
 * 使用真实安装的 DSH headless CLI，在**只读**独立审计工作区中审计一个任务/commit。
 * - 审计工作区是 worktree 的临时副本（排除 .git/node_modules），DSH permission-mode=read-only；
 * - 输入：任务、逐条验收标准、commit/tree、diff、测试结果、仓库文件；
 * - 输出：逐条 PASS/FAIL/UNKNOWN + 证据 + 修复意见；
 * - 记录真实 token/usage/费用来源（DSH CLI 使用现有 DeepSeek API Key，受原预算约束）。
 * 不允许 DSH 修改产品代码；审计提交失败/无法确认身份时 fail-closed。
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { commandExists, execCapture } from '../runner.js';
import { buildAgentEnv } from '../security.js';
import { estimateCostCny } from '../pricing.js';
import { PolicyError, finalizeAuditVerdict, modelFamily, summarizeUsage } from '../policy.js';
import { truncate } from '../util.js';

function copyAuditWorkspace(worktree, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(worktree, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(worktree, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (parts.includes('.git') || parts.includes('node_modules') || parts.includes('.workbench')) return false;
      return true;
    },
  });
}

function materializeCommit(repo, commit, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(path.dirname(dest), `candidate-${Date.now().toString(36)}.tar`);
  try {
    const pack = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, commit], { encoding: 'utf8' });
    if (pack.status !== 0) throw new PolicyError('AUDIT_SNAPSHOT_FAILED', `无法读取候选 commit ${commit}：${pack.stderr || pack.stdout}`);
    const extract = spawnSync('tar', ['-xf', tar, '-C', dest], { encoding: 'utf8' });
    if (extract.status !== 0) throw new PolicyError('AUDIT_SNAPSHOT_FAILED', `无法解包候选 commit ${commit}：${extract.stderr || extract.stdout}`);
  } finally { try { fs.rmSync(tar, { force: true }); } catch { /* ignore */ } }
}

export function dshAuditAvailable(config) {
  try { return commandExists(config.agents.dsh.bin); } catch { return false; }
}

function buildPrompt({ task, acceptance, diff, diffStat, testResult, repoFiles, versionInfo, commit }) {
  const testEvidence = testResult ? [
    `命令：${testResult.command}`,
    `退出码：${testResult.code}`,
    testResult.durationMs ? `耗时：${Math.round(testResult.durationMs / 1000)}s` : '',
    `输出：\n${truncate(testResult.stdout || '', 5000)}`,
    testResult.stderr ? `stderr：\n${truncate(testResult.stderr, 1500)}` : '',
    testResult.isolation ? `隔离：${JSON.stringify(testResult.isolation)}` : '',
  ].filter(Boolean).join('\n') : '（无）';
  return `你是独立审计员，未参与编码。审计工作区只读；禁止修改任何文件。请只输出一个 JSON 对象，不要 Markdown。

## 任务
${task.title}
${task.description || ''}

## 验收标准（必须逐条原样复制 criterion，不得改写/遗漏）
${acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}

## 被审计版本
- base commit: ${versionInfo.baseCommit || 'unknown'}
- tested tree hash: ${versionInfo.testedHash || versionInfo.worktreeHash || 'unknown'}
- final commit (如已存在): ${commit || '尚未生成，审计对象为 tested tree'}
- 仓库文件：${repoFiles.slice(0, 80).join(', ') || '（不可用）'}

## 代码变更统计
${diffStat || '（无）'}

## 代码 diff
${truncate(diff, 50000)}

## 测试证据
${testEvidence}

## 输出 JSON 格式
{"score":0-100,"criteria":[{"criterion":"逐字复制","status":"pass|fail|unproven","evidence":"具体文件:行号/命令输出/代码行为"}],"findings":[{"severity":"high|medium|low","file":"","line":0,"issue":"","required_fix":""}],"required_fixes":["具体修复"],"summary":"一句话"}
PASS 必须有具体证据；证据不足必须 unproven；同族自审或无法审计必须 unproven。`;
}

function parseEvents(stdout) {
  let finalText = '';
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sessionId = '';
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'session' && evt.sessionId) sessionId = evt.sessionId;
    if (evt.type === 'status' && evt.usage) {
      usage.input += Number(evt.usage.inputTokens || 0);
      usage.output += Number(evt.usage.outputTokens || 0);
      usage.cacheRead += Number(evt.usage.cacheReadTokens || 0);
      usage.cacheWrite += Number(evt.usage.cacheWriteTokens || 0);
    }
    if (evt.type === 'final' && typeof evt.text === 'string') finalText = evt.text;
  }
  return { finalText, usage, sessionId };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch { /* continue */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* ignore */ } }
  return null;
}

export async function runDshAudit({ config, project, task, acceptance, diff, diffStat, testResult, repoFiles = [], versionInfo = {}, worktree, commit = '', coderFamily = '', signal = null }) {
  if (!acceptance.length) throw new PolicyError('AUDIT_NO_CRITERIA', '任务没有验收标准');
  if (!dshAuditAvailable(config)) throw new PolicyError('AUDIT_UNAVAILABLE', 'DSH CLI 不可用，无法执行 DSH 独立审计');
  if (!worktree || !fs.existsSync(worktree)) throw new PolicyError('AUDIT_WORKSPACE_MISSING', 'DSH 审计工作区不存在');
  if (coderFamily && modelFamily('deepseek', 'deepseek') === coderFamily) {
    throw new PolicyError('AUDIT_UNAVAILABLE', 'DSH 审计模型与编码模型族相同，拒绝同族自审');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dsh-audit-'));
  const work = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    if (commit && project?.local_path) materializeCommit(project.local_path, commit, work);
    else copyAuditWorkspace(worktree, work);
    const prompt = buildPrompt({ task, acceptance, diff, diffStat, testResult, repoFiles, versionInfo, commit });
    // 只读保护：审计工作区取消写权限（DSH 仍以 read-only permission preset 运行）
    try { fs.chmodSync(work, 0o555); } catch { /* ignore */ }
    const env = buildAgentEnv({ config, agentId: 'dsh', homeDir: home });
    const args = ['headless', '--json', '--permission-mode', 'read-only', '--approval-policy', 'never', '-'];
    const startedAt = Date.now();
    const res = await execCapture(config.agents.dsh.bin, args, {
      cwd: work,
      env,
      stdin: prompt,
      timeoutMs: config.audit.timeoutMs,
      signal,
      logPath: path.join(root, 'dsh-audit.log'),
      onStdout: null,
    });
    const durationMs = Date.now() - startedAt;
    const parsed = parseEvents(res.stdout);
    if (!parsed.finalText) {
      const reason = res.timedOut ? 'DSH 审计超时' : res.aborted ? 'DSH 审计被取消' : 'DSH 未返回最终审计文本';
      return {
        provider: 'deepseek', providerLabel: 'DeepSeek Harness', providerSource: 'dsh-cli', model: 'deepseek',
        status: 'UNKNOWN', verdict: 'fail', score: 0, criteria: [], findings: [], highFindings: [],
        requiredFixes: [`DSH 审计无法完成：${reason}`], unknownReasons: [reason],
        summary: reason, usage: parsed.usage, costCny: estimateCostCny('deepseek', 'deepseek', parsed.usage),
        independence: { independent: true, coderFamily, note: 'DSH CLI read-only audit' },
        chunks: 1, versionInfo, rawText: '', durationMs, sessionId: parsed.sessionId,
      };
    }
    const data = extractJson(parsed.finalText);
    if (!data) {
      return {
        provider: 'deepseek', providerLabel: 'DeepSeek Harness', providerSource: 'dsh-cli', model: 'deepseek',
        status: 'UNKNOWN', verdict: 'fail', score: 0, criteria: [], findings: [], highFindings: [],
        requiredFixes: ['DSH 返回内容不是可解析 JSON，不能伪造审计结论'], unknownReasons: ['DSH 输出无法解析'],
        summary: 'DSH 输出无法解析', usage: parsed.usage, costCny: estimateCostCny('deepseek', 'deepseek', parsed.usage),
        independence: { independent: true, coderFamily, note: 'DSH CLI read-only audit' },
        chunks: 1, versionInfo, rawText: parsed.finalText.slice(0, 3000), durationMs, sessionId: parsed.sessionId,
      };
    }
    const final = finalizeAuditVerdict(data, acceptance);
    const usage = parsed.usage;
    return {
      provider: 'deepseek', providerLabel: 'DeepSeek Harness', providerSource: 'dsh-cli', model: 'deepseek',
      status: final.status, verdict: final.verdict, score: final.score, criteria: final.criteria,
      findings: final.findings, highFindings: final.highFindings, requiredFixes: final.requiredFixes,
      unknownReasons: final.unknownReasons, summary: final.summary,
      usage, costCny: estimateCostCny('deepseek', 'deepseek', usage),
      costReported: false, costSource: 'estimated',
      independence: { independent: true, coderFamily, note: 'DSH CLI read-only audit; DeepSeek API budget' },
      chunks: 1, versionInfo, rawText: parsed.finalText.slice(0, 3000), durationMs, sessionId: parsed.sessionId,
    };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
