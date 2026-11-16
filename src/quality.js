// SPDX-License-Identifier: Apache-2.0
/**
 * v2.7 Product Quality Loop：需求覆盖矩阵 + 有证据的质量问题 + 自动修复任务。
 *
 * 设计边界：
 * - 质量评估是确定性的证据合并器，不让 Coding Agent 自评通过；
 * - 只接受“可复现质量命令输出 / 测试 / 独立审计”中的具体证据；
 * - 没有证据的问题只记为 hypothesis，不自动生成修复任务；
 * - 质量命令由验收方预置（隐藏测试/静态检查），不把预置缺陷清单交给 Coding Agent。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCapture } from './runner.js';
import { buildTestEnv } from './security.js';
import { PolicyError, redact } from './policy.js';
import { nowIso } from './util.js';

const STATUS = ['PASS', 'FAIL', 'UNKNOWN', 'BLOCKED'];
const NORM = { pass: 'PASS', passed: 'PASS', fail: 'FAIL', failed: 'FAIL', unproven: 'UNKNOWN', unknown: 'UNKNOWN', blocked: 'BLOCKED', blocked_by_policy: 'BLOCKED' };
const PRIORITY = { p0: 'P0', p1: 'P1', p2: 'P2' };
function osHome() { return process.env.HOME || process.env.USERPROFILE || '/tmp'; }
function requireTmpDir() { return os.tmpdir(); }

export function qualityConfig(project) {
  const cfg = project?.config_json?.quality;
  if (!cfg || typeof cfg !== 'object') return null;
  const requirements = Array.isArray(cfg.requirements) ? cfg.requirements : [];
  if (!requirements.length) return null;
  return {
    ...cfg,
    requirements: requirements.map((r, i) => ({
      id: String(r.id || `R${i + 1}`),
      title: String(r.title || r.requirement || `需求 ${i + 1}`),
      description: String(r.description || ''),
      acceptance: Array.isArray(r.acceptance) ? r.acceptance.map(String) : [],
      priority: PRIORITY[String(r.priority || 'p1').toLowerCase()] || 'P1',
      required: r.required !== false,
      codeRefs: Array.isArray(r.code) ? r.code : [],
      testRefs: Array.isArray(r.tests) ? r.tests : [],
      auditRefs: Array.isArray(r.audit) ? r.audit : [],
    })),
    qualityCommand: String(cfg.quality_command || cfg.qualityCommand || ''),
    maxCycles: Math.max(0, Math.min(5, Number(cfg.max_cycles ?? 2))),
    maxIssuesPerCycle: Math.max(1, Math.min(20, Number(cfg.max_issues_per_cycle ?? 6))),
    timeoutMs: Math.max(500, Number(cfg.timeout_ms || 300_000)),
    stopOnUnknown: cfg.stop_on_unknown !== false,
    envAllowlist: Array.isArray(cfg.env_allowlist) ? cfg.env_allowlist : [],
    allowedCommands: Array.isArray(cfg.allowed_commands) ? cfg.allowed_commands.map(String) : [],
    denyNetwork: cfg.deny_network !== false,
    sandbox: String(cfg.sandbox || 'auto'),
  };
}

function normStatus(value) {
  return NORM[String(value || '').toLowerCase()] || 'UNKNOWN';
}

function parseJsonOutput(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* continue */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* ignore */ } }
  return null;
}

/**
 * 异步执行质量命令（隐藏测试/静态检查由项目配置提供；不在本模块写产品代码）。
 *
 * P0 安全约束：
 * - 不继承宿主 process.env；使用 buildTestEnv + 项目显式 env allowlist；
 * - 不传递 API Key、GitHub Token 或无关凭据；
 * - 显式命令 allowlist（若配置）；无 shell 凭据泄露；
 * - 异步可取消/超时，避免阻塞 Workbench 健康检查事件循环；
 * - 非零退出码、超时、spawn 异常、无效 JSON 一律 commandFailed，不能 PASS。
 */
