// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite 持久化层（Node 24 内置 node:sqlite，零原生依赖）。
 * 所有运行状态可恢复：runs / tasks / attempts / audits / events / actions。
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir, nowIso, readJson } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  repo_url TEXT DEFAULT '',
  local_path TEXT NOT NULL,
  default_branch TEXT DEFAULT 'main',
  test_command TEXT DEFAULT '',
  language TEXT DEFAULT '',
  agent_kind TEXT DEFAULT 'auto',
  audit_provider TEXT DEFAULT 'auto',
  protected_paths TEXT DEFAULT '[]',
  config_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  title TEXT DEFAULT '',
  mode TEXT DEFAULT 'single',
  tasks_json TEXT DEFAULT '[]',
  planner_meta_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  plan_id TEXT DEFAULT '',
  goal TEXT NOT NULL,
  mode TEXT DEFAULT 'single',
  status TEXT NOT NULL,
  current_task_id TEXT DEFAULT '',
  budget_json TEXT DEFAULT '{}',
  spent_json TEXT DEFAULT '{}',
  stop_reason TEXT DEFAULT '',
  result_json TEXT DEFAULT '{}',
  started_at TEXT DEFAULT '',
  ended_at TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  acceptance_json TEXT DEFAULT '[]',
  agent_kind TEXT DEFAULT 'auto',
  test_command TEXT DEFAULT '',
  status TEXT NOT NULL,
  attempt INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 2,
  branch TEXT DEFAULT '',
  base_commit TEXT DEFAULT '',
  head_commit TEXT DEFAULT '',
  worktree_path TEXT DEFAULT '',
  session_id TEXT DEFAULT '',
  blocked_reason TEXT DEFAULT '',
  result_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  stage TEXT NOT NULL,
  agent_kind TEXT DEFAULT '',
  session_id TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  exit_code INTEGER,
  status TEXT NOT NULL,
  error TEXT DEFAULT '',
  feedback TEXT DEFAULT '',
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  tokens_cache INTEGER DEFAULT 0,
  cost_cny REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  log_path TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_no INTEGER DEFAULT 0,
  provider TEXT NOT NULL,
  model TEXT DEFAULT '',
  verdict TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  criteria_json TEXT DEFAULT '[]',
  findings_json TEXT DEFAULT '[]',
  required_fixes_json TEXT DEFAULT '[]',
  summary TEXT DEFAULT '',
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_cny REAL DEFAULT 0,
  raw_path TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT DEFAULT '',
  project_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '',
  type TEXT NOT NULL,
  level TEXT DEFAULT 'info',
  message TEXT DEFAULT '',
  data_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '',
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  run_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '',
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT DEFAULT '{}',
  result_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_audits_task ON audits(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at);
