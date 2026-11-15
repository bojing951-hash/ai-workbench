// SPDX-License-Identifier: Apache-2.0
/**
 * 持续自主研发循环（v2.1）：
 *   goal -> 检查状态/契约 -> Planner 识别下一真实任务 -> 启动编排运行
 *   -> 编码/测试/独立审计/修复 -> 内部验收 -> 更新项目基线与循环历史 -> 下一轮
 * 停止条件：达到最大轮次、没有真实任务、任务失败/阻塞、需要人工授权。
 * 所有状态持久化到 SQLite；进程重启后可恢复。
 */
import { spawnSync } from 'node:child_process';
import { nowIso, newId } from './util.js';
import { PolicyError, redact } from './policy.js';
import { planNextTask } from './planner.js';

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
    const loop = this.store.createLoop({
      id: newId('loop'),
      projectId,
      goal: String(goal).trim(),
      mode: mode === 'queue' ? 'queue' : 'plan',
      maxRounds: Math.max(1, Math.min(20, Number(maxRounds) || 3)),
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
    this.store.updateLoop(id, { status: 'paused', stop_reason: reason });
    this.emit(loop, 'loop_paused', `研发循环已暂停：${reason}`, 'warn');
    return this.get(id);
  }

  async cancel(id, reason = '人工取消') {
    const loop = this.store.getLoop(id);
    if (!loop) throw new PolicyError('LOOP_NOT_FOUND', `循环不存在：${id}`);
    this.store.updateLoop(id, { status: 'cancelled', stop_reason: reason });
    this.emit(loop, 'loop_cancelled', `研发循环已取消：${reason}`, 'warn');
    return this.get(id);
  }

  async resume(id, { retryCurrent = false } = {}) {
    const loop = this.store.getLoop(id);
    if (!loop) throw new PolicyError('LOOP_NOT_FOUND', `循环不存在：${id}`);
    if (['completed', 'cancelled'].includes(loop.status)) throw new PolicyError('LOOP_CLOSED', `循环已结束：${loop.status}`);
    const current = loop.current_run_id ? this.store.getRun(loop.current_run_id) : null;
    if (current && ['interrupted', 'paused'].includes(current.status)) {
      if (retryCurrent) await this.orchestrator.resumeRun(current.id, { retryFailed: true }).catch(() => {});
      else {
        this.store.updateLoop(id, { status: 'paused', stop_reason: `当前运行 ${current.id} 状态 ${current.status}，恢复循环需重试或取消该运行` });
        return this.get(id);
      }
    }
    this.store.updateLoop(id, { status: 'running', stop_reason: '' });
    this.emit(loop, 'loop_resumed', '研发循环已恢复');
    this.schedule(id, 800);
    return this.get(id);
  }

  /** 启动时把未完成的循环标记为 interrupted，等待人工/API 恢复。 */
  recover() {
    const loops = this.store.listLoops({ status: 'running' });
    for (const loop of loops) {
      this.store.updateLoop(loop.id, { status: 'interrupted', stop_reason: '工作台进程重启，循环已中断（可恢复）' });
      this.emit(loop, 'loop_interrupted', '检测到未完成的研发循环，已标记中断；状态与历史已保留', 'warn');
    }
    return loops.map((l) => l.id);
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
          this.completeRound(loop, project, run);
          this.schedule(id, 1200);
          return;
        }
        if (['paused', 'failed', 'interrupted', 'cancelled'].includes(run.status)) {
          const reason = `第 ${loop.round + 1} 轮运行 ${run.id} 状态为 ${run.status}：${run.stop_reason || '无说明'}`;
          this.store.updateLoop(id, { status: run.status === 'cancelled' ? 'cancelled' : 'paused', stop_reason: reason });
          this.emit(loop, 'loop_paused', reason, 'warn', { runId: run.id });
          return;
        }
        this.schedule(id, 5000);
        return;
      }

      // 2) 轮次上限
      if (loop.round >= loop.max_rounds) {
        this.store.updateLoop(id, { status: 'completed', stop_reason: `已达到最大轮次 ${loop.max_rounds}` });
        this.emit(loop, 'loop_completed', `研发循环完成：${loop.round} 轮（达到上限）`);
        return;
      }

      // 3) 选择下一任务
      let task = null;
      let rationale = '';
      if (loop.mode === 'queue') {
        const queue = Array.isArray(loop.queue_json) ? [...loop.queue_json] : [];
        if (!queue.length) {
          this.store.updateLoop(id, { status: 'completed', stop_reason: '队列已空（没有伪造任务）' });
          this.emit(loop, 'loop_completed', '研发循环完成：没有更多真实任务（队列为空）');
          return;
        }
        const next = queue.shift();
        task = { ...next, seq: 1, acceptance: Array.isArray(next.acceptance) ? next.acceptance : [next.title], agent: next.agent || 'auto', testCommand: next.testCommand || '' };
        this.store.updateLoop(id, { queue_json: queue });
        rationale = '来自显式任务队列';
      } else {
        try {
          const planned = await planNextTask({
            config: this.config, project, goal: loop.goal,
            history: loop.history_json || [],
            contractFiles: loop.contract_files_json || [],
            previousTasks: this.store.listTasks({ projectId: project.id }).slice(-20),
          });
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

      // 4) 启动本轮 run（单任务）
      const started = await this.orchestrator.startRun({
        projectId: project.id,
        goal: `[Loop round ${loop.round + 1}] ${task.title}`,
        mode: 'single',
        tasks: [task],
        acceptance: task.acceptance,
        maxAttempts: Number(project.budget_json?.max_attempts || this.config.budget.maxAttempts),
      });
      loop = this.store.updateLoop(id, { current_run_id: started.runId, last_run_id: started.runId });
      this.emit(loop, 'loop_round_started', `第 ${loop.round + 1}/${loop.max_rounds} 轮开始：${task.title}${rationale ? `（${rationale}）` : ''}`, 'info', { task: task.title, runId: started.runId });
      this.schedule(id, 5000);
    } finally {
      this.ticking.delete(id);
    }
  }

  completeRound(loop, project, run) {
    const tasks = this.store.listTasks({ runId: run.id });
    const task = tasks[0] || {};
    const history = Array.isArray(loop.history_json) ? [...loop.history_json] : [];
    // 幂等：同一 run/commit 不重复入历史，避免恢复后重复轮次/重复提交语义
    if (history.some((h) => h.runId === run.id || (task.head_commit && h.commit === task.head_commit))) {
      this.store.updateLoop(loop.id, { current_run_id: '', status: loop.round >= loop.max_rounds ? 'completed' : 'running' });
      this.emit(loop, 'loop_round_duplicate_skipped', `检测到已完成轮次的重复通知，已跳过：${run.id}`);
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
    const nextRound = loop.round + 1;
    const nextStatus = nextRound >= loop.max_rounds ? 'completed' : 'running';
    this.store.updateLoop(loop.id, {
      round: nextRound,
      current_run_id: '',
      history_json: history,
      status: nextStatus,
      stop_reason: nextStatus === 'completed' ? `已完成 ${nextRound} 轮` : '',
    });
    this.emit(loop, 'loop_round_completed', `第 ${nextRound}/${loop.max_rounds} 轮通过：${task.title || run.id}（${verification}，commit ${String(commit).slice(0, 8)}）`, 'info', { runId: run.id, commit, verification });
    if (nextStatus === 'completed') this.emit(loop, 'loop_completed', `研发循环完成：${nextRound} 轮`);
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