export async function runQualityCommand({ config, project, signal = null }) {
  const q = qualityConfig(project);
  if (!q) return { ok: false, commandFailed: true, reason: '项目未配置质量需求/quality_command', skipped: true, requirements: [], issues: [], stdout: '', stderr: '', exitCode: null };
  if (!q.qualityCommand) return { ok: false, commandFailed: true, reason: '项目未配置 quality_command，不能伪造质量通过', requirements: [], issues: [], stdout: '', stderr: '', exitCode: null };
  const cwd = project.local_path;
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, commandFailed: true, reason: `项目目录不存在：${cwd}`, requirements: [], issues: [], stdout: '', stderr: '', exitCode: null };
  if (q.allowedCommands.length && !q.allowedCommands.includes(q.qualityCommand)) {
    return { ok: false, commandFailed: true, reason: '质量命令不在项目 allowlist 中，已拒绝执行（安全策略）', requirements: [], issues: [], stdout: '', stderr: '', exitCode: null };
  }
  const home = fs.mkdtempSync(path.join(requireTmpDir(), 'wb-quality-home-'));
  const extraEnv = { WORKBENCH_PROJECT_ID: project.id, WORKBENCH_PROJECT_REPO: cwd, WORKBENCH_QUALITY_MODE: '1' };
  // 仅项目显式允许的环境变量可以进入质量检查；buildTestEnv 本身绝不做 process.env 全量继承。
  const allowExtra = {};
  for (const key of q.envAllowlist) if (process.env[key] !== undefined) allowExtra[key] = process.env[key];
  const env = buildTestEnv({ config, project, homeDir: home, extraEnv: { ...allowExtra, ...extraEnv } });
  const started = Date.now();
  const sandboxMode = process.platform === 'darwin' && q.sandbox !== 'off' && q.denyNetwork && fs.existsSync('/usr/bin/sandbox-exec') ? 'macos' : 'env-only';
  let command = '/bin/sh';
  let args = ['-c', q.qualityCommand];
  if (sandboxMode === 'macos') {
    const profilePath = path.join(home, 'quality.sandbox');
    const sensitiveRead = [path.join(config.root, '.env'), config.paths.dataDir, path.join(osHome(), '.dsh'), path.join(osHome(), '.ssh')];
    const sensitiveWrite = [config.paths.dataDir, path.join(osHome(), '.dsh'), path.join(osHome(), '.ssh')];
    const quote = (p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      ...sensitiveRead.map((p) => `(deny file-read* (subpath ${quote(p)}))`),
      ...sensitiveWrite.map((p) => `(deny file-write* (subpath ${quote(p)}))`),
    ].join('\n');
    fs.writeFileSync(profilePath, profile);
    command = '/usr/bin/sandbox-exec';
    args = ['-p', profile, '/bin/sh', '-c', q.qualityCommand];
  }
  let res = await execCapture(command, args, {
    cwd, env, timeoutMs: q.timeoutMs, signal, abortReason: 'quality-command-aborted',
    logPath: path.join(home, 'quality.log'),
  });
  let sandboxFallback = '';
  // 当前受限宿主可能连 sandbox-exec 都不允许（sandbox_apply EPERM）；此时显式降级为最小环境执行并记录，
  // 不把沙箱基础设施失败误判为产品缺陷。
  if (sandboxMode === 'macos' && res.code !== 0 && /sandbox_apply:\s*Operation not permitted/i.test(String(res.stderr || ''))) {
    sandboxFallback = 'sandbox-exec unavailable (EPERM); executed with minimal env only';
    res = await execCapture('/bin/sh', ['-c', q.qualityCommand], {
      cwd, env, timeoutMs: q.timeoutMs, signal, abortReason: 'quality-command-aborted',
      logPath: path.join(home, 'quality.log'),
    });
  }
  const stdout = String(res.stdout || '');
  const stderr = String(res.stderr || '');
  const base = { stdout, stderr, exitCode: res.code, timedOut: !!res.timedOut, spawnError: !!res.spawnError, durationMs: Date.now() - started, sandbox: sandboxFallback ? 'env-only-fallback' : sandboxMode, sandboxFallback };
  if (res.spawnError) {
    const reason = `质量命令无法启动：${stderr.slice(0, 600) || 'spawn error'}`;
    return { ok: false, commandFailed: true, reason, issueClass: 'SPAWN_ERROR', ...base, requirements: [], issues: [{ id: 'quality-command-spawn', title: reason, priority: 'P0', evidence: reason, requirementId: '', hypothesis: true, source: 'quality-command' }] };
  }
  if (res.timedOut) {
    const reason = `质量命令超时（${q.timeoutMs}ms），已终止子进程`;
    return { ok: false, commandFailed: true, reason, issueClass: 'TIMEOUT', ...base, requirements: [], issues: [{ id: 'quality-command-timeout', title: reason, priority: 'P0', evidence: reason, requirementId: '', hypothesis: true, source: 'quality-command' }] };
  }
  if (res.code !== 0) {
    const reason = `质量命令非零退出码 exit=${res.code}；非零退出不得视为成功检查`;
    return { ok: false, commandFailed: true, reason, issueClass: 'NONZERO_EXIT', ...base, requirements: [], issues: [{ id: 'quality-command-nonzero', title: reason, priority: 'P0', evidence: redact((stderr || stdout || reason).slice(-4000), config), requirementId: '', hypothesis: true, source: 'quality-command' }] };
  }
  const parsed = parseJsonOutput(stdout);
  if (!parsed) {
    const reason = `质量命令 exit=0 但输出不是有效 JSON（损坏/截断），不能判定 PASS`;
    return { ok: false, commandFailed: true, reason, issueClass: 'INVALID_JSON', ...base, requirements: [], issues: [{ id: 'quality-command-invalid-json', title: reason, priority: 'P0', evidence: redact((stdout || stderr || reason).slice(-4000), config), requirementId: '', hypothesis: true, source: 'quality-command' }] };
  }
  return { ok: true, parsed, requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [], issues: Array.isArray(parsed.issues) ? parsed.issues : [], ...base, reason: '' };
}

