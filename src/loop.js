// SPDX-License-Identifier: Apache-2.0
/**
 * 持续自主研发循环（v2.1）：
 *   goal -> 检查状态/契约 -> Planner 识别下一真实任务 -> 启动编排运行
 *   -> 编码/测试/独立审计/修复 -> 内部验收 -> 更新项目基线与循环历史 -> 下一轮
 * 停止条件：达到最大轮次、没有真实任务、任务失败/阻塞、需要人工授权。
 * 所有状态持久化到 SQLite；进程重启后可恢复。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as gitops from './git.js';
import { nowIso, newId } from './util.js';
import { PolicyError, redact, modelFamily } from './policy.js';
import { planNextTask } from './planner.js';
import { assertModelBudget } from './budget.js';
import { buildCoverageMatrix, qualityConfig, repairTasksFromQuality, runQualityCommand } from './quality.js';

function lastAttemptFamily(loop, store) {
  try {
    const run = loop.current_run_id ? store.getRun(loop.current_run_id) : null;
    const task = run ? store.listTasks({ runId: run.id })[0] : null;
    const attempt = task ? store.listAttempts(task.id).at(-1) : null;
    return attempt?.provider ? modelFamily(attempt.provider, attempt.model || '') : null;
  } catch { return null; }
}

function classifyLoopFailure(evidence = []) {
  const text = evidence.join(' ');
  if (/没有可用的 Coding Agent|Coding Agent.*配置|AGENT_UNAVAILABLE|没有可用.*Agent/i.test(text)) return 'agent_unavailable';
  if (/exit=127|command not found|not found|npm ci|依赖|node_modules/i.test(text)) return 'dependency_or_environment';
  if (/超时|timeout|max_turns|max turns|轮次/i.test(text)) return 'agent_or_audit_timeout';
  if (/审计|DSH|audit/i.test(text)) return 'audit_failure';
  if (/测试|test|vitest|playwright/i.test(text)) return 'test_failure';
  return 'unknown';
}


function contractAcceptanceIncomplete(loop, project, store) {
  let expected = safeJsonArray(project?.config_json?.test_plan?.acceptance || project?.config_json?.test_plan?.acceptance_json || []);
  if (!expected.length && project?.local_path) {
    try { const f = path.join(project.local_path, 'TEST_PLAN.json'); if (fs.existsSync(f)) expected = safeJsonArray(JSON.parse(fs.readFileSync(f, 'utf8')).acceptance); } catch { /* ignore */ }
  }
  if (!expected.length) return null;
  const runId = loop?.current_run_id || [...(loop?.history_json || [])].reverse().find((h) => h?.runId)?.runId;
  const run = runId ? store.getRun(runId) : null;
  const tasks = run ? store.listTasks({ runId: run.id }) : [];
  const norm = (x) => String(x || '').toLowerCase().replace(/[\s，。；：、,.!?！？:;（）()\-—]/g, '');
  const evidence = [];
  for (const task of tasks) {
    if (task.status !== 'passed') continue;
    for (const audit of store.listAudits(task.id)) {
      if (String(audit.verification_status || audit.verdict || '').toUpperCase() !== 'PASS') continue;
      for (const c of safeJsonArray(audit.criteria_json)) {
        if (String(c.status || '').toLowerCase() !== 'pass') continue;
        if (String(c.evidence || '').trim().length < 12) continue;
        evidence.push({ criterion: String(c.criterion || ''), evidence: String(c.evidence || '') });
      }
    }
  }
  const missing = expected.filter((clause) => {
    const n = norm(clause);
    return !evidence.some((e) => { const c = norm(e.criterion); return c && (c.includes(n) || n.includes(c)); });
  });
  return missing.length ? { missing, expected } : null;
}

function loopStillRunning(store, id) { return store.getLoop(id)?.status === 'running'; }

function qualityGateIncomplete(loop, project) {
  const q = qualityConfig(project);
  if (!q) return null;
  const history = Array.isArray(loop?.history_json) ? loop.history_json : [];
  const withQuality = [...history].reverse().find((h) => h && h.quality);
  if (!withQuality) return { reason: '尚未执行质量评估，达到上限不能已完成' };
  if (!withQuality.quality.allPass) return { reason: `质量矩阵未全部 PASS（${withQuality.quality.coverage?.pass || 0}/${withQuality.quality.coverage?.total || 0}）` };
  const queue = Array.isArray(loop?.queue_json) ? loop.queue_json : [];
  if (queue.length) return { reason: `任务队列仍有 ${queue.length} 项未清空（含质量/自动修复）` };
  return null;
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try { const v = JSON.parse(String(value || '[]')); return Array.isArray(v) ? v : []; } catch { return []; }
}