`;

function parseRow(row, jsonFields = {}) {
  if (!row) return null;
  const out = { ...row };
  for (const [key, fallback] of Object.entries(jsonFields)) {
    out[key] = readJsonValue(out[key], fallback);
  }
  return out;
}

function readJsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class Store {
  constructor(dbPath) {
    ensureDir(path.dirname(dbPath));
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // ---------------- projects ----------------
  createProject(p) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (id,name,description,repo_url,local_path,default_branch,test_command,language,agent_kind,audit_provider,protected_paths,config_json,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        p.name,
        p.description || '',
        p.repoUrl || '',
        p.localPath,
        p.defaultBranch || 'main',
        p.testCommand || '',
        p.language || '',
        p.agentKind || 'auto',
        p.auditProvider || 'auto',
        JSON.stringify(p.protectedPaths || []),
        JSON.stringify(p.config || {}),
        p.status || 'active',
        now,
        now,
      );
    return this.getProject(p.id);
  }

  getProject(id) {
    return parseRow(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id), {
      protected_paths: [],
      config_json: {},
    });
  }

  listProjects() {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all()
      .map((r) => parseRow(r, { protected_paths: [], config_json: {} }));
  }

  updateProject(id, patch) {
    const current = this.getProject(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name=?, description=?, repo_url=?, local_path=?, default_branch=?, test_command=?, language=?, agent_kind=?, audit_provider=?, protected_paths=?, config_json=?, status=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.name,
        merged.description || '',
        merged.repo_url || '',
        merged.local_path,
        merged.default_branch || 'main',
        merged.test_command || '',
        merged.language || '',
        merged.agent_kind || 'auto',
        merged.audit_provider || 'auto',
        JSON.stringify(merged.protected_paths || []),
        JSON.stringify(merged.config_json || {}),
        merged.status || 'active',
        nowIso(),
        id,
      );
    return this.getProject(id);
  }

  // ---------------- plans ----------------
  createPlan(p) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO plans (id,project_id,run_id,goal,title,mode,tasks_json,planner_meta_json,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        p.projectId,
        p.runId,
        p.goal,
        p.title || '',
        p.mode || 'single',
        JSON.stringify(p.tasks || []),
        JSON.stringify(p.plannerMeta || {}),
        p.status || 'active',
        now,
        now,
      );
    return this.getPlan(p.id);
  }

  getPlan(id) {
    return parseRow(this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id), {
      tasks_json: [],
      planner_meta_json: {},
    });
  }

  listPlans(projectId) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM plans ORDER BY created_at DESC LIMIT 50').all();
    return rows.map((r) => parseRow(r, { tasks_json: [], planner_meta_json: {} }));
  }

  updatePlan(id, patch) {
    const cur = this.getPlan(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    this.db
      .prepare('UPDATE plans SET title=?, status=?, tasks_json=?, planner_meta_json=?, updated_at=? WHERE id=?')
      .run(
        merged.title || '',
        merged.status || 'active',
        JSON.stringify(merged.tasks_json || []),
        JSON.stringify(merged.planner_meta_json || {}),
        nowIso(),
        id,
      );
    return this.getPlan(id);
  }

  // ---------------- runs ----------------
  createRun(r) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id,project_id,plan_id,goal,mode,status,current_task_id,budget_json,spent_json,stop_reason,result_json,started_at,ended_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.projectId,
        r.planId || '',
        r.goal,
        r.mode || 'single',
        r.status || 'queued',
        '',
        JSON.stringify(r.budget || {}),
        JSON.stringify(r.spent || { tokens: 0, costCny: 0 }),
        '',
        '{}',
        '',
        '',
        now,
        now,
      );
    return this.getRun(r.id);
  }

  getRun(id) {
    return parseRow(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id), {
      budget_json: {},
      spent_json: {},
      result_json: {},
    });
  }

  listRuns(projectId, limit = 20) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit)
      : this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map((r) => parseRow(r, { budget_json: {}, spent_json: {}, result_json: {} }));
  }

  listActiveRuns() {
    return this.db
      .prepare("SELECT * FROM runs WHERE status IN ('running','queued','paused') ORDER BY created_at ASC")
      .all()
      .map((r) => parseRow(r, { budget_json: {}, spent_json: {}, result_json: {} }));
  }

  updateRun(id, patch) {
    const cur = this.getRun(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE runs SET plan_id=?, status=?, current_task_id=?, budget_json=?, spent_json=?, stop_reason=?, result_json=?, started_at=?, ended_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.plan_id || '',
        merged.status,
        merged.current_task_id || '',
        JSON.stringify(merged.budget_json || {}),
        JSON.stringify(merged.spent_json || {}),
        merged.stop_reason || '',
        JSON.stringify(merged.result_json || {}),
        merged.started_at || '',
        merged.ended_at || '',
        nowIso(),
        id,
      );
    return this.getRun(id);
  }

  addRunUsage(runId, { tokens = 0, costCny = 0 }) {
    const run = this.getRun(runId);
    if (!run) return null;
    const spent = {
      tokens: Number(run.spent_json?.tokens || 0) + Number(tokens || 0),
      costCny: Number(run.spent_json?.costCny || 0) + Number(costCny || 0),
      updatedAt: nowIso(),
    };
    return this.updateRun(runId, { spent_json: spent });
  }

  // ---------------- tasks ----------------
  createTasks(rows) {
    const now = nowIso();
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id,project_id,plan_id,run_id,seq,title,description,acceptance_json,agent_kind,test_command,status,attempt,max_attempts,branch,base_commit,head_commit,worktree_path,session_id,blocked_reason,result_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const t of rows) {
        stmt.run(
          t.id,
          t.projectId,
          t.planId,
          t.runId,
          t.seq,
          t.title,
          t.description || '',
          JSON.stringify(t.acceptance || []),
          t.agentKind || 'auto',
          t.testCommand || '',
          t.status || 'queued',
          0,
          t.maxAttempts || 2,
          '',
          '',
          '',
          '',
          '',
          '',
          '{}',
          now,
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.listTasks({ planId: rows[0]?.planId });
  }

  getTask(id) {
    return parseRow(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), {
      acceptance_json: [],
      result_json: {},
    });
  }

  listTasks({ planId, runId, projectId, status } = {}) {
    const where = [];
    const params = [];
    if (planId) {
      where.push('plan_id = ?');
      params.push(planId);
    }
    if (runId) {
      where.push('run_id = ?');
      params.push(runId);
    }
    if (projectId) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ASC`;
    return this.db.prepare(sql).all(...params).map((r) => parseRow(r, { acceptance_json: [], result_json: {} }));
  }

  updateTask(id, patch) {
    const cur = this.getTask(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE tasks SET status=?, attempt=?, branch=?, base_commit=?, head_commit=?, worktree_path=?, session_id=?, blocked_reason=?, result_json=?, agent_kind=?, test_command=?, max_attempts=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.status,
        merged.attempt || 0,
        merged.branch || '',
        merged.base_commit || '',
        merged.head_commit || '',
        merged.worktree_path || '',
        merged.session_id || '',
        merged.blocked_reason || '',
        JSON.stringify(merged.result_json || {}),
        merged.agent_kind || 'auto',
        merged.test_command || '',
        merged.max_attempts || 2,
        nowIso(),
        id,
      );
    return this.getTask(id);
  }

  /** 确定性状态迁移：只有当前状态等于 from 时才更新，返回是否成功。 */
  transitionTask(id, from, to, extra = {}) {
    const cur = this.getTask(id);
    if (!cur || cur.status !== from) return false;
    this.updateTask(id, { ...extra, status: to });
    return true;
  }

  nextQueuedTask(planId) {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE plan_id = ? AND status = 'queued' ORDER BY seq ASC LIMIT 1")
      .get(planId);
    return parseRow(row, { acceptance_json: [], result_json: {} });
  }

  taskCounts(planId) {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE plan_id = ? GROUP BY status').all(planId);
    const counts = {};
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  resetTaskForRetry(id) {
    return this.updateTask(id, {
      status: 'queued',
      attempt: 0,
      blocked_reason: '',
      head_commit: '',
      result_json: {},
    });
  }

  // ---------------- attempts ----------------
  createAttempt(a) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO attempts (id,run_id,task_id,attempt_no,stage,agent_kind,session_id,prompt,exit_code,status,error,feedback,tokens_in,tokens_out,tokens_cache,cost_cny,duration_ms,log_path,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.id,
        a.runId,
        a.taskId,
        a.attemptNo,
        a.stage,
        a.agentKind || '',
        a.sessionId || '',
        a.prompt || '',
        a.exitCode ?? null,
        a.status || 'running',
        a.error || '',
        a.feedback || '',
        a.tokensIn || 0,
        a.tokensOut || 0,
        a.tokensCache || 0,
        a.costCny || 0,
        a.durationMs || 0,
        a.logPath || '',
        now,
        now,
      );
    return this.getAttempt(a.id);
  }

  getAttempt(id) {
    return this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) || null;
  }

  updateAttempt(id, patch) {
    const cur = this.getAttempt(id);
    if (!cur) return null;
    const normalized = {
      ...patch,
      session_id: patch.session_id ?? patch.sessionId ?? cur.session_id,
      exit_code: patch.exit_code ?? patch.exitCode ?? cur.exit_code,
      error: patch.error ?? cur.error,
      feedback: patch.feedback ?? cur.feedback,
      tokens_in: patch.tokens_in ?? patch.tokensIn ?? cur.tokens_in,
      tokens_out: patch.tokens_out ?? patch.tokensOut ?? cur.tokens_out,
      tokens_cache: patch.tokens_cache ?? patch.tokensCache ?? cur.tokens_cache,
      cost_cny: patch.cost_cny ?? patch.costCny ?? cur.cost_cny,
      duration_ms: patch.duration_ms ?? patch.durationMs ?? cur.duration_ms,
      log_path: patch.log_path ?? patch.logPath ?? cur.log_path,
    };
    const merged = { ...cur, ...normalized };
    this.db
      .prepare(
        `UPDATE attempts SET session_id=?, exit_code=?, status=?, error=?, feedback=?, tokens_in=?, tokens_out=?, tokens_cache=?, cost_cny=?, duration_ms=?, log_path=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.session_id || '',
        merged.exit_code ?? null,
        merged.status,
        merged.error || '',
        merged.feedback || '',
        merged.tokens_in || 0,
        merged.tokens_out || 0,
        merged.tokens_cache || 0,
        merged.cost_cny || 0,
        merged.duration_ms || 0,
        merged.log_path || '',
        nowIso(),
        id,
      );
    return this.getAttempt(id);
  }

  listAttempts(taskId) {
    return this.db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
  }

  markRunningAttemptsInterrupted() {
    const now = nowIso();
    return this.db
      .prepare("UPDATE attempts SET status='interrupted', updated_at=? WHERE status='running'")
      .run(now).changes;
  }

  // ---------------- audits ----------------
  createAudit(a) {
    this.db
      .prepare(
        `INSERT INTO audits (id,run_id,task_id,attempt_no,provider,model,verdict,score,criteria_json,findings_json,required_fixes_json,summary,tokens_in,tokens_out,cost_cny,raw_path,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.id,
        a.runId,
        a.taskId,
        a.attemptNo || 0,
        a.provider,
        a.model || '',
        a.verdict,
        a.score || 0,
        JSON.stringify(a.criteria || []),
        JSON.stringify(a.findings || []),
        JSON.stringify(a.requiredFixes || []),
        a.summary || '',
        a.tokensIn || 0,
        a.tokensOut || 0,
        a.costCny || 0,
        a.rawPath || '',
        nowIso(),
      );
    return this.getAudit(a.id);
  }

  getAudit(id) {
    return parseRow(this.db.prepare('SELECT * FROM audits WHERE id = ?').get(id), {
      criteria_json: [],
      findings_json: [],
      required_fixes_json: [],
    });
  }

  listAudits(taskId) {
    return this.db
      .prepare('SELECT * FROM audits WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId)
      .map((r) => parseRow(r, { criteria_json: [], findings_json: [], required_fixes_json: [] }));
  }

  // ---------------- events ----------------
  appendEvent(e) {
    const created = nowIso();
    const info = this.db
      .prepare(
        'INSERT INTO events (run_id,project_id,task_id,type,level,message,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(e.runId || '', e.projectId || '', e.taskId || '', e.type, e.level || 'info', String(e.message || '').slice(0, 4000), JSON.stringify(e.data || {}), created);
    return { id: Number(info.lastInsertRowid), ...e, createdAt: created };
  }

  listEvents({ runId, projectId, after = 0, limit = 200 } = {}) {
    const where = ['id > ?'];
    const params = [after];
    if (runId) {
      where.push('run_id = ?');
      params.push(runId);
    }
    if (projectId) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    params.push(limit);
    return this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`)
      .all(...params)
      .map((r) => parseRow(r, { data_json: {} }));
  }

  // ---------------- artifacts ----------------
  addArtifact(a) {
    this.db
      .prepare('INSERT INTO artifacts (id,run_id,task_id,kind,path,meta_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(a.id, a.runId || '', a.taskId || '', a.kind, a.path, JSON.stringify(a.meta || {}), nowIso());
    return a;
  }

  listArtifacts(taskId) {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId)
      .map((r) => parseRow(r, { meta_json: {} }));
  }

  // ---------------- actions (需要授权/自动执行的外部动作) ----------------
  createAction(a) {
    const now = nowIso();
    this.db
      .prepare('INSERT INTO actions (id,run_id,task_id,type,status,payload_json,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.runId || '', a.taskId || '', a.type, a.status || 'pending', JSON.stringify(a.payload || {}), JSON.stringify(a.result || {}), now, now);
    return this.getAction(a.id);
  }

  getAction(id) {
    return parseRow(this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id), { payload_json: {}, result_json: {} });
  }

  updateAction(id, patch) {
    const cur = this.getAction(id);
    if (!cur) return null;
    // 兼容 result / result_json 两种调用写法（历史缺陷：仅读 result_json 会丢结果）
    const merged = { ...cur, ...patch };
    const result = patch.result !== undefined ? patch.result : patch.result_json !== undefined ? patch.result_json : merged.result_json;
    this.db
      .prepare('UPDATE actions SET status=?, result_json=?, updated_at=? WHERE id=?')
      .run(merged.status, JSON.stringify(result || {}), nowIso(), id);
    return this.getAction(id);
  }

  listActions(runId) {
    return this.db
      .prepare('SELECT * FROM actions WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId)
      .map((r) => parseRow(r, { payload_json: {}, result_json: {} }));
  }

  // ---------------- stats ----------------
  usageTotals() {
    const attempts = this.db.prepare('SELECT COALESCE(SUM(tokens_in),0) a, COALESCE(SUM(tokens_out),0) b, COALESCE(SUM(tokens_cache),0) c, COALESCE(SUM(cost_cny),0) d FROM attempts').get();
    const audits = this.db.prepare('SELECT COALESCE(SUM(tokens_in),0) a, COALESCE(SUM(tokens_out),0) b, COALESCE(SUM(cost_cny),0) c FROM audits').get();
    const tokens = Number(attempts.a) + Number(attempts.b) + Number(attempts.c) + Number(audits.a) + Number(audits.b);
    return {
      tokens,
      tokensIn: Number(attempts.a) + Number(audits.a),
      tokensOut: Number(attempts.b) + Number(audits.b),
      tokensCache: Number(attempts.c),
      costCny: Number(attempts.d) + Number(audits.c),
    };
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? readJsonValue(row.value, fallback) : fallback;
  }
}

export function openStore(dbPath) {
  return new Store(dbPath);
}