function evidenceText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  try { return JSON.stringify(value).slice(0, 4000); } catch { return ''; }
}

function evidenceIsConcrete(value) {
  const text = evidenceText(value);
  if (!text || text.length < 8) return false;
  if (/^(n\/?a|none|null|unknown|unproven|tbd|todo|na|x+|-+|无|没有|待补|待定|不适用)$/i.test(text)) return false;
  return true;
}

function normalizeIssue(issue, req, source) {
  const evidence = evidenceText(issue?.evidence || issue?.repro || issue?.details);
  const title = String(issue?.title || issue?.issue || issue?.message || '').trim();
  if (!title) return null;
  const priority = PRIORITY[String(issue?.priority || issue?.severity || req?.priority || 'P1').toLowerCase()] || 'P1';
  return {
    id: String(issue?.id || `${source}-${req?.id || 'x'}-${title}`).slice(0, 120),
    title: title.slice(0, 500),
    priority,
    evidence,
    requirementId: String(issue?.requirement_id || issue?.requirementId || req?.id || ''),
    hypothesis: !evidence, // 无证据 → 假设，不得当作确定缺陷
    source,
  };
}

/**
 * 生成 Requirements Coverage Matrix；
 * 每条需求的 PASS 必须有质量命令证据或独立审计证据，否则不得 PASS。
 */
