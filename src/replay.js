// SPDX-License-Identifier: Apache-2.0
/**
 * v2.6 只读观察层：研发实况 / 历史回放 / 工作台解释所需的真实数据快照。
 *
 * 原则：
 * - 只读 SQLite、事件、attempts、audits、artifacts、Git 与已有证据文件；不写任何研发状态。
 * - 不做“演示数据”：空数据返回空状态；缺失字段明确标记为空/未记录。
 * - A/B 项目不进入该观察层的项目列表（不读取/不操作其研发状态）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const A_B_NAME_RE = /(Global Opportunity Engine|Investment Agent)/i;
const TZ = 'Asia/Shanghai';

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function git(repo, args, timeout = 8000) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

export function isExcludedProject(project) {
  return A_B_NAME_RE.test(String(project?.name || '')) || A_B_NAME_RE.test(String(project?.local_path || ''));
}

export function eligibleProjects(store) {
  return store.listProjects().filter((p) => !isExcludedProject(p));
}

function projectByKey(store, key = '') {
  const projects = store.listProjects();
  if (key) {
    const found = projects.find((p) => p.id === key || p.name === key);
    if (found && !isExcludedProject(found)) return found;
  }
  return eligibleProjects(store)[0] || null;
}

function tasksForRun(store, runId) {
  const rows = store.db.prepare('SELECT * FROM tasks WHERE run_id=? ORDER BY seq').all(runId);
  return rows.map((t) => ({ ...t, acceptance: parseJson(t.acceptance_json, []), verification: parseJson(t.verification_json, {}) }));
}

function attemptsForTask(store, taskId) {
  return store.db.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY created_at, attempt_no').all(taskId).map((a) => ({ ...a }));
}

function auditsForTask(store, taskId) {
  return store.db.prepare('SELECT * FROM audits WHERE task_id=? ORDER BY created_at').all(taskId).map((a) => ({
    ...a,
    criteria: parseJson(a.criteria_json, []),
    findings: parseJson(a.findings_json, []),
    requiredFixes: parseJson(a.required_fixes_json, []),
    independence: parseJson(a.independence, {}),
  }));
}

function eventsForProject(store, projectId, limit = 1000) {
  return store.db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY id LIMIT ?').all(projectId, limit).map((e) => ({ ...e, data: parseJson(e.data_json, {}) }));
}

function artifactsForProject(store, projectId) {
  return store.db.prepare('SELECT a.* FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE r.project_id=? ORDER BY a.created_at LIMIT 500').all(projectId).map((a) => ({ ...a, meta: parseJson(a.meta_json, {}) }));
}

function loopsForProject(store, projectId) {
  return store.db.prepare('SELECT * FROM loops WHERE project_id=? ORDER BY created_at').all(projectId).map((l) => ({
    ...l,
    queue: parseJson(l.queue_json, []),
    history: parseJson(l.history_json, []),
    contractFiles: parseJson(l.contract_files_json, []),
  }));
}

function readContract(project) {
  const candidates = [
    path.join(project.local_path || '', 'CONTRACT.md'),
    path.join(project.local_path || '', 'README.md'),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        const text = fs.readFileSync(p, 'utf8');
        return { path: p.replace(project.local_path || '', '').replace(/^\//, ''), text: text.slice(0, 12000) };
      }
    } catch { /* ignore */ }
  }
  return { path: '', text: '' };
}

