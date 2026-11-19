// SPDX-License-Identifier: Apache-2.0
/**
 * 统一编排器：确定性任务状态机 + 多 Agent 调度 + 独立审计 + 自动修复 + 预算/权限控制 + 断点恢复。
 *
 * 任务状态机（持久化在 SQLite，每次迁移都是 CAS）：
 *   queued -> preparing -> coding -> testing -> auditing -> committing -> passed
 *                                  ^            |
 *                                  └── repairing ┘（审计/测试失败，反馈给同一 Agent 修复）
 * 失败超过重试上限 -> failed（记录阻塞原因，不伪造通过）
 *
 * 运行级状态：queued -> running -> awaiting_acceptance -> accepted（人工验收）
 *                    ├-> paused（预算/失败/人工） -> running（resume）
 *                    └-> cancelled
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nowIso, newId, ensureDir, truncate, tailLines, safeFilename, parseList } from './util.js';
import {
  PolicyError, RunStatus, TaskStatus, assertBudgetAllowed, assertProjectBudget, assertRunWallClock,
  failureSignature, finalizeAuditVerdict, modelFamily, protectedViolations, protectPathsForProject,
  redact, summarizeUsage, verificationState,
} from './policy.js';
import { estimateCostCny } from './pricing.js';
import * as gitops from './git.js';
import { execShell } from './runner.js';
import { assertIsolationForProject, detectIsolationCapabilities, isolationModeForProject } from './isolation.js';
import { resolveAgentIdentity, resolveLlmIdentity, isExemptIdentity } from './model-identity.js';
import { runTestInContainer, containerCapabilities } from './container.js';
import { buildRepoContext, planTasks } from './planner.js';
import { availableProviders } from './llm.js';
import { runAudit, auditSummaryText, auditProviderStatus, resolveAuditProvider } from './auditors/index.js';
import { deriveClausePlan } from './quality.js';
import { assertModelBudget, evaluateProviderRiskGate, resolveCodingReservation, recordModelUsage } from './budget.js';
import { verifyContractBaseline, verifyTestBaseline, validateTestEvidence, findTestFiles, sha256File, trustedProductTestCommand, parseTestCount, classifyTestFailure } from './contract.js';
import { dshAuditAvailable } from './auditors/dsh.js';
import { chooseAgent, checkAllAgents, runAgent } from './agents/index.js';
import { AsyncSemaphore } from './semaphore.js';
import * as gh from './github.js';
import {
  assertSafeTestCommand, buildTestEnv, hashText, resolveAgentPermission, resolveWithin,
  tmpHomeFor, WriteRateLimiter, isAllowedHost, assertSafeWriteRequest, redactForResponse,
} from './security.js';

const VERSION = '3.3.0';

export class Orchestrator {
  constructor({ config, store, bus, deps = {} }) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.running = new Set();
    this.controllers = new Map();
    this.agentSemaphore = new AsyncSemaphore(config.budget.maxAgentConcurrency || 2);
    this.projectLeases = new Map();
    this.startedAt = Date.now();
    this.instanceId = `wb:${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    // 依赖注入（仅用于测试/扩展；生产环境使用真实 Agent 与审计器）
    this.deps = {
      runAgent: deps.runAgent || runAgent,
      chooseAgent: deps.chooseAgent || chooseAgent,
      runAudit: deps.runAudit || runAudit,
      checkAgents: deps.checkAgents || checkAllAgents,
    };
  }

  leaseFor(projectId) {
    return this.projectLeases.get(projectId) || null;
  }

  releaseProjectLease(projectId) {
    const lease = this.projectLeases.get(projectId);
    if (!lease) return;
    try { this.store.releaseProjectLeaseFenced(projectId, lease.owner, lease.fence); } catch { /* ignore */ }
    this.projectLeases.delete(projectId);
  }

  /** 关键写操作前校验：当前 DB 租约必须仍属于本执行者且 fence 一致；否则立即抛错。 */
  assertProjectLease(projectId) {
    const lease = this.projectLeases.get(projectId);
    if (!lease) throw new PolicyError('LEASE_LOST', '当前执行者没有项目写租约，拒绝继续写入');
    const row = this.store.getProjectLease(projectId);
    const expired = !row?.lease_expires_at || row.lease_expires_at <= new Date().toISOString();
    if (!row || row.write_owner !== lease.owner || Number(row.lease_fence) !== Number(lease.fence) || expired) {
      this.projectLeases.delete(projectId);
      throw new PolicyError('LEASE_LOST', `项目写租约已失效/被接管（期望 fence ${lease.fence}，实际 ${row?.lease_fence ?? 'none'}，过期=${expired}），拒绝旧执行者继续写入`);
    }
    return lease;
  }

  // ============================================================
  // 事件与持久化辅助
  // ============================================================
  emit({ runId = '', projectId = '', taskId = '', type, level = 'info', message = '', data = {} }) {
    const safeMessage = redact(message, this.config);
    const safeData = JSON.parse(redact(JSON.stringify(data || {}), this.config));
    const row = this.store.appendEvent({
      runId,
      projectId,
      taskId,
      type,
      level,
      message: safeMessage,
      data: safeData,
    });
    const event = {
      id: row.id,
      runId,
      projectId,
      taskId,
      type,
      level,
      message: safeMessage,
      data: safeData,
      createdAt: row.createdAt,
    };
    this.bus.publish(event);
    return event;
  }

  artifactsDir(runId) {
    return path.join(this.config.paths.artifactsDir, runId);
  }

  writeArtifact({ runId, taskId = '', kind, filename, content }) {
    const dir = this.artifactsDir(runId);
    ensureDir(dir);
    const file = path.join(dir, `${safeFilename(filename)}`);
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(file, text);
    const rel = path.relative(this.config.paths.dataDir, file);
    this.store.addArtifact({ id: newId('art'), runId, taskId, kind, path: rel, meta: { bytes: Buffer.byteLength(text) } });
    return rel;
  }

  artifactAbs(rel) {
    if (!rel) return '';
    return path.isAbsolute(rel) ? rel : path.join(this.config.paths.dataDir, rel);
  }

  logsDir(runId, taskId = '') {
    return path.join(this.config.paths.logsDir, runId, taskId);
  }

  recordLlmUsage({ runId, taskId = '', source, provider, model, usage, costCny }) {
    const u = summarizeUsage(usage || {});
    const identity = resolveLlmIdentity({ config: this.config, provider });
    const actualProvider = identity.known ? identity.provider : 'unknown';
    const attempt = this.store.createAttempt({
      id: newId('att'),
      runId,
      taskId,
      attemptNo: 0,
      stage: source,
      agentKind: source,
      provider: actualProvider,
      providerKnown: identity.known,
      providerSource: identity.source,
      model: model || identity.model || '',
      sessionId: '',
      prompt: '',
      status: 'completed',
      error: '',
      feedback: '',
      tokensIn: u.input,
      tokensOut: u.output,
      tokensCache: u.cacheRead + u.cacheWrite,
      costCny: costCny || 0,
      durationMs: 0,
      logPath: '',
    });
    this.store.addRunUsage(runId, { tokens: u.total, costCny: costCny || 0 });
    this.store.setMeta('last_llm', { provider, model, source, at: nowIso() });
    return attempt;
  }

  weightUsage(raw) {
    const exempt = new Set(this.config.budget.exemptProviders || ['glm']);
    const weight = Number(this.config.budget.cacheTokenWeight ?? 0.1);
    const byProvider = raw.byProvider || {};
    let budgetTokens = 0;
    let budgetCostCny = 0;
    for (const [name, agg] of Object.entries(byProvider)) {
      if (exempt.has(String(name).toLowerCase()) && agg.known !== false) continue;
      budgetTokens += Number(agg.tokensIn || 0) + Number(agg.tokensOut || 0) + Number(agg.tokensCache || 0) * weight;
      budgetCostCny += Number(agg.costCny || 0);
    }
    const glm = byProvider.glm || { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0 };
    const nonGlm = Object.entries(byProvider).reduce((acc, [name, agg]) => {
      if (exempt.has(String(name).toLowerCase()) && agg.known !== false) return acc;
      acc.tokensIn += Number(agg.tokensIn || 0);
      acc.tokensOut += Number(agg.tokensOut || 0);
      acc.tokensCache += Number(agg.tokensCache || 0);
      acc.costCny += Number(agg.costCny || 0);
      acc.names.push(name);
      return acc;
    }, { tokensIn: 0, tokensOut: 0, tokensCache: 0, costCny: 0, names: [] });
    nonGlm.tokens = nonGlm.tokensIn + nonGlm.tokensOut + nonGlm.tokensCache;
    return {
      ...raw,
      byProvider,
      budgetTokens,
      budgetCostCny,
      glmUnlimited: this.config.budget.glmUnlimited !== false,
      exemptProviders: [...exempt],
      glm,
      nonGlm,
      cacheTokenWeight: weight,
    };
  }

  usage() {
    return this.weightUsage(this.store.usageTotals());
  }

  weightProjectUsage(raw) {
    return this.weightUsage(raw);
  }

  budget() {
    const used = this.usage();
    const cfg = this.config.budget;
    const reserved = this.store.reservedBudgetTotals ? this.store.reservedBudgetTotals() : { tokens: 0, costCny: 0 };
    const effectiveUsed = Number(used.budgetTokens || 0);
    return {
      maxTokens: cfg.maxTotalTokens,
      usedTokens: used.tokens + Number(used.projectAudit?.tokens || 0),
      usedBudgetTokens: Math.round(effectiveUsed),
      projectAudit: used.projectAudit || { tokens: 0, costCny: 0 },
      cacheTokenWeight: used.cacheTokenWeight,
      glmUnlimited: used.glmUnlimited,
      exemptProviders: used.exemptProviders,
      glm: used.glm,
      nonGlm: used.nonGlm,
      byProvider: used.byProvider,
      maxCostCny: cfg.maxCostCny,
      usedCostCny: Number((used.costCny + Number(used.projectAudit?.costCny || 0)).toFixed(4)),
      usedBudgetCostCny: Number(used.budgetCostCny.toFixed(4)),
      reservedTokens: Number(reserved.tokens || 0),
      reservedCostCny: Number(reserved.costCny || 0),
      remainingTokens: Math.max(0, cfg.maxTotalTokens - effectiveUsed - Number(reserved.tokens || 0)),
      remainingCostCny: Math.max(0, cfg.maxCostCny - used.budgetCostCny - Number(reserved.costCny || 0)),
      tokensPercent: Math.min(100, Math.round((effectiveUsed / cfg.maxTotalTokens) * 1000) / 10),
      costPercent: Math.min(100, Math.round((used.budgetCostCny / cfg.maxCostCny) * 1000) / 10),
      breakdown: used,
      note: '仅当实际模型供应商被识别为 GLM 时豁免工作台 token/费用上限；未知供应商不豁免；其余模型仍受原预算（缓存按权重折算）约束',
      identityPolicy: 'provider identity: glm(exempt) / deepseek / openai / anthropic / unknown(not exempt)',
    };
  }

  experimentIdForProject(projectId) {
    return this.store.getExperimentForProject?.(projectId)?.id || '';
  }

  experimentScopeForProvider(project, provider) {
    if (this.isDshAuditProject(project)) return 'dsh';
    return String(provider || '').toLowerCase() === 'glm' ? 'glm' : 'global';
  }

  assertBudget(estimatedTokens = 8_000) {
    const totals = this.usage();
    assertBudgetAllowed(this.config, totals, { estimatedTokens, estimatedCostCny: 0.05 });
    return totals;
  }

  // ============================================================
  // 启动恢复
  // ============================================================
  recoverOrphans() {
    const deadLeases = this.store.clearLeasesFromDeadProcesses();
    const leases = this.store.clearExpiredLeases();
    const active = this.store.listActiveRuns();
    const recovered = [];
    const skippedLiveOwners = [];
    const ownerAlive = (owner) => {
      const m = String(owner || '').match(/^wb:(\d+):/);
      if (!m) return false;
      try { process.kill(Number(m[1]), 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
    };
    for (const run of active) {
      if (run.status === 'running' || run.status === 'queued') {
        const runTasks = this.store.listTasks({ runId: run.id });
        if (run.status === 'queued' && runTasks.length === 0) {
          this.store.updateRun(run.id, { status: RunStatus.FAILED, stop_reason: '启动恢复：发现半创建 Run（无 tasks），已清理，不占用项目', ended_at: nowIso() });
          this.emit({ runId: run.id, projectId: run.project_id, type: 'run_orphan_cleaned', level: 'warn', message: '启动恢复清理半创建 Run（无 tasks）' });
          continue;
        }
        const lease = this.store.getProjectLease(run.project_id);
        if (lease?.write_owner && lease.lease_expires_at > nowIso() && lease.write_owner !== this.instanceId && ownerAlive(lease.write_owner)) {
          skippedLiveOwners.push(run.id);
          continue;
        }
        this.store.updateRun(run.id, {
          status: RunStatus.INTERRUPTED,
          stop_reason: '工作台进程重启导致运行中断，可在界面点击"恢复运行"从断点继续',
          pause_kind: 'crash',
        });
        this.emit({
          runId: run.id,
          projectId: run.project_id,
          type: 'run_interrupted',
          level: 'warn',
          message: '检测到未完成的运行，已标记为中断；状态与任务进度已保留',
        });
        recovered.push(run.id);
      }
    }
    const attempts = this.store.markRunningAttemptsInterrupted(recovered);
    return { recoveredRuns: recovered, skippedLiveOwners, interruptedAttempts: attempts, expiredLeases: leases, deadLeases };
  }

  /**
   * 恢复前对账：数据库 passed 任务必须能在计划分支上找到对应 commit，
   * 且每个 passed 任务有 PASS 审计；不一致则拒绝盲目续跑。
   */
  async reconcileInterruptedRun(runId) {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: `运行不存在：${runId}` };
    const project = this.store.getProject(run.project_id);
    const tasks = this.store.listTasks({ runId });
    const planBranch = `wb/plan-${run.id.slice(-6)}`;
    const planHead = project ? await gitops.branchRef(project.local_path, planBranch).catch(() => '') : '';
    const details = [];
    const failures = [];
    for (const task of tasks) {
      const entry = { taskId: task.id, seq: task.seq, status: task.status, headCommit: task.head_commit || '', checks: [] };
      if (task.status === TaskStatus.PASSED) {
        const audits = this.store.listAudits(task.id).filter((a) => a.verification_status === 'PASS');
        entry.checks.push({ name: 'audit_pass', ok: audits.length > 0 });
        if (!audits.length) failures.push(`任务 #${task.seq} passed 但缺少 PASS 审计`);
        const commit = task.head_commit || '';
        let ancestor = false;
        if (commit && planHead && project) {
          const res = await gitops.git(project.local_path, ['merge-base', '--is-ancestor', commit, planHead], { allowFail: true });
          ancestor = res.code === 0;
        }
        entry.checks.push({ name: 'commit_in_plan_branch', ok: ancestor, planHead, commit });
        if (!ancestor) failures.push(`任务 #${task.seq} commit ${commit.slice(0, 8)} 不在计划分支 ${planBranch} 上`);
      } else if ([TaskStatus.CODING, TaskStatus.TESTING, TaskStatus.AUDITING, TaskStatus.COMMITTING, TaskStatus.REPAIRING].includes(task.status)) {
        entry.checks.push({ name: 'intermediate_task_will_rerun', ok: true });
      } else if (task.status === TaskStatus.BLOCKED || task.status === TaskStatus.FAILED) {
        entry.checks.push({ name: 'failed_task_not_auto_resumed', ok: true });
      }
      details.push(entry);
    }
    const ok = failures.length === 0;
    const reconciliation = { at: nowIso(), ok, planBranch, planHead, failures, details };
    this.store.updateRun(run.id, { reconciliation_json: reconciliation });
    this.emit({ runId: run.id, projectId: run.project_id, type: ok ? 'run_reconciled' : 'run_reconciliation_failed', level: ok ? 'info' : 'warn', message: ok ? '恢复前对账通过：数据库/审计/Git 计划分支一致' : `恢复前对账失败：${failures.slice(0, 4).join('；')}`, data: reconciliation });
    return { ok, failures, planBranch, planHead, details };
  }

  /** 仅恢复被 Supervisor 标记管理的项目中的 interrupted 运行。 */
  async recoverSupervisedRuns() {
    const projects = this.store.listProjects().filter((p) => p.config_json?.supervisor_managed === true);
    const projectIds = new Set(projects.map((p) => p.id));
    const result = [];
    for (const run of this.store.listRuns(undefined, 200).filter((r) => projectIds.has(r.project_id) && r.status === 'interrupted')) {
      const rec = await this.reconcileInterruptedRun(run.id);
      if (!rec.ok) { result.push({ runId: run.id, resumed: false, reason: rec.failures.join('；') }); continue; }
      try {
        await this.resumeRun(run.id, { retryFailed: false });
        result.push({ runId: run.id, resumed: true });
      } catch (err) {
        result.push({ runId: run.id, resumed: false, reason: err.message });
      }
    }
    return result;
  }

  // ============================================================
  // 项目管理
  // ============================================================
  async createProject(input) {
    const name = String(input.name || '').trim();
    const repo = String(input.repo || input.repoUrl || input.localPath || '').trim();
    if (!name) throw new PolicyError('PROJECT_NAME_REQUIRED', '项目名称不能为空');
    if (!repo) throw new PolicyError('PROJECT_REPO_REQUIRED', '请提供 GitHub 仓库地址或本地项目路径');

    const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(repo) || /^[\w.-]+\/[\w.-]+$/.test(repo);
    const slug = `${String(input.slug || name).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project'}-${Math.random().toString(36).slice(2, 6)}`;
    let localPath;
    let repoUrl = '';
    if (isUrl) {
      repoUrl = gitops.normalizeGitUrl(repo);
      localPath = path.join(this.config.paths.projectsDir, slug);
      if (!fs.existsSync(path.join(localPath, '.git'))) {
        if (fs.existsSync(localPath)) fs.rmSync(localPath, { recursive: true, force: true });
        await gitops.cloneRepo(this.config, repoUrl, localPath, {
          logPath: path.join(this.config.paths.logsDir, `clone-${slug}.log`),
        });
      }
    } else {
      localPath = path.resolve(this.config.paths.root, repo);
      if (!fs.existsSync(localPath)) throw new PolicyError('PROJECT_PATH_MISSING', `本地项目路径不存在：${localPath}`);
      if (!(await gitops.isGitRepo(localPath))) {
        await gitops.ensureGitRepo(localPath, 'main');
        const has = await gitops.hasCommits(localPath);
        if (!has) {
          const status = await gitops.statusPorcelain(localPath);
          if (status.trim()) await gitops.commitAll(localPath, 'chore: initialize project baseline by AI Workbench');
        }
      }
    }

    const defaultBranch = input.defaultBranch || (await gitops.resolveDefaultBranch(localPath));
    const testCommand = String(input.testCommand || input.test_command || '').trim() || detectTestCommand(localPath);
    const protectedPaths = [...new Set([...(parseList(input.protectedPaths)), ...(input.protectTests ? ['tests/**', 'test/**', '**/*.test.js', '**/*.test.mjs', '**/*.spec.js'] : [])])];
    const contractFiles = parseList(input.contractFiles || input.contract_files);
    let qualityConfigInput = input.quality || input.qualityConfig || input.quality_config || undefined;
    let qualityPlanInput = null;
    // P1-1：没有显式 quality requirements 时，从冻结契约文本自动生成条款级计划；
    // 仍需要质量命令/独立审计提供逐条款证据，不能仅凭生成计划判 PASS。
    if (!qualityConfigInput && contractFiles.length) {
      const texts = [];
      for (const rel of contractFiles) {
        try { const p = path.join(localPath, rel); if (fs.existsSync(p) && fs.statSync(p).isFile()) texts.push(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
      }
      const derived = deriveClausePlan(texts.join('\n\n'));
      if (derived.length) {
        const qcmd = String(input.qualityCommand || input.quality_command || '').trim();
        // 没有质量命令时只保存 plan，不启用不可执行的 quality gate；避免把本来可完成的契约项目全部 BLOCKED。
        if (qcmd) qualityConfigInput = { requirements: derived, require_clause_evidence: true, quality_command: qcmd };
        else qualityPlanInput = derived;
        this.emit({ projectId: '', type: 'quality_plan_derived', message: `已从 ${contractFiles.length} 个冻结契约文件生成 ${derived.length} 条需求/条款质量计划${qcmd ? '（已启用质量门）' : '（未配置 quality_command，仅保存计划，质量闭环未启用）'}`, data: { requirements: derived.length, gateEnabled: !!qcmd } });
      }
    }
    const project = this.store.createProject({
      id: newId('proj'),
      name,
      description: String(input.description || ''),
      repoUrl,
      localPath,
      defaultBranch,
      testCommand,
      language: detectLanguage(localPath),
      agentKind: validAgentKind(input.agentKind || 'auto'),
      auditProvider: validAuditProvider(input.auditProvider || 'auto'),
      protectedPaths,
      budget: input.budget || {},
      agentConfig: input.agentConfig || {},
      contractFiles,
      ciRequired: input.ciRequired !== false && input.ci_required !== false,
      allowLocalAcceptance: input.allowLocalAcceptance !== false && input.allow_local_acceptance !== false,
      remotePushAuthorized: input.remotePushAuthorized === true || input.remote_push_authorized === true,
      config: {
        ...(input.config || {}),
        publish: input.publish === false ? false : true,
        allowed_test_commands: parseList(input.allowedTestCommands || input.allowed_test_commands || input.testCommand || input.test_command),
        test_env_allowlist: parseList(input.testEnvAllowlist || input.test_env_allowlist),
        agent_permission: input.agentPermission || input.agent_permission || '',
        test_isolation: input.testIsolation || input.test_isolation || '',
        agent_isolation: input.agentIsolation || input.agent_isolation || '',
        container_agent_network: input.containerAgentNetwork || input.container_agent_network || '',
        low_budget_finalize: input.lowBudgetFinalize === true || input.low_budget_finalize === true,
        supervisor_managed: input.supervisorManaged === true || input.supervisor_managed === true,
        audit_budget: input.auditBudget || input.audit_budget || {},
        require_real_tests: input.requireRealTests === true || input.require_real_tests === true,
        auto_test_setup: input.autoTestSetup === true || input.auto_test_setup === true,
        test_plan: input.testPlan || input.test_plan || null,
        contract_baseline: input.contractBaseline || input.contract_baseline || null,
        trusted_test_hashes: input.trustedTestHashes || input.trusted_test_hashes || null,
        quality: qualityConfigInput,
        quality_plan: qualityPlanInput,
        replay_assets: input.replayAssets || input.replay_assets || undefined,
        agent_fallback: parseList(input.agentFallback || input.agent_fallback),
        agent_stall_timeout_ms: Number(input.agentStallTimeoutMs || input.agent_stall_timeout_ms || 0) || undefined,
      },
    });
    this.emit({ projectId: project.id, type: 'project_created', message: `项目已添加：${project.name}（${localPath}）` });
    if (!testCommand) {
      this.emit({ projectId: project.id, type: 'project_warning', level: 'warn', message: `项目 ${name} 未检测到测试命令，请手动配置，否则任务无法通过测试验证` });
    }
    return project;
  }

  updateProject(projectId, patch = {}) {
    const project = this.store.getProject(projectId);
    if (!project) throw new PolicyError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
    const mapped = {};
    if (patch.name !== undefined) mapped.name = String(patch.name);
    if (patch.description !== undefined) mapped.description = String(patch.description);
    if (patch.testCommand !== undefined || patch.test_command !== undefined) {
      mapped.test_command = String(patch.testCommand ?? patch.test_command);
    }
    if (patch.defaultBranch !== undefined || patch.default_branch !== undefined) {
      mapped.default_branch = String(patch.defaultBranch ?? patch.default_branch);
    }
    if (patch.protectedPaths !== undefined || patch.protected_paths !== undefined) {
      mapped.protected_paths = parseList(patch.protectedPaths ?? patch.protected_paths);
    }
    if (patch.agentKind !== undefined || patch.agent_kind !== undefined) mapped.agent_kind = patch.agentKind ?? patch.agent_kind;
    if (patch.auditProvider !== undefined || patch.audit_provider !== undefined) mapped.audit_provider = patch.auditProvider ?? patch.audit_provider;
    if (patch.budget !== undefined) mapped.budget_json = patch.budget;
    if (patch.agentConfig !== undefined || patch.agent_config !== undefined) mapped.agent_config_json = patch.agentConfig ?? patch.agent_config;
    if (patch.contractFiles !== undefined || patch.contract_files !== undefined) mapped.contract_files = parseList(patch.contractFiles ?? patch.contract_files);
    if (patch.ciRequired !== undefined || patch.ci_required !== undefined) mapped.ci_required = (patch.ciRequired ?? patch.ci_required) ? 1 : 0;
    if (patch.allowLocalAcceptance !== undefined || patch.allow_local_acceptance !== undefined) mapped.allow_local_acceptance = (patch.allowLocalAcceptance ?? patch.allow_local_acceptance) ? 1 : 0;
    if (patch.remotePushAuthorized !== undefined || patch.remote_push_authorized !== undefined) mapped.remote_push_authorized = (patch.remotePushAuthorized ?? patch.remote_push_authorized) ? 1 : 0;
    let configPatch = {};
    if (patch.allowedTestCommands !== undefined || patch.allowed_test_commands !== undefined) configPatch.allowed_test_commands = parseList(patch.allowedTestCommands ?? patch.allowed_test_commands);
    if (patch.testEnvAllowlist !== undefined || patch.test_env_allowlist !== undefined) configPatch.test_env_allowlist = parseList(patch.testEnvAllowlist ?? patch.test_env_allowlist);
    if (patch.agentPermission !== undefined || patch.agent_permission !== undefined) configPatch.agent_permission = patch.agentPermission ?? patch.agent_permission;
    if (patch.testTimeoutMs !== undefined || patch.test_timeout_ms !== undefined) configPatch.test_timeout_ms = Number(patch.testTimeoutMs ?? patch.test_timeout_ms);
    if (patch.autoTestSetup !== undefined || patch.auto_test_setup !== undefined) configPatch.auto_test_setup = patch.autoTestSetup === true || patch.auto_test_setup === true;
    if (patch.testIsolation !== undefined || patch.test_isolation !== undefined) configPatch.test_isolation = String(patch.testIsolation ?? patch.test_isolation);
    if (patch.agentIsolation !== undefined || patch.agent_isolation !== undefined) configPatch.agent_isolation = String(patch.agentIsolation ?? patch.agent_isolation);
    if (patch.containerAgentNetwork !== undefined || patch.container_agent_network !== undefined) configPatch.container_agent_network = String(patch.containerAgentNetwork ?? patch.container_agent_network);
    if (patch.agentStallTimeoutMs !== undefined || patch.agent_stall_timeout_ms !== undefined) configPatch.agent_stall_timeout_ms = Number(patch.agentStallTimeoutMs ?? patch.agent_stall_timeout_ms);
    if (patch.agentFallback !== undefined || patch.agent_fallback !== undefined) configPatch.agent_fallback = parseList(patch.agentFallback ?? patch.agent_fallback);
    if (patch.lowBudgetFinalize !== undefined || patch.low_budget_finalize !== undefined) configPatch.low_budget_finalize = patch.lowBudgetFinalize === true || patch.low_budget_finalize === true;
    if (patch.supervisorManaged !== undefined || patch.supervisor_managed !== undefined) configPatch.supervisor_managed = patch.supervisorManaged === true || patch.supervisor_managed === true;
    if (patch.auditBudget !== undefined || patch.audit_budget !== undefined) configPatch.audit_budget = patch.auditBudget ?? patch.audit_budget;
    if (patch.agentAllowedTools !== undefined || patch.agent_allowed_tools !== undefined) configPatch.agent_allowed_tools = String(patch.agentAllowedTools ?? patch.agent_allowed_tools);
    if (patch.agentDisallowedTools !== undefined || patch.agent_disallowed_tools !== undefined) configPatch.agent_disallowed_tools = String(patch.agentDisallowedTools ?? patch.agent_disallowed_tools);
    if (patch.quality !== undefined) configPatch.quality = patch.quality;
    if (patch.config !== undefined) configPatch = { ...configPatch, ...(patch.config || {}) };
    if (patch.protectedPaths !== undefined || patch.protected_paths !== undefined) mapped.protected_paths = parseList(patch.protectedPaths ?? patch.protected_paths);
    if (patch.replayAssets !== undefined || patch.replay_assets !== undefined) configPatch.replay_assets = patch.replayAssets ?? patch.replay_assets;
    if (patch.publish !== undefined) configPatch.publish = !!patch.publish;
    if (Object.keys(configPatch).length) mapped.config_json = { ...(project.config_json || {}), ...configPatch };
    return this.store.updateProject(projectId, mapped);
  }

  // ============================================================
  // 运行创建
  // ============================================================
  async assertExperimentModelBinding(project) {
    const exp = this.store.getExperimentForProject?.(project.id);
    if (!exp) return null;
    const bind = exp.provider_json || {};
    const coding = bind.coding || null; const audit = bind.audit || null;
    if (!coding?.client || !coding?.provider || !coding?.model) throw new PolicyError('EXPERIMENT_MODEL_BINDING_MISSING', '实验契约缺少 Coding Provider/模型绑定');
    if (!audit?.client || !audit?.provider || !audit?.model) throw new PolicyError('EXPERIMENT_MODEL_BINDING_MISSING', '实验契约缺少 Audit Provider/模型绑定');
    const codingIdentity = resolveAgentIdentity({ config: this.config, agentId: coding.client, project });
    if (!codingIdentity.known || codingIdentity.provider !== coding.provider || String(codingIdentity.model || '').toLowerCase() !== String(coding.model).toLowerCase()) {
      throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `Coding 实际身份 ${codingIdentity.provider}/${codingIdentity.model} 与授权 ${coding.provider}/${coding.model} 不匹配`);
    }
    const chat = bind.chat; const planner = bind.planner;
    if (!chat || !planner) throw new PolicyError('EXPERIMENT_MODEL_BINDING_MISSING', '实验契约缺少 Chat/Planner 绑定');
    const chatActual = resolveLlmIdentity({ config: this.config, provider: chat.client || chat.provider });
    if (chatActual.provider !== chat.provider || String(chatActual.model || '').toLowerCase() !== String(chat.model || '').toLowerCase()) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `Chat 实际身份 ${chatActual.provider}/${chatActual.model} 与授权 ${chat.provider}/${chat.model} 不匹配`);
    const p = this.config.planner?.provider || 'deepseek';
    const plannerActual = resolveLlmIdentity({ config: this.config, provider: p });
    if (plannerActual.provider !== planner.provider || String(plannerActual.model || '').toLowerCase() !== String(planner.model || '').toLowerCase()) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `Planner 实际身份 ${plannerActual.provider}/${plannerActual.model} 与授权 ${planner.provider}/${planner.model} 不匹配`);
    const auditIdentity = audit.client === 'dsh' ? { provider: 'deepseek', model: 'deepseek' } : resolveLlmIdentity({ config: this.config, provider: audit.client });
    if (auditIdentity.provider !== audit.provider || String(auditIdentity.model || '').toLowerCase() !== String(audit.model || '').toLowerCase()) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `Audit 实际身份 ${auditIdentity.provider}/${auditIdentity.model} 与授权 ${audit.provider}/${audit.model} 不匹配`);
    if (modelFamily(coding.provider, coding.model) === modelFamily(audit.provider, audit.model)) throw new PolicyError('EXPERIMENT_MODEL_SAME_FAMILY', 'Coding 与 Audit 不允许同模型族');
    if (audit.client === 'dsh' && !dshAuditAvailable(this.config)) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', '授权要求 DSH 审计，但 DSH CLI 不可用');
    if (audit.client === 'dsh' && !this.config.llm?.deepseek?.apiKey) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', '授权要求 DSH/DeepSeek 审计，但缺少 DeepSeek API Key；DSH 可能使用未授权凭据');
    return exp;
  }

  assertExperimentIsolation(project) {
    const exp = this.store.getExperimentForProject?.(project.id);
    if (!exp) return null;
    const mode = String(exp.isolation_mode || '').toUpperCase();
    if (mode === 'LOCAL_APPROVED') {
      // 本地测试进程与 Workbench 同用户/同文件系统，无法阻止读取宿主未授权文件；不满足 E2E 安全边界。
      throw new PolicyError('EXPERIMENT_ISOLATION_BLOCKED', '实验契约要求本地执行，但本地无文件系统隔离边界（可读宿主文件）；必须使用容器隔离', { experimentId: exp.id });
    }
    if (['completed','cancelled','failed','ended'].includes(exp.status)) throw new PolicyError('EXPERIMENT_ENDED', `实验契约已终止（${exp.status}），必须重新授权`, { experimentId: exp.id });
    if (mode === 'DOCKER_REQUIRED') {
      const caps = containerCapabilities(this.config);
      if (!caps.testExecution || !caps.agentExecution) throw new PolicyError('EXPERIMENT_ISOLATION_BLOCKED', `实验契约要求 Docker 隔离，但 Docker/镜像不可用：${caps.image.reason || caps.docker.reason || 'unknown'}；不静默降级`, { experimentId: exp.id });
      const pcfg = project.config_json || {};
      if (String(pcfg.agent_isolation || '').toLowerCase() !== 'docker' || String(pcfg.test_isolation || '').toLowerCase() !== 'docker') {
        throw new PolicyError('EXPERIMENT_ISOLATION_BLOCKED', '实验契约要求 Docker，但项目未强制 agent_isolation=docker 且 test_isolation=docker；不允许宿主执行', { experimentId: exp.id });
      }
      return exp;
    }
    throw new PolicyError('EXPERIMENT_ISOLATION_BLOCKED', `实验契约隔离方案未获批准（${mode || 'EMPTY'}）；不静默降级到普通宿主执行`, { experimentId: exp.id });
  }

  async startRun(input) {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new PolicyError('PROJECT_NOT_FOUND', `项目不存在：${input.projectId}`);
    await this.assertExperimentModelBinding(project);
    this.assertExperimentIsolation(project);
    const goal = String(input.goal || '').trim();
    if (!goal) throw new PolicyError('GOAL_REQUIRED', '请填写开发目标');
    const mode = input.mode === 'plan' ? 'plan' : 'single';
    const frozenAcceptance = parseList(project.config_json?.test_plan?.acceptance || project.config_json?.test_plan?.acceptance_json || []);
    const acceptance = parseList(input.acceptance).length ? parseList(input.acceptance) : frozenAcceptance;
    const requestKey = String(input.requestKey || '').trim();
    let runId = newId('run');

    // P0-2：同一请求键的 Run 只能创建一次；崩溃恢复/重复调用返回已有 Run。
    if (requestKey) {
      const existing = this.store.getRunByRequestKey(requestKey);
      if (existing) return { runId: existing.id, planId: existing.plan_id, existing: true };
    }
    const persistedReceipt = requestKey ? this.store.getRunPlanReceipt(requestKey) : null;
    if (persistedReceipt?.__pending) throw new PolicyError('PLANNER_RESULT_UNKNOWN', '同一业务请求的 Planner 发送结果未持久化；保留原预留并阻断，不得重发');
    const persistedPlan = persistedReceipt?.plan || persistedReceipt || null;
    if (persistedReceipt?.runId) runId = persistedReceipt.runId;

    this.assertBudget(5_000);
    assertModelBudget({ config: this.config, store: this.store, provider: this.config.planner.provider || 'deepseek', model: this.config.planner.model || '', estimatedTokens: 5000, label: 'Planner', experimentId: this.experimentIdForProject(project.id), experimentRole: 'planner', experimentClient: this.config.planner.provider || 'deepseek' });

    const busy = this.store.activeRunForProject(project.id);
    if (busy) {
      throw new PolicyError('PROJECT_BUSY', `项目已有未完成的运行（${busy.id}，状态 ${busy.status}），同一项目同一时间只允许一个写入运行；请先恢复或取消它`);
    }
    const acquired = this.store.acquireProjectLeaseFenced(project.id, this.instanceId, 30 * 60 * 1000);
    if (!acquired.ok) {
      throw new PolicyError('PROJECT_LEASE_HELD', `无法获得项目写租约：${acquired.reason || '其他执行者持有'}（当前 fence=${acquired.fence || 0}）`);
    }
    this.projectLeases.set(project.id, { owner: this.instanceId, fence: acquired.fence });
    const projectUsage = this.weightProjectUsage(this.store.usageForProject(project.id));
    assertProjectBudget({
      config: this.config,
      project,
      run: null,
      totals: projectUsage,
      estimatedTokens: 8_000,
      estimatedCostCny: 0.05,
    });
    const planId = newId('plan');
    const budget = {
      maxTokens: Math.min(
        Number(project.budget_json?.max_tokens_per_run || this.config.budget.maxTokensPerRun),
        this.config.budget.maxTotalTokens,
      ),
      maxCostCny: Math.min(
        Number(project.budget_json?.max_cost_cny_per_run || this.config.budget.maxCostCnyPerRun),
        this.config.budget.maxCostCny,
      ),
      maxAttempts: Number(project.budget_json?.max_attempts || this.config.budget.maxAttempts),
      maxWallClockMs: Number(project.budget_json?.max_wall_clock_ms || this.config.budget.runWallClockMs),
    };
    const wallDeadline = new Date(Date.now() + budget.maxWallClockMs).toISOString();

    // 先做规划（LLM 调用），失败不创建半成品运行；持有项目 fence 期间失败必须释放。
    let planResult = persistedPlan;
    let plannerReservation = null;
    const explicitTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
    const needsPlannerModel = mode === 'plan' && !explicitTasks;
    const plannerProviders = availableProviders(this.config);
    const selectedPlanner = plannerProviders.find((p) => p.name === this.config.planner.provider)
      || plannerProviders.find((p) => p.name === 'deepseek')
      || plannerProviders.find((p) => p.name === 'openai')
      || plannerProviders.find((p) => p.name === 'glm') || null;
    const plannerProvider = selectedPlanner?.name || this.config.planner.provider || 'deepseek';
    const plannerModel = selectedPlanner?.model || this.config.planner.model || '';
    if (needsPlannerModel && !planResult && !selectedPlanner) {
      this.releaseProjectLease(project.id);
      throw new PolicyError('PLANNER_UNAVAILABLE', '没有可用的 Planner 模型；本次未发送、未预留、未写用量。补齐配置后可用同一请求键重试');
    }
    try {
      if (planResult) { /* 已收到并持久化的结果：重投不得再次发送/计费 */ } else {
      // 单任务/显式任务不调用模型：不预留、不计费、不占额。自动规划才做原子预留。
      if (needsPlannerModel) {
        plannerReservation = assertModelBudget({ config: this.config, store: this.store, provider: plannerProvider, model: plannerModel, estimatedTokens: 6000, label: 'Planner', reserve: true, experimentId: this.experimentIdForProject(project.id), experimentRole: 'planner', experimentClient: plannerProvider });
      }
      const experimentPlanBinding = this.store.getExperimentForProject?.(project.id)?.provider_json?.planner || null;
      if (requestKey && needsPlannerModel) this.store.beginRunPlanIntent(requestKey);
      planResult = await planTasks({
        config: this.config,
        project,
        goal,
        acceptance,
        mode,
          tasks: input.tasks,
          plannerBinding: experimentPlanBinding,
        });
      }
    } catch (err) {
      if (plannerReservation?.reservation?.id) this.store.markModelReservationUnknown(plannerReservation.reservation.id);
      this.releaseProjectLease(project.id);
      throw err;
    }
    if (needsPlannerModel && !persistedPlan) {
      const plannerUsage = planResult.usage || {};
      const usageKnown = planResult.usageKnown === true;
      recordModelUsage({
        store: this.store, config: this.config, source: 'planner',
        sourceId: `planner:run:${requestKey || runId}`,
        provider: planResult.provider || planResult.plannerMeta?.provider || plannerProvider,
        model: planResult.model || planResult.plannerMeta?.model || plannerModel,
        usage: plannerUsage, usageKnown, costCny: planResult.costCny || 0,
        runId, projectId: project.id, experimentId: this.experimentIdForProject(project.id),
        reservationId: plannerReservation?.reservation?.id || '',
        costSource: usageKnown ? 'estimated' : 'unknown',
      });
      plannerReservation = null;
    }

    if (requestKey) this.store.saveRunPlanReceipt(requestKey, { runId, plan: planResult });
    try {
      this.assertProjectLease(project.id);
      try {
        this.store.createRun({
          id: runId,
          projectId: project.id,
          planId,
          goal,
          mode,
          status: RunStatus.QUEUED,
          budget,
          spent: { tokens: 0, costCny: 0 },
          result: input.loopId ? { loopId: input.loopId } : {},
          wallDeadline,
          verificationStatus: 'LOCAL_VERIFIED',
          parentRunId: input.parentRunId || '',
          requestKey,
        });
      } catch (err) {
        if (requestKey) {
          const existing = this.store.getRunByRequestKey(requestKey);
          if (existing) { this.releaseProjectLease(project.id); return { runId: existing.id, planId: existing.plan_id, existing: true }; }
        }
        throw err;
      }
    this.store.createPlan({
      id: planId,
      projectId: project.id,
      runId,
      goal,
      title: planResult.title,
      mode: mode,
      tasks: planResult.tasks,
      plannerMeta: planResult.plannerMeta || {},
    });
    this.store.updateRun(runId, { plan_id: planId });

    const maxAttempts = Number(input.maxAttempts || this.config.budget.maxAttempts);
    const taskRows = planResult.tasks.map((t) => ({
      id: newId('task'),
      projectId: project.id,
      planId,
      runId,
      seq: t.seq,
      title: t.title,
      description: t.description,
      acceptance: t.acceptance,
      agentKind: t.agent || 'auto',
      testCommand: t.testCommand || '',
      status: TaskStatus.QUEUED,
      maxAttempts,
    }));
    this.store.createTasks(taskRows);

    } catch (err) {
      // P0-2：半创建 Run 不能永久占住项目；失败时清理为 failed，保留错误原因。
      try {
        if (this.store.getRun(runId)) this.store.updateRun(runId, { status: RunStatus.FAILED, stop_reason: `运行创建失败：${redact(err?.message || err, this.config)}`.slice(0, 1000), ended_at: nowIso() });
      } catch { /* ignore */ }
      this.releaseProjectLease(project.id);
      throw err;
    }

    this.emit({
      runId,
      projectId: project.id,
      type: 'run_created',
      message: `已创建运行：${mode === 'plan' ? `自动规划 ${planResult.tasks.length} 个任务` : '单任务执行'}`,
      data: { planId, mode, taskCount: planResult.tasks.length, planner: planResult.plannerMeta },
    });

    this.kick(runId);
    return { runId, planId, tasks: planResult.tasks.length, projectId: project.id };
  }

  kick(runId) {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.store.updateRun(runId, {
      status: RunStatus.RUNNING,
      started_at: run.started_at || nowIso(),
      stop_reason: '',
      pause_kind: '',
    });
    this.emit({ runId, projectId: run.project_id, type: 'run_started', message: '编排器开始执行' });
    setImmediate(() => {
      this.processRun(runId).catch((err) => {
        const message = `编排器异常：${err?.message || err}`;
        try {
          this.store.updateRun(runId, { status: RunStatus.INTERRUPTED, stop_reason: message });
          this.emit({ runId, projectId: run.project_id, type: 'run_error', level: 'error', message });
        } catch {
          /* ignore */
        }
      });
    });
  }

  // ============================================================
  // 运行主循环
  // ============================================================
  async processRun(runId) {
    if (this.running.has(runId)) return;
    const runForLease = this.store.getRun(runId);
    if (!runForLease) return;
    let lease = this.projectLeases.get(runForLease.project_id);
    if (!lease) {
      const acquired = this.store.acquireProjectLeaseFenced(runForLease.project_id, this.instanceId, 30 * 60 * 1000);
      if (!acquired.ok) {
        // 非 owner：不写 run 状态/事件，留给真正的 owner 或恢复流程处理，避免旧执行者覆盖活 run。
        return;
      }
      lease = { owner: this.instanceId, fence: acquired.fence };
      this.projectLeases.set(runForLease.project_id, lease);
    }
    const runLease = this.store.setRunLeaseFenced(runId, lease.owner, lease.fence, 10 * 60 * 1000);
    if (!runLease.ok) {
      // 非 owner：不写 run 状态。
      return;
    }
    this.running.add(runId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const leaseHeartbeat = setInterval(() => {
      const current = this.projectLeases.get(runForLease.project_id);
      if (!current) return;
      const ok = this.store.renewProjectLeaseFenced(runForLease.project_id, current.owner, current.fence, 30 * 60 * 1000);
      if (!ok) {
        this.projectLeases.delete(runForLease.project_id);
        try { controller.abort(); } catch { /* ignore */ }
      }
    }, 60_000);
    leaseHeartbeat.unref?.();
    try {
      let run = this.store.getRun(runId);
      if (!run) return;
      if (run.status !== RunStatus.RUNNING) {
        this.store.updateRun(runId, { status: RunStatus.RUNNING });
      }
      for (;;) {
        run = this.store.getRun(runId);
        if (!run || run.status !== RunStatus.RUNNING) break;
        if (controller.signal.aborted) break;
        const currentLease = this.projectLeases.get(run.project_id);
        const renewed = currentLease ? this.store.renewProjectLeaseFenced(run.project_id, currentLease.owner, currentLease.fence, 10 * 60 * 1000) : false;
        if (!renewed) {
          this.projectLeases.delete(run.project_id);
          this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: '项目写租约续租失败：执行者已被其他进程接管，停止后续写入' });
          this.emit({ runId: run.id, projectId: run.project_id, type: 'lease_lost', level: 'error', message: '项目写租约续租失败，停止后续写入（fencing）' });
          break;
        }
        this.store.setRunLeaseFenced(run.id, currentLease.owner, currentLease.fence, 10 * 60 * 1000);
        const task = this.store.nextQueuedTask(run.plan_id);
        const project = this.store.getProject(run.project_id);
        const allowLowReserveFinalize = !task && project?.config_json?.low_budget_finalize === true;
        if (!allowLowReserveFinalize) {
          try {
            assertRunWallClock(run, this.config.budget.runWallClockMs);
            this.assertBudget(8_000);
            const projectUsage = this.weightProjectUsage(this.store.usageForProject(run.project_id));
            assertProjectBudget({
              config: this.config,
              project,
              run,
              totals: projectUsage,
              estimatedTokens: 8_000,
              estimatedCostCny: 0.05,
            });
          } catch (err) {
            const kind = /WALL_CLOCK/.test(err?.code || '') ? 'wall_clock' : 'budget';
            void this.pauseRun(runId, err.message, kind).catch((e) => this.emit({ runId, projectId: run.project_id, type: 'run_pause_error', level: 'error', message: `暂停失败：${e.message}` }));
            break;
          }
        }
        if (!task) {
          const finalized = await this.finalizeRun(run);
          if (finalized?.continue) continue;
          break;
        }
        this.store.updateRun(runId, { current_task_id: task.id });
        const result = await this.runTask(run, task, controller.signal);
        if (!result.ok) {
          const latest = this.store.getRun(runId);
          if (!latest || latest.status !== RunStatus.RUNNING) break;
          if (controller.signal.aborted) break;
          void this.pauseRun(runId, result.reason || '任务失败，等待人工处理', 'task_failed').catch((e) => this.emit({ runId, projectId: run.project_id, type: 'run_pause_error', level: 'error', message: `暂停失败：${e.message}` }));
          break;
        }
      }
    } catch (err) {
      const message = redact(`运行异常终止：${err?.message || err}`, this.config);
      this.store.updateRun(runId, { status: RunStatus.INTERRUPTED, stop_reason: message });
      this.emit({ runId, type: 'run_error', level: 'error', message });
    } finally {
      clearInterval(leaseHeartbeat);
      this.running.delete(runId);
      this.controllers.delete(runId);
      // 终态安全释放：只用本执行者 fence 释放，已被接管时不会误删新租约。
      const lease = this.projectLeases.get(runForLease.project_id);
      if (lease) {
        try { this.store.clearRunLeaseFenced(runId, lease.owner, lease.fence); } catch { /* ignore */ }
        this.releaseProjectLease(runForLease.project_id);
      }
    }
  }

  /**
   * 任务启动前检查完整流水线资源（Provider-aware）：
   * Coding Agent 与 Audit Provider 分离；审计 Provider 预算不足/不可用时在编码前阻塞并保存检查点，
   * 避免写完代码才发现无法独立审计（也不得同模型自审）。
   */
  auditResourcePreflight(project, coderFamily) {
    if (this.isDshAuditProject(project)) {
      if (!dshAuditAvailable(this.config)) throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', 'DSH CLI 不可用，无法进行 DSH 独立审计；任务在编码前阻塞');
      if (coderFamily && modelFamily('deepseek', 'deepseek') === coderFamily) throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', 'DSH 审计与 Coding Agent 同族，拒绝自审');
      const estimate = Number(project?.config_json?.audit_resource_estimate_tokens || 4000);
      const budgetStatus = this.auditBudgetStatus(project);
      if (budgetStatus.remainingCostCny <= 0 || budgetStatus.remainingTokens <= 0) throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', `DSH 独立审计预算已耗尽：费用 ${budgetStatus.usedCostCny.toFixed(4)}/${budgetStatus.maxCostCny}，tokens ${budgetStatus.usedTokens}/${budgetStatus.maxTokens}；任务在编码前阻塞并保存检查点`);
      if (budgetStatus.remainingCostCny < 0.20 || budgetStatus.remainingTokens < estimate) throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', `DSH 独立审计预算不足以预估调用（剩余 ¥${budgetStatus.remainingCostCny.toFixed(2)}，剩余 tokens ${budgetStatus.remainingTokens}，预估 ${estimate}）；接近上限，停止发起可能超额调用并保存检查点`);
      return { provider: 'dsh', model: 'deepseek', exempt: false, estimate, source: 'dsh-cli', budgetStatus };
    }
    const resolution = resolveAuditProvider(this.config, { coderFamily });
    if (!resolution.provider) throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', `没有可用的独立审计 Provider：${resolution.reason || 'unknown'}；任务在编码前阻塞并保存检查点`);
    const spec = this.config.llm?.[resolution.provider.name] || {};
    const identity = resolveLlmIdentity({ config: this.config, provider: resolution.provider.name, spec });
    if (!identity.known || identity.provider === 'unknown') {
      throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', '审计 Provider 实际模型身份无法识别，拒绝同源/未知审计');
    }
    if (coderFamily && modelFamily(identity.provider, identity.model || spec.model || '') === coderFamily && this.config.audit.requireIndependent !== false) {
      throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', `审计 Provider ${identity.provider} 与编码模型族 ${coderFamily} 相同，拒绝自审`);
    }
    const exempt = isExemptIdentity(identity, this.config);
    const estimate = Number(this.config.audit.resourceEstimateTokens || 8_000);
    if (!exempt) {
      const remaining = this.budget().remainingTokens;
      const reserve = Number(this.config.budget.minReserveTokens || 0);
      if (remaining - estimate < reserve) {
        throw new PolicyError('AUDIT_RESOURCE_UNAVAILABLE', `独立审计资源预算不足：Provider=${identity.provider}，剩余预算折算 ${Math.max(0, remaining)}，审计预估 ${estimate} + 保留 ${reserve}；任务在编码前阻塞并保存检查点`);
      }
    }
    return { provider: identity.provider, model: identity.model || spec.model || '', exempt, estimate };
  }

  isDshAuditProject(project) {
    return String(project?.audit_provider || '').toLowerCase() === 'dsh';
  }

  auditBudgetStatus(project) {
    const cfg = project?.config_json?.audit_budget || {};
    const maxCost = Number(cfg.max_cost_cny ?? 30);
    const maxTokens = Number(cfg.max_tokens ?? 2_000_000);
    const used = this.store.auditBudgetUsage(project.id);
    return { maxCostCny: maxCost, maxTokens, usedCostCny: used.costCny, usedTokens: used.tokens, calls: used.calls, remainingCostCny: Math.max(0, maxCost - used.costCny), remainingTokens: Math.max(0, maxTokens - used.tokens) };
  }

  // ============================================================
  // 自主恢复：Agent 候选、进度看门狗、失败分类
  // ============================================================
  classifyAgentFailure(agentResult = {}) {
    const err = String(agentResult.error || '');
    if (agentResult.stalled) return 'infrastructure_stalled';
    if (agentResult.timedOut) return 'infrastructure_timeout';
    if (agentResult.aborted) return 'infrastructure_aborted';
    if (/token 预算|超出单任务 token|budget/i.test(err)) return 'budget';
    if (/CONTAINER|docker|socket|ENOENT|ECONN|ETIMEDOUT|EAI_AGAIN|network|SIGKILL|lease|租约|权限|permission|ISOLATION/i.test(err)) return 'infrastructure';
    if (/未返回可解析|未正常完成|连续未产生|no changes|结构化结果/i.test(err)) return 'agent_no_output';
    return 'agent_error';
  }

  isInfrastructureFailure(failureClass, agentResult = {}) {
    return String(failureClass).startsWith('infrastructure') || /CONTAINER|docker|socket|ECONN|ETIMEDOUT|network|SIGKILL|lease|租约|permission|ISOLATION/i.test(String(agentResult.error || ''));
  }

  async resolveAgentCandidates(project, task) {
    const primary = await this.deps.chooseAgent(this.config, project, task);
    if (!primary) return [];
    const configured = Array.isArray(project?.config_json?.agent_fallback) && project.config_json.agent_fallback.length
      ? project.config_json.agent_fallback
      : (this.config.agents.fallback || []);
    let checks = [];
    try { checks = await this.deps.checkAgents(this.config); } catch { checks = []; }
    const ok = new Set((Array.isArray(checks) ? checks : []).filter((a) => a && a.ok).map((a) => a.id || a.agentId));
    const list = [primary];
    for (const id of configured) {
      if (!id || id === primary || list.includes(id)) continue;
      if (ok.size > 0 && !ok.has(id)) continue;
      const identity = resolveAgentIdentity({ config: this.config, agentId: id, project });
      if (!identity.exempt && this.budget().remainingTokens < 100_000) continue;
      list.push(id);
    }
    return list;
  }

  async worktreeProgressSignal(worktree) {
    try {
      const files = [];
      const walk = (dir, rel = '') => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (files.length >= 2000) return;
          if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.workbench') continue;
          const abs = path.join(dir, ent.name);
          const r = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) { walk(abs, r); continue; }
          if (!ent.isFile()) continue;
          let st;
          try { st = fs.statSync(abs); } catch { continue; }
          // 未跟踪文件同样进入指纹；内容变化即使 Git diff 行数不变也会被发现。
          let digest = '';
          if (st.size <= 2 * 1024 * 1024) {
            try { digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 24); } catch { /* ignore */ }
          }
          files.push(`${r}	${st.size}	${Math.trunc(st.mtimeMs)}	${digest}`);
        }
      };
      walk(worktree);
      files.sort();
      const treeHash = crypto.createHash('sha256').update(files.join(String.fromCharCode(10))).digest('hex').slice(0, 32);
      const status = await gitops.statusPorcelain(worktree);
      const changed = String(status || '').split('\n').filter(Boolean).length;
      return `${changed}:${files.length}:${treeHash}`;
    } catch {
      return 'unknown';
    }
  }

  /**
   * 真实进度看门狗：不是只看进程存活，而是看工作树是否持续推进；
   * 无进展超过阈值时终止子进程并返回 stalled（随后由上层切换/重试 Agent）。
   */
  async runAgentWithWatchdog({ agentId, ctx, worktree, parentSignal = null, stallTimeoutMs = 0 }) {
    const local = new AbortController();
    const onParentAbort = () => { try { local.abort(); } catch { /* ignore */ } };
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    const configuredThreshold = Math.max(1_000, Number(stallTimeoutMs || this.config.agents.stallTimeoutMs || 180_000));
    // 容器内 Claude Code 可能长时间等待模型响应且不产生 Git diff；使用有界容器阈值，不无限延长。
    const threshold = ctx.container ? Math.max(configuredThreshold, Number(this.config.agents.containerStallTimeoutMs || 2_700_000)) : configuredThreshold;
    let lastSignal = await this.worktreeProgressSignal(worktree);
    let lastProgressAt = Date.now();
    let eventCount = 0;
    let stalled = false;
    const intervalMs = Math.max(5_000, Math.min(30_000, Math.floor(threshold / 10)));
    const timer = setInterval(async () => {
      if (local.signal.aborted) return;
      const current = await this.worktreeProgressSignal(worktree);
      const changed = current !== lastSignal;
      lastSignal = current;
      if (changed || eventCount > 0) {
        lastProgressAt = Date.now();
        eventCount = 0;
      } else if (Date.now() - lastProgressAt >= threshold) {
        stalled = true;
        try { local.abort(); } catch { /* ignore */ }
      }
    }, intervalMs);
    timer.unref?.();
    try {
      const wrapped = {
        ...ctx,
        signal: local.signal,
        onEvent: (evt) => {
          eventCount += 1;
          lastProgressAt = Date.now();
          try { ctx.onEvent?.(evt); } catch { /* ignore */ }
        },
      };
      const result = await this.deps.runAgent(agentId, wrapped);
      return { result, stalled };
    } finally {
      clearInterval(timer);
      if (parentSignal) parentSignal.removeEventListener?.('abort', onParentAbort);
    }
  }

  // ============================================================
  // 执行隔离辅助（容器测试 / 容器 Agent）
  // ============================================================
  containerTestRequested(project) {
    return String(project?.config_json?.test_isolation || '').toLowerCase() === 'docker';
  }

  agentContainerRequested(project) {
    return String(project?.config_json?.agent_isolation || '').toLowerCase() === 'docker';
  }

  containerTestEnv(project) {
    const projectConfig = project?.config_json || {};
    const allow = new Set(
      [...(projectConfig.test_env_allowlist || []), ...(this.config.security.testEnvAllowlist || [])]
        .map((s) => String(s).trim()).filter(Boolean),
    );
    const env = { CI: '1', PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
    return env;
  }

  async runProjectTest({ project, worktree, command, timeoutMs, logPath, signal = null, metadata = null, runId = '', taskId = '' }) {
    const runOnce = async (cmd, pathName) => {
      if (this.containerTestRequested(project)) {
        const caps = containerCapabilities(this.config);
        if (!caps.testExecution) {
          throw new PolicyError('CONTAINER_UNAVAILABLE', `项目要求容器测试，但 Docker/镜像不可用：${caps.image.reason || caps.docker.reason || 'unknown'}（fail-closed，不降级）`);
        }
        return runTestInContainer({ config: this.config, worktree, command: cmd, env: this.containerTestEnv(project), timeoutMs, logPath: pathName, signal, metadata });
      }
      const sandbox = tmpHomeFor(this.config, `local-${newId('run')}`, newId('task'));
      return execShell(cmd, {
        cwd: worktree,
        timeoutMs,
        logPath: pathName,
        signal,
        env: buildTestEnv({ config: this.config, project, homeDir: path.join(sandbox, 'test-home') }),
      });
    };
    // 按真实技术栈准备依赖：仅对 require_real_tests 的新项目自动执行一次有界依赖安装。
    const autoSetup = (() => {
      const cfg = project?.config_json || {};
      if (!cfg.require_real_tests || !cfg.auto_test_setup) return '';
      try {
        if (fs.existsSync(path.join(worktree, 'requirements.txt'))) return 'python3 -m pip install -r requirements.txt';
        if (fs.existsSync(path.join(worktree, 'pyproject.toml'))) return 'python3 -m pip install -e .';
        if (fs.existsSync(path.join(worktree, 'go.mod'))) return 'go mod download';
        if (fs.existsSync(path.join(worktree, 'Cargo.toml'))) return 'cargo fetch';
        if (!fs.existsSync(path.join(worktree, 'package.json'))) return '';
        if (fs.existsSync(path.join(worktree, 'node_modules'))) return '';
        const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
        if (!pkg.dependencies && !pkg.devDependencies) return '';
        if (fs.existsSync(path.join(worktree, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile --ignore-scripts';
        if (fs.existsSync(path.join(worktree, 'yarn.lock'))) return 'yarn install --frozen-lockfile --ignore-scripts';
        return 'npm install --no-audit --no-fund --ignore-scripts';
      } catch { return ''; }
    })();
    const setup = String(project?.config_json?.test_setup_command || '').trim() || autoSetup;
    // 隐藏契约测试由 Workbench 独立执行，不依赖 Agent 的 test script 是否包含它。
    if (project?.config_json?.require_real_tests) {
      const trustedRel = project.config_json?.test_plan?.trustedContractTest || 'tests/acceptance/workbench-contract.test.mjs';
      const trustedLog = `${logPath}.trusted-contract.log`;
      const trustedBin = this.containerTestRequested(project) ? 'node' : process.execPath;
      const trusted = await runOnce(`${JSON.stringify(trustedBin)} --test ${JSON.stringify(trustedRel)}`, trustedLog);
      if (trusted.code !== 0) throw new PolicyError('TRUSTED_CONTRACT_TEST_FAILED', `隐藏契约测试未通过（exit=${trusted.code}）：${(trusted.stderr || trusted.stdout || '').slice(-2000)}`);
    }
    let res;
    if (autoSetup) {
      const setupLog = `${logPath}.auto-setup.log`;
      const setupRes = await runOnce(autoSetup, setupLog);
      if (setupRes.code !== 0) throw new PolicyError('TEST_SETUP_FAILED', `真实测试依赖准备失败（${autoSetup}，exit=${setupRes.code}）：${(setupRes.stderr || setupRes.stdout || '').slice(-2000)}`);
      res = await runOnce(command, logPath);
      res.autoSetup = true;
      res.setupCommand = autoSetup;
      res.setupLogPath = setupLog;
    } else {
      res = await runOnce(command, logPath);
    }
    // P1-2：测试命令因缺少项目依赖/环境而失败时，先执行有界 setup 再重试一次；不修改业务代码。
    if (res.code === 127 && setup) {
      if (setup.length > 1200 || /[\n\r]/.test(setup)) throw new PolicyError('TEST_SETUP_INVALID', 'test_setup_command 非法');
      const setupLog = `${logPath}.setup.log`;
      const setupRes = await runOnce(setup, setupLog);
      if (setupRes.code === 0) {
        res = await runOnce(command, `${logPath}.retry.log`);
        res.setupRetried = true;
        res.setupCommand = setup;
        res.setupLogPath = setupLog;
      } else {
        res.setupRetried = true;
        res.setupCommand = setup;
        res.setupLogPath = setupLog;
        res.setupFailed = true;
        res.stderr = `${res.stderr || ''}\n[test_setup_command exit=${setupRes.code}]\n${(setupRes.stderr || setupRes.stdout || '').slice(-2000)}`;
      }
    }
    if (project?.config_json?.require_real_tests) {
      let evidence = validateTestEvidence({ project, worktree, command, result: res });
      // 测试命令本身可能是不可移植的包脚本（例如 node --test tests/），但产品测试可由独立可信运行器实际执行。
      // 仅当原命令确有测试文件、可信运行器真实通过时采用，绝不把退出码 0 当成测试证据。
      const failureClass = classifyTestFailure(res, command);
      const uncovered = (evidence.all || []).filter((f) => !f.meaningful && !String(f.file).includes('workbench-contract.test'));
      // 原始 test 脚本若包含 lint/build/typecheck 等强制阶段，回退不能跳过它们。
      let mandatoryPhase = false;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
        const script = String(pkg.scripts?.test || '');
        mandatoryPhase = /(?:&&|\|\||;|\b(?:lint|build|tsc|typecheck|check|coverage|audit)\b)/i.test(script);
      } catch { /* no package */ }
      // 只有明确是测试命令/运行器兼容性错误、且所有非冻结测试文件都被覆盖、且无强制阶段时，才允许可信回退。
      // 产品断言失败、混合格式、遗漏文件、lint/build 一律保留 FAIL/BLOCKED。
      if (!evidence.ok && evidence.code === 'TEST_EXIT_NONZERO' && !mandatoryPhase && failureClass === 'runner_compatibility' && uncovered.length === 0 && Array.isArray(evidence.productTestFiles) && evidence.productTestFiles.length) {
        const originalExit = res.code; const originalStdout = String(res.stdout || '').slice(-4000); const originalStderr = String(res.stderr || '').slice(-4000);
        try {
          const fallbackCmd = trustedProductTestCommand(worktree, evidence.productTestFiles, { nodeBin: this.containerTestRequested(project) ? 'node' : process.execPath });
          const fallbackRes = await runOnce(fallbackCmd, `${logPath}.trusted-fallback.log`);
          const fallbackEvidence = validateTestEvidence({ project, worktree, command: fallbackCmd, result: fallbackRes });
          if (fallbackEvidence.ok) {
            res = fallbackRes; evidence = fallbackEvidence;
            res.testCommandFallback = fallbackCmd;
            res.testFallbackEvidence = { reason: 'runner_compatibility', originalCommand: command, originalExit, originalStdout, originalStderr, fallbackCommand: fallbackCmd, files: evidence.productTestFiles, count: parseTestCount(fallbackRes.stdout, fallbackRes.stderr) };
            this.emit({ runId, projectId: project.id, taskId, type: 'test_command_fallback', level: 'warn', message: `原测试命令属于运行器兼容性错误，已使用独立可信运行器覆盖 ${evidence.productTestFiles.length} 个产品测试文件：${fallbackCmd}`, data: res.testFallbackEvidence });
          } else {
            this.emit({ runId, projectId: project.id, taskId, type: 'test_command_fallback_failed', level: 'error', message: `可信运行器回退仍未通过：${fallbackEvidence.reason || fallbackEvidence.code}`, data: { fallbackCommand: fallbackCmd, code: fallbackEvidence.code } });
          }
        } catch (err) {
          this.emit({ runId, projectId: project.id, taskId, type: 'test_command_fallback_failed', level: 'error', message: `可信运行器回退异常：${err.message}` });
        }
      } else if (!evidence.ok) {
        this.emit({ runId, projectId: project.id, taskId, type: 'test_no_fallback', level: 'warn', message: `测试失败不满足可信回退条件（class=${failureClass}, uncovered=${uncovered.length}），保持 FAIL`, data: { failureClass, uncovered: uncovered.map((f) => f.file), code: evidence.code } });
      }
      res.realTestEvidence = evidence;
      if (!evidence.ok) throw new PolicyError(evidence.code || 'TEST_EVIDENCE_INVALID', `${evidence.reason}；真实测试未成立，不能进入审计/交付`);
      // 独立可信运行器：不信任 Agent 的 test script 输出；直接执行发现到的产品测试文件。
      const trustedCommand = trustedProductTestCommand(worktree, evidence.productTestFiles || [], { nodeBin: this.containerTestRequested(project) ? 'node' : process.execPath });
      const trustedLog = `${logPath}.trusted-product.log`;
      const trustedRes = await runOnce(trustedCommand, trustedLog);
      const trustedCount = parseTestCount(trustedRes.stdout || '', trustedRes.stderr || '');
      const minTests = Math.max(1, Number(project.config_json?.test_plan?.minTests || 1));
      if (trustedRes.code !== 0) throw new PolicyError('TRUSTED_TEST_RUN_FAILED', `可信测试运行器失败（exit=${trustedRes.code}）：${(trustedRes.stderr || trustedRes.stdout || '').slice(-2000)}`);
      if (!trustedCount || trustedCount < minTests) throw new PolicyError('TRUSTED_TEST_COUNT_TOO_LOW', `可信运行器实际执行测试数 ${trustedCount} < ${minTests}；拒绝用 Agent 自报输出作为 PASS`);
      res.trustedProductTest = { command: trustedCommand, testCount: trustedCount, logPath: trustedLog, files: evidence.productTestFiles };
    }
    return res;
  }

  async runTask(run, task, signal) {
    const project = this.store.getProject(task.project_id);
    const plan = this.store.getPlan(task.plan_id);
    const runShort = run.id.slice(-6);
    const planBranch = `wb/plan-${runShort}`;
    const maxAttempts = Number(task.max_attempts || this.config.budget.maxAttempts);
    const maxInfraRecoveries = Math.max(0, Math.min(3, Number(project.config_json?.infra_recovery_max ?? 2)));
    const protectedPaths = protectPathsForProject(project, this.config);
    const sandboxHome = tmpHomeFor(this.config, run.id, task.id);
    let sessionId = task.session_id || '';
    let feedback = '';
    let lastTest = null;
    let lastAudit = null;
    let lastAgent = null;
    let changedFiles = [];
    let auditResourceInfo = null;

    const logDir = this.logsDir(run.id, task.id);
    ensureDir(logDir);

    try {
      this.store.transitionTask(task.id, TaskStatus.QUEUED, TaskStatus.PREPARING);
      this.emit({
        runId: run.id, projectId: project.id, taskId: task.id, type: 'task_started',
        message: `开始任务 ${task.seq}/${this.store.listTasks({ planId: task.plan_id }).length}：${task.title}`,
        data: { seq: task.seq, acceptance: task.acceptance_json },
      });

      // Provider-aware 流水线资源预检：审计资源不可用时在编码前阻塞（保存检查点）
      try {
        if (this.deps.runAudit !== runAudit) throw { code: 'PREFLIGHT_SKIPPED_FOR_INJECTED_AUDIT', message: '测试注入审计器，跳过真实 Provider 预检' };

        const primaryAgent = await this.deps.chooseAgent(this.config, project, task);
        const primaryIdentity = resolveAgentIdentity({ config: this.config, agentId: primaryAgent || 'dsh', project });
        const coderFamily = primaryIdentity.known ? modelFamily(primaryIdentity.provider, primaryIdentity.model || '') : '';
        const auditResource = this.auditResourcePreflight(project, coderFamily);
        auditResourceInfo = auditResource;
        const exp = this.store.getExperimentForProject?.(project.id);
        const bind = exp?.provider_json || {};
        if (exp && bind.coding) {
          if (primaryAgent !== bind.coding.client) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `实际 Coding Agent ${primaryAgent} 与授权 ${bind.coding.client} 不匹配；禁止自动切换`);
          if (primaryIdentity.provider !== bind.coding.provider || String(primaryIdentity.model || '').toLowerCase() !== String(bind.coding.model || '').toLowerCase()) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `实际 Coding 模型 ${primaryIdentity.provider}/${primaryIdentity.model} 与授权 ${bind.coding.provider}/${bind.coding.model} 不匹配`);
        }
        if (exp && bind.audit) {
          const effectiveAuditClient = this.isDshAuditProject(project) ? 'dsh' : auditResource.provider;
          if (effectiveAuditClient !== bind.audit.client) throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `实际 Audit ${effectiveAuditClient} 与授权 ${bind.audit.client} 不匹配`);
          if (auditResource.provider !== bind.audit.provider && bind.audit.client !== 'dsh') throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `实际 Audit Provider ${auditResource.provider} 与授权 ${bind.audit.provider} 不匹配`);
        }
        this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'pipeline_resource_checked', message: `流水线资源预检通过：编码=${primaryIdentity.provider || 'unknown'}，审计=${auditResource.provider}${auditResource.exempt ? '（豁免）' : ''}`, data: { coding: primaryIdentity, audit: auditResource } });
      } catch (err) {
        if (err?.code === 'PREFLIGHT_SKIPPED_FOR_INJECTED_AUDIT') {
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'pipeline_resource_checked', message: '测试注入审计器：跳过真实 Provider 预检' });
        } else {
          const reason = `流水线资源阻塞（编码前检查点）：${err.message}`;
          this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
          this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason });
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'pipeline_resource_blocked', level: 'warn', message: reason });
          return { ok: false, reason };
        }
      }
      const base = await this.ensurePlanBranch(project, planBranch);
      const branch = `wb/r${runShort}/t${task.seq}`;
      let worktree = task.worktree_path || path.join(this.config.paths.worktreesDir, project.id, run.id, `task-${task.seq}`);
      let baseCommit = task.base_commit || '';
      const reusable = (() => { try { return fs.existsSync(worktree) && fs.existsSync(path.join(worktree, '.git')); } catch { return false; } })();
      if (!reusable) {
        await gitops.git(project.local_path, ['branch', '-D', branch], { allowFail: true });
        await gitops.createWorktree(project.local_path, worktree, branch, base);
        baseCommit = await gitops.currentHead(worktree);
      } else if (!baseCommit) {
        baseCommit = await gitops.currentHead(worktree);
      }
      this.store.updateTask(task.id, { status: TaskStatus.PREPARING, worktree_path: worktree, branch, base_commit: baseCommit });
      // 若上次已生成检查点但 Worktree 不存在/被重建，先校验并恢复所有未提交文件。
      const savedCheckpoint = task.verification_json?.checkpoint || this.store.getTask(task.id)?.verification_json?.checkpoint;
      if (savedCheckpoint?.archive && !reusable) {
        try { await this.verifyAndRestoreCheckpoint(savedCheckpoint, worktree); this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'checkpoint_restored', message: `已从检查点恢复 ${savedCheckpoint.files || 0} 个文件（manifest ${String(savedCheckpoint.manifestHash || '').slice(0, 12)}）`, data: savedCheckpoint }); }
        catch (err) { return this.failTask(run, task, `检查点损坏，拒绝继续：${err.message}`, 'blocked'); }
      }
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'worktree_ready', message: `工作副本就绪：${branch}`, data: { worktree, baseCommit, planBranch } });

      const agentCandidates = await this.resolveAgentCandidates(project, task);
      if (!agentCandidates.length) {
        return this.failTask(run, task, '没有可用的 Coding Agent（请检查 DSH / Claude Code 配置）', 'blocked');
      }
      let candidateIndex = 0;
      let agentSwitches = 0;
      let productAttempts = 0;
      for (let attemptNo = 1; attemptNo <= maxAttempts + maxInfraRecoveries; attemptNo++) {
        if (productAttempts >= maxAttempts) break;
        if (signal.aborted) throw new PolicyError('RUN_ABORTED', '运行已被取消');
        const currentRun = this.store.getRun(run.id) || run;
        assertRunWallClock(currentRun, this.config.budget.runWallClockMs);
        const pu = this.weightProjectUsage(this.store.usageForProject(project.id));
        assertProjectBudget({
          config: this.config, project, run: currentRun,
          totals: pu, estimatedTokens: 10_000, estimatedCostCny: 0.05,
        });
        this.store.updateTask(task.id, { status: TaskStatus.CODING, attempt: attemptNo });

        const agentId = agentCandidates[candidateIndex] || agentCandidates[0];
        const expBinding = this.store.getExperimentForProject?.(project.id)?.provider_json || {};
        if (expBinding.coding && agentId !== expBinding.coding.client) return this.failTask(run, task, `实验授权 Coding Agent=${expBinding.coding.client}，实际候选=${agentId}；拒绝自动切换`, 'blocked', { modelBinding: expBinding.coding });
        const agentIdentity = resolveAgentIdentity({ config: this.config, agentId, project });
        if (expBinding.coding && (agentIdentity.provider !== expBinding.coding.provider || String(agentIdentity.model || '').toLowerCase() !== String(expBinding.coding.model || '').toLowerCase())) return this.failTask(run, task, `实验授权 Coding 模型=${expBinding.coding.provider}/${expBinding.coding.model}，实际=${agentIdentity.provider}/${agentIdentity.model}；拒绝执行`, 'blocked', { modelBinding: expBinding.coding });

        let permission;
        try {
          permission = resolveAgentPermission(this.config, agentId, project);
        } catch (err) {
          return this.failTask(run, task, `Agent 权限策略拒绝执行：${err.message}`, 'blocked');
        }
        if (!agentIdentity.exempt) this.assertBudget(10_000);
        const prompt = this.buildCodingPrompt({
          project, task, attemptNo, maxAttempts, feedback, worktree, protectedPaths, plan,
          agentId, permission,
        });
        const promptArtifact = this.writeArtifact({
          runId: run.id, taskId: task.id, kind: 'prompt',
          filename: `attempt-${attemptNo}-coding-prompt.md`, content: prompt,
        });
        const attempt = this.store.createAttempt({
          id: newId('att'), runId: run.id, taskId: task.id, attemptNo, stage: 'coding',
          agentKind: agentId, sessionId, prompt, status: 'running', logPath: '',
        });
        this.emit({
          runId: run.id, projectId: project.id, taskId: task.id, type: 'agent_started',
          message: `第 ${attemptNo}/${maxAttempts} 轮编码：${agentId === 'dsh' ? 'DeepSeek Harness' : agentId === 'claude' ? 'Claude Code' : agentId}（${permission.mode}）`,
          data: { agent: agentId, attemptNo, sessionId: sessionId || null, promptArtifact, permission: permission.mode },
        });

        let agentContainer = null;
        if (this.agentContainerRequested(project)) {
          if (agentId !== 'claude') {
            return this.failTask(run, task, `项目要求容器 Agent，但当前 Agent ${agentId} 不支持容器执行（仅 Claude Code）；未降级为宿主执行`, 'blocked');
          }
          const caps = containerCapabilities(this.config);
          if (!caps.agentExecution) {
            return this.failTask(run, task, `项目要求容器 Agent，但 Docker/镜像不可用：${caps.image.reason || caps.docker.reason || 'unknown'}（fail-closed，不降级）`, 'blocked');
          }
          agentContainer = { network: project.config_json?.container_agent_network || this.config.isolation?.container?.networkAgent || 'bridge', metadata: { runId: run.id, taskId: task.id, projectId: project.id, owner: this.instanceId, fence: this.projectLeases.get(project.id)?.fence || 0 } };
        }
        const release = await this.agentSemaphore.acquire();
        let agentResult;
        let agentReservation = null;
        try {
          const codingExperimentId = this.experimentIdForProject(project.id);
          // 统一真实付费 Provider 风险准入：没有调用中可执行硬边界时，实验内默认 fail-closed。
          // 唯一例外是冻结实验契约中按 client/provider/model 精确绑定的用户风险许可；
          // 环境变量、单独配置开关、重启或切换模型都不能绕过。
          const userPays = agentId !== 'custom' && agentIdentity.provider !== 'custom';
          if (codingExperimentId && userPays && this.deps.runAgent === runAgent) {
            const gate = evaluateProviderRiskGate({ store: this.store, experimentId: codingExperimentId, binding: { client: agentId, provider: agentIdentity.provider, model: agentIdentity.model } });
            if (!gate.ok) {
              return this.failTask(run, task, `BUDGET_RISK_BLOCKED（${gate.code}）：${agentId}/${agentIdentity.provider}/${agentIdentity.model || 'unknown'} 没有可执行费用硬边界，且冻结实验契约没有有效匹配的风险许可；已 fail-closed，禁止启动付费调用。`, 'blocked');
            }
            if (gate.mode === 'contract-risk-accepted') {
              this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'budget_risk_accepted', level: 'warn', message: `使用实验契约内用户风险许可启动调用：${gate.acceptance.reason}（仍不宣称绝对费用硬上限）`, data: gate.acceptance });
            }
          }
          const remaining = this.budget().remainingTokens;
          const projectTaskCap = Number(project.budget_json?.max_tokens_per_task || 0);
          const perTaskCap = projectTaskCap > 0 ? projectTaskCap : this.config.budget.maxTokensPerTask;
          let experimentTokenRemaining = Infinity;
          if (codingExperimentId) {
            const exp = this.store.getExperimentContract(codingExperimentId);
            const eu = this.store.experimentUsage(codingExperimentId);
            if (agentIdentity.provider === 'glm') experimentTokenRemaining = Number(exp?.glm_token_limit || 0) > 0 ? Number(exp.glm_token_limit) - Number(eu.byScope?.glm?.tokens || 0) : Infinity;
            else experimentTokenRemaining = Number(exp?.token_limit || 0) > 0 ? Number(exp.token_limit) - Number(eu.tokens || 0) : Infinity;
          }
          const perTaskTokens = codingExperimentId
            ? Math.max(0, Math.min(perTaskCap, experimentTokenRemaining))
            : (agentIdentity.exempt ? 0 : Math.min(perTaskCap, Math.max(15_000, remaining - 25_000)));
          const perCallMax = codingExperimentId ? Number(this.store.getExperimentContract(codingExperimentId)?.per_call_max_tokens || 0) : 0;
          const codingReservation = resolveCodingReservation({ perTaskTokens, perCallMaxTokens: perCallMax });
          if (codingExperimentId && !codingReservation.ok) {
            return this.failTask(run, task, `BUDGET_BLOCKED：剩余额度 ${perTaskTokens} / 单次预留上限 ${perCallMax} 不足，拒绝启动 Coding 调用`, 'blocked');
          }
          // GLM 的全局豁免不适用于实验：实验内 GLM Coding 仍必须原子预留并受 GLM 分项上限约束。
          // 预留同时受单任务剩余额度和实验 per-call 上限约束。
          if (!agentIdentity.exempt || codingExperimentId) {
            const reserveEstimate = codingExperimentId ? codingReservation.tokens : Math.max(12_000, codingReservation.tokens);
            agentReservation = assertModelBudget({ config: this.config, store: this.store, provider: agentIdentity.provider, model: agentIdentity.model || '', estimatedTokens: reserveEstimate, label: 'Coding Agent', reserve: true, experimentId: codingExperimentId, experimentScope: agentIdentity.provider === 'glm' ? 'glm' : 'global', experimentRole: 'coding', experimentClient: agentId });
          }
          const watchdog = await this.runAgentWithWatchdog({
            agentId,
            worktree,
            parentSignal: signal,
            stallTimeoutMs: Number(project.config_json?.agent_stall_timeout_ms || this.config.agents.stallTimeoutMs),
            ctx: {
              config: this.config,
              project,
              prompt,
              cwd: worktree,
              sessionId,
              timeoutMs: agentId === 'claude' ? Math.max(Number(this.config.agents.claude.timeoutMs || 0), Number(this.config.agents.containerStallTimeoutMs || 0) + 60_000) : this.config.agents.dsh.timeoutMs,
              maxTokens: perTaskTokens,
              identity: agentIdentity,
              container: agentContainer,
              agentHome: path.join(sandboxHome, `${agentId}-home`),
              logPath: path.join(logDir, `attempt-${attemptNo}-${agentId}.log`),
              onEvent: (evt) => {
                if (!evt) return;
                const message = evt.kind === 'tool_call'
                  ? `[${agentId}] 调用工具 ${evt.tool}${evt.summary ? `：${evt.summary}` : ''}`
                  : `[${agentId}] ${evt.summary || evt.kind}`;
                this.emit({
                  runId: run.id, projectId: project.id, taskId: task.id, type: 'agent_progress',
                  level: evt.kind === 'error' ? 'warn' : 'debug', message: truncate(message, 500),
                });
              },
            },
          });
          agentResult = { ...watchdog.result, stalled: !!watchdog.stalled };
        } finally {
          release();
          if (agentReservation?.reservation?.id && !agentResult) this.store.markModelReservationUnknown(agentReservation.reservation.id);
        }
        if (agentReservation?.reservation?.id) {
          const au = summarizeUsage(agentResult?.usage || {});
          this.store.settleModelReservation(agentReservation.reservation.id, { actualTokens: au.total, actualCostCny: agentResult?.costCny || 0, usageKnown: !!(agentResult?.usage && au.total > 0) });
        }
        // 人工/系统暂停已请求：不把中断归类为 Agent 产品失败，保留任务检查点等待恢复。
        if (signal.aborted) return { ok: false, reason: '运行被暂停/取消，任务检查点已保留' };
        this.assertProjectLease(project.id);
        lastAgent = agentResult;
        const usage = summarizeUsage(agentResult.usage || {});
        this.store.updateAttempt(attempt.id, {
          sessionId: agentResult.sessionId || sessionId,
          exitCode: agentResult.exitCode ?? null,
          status: agentResult.ok ? 'completed' : 'failed',
          error: agentResult.error || '',
          tokensIn: usage.input, tokensOut: usage.output, tokensCache: usage.cacheRead + usage.cacheWrite,
          costCny: agentResult.costCny || 0,
          costReported: !!agentResult.costReported,
          costSource: agentResult.costSource || (agentResult.costReported ? 'vendor' : 'estimated'),
          provider: agentResult.provider || (agentIdentity.known ? agentIdentity.provider : 'unknown'),
          providerKnown: agentResult.providerKnown ?? agentIdentity.known,
          providerSource: agentResult.providerSource || agentIdentity.source,
          failureClass: agentResult.ok ? '' : this.classifyAgentFailure(agentResult),
          model: agentResult.model || agentIdentity.model || '',
          durationMs: agentResult.durationMs || 0,
          logPath: agentResult.logPath || '',
        });
        this.store.addRunUsage(run.id, { tokens: usage.total, costCny: agentResult.costCny || 0 });
        if (agentResult.sessionId) {
          sessionId = agentResult.sessionId;
          this.store.updateTask(task.id, { session_id: sessionId });
        }
        this.emit({
          runId: run.id, projectId: project.id, taskId: task.id,
          type: agentResult.ok ? 'agent_finished' : 'agent_failed',
          level: agentResult.ok ? 'info' : 'warn',
          type: agentResult.ok ? 'agent_finished' : 'agent_failed',
          level: agentResult.ok ? 'info' : 'warn',
          message: agentResult.ok
            ? `编码 Agent 完成（${Math.round((agentResult.durationMs || 0) / 1000)}s，tokens ${usage.total}，费用来源：${agentResult.costReported ? '厂商返回' : '估算'}）`
            : `编码 Agent 失败${agentResult.stalled ? '（无进展，看门狗已终止）' : ''}：${agentResult.error}`,
          data: { agent: agentId, tokens: usage.total, costCny: agentResult.costCny, costReported: !!agentResult.costReported, stalled: !!agentResult.stalled, failureClass: agentResult.ok ? '' : this.classifyAgentFailure(agentResult), agentSwitches },
        });

        if (!agentResult.ok) {
          const failureClass = this.classifyAgentFailure(agentResult);
          const infra = this.isInfrastructureFailure(failureClass, agentResult);
          if (infra || failureClass === 'budget') {
            const reason = `基础设施/预算中断（${failureClass}）：${agentResult.error || 'Agent 未完成'}`;
            const currentTask = this.store.getTask(task.id) || task;
            const prevVerification = currentTask.verification_json && typeof currentTask.verification_json === 'object' ? currentTask.verification_json : {};
            const infraCount = Number(prevVerification.infra_recovery_count || 0);
            let checkpointHead = ''; let checkpointTree = '';
            try { checkpointHead = (await gitops.currentHead(worktree)) || ''; checkpointTree = (await gitops.git(worktree, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim(); } catch { /* best effort */ }
            const checkpoint = { failureClass, error: agentResult.error || '', sessionId: agentResult.sessionId || sessionId, usage, durationMs: agentResult.durationMs || 0, worktree, head: checkpointHead, tree: checkpointTree, runId: run.id, taskId: task.id, attemptNo, logPath: agentResult.logPath || '', stalled: !!agentResult.stalled, at: nowIso() };
            try {
              this.writeArtifact({
                runId: run.id, taskId: task.id, kind: 'agent-checkpoint',
                filename: `attempt-${attemptNo}-${agentId}-abort.json`, content: checkpoint,
              });
            } catch { /* evidence best effort */ }
            this.store.updateTask(task.id, { status: TaskStatus.CODING, blocked_reason: reason, session_id: agentResult.sessionId || sessionId, verification_json: { ...prevVerification, infra_recovery_count: infraCount, checkpoint } });
            // 可恢复基础设施故障：保留同一任务/工作副本/Session，清理失效容器后由原授权 Agent 自动续跑。
            if (failureClass !== 'budget' && infraCount < maxInfraRecoveries) {
              const next = infraCount + 1;
              this.store.updateTask(task.id, { status: TaskStatus.QUEUED, blocked_reason: '', verification_json: { ...prevVerification, infra_recovery_count: next, checkpoint: { ...checkpoint, recoveryAt: nowIso() } } });
              this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'infrastructure_recovery', level: 'warn', message: `基础设施故障自动恢复 ${next}/${maxInfraRecoveries}：保留工作副本和 Session，使用原授权 Agent 续跑`, data: { failureClass, next, maxInfraRecoveries, worktree, sessionId: agentResult.sessionId || sessionId } });
              let cleanupOk = true;
              try {
                const { cleanupOrphanContainers } = await import('./container.js');
                const cleanup = await cleanupOrphanContainers({ config: this.config, store: this.store, log: (m) => this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'container_recovery', message: m }) });
                if (cleanup?.error) throw new Error(cleanup.error);
                if (cleanup?.failed?.length) throw new Error(`容器清理未确认：${cleanup.failed.map((x) => x.error).join('；').slice(0, 800)}`);
              } catch (e) { cleanupOk = false; this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'container_recovery_failed', level: 'warn', message: `容器清理失败，停止自动恢复：${e.message}` }); }
              if (!cleanupOk) {
                const blocked = `${reason}；容器清理失败，拒绝启动冲突 Agent`;
                this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: blocked });
                this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: blocked, current_task_id: task.id });
                return { ok: false, reason: blocked, infrastructure: true };
              }
              await new Promise((r) => setTimeout(r, Math.min(5000, 500 * next)));
              // 保持 worktree 与 session；继续下一轮 attempt（原 Agent 候选不切换）。
              continue;
            }
            this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason, session_id: agentResult.sessionId || sessionId, verification_json: { ...prevVerification, infra_recovery_count: infraCount, checkpoint } });
            this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason, current_task_id: task.id });
            this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'infrastructure_blocked', level: 'error', message: `${reason}；恢复次数已耗尽或属于必须重新授权故障`, data: { failureClass, infraCount, maxInfraRecoveries, checkpoint } });
            return { ok: false, reason, infrastructure: true };
          }
          productAttempts += 1;
          const canSwitch = ['agent_no_output', 'agent_error'].includes(failureClass);
          if (canSwitch) {
            const previous = agentId;
            let nextAgent = '';
            if (candidateIndex + 1 < agentCandidates.length) {
              candidateIndex += 1;
              nextAgent = agentCandidates[candidateIndex];
            } else if (attemptNo < maxAttempts) {
              // 没有可用备选/备选也失败时，回到主 Agent 的全新会话（不合并/不降低验收标准）
              candidateIndex = 0;
              nextAgent = agentCandidates[0];
            }
            if (nextAgent) {
              agentSwitches += 1;
              sessionId = '';
              this.store.updateTask(task.id, { session_id: '' });
              feedback = `上一轮 Agent（${previous}）失败/无进展（${failureClass}：${agentResult.error}）。已终止并切换到 ${nextAgent} 全新会话重新执行；保留验收标准不变。`;
              this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'agent_fallback', level: 'warn', message: `Agent 失败分类 ${failureClass}，切换到 ${nextAgent}（新会话）`, data: { from: previous, to: nextAgent, failureClass, stalled: !!agentResult.stalled, attemptNo } });
              this.recordFailure(task, failureSignature({ testTail: `fallback:${failureClass}:${previous}:${attemptNo}` }));
              continue;
            }
          }
          feedback = `上一轮 Agent 执行失败：${agentResult.error}。请重新执行任务，确保只通过文件编辑产出可运行代码。`;
          const repeated = this.recordFailure(task, failureSignature({ testTail: agentResult.error }));
          if (repeated >= 1) return this.failTask(run, task, `Agent 连续失败（${failureClass}），无可用的替代 Agent 或重试预算，停止并保留证据：${agentResult.error}`, 'blocked');
          sessionId = '';
          continue;
        }

        productAttempts += 1;
        // ---- 变更检查 ----
        const diff = await gitops.stagedDiff(worktree, baseCommit, { maxChars: 1_000_000 });
        const fileEntries = await gitops.stagedFiles(worktree, baseCommit);
        changedFiles = fileEntries.map((f) => f.file);
        if (changedFiles.length === 0) {
          feedback = '你没有修改任何文件。请实际实现任务要求再结束。';
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'no_changes', level: 'warn', message: 'Agent 未产生任何代码变更，要求重做' });
          const repeated = this.recordFailure(task, failureSignature({ testTail: 'no changes' }));
          if (repeated >= 1) return this.failTask(run, task, 'Agent 连续未产生代码变更，停止自动重试', 'blocked');
          continue;
        }
        this.writeArtifact({ runId: run.id, taskId: task.id, kind: 'diff', filename: `attempt-${attemptNo}.diff`, content: diff });

        const violations = protectedViolations(changedFiles, protectedPaths);
        if (violations.length) {
          await enforceProtectedPaths(worktree, violations);
          feedback = `你修改了受保护路径：${violations.join(', ')}。这些文件禁止修改，已还原。请只修改实现代码。`;
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'protected_path_violation', level: 'warn', message: feedback, data: { violations } });
          const repeated = this.recordFailure(task, failureSignature({ testTail: `protected:${violations.join(',')}` }));
          if (repeated >= 1) return this.failTask(run, task, '多次修改受保护路径，任务阻塞', 'blocked', { violations });
          continue;
        }
        const contractViolations = verifyContractBaseline(worktree, project.config_json?.contract_baseline || {});
        if (contractViolations.length) {
          await enforceProtectedPaths(worktree, contractViolations);
          return this.failTask(run, task, `冻结验收契约被修改且已还原：${contractViolations.join(', ')}；修改契约必须由用户显式授权`, 'blocked', { contractViolations });
        }
        const testBaselineViolations = verifyTestBaseline(worktree, project.config_json?.trusted_test_hashes || {});
        if (testBaselineViolations.length) {
          await enforceProtectedPaths(worktree, testBaselineViolations);
          return this.failTask(run, task, `已冻结测试/运行器被修改：${testBaselineViolations.join(', ')}；新增测试可提交，修改已有测试必须显式授权`, 'blocked', { testBaselineViolations });
        }

        if (signal.aborted) return { ok: false, reason: '运行被暂停/取消，任务检查点已保留' };
        // ---- 指纹：确保审计/测试/提交是同一版本 ----
        this.assertProjectLease(project.id);
        await gitops.stageAll(worktree);
        const testedHash = (await gitops.git(worktree, ['write-tree'])).stdout.trim();
        this.store.updateTask(task.id, { status: TaskStatus.TESTING, verification_json: { baseCommit, testedHash } });

        const testCommand = this.resolveTaskTestCommand(project, task, worktree);
        let safeCommand;
        try {
          safeCommand = assertSafeTestCommand(testCommand, project);
        } catch (err) {
          return this.failTask(run, task, `测试命令安全校验失败：${err.message}`, 'blocked');
        }
        this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_started', message: `运行测试：${safeCommand}`, data: { command: safeCommand, testedHash } });
        const testRes = await this.runProjectTest({
          project,
          worktree,
          command: safeCommand,
          timeoutMs: Number(project.config_json?.test_timeout_ms || this.config.policy.testTimeoutMs),
          logPath: path.join(logDir, `attempt-${attemptNo}-test.log`),
          signal,
          metadata: { runId: run.id, taskId: task.id, projectId: project.id, owner: this.instanceId, fence: this.projectLeases.get(project.id)?.fence || 0 },
          runId: run.id,
          taskId: task.id,
        });
        if (signal.aborted) return { ok: false, reason: '运行被暂停/取消，测试检查点已保留' };
        lastTest = {
          command: safeCommand, code: testRes.code, timedOut: testRes.timedOut,
          durationMs: testRes.durationMs, stdout: testRes.stdout, stderr: testRes.stderr,
          isolation: testRes.isolation || null,
          setupRetried: !!testRes.setupRetried, setupCommand: testRes.setupCommand || '', setupLogPath: testRes.setupLogPath || '', setupFailed: !!testRes.setupFailed,
        };
        const testArtifactContent = `$ ${safeCommand}\nexit=${testRes.code} duration=${testRes.durationMs}ms\n${testRes.isolation ? `isolation=${JSON.stringify(testRes.isolation)}\n` : ''}\n[stdout]\n${testRes.stdout}\n\n[stderr]\n${testRes.stderr}`;
        const testArtifact = this.writeArtifact({
          runId: run.id, taskId: task.id, kind: 'test', filename: `task-${task.id}-attempt-${attemptNo}-test.txt`,
          content: testArtifactContent,
        });
        const testArtifactSha256 = crypto.createHash('sha256').update(testArtifactContent).digest('hex');
        await gitops.stageAll(worktree);
        const afterTestHash = (await gitops.git(worktree, ['write-tree'])).stdout.trim();
        if (afterTestHash !== testedHash) {
          return this.failTask(run, task, '测试期间工作树内容发生变化（指纹不一致），无法保证测试版本与审计版本一致', 'blocked', { testedHash, afterTestHash });
        }
        if (testRes.code !== 0) {
          feedback = [
            `测试命令失败（exit=${testRes.code}${testRes.timedOut ? '，超时' : ''}）：${safeCommand}`,
            '测试输出（末尾）：', tailLines(testRes.stdout || testRes.stderr || '', 60),
            '请修复实现代码使测试全部通过。禁止修改测试文件。',
          ].join('\n');
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_failed', level: 'warn', message: `测试失败（exit=${testRes.code}），将反馈给 Agent 修复`, data: { code: testRes.code, command: safeCommand } });
          this.store.updateTask(task.id, { status: TaskStatus.REPAIRING });
          const repeated = this.recordFailure(task, failureSignature({ testCode: testRes.code, testTail: tailLines(testRes.stdout || testRes.stderr || '', 40) }));
          if (repeated >= 1) return this.failTask(run, task, '检测到重复的测试失败签名，停止无限重试，保留证据等待人工处理', 'blocked', { lastTest });
          continue;
        }
        this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_passed', message: `测试通过（${Math.round(testRes.durationMs / 1000)}s）`, data: { code: 0, command: safeCommand, durationMs: testRes.durationMs, testedHash } });

        // ---- 独立审计 ----
        this.store.updateTask(task.id, { status: TaskStatus.AUDITING });
        const coderFamily = coderFamilyFor(agentId, this.config);
        this.emit({
          runId: run.id, projectId: project.id, taskId: task.id, type: 'audit_started',
          message: `开始独立审计（编码模型族：${coderFamily}）`,
          data: { audit: auditProviderStatus(this.config, { coderFamily }) },
        });
        if (!this.isDshAuditProject(project)) this.assertBudget(6_000);
        let audit;
        let auditReservation = null;
        let auditCommit = '';
        let provisionalCommit = null;
        try {
          let auditBudget = null;
          if (this.deps.runAudit === runAudit && auditResourceInfo && ((!auditResourceInfo.exempt && !this.isDshAuditProject(project)) || this.experimentIdForProject(project.id))) {
            const mainAuditProvider = this.isDshAuditProject(project) ? 'deepseek' : auditResourceInfo.provider;
            if (this.isDshAuditProject(project)) {
              // DSH CLI 是单次外部审计；保留外层单笔预留。
              auditReservation = assertModelBudget({ config: this.config, store: this.store, provider: mainAuditProvider, model: 'deepseek', estimatedTokens: Number(auditResourceInfo.estimate || 8_000), label: 'Independent Audit', reserve: true, experimentId: this.experimentIdForProject(project.id), experimentScope: this.experimentScopeForProvider(project, mainAuditProvider), experimentRole: 'audit', experimentClient: 'dsh' });
            } else {
              // 分块审计：每个实际分块独立预留，避免外层再记一次。
              auditBudget = { config: this.config, store: this.store, provider: mainAuditProvider, model: auditResourceInfo.model || '', estimatedTokens: Number(auditResourceInfo.estimate || 8_000), experimentId: this.experimentIdForProject(project.id), experimentScope: this.experimentScopeForProvider(project, mainAuditProvider), client: mainAuditProvider, requestKey: `audit:${run.id}:${task.id}:${attemptNo}` };
            }
          }
          const repoFiles = await gitops.listTree(worktree, 'HEAD', { max: 150 });
          const diffStat = await gitops.diffStat(worktree, baseCommit);
          if (this.isDshAuditProject(project)) {
            const provisionalMessage = `feat(task-${task.seq}): ${task.title}\n\nDSH 只读独立审计对象 commit（AI Workbench v2.5）\n测试指纹: ${testedHash}`;
            provisionalCommit = await gitops.commitAll(worktree, provisionalMessage);
            const provisionalTree = (await gitops.git(worktree, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
            if (provisionalCommit.empty || provisionalTree !== testedHash) throw new PolicyError('COMMIT_FINGERPRINT_MISMATCH', 'DSH 预审计 commit 与测试版本不一致');
            auditCommit = provisionalCommit.commit || (await gitops.currentHead(worktree));
            await gitops.updateRef(project.local_path, planBranch, auditCommit);
            this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'audit_commit_created', message: `已创建 DSH 审计绑定 commit ${auditCommit.slice(0, 8)}`, data: { auditCommit, testedHash } });
          }
          audit = await this.deps.runAudit({
            config: this.config, project,
            task: { ...task, acceptance_json: task.acceptance_json },
            diff, diffStat, testResult: lastTest, repoFiles, coderFamily,
            versionInfo: { baseCommit, worktreeHash: testedHash, testedHash },
            worktree, commit: auditCommit,
            signal, budget: auditBudget,
          });
        } catch (err) {
          if (auditReservation?.reservation?.id) this.store.markModelReservationUnknown(auditReservation.reservation.id);
          if (signal.aborted) return { ok: false, reason: '运行被暂停/取消，审计检查点已保留' };
          const message = redact(`独立审计无法完成：${err?.message || err}`, this.config);
          this.writeArtifact({ runId: run.id, taskId: task.id, kind: 'audit-error', filename: `attempt-${attemptNo}-audit-error.txt`, content: message });
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'audit_error', level: 'error', message });
          return this.failTask(run, task, `${message}（不伪造审计结论）`, 'blocked');
        }
        if (auditReservation?.reservation?.id) {
          const au = summarizeUsage(audit.usage || {});
          this.store.settleModelReservation(auditReservation.reservation.id, { actualTokens: au.total, actualCostCny: audit.costCny || 0, usageKnown: !!(audit.usage && au.total > 0) });
        }
        if (signal.aborted) return { ok: false, reason: '运行被暂停/取消，审计检查点已保留' };
        const auditStatus = audit.status || (audit.verdict === 'pass' ? 'PASS' : 'FAIL');
        const auditIdentity = resolveLlmIdentity({ config: this.config, provider: audit.provider });
        const actualAuditProvider = auditIdentity.known ? auditIdentity.provider : 'unknown';
        const auditRow = this.store.createAudit({
          id: newId('aud'), runId: run.id, taskId: task.id, attemptNo,
          provider: actualAuditProvider, providerKnown: auditIdentity.known, providerSource: audit.providerSource || auditIdentity.source, budgetScope: this.isDshAuditProject(project) ? 'project_audit' : 'global', model: audit.model,
          verdict: audit.verdict, score: audit.score,
          criteria: audit.criteria, findings: audit.findings, requiredFixes: audit.requiredFixes,
          summary: audit.summary,
          tokensIn: audit.usage?.input || 0, tokensOut: audit.usage?.output || 0,
          costCny: audit.costCny || 0, rawPath: '',
          verificationStatus: auditStatus, evidenceHash: testedHash,
          diffHash: hashText(diff), independence: audit.independence?.independent ? 'independent' : 'same-family',
        });
        const auditArtifact = this.writeArtifact({
          runId: run.id, taskId: task.id, kind: 'audit', filename: `attempt-${attemptNo}-audit.json`,
          content: {
            provider: audit.provider, providerLabel: audit.providerLabel, model: audit.model,
            status: auditStatus, verdict: audit.verdict, score: audit.score,
            criteria: audit.criteria, findings: audit.findings, requiredFixes: audit.requiredFixes,
            unknownReasons: audit.unknownReasons, independence: audit.independence,
            chunks: audit.chunks, versionInfo: audit.versionInfo, usage: audit.usage, costCny: audit.costCny,
            raw: audit.rawText,
          },
        });
        this.store.addRunUsage(run.id, { tokens: summarizeUsage(audit.usage || {}).total, costCny: audit.costCny || 0 });
        lastAudit = { ...auditRow, artifact: auditArtifact };
        this.emit({
          runId: run.id, projectId: project.id, taskId: task.id,
          type: auditStatus === 'PASS' ? 'audit_passed' : auditStatus === 'UNKNOWN' ? 'audit_unknown' : 'audit_failed',
          level: auditStatus === 'PASS' ? 'info' : 'warn',
          message: auditSummaryText({ ...audit, status: auditStatus }),
          data: {
            provider: audit.provider, model: audit.model, status: auditStatus, verdict: audit.verdict,
            score: audit.score, criteria: audit.criteria, requiredFixes: audit.requiredFixes,
            unknownReasons: audit.unknownReasons, independence: audit.independence,
            chunks: audit.chunks, artifact: auditArtifact,
          },
        });

        if (auditStatus === 'PASS') {
          this.assertProjectLease(project.id);
          // 提交前持久化可恢复意图：即使 Git commit 完成后进程崩溃，也能按 tree/audit 识别并只补账。
          this.store.updateTask(task.id, {
            status: TaskStatus.COMMITTING,
            verification_json: {
              ...(task.verification_json || {}), baseCommit, testedHash, planBranch,
              auditId: auditRow.id, auditStatus, auditProvider: audit.provider, auditModel: audit.model,
              auditScore: audit.score, testCommand: safeCommand, testCode: testRes.code, testStdout: String(testRes.stdout || ''), testStderr: String(testRes.stderr || ''), testArtifactLog: this.artifactAbs(testArtifact), testArtifactSha256, testArtifactBytes: Buffer.byteLength(testArtifactContent), commitIntentAt: nowIso(),
            },
          });
          const commitMessage = [
            `feat(task-${task.seq}): ${task.title}`, '',
            ...(task.acceptance_json || []).map((a) => `- 验收：${a}`), '',
            `审计：${audit.provider}/${audit.model} PASS（得分 ${audit.score}）`,
            `测试：${safeCommand} 通过（指纹 ${testedHash.slice(0, 12)}）`,
            '生成：AI 开发工作台 v2.0',
          ].join('\n');
          let commit;
          if (provisionalCommit) {
            commit = provisionalCommit;
          } else {
            commit = await gitops.commitAll(worktree, commitMessage);
            const committedTree = (await gitops.git(worktree, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
            if (commit.empty || committedTree !== testedHash) {
              return this.failTask(run, task, '提交内容与审计/测试版本不一致（指纹校验失败），拒绝推进', 'blocked', { testedHash, committedTree });
            }
            await gitops.updateRef(project.local_path, planBranch, commit.commit || (await gitops.currentHead(worktree)));
          }
          const headCommit = await gitops.currentHead(worktree);
          this.freezeTestBaseline(project, worktree, { runId: run.id, taskId: task.id, source: 'task_passed', commit: headCommit });
          const verification = {
            baseCommit, testedHash, commit: headCommit, planBranch,
            testCommand: safeCommand, auditId: auditRow.id, auditStatus,
            auditProvider: audit.provider, auditModel: audit.model, auditScore: audit.score,
            independence: audit.independence, attempts: attemptNo, agent: agentId,
            usage: { tokens: usage.total, costCny: agentResult.costCny || 0 },
          };
          this.store.updateTask(task.id, {
            status: TaskStatus.PASSED, head_commit: headCommit,
            verification_json: verification,
            result_json: {
              ...verification,
              testDurationMs: testRes.durationMs,
              testCode: testRes.code,
              testStdout: String(testRes.stdout || ''),
              testStderr: String(testRes.stderr || ''),
              testArtifactLog: this.artifactAbs(testArtifact), testArtifactSha256, testArtifactBytes: Buffer.byteLength(testArtifactContent),
              criteria: audit.criteria,
            },
          });
          this.writeArtifact({ runId: run.id, taskId: task.id, kind: 'commit', filename: 'commit.txt', content: `branch=${planBranch}\ncommit=${headCommit}\ntree=${testedHash}\n\n${commitMessage}` });
          this.emit({
            runId: run.id, projectId: project.id, taskId: task.id, type: 'task_passed',
            message: `任务通过：${task.title}（commit ${String(headCommit).slice(0, 8)}，审计 ${audit.provider} ${auditStatus}）`,
            data: { commit: headCommit, planBranch, agent: agentId, attempts: attemptNo, auditStatus, auditScore: audit.score, testedHash },
          });
          await gitops.removeWorktree(project.local_path, worktree).catch(() => {});
          return { ok: true, commit: headCommit, verification };
        }

        if (auditStatus === 'UNKNOWN') {
          const unknownMsg = (audit.unknownReasons || []).slice(0, 6).join('；') || '证据不足';
          if (attemptNo < maxAttempts && this.config.audit.retryUnknown !== false) {
            feedback = [
              '独立审计结论为 UNKNOWN（证据不足，不能判定通过）。',
              `原因：${unknownMsg}`,
              '请补充能直接证明验收标准的实现/测试/文档证据，不要修改受保护文件。',
              ...(audit.requiredFixes || []).map((f, i) => `${i + 1}. ${f}`),
            ].join('\n');
            this.store.updateTask(task.id, { status: TaskStatus.REPAIRING });
            this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'repair_requested', message: '审计 UNKNOWN，已要求补充可验证证据', data: { unknownReasons: audit.unknownReasons } });
            continue;
          }
          return this.failTask(run, task, `独立审计 UNKNOWN，缺少可验证证据：${unknownMsg}`, 'blocked', { lastAudit: auditRow.id, auditStatus: 'UNKNOWN' });
        }

        feedback = buildAuditFeedback(audit);
        this.store.updateTask(task.id, { status: TaskStatus.REPAIRING });
        this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'repair_requested', message: `审计未通过（${auditStatus}），已把修复要求反馈给 Coding Agent（第 ${attemptNo}/${maxAttempts} 轮）`, data: { requiredFixes: audit.requiredFixes, criteria: audit.criteria } });
        const repeated = this.recordFailure(task, failureSignature({ auditSummary: audit.summary, failedCriteria: (audit.criteria || []).filter((c) => c.status !== 'pass').map((c) => c.criterion) }));
        if (repeated >= 1) return this.failTask(run, task, '检测到重复的审计失败签名，停止无限重试，保留证据等待人工处理', 'blocked', { lastAudit: auditRow.id });
        if (attemptNo >= maxAttempts) {
          return this.failTask(run, task, `超过最大尝试次数（${maxAttempts}），最后一次审计未通过：${(audit.requiredFixes || []).slice(0, 3).join('；') || audit.summary}`, 'failed', { lastAudit: auditRow.id, lastTest });
        }
      }
      return this.failTask(run, task, '尝试次数耗尽，任务未通过测试/审计', 'failed', { lastAudit: lastAudit?.id, lastTest, lastAgent });
    } catch (err) {
      if (err?.code === 'RUN_ABORTED' || signal.aborted) return { ok: false, reason: '运行被暂停/取消' };
      if (err?.code === 'LEASE_LOST') {
        // 不写入任务成功/失败状态；旧执行者已失去项目写权，留给新执行者对账。
        this.projectLeases.delete(project.id);
        return { ok: false, reason: `写租约丢失：${err.message}` };
      }
      const message = redact(`任务执行异常：${err?.message || err}`, this.config);
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'task_error', level: 'error', message });
      return this.failTask(run, task, message, 'blocked');
    }
  }

  freezeTestBaseline(project, worktree, meta = {}) {
    const cfg = project.config_json || {};
    if (cfg.require_real_tests !== true) return cfg.trusted_test_hashes || {};
    // P1-1：永久冻结已有测试；允许新增测试文件。新增文件只有在真实测试/审计通过后
    // 由本函数合并进下一版测试基线，不在第一轮就把整个 tests/** 永久锁死。
    const files = findTestFiles(worktree);
    const hashes = {};
    for (const rel of files) {
      const h = sha256File(path.join(worktree, rel));
      if (h) hashes[rel] = h;
    }
    if (!Object.keys(hashes).length) throw new PolicyError('TEST_FREEZE_EMPTY', '没有可冻结的真实测试文件，不能标记任务通过');
    const runnerConfigs = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'pytest.ini', 'go.mod', 'Cargo.toml', 'vitest.config.js', 'vitest.config.mjs', 'jest.config.js', 'jest.config.mjs', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.ts'];
    for (const rel of runnerConfigs) {
      const h = sha256File(path.join(worktree, rel));
      if (h) hashes[rel] = h;
    }
    const history = Array.isArray(cfg.test_baseline_history) ? [...cfg.test_baseline_history] : [];
    history.push({ at: new Date().toISOString(), ...meta, files: Object.keys(hashes), hashes });
    const broadTestGlobs = new Set(['tests/**', 'test/**', '**/*.test.js', '**/*.test.mjs', '**/*.spec.js', '**/*.spec.mjs']);
    const protectedPaths = [...new Set([...(project.protected_paths || []).filter((p) => !broadTestGlobs.has(String(p))), ...Object.keys(hashes), ...runnerConfigs, 'tests/acceptance/**', '.workbench/**'])];
    const updated = this.updateProject(project.id, {
      protectedPaths,
      config: { ...cfg, trusted_test_hashes: hashes, tests_frozen_at: new Date().toISOString(), test_baseline_history: history.slice(-50), test_baseline_version: history.length },
    });
    project.protected_paths = updated.protected_paths;
    project.config_json = updated.config_json;
    this.emit({ projectId: project.id, type: 'tests_frozen', message: `测试基线已版本化：${Object.keys(hashes).length} 个文件；已有测试只可新增，不可修改`, data: { files: Object.keys(hashes), version: history.length, runId: meta.runId || '', taskId: meta.taskId || '' } });
    return hashes;
  }

  resolveTaskTestCommand(project, task, worktree = '') {
    const projectConfig = project.config_json || {};
    const requireReal = projectConfig.require_real_tests === true;
    const allowed = new Set([project.test_command, ...(projectConfig.allowed_test_commands || [])].map((s) => String(s || '').trim()).filter(Boolean));
    const requested = String(task.test_command || '').trim();
    if (requested && allowed.has(requested)) return requested;
    if (requested) {
      this.emit({ runId: task.run_id, projectId: project.id, taskId: task.id, type: 'test_command_fallback', level: 'warn', message: `任务测试命令未在项目 allowlist 中，已回退到项目默认测试命令：${requested}` });
    }
    if (project.test_command) return project.test_command;
    if (requireReal && worktree) {
      const detected = detectTestCommand(worktree);
      if (!detected) throw new PolicyError('TEST_PLAN_UNRESOLVED', '真实测试计划未建立：项目没有测试命令，Coding Agent 也没有生成可检测的测试框架/脚本；不能宣布通过');
      const updatedProject = this.updateProject(project.id, { testCommand: detected, allowedTestCommands: [detected] });
      project.test_command = updatedProject.test_command;
      project.config_json = updatedProject.config_json;
      this.emit({ runId: task.run_id, projectId: project.id, taskId: task.id, type: 'test_command_detected', message: `按真实技术栈检测到测试命令：${detected}` });
      return detected;
    }
    return project.test_command;
  }

  recordFailure(task, signature) {
    const same = task.failure_signature && task.failure_signature === signature;
    const repeated = same ? Number(task.repeated_failures || 0) + 1 : 0;
    this.store.updateTask(task.id, { failure_signature: signature, repeated_failures: repeated });
    return repeated;
  }

  async ensurePlanBranch(project, planBranch) {
    const existing = await gitops.branchRef(project.local_path, planBranch);
    if (existing) return existing;
    const baseBranch = project.default_branch || (await gitops.resolveDefaultBranch(project.local_path));
    const baseHead = await gitops.currentHead(project.local_path);
    const branchHead = await gitops.branchRef(project.local_path, baseBranch);
    const startPoint = branchHead || baseHead;
    if (!startPoint) throw new PolicyError('REPO_EMPTY', '项目仓库没有任何提交，无法创建工作计划分支');
    await gitops.git(project.local_path, ['branch', planBranch, startPoint]);
    return startPoint;
  }

  failTask(run, task, reason, status = 'failed', extra = {}) {
    const safeReason = redact(reason, this.config);
    this.store.updateTask(task.id, {
      status,
      blocked_reason: safeReason,
      result_json: { ...(task.result_json || {}), ...extra, failureReason: safeReason },
    });
    this.emit({
      runId: run.id,
      projectId: task.project_id,
      taskId: task.id,
      type: 'task_failed',
      level: 'error',
      message: `任务 ${task.seq} 未通过：${safeReason}`,
      data: { seq: task.seq, blocked: status === 'blocked', reason: safeReason },
    });
    return { ok: false, reason: `任务「${task.title}」未通过：${safeReason}` };
  }

  buildCodingPrompt({ project, task, attemptNo, maxAttempts, feedback, worktree, protectedPaths, plan, agentId = 'unknown', permission = {} }) {
    // 带 [hidden] 前缀的验收标准对 Coding Agent 隐藏，用于防止"按标准过拟合"；
    // 审计失败后的修复反馈会揭示未满足项，因此仍可自动修复。
    const visible = (task.acceptance_json || []).filter((a) => !/^\[hidden\]\s*/i.test(String(a)));
    const acceptance = visible.map((a, i) => `${i + 1}. ${a}`).join('\n');
    const hiddenCount = (task.acceptance_json || []).length - visible.length;
    const contractFiles = (project.contract_files || []).slice(0, 5);
    const contractBlocks = [];
    for (const file of contractFiles) {
      try {
        const abs = path.join(worktree, file);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          contractBlocks.push(`### ${file}\n${truncate(fs.readFileSync(abs, 'utf8'), 5000)}`);
        }
      } catch {
        /* ignore */
      }
    }
    const canRunShell = !!permission.allowShell;
    const parts = [
      `你是 AI 开发工作台调度的 Coding Agent。请直接在当前工作副本中实现任务，不要询问澄清问题。`,
      ``,
      `## 项目`,
      `- 名称：${project.name}`,
      `- 工作目录：${worktree}`,
      `- 默认分支：${project.default_branch}`,
      `- 测试命令（由工作台执行）：${project.test_command || '（未配置）'}`,
      `- 受保护路径（禁止修改）：${protectedPaths.join(', ') || '无'}`,
      `- 你的执行权限：${permission.mode || 'restricted'}；${canRunShell ? '允许执行 shell' : '不允许执行 shell / 网络工具，只能编辑文件'}`,
      ``,
      `## 任务 ${task.seq}/${plan ? plan.tasks_json?.length || '?' : '?'}：${task.title}`,
      task.description || '',
      ``,
      `## 验收标准（独立审计员会逐条核对；必须有可核对证据）`,
      acceptance || '（无，按任务描述执行）',
      hiddenCount > 0 ? `（另有 ${hiddenCount} 条隐藏验收标准，由独立审计员核对；请优先保证实现质量、测试覆盖与文档完备性）` : '',
      ``,
      `## 权威契约文件`,
      contractBlocks.length ? contractBlocks.join('\n\n') : '（未配置 contract_files；请阅读仓库 README / AGENTS.md / TASKS.md 等现有契约）',
      ``,
      `## 硬性约束`,
      `1. 只修改当前工作副本内的文件，禁止修改受保护路径（测试/验收/CI/许可证等）。`,
      `2. ${canRunShell ? '可以运行只读验证命令，但不得安装依赖、不得联网、不得调用付费 API。' : '不要调用 bash/shell（受限权限下 shell 不可用），也不要使用网络工具；工作台会在你结束后自动运行测试。'}`,
      `3. 不要执行 git commit / push / merge（工作台统一负责提交、推送与 PR）。`,
      `4. 不要访问生产环境、不要付款、不要合并主分支、不要修改 LIVE 配置。`,
      `5. 使用仓库已有技术栈与代码风格；优先复用现有模块，避免无关重构。`,
      `6. 需要新增测试时，只能新增测试文件，不能修改已有验收测试或降低验收标准。`,
      `7. 完成后用一段话总结修改内容与如何验证。`,
    ];
    if (feedback) {
      parts.push(``, `## 上一轮失败反馈（必须修复，不要重复同样的错误）`, feedback);
    }
    if (attemptNo > 1) {
      parts.push(``, `这是第 ${attemptNo}/${maxAttempts} 轮尝试。请聚焦修复问题，不要重写无关代码。`);
    }
    return parts.filter((p) => p !== undefined && p !== null && p !== '').join('\n');
  }

  // ============================================================
  // 运行收尾、发布、PR、CI
  // ============================================================
  releaseLease(run) {
    try { this.store.clearRunLease(run.id); this.store.releaseProjectLease(run.project_id, this.instanceId); } catch { /* ignore */ }
  }

  contractAcceptanceStatus(project, tasks) {
    const cfg = project?.config_json || {};
    let expected = parseList(cfg.test_plan?.acceptance || cfg.test_plan?.acceptance_json || []);
    // 兼容 v3.0 已创建的项目：acceptance 可能只存在于冻结的 TEST_PLAN.json（config 未回填）。
    if (!expected.length && project?.local_path) {
      try {
        const planFile = path.join(project.local_path, 'TEST_PLAN.json');
        if (fs.existsSync(planFile)) expected = parseList(JSON.parse(fs.readFileSync(planFile, 'utf8')).acceptance);
      } catch { /* ignore */ }
    }
    if (!expected.length) return { required: false, ok: true, missing: [] };
    const norm = (text) => String(text || '').toLowerCase().replace(/[\s，。；：、,.!?！？:;（）()\-—]/g, '');
    const evidence = [];
    for (const task of tasks) {
      if (task.status !== TaskStatus.PASSED) continue;
      const audits = this.store.listAudits(task.id).filter((a) => String(a.verification_status || a.verdict || '').toUpperCase() === 'PASS');
      for (const audit of audits) {
        for (const c of audit.criteria_json || []) {
          if (String(c.status || '').toLowerCase() !== 'pass') continue;
          const text = String(c.evidence || '').trim();
          if (text.length < 12 || /^(无|none|n\/a|unknown|未提供|未验证|-+)$/i.test(text)) continue;
          evidence.push({ criterion: String(c.criterion || ''), evidence: text, taskId: task.id, auditId: audit.id, commit: task.head_commit || '', evidenceHash: audit.evidence_hash || '' });
        }
      }
    }
    const missing = [];
    for (const clause of expected) {
      const n = norm(clause);
      const hit = evidence.find((e) => {
        const c = norm(e.criterion);
        return c && (c.includes(n) || n.includes(c) || (n.length > 8 && c.slice(0, Math.min(c.length, 24)) === n.slice(0, Math.min(n.length, 24))));
      });
      if (!hit) missing.push(clause);
    }
    return { required: true, ok: missing.length === 0, expected, evidence, missing };
  }

  async finalizeRun(run) {
    const project = this.store.getProject(run.project_id);
    const tasks = this.store.listTasks({ planId: run.plan_id });
    const counts = this.store.taskCounts(run.plan_id);
    const allPassed = tasks.length > 0 && tasks.every((t) => t.status === TaskStatus.PASSED);
    if (!allPassed) {
      const failed = tasks.filter((t) => t.status === TaskStatus.FAILED || t.status === TaskStatus.BLOCKED);
      const reason = failed.length
        ? `存在未通过任务：${failed.map((t) => `#${t.seq} ${t.title}`).join('；')}`
        : '任务未全部完成';
      this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason });
      this.emit({ runId: run.id, projectId: run.project_id, type: 'run_paused', level: 'warn', message: reason });
      return;
    }

    // 任务级 Run（Loop 内）只验证当前任务；产品级冻结验收由 Loop 在所有计划任务后执行。
    const loopScoped = !!run.result_json?.loopId;
    const acceptance = this.contractAcceptanceStatus(project, tasks);
    if (!loopScoped && acceptance.required && !acceptance.ok) {
      const resultJson = run.result_json || {};
      const repairs = Number(resultJson.acceptanceRepairCount || 0);
      const maxRepairs = Math.max(1, Math.min(3, Number(project.config_json?.test_plan?.maxAcceptanceRepairs ?? 2)));
      if (repairs < maxRepairs) {
        const missingText = acceptance.missing.join('；');
        const nextSeq = tasks.reduce((m, t) => Math.max(m, Number(t.seq || 0)), 0) + 1;
        this.store.createTasks([{
          id: newId('task'), projectId: project.id, planId: run.plan_id, runId: run.id, seq: nextSeq,
          title: `完成冻结验收条款：${missingText.slice(0, 100)}`,
          description: `自动验收门发现以下必需验收条款缺少 PASS 审计证据：\n${acceptance.missing.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n请修复产品并补充真实测试；不得修改冻结契约/已有测试。`,
          acceptance: acceptance.missing,
          agentKind: 'auto', testCommand: project.test_command || '', status: TaskStatus.QUEUED,
          maxAttempts: Number(project.config_json?.max_attempts || this.config.budget.maxAttempts || 2),
        }]);
        this.store.updateRun(run.id, { status: RunStatus.RUNNING, stop_reason: '', pause_kind: '', current_task_id: '', result_json: { ...resultJson, acceptanceRepairCount: repairs + 1, acceptanceMissing: acceptance.missing } });
        this.emit({ runId: run.id, projectId: project.id, type: 'acceptance_repair_queued', message: `冻结验收条款缺少证据，已自动生成修复任务（${repairs + 1}/${maxRepairs}）：${missingText.slice(0, 500)}`, data: { missing: acceptance.missing } });
        return { continue: true };
      }
      const reason = `冻结验收条款未完成（${acceptance.missing.length} 项缺少真实测试/独立审计 PASS 证据）：${acceptance.missing.join('；').slice(0, 1000)}`;
      this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason, pause_kind: 'acceptance_incomplete', result_json: { ...resultJson, acceptanceMissing: acceptance.missing } });
      this.emit({ runId: run.id, projectId: project.id, type: 'acceptance_blocked', level: 'warn', message: reason, data: { missing: acceptance.missing } });
      return;
    }

    const planBranch = `wb/plan-${run.id.slice(-6)}`;
    const planHead = await gitops.branchRef(project.local_path, planBranch);
    if (!planHead) {
      this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: '计划分支不存在，无法绑定验证 commit' });
      this.emit({ runId: run.id, type: 'run_paused', level: 'error', message: '计划分支不存在，无法绑定验证 commit' });
      return;
    }

    const projectConfig = project.config_json || {};
    const productAccepted = !loopScoped || String(run.result_json?.productAcceptance || '').toUpperCase() === 'PASS';
    // Loop 中间 Run 只保留本地提交/验证；最终产品终审 PASS 后由 publishAcceptedRun 统一发布。
    const wantRemote = productAccepted && project.remote_push_authorized === 1 && projectConfig.publish !== false;
    const ciRequired = project.ci_required === 1 && wantRemote;
    let publish = { blocked: [], pr: null, localOnly: true, planBranch, planHead, ci: null };
    if (wantRemote || (projectConfig.publish !== false && this.config.github.token && project.remote_push_authorized === 1)) {
      publish = await this.publishRun(run, project, planBranch, planHead, tasks);
    } else if (!wantRemote) {
      const reason = loopScoped && !productAccepted ? '等待产品终审 PASS 后再执行远端发布（中间 Run 不推送）' : project.remote_push_authorized !== 1 ? '项目未授权远端推送（remote_push_authorized=false），不创建 GitHub PR' : '项目配置关闭远端发布';
      publish.blocked.push(reason);
      this.store.createAction({ id: newId('act'), runId: run.id, type: 'github-publish', status: 'blocked', payload: { planBranch, planHead, reason }, result: { reason } });
      this.emit({ runId: run.id, projectId: run.project_id, type: 'publish_blocked', level: 'warn', message: reason, data: { planBranch, planHead } });
    }

    let verification;
    if (!ciRequired) {
      verification = {
        status: 'LOCAL_VERIFIED',
        note: `本地验证完成并绑定 commit ${planHead.slice(0, 8)}；项目未要求远端 CI${publish.blocked.length ? `（远端动作：${publish.blocked.join('；')}）` : ''}`,
      };
    } else {
      const ci = publish.ci || { status: 'pending', conclusion: null, sha: planHead };
      verification = verificationState({
        ciRequired: true,
        ciStatus: ci.status,
        ciConclusion: ci.conclusion,
        ciSha: ci.sha || planHead,
        verifiedSha: planHead,
      });
      verification.ci = ci;
    }

    const result = {
      planBranch,
      planHead,
      verifiedSha: planHead,
      loopId: run.result_json?.loopId || '',
      taskLevelOnly: !!loopScoped,
      verificationStatus: verification.status,
      verificationNote: verification.note,
      taskCount: tasks.length,
      counts,
      publish,
      ci: publish.ci || null,
      budget: this.budget(),
      audit: auditProviderStatus(this.config),
    };

    if (ciRequired && verification.status !== 'CI_PASSED') {
      const reason = `远端交付闸门未通过：${verification.status} — ${verification.note}`;
      this.store.updateRun(run.id, {
        status: RunStatus.PAUSED,
        current_task_id: '',
        result_json: result,
        verification_status: verification.status,
        verified_sha: planHead,
        ci_status: publish.ci?.status || '',
        ci_url: publish.ci?.htmlUrl || '',
        ci_checked_at: nowIso(),
        stop_reason: reason,
      });
      this.store.createApproval({
        id: newId('appr'),
        runId: run.id,
        taskId: '',
        type: 'ci_gate',
        status: 'pending',
        title: `CI 闸门未通过：${verification.status}`,
        details: { planHead, verification, publish, note: '人工检查 CI 后决定重试/放弃' },
      });
      this.emit({ runId: run.id, projectId: run.project_id, type: 'ci_gate_blocked', level: 'warn', message: reason, data: { result } });
      return;
    }

    this.store.updateRun(run.id, {
      status: RunStatus.AWAITING_ACCEPTANCE,
      current_task_id: '',
      result_json: result,
      verification_status: verification.status,
      verified_sha: planHead,
      ci_status: publish.ci?.status || '',
      ci_url: publish.ci?.htmlUrl || '',
      ci_checked_at: nowIso(),
      ended_at: nowIso(),
      stop_reason: publish.blocked.length ? `部分发布动作待授权：${publish.blocked.join('；')}` : '',
    });
    if (!loopScoped) {
      const exp = this.store.getExperimentForProject?.(run.project_id);
      if (exp) this.store.endExperiment?.(exp.id, 'completed', '产品级验收 PASS，终止新增付费调用');
    }
    this.emit({
      runId: run.id,
      projectId: run.project_id,
      type: 'run_awaiting_acceptance',
      message: publish.pr?.url
        ? `全部 ${tasks.length} 个任务通过（${verification.status}）并已创建 PR：${publish.pr.url}`
        : `全部 ${tasks.length} 个任务通过（${verification.status}），等待你验收`,
      data: result,
    });
  }

  async waitForCi(owner, repo, sha) {
    const attempts = Number(this.config.policy.ciPollAttempts || 12);
    const interval = Number(this.config.policy.ciPollIntervalMs || 10_000);
    let last = { status: 'pending', conclusion: null, runs: [], sha };
    for (let i = 0; i < attempts; i++) {
      try {
        const runs = await gh.listWorkflowRunsForSha(this.config, owner, repo, sha);
        if (runs.length) {
          const finished = runs.every((r) => r.status === 'completed');
          const conclusion = finished
            ? runs.every((r) => r.conclusion === 'success') ? 'success' : 'failure'
            : 'pending';
          last = {
            status: finished ? (conclusion === 'success' ? 'passed' : 'failed') : 'pending',
            conclusion: finished ? conclusion : null,
            runs,
            sha,
            htmlUrl: runs[0]?.htmlUrl || '',
            checkedAt: nowIso(),
          };
        }
      } catch (err) {
        last = { status: 'pending', conclusion: null, runs: [], sha, error: redact(err.message, this.config) };
      }
      if (last.status !== 'pending') return last;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, interval));
    }
    return last;
  }

  async publishAcceptedRun(run, project, planHead, tasks = []) {
    const latest = this.store.getRun(run.id) || run;
    if (!latest || !planHead) return { blocked: ['缺少最终 SHA'], pr: null, localOnly: true, ci: null };
    if (String(this.store.getRun(run.id)?.result_json?.productAcceptance || '').toUpperCase() !== 'PASS') {
      return { blocked: ['产品终审尚未 PASS，拒绝远端发布'], pr: null, localOnly: true, ci: null };
    }
    const planBranch = `wb/plan-${run.id.slice(-6)}`;
    const projectTasks = tasks.length ? tasks : this.store.listTasks({ runId: run.id });
    const publish = await this.publishRun(latest, project, planBranch, planHead, projectTasks);
    const after = this.store.getRun(run.id);
    const next = this.store.getRun(run.id);
    this.store.updateRun(run.id, {
      result_json: { ...(after.result_json || {}), publish, ci: publish.ci || null, publishedAfterAcceptance: true, publishedAt: nowIso() },
      ci_status: publish.ci?.status || (next?.ci_status || ''),
      ci_url: publish.ci?.htmlUrl || (next?.ci_url || ''),
      verified_sha: planHead,
    });
    this.emit({ runId: run.id, projectId: project.id, type: 'post_acceptance_publish', message: publish.pr?.url ? `产品终审 PASS 后已创建 Draft PR：${publish.pr.url}` : '产品终审 PASS 后的远端发布已处理', data: { publish } });
    return publish;
  }

  async publishRun(run, project, planBranch, planHead, tasks) {
    const actions = [];
    const blocked = [];
    const ownerRepo = parseGithubRemote(await gitops.remoteUrl(project.local_path)) || null;
    const projectConfig = project.config_json || {};
    const canPush = !!this.config.github.token && this.config.policy.autoPush && this.config.github.push && projectConfig.publish !== false;
    if (!canPush) {
      const reason = !this.config.github.token
        ? '缺少 GITHUB_TOKEN，推送分支与创建 PR 需要你授权'
        : '策略已关闭自动推送';
      this.store.createAction({ id: newId('act'), runId: run.id, type: 'github-publish', status: 'blocked', payload: { planBranch, planHead, reason }, result: { reason } });
      blocked.push(reason);
      this.emit({ runId: run.id, projectId: project.id, type: 'publish_blocked', level: 'warn', message: reason, data: { planBranch } });
      return { actions, blocked, pr: null, localOnly: true, planBranch, planHead, ci: null };
    }

    let owner = ownerRepo?.owner || '';
    let repo = ownerRepo?.repo || '';
    try {
      if (!owner || !repo) {
        if (!this.config.github.autoCreateRepo) throw new Error('项目未配置远端仓库，且策略禁止自动创建 GitHub 仓库');
        const created = await gh.ensureRepo(this.config, {
          name: `${this.config.github.repoPrefix}${slugForRepo(project.name)}`,
          private: true,
          description: `AI 开发工作台：${project.name}`,
        });
        owner = created.owner;
        repo = created.repo;
        await gitops.addRemote(project.local_path, 'origin', gh.remoteUrlFor(this.config, owner, repo));
        const defaultBranch = project.default_branch || 'main';
        if (await gitops.branchRef(project.local_path, defaultBranch)) {
          await gitops.pushBranch(this.config, project.local_path, defaultBranch, { logPath: path.join(this.logsDir(run.id), 'push-main.log') });
        }
      }
      const pushAction = this.store.createAction({ id: newId('act'), runId: run.id, type: 'github-push', status: 'running', payload: { owner, repo, planBranch, sha: planHead } });
      await gitops.pushBranch(this.config, project.local_path, planBranch, { logPath: path.join(this.logsDir(run.id), 'push-plan.log') });
      this.store.updateAction(pushAction.id, { status: 'done', result: { owner, repo, planBranch, sha: planHead, pushedAt: nowIso() } });
      actions.push(this.store.getAction(pushAction.id));
      this.emit({ runId: run.id, projectId: project.id, type: 'branch_pushed', message: `已推送分支 ${planBranch}（${planHead.slice(0, 8)}）到 GitHub`, data: { owner, repo, planBranch, sha: planHead } });

      let pr = null;
      const baseBranch = (await gh.getRepo(this.config, owner, repo))?.default_branch || project.default_branch || 'main';
      const prAction = this.store.createAction({ id: newId('act'), runId: run.id, type: 'github-pr', status: 'running', payload: { owner, repo, head: planBranch, sha: planHead } });
      const plan = this.store.getPlan(run.plan_id);
      pr = await gh.createPullRequest(this.config, {
        owner, repo,
        title: `[AI Workbench] ${plan?.title || run.goal} (${tasks.length} 个任务, ${planHead.slice(0, 8)})`,
        head: planBranch,
        base: baseBranch,
        body: this.buildPrBody(run, project, tasks, planHead),
        draft: true,
      });
      this.store.updateAction(prAction.id, { status: 'done', result: { pr, sha: planHead } });
      actions.push(this.store.getAction(prAction.id));
      this.emit({ runId: run.id, projectId: project.id, type: 'pr_created', message: `已创建草稿 PR #${pr.number}（未合并）：${pr.url}`, data: pr });

      const ci = await this.waitForCi(owner, repo, planHead);
      const ciAction = this.store.createAction({ id: newId('act'), runId: run.id, type: 'github-ci', status: ci.status === 'pending' ? 'pending' : 'done', payload: { owner, repo, sha: planHead, planBranch }, result: ci });
      actions.push(this.store.getAction(ciAction.id));
      this.emit({
        runId: run.id, projectId: project.id, type: 'ci_update',
        level: ci.status === 'failed' ? 'warn' : 'info',
        message: `GitHub Actions：${ci.status === 'passed' ? '通过' : ci.status === 'failed' ? '失败' : '仍在运行/超时'}`,
        data: { ci },
      });
      return { actions, blocked, pr, localOnly: false, owner, repo, planBranch, planHead, ci };
    } catch (err) {
      const reason = redact(`GitHub 发布失败：${err?.message || err}`, this.config);
      this.store.createAction({ id: newId('act'), runId: run.id, type: 'github-publish', status: 'blocked', payload: { planBranch, planHead, owner, repo }, result: { reason } });
      blocked.push(reason);
      this.emit({ runId: run.id, projectId: project.id, type: 'publish_blocked', level: 'warn', message: reason });
      return { actions, blocked, pr: null, localOnly: true, planBranch, planHead, ci: null };
    }
  }

  async pollCi(run, actionId, owner, repo, sha, attempt) {
    const max = this.config.policy.ciPollAttempts || 6;
    const interval = this.config.policy.ciPollIntervalMs || 10_000;
    if (attempt >= max) {
      this.store.updateAction(actionId, {
        status: 'timeout',
        result: { note: 'CI 状态轮询超时，可在界面手动刷新' },
      });
      return;
    }
    let runs = [];
    try {
      runs = await gh.listWorkflowRunsForSha(this.config, owner, repo, sha);
    } catch (err) {
      this.store.updateAction(actionId, { status: 'error', result: { error: err.message } });
      return;
    }
    if (runs.length === 0) {
      await new Promise((r) => setTimeout(r, interval));
      return this.pollCi(run, actionId, owner, repo, sha, attempt + 1);
    }
    const finished = runs.every((r) => r.status === 'completed');
    const conclusion = finished
      ? runs.every((r) => r.conclusion === 'success')
        ? 'success'
        : 'failure'
      : 'in_progress';
    this.store.updateAction(actionId, {
      status: finished ? 'done' : 'running',
      result: { conclusion, runs, checkedAt: nowIso() },
    });
    this.emit({
      runId: run.id,
      type: 'ci_update',
      level: conclusion === 'failure' ? 'warn' : 'info',
      message: `GitHub Actions：${conclusion === 'success' ? '通过' : conclusion === 'failure' ? '失败' : '运行中'}`,
      data: { conclusion, runs: runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, htmlUrl: r.htmlUrl })) },
    });
    if (!finished && attempt + 1 < max) {
      await new Promise((r) => setTimeout(r, interval));
      return this.pollCi(run, actionId, owner, repo, sha, attempt + 1);
    }
  }

  async refreshCi(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    const actions = this.store.listActions(runId);
    const ci = actions.find((a) => a.type === 'github-ci');
    if (!ci) return { ok: false, message: '该运行没有 CI 记录（可能未推送 GitHub）' };
    const { owner, repo, sha } = ci.payload_json || {};
    const runs = await gh.listWorkflowRunsForSha(this.config, owner, repo, sha);
    const finished = runs.length > 0 && runs.every((r) => r.status === 'completed');
    const conclusion = finished ? (runs.every((r) => r.conclusion === 'success') ? 'success' : 'failure') : runs.length ? 'in_progress' : 'queued';
    this.store.updateAction(ci.id, { status: finished ? 'done' : 'running', result: { conclusion, runs, checkedAt: nowIso() } });
    this.emit({ runId, type: 'ci_update', message: `GitHub Actions 状态刷新：${conclusion}`, data: { conclusion } });
    return { ok: true, conclusion, runs };
  }

  buildPrBody(run, project, tasks, planHead = '') {
    const audits = [];
    for (const t of tasks) {
      const list = this.store.listAudits(t.id);
      const last = list[list.length - 1];
      audits.push(
        `- **#${t.seq} ${t.title}** — 测试通过；审计 ${last ? `${last.provider}/${last.model} ${last.verdict === 'pass' ? '通过' : '未通过'}（${last.score}）` : '无记录'}；commit \`${String(t.head_commit || '').slice(0, 8)}\``,
      );
    }
    const budget = this.budget();
    return [
      `## AI 开发工作台自动开发结果`,
      ``,
      `**目标**：${run.goal}`,
      `**项目**：${project.name}`,
      `**任务数**：${tasks.length}`,
      `**验证 Commit**：\`${planHead}\`（CI/审计绑定此 SHA）`,
      ``,
      `### 任务与独立审计`,
      ...audits,
      ``,
      `### 质量门禁`,
      `- 每个任务均运行项目测试命令并通过`,
      `- 每个任务均通过独立模型审计（逐条验收标准核对）`,
      `- 测试/验收文件受保护，Agent 无法通过修改测试来"通过"`,
      `- 工作台不执行合并，本 PR 需人工验收后由你决定是否合并`,
      ``,
      `### 预算消耗`,
      `- tokens：${budget.usedTokens} / ${budget.maxTokens}`,
      `- 估算成本：¥${budget.usedCostCny.toFixed(2)} / ¥${budget.maxCostCny}`,
      ``,
      `> 本 PR 由 AI 开发工作台自动生成（draft），请人工复核。`,
    ].join('\n');
  }

  // ============================================================
  // 运行控制
  // ============================================================
  /** 控制 API 的写所有权：已有租约必须匹配；无有效 owner 时原子获取；其他 owner 拒绝。 */
  ensureControlLease(projectId) {
    const own = this.projectLeases.get(projectId);
    if (own) { this.assertProjectLease(projectId); return own; }
    const row = this.store.getProjectLease(projectId);
    const now = new Date().toISOString();
    if (row?.write_owner && row.lease_expires_at && row.lease_expires_at > now) {
      throw new PolicyError('PROJECT_LEASE_HELD', `项目写租约由其他执行者持有（${row.write_owner}，fence=${row.lease_fence}），拒绝控制写入`);
    }
    const acquired = this.store.acquireProjectLeaseFenced(projectId, this.instanceId, 30 * 60 * 1000);
    if (!acquired.ok) throw new PolicyError('PROJECT_LEASE_HELD', `无法取得控制写租约：${acquired.reason || '其他执行者持有'}`);
    const lease = { owner: this.instanceId, fence: acquired.fence };
    this.projectLeases.set(projectId, lease);
    return lease;
  }

  async waitForRunStop(runId, timeoutMs = 60_000) {
    const started = Date.now();
    while (this.running.has(runId)) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  }

  async pauseRun(runId, reason, kind = 'manual') {
    const run = this.store.getRun(runId);
    if (!run) return null;
    // 幂等：已暂停/中断不重复写、不重复 aborted
    if ([RunStatus.PAUSED, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.AWAITING_ACCEPTANCE, RunStatus.ACCEPTED].includes(run.status)) {
      return run;
    }
    this.ensureControlLease(run.project_id);
    const controller = this.controllers.get(runId);
    const active = !!controller || this.running.has(runId);
    if (controller) controller.abort();
    if (active) {
      const stopped = await this.waitForRunStop(runId, Number(this.config.policy?.pauseTimeoutMs || 60_000));
      if (!stopped) {
        throw new PolicyError('PAUSE_TIMEOUT', `运行 ${runId} 在超时内未真正停止 Agent/任务；保持 running，不显示已暂停`);
      }
    }
    const latest = this.store.getRun(runId);
    if (!latest) return null;
    if ([RunStatus.PAUSED, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.AWAITING_ACCEPTANCE].includes(latest.status)) {
      return latest;
    }
    const reasonText = redact(reason || '已暂停', this.config);
    const stopped = this.store.updateRun(runId, {
      status: RunStatus.PAUSED,
      stop_reason: reasonText,
      pause_kind: kind,
    });
    this.emit({
      runId,
      projectId: run.project_id,
      type: 'run_paused',
      level: kind === 'manual' ? 'info' : 'warn',
      message: `运行已暂停：${reasonText}`,
      data: { kind, agentStopped: active },
    });
    if (!active) this.releaseProjectLease(run.project_id);
    return stopped;
  }

  async saveWorktreeCheckpoint({ run, task, project, worktree }) {
    if (!worktree) return null;
    let st;
    try { st = fs.statSync(worktree); } catch { return task.verification_json?.checkpoint || null; }
    if (!st.isDirectory()) return task.verification_json?.checkpoint || null;
    const base = path.join(this.config.paths.dataDir, 'checkpoints', run.id, task.id);
    const tmpDir = path.join(base, `.tmp-${Date.now().toString(36)}`);
    const finalDir = path.join(base, `checkpoint-${Date.now().toString(36)}`);
    ensureDir(tmpDir);
    const manifest = [];
    const rootResolved = path.resolve(worktree);
    const walk = (dir, rel = '') => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.workbench') continue;
        const abs = path.join(dir, ent.name); const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) { walk(abs, r); continue; }
        const stEntry = fs.lstatSync(abs);
        if (stEntry.isSymbolicLink()) {
          const link = fs.readlinkSync(abs);
          const resolved = path.resolve(path.dirname(abs), link);
          if (path.isAbsolute(link) || !(resolved === rootResolved || resolved.startsWith(rootResolved + path.sep))) {
            throw new PolicyError('CHECKPOINT_SYMLINK_UNSAFE', `检查点拒绝越界符号链接：${r} -> ${link}`);
          }
          manifest.push({ type: 'symlink', path: r, target: link, mode: stEntry.mode & 0o777 });
          continue;
        }
        if (!stEntry.isFile()) continue;
        const buf = fs.readFileSync(abs);
        manifest.push({ type: 'file', path: r, size: buf.length, mode: stEntry.mode & 0o777, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        fs.mkdirSync(path.dirname(path.join(tmpDir, r)), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, r), buf, { mode: stEntry.mode & 0o777 });
      }
    };
    try { walk(worktree); } catch (err) { fs.rmSync(tmpDir, { recursive: true, force: true }); throw err instanceof PolicyError ? err : new PolicyError('CHECKPOINT_CAPTURE_FAILED', `工作副本检查点保存失败：${err.message}`); }
    let head = ''; let tree = ''; let branch = task.branch || ''; let indexTree = '';
    try { head = await gitops.currentHead(worktree); tree = (await gitops.git(worktree, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim(); branch = (await gitops.git(worktree, ['branch', '--show-current'], { allowFail: true })).stdout.trim() || branch; } catch { /* best effort */ }
    try { indexTree = (await gitops.git(worktree, ['write-tree'], { allowFail: true })).stdout.trim(); } catch { /* best effort */ }
    const meta = { version: 2, runId: run.id, taskId: task.id, projectId: project.id, attempt: task.attempt || 0, sessionId: task.session_id || '', branch, head, tree, indexTree, worktree, files: manifest.length, manifestHash: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), createdAt: nowIso() };
    fs.writeFileSync(path.join(tmpDir, 'checkpoint.json'), JSON.stringify({ ...meta, manifest }, null, 2));
    fs.renameSync(tmpDir, finalDir);
    return { ...meta, archive: finalDir, manifestFile: path.join(finalDir, 'checkpoint.json') };
  }

  async checkpointPause(state) {
    if (process.env.CHECKPOINT_TEST_PAUSE_STATE !== String(state)) return;
    const marker = process.env.CHECKPOINT_TEST_MARKER || '';
    if (marker) fs.writeFileSync(marker, String(state));
    await new Promise(() => {});
  }

  async verifyAndRestoreCheckpoint(meta, targetWorktree) {
    if (!meta?.archive || !fs.existsSync(meta.manifestFile)) throw new PolicyError('CHECKPOINT_MISSING', '恢复检查点不存在');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(meta.manifestFile, 'utf8')); } catch { throw new PolicyError('CHECKPOINT_CORRUPT', '检查点 manifest 无法解析'); }
    if (!Array.isArray(parsed.manifest) || parsed.manifest.length > 5000) throw new PolicyError('CHECKPOINT_CORRUPT', '检查点 manifest 结构非法');
    const manifestHash = crypto.createHash('sha256').update(JSON.stringify(parsed.manifest)).digest('hex');
    if (manifestHash !== meta.manifestHash) throw new PolicyError('CHECKPOINT_CORRUPT', '检查点 manifest 哈希不匹配');

    const target = path.resolve(targetWorktree);
    const parent = path.dirname(target);
    ensureDir(parent);
    const parentReal = fs.realpathSync(parent);
    // macOS /var、/tmp 是系统别名；除这些已知别名外，目标父目录链中的符号链接一律拒绝。
    let normalizedParent = parent;
    // 仅修正 macOS 已知系统别名；Linux 的 /tmp 是真实目录，不能盲目替换。
    if (parentReal.startsWith('/private/var/') && parent.startsWith('/var/')) normalizedParent = parent.replace(/^\/var\//, '/private/var/');
    else if (parentReal.startsWith('/private/tmp/') && parent.startsWith('/tmp/')) normalizedParent = parent.replace(/^\/tmp\//, '/private/tmp/');
    if (parentReal !== normalizedParent) throw new PolicyError('CHECKPOINT_TARGET_PARENT_SYMLINK', `目标父目录包含符号链接：${parent} -> ${parentReal}`);
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new PolicyError('CHECKPOINT_TARGET_SYMLINK', `目标 Worktree 本身是符号链接：${target}`); } catch (err) { if (err?.code !== 'ENOENT') throw err; }

    // 所有恢复先写入同文件系统临时目录，验证成功后再整体替换；失败不触碰现有 Worktree。
    const staging = fs.mkdtempSync(path.join(parentReal, '.wb-restore-'));
    let backup = '';
    const safeStagePath = (rel) => {
      const norm = String(rel || '').replaceAll('\\', '/');
      if (!norm || path.isAbsolute(norm) || norm.split('/').includes('..') || norm.includes('\0') || norm === '.git' || norm.startsWith('.git/')) throw new PolicyError('CHECKPOINT_PATH_TRAVERSAL', `检查点路径非法：${rel}`);
      const dest = path.resolve(staging, norm);
      if (!dest.startsWith(staging + path.sep)) throw new PolicyError('CHECKPOINT_PATH_TRAVERSAL', `检查点路径越界：${rel}`);
      return dest;
    };
    try {
      for (const f of parsed.manifest) {
        if (!f || !['file', 'symlink'].includes(String(f.type))) throw new PolicyError('CHECKPOINT_CORRUPT', `检查点条目类型非法：${f?.path}`);
        const dest = safeStagePath(f.path);
        if (f.type === 'symlink') {
          const linkTarget = String(f.target || '');
          const resolved = path.resolve(path.dirname(dest), linkTarget);
          if (path.isAbsolute(linkTarget) || !(resolved === staging || resolved.startsWith(staging + path.sep))) throw new PolicyError('CHECKPOINT_SYMLINK_UNSAFE', `符号链接越界：${f.path} -> ${linkTarget}`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.symlinkSync(linkTarget, dest);
          continue;
        }
        const src = path.join(meta.archive, f.path);
        const buf = fs.readFileSync(src);
        if (Number(f.size) >= 0 && buf.length !== Number(f.size)) throw new PolicyError('CHECKPOINT_CORRUPT', `检查点大小不匹配：${f.path}`);
        if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) throw new PolicyError('CHECKPOINT_CORRUPT', `检查点文件哈希不匹配：${f.path}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf, { mode: f.mode || 0o644 });
        if (f.mode) try { fs.chmodSync(dest, f.mode); } catch { /* ignore */ }
      }
      // 只复制 Worktree 的 .git 文件（不是目录）；.git 目录目标拒绝整体替换，避免丢仓库元数据。
      const gitEntry = path.join(target, '.git');
      let gitDir = ''; let stagingIndex = ''; let indexTarget = '';
      if (fs.existsSync(gitEntry)) {
        const stEntry = fs.lstatSync(gitEntry);
        if (stEntry.isDirectory()) throw new PolicyError('CHECKPOINT_TARGET_GIT_UNSUPPORTED', '目标 Worktree 的 .git 是目录，拒绝整体恢复');
        if (stEntry.isSymbolicLink()) throw new PolicyError('CHECKPOINT_TARGET_SYMLINK', '目标 .git 是符号链接，拒绝恢复');
        const gitFileText = fs.readFileSync(gitEntry, 'utf8');
        const m = gitFileText.match(/^gitdir:\s*(.+)$/m);
        if (!m) throw new PolicyError('CHECKPOINT_TARGET_GIT_INVALID', '目标 .git 文件缺少 gitdir');
        gitDir = path.resolve(path.dirname(target), m[1].trim());
        stagingIndex = path.join(parentReal, `.wb-index-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
        indexTarget = path.join(gitDir, 'index');
        fs.copyFileSync(gitEntry, path.join(staging, '.git'));
      }
      if (parsed.indexTree && stagingIndex) {
        // 独立 index：绝不能通过共享 .git 指针提前改写真实 Worktree 的 index。
        const idx = await gitops.git(staging, ['read-tree', parsed.indexTree], { allowFail: true, env: { GIT_INDEX_FILE: stagingIndex } });
        if (idx.code !== 0) throw new PolicyError('CHECKPOINT_INDEX_RESTORE_FAILED', `Git index 恢复失败：${idx.stderr || idx.stdout}`);
      }
      const journalDir = path.join(this.config.paths.dataDir, 'checkpoints', '.publish');
      ensureDir(journalDir);
      const journalFile = path.join(journalDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
      const journal = { target, staging, backup: '', state: 'prepared', stagingIndex, indexTarget, indexTree: parsed.indexTree || '', manifest: parsed.manifest, at: nowIso() };
      const writeJournal = (state) => { journal.state = state; fs.writeFileSync(journalFile, JSON.stringify(journal), { mode: 0o600 }); };
      writeJournal('prepared');
      await this.checkpointPause('prepared');
      if (fs.existsSync(target)) {
        backup = `${target}.backup-${Date.now().toString(36)}`;
        journal.backup = backup; writeJournal('backing-up');
        fs.renameSync(target, backup);
        writeJournal('backed-up');
        await this.checkpointPause('backed-up');
      }
      try { fs.renameSync(staging, target); await this.checkpointPause('renamed'); writeJournal('published'); await this.checkpointPause('published'); } catch (err) { if (backup && !fs.existsSync(target)) fs.renameSync(backup, target); try { fs.rmSync(journalFile, { force: true }); } catch { /* ignore */ } throw err; }
      if (stagingIndex && indexTarget) {
        try {
          fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
          fs.copyFileSync(stagingIndex, indexTarget);
          fs.rmSync(stagingIndex, { force: true });
        } catch (err) {
          throw new PolicyError('CHECKPOINT_INDEX_PUBLISH_FAILED', `真实 Index 发布失败：${err.message}`);
        }
      }
      if (backup) fs.rmSync(backup, { recursive: true, force: true });
      try { fs.rmSync(journalFile, { force: true }); } catch { /* ignore */ }
      return { files: parsed.manifest.length, manifestHash, indexTree: parsed.indexTree || '' };
    } catch (err) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
      try { if (backup && fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target); } catch { /* ignore */ }
      throw err;
    }
  }

  recoverCheckpointPublications() {
    const dir = path.join(this.config.paths.dataDir, 'checkpoints', '.publish');
    if (!fs.existsSync(dir)) return { recovered: [], blocked: [] };
    const recovered = []; const blocked = [];
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const file = path.join(dir, name);
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { blocked.push({ file, reason: 'journal-corrupt' }); continue; }
      const target = path.resolve(String(j.target || '')); const staging = path.resolve(String(j.staging || '')); const backup = j.backup ? path.resolve(String(j.backup)) : '';
      try {
        if (!target || !staging) throw new Error('journal-paths-missing');
        const stagingIndex = j.stagingIndex ? path.resolve(String(j.stagingIndex)) : '';
        const indexTarget = j.indexTarget ? path.resolve(String(j.indexTarget)) : '';
        const diskMatchesManifest = () => {
          if (!Array.isArray(j.manifest) || !j.manifest.length) return false;
          try {
            for (const f of j.manifest) {
              if (!f || !f.path) return false;
              const dest = path.resolve(target, String(f.path));
              if (!dest.startsWith(target + path.sep)) return false;
              if (f.type === 'symlink') {
                if (!fs.lstatSync(dest).isSymbolicLink()) return false;
                if (fs.readlinkSync(dest) !== String(f.target || '')) return false;
              } else {
                const st = fs.lstatSync(dest);
                if (!st.isFile() || st.size !== Number(f.size)) return false;
                const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
                if (hash !== f.sha256) return false;
              }
            }
            return true;
          } catch { return false; }
        };
        const diskTree = () => {
          if (!j.indexTree || !indexTarget) return '';
          const tmpIndex = path.join(path.dirname(target), `.wb-recover-index-${process.pid}-${Date.now().toString(36)}`);
          try {
            const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
            const add = spawnSync('git', ['-C', target, 'add', '-A'], { env, encoding: 'utf8' });
            if (add.status !== 0) return '';
            const wt = spawnSync('git', ['-C', target, 'write-tree'], { env, encoding: 'utf8' });
            return wt.status === 0 ? wt.stdout.trim() : '';
          } finally { try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ } }
        };
        if (fs.existsSync(target)) {
          // 原目标仍在：staging 未发布，删除临时目录/独立 index，保留原目标。
          if (staging !== target && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
          // 关键窗口：staging 已改名为 target（磁盘新版），但日志仍 backed-up、真实 Index 仍旧版。
          const diskIsNew = diskMatchesManifest() || (j.indexTree && diskTree() === j.indexTree);
          if (diskIsNew && (!stagingIndex || !fs.existsSync(stagingIndex) || !indexTarget)) {
            // 无法重建应恢复的 staged Index：必须保留磁盘、备份和 journal，交由人工/后续恢复，不能报成功。
            blocked.push({ file, reason: 'published-disk-but-index-source-missing', state: j.state });
            continue;
          }
          const newDiskPendingIndex = diskIsNew && stagingIndex && fs.existsSync(stagingIndex) && indexTarget;
          if (newDiskPendingIndex) {
            fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
            fs.copyFileSync(stagingIndex, indexTarget);
            fs.rmSync(stagingIndex, { force: true });
            if (backup && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
            recovered.push({ file, result: 'completed-index-after-rename', state: j.state, target });
            fs.rmSync(file, { force: true });
            continue;
          }
          if (stagingIndex && fs.existsSync(stagingIndex) && j.state !== 'published') fs.rmSync(stagingIndex, { force: true });
          if (j.state === 'published' && stagingIndex && indexTarget && fs.existsSync(stagingIndex)) {
            fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
            fs.copyFileSync(stagingIndex, indexTarget);
            fs.rmSync(stagingIndex, { force: true });
          }
          if (backup && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
          recovered.push({ file, result: 'kept-existing-target', state: j.state, target });
        } else if (stagingIndex && j.indexTree && !fs.existsSync(stagingIndex)) {
          // backed-up 后目标已不存在、暂存 index 副本丢失：不能只发布磁盘 C 而留下旧 index A。
          blocked.push({ file, reason: 'backed-up-index-source-missing', state: j.state });
          continue;
        } else if (fs.existsSync(staging)) {
          fs.renameSync(staging, target);
          if (stagingIndex && indexTarget && fs.existsSync(stagingIndex)) {
            fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
            fs.copyFileSync(stagingIndex, indexTarget);
            fs.rmSync(stagingIndex, { force: true });
          }
          if (backup && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
          recovered.push({ file, result: 'completed-publish', state: j.state, target });
        } else if (backup && fs.existsSync(backup)) {
          fs.renameSync(backup, target);
          recovered.push({ file, result: 'rolled-back', state: j.state, target });
        } else {
          blocked.push({ file, reason: 'target-staging-backup-missing' }); continue;
        }
        fs.rmSync(file, { force: true });
      } catch (err) { blocked.push({ file, reason: err.message }); }
    }
    return { recovered, blocked };
  }

  async adoptCommittedTask(run, task, project) {
    const v = task.verification_json && typeof task.verification_json === 'object' ? task.verification_json : {};
    if (!task.worktree_path || !v.testedHash || !v.auditId) return false;
    try {
      if (!fs.existsSync(task.worktree_path)) return false;
      const head = await gitops.currentHead(task.worktree_path);
      if (!head) return false;
      const tree = (await gitops.git(task.worktree_path, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
      if (tree !== v.testedHash) {
        // Commit 尚未发生（pre-commit hook/进程中断）：可以安全重跑；不是冲突。
        if (!v.baseCommit || head === v.baseCommit) return 'not-committed';
        return false;
      }
      const audit = this.store.listAudits(task.id).find((a) => a.id === v.auditId);
      if (!audit || String(audit.verification_status || '').toUpperCase() !== 'PASS') return false;
      const taskBranch = task.branch || '';
      let planBranch = v.planBranch || '';
      if (!planBranch || planBranch === taskBranch || !planBranch.startsWith('wb/plan-')) {
        planBranch = (run.result_json?.planBranch && run.result_json.planBranch.startsWith('wb/plan-')) ? run.result_json.planBranch : `wb/plan-${run.id.slice(-6)}`;
      }
      // 只推进计划分支；任务分支可能正被 Worktree 检出，禁止 branch -f 到检出的任务分支（Git 128）。
      if (planBranch !== taskBranch) await gitops.updateRef(project.local_path, planBranch, head);
      this.store.updateTask(task.id, {
        status: TaskStatus.PASSED,
        head_commit: head,
        blocked_reason: '',
        verification_json: { ...v, commit: head, commitRecoveredAt: nowIso() },
        result_json: { ...(task.result_json || {}), ...v, commit: head, commitRecovered: true },
      });
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'commit_recovered', message: `已识别 Git commit ${head.slice(0, 12)} 并按同一 SHA 补账，不重复提交/审计`, data: { commit: head, tree, auditId: v.auditId } });
      return true;
    } catch (err) {
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'commit_recovery_error', level: 'warn', message: `提交恢复核对异常：${err.message}` });
      return false;
    }
  }

  async completeCommittedTaskAfterAudit(run, task, project) {
    const v = task.verification_json && typeof task.verification_json === 'object' ? task.verification_json : {};
    if (!task.worktree_path || !v.testedHash || !v.auditId) return false;
    try {
      if (!fs.existsSync(task.worktree_path)) return false;
      const audit = this.store.listAudits(task.id).find((a) => a.id === v.auditId);
      if (!audit || String(audit.verification_status || '').toUpperCase() !== 'PASS') return false;
      await gitops.stageAll(task.worktree_path);
      const indexTree = (await gitops.git(task.worktree_path, ['write-tree'], { allowFail: true })).stdout.trim();
      if (indexTree !== v.testedHash) return false;
      let head = await gitops.currentHead(task.worktree_path);
      const tree = (await gitops.git(task.worktree_path, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
      let created = false;
      if (tree !== v.testedHash) {
        const msg = `feat(task-${task.seq}): ${task.title}\n\n恢复：使用已测试/已审计工作副本补提交\n测试指纹: ${v.testedHash}`;
        const c = await gitops.commitAll(task.worktree_path, msg);
        head = await gitops.currentHead(task.worktree_path);
        const after = (await gitops.git(task.worktree_path, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
        if (after !== v.testedHash) return false;
        created = true;
      }
      const taskBranch = task.branch || '';
      let planBranch = v.planBranch || '';
      if (!planBranch || planBranch === taskBranch || !planBranch.startsWith('wb/plan-')) planBranch = `wb/plan-${run.id.slice(-6)}`;
      if (planBranch !== taskBranch) {
        const current = await gitops.branchRef(project.local_path, planBranch).catch(() => '');
        if (current && current !== v.baseCommit && current !== head) {
          const anc = await gitops.git(project.local_path, ['merge-base', '--is-ancestor', head, current], { allowFail: true });
          if (anc.code !== 0) return false;
        }
        await gitops.updateRef(project.local_path, planBranch, head);
      }
      this.freezeTestBaseline(project, task.worktree_path, { runId: run.id, taskId: task.id, source: 'commit_recovery', commit: head });
      this.store.updateTask(task.id, {
        status: TaskStatus.PASSED,
        head_commit: head,
        blocked_reason: '',
        verification_json: { ...v, commit: head, commitRecoveredAt: nowIso(), commitRecoveredCreated: created },
        result_json: { ...(task.result_json || {}), ...v, commit: head, commitRecovered: true },
      });
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'commit_recovered', message: `已基于已测试/已审计副本补提交 ${head.slice(0, 12)}，未重跑 Coding/Audit`, data: { commit: head, tree: v.testedHash, created } });
      return true;
    } catch (err) {
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'commit_recovery_error', level: 'warn', message: `提交补账失败：${err.message}` });
      return false;
    }
  }

  async resumeRun(runId, { retryFailed = false, authorizeBudget = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    if (run.result_json?.checkpointBlocked || run.pause_kind === 'checkpoint_blocked') {
      throw new PolicyError('CHECKPOINT_BLOCKED', `运行所属 Checkpoint 发布未对账（目标 ${run.result_json?.checkpointBlockedTarget || 'unknown'}）；保留工作树/备份/journal，禁止恢复派发`);
    }
    if ([RunStatus.ACCEPTED, RunStatus.CANCELLED].includes(run.status)) {
      throw new PolicyError('RUN_CLOSED', `运行已结束（${run.status}），不能恢复`);
    }
    if (['budget', 'wall_clock'].includes(String(run.pause_kind || '')) && !authorizeBudget) {
      throw new PolicyError('RUN_PAUSED_BY_BUDGET', `运行因 ${run.pause_kind === 'wall_clock' ? 'wall clock 超时' : '预算不足'} 暂停，不能自动解除；需要用户明确授权预算/超时后手动恢复`);
    }
    // 幂等也要先验证当前执行者拥有写租约，跨进程不能借幂等读取绕过 Fencing。
    this.ensureControlLease(run.project_id);
    const resumeProjectGate = this.store.getProject(run.project_id);
    if (resumeProjectGate) this.assertExperimentIsolation(resumeProjectGate);
    if ([RunStatus.RUNNING, RunStatus.QUEUED, RunStatus.AWAITING_ACCEPTANCE].includes(run.status)) return run;
    try {
    this.assertBudget(5_000);
    const resumeProject = this.store.getProject(run.project_id);
    const tasks = this.store.listTasks({ runId });
    for (const task of tasks) {
      const intermediate = ![
        TaskStatus.QUEUED,
        TaskStatus.PASSED,
        TaskStatus.FAILED,
        TaskStatus.BLOCKED,
      ].includes(task.status);
      // Git commit 已成功、SQLite 仍停留在 committing 的崩溃窗口：按预期 tree + 独立审计证据幂等补账。
      if (task.status === TaskStatus.COMMITTING) {
        const adopted = await this.adoptCommittedTask(run, task, resumeProject);
        if (adopted === true) continue;
        if (adopted === 'not-committed') {
          const completed = await this.completeCommittedTaskAfterAudit(run, task, resumeProject);
          if (completed) continue;
          // 提交未成功或工作树已偏离已审 tree：保留 COMMITTING/attempt/证据现场并阻断，绝不能退回 queued 重派 Coding。
          const reason = '提交恢复未完成：pre-commit 失败或工作树与已审 testedHash 不一致；保留原 attempt/证据并 BLOCKED';
          this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
          this.emit({ runId, taskId: task.id, type: 'commit_recovery_blocked', level: 'error', message: reason });
          continue;
        }
        if (adopted === false) {
          const reason = '提交恢复冲突：COMMITTING 任务缺少匹配的 Git tree/独立审计证据，拒绝自动重做/冒充成功';
          this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
          this.emit({ runId, taskId: task.id, type: 'commit_recovery_blocked', level: 'error', message: reason });
          continue;
        }
      }
      // 已阻断的提交恢复（例如临时 pre-commit 失败）在故障解除后应从提交阶段续做，不能退回 Coding。
      const blockedCommitIntent = [TaskStatus.BLOCKED, TaskStatus.FAILED].includes(task.status)
        && task.worktree_path && fs.existsSync(task.worktree_path)
        && task.verification_json?.auditId && task.verification_json?.testedHash;
      if (blockedCommitIntent) {
        const completed = await this.completeCommittedTaskAfterAudit(run, task, resumeProject);
        if (completed) continue;
        this.emit({ runId, taskId: task.id, type: 'commit_recovery_still_blocked', level: 'warn', message: '提交恢复仍无法完成，保留尝试与证据' });
        continue;
      }
      const needReset = intermediate || (retryFailed && [TaskStatus.FAILED, TaskStatus.BLOCKED].includes(task.status));
      if (!needReset) continue;
      // 无损续跑：先保存完整检查点；有效 worktree 必须保留，损坏/不存在时也保留其恢复归档。
      let keepWorktree = false;
      let checkpoint = task.verification_json?.checkpoint || null;
      if (task.worktree_path) {
        if (checkpoint?.archive && !fs.existsSync(task.worktree_path)) {
          // 已有归档，保留供 runTask 重建后恢复。
        } else {
          checkpoint = await this.saveWorktreeCheckpoint({ run, task, project: resumeProject, worktree: task.worktree_path });
        }
        keepWorktree = (() => { try { return fs.existsSync(task.worktree_path) && fs.existsSync(path.join(task.worktree_path, '.git')); } catch { return false; } })();
        if (!keepWorktree) {
          await gitops.removeWorktree(resumeProject?.local_path || '', task.worktree_path).catch(() => {});
          try { fs.rmSync(task.worktree_path, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
      this.store.updateTask(task.id, {
        status: TaskStatus.QUEUED,
        attempt: 0,
        blocked_reason: '',
        worktree_path: keepWorktree ? task.worktree_path : '',
        branch: keepWorktree ? task.branch : '',
        base_commit: keepWorktree ? task.base_commit : '',
        session_id: task.session_id || '',
        head_commit: '',
        result_json: keepWorktree ? (task.result_json || {}) : {},
        verification_json: { ...(task.verification_json && typeof task.verification_json === 'object' ? task.verification_json : {}), checkpoint: keepWorktree ? (checkpoint || task.verification_json?.checkpoint || null) : (checkpoint || task.verification_json?.checkpoint || null) },
      });
      this.emit({ runId, taskId: task.id, type: 'task_requeued', message: `任务 #${task.seq} 已重新排队，准备继续` });
    }
    const planBranch = `wb/plan-${run.id.slice(-6)}`;
    const existing = await gitops.branchRef(resumeProject?.local_path || '', planBranch).catch(() => '');
    const projectBudget = resumeProject?.budget_json || {};
    const refreshedBudget = {
      ...(run.budget_json || {}),
      maxTokens: Math.min(
        Number(projectBudget.max_tokens_per_run || this.config.budget.maxTokensPerRun),
        this.config.budget.maxTotalTokens,
      ),
      maxCostCny: Math.min(
        Number(projectBudget.max_cost_cny_per_run || this.config.budget.maxCostCnyPerRun),
        this.config.budget.maxCostCny,
      ),
      maxAttempts: Number(projectBudget.max_attempts || this.config.budget.maxAttempts),
      maxWallClockMs: Number(projectBudget.max_wall_clock_ms || this.config.budget.runWallClockMs),
    };
    const newDeadline = new Date(Date.now() + refreshedBudget.maxWallClockMs).toISOString();
    this.store.updateRun(runId, { budget_json: refreshedBudget, wall_deadline: newDeadline, verification_status: 'LOCAL_VERIFIED', ci_status: '', ci_url: '', ci_checked_at: '', pause_kind: '' });
    this.emit({
      runId,
      projectId: run.project_id,
      type: 'run_resumed',
      message: `从断点恢复运行${existing ? `（计划分支 ${planBranch} 已保留进度）` : ''}`,
    });
    this.kick(runId);
    return this.store.getRun(runId);
    } catch (err) { this.releaseProjectLease(run.project_id); throw err; }
  }

  cancelRun(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    this.ensureControlLease(run.project_id);
    const controller = this.controllers.get(runId);
    if (controller) controller.abort();
    this.store.updateRun(runId, { status: RunStatus.CANCELLED, stop_reason: '用户取消', ended_at: nowIso() });
    this.emit({ runId, projectId: run.project_id, type: 'run_cancelled', level: 'warn', message: '运行已取消' });
    if (!controller) this.releaseProjectLease(run.project_id);
    return this.store.getRun(runId);
  }

  acceptRun(runId, { confirmLocalOnly = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    this.ensureControlLease(run.project_id);
    try {
    if (run.status !== RunStatus.AWAITING_ACCEPTANCE) {
      throw new PolicyError('RUN_NOT_READY', `运行尚未完成，当前状态：${run.status}`);
    }
    const project = this.store.getProject(run.project_id);
    if (run.result_json?.loopId && !['PASS', 'NOT_CONFIGURED'].includes(run.result_json?.productAcceptance)) {
      throw new PolicyError('RUN_NOT_FINAL', '该运行只是 Loop 的任务级阶段，产品级冻结验收尚未通过，不能验收');
    }
    const tasks = this.store.listTasks({ runId: run.id });
    const acceptance = this.contractAcceptanceStatus(project, tasks);
    if (acceptance.required && !acceptance.ok) {
      throw new PolicyError('RUN_ACCEPTANCE_INCOMPLETE', `冻结验收条款缺少 PASS 证据：${acceptance.missing.join('；')}`);
    }
    const verification = run.verification_status || '';
    const verifiedSha = run.verified_sha || '';
    if (verification !== 'CI_PASSED') {
      const localOk = verification === 'LOCAL_VERIFIED' && confirmLocalOnly && project?.allow_local_acceptance;
      if (!localOk) {
        throw new PolicyError(
          'VERIFICATION_NOT_PASSED',
          `不能验收：当前验证状态为 ${verification || '未知'}${verification === 'LOCAL_VERIFIED' ? '（仅本地验证，需显式确认本地验收且项目允许）' : ''}；远端交付必须 CI_PASSED 并绑定提交 SHA`,
        );
      }
    }
    if (!verifiedSha) throw new PolicyError('COMMIT_NOT_BOUND', '验收必须绑定真实 commit SHA，运行没有记录 verified_sha');
    const updated = this.store.updateRun(runId, {
      status: RunStatus.ACCEPTED,
      stop_reason: '',
      result_json: {
        ...(run.result_json || {}),
        acceptedAt: nowIso(),
        acceptedSha: verifiedSha,
        acceptedVerification: verification,
        localOnlyAccepted: verification === 'LOCAL_VERIFIED',
        merged: false,
      },
    });
    this.emit({
      runId,
      projectId: run.project_id,
      type: 'run_accepted',
      message: `人工验收通过（${verification}，commit ${verifiedSha.slice(0, 8)}；工作台未合并主分支）`,
      data: { verifiedSha, verification, localOnly: verification === 'LOCAL_VERIFIED' },
    });
    return updated;
    } finally { this.releaseProjectLease(run.project_id); }
  }

  /** 读取审计参考上下文（未改动文件，仅只读展示，用于核对文档声明与实现是否一致）。 */
  async collectAuditContext(worktree) {
    const paths = Array.isArray(this.config.audit.contextFiles) ? this.config.audit.contextFiles : [];
    const files = [];
    for (const rel of paths.slice(0, 8)) {
      try {
        const abs = path.join(worktree, rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        const content = fs.readFileSync(abs, 'utf8');
        files.push({ path: rel, content: content.slice(0, 12000) });
      } catch {
        /* ignore */
      }
    }
    return files;
  }

  /**
   * P0-1：把失败任务的 Agent 产物保存为可继续的修复基线，供 LoopManager 自动创建修复任务。
   * 只提交 worktree 当前内容（由 Agent 产生），不修改业务逻辑；返回后更新项目默认分支。
   */
  async prepareAutoRepair({ project, task, label = 'auto-repair' } = {}) {
    // 幂等：崩溃后重试不得重复创建修复基线分支。
    const prior = task?.result_json?.autoRepairBaseline;
    if (prior?.branch && prior?.head) {
      this.store.updateProject(project.id, { default_branch: prior.branch });
      return { ok: true, branch: prior.branch, head: prior.head, reused: true };
    }
    const suffix = newId('ar').replace(/^ar_?/, '').slice(0, 8);
    let head = '';
    if (task?.worktree_path && fs.existsSync(task.worktree_path)) {
      const worktree = task.worktree_path;
      try {
        const commit = await gitops.commitAll(worktree, `chore(auto-repair): preserve failed task ${task.id} (${label})`);
        head = commit?.commit || (await gitops.currentHead(worktree));
      } catch {
        head = (await gitops.currentHead(worktree).catch(() => '')) || task.head_commit || '';
      }
      if (!head) head = task.head_commit || '';
      if (head) {
        const branch = `wb/auto-repair-${suffix}`;
        await gitops.updateRef(project.local_path, branch, head);
        await gitops.removeWorktree(project.local_path, worktree).catch(() => {});
        this.store.updateProject(project.id, { default_branch: branch });
        const freshTask = this.store.getTask(task.id);
        this.store.updateTask(task.id, { result_json: { ...(freshTask?.result_json || {}), autoRepairBaseline: { branch, head, at: nowIso() } } });
        this.emit({ projectId: project.id, taskId: task.id, type: 'auto_repair_baseline', message: `已保存失败任务产物为修复基线 ${branch}（${head.slice(0, 8)}）`, data: { branch, head, sourceTaskId: task.id } });
        return { ok: true, branch, head, worktree: '' };
      }
    }
    const branch = task?.branch || '';
    head = task?.head_commit || '';
    if (branch && head) {
      this.store.updateProject(project.id, { default_branch: branch });
      return { ok: true, branch, head, reused: true };
    }
    return { ok: false, reason: '失败任务没有可保留的 Git 产物/分支' };
  }

  /**
   * 产品级验收：在最终 Git Commit 上独立审计全部冻结验收条款。
   * 与任务级 runTask 分离；历史 PASS 不能替代最终 Commit 的重新审计。
   */
  async productAcceptanceAudit({ project, expected = [], planHead = '', baseCommit = '', latestRun = null, latestTask = null } = {}) {
    if (!expected.length) return { ok: true, required: false, status: 'SKIPPED', criteria: [], missing: [] };
    if (!planHead) return { ok: false, required: true, status: 'UNKNOWN', reason: '缺少最终 Git Commit，不能进行产品验收', missing: expected };
    const parent = await gitops.git(project.local_path, ['rev-parse', `${planHead}^`], { allowFail: true }).then((r) => r.stdout.trim()).catch(() => '');
    const base = baseCommit || parent || planHead;
    // 终审必须绑定当前候选自己的真实测试回执：commit/tree/命令/数值退出码/原始日志缺一不可。
    if (this.deps.runAudit === runAudit) {
      if (!latestTask) {
        return { ok: false, required: true, status: 'BLOCKED', reason: `产品终审缺少当前候选 ${planHead.slice(0, 12)} 的最终任务回执；未发送审计`, missing: expected, planHead };
      }
      const candidateTree = (await gitops.git(project.local_path, ['rev-parse', `${planHead}^{tree}`], { allowFail: true })).stdout.trim();
      const receipt = latestTask.result_json || latestTask.verification_json || {};
      const receiptTree = receipt.testedHash || '';
      const receiptLog = receipt.testArtifactLog ? this.artifactAbs(receipt.testArtifactLog) : '';
      let receiptLogValid = !!receiptLog && fs.existsSync(receiptLog);
      if (receiptLogValid) {
        const stat = fs.statSync(receiptLog);
        const actualHash = crypto.createHash('sha256').update(fs.readFileSync(receiptLog)).digest('hex');
        let expectedBytes = Number(receipt.testArtifactBytes);
        if (!Number.isFinite(expectedBytes)) {
          // 兼容 ba544 旧回执：从 SQLite artifacts 登记读取原始字节数。
          const artifacts = latestTask?.id ? this.store.listArtifacts(latestTask.id) : [];
          const absTarget = path.resolve(receiptLog);
          const match = artifacts.find((a) => a.kind === 'test' && (path.resolve(this.config.paths.dataDir, a.path) === absTarget || path.resolve(a.path) === absTarget));
          if (match) { const registeredBytes = match.meta_json?.bytes ?? match.meta?.bytes; if (Number.isFinite(Number(registeredBytes))) expectedBytes = Number(registeredBytes); }
        }
        if (Number.isFinite(expectedBytes) && stat.size !== expectedBytes) receiptLogValid = false;
        if (receipt.testArtifactSha256 && actualHash !== receipt.testArtifactSha256) receiptLogValid = false;
        // 无哈希的旧回执：零字节日志只有在测试本身明确为空输出时才可能是合法的。
        if (!receipt.testArtifactSha256 && stat.size === 0 && String(receipt.testStdout || '').length > 0) receiptLogValid = false;
      }
      const receiptValid = receipt.commit === planHead && receiptTree === candidateTree
        && typeof receipt.testCode === 'number' && receipt.testCode === 0
        && !!receipt.testCommand && receiptLogValid;
      if (!receiptValid) {
        return { ok: false, required: true, status: 'BLOCKED', reason: `产品终审缺少当前候选 ${planHead.slice(0, 12)} 的完整测试回执（commit/tree/数值退出码/命令/原始日志）或属于其他版本；拒绝交付`, missing: expected, planHead };
      }
    }
    const diffRes = await gitops.git(project.local_path, ['diff', base, planHead], { timeoutMs: 120_000 });
    // 产品验收必须让分块器看到完整 diff；禁止在入口预先丢弃中段后再交给审计。
    const diff = diffRes.stdout || '';
    const diffStat = await gitops.git(project.local_path, ['diff', '--stat', base, planHead], { allowFail: true }).then((r) => (r.stdout || '').trim());
    const repoFiles = await gitops.listTree(project.local_path, planHead, { max: 150 });
    const contextFiles = await this.collectAuditContext(project.local_path);
    const lastAttempt = latestTask ? this.store.listAttempts(latestTask.id).filter((a) => a.stage === 'coding').slice(-1)[0] : null;
    const coderFamily = coderFamilyFor(lastAttempt?.agent_kind || latestTask?.agent_kind || 'dsh', this.config);
    let reservation = null;
    let auditInfo = null;
    try { auditInfo = this.deps.runAudit === runAudit ? this.auditResourcePreflight(project, coderFamily) : { provider: 'fake', model: 'fake', exempt: true, estimate: 0 }; } catch (err) { return { ok: false, required: true, status: 'BLOCKED', reason: err.message, missing: expected }; }
    let audit;
    try {
      let productAuditBudget = null;
      if (this.deps.runAudit === runAudit && auditInfo && ((!auditInfo.exempt && !this.isDshAuditProject(project)) || this.experimentIdForProject(project.id))) {
        const paProvider = this.isDshAuditProject(project) ? 'deepseek' : auditInfo.provider;
        if (this.isDshAuditProject(project)) {
          reservation = assertModelBudget({ config: this.config, store: this.store, provider: paProvider, model: 'deepseek', estimatedTokens: Number(auditInfo.estimate || 8_000), label: 'Product Acceptance Audit', reserve: true, experimentId: this.experimentIdForProject(project.id), experimentScope: this.experimentScopeForProvider(project, paProvider), experimentRole: 'audit', experimentClient: 'dsh' });
        } else {
          productAuditBudget = { config: this.config, store: this.store, provider: paProvider, model: auditInfo.model || '', estimatedTokens: Number(auditInfo.estimate || 8_000), experimentId: this.experimentIdForProject(project.id), experimentScope: this.experimentScopeForProvider(project, paProvider), client: paProvider, requestKey: `product-audit:${project.id}:${planHead}` };
        }
      }
      audit = await this.deps.runAudit({
        config: this.config, project,
        task: { id: latestTask?.id || 'product-acceptance', seq: 999, title: 'Product acceptance', acceptance_json: expected, agent_kind: latestTask?.agent_kind || 'auto' },
        diff, diffStat, repoFiles, coderFamily, contextFiles,
        versionInfo: {
          commit: planHead, planHead,
          worktreeHash: await gitops.git(project.local_path, ['rev-parse', `${planHead}^{tree}`], { allowFail: true }).then((r) => r.stdout.trim()).catch(() => planHead),
          testedHash: latestTask?.result_json?.testedHash || latestTask?.verification_json?.testedHash || '',
        },
        testResult: latestTask?.result_json ? {
          command: latestTask.result_json.testCommand || latestTask.verification_json?.testCommand || '',
          code: latestTask.result_json.testCode,
          stdout: latestTask.result_json.testStdout || '',
          stderr: latestTask.result_json.testStderr || '',
          durationMs: latestTask.result_json.testDurationMs,
        } : {},
        worktree: project.local_path, commit: planHead, budget: productAuditBudget,
      });
    } catch (err) {
      if (reservation?.reservation?.id) this.store.markModelReservationUnknown(reservation.reservation.id);
      return { ok: false, required: true, status: 'BLOCKED', reason: `产品验收审计异常：${err.message}`, missing: expected };
    }
    if (reservation?.reservation?.id) {
      const u = summarizeUsage(audit.usage || {});
      this.store.settleModelReservation(reservation.reservation.id, { actualTokens: u.total, actualCostCny: audit.costCny || 0, usageKnown: !!(audit.usage && u.total > 0) });
    }
    const status = String(audit.status || (audit.verdict === 'pass' ? 'PASS' : 'FAIL')).toUpperCase();
    const criteria = Array.isArray(audit.criteria) ? audit.criteria : [];
    const norm = (x) => String(x || '').toLowerCase().replace(/[\s，。；：、,.!?！？:;（）()\-—]/g, '');
    const evidence = criteria.filter((c) => String(c.status || '').toLowerCase() === 'pass' && String(c.evidence || '').trim().length >= 12);
    const missing = expected.filter((clause) => !evidence.some((c) => { const a = norm(c.criterion); const b = norm(clause); return a && b && (a.includes(b) || b.includes(a)); }));
    const ok = status === 'PASS' && missing.length === 0;
    let auditRow = null;
    if (latestRun && latestTask) {
      const identity = resolveLlmIdentity({ config: this.config, provider: audit.provider });
      auditRow = this.store.createAudit({
        id: newId('aud'), runId: latestRun.id, taskId: latestTask.id, attemptNo: 999,
        provider: identity.known ? identity.provider : 'unknown', providerKnown: identity.known, providerSource: identity.source || audit.providerSource || '',
        budgetScope: this.isDshAuditProject(project) ? 'project_audit' : 'global', model: audit.model || '', verdict: ok ? 'pass' : 'fail', score: audit.score || 0,
        criteria, findings: audit.findings || [], requiredFixes: audit.requiredFixes || [], summary: `产品级验收（${planHead.slice(0, 12)}）：${ok ? 'PASS' : status + '，缺失 ' + missing.length}`,
        tokensIn: audit.usage?.input || 0, tokensOut: audit.usage?.output || 0, costCny: audit.costCny || 0,
        verificationStatus: ok ? 'PASS' : status, evidenceHash: planHead, diffHash: hashText(diff), independence: audit.independence?.independent ? 'independent' : 'same-family',
      });
    }
    return { ok, required: true, status, criteria, missing, requiredFixes: audit.requiredFixes || [], auditRow, planHead, diffHash: hashText(diff) };
  }

  /**
   * 仅重试"验证/审计"阶段：复用已存在的任务 worktree，不重新调用 Coding Agent。
   * 用于审计模型暂时不可用/审计空返回等场景；仍执行真实测试、独立审计与提交。
   */
  async retryVerification(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new PolicyError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
    if (!task.worktree_path || !fs.existsSync(task.worktree_path)) {
      throw new PolicyError('WORKTREE_MISSING', '任务工作副本不存在，无法仅重试验证；请重新排队执行任务');
    }
    if (![TaskStatus.BLOCKED, TaskStatus.FAILED, TaskStatus.AUDITING, TaskStatus.TESTING].includes(task.status)) {
      throw new PolicyError('TASK_STATE_INVALID', `任务当前状态为 ${task.status}，不能仅重试验证`);
    }
    const run = this.store.getRun(task.run_id);
    const project = this.store.getProject(task.project_id);
    if (!run || !project) throw new PolicyError('RUN_NOT_FOUND', '运行或项目不存在');
    this.assertExperimentIsolation(project);
    if (!this._verificationLocks) this._verificationLocks = new Set();
    if (this._verificationLocks.has(task.id)) throw new PolicyError('VERIFICATION_IN_PROGRESS', '该任务已有验证重试在进行中，拒绝并发重复验证（防止审计/提交竞态）');
    // 原 Run 仍在本进程执行时不得启动“仅验证重试”：否则会覆盖 processRun 的 controller/running，
    // 暂停等待的可能是新 controller 而非真正的 Agent/test/audit 执行者。
    if (this.running.has(run.id) || this.controllers.has(run.id)) throw new PolicyError('RUN_ACTIVE', `运行 ${run.id} 正在执行中，不能并发启动验证重试；请先暂停/等待当前执行结束`);
    const isolationMode = isolationModeForProject(this.config, project);
    let isolationWarning = '';
    if (isolationMode !== 'restricted') {
      if (!this._isolationCaps) this._isolationCaps = detectIsolationCapabilities();
      isolationWarning = assertIsolationForProject(this.config, project, this._isolationCaps).warning;
    }
    this._verificationLocks.add(task.id);
    const worktree = task.worktree_path;
    const baseCommit = task.base_commit || (await gitops.currentHead(worktree));
    const logDir = this.logsDir(run.id, task.id);
    ensureDir(logDir);
    const sandboxHome = tmpHomeFor(this.config, run.id, task.id);
    const protectedPaths = protectPathsForProject(project, this.config);
    const retryLease = this.store.acquireProjectLeaseFenced(project.id, this.instanceId, 30 * 60 * 1000);
    if (!retryLease.ok) {
      this._verificationLocks.delete(task.id);
      throw new PolicyError('PROJECT_LEASE_HELD', `验证重试无法获得项目写租约：${retryLease.reason || '其他执行者持有'}`);
    }
    this.projectLeases.set(project.id, { owner: this.instanceId, fence: retryLease.fence });
    const retryController = new AbortController();
    const retrySignal = retryController.signal;
    this.running.add(run.id);
    this.controllers.set(run.id, retryController);
    this.store.updateRun(run.id, { status: RunStatus.RUNNING, stop_reason: '', current_task_id: task.id });
    this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'verification_retry_started', message: '复用现有工作副本，仅重试测试与独立审计' });
    try {
      this.assertProjectLease(project.id);
      await gitops.stageAll(worktree);
      const testedHash = (await gitops.git(worktree, ['write-tree'])).stdout.trim();
      this.store.updateTask(task.id, { status: TaskStatus.TESTING, verification_json: { baseCommit, testedHash, verificationRetry: true } });
      const testCommand = this.resolveTaskTestCommand(project, task, worktree);
      const safeCommand = assertSafeTestCommand(testCommand, project);
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_started', message: `运行测试：${safeCommand}`, data: { command: safeCommand, testedHash } });
      const testRes = await this.runProjectTest({
        project,
        worktree,
        command: safeCommand,
        timeoutMs: Number(project.config_json?.test_timeout_ms || this.config.policy.testTimeoutMs),
        logPath: path.join(logDir, `verify-${Date.now()}-test.log`),
        signal: retrySignal,
        metadata: { runId: run.id, taskId: task.id, projectId: project.id, owner: this.instanceId, fence: this.projectLeases.get(project.id)?.fence || 0 },
        runId: run.id,
        taskId: task.id,
      });
      if (retrySignal.aborted) return { ok: false, reason: '运行被暂停/取消，验证检查点已保留' };
      const testResult = { command: safeCommand, code: testRes.code, timedOut: testRes.timedOut, durationMs: testRes.durationMs, stdout: testRes.stdout, stderr: testRes.stderr, isolation: testRes.isolation || null, setupRetried: !!testRes.setupRetried, setupCommand: testRes.setupCommand || '', setupLogPath: testRes.setupLogPath || '', setupFailed: !!testRes.setupFailed };
      const retryArtifactContent = `$ ${safeCommand}\nexit=${testRes.code} duration=${testRes.durationMs}ms\n\n[stdout]\n${testRes.stdout}\n\n[stderr]\n${testRes.stderr}`;
      const retryTestArtifact = this.writeArtifact({ runId: run.id, taskId: task.id, kind: 'test', filename: `task-${task.id}-verify-${Date.now()}-test.txt`, content: retryArtifactContent });
      const retryArtifactSha256 = crypto.createHash('sha256').update(retryArtifactContent).digest('hex');
      await gitops.stageAll(worktree);
      const afterHash = (await gitops.git(worktree, ['write-tree'])).stdout.trim();
      if (afterHash !== testedHash) throw new PolicyError('FINGERPRINT_MISMATCH', '测试期间工作树内容发生变化');
      if (testRes.code !== 0) {
        const reason = `测试失败（exit=${testRes.code}）：${tailLines(testRes.stdout || testRes.stderr || '', 40)}`;
        this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
        this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason });
        this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_failed', level: 'warn', message: reason });
        return { ok: false, reason };
      }
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_passed', message: `测试通过（重试验证，${Math.round(testRes.durationMs / 1000)}s）`, data: { testedHash } });

      const fileEntries = await gitops.stagedFiles(worktree, baseCommit);
      const changedFiles = fileEntries.map((f) => f.file);
      const violations = protectedViolations(changedFiles, protectedPaths);
      if (violations.length) {
        await enforceProtectedPaths(worktree, violations);
        throw new PolicyError('PROTECTED_PATH_VIOLATION', `受保护路径被修改：${violations.join(', ')}`);
      }
      const contractViolations = verifyContractBaseline(worktree, project.config_json?.contract_baseline || {});
      if (contractViolations.length) throw new PolicyError('CONTRACT_MUTATED', `冻结验收契约被修改：${contractViolations.join(', ')}`);
      const testBaselineViolations = verifyTestBaseline(worktree, project.config_json?.trusted_test_hashes || {});
      if (testBaselineViolations.length) throw new PolicyError('TEST_BASELINE_MUTATED', `已冻结测试/运行器被修改：${testBaselineViolations.join(', ')}`);
      const diff = await gitops.stagedDiff(worktree, baseCommit, { maxChars: 1_000_000 });
      const diffStat = await gitops.diffStat(worktree, baseCommit);
      const repoFiles = await gitops.listTree(worktree, 'HEAD', { max: 150 });
      const lastAttempt = this.store.listAttempts(task.id).filter((a) => a.stage === 'coding').slice(-1)[0];
      const coderFamily = coderFamilyFor(lastAttempt?.agent_kind || task.agent_kind || 'dsh', this.config);
      let auditResourceInfo = null;
      try {
        // 真实审计必须通过预检；测试注入审计器允许跳过真实 Provider 预检。
        if (this.deps.runAudit === runAudit) auditResourceInfo = this.auditResourcePreflight(project, coderFamily);
      } catch (err) {
        const reason = `审计资源预检失败，停止验证重试（不继续调用模型）：${err.message}`;
        this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
        this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason });
        this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'verification_preflight_blocked', level: 'error', message: reason });
        return { ok: false, reason, blocked: true };
      }
      this.store.updateTask(task.id, { status: TaskStatus.AUDITING });
      this.assertBudget(8_000);
      const contextFiles = await this.collectAuditContext(worktree);
      this.assertProjectLease(project.id);
      let auditReservation = null;
      let retryAuditBudget = null;
      let audit;
      try {
        if (this.deps.runAudit === runAudit && auditResourceInfo && ((!auditResourceInfo.exempt && !this.isDshAuditProject(project)) || this.experimentIdForProject(project.id))) {
          const auditProvider = this.isDshAuditProject(project) ? 'deepseek' : auditResourceInfo.provider;
          if (this.isDshAuditProject(project)) {
            auditReservation = assertModelBudget({ config: this.config, store: this.store, provider: auditProvider, model: 'deepseek', estimatedTokens: Number(auditResourceInfo.estimate || 8_000), label: 'Independent Audit', reserve: true, experimentId: this.experimentIdForProject(project.id), experimentScope: this.experimentScopeForProvider(project, auditProvider), experimentRole: 'audit', experimentClient: 'dsh' });
          } else {
            retryAuditBudget = { config: this.config, store: this.store, provider: auditProvider, model: auditResourceInfo.model || '', estimatedTokens: Number(auditResourceInfo.estimate || 8_000), experimentId: this.experimentIdForProject(project.id), experimentScope: this.experimentScopeForProvider(project, auditProvider), client: auditProvider, requestKey: `retry-audit:${run.id}:${task.id}` };
          }
        }
        audit = await this.deps.runAudit({
          config: this.config, project, task: { ...task, acceptance_json: task.acceptance_json },
          diff, diffStat, testResult, repoFiles, coderFamily, contextFiles,
          versionInfo: { baseCommit, worktreeHash: testedHash, testedHash }, worktree, commit: '', signal: retrySignal, budget: retryAuditBudget,
        });
      } catch (err) {
        if (auditReservation?.reservation?.id) this.store.markModelReservationUnknown(auditReservation.reservation.id);
        throw err;
      }
      if (auditReservation?.reservation?.id) {
        const au = summarizeUsage(audit.usage || {});
        this.store.settleModelReservation(auditReservation.reservation.id, { actualTokens: au.total, actualCostCny: audit.costCny || 0, usageKnown: !!(audit.usage && au.total > 0) });
      }
      if (retrySignal.aborted) return { ok: false, reason: '运行被暂停/取消，验证检查点已保留' };
      const auditStatus = audit.status || (audit.verdict === 'pass' ? 'PASS' : 'FAIL');
      this.assertProjectLease(project.id);
      const auditIdentity = resolveLlmIdentity({ config: this.config, provider: audit.provider });
      const actualAuditProvider = auditIdentity.known ? auditIdentity.provider : 'unknown';
      const auditRow = this.store.createAudit({
        id: newId('aud'), runId: run.id, taskId: task.id, attemptNo: Number(task.attempt || 0) + 1,
        provider: actualAuditProvider, providerKnown: auditIdentity.known, providerSource: audit.providerSource || auditIdentity.source, budgetScope: this.isDshAuditProject(project) ? 'project_audit' : 'global', model: audit.model, verdict: audit.verdict, score: audit.score,
        criteria: audit.criteria, findings: audit.findings, requiredFixes: audit.requiredFixes,
        summary: audit.summary, tokensIn: audit.usage?.input || 0, tokensOut: audit.usage?.output || 0,
        costCny: audit.costCny || 0, verificationStatus: auditStatus, evidenceHash: testedHash,
        diffHash: hashText(diff), independence: audit.independence?.independent ? 'independent' : 'same-family',
      });
      this.store.addRunUsage(run.id, { tokens: summarizeUsage(audit.usage || {}).total, costCny: audit.costCny || 0 });
      this.emit({
        runId: run.id, projectId: project.id, taskId: task.id,
        type: auditStatus === 'PASS' ? 'audit_passed' : auditStatus === 'UNKNOWN' ? 'audit_unknown' : 'audit_failed',
        level: auditStatus === 'PASS' ? 'info' : 'warn', message: auditSummaryText({ ...audit, status: auditStatus }),
        data: { provider: audit.provider, model: audit.model, status: auditStatus, criteria: audit.criteria, requiredFixes: audit.requiredFixes, unknownReasons: audit.unknownReasons },
      });
      if (auditStatus !== 'PASS') {
        const reason = auditStatus === 'UNKNOWN' ? `审计 UNKNOWN：${(audit.unknownReasons || []).join('；')}` : `审计未通过：${(audit.requiredFixes || []).slice(0, 4).join('；')}`;
        this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
        this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason });
        return { ok: false, reason, auditStatus };
      }
      const taskBranch = task.branch || '';
      const planBranchForIntent = (() => {
        const candidate = task.verification_json?.planBranch || run.result_json?.planBranch || '';
        return candidate && candidate !== taskBranch && candidate.startsWith('wb/plan-') ? candidate : `wb/plan-${run.id.slice(-6)}`;
      })();
      this.store.updateTask(task.id, {
        status: TaskStatus.COMMITTING,
        verification_json: {
          ...(task.verification_json || {}), baseCommit, testedHash, planBranch: planBranchForIntent,
          auditId: auditRow.id, auditStatus, auditProvider: audit.provider, auditModel: audit.model,
          auditScore: audit.score, testCommand: safeCommand, testCode: testRes.code, testStdout: String(testRes.stdout || ''), testStderr: String(testRes.stderr || ''), testArtifactLog: this.artifactAbs(retryTestArtifact), testArtifactSha256: retryArtifactSha256, testArtifactBytes: Buffer.byteLength(retryArtifactContent), verificationRetry: true, commitIntentAt: nowIso(),
        },
      });
      const commitMessage = [
        `feat(task-${task.seq}): ${task.title}`, '',
        ...(task.acceptance_json || []).map((a) => `- 验收：${a}`), '',
        `审计：${audit.provider}/${audit.model} PASS（得分 ${audit.score}）`,
        `测试：${safeCommand} 通过（指纹 ${testedHash.slice(0, 12)}）`,
        '生成：AI 开发工作台 v2.0',
      ].join('\n');
      const currentBranch = (await gitops.git(worktree, ['branch', '--show-current'], { allowFail: true })).stdout.trim();
      const planBranch = task.verification_json?.planBranch || run.result_json?.planBranch || currentBranch || task.branch || `wb/plan-${run.id.slice(-6)}`;
      this.assertProjectLease(project.id);
      let commit;
      const provisionalCommit = null;
      if (provisionalCommit) {
        commit = provisionalCommit;
      } else {
        commit = await gitops.commitAll(worktree, commitMessage);
        const committedTree = (await gitops.git(worktree, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
        // 验证重试的特殊情况：工作树可能已被上一轮 Agent 提交（干净且 HEAD tree == testedHash）。
        // 这时 commitAll 返回 empty，但复用已有 HEAD 是安全且幂等的，不能误报版本不一致。
        if (commit.empty) {
          if (committedTree !== testedHash) throw new PolicyError('COMMIT_FINGERPRINT_MISMATCH', '工作树干净但 HEAD tree 与测试/审计版本不一致');
          commit = { commit: await gitops.currentHead(worktree), files: [] };
        } else if (committedTree !== testedHash) {
          throw new PolicyError('COMMIT_FINGERPRINT_MISMATCH', '提交与测试/审计版本不一致');
        }
        // 如果该分支正被当前 worktree 检出，不能 branch -f 它；它已经指向目标 commit 即可。
        const sameCheckedOutBranch = currentBranch && currentBranch === planBranch && (await gitops.currentHead(worktree)) === commit.commit;
        if (!sameCheckedOutBranch) await gitops.updateRef(project.local_path, planBranch, commit.commit || (await gitops.currentHead(worktree)));
      }
      const headCommit = await gitops.currentHead(worktree);
      this.freezeTestBaseline(project, worktree, { runId: run.id, taskId: task.id, source: 'verification_retry', commit: headCommit });
      const verification = {
        baseCommit, testedHash, commit: headCommit, planBranch, testCommand: safeCommand, testCode: testRes.code, testStdout: String(testRes.stdout || ''), testStderr: String(testRes.stderr || ''), testArtifactLog: this.artifactAbs(retryTestArtifact), testArtifactSha256: retryArtifactSha256, testArtifactBytes: Buffer.byteLength(retryArtifactContent), isolation: isolationWarning ? { mode: isolationMode, warning: isolationWarning } : { mode: isolationMode },
        auditId: auditRow.id, auditStatus, auditProvider: audit.provider, auditModel: audit.model,
        auditScore: audit.score, independence: audit.independence, agent: lastAttempt?.agent_kind || '',
        verificationRetry: true,
      };
      this.store.updateTask(task.id, { status: TaskStatus.PASSED, head_commit: headCommit, verification_json: verification, blocked_reason: '', result_json: { ...verification, criteria: audit.criteria } });
      this.store.updateRun(run.id, { result_json: { ...(run.result_json || {}), planBranch, planHead: headCommit } });
      await gitops.removeWorktree(project.local_path, worktree).catch(() => {});
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'task_passed', message: `任务通过（仅重试验证）：${task.title}（commit ${headCommit.slice(0, 8)}，审计 ${audit.provider} PASS）`, data: { commit: headCommit, planBranch, auditStatus, testedHash } });
      this.kick(run.id);
      return { ok: true, commit: headCommit };
    } catch (err) {
      if (retrySignal.aborted) return { ok: false, reason: '运行被暂停/取消，验证检查点已保留' };
      const reason = redact(`验证重试失败：${err?.message || err}`, this.config);
      this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
      this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason });
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'audit_error', level: 'error', message: reason });
      return { ok: false, reason };
    } finally {
      this._verificationLocks.delete(task.id);
      this.running.delete(run.id);
      if (this.controllers.get(run.id) === retryController) this.controllers.delete(run.id);
      this.releaseProjectLease(project.id);
    }
  }

  /**
   * 恢复因并发/中断导致的任务状态竞态：当任务已有 commit + verification.commit +
   * 最近一次审计 PASS 时，原子恢复为 passed 并重新走 finalize，避免把真实通过误判为失败。
   */
  reconcileRun(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    if (!['paused', 'failed', 'interrupted', 'running'].includes(run.status)) {
      throw new PolicyError('RUN_STATE_INVALID', `运行状态 ${run.status} 不允许 reconcile`);
    }
    const tasks = this.store.listTasks({ runId });
    const reconciled = [];
    for (const task of tasks) {
      if (task.status === 'passed') continue;
      if (task.status !== 'blocked' && task.status !== 'failed') continue;
      const audits = this.store.listAudits(task.id) || [];
      const passAudit = [...audits].reverse().find((a) => String(a.verdict || '').toLowerCase() === 'pass' && a.verification_status === 'PASS');
      let verification = task.verification_json;
      for (let i = 0; i < 3 && typeof verification === 'string'; i += 1) {
        try { verification = JSON.parse(verification); } catch { verification = null; }
      }
      const commit = task.head_commit || verification?.commit;
      if (!passAudit || !commit || verification?.commit !== commit) continue;
      this.store.updateTask(task.id, { status: TaskStatus.PASSED, blocked_reason: '', head_commit: commit, verification_json: verification });
      this.emit({ runId: run.id, projectId: run.project_id, taskId: task.id, type: 'task_reconciled', message: `任务状态按已有证据恢复为 passed（commit ${commit.slice(0, 8)}，审计 ${passAudit.provider} PASS）`, data: { commit, auditId: passAudit.id } });
      reconciled.push(task.id);
    }
    if (!reconciled.length) return { ok: false, reason: '没有可恢复的任务（需要 commit + verification.commit + PASS 审计同时存在）' };
    this.store.updateRun(run.id, { status: RunStatus.RUNNING, stop_reason: '', current_task_id: '' });
    this.kick(run.id);
    return { ok: true, reconciled, runId: run.id };
  }

  // ============================================================
  // 查询
  // ============================================================
  async state() {
    const projects = this.store.listProjects().map((p) => {
      const runs = this.store.listRuns(p.id, 5);
      const latest = runs[0] || null;
      return { ...p, latestRun: latest, runs };
    });
    const totals = this.usage();
    const taskRows = this.store.listTasks({});
    const statusCounts = {};
    for (const t of taskRows) statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    return {
      version: VERSION,
      server: {
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      },
      budget: this.budget(),
      audit: auditProviderStatus(this.config),
      agents: await this.deps.checkAgents(this.config),
      projects,
      runs: this.store.listRuns(null, 12),
      tasks: taskRows.slice(-60),
      taskStatusCounts: statusCounts,
      activeRunIds: [...this.running],
      agentSlots: this.agentSemaphore.stats(),
      usage: totals,
      github: {
        configured: gh.githubConfigured(this.config),
        owner: this.config.github.owner || '',
        autoCreateRepo: this.config.github.autoCreateRepo,
        note: gh.githubConfigured(this.config) ? 'GitHub Token 已配置' : '未配置 GITHUB_TOKEN：阶段三 Push/PR/CI 会记录为待授权',
      },
      approvals: this.store.listApprovals({ status: 'pending' }),
      verification: {
        ciRequiredByDefault: true,
        note: '远端验收需要 CI_PASSED 且绑定 commit SHA；本地验收需显式确认',
      },
      policy: {
        neverMerge: this.config.policy.neverMerge,
        autoPush: this.config.policy.autoPush,
        protectedPaths: this.config.policy.protectedPaths,
        maxAttempts: this.config.budget.maxAttempts,
        allowUnsafeAgentPermissions: this.config.security.allowUnsafeAgentPermissions,
      },
    };
  }

  runDetail(runId) {
    const run = this.store.getRun(runId);
    if (!run) return null;
    const project = this.store.getProject(run.project_id);
    const plan = this.store.getPlan(run.plan_id);
    const tasks = this.store.listTasks({ planId: run.plan_id }).map((t) => {
      const audits = this.store.listAudits(t.id);
      const attempts = this.store.listAttempts(t.id);
      return {
        ...t,
        audits: audits.map((a) => ({ ...a, criteria: a.criteria_json, findings: a.findings_json, requiredFixes: a.required_fixes_json })),
        attempts: attempts.map((a) => ({
          id: a.id,
          attempt_no: a.attempt_no,
          stage: a.stage,
          agent_kind: a.agent_kind,
          status: a.status,
          tokens: Number(a.tokens_in) + Number(a.tokens_out) + Number(a.tokens_cache),
          cost_cny: a.cost_cny,
          duration_ms: a.duration_ms,
          error: a.error,
          created_at: a.created_at,
        })),
        artifacts: this.store.listArtifacts(t.id),
      };
    });
    const events = this.store.listEvents({ runId, limit: 300 });
    return {
      ...run,
      budget_json: run.budget_json,
      spent_json: run.spent_json,
      result_json: run.result_json,
      project,
      plan,
      tasks,
      actions: this.store.listActions(runId),
      approvals: this.store.listApprovals({ runId }),
      events,
      budget: this.budget(),
    };
  }

  taskDetail(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const attempts = this.store.listAttempts(taskId).map((a) => ({ ...a, prompt: a.prompt }));
    const audits = this.store.listAudits(taskId);
    const artifacts = this.store.listArtifacts(taskId).map((a) => {
      let content = '';
      try {
        const rel = String(a.path || '').replace(/\\/g, '/');
        if (!rel.startsWith('artifacts/')) throw new Error('not artifact');
        const abs = resolveWithin(this.config.paths.artifactsDir, rel.slice('artifacts/'.length));
        if (fs.existsSync(abs) && fs.statSync(abs).size <= 5 * 1024 * 1024) content = truncate(fs.readFileSync(abs, 'utf8'), 120_000);
      } catch {
        content = '（读取失败）';
      }
      return { ...a, content };
    });
    return { ...task, attempts, audits, artifacts, project: this.store.getProject(task.project_id) };
  }

  artifactContent(relPath) {
    const normalized = String(relPath || '').replace(/\\/g, '/');
    if (!normalized.startsWith('artifacts/')) {
      throw new PolicyError('ARTIFACT_FORBIDDEN', '只允许读取已登记的 artifacts/ 产物');
    }
    const abs = resolveWithin(this.config.paths.artifactsDir, normalized.slice('artifacts/'.length));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new PolicyError('ARTIFACT_MISSING', '产物不存在');
    const size = fs.statSync(abs).size;
    if (size > 5 * 1024 * 1024) throw new PolicyError('ARTIFACT_TOO_LARGE', '产物超过 5MB，拒绝在线打开');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) throw new PolicyError('ARTIFACT_BINARY', '二进制产物不允许在线查看');
    return buf.toString('utf8');
  }

  decideApproval(id, { decision, decidedBy = 'human' }) {
    const approval = this.store.getApproval(id);
    if (!approval) throw new PolicyError('APPROVAL_NOT_FOUND', `审批项不存在：${id}`);
    if (!['approved', 'rejected'].includes(decision)) throw new PolicyError('APPROVAL_DECISION_INVALID', 'decision 必须是 approved 或 rejected');
    const updated = this.store.updateApproval(id, {
      status: decision,
      decided_at: nowIso(),
      decided_by: String(decidedBy || 'human'),
    });
    this.emit({
      runId: approval.run_id,
      projectId: '',
      type: 'approval_decided',
      message: `审批项「${approval.title}」已${decision === 'approved' ? '批准' : '拒绝'}（不会自动合并主分支）`,
      data: { approvalId: id, type: approval.type, decision },
    });
    return updated;
  }

  async agentsStatus() {
    return this.deps.checkAgents(this.config);
  }
}