export function buildCoverageMatrix({ project, qualityRun, audits = [] }) {
  const q = qualityConfig(project);
  const requirements = q ? q.requirements : [];
  const byId = new Map((qualityRun.requirements || []).map((r) => [String(r.id || r.requirement_id || ''), r]));
  const matrix = [];
  const issues = [];
  if (qualityRun.commandFailed) {
    for (const req of requirements) {
      matrix.push({ id: req.id, title: req.title, description: req.description, priority: req.priority, required: req.required, acceptance: req.acceptance, codeRefs: req.codeRefs, testRefs: req.testRefs, auditRefs: req.auditRefs, status: 'UNKNOWN', evidence: '', auditEvidence: [], issues: [] });
      issues.push({ id: `quality-command-error-${req.id}`, title: `质量命令失败，未评估需求「${req.title}」`, priority: 'P0', evidence: qualityRun.reason || '', requirementId: req.id, hypothesis: true, source: 'quality-command' });
    }
    return { requirements: matrix, issues, allPass: false, coverage: { total: matrix.length, pass: 0, fail: 0, unknown: matrix.length, blocked: 0 }, p0p1: [], generatedAt: nowIso(), qualityCommandRan: false, qualityCommandError: qualityRun.reason || '质量命令失败' };
  }
  const auditText = (audits || []).map((a) => ({
    id: a.id || '', status: a.verification_status || a.status || '', score: a.score,
    criteria: Array.isArray(a.criteria) ? a.criteria : [],
    requiredFixes: Array.isArray(a.requiredFixes) ? a.requiredFixes : [],
  }));
  for (const req of requirements) {
    const raw = byId.get(req.id);
    const rawStatus = raw ? normStatus(raw.status || raw.coverage_status) : 'UNKNOWN';
    const rawEvidence = evidenceText(raw?.evidence || raw?.test_evidence || raw?.output);
    const auditEvidence = auditText.filter((a) => a.status === 'PASS' && (req.auditRefs || []).some((ref) => {
      const text = `${a.id} ${(a.criteria || []).map((c) => `${c.criterion} ${c.evidence}`).join(' ')}`;
      return ref && text.includes(String(ref));
    }));
    let status = rawStatus;
    let evidence = rawEvidence;
    // 质量命令明确 PASS 且带证据才 PASS；仅任务通过不算。
    if (status === 'PASS' && !evidenceIsConcrete(evidence) && !auditEvidence.length) status = 'UNKNOWN';
    if (status === 'PASS' && auditEvidence.length && !evidenceIsConcrete(evidence)) evidence = `独立审计：${auditEvidence.map((a) => a.id).join(', ')}`;
    const reqIssues = [];
    for (const i of (raw?.issues || [])) { const n = normalizeIssue(i, req, 'quality-command'); if (n) reqIssues.push(n); }
    for (const n of reqIssues) issues.push(n);
    if (!raw) {
      const unknown = { id: `requirement-not-evaluated-${req.id}`, title: `质量命令没有评估需求「${req.title}」`, priority: req.priority, evidence: qualityRun.reason || '质量命令未返回该需求结果', requirementId: req.id, hypothesis: true, source: 'coverage' };
      issues.push(unknown);
    }
    if (status !== 'PASS' && status !== 'BLOCKED' && !reqIssues.some((i) => i.priority === 'P0' || i.priority === 'P1')) {
      issues.push({
        id: `requirement-${req.id}-${status}`, title: `需求未通过：${req.title}`,
        priority: req.priority, evidence: evidence || qualityRun.reason || '质量命令证据不足',
        requirementId: req.id, hypothesis: !evidence && !qualityRun.reason, source: 'coverage',
      });
    }
    matrix.push({
      id: req.id, title: req.title, description: req.description,
      priority: req.priority, required: req.required,
      acceptance: req.acceptance, codeRefs: req.codeRefs, testRefs: req.testRefs, auditRefs: req.auditRefs,
      status, evidence: evidence || '',
      auditEvidence: auditEvidence.map((a) => ({ id: a.id, score: a.score, status: a.status })),
      issues: reqIssues,
    });
  }
  // 质量命令发现但不属于已知需求的 issue 也保留（不能丢弃）。
  for (const raw of (qualityRun.issues || [])) {
    const n = normalizeIssue(raw, null, 'quality-command');
    if (n && !issues.some((x) => x.id === n.id)) issues.push(n);
  }
  // 验收门槛：必须需求且非 P2 全部 PASS；P2 改进记录但不阻塞（用户要求 P0/P1 解决）。
  const required = matrix.filter((m) => m.required && m.priority !== 'P2');
  const allPass = required.length > 0 && required.every((m) => m.status === 'PASS') && !issues.some((i) => (i.priority === 'P0' || i.priority === 'P1') && !i.hypothesis);
  const p0p1 = issues.filter((i) => (i.priority === 'P0' || i.priority === 'P1') && !i.hypothesis);
  return {
    requirements: matrix,
    issues,
    allPass,
    coverage: {
      total: matrix.length,
      pass: matrix.filter((m) => m.status === 'PASS').length,
      fail: matrix.filter((m) => m.status === 'FAIL').length,
      unknown: matrix.filter((m) => m.status === 'UNKNOWN').length,
      blocked: matrix.filter((m) => m.status === 'BLOCKED').length,
    },
    p0p1,
    generatedAt: nowIso(),
    qualityCommandRan: !!qualityRun && !qualityRun.skipped,
    qualityCommandError: qualityRun?.ok === false ? qualityRun.reason : '',
  };
}

/** 只把有证据的 P0/P1 问题转成修复任务；无证据的假设需先补证据，不自动改代码。 */
export function repairTasksFromQuality(matrix, { maxIssues = 6 } = {}) {
  const tasks = [];
  const seen = new Set();
  for (const issue of (matrix.p0p1 || []).slice(0, maxIssues)) {
    if (!issue.evidence || issue.hypothesis) continue;
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    const base = String(issue.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
    tasks.push({
      title: `[Quality ${issue.priority}] ${issue.title}`.slice(0, 190),
      description: [
        `质量闭环发现问题：${issue.title}`,
        `优先级：${issue.priority}`,
        `需求：${issue.requirementId || '未关联'}`,
        `可复现证据：${issue.evidence}`,
        '只修复该问题，不扩大原始产品范围；不得修改冻结测试/验收契约。',
        `qualityIssueId=${issue.id}`,
      ].join('\n'),
      acceptance: [
        `代码修改应修复质量问题「${issue.title}」，包含具体代码修改与可核对行为证据`,
        `项目可见测试全部通过，且未修改冻结测试/契约`,
        `不需要审计员运行项目外质量命令；质量命令复核由工作台质量评估执行`,
      ],
      agent: 'auto',
      qualityIssueId: issue.id,
      qualityPriority: issue.priority,
      queueKey: `quality:${base}`,
    });
  }
  return tasks;
}

/** 从历史中读取最近一次质量矩阵（只读 API 使用）。 */
export function latestMatrixFromHistory(loop) {
  const history = Array.isArray(loop?.history_json) ? loop.history_json : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.quality?.requirements) return history[i].quality;
  }
  return null;
}