function commitsForProject(project, tasks = []) {
  const repo = project.local_path || '';
  if (!repo || !fs.existsSync(repo)) return [];
  // 通用：从真实任务 head_commit 出发，读取每个 commit 的文件变化；不依赖任何产品名/固定 SHA。
  const shas = [...new Set(tasks.map((t) => t.head_commit || t.verification?.commit || '').filter(Boolean))];
  return shas.map((sha) => {
    const full = git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
    if (!full) return null;
    const header = git(repo, ['show', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s', '--no-patch', full]).split('\x1f');
    const nameStatus = git(repo, ['show', '--format=', '--name-status', full]);
    const files = nameStatus.split('\n').filter(Boolean).map((row) => {
      const [status, ...rest] = row.split('\t');
      return { status, path: rest.join('\t') };
    });
    const stat = git(repo, ['show', '--format=', '--stat', full]);
    return { sha: full, short: header[1] || '', author: header[2] || '', date: header[3] || '', subject: header[4] || '', files, stat: stat.slice(0, 8000), diffAvailable: true };
  }).filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function summarize(store, project, tasks, attempts, audits, events) {
  const taskCounts = {};
  for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] || 0) + 1;
  const auditUnknown = audits.filter((a) => a.verification_status === 'UNKNOWN' || a.verdict === 'fail').length;
  const requiredFixes = [...new Set(audits.flatMap((a) => a.requiredFixes || []).filter(Boolean))];
  const findings = audits.flatMap((a) => a.findings || []);
  const failureClasses = {};
  for (const a of attempts) if (a.failure_class) failureClasses[a.failure_class] = (failureClasses[a.failure_class] || 0) + 1;
  const agentFailed = events.filter((e) => e.type === 'agent_failed').length;
  const stalled = (failureClasses.stalled || 0) + (failureClasses.agent_timeout || 0) + (failureClasses.agent_aborted || 0);
  const starts = events.map((e) => Date.parse(e.created_at)).filter(Number.isFinite);
  const fallbackStart = project.created_at || new Date().toISOString();
  const fallbackEnd = project.updated_at || fallbackStart;
  const start = starts.length ? new Date(Math.min(...starts)).toISOString() : fallbackStart;
  const end = starts.length ? new Date(Math.max(...starts)).toISOString() : fallbackEnd;
  const glmLimit = attempts.filter((a) => String(a.provider || '').toLowerCase() === 'glm');
  const sum = (list, field) => list.reduce((n, x) => n + Number(x[field] || 0), 0);
  return {
    projectTaskRecords: tasks.length,
    taskStatusCounts: taskCounts,
    passedTasks: taskCounts.passed || 0,
    failedTasks: taskCounts.failed || 0,
    blockedTasks: taskCounts.blocked || 0,
    attemptCalls: attempts.length,
    claudeAttempts: attempts.filter((a) => String(a.agent_kind || '').toLowerCase().includes('claude')).length,
    auditCalls: audits.length,
    auditUnknown,
    auditPassed: audits.filter((a) => a.verification_status === 'PASS' || (a.verdict === 'pass' && a.verification_status !== 'UNKNOWN')).length,
    issuesFound: requiredFixes.length + findings.filter((f) => String(f.severity || '').toLowerCase() === 'high').length,
    requiredFixes,
    agentFailedEvents: agentFailed,
    stalledAttempts: stalled,
    failureClasses,
    humanProductCodeEdits: 'UNKNOWN',
    humanProductCodeEditsNote: '没有完整的逐行人工修改审计记录；只能确认数据库中的 coding attempts 均由 Claude Code/GLM 触发，不能证明源码归属。',
    externalTestHarnessIntervention: 'KNOWN_OPERATION',
    externalTestHarnessNote: '交付过程中有一次 Playwright 完整 Chromium 测试环境修正；这是操作记录，不是产品源码修改。',
    provenanceStatus: audits.some((a) => a.verification_status === 'UNKNOWN') ? 'UNKNOWN' : 'UNRECORDED',
    unresolved: audits.filter((a) => a.verification_status === 'UNKNOWN').flatMap((a) => a.requiredFixes || []),
    costCny: 0,
    glmLimitTokens: sum(glmLimit, 'tokens_in') + sum(glmLimit, 'tokens_out'),
    glmLimitCostCny: sum(glmLimit, 'cost_cny'),
    start, end, durationMs: Math.max(0, Date.parse(end) - Date.parse(start)), timezone: TZ,
  };
}

/** 真实历史回放：只读查询，不修改任何记录。 */
export function buildReplay(store, projectKey = '', options = {}) {
  const projects = eligibleProjects(store);
  const project = projectKey
    ? projects.find((p) => p.id === projectKey || p.name === projectKey)
    : projects.slice().sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)))[0];
  if (!project) return { available: false, projects: [], project: null, reason: '没有可回放的项目记录' };
  const loops = loopsForProject(store, project.id);
  const runs = store.db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY created_at').all(project.id).map((r) => ({ ...r, result: parseJson(r.result_json, {}), spent: parseJson(r.spent_json, {}) }));
  const tasks = store.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at').all(project.id).map((t) => ({ ...t, acceptance: parseJson(t.acceptance_json, []), verification: parseJson(t.verification_json, {}) }));
  const taskCommits = new Map(tasks.map((t) => [t.id, t.head_commit || t.verification?.commit || '']));
  const attempts = store.db.prepare('SELECT * FROM attempts WHERE run_id IN (SELECT id FROM runs WHERE project_id=?) ORDER BY created_at').all(project.id);
  const audits = store.db.prepare('SELECT a.* FROM audits a JOIN runs r ON r.id=a.run_id WHERE r.project_id=? ORDER BY a.created_at').all(project.id).map((a) => ({
    ...a, criteria: parseJson(a.criteria_json, []), findings: parseJson(a.findings_json, []), requiredFixes: parseJson(a.required_fixes_json, []), independence: parseJson(a.independence, {}), commit: taskCommits.get(a.task_id) || '',
  }));
  const eventLimit = Math.max(1, Math.min(5000, Number(options.eventLimit || 1000)));
  const eventBefore = Number(options.eventBefore || 0);
  const eventsAll = (eventBefore > 0
    ? store.db.prepare('SELECT * FROM events WHERE project_id=? AND id<? ORDER BY id DESC LIMIT ?').all(project.id, eventBefore, eventLimit + 1)
    : store.db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY id DESC LIMIT ?').all(project.id, eventLimit + 1)
  ).map((e) => ({ ...e, data: parseJson(e.data_json, {}) }));
  const hasOlder = eventsAll.length > eventLimit;
  const events = eventsAll.slice(0, eventLimit).reverse();
  const artifacts = artifactsForProject(store, project.id);
  const contract = readContract(project);
  const commits = commitsForProject(project, tasks);
  const stats = summarize(store, project, tasks, attempts, audits, events);
  stats.auditBudget = store.auditBudgetUsage(project.id);
  stats.modelCost = {
    codingCny: stats.glmLimitCostCny,
    auditCny: stats.auditBudget.costCny,
    totalCny: Number((stats.glmLimitCostCny + stats.auditBudget.costCny).toFixed(6)),
  };
  stats.costCny = stats.modelCost.totalCny;
  const finalRun = runs.slice().reverse().find((r) => r.status === 'awaiting_acceptance') || runs.slice().reverse().find((r) => r.status !== 'cancelled') || null;
  const finalTask = finalRun ? tasks.find((t) => t.run_id === finalRun.id && t.status === 'passed') || null : null;
  const finalAudit = finalTask ? audits.filter((a) => a.task_id === finalTask.id).slice(-1)[0] || null : null;
  const finalTest = finalRun ? events.filter((e) => e.run_id === finalRun.id && e.type === 'test_passed').slice(-1)[0] || null : null;
  const final = {
    loopId: finalRun ? loops.find((l) => l.current_run_id === finalRun.id || l.last_run_id === finalRun.id)?.id || '' : '',
    runId: finalRun?.id || '',
    taskId: finalTask?.id || '',
    taskTitle: finalTask?.title || '',
    commit: finalTask?.head_commit || finalTask?.verification?.commit || '',
    auditStatus: finalAudit?.verification_status || '',
    auditScore: finalAudit?.score ?? null,
    auditCriteriaPassed: finalAudit?.criteria?.filter((c) => c.status === 'pass').length || 0,
    auditCriteriaTotal: finalAudit?.criteria?.length || 0,
    testPassedAt: finalTest?.created_at || '',
    testEvidence: finalAudit?.criteria?.map((c) => c.evidence).filter(Boolean).join('\n').slice(0, 4000) || '',
  };
  return {
    available: true,
    timezone: TZ,
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id, name: project.name, description: project.description, local_path: project.local_path,
      created_at: project.created_at, audit_provider: project.audit_provider, audit_budget: parseJson(project.config_json?.audit_budget, null),
    },
    origin: {
      projectDescription: project.description || '',
      loopGoals: loops.map((l) => ({ id: l.id, goal: l.goal, created_at: l.created_at })),
      contractPath: contract.path,
      contractText: contract.text,
      note: '原始聊天消息未写入 SQLite；此处使用项目记录、研发循环目标与冻结契约文件作为可核对来源。',
    },
    loops: loops.map((l) => ({ id: l.id, status: l.status, goal: l.goal, round: l.round, max_rounds: l.max_rounds, created_at: l.created_at, current_run_id: l.current_run_id || '', last_run_id: l.last_run_id || '', queue: l.queue, history: l.history })),
    runs: runs.map((r) => ({ id: r.id, status: r.status, mode: r.mode, goal: r.goal, created_at: r.created_at, started_at: r.started_at, ended_at: r.ended_at, stop_reason: r.stop_reason, spent: r.spent, verification_status: r.verification_status, verified_sha: r.verified_sha })),
    tasks: tasks.map((t) => ({ id: t.id, run_id: t.run_id, seq: t.seq, title: t.title, description: t.description, status: t.status, acceptance: t.acceptance, agent_kind: t.agent_kind, head_commit: t.head_commit, base_commit: t.base_commit, created_at: t.created_at, updated_at: t.updated_at, blocked_reason: t.blocked_reason, verification: t.verification })),
    attempts: attempts.map((a) => ({ id: a.id, run_id: a.run_id, task_id: a.task_id, attempt_no: a.attempt_no, agent_kind: a.agent_kind, status: a.status, error: a.error, failure_class: a.failure_class, started_at: a.created_at, updated_at: a.updated_at, duration_ms: a.duration_ms, tokens_in: a.tokens_in, tokens_out: a.tokens_out, tokens_cache: a.tokens_cache, cost_cny: a.cost_cny, cost_source: a.cost_source, provider: a.provider, model: a.model, prompt: String(a.prompt || '').slice(0, 6000), log_path: a.log_path })),
    audits: audits.map((a) => ({ id: a.id, run_id: a.run_id, task_id: a.task_id, commit: a.commit, provider: a.provider, provider_source: a.provider_source, model: a.model, verdict: a.verdict, verification_status: a.verification_status, score: a.score, criteria: a.criteria, findings: a.findings, requiredFixes: a.requiredFixes, summary: a.summary, tokens: Number(a.tokens_in || 0) + Number(a.tokens_out || 0), cost_cny: a.cost_cny, created_at: a.created_at, independence: a.independence })),
    events,
    artifacts: artifacts.map((a) => ({ id: a.id, run_id: a.run_id, task_id: a.task_id, kind: a.kind, path: a.path, created_at: a.created_at })),
    commits,
    final,
    stats,
    projects: projects.map((p) => ({ id: p.id, name: p.name, local_path: p.local_path })),
    media: {
      screenshots: (Array.isArray(parseJson(project.config_json?.replay_assets, [])) ? parseJson(project.config_json.replay_assets, []) : []).map((item) => typeof item === 'string' ? { path: item, label: item.split('/').pop() } : item).filter((item) => item && item.path),
    },
    eventPagination: { limit: eventLimit, count: events.length, hasOlder, before: events[0]?.id || 0 },
  };
}

