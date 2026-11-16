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

CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  mode TEXT DEFAULT 'plan',
  status TEXT NOT NULL DEFAULT 'running',
  round INTEGER DEFAULT 0,
  max_rounds INTEGER DEFAULT 3,
  queue_json TEXT DEFAULT '[]',
  history_json TEXT DEFAULT '[]',
  contract_files_json TEXT DEFAULT '[]',
  current_run_id TEXT DEFAULT '',
  last_run_id TEXT DEFAULT '',
  stop_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '',
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  details_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT DEFAULT '',
  decided_by TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_audits_task ON audits(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_loops_project ON loops(project_id, status);
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
    this.migrate();
  }

  migrate() {
    const columns = {
      projects: [
        ['budget_json', "TEXT DEFAULT '{}'"],
        ['agent_config_json', "TEXT DEFAULT '{}'"],
        ['contract_files', "TEXT DEFAULT '[]'"],
        ['ci_required', 'INTEGER DEFAULT 1'],
        ['allow_local_acceptance', 'INTEGER DEFAULT 1'],
        ['remote_push_authorized', 'INTEGER DEFAULT 0'],
        ['write_owner', "TEXT DEFAULT ''"],
        ['lease_expires_at', "TEXT DEFAULT ''"],
        ['lease_fence', 'INTEGER DEFAULT 0'],
      ],
      runs: [
        ['verification_status', "TEXT DEFAULT 'LOCAL_VERIFIED'"],
        ['verified_sha', "TEXT DEFAULT ''"],
        ['ci_status', "TEXT DEFAULT ''"],
        ['ci_url', "TEXT DEFAULT ''"],
        ['ci_checked_at', "TEXT DEFAULT ''"],
        ['wall_deadline', "TEXT DEFAULT ''"],
        ['parent_run_id', "TEXT DEFAULT ''"],
        ['lease_owner', "TEXT DEFAULT ''"],
        ['lease_expires_at', "TEXT DEFAULT ''"],
        ['lease_fence', 'INTEGER DEFAULT 0'],
        ['reconciliation_json', "TEXT DEFAULT '{}'"],
      ],
      tasks: [
        ['verification_json', "TEXT DEFAULT '{}'"],
        ['failure_signature', "TEXT DEFAULT ''"],
        ['repeated_failures', 'INTEGER DEFAULT 0'],
      ],
      attempts: [
        ['cost_reported', 'INTEGER DEFAULT 0'],
        ['cost_source', "TEXT DEFAULT 'estimated'"],
        ['provider', "TEXT DEFAULT ''"],
        ['model', "TEXT DEFAULT ''"],
        ['provider_known', 'INTEGER DEFAULT 0'],
        ['provider_source', "TEXT DEFAULT ''"],
        ['failure_class', "TEXT DEFAULT ''"],
      ],
      audits: [
        ['budget_scope', "TEXT DEFAULT 'global'"],
        ['verification_status', "TEXT DEFAULT ''"],
        ['evidence_hash', "TEXT DEFAULT ''"],
        ['diff_hash', "TEXT DEFAULT ''"],
        ['independence', "TEXT DEFAULT 'unknown'"],
        ['provider_known', 'INTEGER DEFAULT 0'],
        ['provider_source', "TEXT DEFAULT ''"],
        ['failure_class', "TEXT DEFAULT ''"],
      ],
    };
    for (const [table, cols] of Object.entries(columns)) {
      for (const [name, ddl] of cols) {
        try {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
        } catch {
          /* 列已存在 */
        }
      }
    }
    // 旧记录回填 provider（用于按模型族分开统计；不改动金额/用量）
    try {
      this.db.exec("UPDATE attempts SET provider='glm' WHERE (provider IS NULL OR provider='') AND agent_kind='claude'");
      this.db.exec("UPDATE attempts SET provider='deepseek' WHERE (provider IS NULL OR provider='') AND agent_kind IN ('dsh','planning','deepseek')");
      this.db.exec("UPDATE attempts SET provider='unknown' WHERE provider IS NULL OR provider=''");
      // 历史记录：旧版按 agentKind 推断 provider；标记 known=1 并保留来源，避免重复/回退费用口径
      this.db.exec("UPDATE attempts SET provider_known=1, provider_source='legacy_inferred' WHERE provider IN ('glm','deepseek') AND provider_known=0 AND provider_source=''");
      this.db.exec("UPDATE attempts SET provider='unknown', provider_known=0, provider_source='legacy_unknown' WHERE provider NOT IN ('glm','deepseek','openai','anthropic') AND provider_source=''");
      this.db.exec("UPDATE audits SET provider_known=1, provider_source='legacy_inferred' WHERE provider IN ('glm','deepseek','openai','anthropic') AND provider_known=0 AND provider_source=''");
    } catch {
      /* ignore */
    }
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
        `INSERT INTO projects (id,name,description,repo_url,local_path,default_branch,test_command,language,agent_kind,audit_provider,protected_paths,config_json,budget_json,agent_config_json,contract_files,ci_required,allow_local_acceptance,remote_push_authorized,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        JSON.stringify(p.budget || {}),
        JSON.stringify(p.agentConfig || {}),
        JSON.stringify(p.contractFiles || []),
        p.ciRequired === false ? 0 : 1,
        p.allowLocalAcceptance === false ? 0 : 1,
        p.remotePushAuthorized ? 1 : 0,
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
      budget_json: {},
      agent_config_json: {},
      contract_files: [],
    });
  }

  listProjects() {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all()
      .map((r) => parseRow(r, { protected_paths: [], config_json: {}, budget_json: {}, agent_config_json: {}, contract_files: [] }));
  }

  updateProject(id, patch) {
    const current = this.getProject(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name=?, description=?, repo_url=?, local_path=?, default_branch=?, test_command=?, language=?, agent_kind=?, audit_provider=?, protected_paths=?, config_json=?, budget_json=?, agent_config_json=?, contract_files=?, ci_required=?, allow_local_acceptance=?, remote_push_authorized=?, status=?, updated_at=? WHERE id=?`,
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
        JSON.stringify(merged.budget_json || {}),
        JSON.stringify(merged.agent_config_json || {}),
        JSON.stringify(merged.contract_files || []),
        merged.ci_required ? 1 : 0,
        merged.allow_local_acceptance ? 1 : 0,
        merged.remote_push_authorized ? 1 : 0,
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
    if (typeof merged.verification_json === 'string') {
      try { merged.verification_json = JSON.parse(merged.verification_json); } catch { merged.verification_json = {}; }
    }
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
        `INSERT INTO runs (id,project_id,plan_id,goal,mode,status,current_task_id,budget_json,spent_json,stop_reason,result_json,verification_status,verified_sha,ci_status,ci_url,ci_checked_at,wall_deadline,parent_run_id,started_at,ended_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        r.verificationStatus || 'LOCAL_VERIFIED',
        '',
        '',
        '',
        '',
        r.wallDeadline || '',
        r.parentRunId || '',
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
    if (typeof merged.verification_json === 'string') {
      try { merged.verification_json = JSON.parse(merged.verification_json); } catch { merged.verification_json = {}; }
    }
    this.db
      .prepare(
        `UPDATE runs SET plan_id=?, status=?, current_task_id=?, budget_json=?, spent_json=?, stop_reason=?, result_json=?, verification_status=?, verified_sha=?, ci_status=?, ci_url=?, ci_checked_at=?, wall_deadline=?, parent_run_id=?, started_at=?, ended_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.plan_id || '',
        merged.status,
        merged.current_task_id || '',
        JSON.stringify(merged.budget_json || {}),
        JSON.stringify(merged.spent_json || {}),
        merged.stop_reason || '',
        JSON.stringify(merged.result_json || {}),
        merged.verification_status || 'LOCAL_VERIFIED',
        merged.verified_sha || '',
        merged.ci_status || '',
        merged.ci_url || '',
        merged.ci_checked_at || '',
        merged.wall_deadline || '',
        merged.parent_run_id || '',
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
      verification_json: {},
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
    if (typeof merged.verification_json === 'string') {
      try { merged.verification_json = JSON.parse(merged.verification_json); } catch { merged.verification_json = {}; }
    }
    this.db
      .prepare(
        `UPDATE tasks SET status=?, attempt=?, branch=?, base_commit=?, head_commit=?, worktree_path=?, session_id=?, blocked_reason=?, result_json=?, verification_json=?, failure_signature=?, repeated_failures=?, agent_kind=?, test_command=?, max_attempts=?, updated_at=? WHERE id=?`,
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
        JSON.stringify(merged.verification_json || {}),
        merged.failure_signature || '',
        Number(merged.repeated_failures || 0),
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
    return parseRow(row, { acceptance_json: [], result_json: {}, verification_json: {} });
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
        `INSERT INTO attempts (id,run_id,task_id,attempt_no,stage,agent_kind,session_id,prompt,exit_code,status,error,feedback,tokens_in,tokens_out,tokens_cache,cost_cny,cost_reported,cost_source,provider,model,provider_known,provider_source,duration_ms,log_path,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        a.costReported ? 1 : 0,
        a.costSource || (a.costReported ? 'vendor' : 'estimated'),
        a.provider || '',
        a.model || '',
        a.providerKnown ? 1 : 0,
        a.providerSource || '',
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
      cost_reported: patch.cost_reported ?? patch.costReported ?? cur.cost_reported,
      cost_source: patch.cost_source ?? patch.costSource ?? cur.cost_source,
      provider: patch.provider ?? cur.provider,
      model: patch.model ?? cur.model,
      provider_known: patch.provider_known ?? patch.providerKnown ?? cur.provider_known,
      provider_source: patch.provider_source ?? patch.providerSource ?? cur.provider_source,
      failure_class: patch.failure_class ?? patch.failureClass ?? cur.failure_class,
      duration_ms: patch.duration_ms ?? patch.durationMs ?? cur.duration_ms,
      log_path: patch.log_path ?? patch.logPath ?? cur.log_path,
    };
    const merged = { ...cur, ...normalized };
    this.db
      .prepare(
        `UPDATE attempts SET session_id=?, exit_code=?, status=?, error=?, feedback=?, tokens_in=?, tokens_out=?, tokens_cache=?, cost_cny=?, cost_reported=?, cost_source=?, provider=?, model=?, provider_known=?, provider_source=?, failure_class=?, duration_ms=?, log_path=?, updated_at=? WHERE id=?`,
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
        merged.cost_reported ? 1 : 0,
        merged.cost_source || 'estimated',
        merged.provider || '',
        merged.model || '',
        merged.provider_known ? 1 : 0,
        merged.provider_source || '',
        merged.failure_class || '',
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
      .prepare("UPDATE attempts SET status='interrupted', cost_source=CASE WHEN cost_cny=0 AND tokens_in=0 AND tokens_out=0 AND tokens_cache=0 THEN 'unknown' ELSE cost_source END, error=CASE WHEN error='' THEN '工作台进程中断：厂商最终用量未返回，费用/Tokens 标记为未知（不伪造为 0）' ELSE error END, updated_at=? WHERE status='running'")
      .run(now).changes;
  }

  // ---------------- audits ----------------
  createAudit(a) {
    this.db
      .prepare(
        `INSERT INTO audits (id,run_id,task_id,attempt_no,provider,model,provider_known,provider_source,budget_scope,verdict,score,criteria_json,findings_json,required_fixes_json,summary,tokens_in,tokens_out,cost_cny,raw_path,verification_status,evidence_hash,diff_hash,independence,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.id,
        a.runId,
        a.taskId,
        a.attemptNo || 0,
        a.provider,
        a.model || '',
        a.providerKnown ? 1 : 0,
        a.providerSource || '',
        a.budgetScope || 'global',
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
        a.verificationStatus || (a.verdict === 'pass' ? 'PASS' : a.verdict === 'unknown' ? 'UNKNOWN' : 'FAIL'),
        a.evidenceHash || '',
        a.diffHash || '',
        a.independence || 'unknown',
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
  usageForProject(projectId) {
    const attempts = this.db
      .prepare(`SELECT COALESCE(SUM(a.tokens_in),0) a, COALESCE(SUM(a.tokens_out),0) b, COALESCE(SUM(a.tokens_cache),0) c, COALESCE(SUM(a.cost_cny),0) d
                FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.project_id = ?`)
      .get(projectId);
    const audits = this.db
      .prepare(`SELECT COALESCE(SUM(au.tokens_in),0) a, COALESCE(SUM(au.tokens_out),0) b, COALESCE(SUM(au.cost_cny),0) c
                FROM audits au JOIN runs r ON r.id = au.run_id WHERE r.project_id = ?`)
      .get(projectId);
    const tokensIn = Number(attempts.a) + Number(audits.a);
    const tokensOut = Number(attempts.b) + Number(audits.b);
    const tokensCache = Number(attempts.c);
    return {
      tokens: tokensIn + tokensOut + tokensCache,
      tokensIn,
      tokensOut,
      tokensCache,
      costCny: Number(attempts.d) + Number(audits.c),
    };
  }

  usageTotals() {
    const attemptRows = this.db.prepare(`SELECT provider, MAX(provider_known) known, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(tokens_cache),0) tc, COALESCE(SUM(cost_cny),0) cost FROM attempts GROUP BY provider`).all();
    const auditRows = this.db.prepare(`SELECT provider, MAX(provider_known) known, COALESCE(SUM(CASE WHEN budget_scope<>'project_audit' THEN tokens_in ELSE 0 END),0) tin, COALESCE(SUM(CASE WHEN budget_scope<>'project_audit' THEN tokens_out ELSE 0 END),0) tout, COALESCE(SUM(CASE WHEN budget_scope<>'project_audit' THEN cost_cny ELSE 0 END),0) cost FROM audits GROUP BY provider`).all();
    const scoped = this.db.prepare(`SELECT provider, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(cost_cny),0) cost FROM audits WHERE budget_scope='project_audit' GROUP BY provider`).all();
    const byProvider = {};
    const ensure = (name) => {
      const key = name || 'unknown';
      if (!byProvider[key]) byProvider[key] = { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0, known: false };
      return byProvider[key];
    };
    for (const r of attemptRows) {
      const agg = ensure(r.provider || 'unknown');
      agg.tokensIn += Number(r.tin);
      agg.tokensOut += Number(r.tout);
      agg.tokensCache += Number(r.tc);
      agg.costCny += Number(r.cost);
      agg.known = agg.known || Number(r.known) === 1;
    }
    for (const r of auditRows) {
      const agg = ensure(r.provider || 'unknown');
      agg.tokensIn += Number(r.tin);
      agg.tokensOut += Number(r.tout);
      agg.costCny += Number(r.cost);
      agg.known = agg.known || Number(r.known) === 1;
    }
    for (const agg of Object.values(byProvider)) agg.tokens = agg.tokensIn + agg.tokensOut + agg.tokensCache;
    const total = Object.values(byProvider).reduce((acc, a) => {
      acc.tokensIn += a.tokensIn; acc.tokensOut += a.tokensOut; acc.tokensCache += a.tokensCache; acc.tokens += a.tokens; acc.costCny += a.costCny;
      return acc;
    }, { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0 });
    const projectAudit = scoped.reduce((acc, r) => { acc.tokensIn += Number(r.tin); acc.tokensOut += Number(r.tout); acc.tokens += Number(r.tin) + Number(r.tout); acc.costCny += Number(r.cost); return acc; }, { tokensIn: 0, tokensOut: 0, tokens: 0, costCny: 0 });
    return { ...total, byProvider, projectAudit };
  }

  auditBudgetUsage(projectId) {
    const rows = this.db.prepare("SELECT COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(cost_cny),0) cost, COUNT(*) calls FROM audits a JOIN runs r ON r.id=a.run_id WHERE r.project_id=? AND a.budget_scope='project_audit'").all(projectId);
    const r = rows[0] || {};
    return { tokens: Number(r.tin || 0) + Number(r.tout || 0), costCny: Number(r.cost || 0), calls: Number(r.calls || 0) };
  }

  usageForProject(projectId) {
    const attemptRows = this.db.prepare(`SELECT a.provider, MAX(a.provider_known) known, COALESCE(SUM(a.tokens_in),0) tin, COALESCE(SUM(a.tokens_out),0) tout, COALESCE(SUM(a.tokens_cache),0) tc, COALESCE(SUM(a.cost_cny),0) cost FROM attempts a JOIN runs r ON r.id=a.run_id WHERE r.project_id=? GROUP BY a.provider`).all(projectId);
    const auditRows = this.db.prepare(`SELECT au.provider, MAX(au.provider_known) known, COALESCE(SUM(au.tokens_in),0) tin, COALESCE(SUM(au.tokens_out),0) tout, COALESCE(SUM(au.cost_cny),0) cost FROM audits au JOIN runs r ON r.id=au.run_id WHERE r.project_id=? GROUP BY au.provider`).all(projectId);
    const byProvider = {};
    const ensure = (name) => { const k = name || 'unknown'; if (!byProvider[k]) byProvider[k] = { tokensIn:0,tokensOut:0,tokensCache:0,tokens:0,costCny:0,known:false }; return byProvider[k]; };
    for (const r of attemptRows) { const a=ensure(r.provider||'unknown'); a.tokensIn+=Number(r.tin); a.tokensOut+=Number(r.tout); a.tokensCache+=Number(r.tc); a.costCny+=Number(r.cost); a.known=a.known||Number(r.known)===1; }
    for (const r of auditRows) { const a=ensure(r.provider||'unknown'); a.tokensIn+=Number(r.tin); a.tokensOut+=Number(r.tout); a.costCny+=Number(r.cost); a.known=a.known||Number(r.known)===1; }
    for (const a of Object.values(byProvider)) a.tokens=a.tokensIn+a.tokensOut+a.tokensCache;
    const total = Object.values(byProvider).reduce((acc,a)=>{acc.tokensIn+=a.tokensIn;acc.tokensOut+=a.tokensOut;acc.tokensCache+=a.tokensCache;acc.tokens+=a.tokens;acc.costCny+=a.costCny;return acc;},{tokensIn:0,tokensOut:0,tokensCache:0,tokens:0,costCny:0});
    return { ...total, byProvider };
  }

  activeRunForProject(projectId, excludeRunId = '') {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND status IN ('queued','running','paused','interrupted') ORDER BY created_at ASC")
      .all(projectId);
    return rows.map((r) => parseRow(r, { budget_json: {}, spent_json: {}, result_json: {} })).find((r) => r.id !== excludeRunId) || null;
  }

  createApproval(a) {
    const now = nowIso();
    this.db
      .prepare('INSERT INTO approvals (id,run_id,task_id,type,status,title,details_json,created_at,updated_at,decided_at,decided_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.runId || '', a.taskId || '', a.type, a.status || 'pending', a.title || '', JSON.stringify(a.details || {}), now, now, '', '');
    return this.getApproval(a.id);
  }

  getApproval(id) {
    return parseRow(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id), { details_json: {} });
  }

  listApprovals({ status = '', runId = '' } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (runId) { where.push('run_id = ?'); params.push(runId); }
    const sql = `SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`;
    return this.db.prepare(sql).all(...params).map((r) => parseRow(r, { details_json: {} }));
  }

  updateApproval(id, patch) {
    const cur = this.getApproval(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    if (typeof merged.verification_json === 'string') {
      try { merged.verification_json = JSON.parse(merged.verification_json); } catch { merged.verification_json = {}; }
    }
    this.db
      .prepare('UPDATE approvals SET status=?, details_json=?, decided_at=?, decided_by=?, updated_at=? WHERE id=?')
      .run(merged.status, JSON.stringify(merged.details_json || {}), merged.decided_at || '', merged.decided_by || '', nowIso(), id);
    return this.getApproval(id);
  }

  createLoop(l) {
    const now = nowIso();
    this.db.prepare('INSERT INTO loops (id,project_id,goal,mode,status,round,max_rounds,queue_json,history_json,contract_files_json,current_run_id,last_run_id,stop_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(l.id, l.projectId, l.goal, l.mode || 'plan', l.status || 'running', 0, l.maxRounds || 3, JSON.stringify(l.queue || []), JSON.stringify([]), JSON.stringify(l.contractFiles || []), '', '', '', now, now);
    return this.getLoop(l.id);
  }

  getLoop(id) {
    return parseRow(this.db.prepare('SELECT * FROM loops WHERE id=?').get(id), { queue_json: [], history_json: [], contract_files_json: [] });
  }

  listLoops({ projectId = '', status = '' } = {}) {
    const where = []; const params = [];
    if (projectId) { where.push('project_id=?'); params.push(projectId); }
    if (status) { where.push('status=?'); params.push(status); }
    return this.db.prepare(`SELECT * FROM loops ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 100`).all(...params)
      .map((r) => parseRow(r, { queue_json: [], history_json: [], contract_files_json: [] }));
  }

  updateLoop(id, patch) {
    const cur = this.getLoop(id); if (!cur) return null;
    const m = { ...cur, ...patch };
    this.db.prepare('UPDATE loops SET status=?,round=?,max_rounds=?,queue_json=?,history_json=?,contract_files_json=?,current_run_id=?,last_run_id=?,stop_reason=?,updated_at=? WHERE id=?')
      .run(m.status, m.round, m.max_rounds, JSON.stringify(m.queue_json || []), JSON.stringify(m.history_json || []), JSON.stringify(m.contract_files_json || []), m.current_run_id || '', m.last_run_id || '', m.stop_reason || '', nowIso(), id);
    return this.getLoop(id);
  }

  /**
   * 原子获取项目写租约并返回单调递增的 fencing token。
   * 过期租约不会“被视为仍然有效”；新执行者获取时 fence 自增，旧执行者的 token 永久失效。
   */
  acquireProjectLeaseFenced(projectId, owner, ttlMs = 90_000) {
    const now = nowIso();
    const expires = new Date(Date.now() + ttlMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT write_owner, lease_expires_at, lease_fence FROM projects WHERE id=?').get(projectId);
      if (!row) { this.db.exec('ROLLBACK'); return { ok: false, fence: 0, reason: 'project-not-found' }; }
      const held = row.write_owner && row.write_owner !== owner && row.lease_expires_at && row.lease_expires_at > now;
      if (held) { this.db.exec('ROLLBACK'); return { ok: false, fence: Number(row.lease_fence || 0), reason: 'lease-held-by-other' }; }
      const nextFence = Number(row.lease_fence || 0) + 1;
      this.db.prepare('UPDATE projects SET write_owner=?, lease_expires_at=?, lease_fence=?, updated_at=? WHERE id=?').run(owner, expires, nextFence, now, projectId);
      this.db.exec('COMMIT');
      return { ok: true, fence: nextFence, expiresAt: expires };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  /** 兼容旧调用：成功返回 true；新代码应使用带 fence 的版本。 */
  acquireProjectLease(projectId, owner, ttlMs = 90_000) {
    return this.acquireProjectLeaseFenced(projectId, owner, ttlMs).ok;
  }

  getProjectLease(projectId) {
    return this.db.prepare('SELECT write_owner, lease_expires_at, lease_fence FROM projects WHERE id=?').get(projectId) || null;
  }

  /** 只有 owner + fence + 未过期同时匹配才续租；任何一项失败都视为失去写权。 */
  renewProjectLeaseFenced(projectId, owner, fence, ttlMs = 90_000) {
    const now = nowIso();
    const expires = new Date(Date.now() + ttlMs).toISOString();
    return this.db.prepare("UPDATE projects SET lease_expires_at=?, updated_at=? WHERE id=? AND write_owner=? AND lease_fence=? AND lease_expires_at>?").run(expires, now, projectId, owner, Number(fence), now).changes > 0;
  }

  renewProjectLease(projectId, owner, ttlMs = 90_000) {
    const row = this.getProjectLease(projectId);
    if (!row || row.write_owner !== owner) return false;
    return this.renewProjectLeaseFenced(projectId, owner, row.lease_fence, ttlMs);
  }

  releaseProjectLeaseFenced(projectId, owner, fence) {
    return this.db.prepare("UPDATE projects SET write_owner='', lease_expires_at='', updated_at=? WHERE id=? AND write_owner=? AND lease_fence=?").run(nowIso(), projectId, owner, Number(fence)).changes > 0;
  }

  releaseProjectLease(projectId, owner) {
    return this.db.prepare("UPDATE projects SET write_owner='', lease_expires_at='', updated_at=? WHERE id=? AND write_owner=?").run(nowIso(), projectId, owner).changes > 0;
  }

  clearExpiredLeases() {
    const now = nowIso();
    // fence 不重置；新 owner 通过自增 fence 获得更高写权，旧 token 无法再写。
    return { projects: this.db.prepare("UPDATE projects SET write_owner='', lease_expires_at='' WHERE lease_expires_at<>'' AND lease_expires_at<?").run(now).changes,
      runs: this.db.prepare("UPDATE runs SET lease_owner='', lease_expires_at='' WHERE lease_expires_at<>'' AND lease_expires_at<?").run(now).changes };
  }

  /** run 租约不能覆盖其他有效执行者；fence 只能前进，不能回退。 */
  setRunLeaseFenced(runId, owner, fence, ttlMs = 90_000) {
    const now = nowIso();
    const expires = new Date(Date.now() + ttlMs).toISOString();
    let result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT lease_owner, lease_expires_at, lease_fence FROM runs WHERE id=?').get(runId);
      if (!row) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'run-not-found' }; }
      const held = row.lease_owner && row.lease_owner !== owner && row.lease_expires_at && row.lease_expires_at > now;
      if (held || Number(row.lease_fence || 0) > Number(fence)) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: held ? 'run-lease-held' : 'stale-fence', fence: Number(row.lease_fence || 0) };
      }
      result = this.db.prepare('UPDATE runs SET lease_owner=?, lease_expires_at=?, lease_fence=? WHERE id=? AND (lease_owner=? OR lease_owner=? OR lease_expires_at<?)').run(owner, expires, Number(fence), runId, '', owner, now);
      this.db.exec('COMMIT');
      return { ok: result.changes > 0, fence: Number(fence) };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  setRunLease(runId, owner, ttlMs = 90_000, fence = 0) {
    return this.setRunLeaseFenced(runId, owner, fence, ttlMs);
  }

  clearRunLeaseFenced(runId, owner, fence) {
    return this.db.prepare("UPDATE runs SET lease_owner='', lease_expires_at='' WHERE id=? AND lease_owner=? AND lease_fence=?").run(runId, owner, Number(fence)).changes > 0;
  }

  clearRunLease(runId) {
    return this.db.prepare("UPDATE runs SET lease_owner='', lease_expires_at='' WHERE id=?").run(runId);
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
