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
import { runAudit, auditSummaryText, auditProviderStatus, resolveAuditProvider } from './auditors/index.js';
import { deriveClausePlan } from './quality.js';
import { dshAuditAvailable } from './auditors/dsh.js';
import { chooseAgent, checkAllAgents, runAgent } from './agents/index.js';
import { AsyncSemaphore } from './semaphore.js';
import * as gh from './github.js';
import {
  assertSafeTestCommand, buildTestEnv, hashText, resolveAgentPermission, resolveWithin,
  tmpHomeFor, WriteRateLimiter, isAllowedHost, assertSafeWriteRequest, redactForResponse,
} from './security.js';

const VERSION = '2.9.0';

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
      remainingTokens: used.glmUnlimited ? Math.max(0, cfg.maxTotalTokens - effectiveUsed) : Math.max(0, cfg.maxTotalTokens - effectiveUsed),
      remainingCostCny: Math.max(0, cfg.maxCostCny - used.budgetCostCny),
      tokensPercent: Math.min(100, Math.round((effectiveUsed / cfg.maxTotalTokens) * 1000) / 10),
      costPercent: Math.min(100, Math.round((used.budgetCostCny / cfg.maxCostCny) * 1000) / 10),
      breakdown: used,
      note: '仅当实际模型供应商被识别为 GLM 时豁免工作台 token/费用上限；未知供应商不豁免；其余模型仍受原预算（缓存按权重折算）约束',
      identityPolicy: 'provider identity: glm(exempt) / deepseek / openai / anthropic / unknown(not exempt)',
    };
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
    const configPatch = {};
    if (patch.allowedTestCommands !== undefined || patch.allowed_test_commands !== undefined) configPatch.allowed_test_commands = parseList(patch.allowedTestCommands ?? patch.allowed_test_commands);
    if (patch.testEnvAllowlist !== undefined || patch.test_env_allowlist !== undefined) configPatch.test_env_allowlist = parseList(patch.testEnvAllowlist ?? patch.test_env_allowlist);
    if (patch.agentPermission !== undefined || patch.agent_permission !== undefined) configPatch.agent_permission = patch.agentPermission ?? patch.agent_permission;
    if (patch.testTimeoutMs !== undefined || patch.test_timeout_ms !== undefined) configPatch.test_timeout_ms = Number(patch.testTimeoutMs ?? patch.test_timeout_ms);
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
    if (patch.replayAssets !== undefined || patch.replay_assets !== undefined) configPatch.replay_assets = patch.replayAssets ?? patch.replay_assets;
    if (patch.publish !== undefined) configPatch.publish = !!patch.publish;
    if (Object.keys(configPatch).length) mapped.config_json = { ...(project.config_json || {}), ...configPatch };
    return this.store.updateProject(projectId, mapped);
  }

  // ============================================================
  // 运行创建
  // ============================================================
  async startRun(input) {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new PolicyError('PROJECT_NOT_FOUND', `项目不存在：${input.projectId}`);
    const goal = String(input.goal || '').trim();
    if (!goal) throw new PolicyError('GOAL_REQUIRED', '请填写开发目标');
    const mode = input.mode === 'plan' ? 'plan' : 'single';
    const acceptance = parseList(input.acceptance);
    const requestKey = String(input.requestKey || '').trim();

    // P0-2：同一请求键的 Run 只能创建一次；崩溃恢复/重复调用返回已有 Run。
    if (requestKey) {
      const existing = this.store.getRunByRequestKey(requestKey);
      if (existing) return { runId: existing.id, planId: existing.plan_id, existing: true };
    }

    this.assertBudget(5_000);

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
    const runId = newId('run');
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
    let planResult;
    try {
      planResult = await planTasks({
        config: this.config,
        project,
        goal,
        acceptance,
        mode,
        tasks: input.tasks,
      });
    } catch (err) {
      this.releaseProjectLease(project.id);
      throw err;
    }

    try {
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

    if (planResult.usage) {
      this.recordLlmUsage({
        runId,
        source: 'planning',
        provider: planResult.plannerMeta?.provider,
        model: planResult.plannerMeta?.model,
        usage: planResult.usage,
        costCny: planResult.costCny || 0,
      });
    }
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
            this.pauseRun(runId, err.message, kind);
            break;
          }
        }
        if (!task) {
          await this.finalizeRun(run);
          break;
        }
        this.store.updateRun(runId, { current_task_id: task.id });
        const result = await this.runTask(run, task, controller.signal);
        if (!result.ok) {
          const latest = this.store.getRun(runId);
          if (!latest || latest.status !== RunStatus.RUNNING) break;
          if (controller.signal.aborted) break;
          this.pauseRun(runId, result.reason || '任务失败，等待人工处理', 'task_failed');
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
    if (agentResult.stalled) return 'stalled';
    if (agentResult.timedOut) return 'agent_timeout';
    if (agentResult.aborted) return 'agent_aborted';
    if (/token 预算|超出单任务 token|budget/i.test(err)) return 'budget';
    if (/未返回可解析|未正常完成|连续未产生|no changes|结构化结果/i.test(err)) return 'agent_no_output';
    if (/权限|permission|ISOLATION|CONTAINER_UNAVAILABLE/i.test(err)) return 'infrastructure';
    return 'agent_error';
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
      const status = await gitops.statusPorcelain(worktree);
      const numstat = await gitops.git(worktree, ['diff', '--numstat'], { allowFail: true });
      const changed = String(status || '').split('\n').filter(Boolean).length;
      let lines = 0;
      for (const line of String(numstat?.stdout || '').split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        lines += Number(parts[0] || 0) + Number(parts[1] || 0);
      }
      return `${changed}:${lines}`;
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
    const threshold = Math.max(1_000, Number(stallTimeoutMs || this.config.agents.stallTimeoutMs || 180_000));
    let lastSignal = await this.worktreeProgressSignal(worktree);
    let lastProgressAt = Date.now();
    let eventCount = 0;
    let stalled = false;
    const intervalMs = Math.max(5_000, Math.floor(threshold / 4));
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

  async runProjectTest({ project, worktree, command, timeoutMs, logPath, signal = null }) {
    const runOnce = async (cmd, pathName) => {
      if (this.containerTestRequested(project)) {
        const caps = containerCapabilities(this.config);
        if (!caps.testExecution) {
          throw new PolicyError('CONTAINER_UNAVAILABLE', `项目要求容器测试，但 Docker/镜像不可用：${caps.image.reason || caps.docker.reason || 'unknown'}（fail-closed，不降级）`);
        }
        return runTestInContainer({ config: this.config, worktree, command: cmd, env: this.containerTestEnv(project), timeoutMs, logPath: pathName, signal });
      }
      const sandbox = tmpHomeFor(this.config, `local-${newId('run')}`, newId('task'));
      return execShell(cmd, {
        cwd: worktree,
        timeoutMs,
        logPath: pathName,
        env: buildTestEnv({ config: this.config, project, homeDir: path.join(sandbox, 'test-home') }),
      });
    };
    let res = await runOnce(command, logPath);
    // P1-2：测试命令因缺少项目依赖而失败（典型 exit=127，如 vitest/npm 不可执行）时，
    // 若项目显式配置 test_setup_command，先执行环境准备再重试一次；不修改产品业务代码。
    const setup = String(project?.config_json?.test_setup_command || '').trim();
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
    return res;
  }

  async runTask(run, task, signal) {
    const project = this.store.getProject(task.project_id);
    const plan = this.store.getPlan(task.plan_id);
    const runShort = run.id.slice(-6);
    const planBranch = `wb/plan-${runShort}`;
    const maxAttempts = Number(task.max_attempts || this.config.budget.maxAttempts);
    const protectedPaths = protectPathsForProject(project, this.config);
    const sandboxHome = tmpHomeFor(this.config, run.id, task.id);
    let sessionId = task.session_id || '';
    let feedback = '';
    let lastTest = null;
    let lastAudit = null;
    let lastAgent = null;
    let changedFiles = [];

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
      await gitops.git(project.local_path, ['branch', '-D', branch], { allowFail: true });
      const worktree = path.join(this.config.paths.worktreesDir, project.id, run.id, `task-${task.seq}`);
      await gitops.createWorktree(project.local_path, worktree, branch, base);
      const baseCommit = await gitops.currentHead(worktree);
      this.store.updateTask(task.id, { status: TaskStatus.PREPARING, worktree_path: worktree, branch, base_commit: baseCommit });
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'worktree_ready', message: `工作副本就绪：${branch}`, data: { worktree, baseCommit, planBranch } });

      const agentCandidates = await this.resolveAgentCandidates(project, task);
      if (!agentCandidates.length) {
        return this.failTask(run, task, '没有可用的 Coding Agent（请检查 DSH / Claude Code 配置）', 'blocked');
      }
      let candidateIndex = 0;
      let agentSwitches = 0;
      for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
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
        const agentIdentity = resolveAgentIdentity({ config: this.config, agentId, project });
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
          agentContainer = { network: project.config_json?.container_agent_network || this.config.isolation?.container?.networkAgent || 'bridge' };
        }
        const release = await this.agentSemaphore.acquire();
        let agentResult;
        try {
          const remaining = this.budget().remainingTokens;
          const projectTaskCap = Number(project.budget_json?.max_tokens_per_task || 0);
          const perTaskCap = projectTaskCap > 0 ? projectTaskCap : this.config.budget.maxTokensPerTask;
          const perTaskTokens = agentIdentity.exempt ? 0 : Math.min(perTaskCap, Math.max(15_000, remaining - 25_000));
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
              timeoutMs: agentId === 'claude' ? this.config.agents.claude.timeoutMs : this.config.agents.dsh.timeoutMs,
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
        }
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
          const canSwitch = ['stalled', 'agent_timeout', 'agent_aborted', 'agent_no_output', 'infrastructure', 'agent_error', 'budget'].includes(failureClass);
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

        // ---- 指纹：确保审计/测试/提交是同一版本 ----
        await gitops.stageAll(worktree);
        const testedHash = (await gitops.git(worktree, ['write-tree'])).stdout.trim();
        this.store.updateTask(task.id, { status: TaskStatus.TESTING, verification_json: { baseCommit, testedHash } });

        const testCommand = this.resolveTaskTestCommand(project, task);
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
        });
        lastTest = {
          command: safeCommand, code: testRes.code, timedOut: testRes.timedOut,
          durationMs: testRes.durationMs, stdout: testRes.stdout, stderr: testRes.stderr,
          isolation: testRes.isolation || null,
          setupRetried: !!testRes.setupRetried, setupCommand: testRes.setupCommand || '', setupLogPath: testRes.setupLogPath || '', setupFailed: !!testRes.setupFailed,
        };
        this.writeArtifact({
          runId: run.id, taskId: task.id, kind: 'test', filename: `attempt-${attemptNo}-test.txt`,
          content: `$ ${safeCommand}\nexit=${testRes.code} duration=${testRes.durationMs}ms\n${testRes.isolation ? `isolation=${JSON.stringify(testRes.isolation)}\n` : ''}\n[stdout]\n${testRes.stdout}\n\n[stderr]\n${testRes.stderr}`,
        });
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
        let auditCommit = '';
        let provisionalCommit = null;
        try {
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
            signal,
          });
        } catch (err) {
          const message = redact(`独立审计无法完成：${err?.message || err}`, this.config);
          this.writeArtifact({ runId: run.id, taskId: task.id, kind: 'audit-error', filename: `attempt-${attemptNo}-audit-error.txt`, content: message });
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'audit_error', level: 'error', message });
          return this.failTask(run, task, `${message}（不伪造审计结论）`, 'blocked');
        }
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
          this.store.updateTask(task.id, { status: TaskStatus.COMMITTING });
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

  resolveTaskTestCommand(project, task) {
    const projectConfig = project.config_json || {};
    const allowed = new Set([project.test_command, ...(projectConfig.allowed_test_commands || [])].map((s) => String(s || '').trim()).filter(Boolean));
    const requested = String(task.test_command || '').trim();
    if (requested && allowed.has(requested)) return requested;
    if (requested) {
      this.emit({ runId: task.run_id, projectId: project.id, taskId: task.id, type: 'test_command_fallback', level: 'warn', message: `任务测试命令未在项目 allowlist 中，已回退到项目默认测试命令：${requested}` });
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

    const planBranch = `wb/plan-${run.id.slice(-6)}`;
    const planHead = await gitops.branchRef(project.local_path, planBranch);
    if (!planHead) {
      this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: '计划分支不存在，无法绑定验证 commit' });
      this.emit({ runId: run.id, type: 'run_paused', level: 'error', message: '计划分支不存在，无法绑定验证 commit' });
      return;
    }

    const projectConfig = project.config_json || {};
    const wantRemote = project.remote_push_authorized === 1 && projectConfig.publish !== false;
    const ciRequired = project.ci_required === 1 && wantRemote;
    let publish = { blocked: [], pr: null, localOnly: true, planBranch, planHead, ci: null };
    if (wantRemote || (projectConfig.publish !== false && this.config.github.token && project.remote_push_authorized === 1)) {
      publish = await this.publishRun(run, project, planBranch, planHead, tasks);
    } else if (!wantRemote) {
      const reason = project.remote_push_authorized !== 1 ? '项目未授权远端推送（remote_push_authorized=false），不创建 GitHub PR' : '项目配置关闭远端发布';
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

  pauseRun(runId, reason, kind = 'manual') {
    const run = this.store.getRun(runId);
    if (!run) return null;
    this.ensureControlLease(run.project_id);
    const controller = this.controllers.get(runId);
    if (controller) controller.abort();
    const stopped = this.store.updateRun(runId, {
      status: RunStatus.PAUSED,
      stop_reason: redact(reason || '已暂停', this.config),
    });
    this.emit({
      runId,
      projectId: run.project_id,
      type: 'run_paused',
      level: kind === 'manual' ? 'info' : 'warn',
      message: `运行已暂停：${redact(reason || '人工暂停', this.config)}`,
      data: { kind },
    });
    if (!controller) this.releaseProjectLease(run.project_id);
    return stopped;
  }

  async resumeRun(runId, { retryFailed = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    if ([RunStatus.ACCEPTED, RunStatus.CANCELLED].includes(run.status)) {
      throw new PolicyError('RUN_CLOSED', `运行已结束（${run.status}），不能恢复`);
    }
    this.ensureControlLease(run.project_id);
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
      const needReset = intermediate || (retryFailed && [TaskStatus.FAILED, TaskStatus.BLOCKED].includes(task.status));
      if (!needReset) continue;
      if (task.worktree_path) {
        await gitops.removeWorktree(resumeProject?.local_path || '', task.worktree_path).catch(() => {});
        try {
          fs.rmSync(task.worktree_path, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      this.store.updateTask(task.id, {
        status: TaskStatus.QUEUED,
        attempt: 0,
        blocked_reason: '',
        worktree_path: '',
        head_commit: '',
        result_json: {},
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
    this.store.updateRun(runId, { budget_json: refreshedBudget, wall_deadline: newDeadline, verification_status: 'LOCAL_VERIFIED', ci_status: '', ci_url: '', ci_checked_at: '' });
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
    if (!this._verificationLocks) this._verificationLocks = new Set();
    if (this._verificationLocks.has(task.id)) throw new PolicyError('VERIFICATION_IN_PROGRESS', '该任务已有验证重试在进行中，拒绝并发重复验证（防止审计/提交竞态）');
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
    this.store.updateRun(run.id, { status: RunStatus.RUNNING, stop_reason: '', current_task_id: task.id });
    this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'verification_retry_started', message: '复用现有工作副本，仅重试测试与独立审计' });
    try {
      await gitops.stageAll(worktree);
      const testedHash = (await gitops.git(worktree, ['write-tree'])).stdout.trim();
      this.store.updateTask(task.id, { status: TaskStatus.TESTING, verification_json: { baseCommit, testedHash, verificationRetry: true } });
      const testCommand = this.resolveTaskTestCommand(project, task);
      const safeCommand = assertSafeTestCommand(testCommand, project);
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_started', message: `运行测试：${safeCommand}`, data: { command: safeCommand, testedHash } });
      const testRes = await this.runProjectTest({
        project,
        worktree,
        command: safeCommand,
        timeoutMs: Number(project.config_json?.test_timeout_ms || this.config.policy.testTimeoutMs),
        logPath: path.join(logDir, `verify-${Date.now()}-test.log`),
      });
      const testResult = { command: safeCommand, code: testRes.code, timedOut: testRes.timedOut, durationMs: testRes.durationMs, stdout: testRes.stdout, stderr: testRes.stderr, isolation: testRes.isolation || null, setupRetried: !!testRes.setupRetried, setupCommand: testRes.setupCommand || '', setupLogPath: testRes.setupLogPath || '', setupFailed: !!testRes.setupFailed };
      this.writeArtifact({ runId: run.id, taskId: task.id, kind: 'test', filename: `verify-${Date.now()}-test.txt`, content: `$ ${safeCommand}\nexit=${testRes.code} duration=${testRes.durationMs}ms\n\n[stdout]\n${testRes.stdout}\n\n[stderr]\n${testRes.stderr}` });
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
      const diff = await gitops.stagedDiff(worktree, baseCommit, { maxChars: 1_000_000 });
      const diffStat = await gitops.diffStat(worktree, baseCommit);
      const repoFiles = await gitops.listTree(worktree, 'HEAD', { max: 150 });
      const lastAttempt = this.store.listAttempts(task.id).filter((a) => a.stage === 'coding').slice(-1)[0];
      const coderFamily = coderFamilyFor(lastAttempt?.agent_kind || task.agent_kind || 'dsh', this.config);
      this.store.updateTask(task.id, { status: TaskStatus.AUDITING });
      this.assertBudget(8_000);
      const contextFiles = await this.collectAuditContext(worktree);
      const audit = await this.deps.runAudit({
        config: this.config, project, task: { ...task, acceptance_json: task.acceptance_json },
        diff, diffStat, testResult, repoFiles, coderFamily, contextFiles,
        versionInfo: { baseCommit, worktreeHash: testedHash, testedHash }, worktree, commit: '',
      });
      const auditStatus = audit.status || (audit.verdict === 'pass' ? 'PASS' : 'FAIL');
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
      this.store.updateTask(task.id, { status: TaskStatus.COMMITTING });
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
      const verification = {
        baseCommit, testedHash, commit: headCommit, planBranch, testCommand: safeCommand, isolation: isolationWarning ? { mode: isolationMode, warning: isolationWarning } : { mode: isolationMode },
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
      const reason = redact(`验证重试失败：${err?.message || err}`, this.config);
      this.store.updateTask(task.id, { status: TaskStatus.BLOCKED, blocked_reason: reason });
      this.store.updateRun(run.id, { status: RunStatus.PAUSED, stop_reason: reason });
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'audit_error', level: 'error', message: reason });
      return { ok: false, reason };
    } finally {
      this._verificationLocks.delete(task.id);
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