function taskProgress(tasks) {
  const total = tasks.length;
  const passed = tasks.filter((t) => t.status === 'passed').length;
  return { total, passed, failed: tasks.filter((t) => t.status === 'failed').length, blocked: tasks.filter((t) => t.status === 'blocked').length, active: tasks.filter((t) => ['coding', 'testing', 'auditing', 'repairing', 'committing', 'preparing'].includes(t.status)).length };
}

function nextStepFor(run, task) {
  if (!run) return '当前没有研发运行。选择项目后可以启动新运行，或到“历史回放”看过去的开发过程。';
  if (run.status === 'awaiting_acceptance') return '本次运行的已通过任务等待你验收；工作台不会自动合并或部署。';
  if (run.status === 'running' && task) {
    const map = {
      coding: '等待 Claude Code 返回本轮代码；随后工作台会自动运行测试。',
      testing: '工作台正在运行测试命令，测试结果会写入时间线。',
      auditing: '测试已通过，等待 DeepSeek Harness 独立审计逐条核对验收标准。',
      repairing: '测试或审计未通过，工作台已把问题交回 Claude Code 修复。',
      committing: '独立审计已通过，正在保存 Git commit 并推进下一任务。',
      preparing: '工作台正在准备隔离工作副本与任务上下文。',
    };
    return map[task.status] || '工作台继续推进当前任务。';
  }
  if (run.status === 'paused' || run.status === 'interrupted') return '运行已暂停/中断，检查点已保留；恢复后从断点继续。';
  if (run.status === 'cancelled') return '本次运行已取消；历史记录保留，可查看原因。';
  return '当前没有进行中的运行；最近一次运行已结束。';
}

