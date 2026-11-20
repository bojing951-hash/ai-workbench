// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite 持久化层（Node 24 内置 node:sqlite，零原生依赖）。
 * 所有运行状态可恢复：runs / tasks / attempts / audits / events / actions。
 */
import path from 'node:path';
import crypto from 'node:crypto';
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
  conversation_id TEXT DEFAULT '',
  request_key TEXT DEFAULT '',
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

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  project_id TEXT DEFAULT '',
  run_id TEXT DEFAULT '',
  loop_id TEXT DEFAULT '',
  goal TEXT DEFAULT '',
  acceptance_json TEXT DEFAULT '[]',
  brief_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'draft',
  request_key TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  request_key TEXT DEFAULT '',
  reply_to TEXT DEFAULT '',
  data_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  source_id TEXT UNIQUE,
  source TEXT NOT NULL,
  run_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '',
  project_id TEXT DEFAULT '',
  conversation_id TEXT DEFAULT '',
  provider TEXT DEFAULT 'unknown',
  provider_known INTEGER DEFAULT 0,
  provider_source TEXT DEFAULT '',
  model TEXT DEFAULT '',
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  tokens_cache INTEGER DEFAULT 0,
  cost_cny REAL DEFAULT 0,
  cost_source TEXT DEFAULT 'estimated',
  usage_known INTEGER DEFAULT 0,
  budget_scope TEXT DEFAULT 'global',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_reservations (
  id TEXT PRIMARY KEY,
  request_key TEXT DEFAULT '',
  provider TEXT DEFAULT 'unknown',
  model TEXT DEFAULT '',
  estimated_tokens INTEGER DEFAULT 0,
  estimated_cost_cny REAL DEFAULT 0,
  actual_tokens INTEGER DEFAULT 0,
  actual_cost_cny REAL DEFAULT 0,
  status TEXT DEFAULT 'reserved',
  usage_known INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  settled_at TEXT DEFAULT '',
  experiment_id TEXT DEFAULT '',
  experiment_scope TEXT DEFAULT 'global',
  exempt_global INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS experiment_contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  conversation_id TEXT DEFAULT '',
  authorized_by TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  authorization_source TEXT DEFAULT '',
  authorization_text_hash TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  status TEXT DEFAULT 'authorized',
  token_limit INTEGER DEFAULT 0,
  cost_limit_cny REAL DEFAULT 0,
  stop_loss_cny REAL DEFAULT 0,
  call_limit INTEGER DEFAULT 0,
  deadline_at TEXT DEFAULT '',
  glm_token_limit INTEGER DEFAULT 0,
  glm_cost_limit_cny REAL DEFAULT 0,
  dsh_token_limit INTEGER DEFAULT 0,
  dsh_cost_limit_cny REAL DEFAULT 0,
  non_glm_cost_limit_cny REAL DEFAULT 0,
  per_call_max_tokens INTEGER DEFAULT 0,
  provider_json TEXT DEFAULT '{}',
  isolation_mode TEXT DEFAULT '',
  stop_conditions_json TEXT DEFAULT '[]',
  ended_at TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_reservations_request ON model_reservations(request_key) WHERE request_key<>'';
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_project_active ON experiment_contracts(project_id) WHERE project_id<>'' AND status IN ('authorized','running');
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages(conversation_id, created_at);
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

function experimentContractPayload(row) {
  return {
    version: String(row.contract_version || 'e2e-budget-v1'),
    projectId: row.project_id || '', conversationId: row.conversation_id || '',
    authorizedBy: String(row.authorized_by || ''), authorizedAt: row.authorized_at || '',
    authorizationSource: String(row.authorization_source || ''),
    tokenLimit: Number(row.token_limit), costLimitCny: Number(row.cost_limit_cny),
    stopLossCny: Number(row.stop_loss_cny || 0), callLimit: Number(row.call_limit),
    deadlineAt: String(row.deadline_at || ''),
    glmTokenLimit: Number(row.glm_token_limit || 0), glmCostLimitCny: Number(row.glm_cost_limit_cny || 0),
    dshTokenLimit: Number(row.dsh_token_limit || 0), dshCostLimitCny: Number(row.dsh_cost_limit_cny || 0),
    nonGlmCostLimitCny: Number(row.non_glm_cost_limit_cny || 0), perCallMaxTokens: Number(row.per_call_max_tokens || 0),
    provider: row.provider_json ? JSON.parse(row.provider_json) : {}, isolationMode: String(row.isolation_mode || ''),
    stopConditions: row.stop_conditions_json ? JSON.parse(row.stop_conditions_json) : [],
  };
}

function experimentContractHashFor(row) {
  return crypto.createHash('sha256').update(JSON.stringify(experimentContractPayload(row))).digest('hex');
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
    // 先设置 busy timeout，避免多个独立进程同时打开 WAL 数据库时在 journal_mode 切换处直接 locked。
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
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
        ['pause_kind', "TEXT DEFAULT ''"],
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
        ['request_key', "TEXT DEFAULT ''"],
      ],
      loops: [
        ['pending_task_json', "TEXT DEFAULT '{}'"],
        ['product_repair_count', 'INTEGER DEFAULT 0'],
        ['auto_repair_count', 'INTEGER DEFAULT 0'],
        ['auto_retry_count', 'INTEGER DEFAULT 0'],
      ],
      tasks: [
        ['verification_json', "TEXT DEFAULT '{}'"],
        ['failure_signature', "TEXT DEFAULT ''"],
        ['repeated_failures', 'INTEGER DEFAULT 0'],
      ],
      conversations: [
        ['request_key', "TEXT DEFAULT ''"],
      ],
      conversation_messages: [
        ['request_key', "TEXT DEFAULT ''"],
        ['reply_to', "TEXT DEFAULT ''"],
      ],
      actions: [
        ['conversation_id', "TEXT DEFAULT ''"],
        ['request_key', "TEXT DEFAULT ''"],
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
      experiment_contracts: [
        ['authorization_source', "TEXT DEFAULT ''"],
        ['non_glm_cost_limit_cny', 'REAL DEFAULT 0'],
        ['per_call_max_tokens', 'INTEGER DEFAULT 0'],
      ],
      model_reservations: [
        ['experiment_id', "TEXT DEFAULT ''"],
        ['experiment_scope', "TEXT DEFAULT 'global'"],
        ['exempt_global', 'INTEGER DEFAULT 0'],
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
      experiment_contracts: [
        ['authorization_source', "TEXT DEFAULT ''"],
        ['non_glm_cost_limit_cny', 'REAL DEFAULT 0'],
        ['per_call_max_tokens', 'INTEGER DEFAULT 0'],
      ],
      model_reservations: [
        ['experiment_id', "TEXT DEFAULT ''"],
        ['experiment_scope', "TEXT DEFAULT 'global'"],
        ['exempt_global', 'INTEGER DEFAULT 0'],
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
    try {
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_request_key_unique ON runs(request_key) WHERE request_key<>''");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS conversations_request_key_unique ON conversations(request_key) WHERE request_key<>''");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_request_key_unique ON conversation_messages(conversation_id, request_key) WHERE request_key<>''");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS actions_request_key_unique ON actions(request_key) WHERE request_key<>''");
    } catch {
      /* 旧库可能已有重复非空 key；保留现状并让业务回查兜底 */
    }
    // 旧记录回填 provider（用于按模型族分开统计；不改动金额/用量）
    try {
      this.db.exec("UPDATE attempts SET provider='glm' WHERE (provider IS NULL OR provider='') AND agent_kind='claude'");
      this.db.exec("UPDATE attempts SET provider='deepseek' WHERE (provider IS NULL OR provider='') AND agent_kind IN ('dsh','planning','deepseek')");
      this.db.exec("UPDATE attempts SET provider='unknown' WHERE provider IS NULL OR provider=''");
      // 历史记录：旧版按 agentKind 推断 provider，只是推断，不能升级为已核实身份。
      this.db.exec("UPDATE attempts SET provider_source='legacy_inferred' WHERE provider IN ('glm','deepseek') AND provider_known=0 AND provider_source=''");
      this.db.exec("UPDATE attempts SET provider_known=0, provider_source='legacy_inferred' WHERE provider IN ('glm','deepseek') AND provider_known=1 AND provider_source='legacy_inferred'");
      this.db.exec("UPDATE attempts SET provider='unknown', provider_known=0, provider_source='legacy_unknown' WHERE provider NOT IN ('glm','deepseek','openai','anthropic') AND provider_source=''");
      this.db.exec("UPDATE audits SET provider_source='legacy_inferred' WHERE provider IN ('glm','deepseek','openai','anthropic') AND provider_known=0 AND provider_source=''");
      this.db.exec("UPDATE audits SET provider_known=0, provider_source='legacy_inferred' WHERE provider IN ('glm','deepseek','openai','anthropic') AND provider_known=1 AND provider_source='legacy_inferred'");
      // 已回填到统一账本的历史推断行同步降级，禁止历史推断被预算当作已确认 GLM。
      this.db.exec("UPDATE llm_usage SET provider_known=0 WHERE source_id IN (SELECT 'attempt:'||id FROM attempts WHERE provider_source='legacy_inferred')");
      this.db.exec("UPDATE llm_usage SET provider_known=0 WHERE source_id IN (SELECT 'audit:'||id FROM audits WHERE provider_source='legacy_inferred')");
    } catch {
      /* ignore */
    }
    // 统一用量账本：旧 attempts/audits 一次性回填；后续通过触发器自动入账，避免双计或漏计。
    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_attempt_usage AFTER INSERT ON attempts
        BEGIN
          INSERT OR IGNORE INTO llm_usage (id,source_id,source,run_id,task_id,project_id,conversation_id,provider,provider_known,provider_source,model,tokens_in,tokens_out,tokens_cache,cost_cny,cost_source,usage_known,budget_scope,created_at)
          VALUES ('usage_att_'||NEW.id, 'attempt:'||NEW.id, 'attempt', NEW.run_id, NEW.task_id,
            COALESCE((SELECT project_id FROM runs WHERE id=NEW.run_id),''), '', COALESCE(NULLIF(NEW.provider,''),'unknown'),
            COALESCE(NEW.provider_known,0), COALESCE(NEW.provider_source,''), COALESCE(NEW.model,''),
            COALESCE(NEW.tokens_in,0), COALESCE(NEW.tokens_out,0), COALESCE(NEW.tokens_cache,0),
            COALESCE(NEW.cost_cny,0), COALESCE(NEW.cost_source,'estimated'), 1, 'global', NEW.created_at);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_attempt_usage_update AFTER UPDATE OF tokens_in,tokens_out,tokens_cache,cost_cny,provider,provider_known,provider_source,model ON attempts
        BEGIN
          INSERT INTO llm_usage (id,source_id,source,run_id,task_id,project_id,conversation_id,provider,provider_known,provider_source,model,tokens_in,tokens_out,tokens_cache,cost_cny,cost_source,usage_known,budget_scope,created_at)
          VALUES ('usage_att_'||NEW.id, 'attempt:'||NEW.id, 'attempt', NEW.run_id, NEW.task_id,
            COALESCE((SELECT project_id FROM runs WHERE id=NEW.run_id),''), '', COALESCE(NULLIF(NEW.provider,''),'unknown'),
            COALESCE(NEW.provider_known,0), COALESCE(NEW.provider_source,''), COALESCE(NEW.model,''),
            COALESCE(NEW.tokens_in,0), COALESCE(NEW.tokens_out,0), COALESCE(NEW.tokens_cache,0),
            COALESCE(NEW.cost_cny,0), COALESCE(NEW.cost_source,'estimated'), 1, 'global', NEW.created_at)
          ON CONFLICT(source_id) DO UPDATE SET provider=excluded.provider,provider_known=excluded.provider_known,provider_source=excluded.provider_source,model=excluded.model,tokens_in=excluded.tokens_in,tokens_out=excluded.tokens_out,tokens_cache=excluded.tokens_cache,cost_cny=excluded.cost_cny,cost_source=excluded.cost_source;
        END;
        CREATE TABLE IF NOT EXISTS retry_grants (
          key TEXT PRIMARY KEY, created_at TEXT NOT NULL, consumed_at TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS chat_sends (
          key TEXT PRIMARY KEY, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_plan_receipts (
          request_key TEXT PRIMARY KEY, plan_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS trg_audit_usage AFTER INSERT ON audits
        BEGIN
          INSERT OR IGNORE INTO llm_usage (id,source_id,source,run_id,task_id,project_id,conversation_id,provider,provider_known,provider_source,model,tokens_in,tokens_out,tokens_cache,cost_cny,cost_source,usage_known,budget_scope,created_at)
          VALUES ('usage_aud_'||NEW.id, 'audit:'||NEW.id, 'audit', NEW.run_id, NEW.task_id,
            COALESCE((SELECT project_id FROM runs WHERE id=NEW.run_id),''), '', COALESCE(NULLIF(NEW.provider,''),'unknown'),
            COALESCE(NEW.provider_known,0), COALESCE(NEW.provider_source,''), COALESCE(NEW.model,''),
            COALESCE(NEW.tokens_in,0), COALESCE(NEW.tokens_out,0), 0, COALESCE(NEW.cost_cny,0),
            'estimated', 1, COALESCE(NEW.budget_scope,'global'), NEW.created_at);
        END;
      `);
      try { this.db.exec("ALTER TABLE attempts ADD COLUMN accounting_source TEXT DEFAULT ''"); } catch { /* column exists */ }
      try { this.db.exec("ALTER TABLE llm_usage ADD COLUMN superseded_by TEXT DEFAULT ''"); } catch { /* column exists */ }
      this.backfillLlmUsage();
      this.backfillChatSendState();
      this.correctLegacyMirrors();
      this.dedupeLegacyMirrors();
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

  // ---------------- chat conversations ----------------
  createConversation(c = {}) {
    const now = nowIso();
    const id = c.id || `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare('INSERT INTO conversations (id,title,project_id,run_id,loop_id,goal,acceptance_json,brief_json,status,request_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, String(c.title || '新对话'), c.projectId || '', c.runId || '', c.loopId || '', c.goal || '', JSON.stringify(c.acceptance || []), JSON.stringify(c.brief || {}), c.status || 'draft', c.requestKey || '', now, now);
    return this.getConversation(id);
  }
  getConversation(id) {
    return parseRow(this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id), { acceptance_json: [], brief_json: {} });
  }
  getConversationByRequestKey(requestKey) {
    if (!requestKey) return null;
    return parseRow(this.db.prepare('SELECT * FROM conversations WHERE request_key=?').get(requestKey), { acceptance_json: [], brief_json: {} });
  }
  listConversations(limit = 40) {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit)
      .map((r) => parseRow(r, { acceptance_json: [], brief_json: {} }));
  }
  updateConversation(id, patch = {}) {
    const cur = this.getConversation(id); if (!cur) return null;
    const m = { ...cur, ...patch };
    this.db.prepare('UPDATE conversations SET title=?,project_id=?,run_id=?,loop_id=?,goal=?,acceptance_json=?,brief_json=?,status=?,updated_at=? WHERE id=?')
      .run(m.title || '', m.project_id || '', m.run_id || '', m.loop_id || '', m.goal || '', JSON.stringify(m.acceptance_json || []), JSON.stringify(m.brief_json || {}), m.status || 'draft', nowIso(), id);
    return this.getConversation(id);
  }
  addConversationMessage(m = {}) {
    const id = m.id || `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare('INSERT INTO conversation_messages (id,conversation_id,role,content,request_key,reply_to,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, m.conversationId, m.role || 'user', String(m.content || ''), m.requestKey || '', m.replyTo || '', JSON.stringify(m.data || {}), nowIso());
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(nowIso(), m.conversationId);
    return this.listConversationMessages(m.conversationId).find((x) => x.id === id) || null;
  }
  getConversationMessageByRequestKey(conversationId, requestKey) {
    if (!requestKey) return null;
    const r = this.db.prepare('SELECT * FROM conversation_messages WHERE conversation_id=? AND request_key=?').get(conversationId, requestKey);
    if (!r) return null;
    const m = parseRow(r, { data_json: {} }); m.data = m.data_json || {}; return m;
  }
  getConversationReplyTo(conversationId, userMessageId) {
    const r = this.db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? AND reply_to=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(conversationId, userMessageId);
    if (!r) return null;
    const m = parseRow(r, { data_json: {} }); m.data = m.data_json || {}; return m;
  }
  deleteConversationMessage(id) {
    return this.db.prepare('DELETE FROM conversation_messages WHERE id=?').run(id).changes;
  }
  listConversationMessages(conversationId) {
    return this.db.prepare('SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC').all(conversationId)
      .map((r) => { const m = parseRow(r, { data_json: {} }); m.data = m.data_json || {}; return m; });
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
        `INSERT INTO runs (id,project_id,plan_id,goal,mode,status,current_task_id,budget_json,spent_json,stop_reason,result_json,verification_status,verified_sha,ci_status,ci_url,ci_checked_at,wall_deadline,parent_run_id,request_key,pause_kind,started_at,ended_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        JSON.stringify(r.result || {}),
        r.verificationStatus || 'LOCAL_VERIFIED',
        '',
        '',
        '',
        '',
        r.wallDeadline || '',
        r.parentRunId || '',
        r.requestKey || '',
        r.pauseKind || '',
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

  getRunByRequestKey(requestKey) {
    const key = String(requestKey || '').trim();
    if (!key) return null;
    return parseRow(this.db.prepare('SELECT * FROM runs WHERE request_key = ? ORDER BY created_at DESC LIMIT 1').get(key), {
      budget_json: {}, spent_json: {}, result_json: {},
    }) || null;
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
        `UPDATE runs SET plan_id=?, status=?, current_task_id=?, budget_json=?, spent_json=?, stop_reason=?, result_json=?, verification_status=?, verified_sha=?, ci_status=?, ci_url=?, ci_checked_at=?, wall_deadline=?, parent_run_id=?, pause_kind=?, started_at=?, ended_at=?, updated_at=? WHERE id=?`,
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
        merged.pause_kind || '',
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
    return this.db.prepare(sql).all(...params).map((r) => parseRow(r, { acceptance_json: [], result_json: {}, verification_json: {} }));
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
  deleteLlmUsageBySource(sourceId) {
    if (!sourceId) return 0;
    const r = this.db.prepare('DELETE FROM llm_usage WHERE source_id=?').run(String(sourceId));
    return Number(r.changes || 0);
  }

  createAttempt(a) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO attempts (id,run_id,task_id,attempt_no,stage,agent_kind,session_id,prompt,exit_code,status,error,feedback,tokens_in,tokens_out,tokens_cache,cost_cny,cost_reported,cost_source,provider,model,provider_known,provider_source,duration_ms,log_path,accounting_source,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        a.accountingSource || '',
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

  markRunningAttemptsInterrupted(runIds = null) {
    const now = nowIso();
    const ids = Array.isArray(runIds) ? runIds.filter(Boolean) : null;
    if (ids && !ids.length) return 0;
    const sql = `UPDATE attempts SET status='interrupted', cost_source=CASE WHEN cost_cny=0 AND tokens_in=0 AND tokens_out=0 AND tokens_cache=0 THEN 'unknown' ELSE cost_source END, error=CASE WHEN error='' THEN '工作台进程中断：厂商最终用量未返回，费用/Tokens 标记为未知（不伪造为 0）' ELSE error END, updated_at=? WHERE status='running'${ids ? ` AND run_id IN (${ids.map(() => '?').join(',')})` : ''}`;
    return this.db.prepare(sql).run(now, ...(ids || [])).changes;
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
      .prepare('INSERT INTO actions (id,run_id,conversation_id,request_key,task_id,type,status,payload_json,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.runId || '', a.conversationId || '', a.requestKey || '', a.taskId || '', a.type, a.status || 'pending', JSON.stringify(a.payload || {}), JSON.stringify(a.result || {}), now, now);
    return this.getAction(a.id);
  }
  getActionByRequestKey(requestKey) {
    if (!requestKey) return null;
    return parseRow(this.db.prepare('SELECT * FROM actions WHERE request_key=?').get(requestKey), { payload_json: {}, result_json: {} });
  }
  listConversationActions(conversationId, limit = 100) {
    return this.db.prepare('SELECT * FROM actions WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?').all(conversationId, limit)
      .map((r) => parseRow(r, { payload_json: {}, result_json: {} }));
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

  listOpenPublishActions() {
    return this.db.prepare("SELECT * FROM actions WHERE type IN ('github-pr','github-push') AND status IN ('running','pending') ORDER BY created_at ASC").all().map((r) => parseRow(r, { payload_json: {}, result_json: {} }));
  }

  listActions(runId) {
    return this.db
      .prepare('SELECT * FROM actions WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId)
      .map((r) => parseRow(r, { payload_json: {}, result_json: {} }));
  }

  // ---------------- atomic model budget reservations ----------------
  // ---------------- E2E 实验预算契约 ----------------
  createExperimentContract(input = {}) {
    const now = nowIso();
    const required = ['authorizedBy','authorizationText','authorizationSource','tokenLimit','costLimitCny','stopLossCny','callLimit','deadlineAt'];
    for (const k of required) if (!input[k]) throw new Error(`EXPERIMENT_FIELD_REQUIRED:${k}`);
    if (!['user_cli_tty','user_chat_approval'].includes(String(input.authorizationSource))) throw new Error('EXPERIMENT_AUTHORIZATION_SOURCE_INVALID: 只能由用户 TTY 或本次对话明确批准创建');
    for (const k of ['tokenLimit','costLimitCny','stopLossCny','callLimit']) {
      if (!Number.isFinite(Number(input[k])) || Number(input[k]) <= 0) throw new Error(`EXPERIMENT_LIMIT_INVALID:${k}`);
    }
    for (const k of ['glmTokenLimit','glmCostLimitCny','dshTokenLimit','dshCostLimitCny','nonGlmCostLimitCny','perCallMaxTokens']) {
      if (!Number.isFinite(Number(input[k] ?? 0)) || Number(input[k] ?? 0) < 0) throw new Error(`EXPERIMENT_LIMIT_INVALID:${k}`);
    }
    if (!Number.isFinite(Date.parse(String(input.deadlineAt)))) throw new Error('EXPERIMENT_DEADLINE_INVALID');
    for (const role of ['chat', 'planner', 'coding', 'audit']) {
      const b = input.provider?.[role];
      if (!b?.client || !b?.provider || !b?.model) throw new Error(`EXPERIMENT_PROVIDER_REQUIRED:${role}`);
    }
    const id = input.id || `exp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const version = String(input.contractVersion || 'e2e-budget-v1');
    const payload = {
      version, projectId: input.projectId || '', conversationId: input.conversationId || '',
      authorizedBy: String(input.authorizedBy), authorizedAt: input.authorizedAt || now,
      authorizationSource: String(input.authorizationSource),
      tokenLimit: Number(input.tokenLimit), costLimitCny: Number(input.costLimitCny),
      stopLossCny: Number(input.stopLossCny || 0), callLimit: Number(input.callLimit),
      deadlineAt: String(input.deadlineAt),
      glmTokenLimit: Number(input.glmTokenLimit || 0), glmCostLimitCny: Number(input.glmCostLimitCny || 0),
      dshTokenLimit: Number(input.dshTokenLimit || 0), dshCostLimitCny: Number(input.dshCostLimitCny || 0),
      nonGlmCostLimitCny: Number(input.nonGlmCostLimitCny || 0), perCallMaxTokens: Number(input.perCallMaxTokens || 0),
      provider: input.provider || {}, isolationMode: String(input.isolationMode || 'BLOCKED_UNLESS_APPROVED'),
      stopConditions: Array.isArray(input.stopConditions) ? input.stopConditions : [],
    };
    const contractHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const authorizationTextHash = crypto.createHash('sha256').update(String(input.authorizationText)).digest('hex');
    this.db.prepare('INSERT INTO experiment_contracts (id,project_id,conversation_id,authorized_by,authorized_at,authorization_source,authorization_text_hash,contract_version,contract_hash,status,token_limit,cost_limit_cny,stop_loss_cny,call_limit,deadline_at,glm_token_limit,glm_cost_limit_cny,dsh_token_limit,dsh_cost_limit_cny,non_glm_cost_limit_cny,per_call_max_tokens,provider_json,isolation_mode,stop_conditions_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, payload.projectId, payload.conversationId, payload.authorizedBy, payload.authorizedAt, payload.authorizationSource, authorizationTextHash, version, contractHash, 'authorized',
        payload.tokenLimit, payload.costLimitCny, payload.stopLossCny, payload.callLimit, payload.deadlineAt,
        payload.glmTokenLimit, payload.glmCostLimitCny, payload.dshTokenLimit, payload.dshCostLimitCny,
        payload.nonGlmCostLimitCny, payload.perCallMaxTokens, JSON.stringify(payload.provider), payload.isolationMode, JSON.stringify(payload.stopConditions), now, now);
    return this.getExperimentContract(id);
  }

  getExperimentContract(id) {
    return parseRow(this.db.prepare('SELECT * FROM experiment_contracts WHERE id=?').get(id), { provider_json: {}, stop_conditions_json: [] });
  }

  verifyExperimentContractHash(id) {
    const row = this.db.prepare('SELECT * FROM experiment_contracts WHERE id=?').get(id);
    if (!row) return false;
    return row.contract_hash === experimentContractHashFor(row);
  }

  refreshExperimentContractHash(id) {
    const row = this.db.prepare('SELECT * FROM experiment_contracts WHERE id=?').get(id);
    if (!row) return null;
    const hash = experimentContractHashFor(row);
    this.db.prepare('UPDATE experiment_contracts SET contract_hash=?, updated_at=? WHERE id=?').run(hash, nowIso(), id);
    return this.getExperimentContract(id);
  }

  getExperimentForProject(projectId) {
    if (!projectId) return null;
    return parseRow(this.db.prepare("SELECT * FROM experiment_contracts WHERE project_id=? AND status IN ('authorized','running','stop_loss_reached','overspent','completed','cancelled','failed','ended') ORDER BY created_at DESC LIMIT 1").get(projectId), { provider_json: {}, stop_conditions_json: [] });
  }

  getExperimentForConversation(conversationId) {
    if (!conversationId) return null;
    return parseRow(this.db.prepare("SELECT * FROM experiment_contracts WHERE conversation_id=? AND status IN ('authorized','running','stop_loss_reached','overspent','completed','cancelled','failed','ended') ORDER BY created_at DESC LIMIT 1").get(conversationId), { provider_json: {}, stop_conditions_json: [] });
  }

  listExperimentContracts(limit = 50) {
    return this.db.prepare('SELECT * FROM experiment_contracts ORDER BY created_at DESC LIMIT ?').all(limit)
      .map((r) => parseRow(r, { provider_json: {}, stop_conditions_json: [] }));
  }

  linkExperimentProject(experimentId, projectId, { conversationId = '' } = {}) {
    if (!experimentId || !projectId) throw new Error('EXPERIMENT_BINDING_REQUIRED');
    const exp = this.getExperimentContract(experimentId);
    if (!exp) throw new Error('EXPERIMENT_NOT_FOUND');
    if (!['authorized', 'running'].includes(exp.status)) throw new Error('EXPERIMENT_NOT_ACTIVE');
    if (!exp.contract_hash || exp.contract_hash.length !== 64 || !this.verifyExperimentContractHash(exp.id)) throw new Error('EXPERIMENT_CONTRACT_HASH_INVALID');
    if (exp.conversation_id && conversationId && exp.conversation_id !== conversationId) throw new Error('EXPERIMENT_CONVERSATION_MISMATCH');
    if (exp.project_id && exp.project_id !== projectId) throw new Error('EXPERIMENT_PROJECT_MISMATCH');
    const other = this.db.prepare("SELECT id FROM experiment_contracts WHERE project_id=? AND id<>? AND status IN ('authorized','running')").get(projectId, experimentId);
    if (other) throw new Error('EXPERIMENT_PROJECT_BOUND_ELSEWHERE');
    this.db.prepare('UPDATE experiment_contracts SET project_id=?, conversation_id=COALESCE(NULLIF(conversation_id,\'\'), ?), updated_at=? WHERE id=?').run(projectId, conversationId, nowIso(), experimentId);
    // 绑定 Project/Conversation 后重新计算 hash；绑定字段变化必须反映到冻结契约，不能保留旧 hash。
    return this.refreshExperimentContractHash(experimentId);
  }

  updateExperimentStatus(id, status, patch = {}) {
    this.db.prepare('UPDATE experiment_contracts SET status=?, ended_at=?, updated_at=? WHERE id=?').run(status, patch.endedAt || (['ended','completed','cancelled','failed'].includes(status) ? nowIso() : ''), nowIso(), id);
    return this.getExperimentContract(id);
  }

  endExperiment(id, status = 'completed', reason = '') {
    const exp = this.getExperimentContract(id);
    if (!exp) return null;
    // overspent/stop_loss 是审计事实，不能被成功收尾覆盖为 completed。
    if (status === 'completed' && ['overspent', 'stop_loss_reached'].includes(exp.status)) return exp;
    return this.updateExperimentStatus(id, status, { endedAt: nowIso(), reason });
  }

  experimentUsage(experimentId) {
    if (!experimentId) return { calls: 0, tokens: 0, costCny: 0, byScope: {}, rows: [] };
    const rows = this.db.prepare("SELECT experiment_scope scope, status, COUNT(*) calls, COALESCE(SUM(CASE WHEN status='settled' THEN actual_tokens ELSE estimated_tokens END),0) tokens, COALESCE(SUM(CASE WHEN status='settled' THEN actual_cost_cny ELSE estimated_cost_cny END),0) cost FROM model_reservations WHERE experiment_id=? AND status IN ('reserved','settled','unknown') GROUP BY experiment_scope,status").all(experimentId);
    const byScope = {};
    let calls = 0; let tokens = 0; let costCny = 0;
    for (const r of rows) {
      calls += Number(r.calls || 0); tokens += Number(r.tokens || 0); costCny += Number(r.cost || 0);
      const s = r.scope || 'global';
      if (!byScope[s]) byScope[s] = { calls: 0, tokens: 0, costCny: 0 };
      byScope[s].calls += Number(r.calls || 0); byScope[s].tokens += Number(r.tokens || 0); byScope[s].costCny += Number(r.cost || 0);
    }
    return { calls, tokens, costCny, byScope, rows };
  }

  reserveModelBudget({ id, requestKey = '', provider = 'unknown', model = '', estimatedTokens = 0, estimatedCostCny = 0, maxTokens = 0, maxCostCny = 0, minReserveTokens = 0, cacheTokenWeight = 0.1, exemptProviders = ['glm'], ttlMs = 10 * 60 * 1000, experimentId = '', experimentScope = 'global', exemptGlobal = false, retryAuthorized = false } = {}) {
    const now = nowIso();
    const expires = new Date(Date.now() + ttlMs).toISOString();
    // TTL 结算在事务外先提交；即使随后额度检查失败回滚，不能把已过期预留重新变回 reserved。
    this.db.prepare("UPDATE model_reservations SET status='unknown', usage_known=0 WHERE status='reserved' AND expires_at<=?").run(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let retryExisting = null;
      let effectiveRequestKey = requestKey;
      if (requestKey) {
        const existing = this.db.prepare('SELECT * FROM model_reservations WHERE request_key=?').get(requestKey);
        if (existing) {
          if (existing.status === 'reserved' || existing.status === 'settled') { this.db.exec('COMMIT'); return { ok: true, existing: true, reservation: existing }; }
          // UNKNOWN 历史调用保持占额；没有显式新授权不得自动生成第二笔预留。
          if (existing.status === 'unknown' && !retryAuthorized) {
            this.db.exec('COMMIT');
            return { ok: false, reason: 'unknown-retry-not-authorized', existing, requestKey };
          }
          // released/expired/unknown 是历史调用，不得覆盖；新付费重试必须独立预留 ID/requestKey。
          retryExisting = existing;
          effectiveRequestKey = `${requestKey}#retry:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
        }
      }
      const exempt = new Set((exemptProviders || []).map((x) => String(x).toLowerCase()));
      let experiment = null;
      let experimentUsage = { calls: 0, tokens: 0, costCny: 0, byScope: {} };
      if (experimentId) {
        experiment = this.getExperimentContract(experimentId);
        if (!experiment || !this.verifyExperimentContractHash(experimentId) || !['authorized', 'running'].includes(experiment.status)) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'experiment-not-authorized', experimentId };
        }
        if (experiment.deadline_at && Date.now() > Date.parse(experiment.deadline_at)) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'experiment-time-exceeded', experimentId, deadlineAt: experiment.deadline_at };
        }
        experimentUsage = this.experimentUsage(experimentId);
        const projectedCalls = Number(experimentUsage.calls || 0) + 1;
        if (Number(experiment.call_limit || 0) > 0 && projectedCalls > Number(experiment.call_limit)) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'experiment-call-limit', experimentId, calls: experimentUsage.calls, callLimit: experiment.call_limit };
        }
        const perCallMax = Number(experiment.per_call_max_tokens || 0);
        if (perCallMax > 0 && Number(estimatedTokens || 0) > perCallMax) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'experiment-per-call-token-limit', experimentId, estimatedTokens, perCallMax };
        }
        const projectedTokens = Number(experimentUsage.tokens || 0) + Number(estimatedTokens || 0);
        const projectedCost = Number(experimentUsage.costCny || 0) + Number(estimatedCostCny || 0);
        const hardTokens = Number(experiment.token_limit || 0);
        const hardCost = Number(experiment.cost_limit_cny || 0);
        const stopLoss = Number(experiment.stop_loss_cny || 0);
        if (hardTokens > 0 && projectedTokens > hardTokens) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-token-limit', experimentId, projectedTokens, hardTokens }; }
        if (hardCost > 0 && projectedCost > hardCost) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-cost-hard-limit', experimentId, projectedCost, hardCost }; }
        if (stopLoss > 0 && projectedCost >= stopLoss) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-stop-loss', experimentId, projectedCost, stopLoss }; }
        if (experimentScope === 'global') {
          const ng = Number(experiment.non_glm_cost_limit_cny || 0);
          const s = experimentUsage.byScope?.global || { costCny: 0 };
          if (ng > 0 && Number(s.costCny || 0) + Number(estimatedCostCny || 0) > ng) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-non-glm-cost-limit', experimentId, projectedNonGlmCost: Number(s.costCny || 0) + Number(estimatedCostCny || 0), limit: ng }; }
        } else if (experimentScope === 'glm') {
          const gt = Number(experiment.glm_token_limit || 0); const gc = Number(experiment.glm_cost_limit_cny || 0);
          const s = experimentUsage.byScope?.glm || { tokens: 0, costCny: 0 };
          if (gt > 0 && Number(s.tokens || 0) + Number(estimatedTokens || 0) > gt) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-glm-token-limit', experimentId }; }
          if (gc > 0 && Number(s.costCny || 0) + Number(estimatedCostCny || 0) > gc) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-glm-cost-limit', experimentId }; }
        } else if (experimentScope === 'dsh') {
          const dt = Number(experiment.dsh_token_limit || 0); const dc = Number(experiment.dsh_cost_limit_cny || 0);
          const s = experimentUsage.byScope?.dsh || { tokens: 0, costCny: 0 };
          if (dt > 0 && Number(s.tokens || 0) + Number(estimatedTokens || 0) > dt) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-dsh-token-limit', experimentId }; }
          if (dc > 0 && Number(s.costCny || 0) + Number(estimatedCostCny || 0) > dc) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'experiment-dsh-cost-limit', experimentId }; }
        }
      }
      const skipGlobal = !!experiment && (exemptGlobal || experimentScope === 'dsh');
      let usedTokens = 0; let usedCost = 0; let reservedTokens = 0; let reservedCost = 0;
      if (!skipGlobal) {
        const rows = this.db.prepare("SELECT provider, provider_known, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(tokens_cache) tc, SUM(cost_cny) cost FROM llm_usage WHERE COALESCE(superseded_by,'')='' AND budget_scope<>'project_audit' GROUP BY provider, provider_known").all();
        for (const r of rows) {
          const name = String(r.provider || 'unknown').toLowerCase();
          // 只豁免同一行 provider_known=1 的合法 GLM；unknown 行必须计入。
          if (exempt.has(name) && Number(r.provider_known) === 1) continue;
          usedTokens += Number(r.tin || 0) + Number(r.tout || 0) + Number(r.tc || 0) * Number(cacheTokenWeight || 0);
          usedCost += Number(r.cost || 0);
        }
        const reserved = this.db.prepare("SELECT COALESCE(SUM(estimated_tokens),0) t, COALESCE(SUM(estimated_cost_cny),0) c FROM model_reservations WHERE status IN ('reserved','unknown') AND (experiment_id='' OR (exempt_global=0 AND experiment_scope<>'dsh'))").get();
        reservedTokens = Number(reserved.t || 0); reservedCost = Number(reserved.c || 0);
        const totalTokens = usedTokens + reservedTokens + Number(estimatedTokens || 0);
        const totalCost = usedCost + reservedCost + Number(estimatedCostCny || 0);
        const remainingTokens = Number(maxTokens) - usedTokens - reservedTokens;
        const okTokens = maxTokens <= 0 || (remainingTokens >= Number(estimatedTokens || 0) && remainingTokens > Number(minReserveTokens || 0));
        const okCost = maxCostCny <= 0 || totalCost <= Number(maxCostCny);
        if (!okTokens || !okCost) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: 'budget-exceeded', usedTokens, usedCost, reservedTokens, reservedCostCny: reservedCost, estimatedTokens, estimatedCostCny, experimentId };
        }
      }
      // retryExisting 仅用于排除旧行重复计入；新调用使用新 id/new requestKey，旧 UNKNOWN 保留。
      this.db.prepare('INSERT INTO model_reservations (id,request_key,provider,model,estimated_tokens,estimated_cost_cny,status,created_at,expires_at,experiment_id,experiment_scope,exempt_global) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, effectiveRequestKey, provider, model, Number(estimatedTokens || 0), Number(estimatedCostCny || 0), 'reserved', now, expires, experimentId || '', experimentScope || 'global', exemptGlobal ? 1 : 0);
      this.db.exec('COMMIT');
      if (experiment) this.updateExperimentStatus(experiment.id, 'running');
      return { ok: true, retryOf: retryExisting?.id || '', experimentId, experimentUsage: experiment ? this.experimentUsage(experiment.id) : null, reservation: this.db.prepare('SELECT * FROM model_reservations WHERE id=?').get(id) };
    } catch (err) { try { this.db.exec('ROLLBACK'); } catch {} throw err; }
  }

  settleModelReservation(id, { actualTokens = 0, actualCostCny = 0, usageKnown = true } = {}) {
    const now = nowIso();
    const status = usageKnown ? 'settled' : 'unknown';
    this.db.prepare("UPDATE model_reservations SET status=?, actual_tokens=?, actual_cost_cny=?, usage_known=?, settled_at=? WHERE id=? AND status IN ('reserved','unknown')")
      .run(status, Number(actualTokens || 0), Number(actualCostCny || 0), usageKnown ? 1 : 0, now, id);
    const row = this.db.prepare('SELECT * FROM model_reservations WHERE id=?').get(id) || null;
    if (row?.experiment_id) {
      const exp = this.getExperimentContract(row.experiment_id);
      if (exp && ['authorized', 'running'].includes(exp.status)) {
        const u = this.experimentUsage(exp.id);
        if ((Number(exp.cost_limit_cny || 0) > 0 && u.costCny > Number(exp.cost_limit_cny))
          || (Number(exp.token_limit || 0) > 0 && u.tokens > Number(exp.token_limit))) {
          this.updateExperimentStatus(exp.id, 'overspent');
        } else if (Number(exp.stop_loss_cny || 0) > 0 && u.costCny >= Number(exp.stop_loss_cny)) {
          this.updateExperimentStatus(exp.id, 'stop_loss_reached');
        }
      }
    }
    return row;
  }

  releaseModelReservation(id, { reason = 'released', usageKnown = false } = {}) {
    // 仅用于“调用确定没有发生”的显式释放；已发起但结果未知的调用必须 markModelReservationUnknown。
    this.db.prepare("UPDATE model_reservations SET status='released', usage_known=?, settled_at=? WHERE id=? AND status='reserved'").run(usageKnown ? 1 : 0, nowIso(), id);
    return this.db.prepare('SELECT * FROM model_reservations WHERE id=?').get(id) || null;
  }

  markModelReservationUnknown(id) {
    this.db.prepare("UPDATE model_reservations SET status='unknown', usage_known=0, settled_at=? WHERE id=? AND status IN ('reserved','unknown')").run(nowIso(), id);
    return this.db.prepare('SELECT * FROM model_reservations WHERE id=?').get(id) || null;
  }

  reservedBudgetTotals() {
    const row = this.db.prepare("SELECT COALESCE(SUM(estimated_tokens),0) t, COALESCE(SUM(estimated_cost_cny),0) c FROM model_reservations WHERE status IN ('reserved','unknown') AND (experiment_id='' OR (exempt_global=0 AND experiment_scope<>'dsh'))").get();
    return { tokens: Number(row.t || 0), costCny: Number(row.c || 0) };
  }

  listModelReservations(limit = 100) {
    return this.db.prepare('SELECT * FROM model_reservations ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ---------------- unified LLM usage ledger ----------------
  addLlmUsage(u = {}) {
    const now = nowIso();
    const id = u.id || `usage_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    try {
      this.db.prepare(`INSERT INTO llm_usage (id,source_id,source,run_id,task_id,project_id,conversation_id,provider,provider_known,provider_source,model,tokens_in,tokens_out,tokens_cache,cost_cny,cost_source,usage_known,budget_scope,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, u.sourceId || id, u.source || 'unknown', u.runId || '', u.taskId || '', u.projectId || '', u.conversationId || '',
        u.provider || 'unknown', u.providerKnown ? 1 : 0, u.providerSource || '', u.model || '',
        Number(u.tokensIn || 0), Number(u.tokensOut || 0), Number(u.tokensCache || 0), Number(u.costCny || 0),
        u.costSource || 'estimated', u.usageKnown === false ? 0 : 1, u.budgetScope || 'global', now,
      );
    } catch (err) {
      // 幂等重试：同一 sourceId 已入账时返回已有记录，不重复计费。
      const existing = u.sourceId ? this.db.prepare('SELECT * FROM llm_usage WHERE source_id=?').get(u.sourceId) : null;
      if (existing) return existing;
      throw err;
    }
    return this.db.prepare('SELECT * FROM llm_usage WHERE id=?').get(id);
  }
  consumeChatSend(key) {
    if (!key) return false;
    const r = this.db.prepare("INSERT OR IGNORE INTO chat_sends (key,created_at) VALUES (?,?)").run(String(key), nowIso());
    return Number(r.changes || 0) > 0;
  }

  consumeRetryGrant(key) {
    if (!key) return false;
    const now = nowIso();
    const r = this.db.prepare("INSERT OR IGNORE INTO retry_grants (key,created_at,consumed_at) VALUES (?,?,'')").run(String(key), now);
    if (Number(r.changes || 0) === 0) return false;
    this.db.prepare("UPDATE retry_grants SET consumed_at=? WHERE key=? AND consumed_at=''").run(now, String(key));
    return true;
  }

  beginRunPlanIntent(requestKey) {
    if (!requestKey) return;
    const now = nowIso();
    this.db.prepare("INSERT OR IGNORE INTO run_plan_receipts (request_key,plan_json,created_at,updated_at) VALUES (?,?,?,?)")
      .run(String(requestKey), JSON.stringify({ __pending: true }), now, now);
  }

  saveRunPlanReceipt(requestKey, payload) {
    if (!requestKey || !payload) return;
    const now = nowIso();
    this.db.prepare("INSERT INTO run_plan_receipts (request_key,plan_json,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(request_key) DO UPDATE SET plan_json=excluded.plan_json, updated_at=excluded.updated_at")
      .run(String(requestKey), JSON.stringify(payload), now, now);
  }

  getRunPlanReceipt(requestKey) {
    if (!requestKey) return null;
    const row = this.db.prepare('SELECT plan_json FROM run_plan_receipts WHERE request_key=?').get(String(requestKey));
    if (!row) return null;
    try { return JSON.parse(row.plan_json); } catch { return null; }
  }

  listLlmUsage({ projectId = '', conversationId = '', runId = '', limit = 500, includeSuperseded = false } = {}) {
    const where = []; const params = [];
    if (projectId) { where.push('project_id=?'); params.push(projectId); }
    if (conversationId) { where.push('conversation_id=?'); params.push(conversationId); }
    if (runId) { where.push('run_id=?'); params.push(runId); }
    if (!includeSuperseded) where.push("COALESCE(superseded_by,'')=''");
    params.push(limit);
    return this.db.prepare(`SELECT * FROM llm_usage ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...params);
  }
  backfillChatSendState() {
    // 旧版已发送/结果不明的 Chat 预留或失败用量，升级后必须视为首发许可已消费。
    try {
      const rows = this.db.prepare("SELECT request_key FROM model_reservations WHERE request_key LIKE 'chat:%' AND status IN ('unknown','settled')").all();
      const insert = this.db.prepare('INSERT OR IGNORE INTO chat_sends (key,created_at) VALUES (?,?)');
      for (const r of rows) {
        const rest = String(r.request_key || '').slice(5);
        if (!rest.includes(':')) continue;
        const [conversationId, messageId] = rest.split(':');
        if (conversationId && messageId) insert.run(`chat-send:${conversationId}:${messageId}:initial`, nowIso());
      }
      const failures = this.db.prepare("SELECT source_id FROM llm_usage WHERE source IN ('chat','chatfail') AND (source_id LIKE 'chatfail:%' OR source_id LIKE 'chat:%')").all();
      for (const r of failures) {
        const [, conversationId, messageId] = String(r.source_id || '').split(':');
        if (conversationId && messageId) insert.run(`chat-send:${conversationId}:${messageId}:initial`, nowIso());
      }
    } catch { /* legacy tables absent */ }
  }

  correctLegacyMirrors() {
    // 旧候选仅凭 token 相同误把独立 coding 历史标成 planner mirror；有 run/task/project 的独立事实必须恢复。
    this.db.prepare(`UPDATE llm_usage SET superseded_by=''
      WHERE superseded_by='planner-mirror'
        AND (COALESCE(run_id,'')<>'' OR COALESCE(task_id,'')<>'' OR COALESCE(project_id,'')<>'' OR source<>'legacy_attempt')`).run();
  }

  dedupeLegacyMirrors() {
    // 历史镜像只在有效口径忽略，不删除原始行；仅当同源 planner 事实可证明时标记。
    this.db.prepare(`UPDATE llm_usage AS l SET superseded_by='planner-mirror'
      WHERE l.source='legacy_attempt' AND COALESCE(l.superseded_by,'')=''
        AND COALESCE(l.run_id,'')='' AND COALESCE(l.task_id,'' )=''
        AND EXISTS (SELECT 1 FROM llm_usage p
          WHERE p.source='planner' AND p.id<>l.id
            AND COALESCE(p.tokens_in,0)=COALESCE(l.tokens_in,0)
            AND COALESCE(p.tokens_out,0)=COALESCE(l.tokens_out,0)
            AND COALESCE(p.tokens_cache,0)=COALESCE(l.tokens_cache,0))`).run();
  }

  backfillLlmUsage() {
    // 一次性回填旧 attempts/audits 用量，确保预算不因新账本上线而“重置”。
    const now = nowIso();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO llm_usage (id,source_id,source,run_id,task_id,project_id,conversation_id,provider,provider_known,provider_source,model,tokens_in,tokens_out,tokens_cache,cost_cny,cost_source,usage_known,budget_scope,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const attempts = this.db.prepare(`SELECT a.id,a.run_id,a.task_id,r.project_id,a.provider,a.provider_known,a.provider_source,a.model,a.tokens_in,a.tokens_out,a.tokens_cache,a.cost_cny,a.stage,a.created_at,a.accounting_source FROM attempts a LEFT JOIN runs r ON r.id=a.run_id`).all();
    for (const a of attempts) {
      // 已由正式结算身份记账的 attempt 不再做 legacy 回填，避免重开数据库双账；
      // planner 的历史账由 llm_usage 的 planner 身份承载，不把 loop-planning attempt 再补成 legacy。
      if (String(a.accounting_source || '') || a.stage === 'loop-planning') continue;
      insert.run(`usage_legacy_att_${a.id}`, `attempt:${a.id}`, 'legacy_attempt', a.run_id || '', a.task_id || '', a.project_id || '', '', a.provider || 'unknown', a.provider_known ? 1 : 0, a.provider_source || 'legacy', a.model || '', Number(a.tokens_in || 0), Number(a.tokens_out || 0), Number(a.tokens_cache || 0), Number(a.cost_cny || 0), 'legacy', 1, 'global', a.created_at || now);
    }
    const audits = this.db.prepare(`SELECT au.id,au.run_id,au.task_id,r.project_id,au.provider,au.provider_known,au.provider_source,au.model,au.tokens_in,au.tokens_out,au.cost_cny,au.budget_scope,au.created_at FROM audits au LEFT JOIN runs r ON r.id=au.run_id`).all();
    for (const a of audits) insert.run(`usage_legacy_aud_${a.id}`, `audit:${a.id}`, 'legacy_audit', a.run_id || '', a.task_id || '', a.project_id || '', '', a.provider || 'unknown', a.provider_known ? 1 : 0, a.provider_source || 'legacy', a.model || '', Number(a.tokens_in || 0), Number(a.tokens_out || 0), 0, Number(a.cost_cny || 0), 'legacy', 1, a.budget_scope || 'global', a.created_at || now);
    return this.db.prepare('SELECT COUNT(*) n FROM llm_usage').get().n;
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
    // 单一事实源：llm_usage；旧 attempts/audits 已在迁移时回填，后续由触发器入账。
    const rows = this.db.prepare(`SELECT provider, provider_known known, COALESCE(SUM(CASE WHEN budget_scope<>'project_audit' THEN tokens_in ELSE 0 END),0) tin, COALESCE(SUM(CASE WHEN budget_scope<>'project_audit' THEN tokens_out ELSE 0 END),0) tout, COALESCE(SUM(CASE WHEN budget_scope<>'project_audit' THEN tokens_cache ELSE 0 END),0) tc, COALESCE(SUM(CASE WHEN budget_scope<>'project_audit' THEN cost_cny ELSE 0 END),0) cost FROM llm_usage WHERE COALESCE(superseded_by,'')='' GROUP BY provider, provider_known`).all();
    const scoped = this.db.prepare(`SELECT provider, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(tokens_cache),0) tc, COALESCE(SUM(cost_cny),0) cost FROM llm_usage WHERE COALESCE(superseded_by,'')='' AND budget_scope='project_audit' GROUP BY provider`).all();
    const byProvider = {};
    const ensure = (name) => {
      const key = name || 'unknown';
      if (!byProvider[key]) byProvider[key] = { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0, known: false };
      return byProvider[key];
    };
    for (const r of rows) {
      const base = String(r.provider || 'unknown');
      // unknown 用量使用独立 key，确保 GLM 的 known/unknown 不会被聚合后整体豁免。
      const key = Number(r.known) === 1 ? base : `${base}@unknown`;
      const agg = ensure(key);
      agg.tokensIn += Number(r.tin); agg.tokensOut += Number(r.tout); agg.tokensCache += Number(r.tc); agg.costCny += Number(r.cost);
      agg.known = Number(r.known) === 1;
      agg.baseProvider = base;
    }
    for (const agg of Object.values(byProvider)) agg.tokens = agg.tokensIn + agg.tokensOut + agg.tokensCache;
    const total = Object.values(byProvider).reduce((acc, a) => {
      acc.tokensIn += a.tokensIn; acc.tokensOut += a.tokensOut; acc.tokensCache += a.tokensCache; acc.tokens += a.tokens; acc.costCny += a.costCny;
      return acc;
    }, { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0 });
    const projectAudit = scoped.reduce((acc, r) => { acc.tokensIn += Number(r.tin); acc.tokensOut += Number(r.tout); acc.tokensCache += Number(r.tc); acc.tokens += Number(r.tin) + Number(r.tout) + Number(r.tc); acc.costCny += Number(r.cost); return acc; }, { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0 });
    return { ...total, byProvider, projectAudit };
  }

  auditBudgetUsage(projectId) {
    const rows = this.db.prepare("SELECT COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(cost_cny),0) cost, COUNT(*) calls FROM audits a JOIN runs r ON r.id=a.run_id WHERE r.project_id=? AND a.budget_scope='project_audit'").all(projectId);
    const r = rows[0] || {};
    return { tokens: Number(r.tin || 0) + Number(r.tout || 0), costCny: Number(r.cost || 0), calls: Number(r.calls || 0) };
  }

  usageForProject(projectId) {
    const rows = this.db.prepare(`SELECT provider, provider_known known, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(tokens_cache),0) tc, COALESCE(SUM(cost_cny),0) cost FROM llm_usage WHERE project_id=? GROUP BY provider, provider_known`).all(projectId);
    const byProvider = {};
    const ensure = (name) => { const k = name || 'unknown'; if (!byProvider[k]) byProvider[k] = { tokensIn:0,tokensOut:0,tokensCache:0,tokens:0,costCny:0,known:false }; return byProvider[k]; };
    for (const r of rows) { const base=String(r.provider||'unknown'); const key=Number(r.known)===1?base:`${base}@unknown`; const a=ensure(key); a.tokensIn+=Number(r.tin); a.tokensOut+=Number(r.tout); a.tokensCache+=Number(r.tc); a.costCny+=Number(r.cost); a.known=Number(r.known)===1; a.baseProvider=base; }
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

  listLoopsWithPending() {
    return this.db.prepare("SELECT * FROM loops WHERE pending_task_json IS NOT NULL AND pending_task_json<>'' AND pending_task_json<>'{}' ORDER BY created_at ASC LIMIT 100").all()
      .map((r) => parseRow(r, { queue_json: [], history_json: [], contract_files_json: [] }));
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
    this.db.prepare('UPDATE loops SET status=?,round=?,max_rounds=?,queue_json=?,history_json=?,contract_files_json=?,current_run_id=?,last_run_id=?,stop_reason=?,product_repair_count=?,auto_repair_count=?,auto_retry_count=?,updated_at=? WHERE id=?')
      .run(m.status, m.round, m.max_rounds, JSON.stringify(m.queue_json || []), JSON.stringify(m.history_json || []), JSON.stringify(m.contract_files_json || []), m.current_run_id || '', m.last_run_id || '', m.stop_reason || '', Number(m.product_repair_count || 0), Number(m.auto_repair_count || 0), Number(m.auto_retry_count || 0), nowIso(), id);
    return this.getLoop(id);
  }

  incrementLoopProductRepair(loopId) {
    this.db.prepare('UPDATE loops SET product_repair_count=product_repair_count+1, updated_at=? WHERE id=?').run(nowIso(), loopId);
    return Number(this.db.prepare('SELECT product_repair_count FROM loops WHERE id=?').get(loopId)?.product_repair_count || 0);
  }

  incrementLoopAutoRepair(loopId) {
    this.db.prepare('UPDATE loops SET auto_repair_count=auto_repair_count+1, updated_at=? WHERE id=?').run(nowIso(), loopId);
    return Number(this.db.prepare('SELECT auto_repair_count FROM loops WHERE id=?').get(loopId)?.auto_repair_count || 0);
  }

  incrementLoopAutoRetry(loopId) {
    this.db.prepare('UPDATE loops SET auto_retry_count=auto_retry_count+1, updated_at=? WHERE id=?').run(nowIso(), loopId);
    return Number(this.db.prepare('SELECT auto_retry_count FROM loops WHERE id=?').get(loopId)?.auto_retry_count || 0);
  }

  getLoopPending(loopId) {
    const row = this.db.prepare('SELECT pending_task_json FROM loops WHERE id=?').get(loopId);
    if (!row) return {};
    try { return JSON.parse(row.pending_task_json || '{}') || {}; } catch { return {}; }
  }

  setLoopPending(loopId, pending) {
    this.db.prepare('UPDATE loops SET pending_task_json=?, updated_at=? WHERE id=?').run(JSON.stringify(pending || {}), nowIso(), loopId);
    return this.getLoopPending(loopId);
  }

  /**
   * P0-2：原子完成“移除队列任务 + 清除 pending + 绑定 Run”。
   * 进程在 startRun 之后、此事务之前崩溃时，pending 仍保留；恢复通过 requestKey 找到同一 Run，不重复创建。
   */
  claimLoopTask({ loopId, requestKey, runId }) {
    const key = String(requestKey || '');
    if (!key || !runId) throw new Error('claimLoopTask requires requestKey/runId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT pending_task_json, queue_json, current_run_id FROM loops WHERE id=?').get(loopId);
      if (!row) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'loop-not-found' }; }
      let pending = {};
      try { pending = JSON.parse(row.pending_task_json || '{}') || {}; } catch { pending = {}; }
      if (pending.requestKey !== key) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'stale-pending-key' }; }
      const queue = (() => { try { return JSON.parse(row.queue_json || '[]'); } catch { return []; } })();
      const task = pending.task || {};
      let removed = false;
      if (Number.isInteger(pending.queueIndex) && pending.queueIndex >= 0 && queue[pending.queueIndex] && queue[pending.queueIndex].title === task.title) {
        queue.splice(pending.queueIndex, 1); removed = true;
      } else if (task.title) {
        const idx = queue.findIndex((t) => t.title === task.title);
        if (idx >= 0) { queue.splice(idx, 1); removed = true; }
      }
      if (Number.isInteger(pending.queueIndex) && pending.queueIndex >= 0 && !removed) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'queue-item-missing' };
      }
      this.db.prepare('UPDATE loops SET queue_json=?, pending_task_json=?, current_run_id=?, last_run_id=?, updated_at=? WHERE id=?').run(JSON.stringify(queue), '{}', runId, runId, nowIso(), loopId);
      this.db.exec('COMMIT');
      return { ok: true, removed, runId };
    } catch (err) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw err; }
  }

  /** 恢复 pending：拿掉已绑定 Run 的 pending，或把未创建 Run 的任务放回队列。 */
  recoverLoopPending(loopId) {
    const loop = this.getLoop(loopId);
    if (!loop) return { changed: false, reason: 'loop-not-found' };
    const pending = this.getLoopPending(loopId);
    if (!pending.requestKey) return { changed: false };
    const run = this.getRunByRequestKey(pending.requestKey);
    if (run) {
      const taskCount = Number(this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE run_id=?').get(run.id)?.n || 0);
      if (taskCount === 0) {
        // 半创建 Run（crash 在 createRun 与 createPlan/createTasks 之间）：不能绑定并吞掉队列任务。
        this.db.prepare("UPDATE runs SET status='failed', stop_reason=?, ended_at=?, updated_at=? WHERE id=?").run('恢复时发现半创建 Run（无 plan/tasks），任务放回队列', nowIso(), nowIso(), run.id);
        const queue = Array.isArray(loop.queue_json) ? [...loop.queue_json] : [];
        if (pending.task && !queue.some((t) => t.title === pending.task.title)) queue.unshift(pending.task);
        this.db.prepare('UPDATE loops SET queue_json=?, pending_task_json=?, updated_at=? WHERE id=?').run(JSON.stringify(queue), '{}', nowIso(), loopId);
        return { changed: true, restored: true, orphanRunId: run.id };
      }
      const claimed = this.claimLoopTask({ loopId, requestKey: pending.requestKey, runId: run.id });
      if (!claimed?.ok) return { changed: false, linked: false, runId: run.id, reason: claimed?.reason || 'claim-failed' };
      return { changed: true, linked: true, runId: run.id };
    }
    const queue = Array.isArray(loop.queue_json) ? [...loop.queue_json] : [];
    const task = pending.task;
    if (task && !queue.some((t) => t.title === task.title && (t.qualityIssueId || '') === (task.qualityIssueId || ''))) queue.unshift(task);
    this.db.prepare('UPDATE loops SET queue_json=?, pending_task_json=?, updated_at=? WHERE id=?').run(JSON.stringify(queue), '{}', nowIso(), loopId);
    return { changed: true, restored: true };
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

  /**
   * 启动恢复：清理明显已死亡进程留下的租约。
   * 只按 owner 里的 `wb:<pid>:` 判断进程是否存活；其他 Workbench 实例仍活着时不清，
   * 避免两个 HTTP 服务共库时启动清租约互相抢写。
   */
  clearLeasesFromDeadProcesses() {
    const alive = (pid) => {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) return true; // 非标准 owner 不自动清，保持 fail-closed
      if (n === process.pid) return true;
      try { process.kill(n, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
    };
    const dead = (owner) => {
      const m = String(owner || '').match(/^wb:(\d+):/);
      return m ? !alive(m[1]) : false;
    };
    let projects = 0; let runs = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.db.prepare("SELECT id, write_owner FROM projects WHERE write_owner<>''").all()) {
        if (dead(row.write_owner)) {
          this.db.prepare("UPDATE projects SET write_owner='', lease_expires_at='', updated_at=? WHERE id=? AND write_owner=?").run(nowIso(), row.id, row.write_owner);
          projects += 1;
        }
      }
      for (const row of this.db.prepare("SELECT id, lease_owner FROM runs WHERE lease_owner<>''").all()) {
        if (dead(row.lease_owner)) {
          this.db.prepare("UPDATE runs SET lease_owner='', lease_expires_at='' WHERE id=? AND lease_owner=?").run(row.id, row.lease_owner);
          runs += 1;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw err; }
    return { projects, runs };
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