// ============================================================
// 辅助函数
// ============================================================
function detectTestCommand(localPath) {
  const pkgFile = path.join(localPath, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) {
        if (fs.existsSync(path.join(localPath, 'pnpm-lock.yaml'))) return 'pnpm test';
        if (fs.existsSync(path.join(localPath, 'yarn.lock'))) return 'yarn test';
        return 'npm test';
      }
    } catch {
      /* ignore */
    }
  }
  if (fs.existsSync(path.join(localPath, 'pyproject.toml')) || fs.existsSync(path.join(localPath, 'pytest.ini'))) return 'python3 -m pytest -q';
  if (fs.existsSync(path.join(localPath, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(localPath, 'Cargo.toml'))) return 'cargo test';
  return '';
}

function detectLanguage(localPath) {
  if (fs.existsSync(path.join(localPath, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(localPath, 'pyproject.toml'))) return 'python';
  if (fs.existsSync(path.join(localPath, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(localPath, 'Cargo.toml'))) return 'rust';
  return 'unknown';
}

function validAgentKind(value) {
  return ['auto', 'dsh', 'claude', 'custom'].includes(String(value)) ? String(value) : 'auto';
}

function validAuditProvider(value) {
  return ['auto', 'openai', 'glm', 'deepseek', 'dsh'].includes(String(value)) ? String(value) : 'auto';
}

async function enforceProtectedPaths(worktree, violations) {
  // 已跟踪文件：恢复到 HEAD；未跟踪文件：删除
  await gitops.git(worktree, ['reset', '--', ...violations], { allowFail: true });
  await gitops.git(worktree, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...violations], { allowFail: true });
  await gitops.git(worktree, ['clean', '-fd', '--', ...violations], { allowFail: true });
  await gitops.stageAll(worktree);
}

function buildAuditFeedback(audit) {
  const failed = (audit.criteria || []).filter((c) => c.status !== 'pass');
  const findings = (audit.findings || []).filter((f) => String(f.severity || '').toLowerCase() !== 'low');
  const lines = [
    `独立审计未通过（${audit.provider}/${audit.model}，得分 ${audit.score}）。`,
    failed.length ? '未满足的验收标准：' : '',
    ...failed.map((c) => `- ${c.criterion}（状态：${c.status}${c.evidence ? `；证据：${c.evidence}` : ''}）`),
    findings.length ? '审计发现的问题：' : '',
    ...findings.map((f) => `- [${f.severity}] ${f.file ? f.file + (f.line ? ':' + f.line : '') + ' ' : ''}${f.issue || ''}`),
    audit.requiredFixes?.length ? '必须完成的修复：' : '',
    ...(audit.requiredFixes || []).map((f, i) => `${i + 1}. ${f}`),
    '请逐条修复后重新自测。禁止通过修改测试或删除验收来绕过。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

function coderFamilyFor(agentId, config) {
  if (agentId === 'dsh') return 'deepseek';
  if (agentId === 'claude') return modelFamily('glm', config.agents.claude.model || '');
  if (agentId === 'openai') return 'openai';
  return 'unknown';
}

function parseGithubRemote(url) {
  const u = String(url || '').trim();
  let m = u.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

function slugForRepo(name) {
  return String(name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}

export { VERSION };