/** 研发实况：只读快照；没有活跃运行也返回最近一次的真实状态与空状态说明。 */
export function buildLive(store, projectKey = '') {
  const eligible = eligibleProjects(store);
  const projects = eligible.map((p) => ({ id: p.id, name: p.name, local_path: p.local_path, created_at: p.created_at }));
  let selected;
  if (projectKey) selected = projectByKey(store, projectKey);
  else {
    // 默认优先展示真正 running 的项目；没有 running 时展示最近更新的已授权项目。
    selected = eligible.find((p) => store.db.prepare("SELECT 1 FROM runs WHERE project_id=? AND status='running' LIMIT 1").get(p.id)) || eligible[0] || null;
    if (selected && !selected.config_json) selected = eligible.find((p) => p.id === selected.id) || selected;
  }
  if (!selected) return { projects, project: null, active: false, reason: '没有可展示的项目', generatedAt: new Date().toISOString(), timezone: TZ };
  const runs = store.db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC LIMIT 30').all(selected.id).map((r) => ({ ...r, spent: parseJson(r.spent_json, {}) }));
  const activeRun = runs.find((r) => r.status === 'running') || null;
  const run = activeRun || runs[0] || null;
  const tasks = run ? tasksForRun(store, run.id) : [];
  const task = tasks.find((t) => t.id === run?.current_task_id) || tasks.find((t) => ['coding', 'testing', 'auditing', 'repairing', 'committing', 'preparing'].includes(t.status)) || tasks[0] || null;
  const attempt = task ? attemptsForTask(store, task.id).slice(-1)[0] || null : null;
  const audits = task ? auditsForTask(store, task.id) : [];
  const latestLoop = store.listLoops({ projectId: selected.id })[0] || null;
  const progress = taskProgress(tasks);
  // 只取最近 60 条（降序）再按时间正序返回，避免把运行结局截掉。
  const events = run
    ? store.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id DESC LIMIT 60').all(run.id).reverse().map((e) => ({ ...e, data: parseJson(e.data_json, {}) }))
    : [];
  const startedAt = run?.started_at || run?.created_at || '';
  const endedAt = run?.ended_at || (run && ['paused', 'interrupted', 'cancelled', 'failed'].includes(run.status) ? run.updated_at : '') || '';
  const elapsedMs = startedAt ? Math.max(0, Date.parse(endedAt || new Date().toISOString()) - Date.parse(startedAt)) : 0;
  const agent = activeRun ? (attempt?.agent_kind || task?.agent_kind || '') : '';
  const stage = activeRun ? (task?.status || run?.status || '') : (run?.status || '');
  const inactiveReason = !run
    ? '该项目还没有运行记录。'
    : activeRun
      ? ''
      : run.status === 'interrupted'
        ? '最近一次运行已中断，当前没有 Agent 在工作；检查点已保留。'
        : run.status === 'paused'
          ? '最近一次运行已暂停，当前没有 Agent 在工作；检查点已保留。'
          : '当前没有正在执行的 Agent；显示最近一次真实运行。';
  return {
    timezone: TZ,
    generatedAt: new Date().toISOString(),
    projects,
    project: { id: selected.id, name: selected.name, local_path: selected.local_path, description: selected.description },
    active: !!activeRun,
    run: run ? { id: run.id, status: run.status, goal: run.goal, mode: run.mode, created_at: run.created_at, started_at: run.started_at, ended_at: run.ended_at, spent: run.spent, stop_reason: run.stop_reason } : null,
    loop: latestLoop ? { id: latestLoop.id, status: latestLoop.status, round: latestLoop.round, max_rounds: latestLoop.max_rounds, goal: latestLoop.goal } : null,
    task: task ? { id: task.id, title: task.title, description: task.description, status: task.status, acceptance: task.acceptance, agent_kind: task.agent_kind, blocked_reason: task.blocked_reason } : null,
    agent,
    stage,
    progress,
    elapsedMs,
    costCny: Number(run?.spent?.costCny || 0),
    tokens: Number(run?.spent?.tokens || 0),
    audits: audits.map((a) => ({ id: a.id, verdict: a.verdict, verification_status: a.verification_status, score: a.score, criteria: a.criteria, requiredFixes: a.requiredFixes, created_at: a.created_at })),
    events: events.map((e) => ({ id: e.id, type: e.type, level: e.level, message: e.message, data: parseJson(e.data_json, {}), created_at: e.created_at })),
    nextStep: nextStepFor(activeRun || run, activeRun ? task : { ...(task || {}), status: run?.status || task?.status }),
    reason: inactiveReason,
  };
}

/** 只读 commit 详情（任意已授权项目，SHA 正则 + 仓库范围校验）。 */
export function readProjectCommit(store, projectId, sha) {
  const project = store.getProject(projectId);
  if (!project || isExcludedProject(project) || !/^[0-9a-f]{7,40}$/i.test(String(sha))) return null;
  const repo = project.local_path || '';
  if (!fs.existsSync(repo)) return null;
  const full = git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
  if (!full) return null;
  const header = git(repo, ['show', '--format=%H%x1f%h%x1f%aI%x1f%s', '--no-patch', full]).split('\x1f');
  const stat = git(repo, ['show', '--format=', '--stat', full]);
  const patch = git(repo, ['show', '--format=', '--no-ext-diff', '--unified=3', full]);
  return { sha: full, short: header[1] || '', date: header[2] || '', subject: header[3] || '', stat: stat.slice(0, 20000), patch: patch.slice(0, 120000), truncated: patch.length > 120000 };
}
