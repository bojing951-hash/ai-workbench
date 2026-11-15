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
import { buildRepoContext, planTasks } from './planner.js';
import { runAudit, auditSummaryText, auditProviderStatus, resolveAuditProvider } from './auditors/index.js';
import { chooseAgent, checkAllAgents, runAgent } from './agents/index.js';
import { AsyncSemaphore } from './semaphore.js';
import * as gh from './github.js';
import {
  assertSafeTestCommand, buildTestEnv, hashText, resolveAgentPermission, resolveWithin,
  tmpHomeFor, WriteRateLimiter, isAllowedHost, assertSafeWriteRequest, redactForResponse,
} from './security.js';

const VERSION = '2.1.0';

export class Orchestrator {
  constructor({ config, store, bus, deps = {} }) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.running = new Set();
    this.controllers = new Map();
    this.agentSemaphore = new AsyncSemaphore(config.budget.maxAgentConcurrency || 2);
    this.startedAt = Date.now();
    // 依赖注入（仅用于测试/扩展；生产环境使用真实 Agent 与审计器）
    this.deps = {
      runAgent: deps.runAgent || runAgent,
      chooseAgent: deps.chooseAgent || chooseAgent,
      runAudit: deps.runAudit || runAudit,
      checkAgents: deps.checkAgents || checkAllAgents,
    };
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
    const attempt = this.store.createAttempt({
      id: newId('att'),
      runId,
      taskId,
      attemptNo: 0,
      stage: source,
      agentKind: source,
      provider: provider || 'unknown',
      model: model || '',
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
      if (exempt.has(String(name).toLowerCase())) continue;
      budgetTokens += Number(agg.tokensIn || 0) + Number(agg.tokensOut || 0) + Number(agg.tokensCache || 0) * weight;
      budgetCostCny += Number(agg.costCny || 0);
    }
    const glm = byProvider.glm || { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0 };
    const nonGlm = Object.entries(byProvider).reduce((acc, [name, agg]) => {
      if (exempt.has(String(name).toLowerCase())) return acc;
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
      usedTokens: used.tokens,
      usedBudgetTokens: Math.round(effectiveUsed),
      cacheTokenWeight: used.cacheTokenWeight,
      glmUnlimited: used.glmUnlimited,
      exemptProviders: used.exemptProviders,
      glm: used.glm,
      nonGlm: used.nonGlm,
      byProvider: used.byProvider,
      maxCostCny: cfg.maxCostCny,
      usedCostCny: Number(used.costCny.toFixed(4)),
      usedBudgetCostCny: Number(used.budgetCostCny.toFixed(4)),
      remainingTokens: used.glmUnlimited ? Math.max(0, cfg.maxTotalTokens - effectiveUsed) : Math.max(0, cfg.maxTotalTokens - effectiveUsed),
      remainingCostCny: Math.max(0, cfg.maxCostCny - used.budgetCostCny),
      tokensPercent: Math.min(100, Math.round((effectiveUsed / cfg.maxTotalTokens) * 1000) / 10),
      costPercent: Math.min(100, Math.round((used.budgetCostCny / cfg.maxCostCny) * 1000) / 10),
      breakdown: used,
      note: 'GLM 模型按用户授权不受工作台 token/费用上限约束，但真实用量与费用完整记录并单列；其余模型仍受原预算（缓存按权重折算）约束',
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
    const active = this.store.listActiveRuns();
    const recovered = [];
    for (const run of active) {
      if (run.status === 'running' || run.status === 'queued') {
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
    const attempts = this.store.markRunningAttemptsInterrupted();
    return { recoveredRuns: recovered, interruptedAttempts: attempts };
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
      contractFiles: parseList(input.contractFiles || input.contract_files),
      ciRequired: input.ciRequired !== false && input.ci_required !== false,
      allowLocalAcceptance: input.allowLocalAcceptance !== false && input.allow_local_acceptance !== false,
      remotePushAuthorized: input.remotePushAuthorized === true || input.remote_push_authorized === true,
      config: {
        publish: input.publish === false ? false : true,
        allowed_test_commands: parseList(input.allowedTestCommands || input.allowed_test_commands || input.testCommand || input.test_command),
        test_env_allowlist: parseList(input.testEnvAllowlist || input.test_env_allowlist),
        agent_permission: input.agentPermission || input.agent_permission || '',
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

    this.assertBudget(5_000);

    const busy = this.store.activeRunForProject(project.id);
    if (busy) {
      throw new PolicyError('PROJECT_BUSY', `项目已有未完成的运行（${busy.id}，状态 ${busy.status}），同一项目同一时间只允许一个写入运行；请先恢复或取消它`);
    }
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

    // 先做规划（LLM 调用），失败不创建半成品运行
    const planResult = await planTasks({
      config: this.config,
      project,
      goal,
      acceptance,
      mode,
      tasks: input.tasks,
    });

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
    });
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

    this.emit({
      runId,
      projectId: project.id,
      type: 'run_created',
      message: `已创建运行：${mode === 'plan' ? `自动规划 ${taskRows.length} 个任务` : '单任务执行'}`,
      data: { planId, mode, taskCount: taskRows.length, planner: planResult.plannerMeta },
    });

    this.kick(runId);
    return { runId, planId, tasks: taskRows.length, projectId: project.id };
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
    this.running.add(runId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
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
        try {
          assertRunWallClock(run, this.config.budget.runWallClockMs);
          this.assertBudget(8_000);
          const project = this.store.getProject(run.project_id);
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
        const task = this.store.nextQueuedTask(run.plan_id);
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
      this.running.delete(runId);
      this.controllers.delete(runId);
    }
  }

  // ============================================================
  // 单任务流水线
  // ============================================================
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

      const base = await this.ensurePlanBranch(project, planBranch);
      const branch = `wb/r${runShort}/t${task.seq}`;
      await gitops.git(project.local_path, ['branch', '-D', branch], { allowFail: true });
      const worktree = path.join(this.config.paths.worktreesDir, project.id, run.id, `task-${task.seq}`);
      await gitops.createWorktree(project.local_path, worktree, branch, base);
      const baseCommit = await gitops.currentHead(worktree);
      this.store.updateTask(task.id, { status: TaskStatus.PREPARING, worktree_path: worktree, branch, base_commit: baseCommit });
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'worktree_ready', message: `工作副本就绪：${branch}`, data: { worktree, baseCommit, planBranch } });

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

        const agentId = await this.deps.chooseAgent(this.config, project, task);
        if (!agentId) {
          return this.failTask(run, task, '没有可用的 Coding Agent（请检查 DSH / Claude Code 配置）', 'blocked');
        }
        let permission;
        try {
          permission = resolveAgentPermission(this.config, agentId, project);
        } catch (err) {
          return this.failTask(run, task, `Agent 权限策略拒绝执行：${err.message}`, 'blocked');
        }
        this.assertBudget(10_000);
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

        const release = await this.agentSemaphore.acquire();
        let agentResult;
        try {
          const remaining = this.budget().remainingTokens;
          const projectTaskCap = Number(project.budget_json?.max_tokens_per_task || 0);
          const perTaskCap = projectTaskCap > 0 ? projectTaskCap : this.config.budget.maxTokensPerTask;
          const perTaskTokens = Math.min(perTaskCap, Math.max(15_000, remaining - 25_000));
          agentResult = await this.deps.runAgent(agentId, {
            config: this.config,
            project,
            prompt,
            cwd: worktree,
            sessionId,
            timeoutMs: agentId === 'claude' ? this.config.agents.claude.timeoutMs : this.config.agents.dsh.timeoutMs,
            maxTokens: perTaskTokens,
            signal,
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
          });
        } finally {
          release();
        }
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
          provider: agentResult.provider || (agentId === 'claude' ? 'glm' : agentId === 'dsh' ? 'deepseek' : 'unknown'),
          model: agentResult.model || '',
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
          message: agentResult.ok
            ? `编码 Agent 完成（${Math.round((agentResult.durationMs || 0) / 1000)}s，tokens ${usage.total}，费用来源：${agentResult.costReported ? '厂商返回' : '估算'}）`
            : `编码 Agent 失败：${agentResult.error}`,
          data: { agent: agentId, tokens: usage.total, costCny: agentResult.costCny, costReported: !!agentResult.costReported },
        });