export class LoopManager {
  constructor({ config, store, bus, orchestrator }) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.orchestrator = orchestrator;
    this.timers = new Map();
    this.ticking = new Set();
  }

  snapshot(loop) {
    if (!loop) return null;
    const project = this.store.getProject(loop.project_id);
    return {
      ...loop,
      project: project ? { id: project.id, name: project.name, default_branch: project.default_branch } : null,
      progress: { round: loop.round, maxRounds: loop.max_rounds, percent: loop.max_rounds ? Math.round((loop.round / loop.max_rounds) * 100) : 0 },
    };
  }

  list(projectId = '') {
    return this.store.listLoops({ projectId }).map((l) => this.snapshot(l));
  }

  get(id) {
    return this.snapshot(this.store.getLoop(id));
  }

  async create({ projectId, goal, maxRounds = 3, mode = 'plan', queue = [], contractFiles = [] }) {
    const project = this.store.getProject(projectId);
    if (!project) throw new PolicyError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
    if (!goal || !String(goal).trim()) throw new PolicyError('GOAL_REQUIRED', '循环目标不能为空');
    const active = this.store.listLoops({ projectId, status: 'running' })[0] || this.store.listLoops({ projectId, status: 'paused' })[0];
    if (active) throw new PolicyError('LOOP_ACTIVE', `项目已有活动循环（${active.id}，${active.status}），请先恢复或取消`);
    const quality = qualityConfig(project);
    const requestedRounds = Math.max(1, Math.min(20, Number(maxRounds) || 3));
    const loop = this.store.createLoop({
      id: newId('loop'),
      projectId,
      goal: String(goal).trim(),
      mode: mode === 'queue' ? 'queue' : 'plan',
      maxRounds: quality ? Math.max(requestedRounds, quality.maxCycles + 1) : requestedRounds,
      queue: Array.isArray(queue) ? queue : [],
      contractFiles: Array.isArray(contractFiles) ? contractFiles : [],
      status: 'running',
    });
    this.emit(loop, 'loop_created', `研发循环已启动：目标「${loop.goal}」，最多 ${loop.max_rounds} 轮`);
    this.schedule(loop.id, 1200);
    return this.get(loop.id);
  }

  async pause(id, reason = '人工暂停') {
    const loop = this.store.getLoop(id);
    if (!loop) throw new PolicyError('LOOP_NOT_FOUND', `循环不存在：${id}`);
    if (loop.status !== 'running') return this.get(id);
    let ctrl = false;
    if (this.orchestrator?.ensureControlLease) { this.orchestrator.ensureControlLease(loop.project_id); ctrl = true; }
    try {
      const current = loop.current_run_id ? this.store.getRun(loop.current_run_id) : null;
      if (current && ['running', 'queued'].includes(current.status)) {
        if (!this.orchestrator?.pauseRun) throw new PolicyError('ORCHESTRATOR_UNAVAILABLE', '无法安全暂停：编排器不可用');
        const paused = await this.orchestrator.pauseRun(current.id, reason, 'manual');
        if (!paused || !['paused', 'interrupted', 'failed', 'cancelled', 'awaiting_acceptance'].includes(paused.status)) {
          throw new PolicyError('PAUSE_NOT_CONFIRMED', `运行 ${current.id} 未确认停止，不能显示已暂停`);
        }
      }
      this.store.updateLoop(id, { status: 'paused', stop_reason: reason });
      this.emit(loop, 'loop_paused', `研发循环已暂停（Agent/运行已停止确认）：${reason}`, 'warn');
      return this.get(id);
    } finally { if (ctrl) this.orchestrator.releaseProjectLease(loop.project_id); }
  }

  async cancel(id, reason = '人工取消') {
    const loop = this.store.getLoop(id);
    if (!loop) throw new PolicyError('LOOP_NOT_FOUND', `循环不存在：${id}`);
    this.store.updateLoop(id, { status: 'cancelled', stop_reason: reason });
    this.emit(loop, 'loop_cancelled', `研发循环已取消：${reason}`, 'warn');
    return this.get(id);
  }

  async resume(id, { retryCurrent = false, authorizeBudget = false } = {}) {
    const loop = this.store.getLoop(id);
    if (!loop) throw new PolicyError('LOOP_NOT_FOUND', `循环不存在：${id}`);
    if (['completed', 'cancelled'].includes(loop.status)) throw new PolicyError('LOOP_CLOSED', `循环已结束：${loop.status}`);
    let ctrl = false;
    if (this.orchestrator?.ensureControlLease) { this.orchestrator.ensureControlLease(loop.project_id); ctrl = true; }
    try {
    const current = loop.current_run_id ? this.store.getRun(loop.current_run_id) : null;
    if (current && ['interrupted', 'paused'].includes(current.status)) {
      if (!this.orchestrator?.resumeRun) throw new PolicyError('ORCHESTRATOR_UNAVAILABLE', '无法恢复：编排器不可用');
      // 预算/超时暂停必须明确授权；不根据“继续开发”自动解除。
      const resumed = await this.orchestrator.resumeRun(current.id, { retryFailed: retryCurrent === true, authorizeBudget });
      if (!resumed || !['running', 'queued', 'awaiting_acceptance'].includes(resumed.status)) {
        throw new PolicyError('RESUME_NOT_CONFIRMED', `运行 ${current.id} 未确认恢复（当前 ${resumed?.status || 'missing'}）`);
      }
    }
    this.store.updateLoop(id, { status: 'running', stop_reason: '' });
    this.emit(loop, 'loop_resumed', `研发循环已恢复（运行 ${current?.id || '无'} 状态已确认）`);
    this.schedule(id, 800);
    return this.get(id);
    } finally { if (ctrl) this.orchestrator.releaseProjectLease(loop.project_id); }
  }

  /** 启动时把未完成的循环标记为 interrupted，等待人工/API 恢复。 */
  recover() {
    // P0-2：先对账 pending 认领，再处理循环状态；崩溃在 startRun 前后都不能丢/重复任务。
    const pendingRecovered = [];
    const ownerAliveForLoop = (owner) => {
      const m = String(owner || '').match(/^wb:(\d+):/);
      if (!m) return false;
      try { process.kill(Number(m[1]), 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
    };
    for (const lp of this.store.listLoopsWithPending()) {
      try {
        const pj = this.store.getProject(lp.project_id);
        const lease = pj ? this.store.getProjectLease(pj.id) : null;
        if (lease?.write_owner && lease.lease_expires_at > new Date().toISOString() && ownerAliveForLoop(lease.write_owner)) {
          this.emit(lp, 'loop_pending_recovery_skipped', 'pending 由另一个活 Workbench 进程持有，本进程跳过恢复', 'warn');
          continue;
        }
        const rec = this.store.recoverLoopPending(lp.id);
        if (rec.changed) {
          pendingRecovered.push({ loopId: lp.id, ...rec });
          this.emit(lp, 'loop_pending_recovered', rec.linked ? `已按 requestKey 绑定已创建 Run ${rec.runId}` : '已把未创建 Run 的 pending 任务放回队列', 'warn', { ...rec });
        }
      } catch (err) {
        this.emit(lp, 'loop_pending_recovery_failed', `pending 对账失败：${err.message}`, 'error');
      }
    }
    const alive = (owner) => {
      const m = String(owner || '').match(/^wb:(\d+):/);
      if (!m) return false;
      try { process.kill(Number(m[1]), 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
    };
    const loops = this.store.listLoops({ status: 'running' });
    const skipped = [];
    const recovered = [];
    for (const loop of loops) {
      const lease = this.store.getProjectLease(loop.project_id);
      if (lease?.write_owner && lease.lease_expires_at > new Date().toISOString() && alive(lease.write_owner)) { skipped.push(loop.id); continue; }
      this.store.updateLoop(loop.id, { status: 'interrupted', stop_reason: '工作台进程重启，循环已中断（可恢复）' });
      this.emit(loop, 'loop_interrupted', '检测到未完成的研发循环，已标记中断；状态与历史已保留', 'warn');
      recovered.push(loop.id);
    }
    return { recovered, skipped, pendingRecovered };
  }

  emit(loop, type, message, level = 'info', data = {}) {
    try {
      this.orchestrator.emit({
        projectId: loop.project_id,
        runId: loop.current_run_id || '',
        type,
        level,
        message: redact(message, this.config),
        data: { loopId: loop.id, round: loop.round, maxRounds: loop.max_rounds, ...data },
      });
    } catch {
      /* ignore */
    }
  }

  schedule(id, delay = 4000) {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.tick(id).catch((err) => {
        const loop = this.store.getLoop(id);
        if (loop) {
          this.store.updateLoop(id, { status: 'paused', stop_reason: `循环异常：${err?.message || err}` });
          this.emit(loop, 'loop_error', `循环异常：${err?.message || err}`, 'error');
        }
      });
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  async tick(id) {
    if (this.ticking.has(id)) return;
    this.ticking.add(id);
    try {
      let loop = this.store.getLoop(id);
      if (!loop || loop.status !== 'running') return;
      const project = this.store.getProject(loop.project_id);
      if (!project) throw new PolicyError('PROJECT_NOT_FOUND', '循环项目不存在');

      // 1) 等待当前运行结束
      if (loop.current_run_id) {
        const run = this.store.getRun(loop.current_run_id);
        if (!run) {
          this.store.updateLoop(id, { current_run_id: '' });
          this.schedule(id, 1000);
          return;
        }
        if (run.status === 'awaiting_acceptance' || run.status === 'accepted') {
          let controlLease = false;
          if (this.orchestrator?.ensureControlLease) {
            try { this.orchestrator.ensureControlLease(project.id); controlLease = true; }
            catch (err) {
              this.emit(loop, 'loop_write_lease_blocked', `质量轮次/历史写入未取得项目写租约，稍后重试：${err.message}`, 'warn');
              this.schedule(id, 5000);
              return;
            }
          }
          try { await this.completeRound(loop, project, run); }
          finally { if (controlLease) this.orchestrator.releaseProjectLease(project.id); }
          this.schedule(id, 1200);
          return;
        }
        if (['paused', 'failed', 'interrupted', 'cancelled'].includes(run.status)) {
          // P0-1：真实测试/审计失败时自动生成修复任务，而不是要求用户新建第二个 Run。
          if (run.status !== 'cancelled') {
            let controlLease = false;
            if (this.orchestrator?.ensureControlLease) {
              try { this.orchestrator.ensureControlLease(project.id); controlLease = true; }
              catch (err) { this.emit(loop, 'loop_write_lease_blocked', `自动修复写入未取得项目写租约：${err.message}`, 'warn'); this.schedule(id, 5000); return; }
            }
            try {
              const auto = await this.maybeAutoRepair(loop, project, run);
              if (auto) { this.schedule(id, 1200); return; }
            } finally { if (controlLease) this.orchestrator.releaseProjectLease(project.id); }
          }
          const reason = `第 ${loop.round + 1} 轮运行 ${run.id} 状态为 ${run.status}：${run.stop_reason || '无说明'}`;
          this.store.updateLoop(id, { status: run.status === 'cancelled' ? 'cancelled' : 'paused', stop_reason: reason });
          this.emit(loop, 'loop_paused', reason, 'warn', { runId: run.id });
          return;
        }
        this.schedule(id, 5000);
        return;
      }

      // 2) 轮次上限：有质量门时，质量未 PASS/修复队列未清空绝不标记 completed。
      if (loop.round >= loop.max_rounds) {
        const contractIncomplete = contractAcceptanceIncomplete(loop, project, this.store);
        if (contractIncomplete) {
          const reason = `达到最大轮次，但冻结验收条款缺少 PASS 证据：${contractIncomplete.missing.join('；').slice(0, 600)}；不能完成`;
          this.store.updateLoop(id, { status: 'blocked', stop_reason: reason });
          this.emit(loop, 'loop_blocked', reason, 'warn', { acceptanceMissing: contractIncomplete.missing });
          return;
        }
        const qIncomplete = qualityGateIncomplete(loop, project);
        if (qIncomplete) {
          const reason = `达到最大轮次 ${loop.max_rounds}，但不能完成：${qIncomplete.reason}；保留检查点等待继续/人工授权`;
          this.store.updateLoop(id, { status: 'blocked', stop_reason: reason });
          this.emit(loop, 'loop_blocked', reason, 'warn', { qualityGate: qIncomplete });
          return;
        }
        this.store.updateLoop(id, { status: 'completed', stop_reason: `已达到最大轮次 ${loop.max_rounds}` });
        this.emit(loop, 'loop_completed', `研发循环完成：${loop.round} 轮（达到上限）`);
        return;
      }

      // 3) 选择下一任务
      let task = null;
      let rationale = '';
      let queuedTask = null;
      let pending = null;
      const queued = Array.isArray(loop.queue_json) ? [...loop.queue_json] : [];
      const hasQualityRepair = queued.some((t) => t && (t.qualityIssueId || t.autoRepair));
      // plan/queue 均允许质量/自动修复任务优先于新规划。
      // plan 模式恢复出的 pending 任务也必须被消费；普通队列任务仍按显式任务处理。
      if (loop.mode === 'queue' || hasQualityRepair || queued.length > 0) {
        if (!queued.length) {
          const contractIncomplete = contractAcceptanceIncomplete(loop, project, this.store);
          if (contractIncomplete) {
            const reason = `队列已空，但冻结验收条款缺少 PASS 证据：${contractIncomplete.missing.join('；').slice(0, 600)}；不能完成`;
            this.store.updateLoop(id, { status: 'blocked', stop_reason: reason });
            this.emit(loop, 'loop_blocked', reason, 'warn', { acceptanceMissing: contractIncomplete.missing });
            return;
          }
          const qIncomplete = qualityGateIncomplete(loop, project);
          if (qIncomplete) {
            const reason = `队列已空但质量门未完成：${qIncomplete.reason}；不宣布完成`;
            this.store.updateLoop(id, { status: 'blocked', stop_reason: reason });
            this.emit(loop, 'loop_blocked', reason, 'warn', { qualityGate: qIncomplete });
            return;
          }
          this.store.updateLoop(id, { status: 'completed', stop_reason: '队列已空（没有伪造任务）' });
          this.emit(loop, 'loop_completed', '研发循环完成：没有更多真实任务（队列为空）');
          return;
        }
        const queueIndex = queued.findIndex((t) => t && t.title);
        const next = queued[queueIndex];
        queuedTask = next;
        task = { ...next, seq: 1, acceptance: Array.isArray(next.acceptance) ? next.acceptance : [next.title], agent: next.agent || 'auto', testCommand: next.testCommand || '' };
        // P0-2：队列不在 startRun 前删除；先写 pending/requestKey，Run 创建成功后再原子 claim。
        pending = { task: queuedTask, queueIndex, requestKey: newId('claim'), at: nowIso() };
        this.store.setLoopPending(id, pending);
        this.emit(loop, 'loop_task_pending', `任务已持久化待认领：${task.title}（requestKey=${pending.requestKey}）`, 'info', { task: task.title, requestKey: pending.requestKey });
        rationale = next.qualityIssueId ? `来自质量闭环修复任务（${next.qualityIssueId}）` : '来自显式任务队列';
      } else {
        let plannerReservation = null;
        try {
          plannerReservation = assertModelBudget({ config: this.config, store: this.store, provider: this.config.planner.provider || 'deepseek', estimatedTokens: 5000, label: 'Planner', reserve: true });
          const planned = await planNextTask({
            config: this.config, project, goal: loop.goal,
            history: loop.history_json || [],
            contractFiles: loop.contract_files_json || [],
            previousTasks: this.store.listTasks({ projectId: project.id }).slice(-20),
          });
          if (plannerReservation?.reservation?.id) {
            this.store.settleModelReservation(plannerReservation.reservation.id, { actualTokens: Number(planned.usage?.input || 0) + Number(planned.usage?.output || 0) + Number(planned.usage?.cacheRead || 0) + Number(planned.usage?.cacheWrite || 0), actualCostCny: planned.costCny || 0, usageKnown: true });
            plannerReservation = null;
          }
          if (planned.usage) {
            this.store.createAttempt({
              id: newId('att'), runId: '', taskId: '', attemptNo: 0, stage: 'loop-planning',
              agentKind: 'planner', provider: planned.provider || 'deepseek', model: planned.model || '',
              status: 'completed', tokensIn: planned.usage.input || 0, tokensOut: planned.usage.output || 0,
              tokensCache: (planned.usage.cacheRead || 0) + (planned.usage.cacheWrite || 0),
              costCny: planned.costCny || 0, costReported: false, costSource: 'estimated',
              durationMs: 0, logPath: '',
            });
          }
          if (planned.action === 'no_task') {
            let expected = safeJsonArray(project?.config_json?.test_plan?.acceptance || project?.config_json?.test_plan?.acceptance_json || []);
            if (!expected.length && project?.local_path) {
              try { const f = path.join(project.local_path, 'TEST_PLAN.json'); if (fs.existsSync(f)) expected = safeJsonArray(JSON.parse(fs.readFileSync(f, 'utf8')).acceptance); } catch { /* ignore */ }
            }
            if (expected.length) {
              const reason = `Planner 未发现真实任务，但冻结验收契约仍有 ${expected.length} 条条款需要证据；不能把 no_task 当作产品完成`;
              this.store.updateLoop(id, { status: 'blocked', stop_reason: reason });
              this.emit(loop, 'loop_blocked', reason, 'warn', { acceptance: expected });
              return;
            }
            this.store.updateLoop(id, { status: 'completed', stop_reason: `Planner 未发现真实任务：${planned.rationale || '无'}` });
            this.emit(loop, 'loop_completed', `研发循环完成：没有新的真实任务（${planned.rationale || ''}）`);
            return;
          }
          if (planned.action === 'blocked') {
            const reason = `Planner 报告授权/外部阻塞：${planned.blockedReason || planned.rationale || '未说明'}`;
            this.store.updateLoop(id, { status: 'blocked', stop_reason: reason });
            this.emit(loop, 'loop_blocked', reason, 'warn');
            return;
          }
          task = { ...planned.task, seq: 1 };
          rationale = planned.rationale || '';
        } catch (err) {
          if (plannerReservation?.reservation?.id) this.store.releaseModelReservation(plannerReservation.reservation.id);
          this.store.updateLoop(id, { status: 'paused', stop_reason: `规划失败（UNKNOWN）：${err?.message || err}` });
          this.emit(loop, 'loop_paused', `规划失败（UNKNOWN）：${err?.message || err}`, 'warn');
          return;
        }
      }

      if (!task || !task.title) {
        this.store.updateLoop(id, { status: 'paused', stop_reason: 'Planner/队列返回了非法任务（UNKNOWN）' });
        this.emit(loop, 'loop_paused', 'Planner/队列返回非法任务，已暂停（不伪造任务）', 'warn');
        return;
      }
      // plan 模式/任何分支：Planner 生成的任务同样必须先持久化 pending，再带 requestKey 启动。
      if (!pending) {
        pending = { task, queueIndex: -1, requestKey: newId('claim'), at: nowIso() };
        this.store.setLoopPending(id, pending);
        this.emit(loop, 'loop_task_pending', `规划任务已持久化待认领：${task.title}（requestKey=${pending.requestKey}）`, 'info', { task: task.title, requestKey: pending.requestKey });
      }

      // 4) 启动本轮 run（单任务）；暂停/取消请求可能在规划/选任务期间到达。
      if (this.store.getLoop(id)?.status !== 'running') { this.emit(loop, 'loop_start_cancelled', '循环已暂停/取消，放弃本轮 Run 启动', 'warn'); return; }
      let started;
      try {
        started = await this.orchestrator.startRun({
          projectId: project.id,
          goal: `[Loop round ${loop.round + 1}] ${task.title}`,
          mode: 'single',
          tasks: [task],
          acceptance: task.acceptance,
          maxAttempts: Number(project.budget_json?.max_attempts || this.config.budget.maxAttempts),
          requestKey: pending?.requestKey || '',
        });
      } catch (err) {
        // 队列保持原样；只清 pending，任务不丢失。
        this.store.setLoopPending(id, {});
        this.store.updateLoop(id, { status: 'paused', stop_reason: `启动运行失败，任务已保留：${err?.message || err}` });
        this.emit(loop, 'loop_start_failed', `启动运行失败，任务已保留在队列：${err?.message || err}`, 'warn', { task: task.title });
        return;
      }
      // 原子：移除队列项 + 清 pending + 绑定 run；崩溃在 startRun 与 claim 之间时由 requestKey 恢复。
      let claimed;
      try {
        claimed = this.store.claimLoopTask({ loopId: id, requestKey: pending?.requestKey || '', runId: started.runId });
      } catch (err) {
        claimed = { ok: false, reason: err?.message || String(err) };
      }
      if (!claimed?.ok) {
        this.store.updateLoop(id, { status: 'paused', stop_reason: `Run 已创建但任务认领事务失败：${claimed?.reason || 'unknown'}；恢复时将按 requestKey 对账` });
        this.emit(loop, 'loop_claim_failed', `Run ${started.runId} 已创建，认领事务失败；pending 保留用于恢复`, 'error', { runId: started.runId, reason: claimed?.reason });
        return;
      }
      loop = this.store.updateLoop(id, { current_run_id: started.runId, last_run_id: started.runId });
      this.emit(loop, 'loop_round_started', `第 ${loop.round + 1}/${loop.max_rounds} 轮开始：${task.title}${rationale ? `（${rationale}）` : ''}`, 'info', { task: task.title, runId: started.runId });
      this.schedule(id, 5000);
    } finally {
      this.ticking.delete(id);
    }
  }

  /**
   * P0-1：把一次真实失败转换为有证据、优先、可审计的自动修复任务。
   * 只修复已落盘的 Agent 代码基线；不改冻结测试/契约；最多 MAX_AUTO_REPAIRS 次。
   */
  async maybeAutoRepair(loop, project, run) {
    if (typeof this.orchestrator?.prepareAutoRepair !== 'function') return false;
    const maxAuto = Math.max(0, Math.min(3, Number(project?.config_json?.auto_repair_max ?? 2)));
    const count = Number(loop.auto_repair_count || 0);
    if (count >= maxAuto) {
      this.emit(loop, 'auto_repair_exhausted', `自动修复达到上限 ${maxAuto}，保留现场并阻塞，不继续无限重试`, 'warn', { runId: run.id });
      return false;
    }
    const tasks = this.store.listTasks({ runId: run.id });
    const failed = tasks.filter((t) => ['blocked', 'failed'].includes(t.status));
    if (!failed.length) return false;
    const task = failed[0];
    const audits = this.store.listAudits(task.id);
    const latestAudit = audits.at(-1) || null;
    // P1-2：审计 UNKNOWN（例如超时）优先自动重试验证，不把基础设施失败伪装成产品代码缺陷。
    if (latestAudit && String(latestAudit.verification_status || '').toUpperCase() === 'UNKNOWN' && task.worktree_path && typeof this.orchestrator?.retryVerification === 'function') {
      const maxRetry = Math.max(0, Math.min(2, Number(project?.config_json?.auto_verification_retry_max ?? 1)));
      const retryCount = Number(loop.auto_retry_count || 0);
      if (retryCount < maxRetry) {
        const n = this.store.incrementLoopAutoRetry(loop.id);
        this.emit(loop, 'auto_verification_retry', `审计 UNKNOWN（${latestAudit.summary || '证据不足'}），自动重试测试+独立审计 ${n}/${maxRetry}，不生成产品代码修复任务`, 'warn', { taskId: task.id, auditId: latestAudit.id });
        try {
          if (typeof this.orchestrator.auditResourcePreflight === 'function') this.orchestrator.auditResourcePreflight(project, lastAttemptFamily(loop, this.store));
        } catch (err) {
          this.emit(loop, 'auto_verification_retry_blocked', `审计资源预检失败，安全阻塞而不是转产品修复：${err?.message || err}`, 'warn', { taskId: task.id, auditId: latestAudit.id });
          return false;
        }
        try {
          await this.orchestrator.retryVerification(task.id);
          return true;
        } catch (err) {
          this.emit(loop, 'auto_verification_retry_failed', `自动重试验证失败：${err?.message || err}`, 'warn', { taskId: task.id });
        }
      }
    }
    const requiredFixes = latestAudit ? safeJsonArray(latestAudit.required_fixes_json) : [];
    const auditEvidence = requiredFixes.length ? requiredFixes : [];
    const failureEvidence = [
      task.blocked_reason || '',
      run.stop_reason || '',
      ...auditEvidence,
    ].filter(Boolean).slice(0, 8);
    // 没有可执行证据（例如纯预算/授权阻塞）不伪造修复任务。
    if (!failureEvidence.length) return false;
    // 只有可归因到代码/测试/审计/环境失败才自动修；纯权限/预算等策略阻塞不生成产品修复任务。
    const failureClass = classifyLoopFailure(failureEvidence);
    if (failureClass === 'unknown' || failureClass === 'agent_unavailable') {
      this.emit(loop, 'auto_repair_skipped', '失败没有可执行的产品/测试/审计/环境证据（可能是授权/预算策略阻塞），保留 BLOCKED，不生成修复任务', 'warn', { runId: run.id, taskId: task.id });
      return false;
    }
    const base = await this.orchestrator.prepareAutoRepair({ project, task, label: `loop-${loop.id}-run-${run.id}` });
    // pause/cancel 可能在异步 Git 基线保存期间到达：不得把 Loop 重新写回 running/queue。
    if (!loopStillRunning(this.store, loop.id)) { this.emit(loop, 'loop_control_race', '自动修复期间 Loop 已暂停/取消，放弃写回队列', 'warn'); return false; }
    if (!base?.ok) {
      this.emit(loop, 'auto_repair_blocked', `无法保存失败任务基线，不能生成修复任务：${base?.reason || 'unknown'}`, 'warn', { runId: run.id, taskId: task.id });
      return false;
    }
    // 失败 Run 必须先进入终态，否则 startRun 会被 activeRunForProject(PROJECT_BUSY) 拒绝。
    this.store.updateRun(run.id, {
      status: 'failed',
      stop_reason: `自动修复已接管：${failureEvidence.slice(0, 3).join('；')}`.slice(0, 1000),
      ended_at: nowIso(),
      current_task_id: '',
    });
    const existingRepair = (Array.isArray(loop.queue_json) ? loop.queue_json : []).find((t) => t && t.autoRepair && t.repairOfRunId === run.id);
    if (existingRepair) return true;
    const n = this.store.incrementLoopAutoRepair(loop.id);
    const repair = {
      title: `[Auto Repair ${n}/${maxAuto}] ${task.title}`,
      description: `Workbench 自动修复任务（由真实失败证据生成，不是外部追加提示词）。\n\n原始目标：${loop.goal}\n原始任务：${task.title}\n失败证据：\n${failureEvidence.map((x) => `- ${x}`).join('\n')}\n\n要求：在修复基线上定位并修复导致测试/独立审计失败的原因；不得修改冻结测试或契约；不得降低验收标准；修复后必须重新运行完整测试并接受独立审计。`,
      acceptance: [...(safeJsonArray(task.acceptance_json).length ? safeJsonArray(task.acceptance_json) : [task.title]), '修复后原始验收标准重新通过', '失败证据中的测试/审计问题全部解决'],
      testCommand: task.test_command || project.test_command || '',
      agent: task.agent_kind && task.agent_kind !== 'auto' ? task.agent_kind : 'auto',
      autoRepair: true,
      repairOfTaskId: task.id,
      repairOfRunId: run.id,
      repairEvidence: failureEvidence,
      failureClass,
    };
    const queue = Array.isArray(loop.queue_json) ? [...loop.queue_json] : [];
    queue.unshift(repair);
    this.store.updateLoop(loop.id, {
      status: 'running', current_run_id: '', stop_reason: '',
      queue_json: queue, auto_repair_count: n,
    });
    this.emit(loop, 'auto_repair_queued', `检测到真实失败，已自动生成修复任务 ${n}/${maxAuto}：${task.title}`, 'warn', {
      failedTaskId: task.id, failedRunId: run.id, repairTitle: repair.title, evidence: failureEvidence, baseline: base,
    });
    return true;
  }

  async completeRound(loop, project, run) {
    if (!loopStillRunning(this.store, loop.id)) return;
    const tasks = this.store.listTasks({ runId: run.id });
    const task = tasks[0] || {};
    const history = Array.isArray(loop.history_json) ? [...loop.history_json] : [];
    // 幂等：同一 run/commit 不重复入历史，避免恢复后重复轮次/重复提交语义
    if (history.some((h) => h.runId === run.id || (task.head_commit && h.commit === task.head_commit))) {
      const qIncomplete = qualityGateIncomplete(loop, project);
      const status = qIncomplete ? 'blocked' : (loop.round >= loop.max_rounds ? 'completed' : 'running');
      this.store.updateLoop(loop.id, { current_run_id: '', status, stop_reason: qIncomplete ? `重复轮次通知但质量门未完成：${qIncomplete.reason}` : '' });
      this.emit(loop, qIncomplete ? 'loop_blocked' : 'loop_round_duplicate_skipped', qIncomplete ? `重复轮次通知但质量门未完成，不标记 completed：${qIncomplete.reason}` : `检测到已完成轮次的重复通知，已跳过：${run.id}`, qIncomplete ? 'warn' : 'info');
      return;
    }
    // 任务完成判定：必须 passed 且验证状态可信；UNKNOWN/FAILED 不得推进
    const verification = String(run.verification_status || '');
    const allowed = verification === 'LOCAL_VERIFIED' || verification === 'CI_PASSED';
    if (task.status !== 'passed' || !allowed) {
      const reason = `循环拒绝推进：任务 ${task.id || '?'} 状态=${task.status || '?'}，验证=${verification || 'UNKNOWN'}（UNKNOWN 不得视为 PASS）`;
      this.store.updateLoop(loop.id, { status: 'paused', stop_reason: reason });
      this.emit(loop, 'loop_paused', reason, 'warn', { runId: run.id });
      return;
    }
    const commit = task.head_commit || run.result_json?.planHead || '';
    const branch = run.result_json?.planBranch || '';
    if (!commit || !branch) {
      const reason = '循环拒绝推进：缺少实际 commit 或计划分支（不推进到错误基线）';
      this.store.updateLoop(loop.id, { status: 'paused', stop_reason: reason });
      this.emit(loop, 'loop_paused', reason, 'warn', { runId: run.id });
      return;
    }
    // Git 状态安全：先核对分支 ref 与任务 commit 一致，再切换基线；失败必须停止而不是继续
    const ref = spawnSync('git', ['-C', project.local_path, 'rev-parse', '--verify', `refs/heads/${branch}`], { encoding: 'utf8' });
    if (ref.status !== 0 || String(ref.stdout || '').trim() !== commit) {
      const reason = `循环拒绝推进：计划分支 ${branch} 未指向任务 commit ${commit.slice(0, 12)}（rev-parse 失败或 SHA 不一致）`;
      this.store.updateLoop(loop.id, { status: 'paused', stop_reason: reason });
      this.emit(loop, 'loop_paused', reason, 'error', { runId: run.id });
      return;
    }
    const checkout = spawnSync('git', ['-C', project.local_path, 'checkout', branch], { encoding: 'utf8' });
    if (checkout.status !== 0) {
      const reason = `循环拒绝推进：git checkout ${branch} 失败（exit=${checkout.status}）：${String(checkout.stderr || '').slice(0, 300)}`;
      this.store.updateLoop(loop.id, { status: 'paused', stop_reason: reason });
      this.emit(loop, 'loop_paused', reason, 'error', { runId: run.id });
      return;
    }
    this.store.updateProject(project.id, { default_branch: branch });
    history.push({
      round: loop.round + 1,
      runId: run.id,
      task: { title: task.title || '', description: task.description || '' },
      status: verification,
      commit,
      branch,
      baseCommit: task.base_commit || '',
      verification: task.verification_json || null,
      audit: this.store.listAudits(task.id).map((a) => ({ id: a.id, provider: a.provider, verdict: a.verdict, score: a.score, status: a.verification_status })),
      finishedAt: nowIso(),
    });
    // ---- v2.7 Product Quality Loop：在宣布循环完成之前检查原始需求覆盖，而不是只看任务通过 ----
    const qcfg = qualityConfig(project);
    let quality = null;
    if (qcfg) {
      try {
        // 质量检查必须针对本轮验证过的 planHead，而不是项目主目录当前分支。
        const qualityHead = run.result_json?.planHead || tasks[0]?.head_commit || '';
        let qualityWorktree = '';
        if (qualityHead) {
          qualityWorktree = path.join(this.config.paths.worktreesDir, `quality-${run.id.slice(-8)}`);
          try {
            await gitops.createWorktree(project.local_path, qualityWorktree, `wb/quality-${run.id.slice(-8)}-${Date.now().toString(36)}`, qualityHead);
            // host-only 受信质量夹具需要依赖；Docker 中不应依赖宿主 node_modules。
            if (String(project?.config_json?.quality?.isolation || '') === 'host') {
              for (const name of ['node_modules', '.playwright-browsers']) {
                const src = path.join(project.local_path, name);
                if (fs.existsSync(src) && !fs.existsSync(path.join(qualityWorktree, name))) {
                  try { fs.symlinkSync(src, path.join(qualityWorktree, name), 'dir'); } catch { /* ignore */ }
                }
              }
            }
          } catch (err) {
            const reason = `无法创建质量检查 worktree（不能退回错误代码目录）：${err.message}`;
            this.store.updateLoop(loop.id, { round: loop.round + 1, current_run_id: '', history_json: history, status: 'blocked', stop_reason: reason });
            this.emit(loop, 'quality_worktree_error', reason, 'error', { runId: run.id, qualityHead });
            return;
          }
        } else {
          const reason = '缺少可验证的计划分支 commit，质量检查拒绝运行（不退回项目目录）';
          this.store.updateLoop(loop.id, { round: loop.round + 1, current_run_id: '', history_json: history, status: 'blocked', stop_reason: reason });
          this.emit(loop, 'quality_worktree_error', reason, 'error', { runId: run.id });
          return;
        }
        let qualityRun;
        try {
          qualityRun = await runQualityCommand({ config: this.config, project, options: { runId: run.id, commit: qualityHead, worktree: qualityWorktree || undefined } });
        } finally {
          if (qualityWorktree) await gitops.removeWorktree(project.local_path, qualityWorktree).catch(() => {});
        }
        const audits = this.store.listTasks({ projectId: project.id }).flatMap((t) => this.store.listAudits(t.id));
        quality = buildCoverageMatrix({ project, qualityRun, audits });
        history[history.length - 1].quality = quality;
        this.emit(loop, 'quality_evaluated', `质量评估：需求覆盖 ${quality.coverage.pass}/${quality.coverage.total} PASS，${quality.p0p1.length} 个有证据 P0/P1 问题`, quality.allPass ? 'info' : 'warn', { quality });
        if (!loopStillRunning(this.store, loop.id)) return;
        if (!quality.allPass) {
          const cycles = history.filter((h) => h.quality && !h.quality.allPass).length;
          const repairTasks = repairTasksFromQuality(quality, { maxIssues: qcfg.maxIssuesPerCycle });
          if (quality.p0p1.length && !repairTasks.length) {
            const reason = `质量闭环存在 P0/P1 问题但没有可复现证据（只能记为假设）：${quality.p0p1.map((i) => i.title).join('；')}`;
            this.store.updateLoop(loop.id, { round: loop.round + 1, current_run_id: '', history_json: history, status: 'blocked', stop_reason: reason });
            this.emit(loop, 'quality_blocked', reason, 'warn', { quality });
            return;
          }
          if (quality.qualityCommandError) {
            const reason = `质量命令执行失败（基础设施/证据 UNKNOWN），不生成产品修复任务、不自动改代码：${quality.qualityCommandError}`;
            this.store.updateLoop(loop.id, { round: loop.round + 1, current_run_id: '', history_json: history, status: 'blocked', stop_reason: reason });
            this.emit(loop, 'quality_blocked', reason, 'warn', { quality });
            return;
          }
          if (!quality.p0p1.length) {
            const reason = `质量闭环未通过（无 P0/P1 可修复项，存在 UNKNOWN/FAIL/BLOCKED）：${quality.requirements.filter((r) => r.status !== 'PASS').map((r) => `${r.id}:${r.status}`).join('；') || '质量证据不足'}`;
            this.store.updateLoop(loop.id, { round: loop.round + 1, current_run_id: '', history_json: history, status: 'blocked', stop_reason: reason });
            this.emit(loop, 'quality_blocked', reason, 'warn', { quality });
            return;
          }
          if (cycles <= qcfg.maxCycles) {
            const queue = Array.isArray(loop.queue_json) ? [...loop.queue_json] : [];
            const existingKeys = new Set(queue.map((t) => t.queueKey).filter(Boolean));
            const fresh = repairTasks.filter((t) => !existingKeys.has(t.queueKey));
            if (fresh.length) {
              this.store.updateLoop(loop.id, {
                round: loop.round + 1, current_run_id: '', history_json: history,
                queue_json: [...queue, ...fresh], status: 'running',
                stop_reason: `质量闭环：已生成 ${fresh.length} 个有证据修复任务，等待下一轮`,
              });
              this.emit(loop, 'quality_repair_queued', `质量闭环发现 ${fresh.length} 个问题，已生成修复任务并继续循环（第 ${cycles}/${qcfg.maxCycles} 次修复循环）`, 'warn', { quality, tasks: fresh.map((t) => ({ title: t.title, issueId: t.qualityIssueId })) });
              return;
            }
          }
          const reason = `质量闭环达到上限/无法继续：${quality.coverage.pass}/${quality.coverage.total} 需求 PASS；P0/P1 有证据问题 ${quality.p0p1.length} 个；已达到 maxCycles=${qcfg.maxCycles} 或不可自动修复；保留检查点等待人工/授权`;
          this.store.updateLoop(loop.id, { round: loop.round + 1, current_run_id: '', history_json: history, status: 'blocked', stop_reason: reason });
          this.emit(loop, 'quality_blocked', reason, 'warn', { quality });
          return;
        }
        this.emit(loop, 'quality_passed', `质量闭环通过：${quality.coverage.pass}/${quality.coverage.total} 条原始需求都有证据 PASS`, 'info', { quality });
      } catch (err) {
        const reason = `质量评估异常（UNKNOWN，不宣布完成）：${err?.message || err}`;
        this.store.updateLoop(loop.id, { round: loop.round + 1, current_run_id: '', history_json: history, status: 'blocked', stop_reason: reason });
        this.emit(loop, 'quality_error', reason, 'error');
        return;
      }
    }
    if (!loopStillRunning(this.store, loop.id)) return;
    const nextRound = loop.round + 1;
    let nextStatus = 'running';
    let stopReason = '';
    if (nextRound >= loop.max_rounds) {
      const contractIncomplete = contractAcceptanceIncomplete({ ...loop, round: nextRound, history_json: history, current_run_id: run.id }, project, this.store);
      const qIncomplete = contractIncomplete ? { reason: `冻结验收条款缺少证据：${contractIncomplete.missing.join('；')}` } : qualityGateIncomplete({ ...loop, round: nextRound, history_json: history }, project);
      if (qIncomplete) {
        nextStatus = 'blocked';
        stopReason = `达到最大轮次 ${loop.max_rounds} 但质量门未完成：${qIncomplete.reason}；保留检查点等待继续/人工授权`;
        this.emit(loop, 'loop_blocked', stopReason, 'warn', { qualityGate: qIncomplete });
      } else {
        nextStatus = 'completed';
        stopReason = `已完成 ${nextRound} 轮${quality ? '，质量闭环通过' : ''}`;
      }
    }
    this.store.updateLoop(loop.id, { round: nextRound, current_run_id: '', history_json: history, status: nextStatus, stop_reason: stopReason });
    this.emit(loop, 'loop_round_completed', `第 ${nextRound}/${loop.max_rounds} 轮通过：${task.title || run.id}（${verification}，commit ${String(commit).slice(0, 8)}）`, 'info', { runId: run.id, commit, verification });
    if (nextStatus === 'completed') this.emit(loop, 'loop_completed', `研发循环完成：${nextRound} 轮${quality ? '，原始需求覆盖矩阵全部 PASS' : ''}`);
  }
}

export function loopSummary(loop) {
  if (!loop) return null;
  return {
    id: loop.id,
    projectId: loop.project_id,
    goal: loop.goal,
    mode: loop.mode,
    status: loop.status,
    round: loop.round,
    maxRounds: loop.max_rounds,
    currentRunId: loop.current_run_id,
    lastRunId: loop.last_run_id,
    stopReason: loop.stop_reason,
    history: loop.history_json || [],
  };
}