        if (!agentResult.ok) {
          feedback = `上一轮 Agent 执行失败：${agentResult.error}。请重新执行任务，确保只通过文件编辑产出可运行代码。`;
          const repeated = this.recordFailure(task, failureSignature({ testTail: agentResult.error }));
          if (repeated >= 1) return this.failTask(run, task, '检测到重复的 Agent 失败签名，停止自动重试，保留证据等待人工诊断', 'blocked');
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
        const testRes = await execShell(safeCommand, {
          cwd: worktree,
          timeoutMs: Number(project.config_json?.test_timeout_ms || this.config.policy.testTimeoutMs),
          logPath: path.join(logDir, `attempt-${attemptNo}-test.log`),
          env: buildTestEnv({ config: this.config, project, homeDir: path.join(sandboxHome, 'test-home') }),
        });
        lastTest = {
          command: safeCommand, code: testRes.code, timedOut: testRes.timedOut,
          durationMs: testRes.durationMs, stdout: testRes.stdout, stderr: testRes.stderr,
        };
        this.writeArtifact({
          runId: run.id, taskId: task.id, kind: 'test', filename: `attempt-${attemptNo}-test.txt`,
          content: `$ ${safeCommand}\nexit=${testRes.code} duration=${testRes.durationMs}ms\n\n[stdout]\n${testRes.stdout}\n\n[stderr]\n${testRes.stderr}`,
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
        this.assertBudget(6_000);
        let audit;
        try {
          const repoFiles = await gitops.listTree(worktree, 'HEAD', { max: 150 });
          const diffStat = await gitops.diffStat(worktree, baseCommit);
          audit = await this.deps.runAudit({
            config: this.config, project,
            task: { ...task, acceptance_json: task.acceptance_json },
            diff, diffStat, testResult: lastTest, repoFiles, coderFamily,
            versionInfo: { baseCommit, worktreeHash: testedHash, testedHash },
            signal,
          });
        } catch (err) {
          const message = redact(`独立审计无法完成：${err?.message || err}`, this.config);
          this.writeArtifact({ runId: run.id, taskId: task.id, kind: 'audit-error', filename: `attempt-${attemptNo}-audit-error.txt`, content: message });
          this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'audit_error', level: 'error', message });
          return this.failTask(run, task, `${message}（不伪造审计结论）`, 'blocked');
        }
        const auditStatus = audit.status || (audit.verdict === 'pass' ? 'PASS' : 'FAIL');
        const auditRow = this.store.createAudit({
          id: newId('aud'), runId: run.id, taskId: task.id, attemptNo,
          provider: audit.provider, model: audit.model,
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
          this.store.updateTask(task.id, { status: TaskStatus.COMMITTING });
          const commitMessage = [
            `feat(task-${task.seq}): ${task.title}`, '',
            ...(task.acceptance_json || []).map((a) => `- 验收：${a}`), '',
            `审计：${audit.provider}/${audit.model} PASS（得分 ${audit.score}）`,
            `测试：${safeCommand} 通过（指纹 ${testedHash.slice(0, 12)}）`,
            '生成：AI 开发工作台 v2.0',
          ].join('\n');
          const commit = await gitops.commitAll(worktree, commitMessage);
          const committedTree = (await gitops.git(worktree, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
          if (commit.empty || committedTree !== testedHash) {
            return this.failTask(run, task, '提交内容与审计/测试版本不一致（指纹校验失败），拒绝推进', 'blocked', { testedHash, committedTree });
          }
          await gitops.updateRef(project.local_path, planBranch, commit.commit || (await gitops.currentHead(worktree)));
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
  pauseRun(runId, reason, kind = 'manual') {
    const run = this.store.getRun(runId);
    if (!run) return null;
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
    return stopped;
  }

  async resumeRun(runId, { retryFailed = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    if ([RunStatus.ACCEPTED, RunStatus.CANCELLED].includes(run.status)) {
      throw new PolicyError('RUN_CLOSED', `运行已结束（${run.status}），不能恢复`);
    }
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
  }

  cancelRun(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
    const controller = this.controllers.get(runId);
    if (controller) controller.abort();
    this.store.updateRun(runId, { status: RunStatus.CANCELLED, stop_reason: '用户取消', ended_at: nowIso() });
    this.emit({ runId, projectId: run.project_id, type: 'run_cancelled', level: 'warn', message: '运行已取消' });
    return this.store.getRun(runId);
  }

  acceptRun(runId, { confirmLocalOnly = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new PolicyError('RUN_NOT_FOUND', `运行不存在：${runId}`);
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
    this.store.updateRun(run.id, { status: RunStatus.RUNNING, stop_reason: '', current_task_id: task.id });
    this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'verification_retry_started', message: '复用现有工作副本，仅重试测试与独立审计' });
    try {
      await gitops.stageAll(worktree);
      const testedHash = (await gitops.git(worktree, ['write-tree'])).stdout.trim();
      this.store.updateTask(task.id, { status: TaskStatus.TESTING, verification_json: { baseCommit, testedHash, verificationRetry: true } });
      const testCommand = this.resolveTaskTestCommand(project, task);
      const safeCommand = assertSafeTestCommand(testCommand, project);
      this.emit({ runId: run.id, projectId: project.id, taskId: task.id, type: 'test_started', message: `运行测试：${safeCommand}`, data: { command: safeCommand, testedHash } });
      const testRes = await execShell(safeCommand, {
        cwd: worktree, timeoutMs: Number(project.config_json?.test_timeout_ms || this.config.policy.testTimeoutMs),
        logPath: path.join(logDir, `verify-${Date.now()}-test.log`),
        env: buildTestEnv({ config: this.config, project, homeDir: path.join(sandboxHome, 'test-home') }),
      });
      const testResult = { command: safeCommand, code: testRes.code, timedOut: testRes.timedOut, durationMs: testRes.durationMs, stdout: testRes.stdout, stderr: testRes.stderr };
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
        versionInfo: { baseCommit, worktreeHash: testedHash, testedHash },
      });
      const auditStatus = audit.status || (audit.verdict === 'pass' ? 'PASS' : 'FAIL');
      const auditRow = this.store.createAudit({
        id: newId('aud'), runId: run.id, taskId: task.id, attemptNo: Number(task.attempt || 0) + 1,
        provider: audit.provider, model: audit.model, verdict: audit.verdict, score: audit.score,
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
      const planBranch = `wb/plan-${run.id.slice(-6)}`;
      const commitMessage = [
        `feat(task-${task.seq}): ${task.title}`, '',
        ...(task.acceptance_json || []).map((a) => `- 验收：${a}`), '',
        `审计：${audit.provider}/${audit.model} PASS（得分 ${audit.score}）`,
        `测试：${safeCommand} 通过（指纹 ${testedHash.slice(0, 12)}）`,
        '生成：AI 开发工作台 v2.0',
      ].join('\n');
      const commit = await gitops.commitAll(worktree, commitMessage);
      const committedTree = (await gitops.git(worktree, ['rev-parse', 'HEAD^{tree}'], { allowFail: true })).stdout.trim();
      if (commit.empty || committedTree !== testedHash) throw new PolicyError('COMMIT_FINGERPRINT_MISMATCH', '提交与测试/审计版本不一致');
      await gitops.updateRef(project.local_path, planBranch, commit.commit || (await gitops.currentHead(worktree)));
      const headCommit = await gitops.currentHead(worktree);
      const verification = {
        baseCommit, testedHash, commit: headCommit, planBranch, testCommand: safeCommand, isolation: isolationWarning ? { mode: isolationMode, warning: isolationWarning } : { mode: isolationMode },
        auditId: auditRow.id, auditStatus, auditProvider: audit.provider, auditModel: audit.model,
        auditScore: audit.score, independence: audit.independence, agent: lastAttempt?.agent_kind || '',
        verificationRetry: true,
      };
      this.store.updateTask(task.id, { status: TaskStatus.PASSED, head_commit: headCommit, verification_json: verification, blocked_reason: '', result_json: { ...verification, criteria: audit.criteria } });
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
  return ['auto', 'openai', 'glm', 'deepseek'].includes(String(value)) ? String(value) : 'auto';
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
