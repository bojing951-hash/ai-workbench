/**
 * AI 全自动软件开发工作台 — 可视化前端
 * 原生 ES Module，零依赖、无外部资源；所有后端字符串仅通过
 * textContent / createElement / setAttribute 渲染，杜绝 HTML 注入。
 */

// ============================================================
// 常量：状态映射与格式化
// ============================================================
const MAX_EVENTS = 300;
const LOOP_HISTORY_LIMIT = 5;
const POLL_INTERVAL_MS = 5000;
const REFRESH_DEBOUNCE_MS = 260;

const RUN_STATUS = {
  queued: { label: '排队中', tone: 'gray' },
  running: { label: '运行中', tone: 'blue' },
  paused: { label: '已暂停', tone: 'amber' },
  interrupted: { label: '已中断', tone: 'amber' },
  awaiting_acceptance: { label: '等待验收', tone: 'cyan' },
  accepted: { label: '已验收', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
};

const LOOP_STATUS = {
  running: { label: '运行中', tone: 'blue' },
  paused: { label: '已暂停', tone: 'amber' },
  interrupted: { label: '已中断', tone: 'amber' },
  blocked: { label: '已阻塞', tone: 'amber' },
  completed: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
  unknown: { label: '未知', tone: 'gray' },
};

const TASK_STATUS = {
  queued: { label: '排队中', tone: 'gray' },
  preparing: { label: '准备中', tone: 'blue' },
  coding: { label: '编码中', tone: 'blue' },
  testing: { label: '测试中', tone: 'purple' },
  auditing: { label: '审计中', tone: 'purple' },
  repairing: { label: '修复中', tone: 'amber' },
  committing: { label: '提交中', tone: 'blue' },
  passed: { label: '已通过', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  blocked: { label: '已阻塞', tone: 'amber' },
};

const VERDICT = {
  pass: { label: '审计通过', tone: 'green' },
  fail: { label: '审计未通过', tone: 'red' },
};

const CRITERION_STATUS = {
  pass: { label: '通过', tone: 'green', icon: '✓' },
  fail: { label: '未通过', tone: 'red', icon: '✕' },
  unproven: { label: '未证实', tone: 'amber', icon: '?' },
  pending: { label: '待审计', tone: 'gray', icon: '·' },
};

const EVENT_LEVEL = {
  info: { label: '信息', tone: 'blue' },
  warn: { label: '警告', tone: 'amber' },
  error: { label: '错误', tone: 'red' },
  debug: { label: '调试', tone: 'gray' },
};

const MODE_LABELS = { single: '单任务执行', plan: '自动多任务规划' };
const AGENT_LABELS = { auto: '自动调度', dsh: 'DeepSeek Harness', claude: 'Claude Code', custom: '自定义 Agent' };
const AUDIT_PROVIDER_LABELS = { openai: 'GPT', glm: 'GLM', deepseek: 'DeepSeek' };
const STAGE_LABELS = {
  coding: '编码',
  testing: '测试',
  auditing: '审计',
  planning: '规划',
  repair: '修复',
  repairing: '修复',
  commit: '提交',
  committing: '提交',
};
const ATTEMPT_STATUS = {
  running: { label: '进行中', tone: 'blue' },
  completed: { label: '完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  interrupted: { label: '中断', tone: 'amber' },
};
const ARTIFACT_KIND_LABELS = {
  prompt: '提示词',
  diff: '代码差异',
  test: '测试证据',
  audit: '审计原文',
  commit: '提交记录',
  'audit-error': '审计错误',
};
const SEVERITY = {
  high: { label: '高', tone: 'red' },
  medium: { label: '中', tone: 'amber' },
  low: { label: '低', tone: 'gray' },
};
const CI_LABELS = {
  success: { label: 'Actions 通过', tone: 'green' },
  failure: { label: 'Actions 失败', tone: 'red' },
  in_progress: { label: 'Actions 运行中', tone: 'blue' },
  queued: { label: 'Actions 排队中', tone: 'gray' },
  pending: { label: 'Actions 等待中', tone: 'gray' },
  timeout: { label: 'Actions 轮询超时', tone: 'amber' },
  error: { label: 'Actions 查询失败', tone: 'red' },
};

// v2：验证状态（远端 CI 闸门 + 本地验收）
const VERIFICATION_STATUS = {
  LOCAL_VERIFIED: {
    code: 'LOCAL_VERIFIED',
    label: '本地已验证',
    tone: 'cyan',
    note: '仅完成本地测试与独立审计，未通过远端 CI',
  },
  CI_PENDING: {
    code: 'CI_PENDING',
    label: 'CI 等待中',
    tone: 'amber',
    note: 'GitHub Actions 尚未完成，暂不能验收',
  },
  CI_PASSED: {
    code: 'CI_PASSED',
    label: 'CI 已通过',
    tone: 'green',
    note: '远端 CI 通过且绑定验证 commit，可正常验收',
  },
  CI_FAILED: {
    code: 'CI_FAILED',
    label: 'CI 未通过',
    tone: 'red',
    note: 'GitHub Actions 失败或 commit 不一致，不能验收',
  },
  AWAITING_ACCEPTANCE: {
    code: 'AWAITING_ACCEPTANCE',
    label: '等待人工验收',
    tone: 'cyan',
    note: '运行等待人工验收',
  },
  ACCEPTED: {
    code: 'ACCEPTED',
    label: '已验收',
    tone: 'green',
    note: '已记录人工验收，未合并主分支',
  },
};

// v2：审批中心
const APPROVAL_TYPE_LABELS = {
  ci_gate: 'CI 闸门',
  remote_push: '远端推送',
  publish: '发布',
  merge: '合并',
};
const APPROVAL_STATUS = {
  pending: { label: '待审批', tone: 'amber' },
  approved: { label: '已批准', tone: 'green' },
  rejected: { label: '已拒绝', tone: 'red' },
};

// v2：费用来源（不能把 ¥0 / 未标注金额当作真实成本）
const COST_SOURCE = {
  vendor: { key: 'vendor', label: '厂商返回', tone: 'green', note: '成本来自模型厂商返回值' },
  estimated: { key: 'estimated', label: '估算', tone: 'amber', note: '按 token 与公开价格估算，不是厂商账单' },
  mixed: { key: 'mixed', label: '混合（厂商 + 估算）', tone: 'cyan', note: '部分调用为厂商返回，部分为估算' },
  unknown: { key: 'unknown', label: 'UNKNOWN', tone: 'gray', note: '未找到成本来源记录，金额可能不可靠' },
};

// v2：新增事件类型的配色与图标（未映射类型回退到关键词匹配）
const EVENT_TYPE_META = {
  audit_unknown: { icon: '?', tone: 'amber', rowClass: 'type-audit-unknown', label: '审计未知' },
  audit_error: { icon: '!', tone: 'red', rowClass: 'type-audit-error', label: '审计错误' },
  ci_gate_blocked: { icon: '⌁', tone: 'amber', rowClass: 'type-gate-blocked', label: 'CI 闸门阻塞' },
  approval_decided: { icon: '◈', tone: 'cyan', rowClass: 'type-approval', label: '审批决定' },
  test_command_fallback: { icon: '↺', tone: 'amber', rowClass: 'type-test-fallback', label: '测试命令回退' },
  protected_path_violation: { icon: '⚠', tone: 'red', rowClass: 'type-protected-violation', label: '受保护路径违规' },
  agent_progress: { icon: '›', tone: 'blue', rowClass: 'type-agent-progress', label: 'Agent 进度' },
  audit_started: { icon: '◌', tone: 'purple', label: '审计开始' },
  audit_passed: { icon: '✓', tone: 'green', rowClass: 'type-passed', label: '审计通过' },
  audit_failed: { icon: '✕', tone: 'red', rowClass: 'type-failed', label: '审计失败' },
  test_started: { icon: '▷', tone: 'blue', label: '测试开始' },
  test_passed: { icon: '✓', tone: 'green', rowClass: 'type-passed', label: '测试通过' },
  test_failed: { icon: '✕', tone: 'red', rowClass: 'type-failed', label: '测试失败' },
  task_passed: { icon: '✓', tone: 'green', rowClass: 'type-passed', label: '任务通过' },
  task_failed: { icon: '✕', tone: 'red', rowClass: 'type-failed', label: '任务失败' },
  task_requeued: { icon: '↺', tone: 'blue', label: '任务重新排队' },
  run_accepted: { icon: '✓', tone: 'green', rowClass: 'type-passed', label: '运行已验收' },
  run_awaiting_acceptance: { icon: '◈', tone: 'cyan', label: '等待验收' },
  run_resumed: { icon: '↻', tone: 'blue', label: '运行已恢复' },
  run_paused: { icon: 'Ⅱ', tone: 'amber', label: '运行已暂停' },
  run_cancelled: { icon: '×', tone: 'gray', label: '运行已取消' },
  run_error: { icon: '!', tone: 'red', rowClass: 'type-failed', label: '运行错误' },
  agent_finished: { icon: '✓', tone: 'green', label: 'Agent 完成' },
  agent_failed: { icon: '✕', tone: 'red', rowClass: 'type-failed', label: 'Agent 失败' },
  branch_pushed: { icon: '↑', tone: 'green', rowClass: 'type-passed', label: '分支已推送' },
  pr_created: { icon: '⤴', tone: 'green', rowClass: 'type-passed', label: 'PR 已创建' },
  publish_blocked: { icon: '⌁', tone: 'amber', label: '发布待授权' },
  ci_update: { icon: '◈', tone: 'blue', label: 'CI 状态更新' },
  no_changes: { icon: '·', tone: 'amber', label: '无代码变更' },
  worktree_ready: { icon: '◇', tone: 'blue', label: '工作副本就绪' },
};

const TONE_VARS = {
  green: 'var(--green)',
  red: 'var(--red)',
  amber: 'var(--amber)',
  cyan: 'var(--cyan)',
  blue: 'var(--blue)',
  purple: 'var(--purple)',
  gray: 'var(--gray)',
};

// ============================================================
// 全局 UI 状态（仅前端）
// ============================================================
const app = {
  state: null,
  stateError: null,
  lastStateAt: 0,
  selectedProjectId: null,
  selectedRunId: null,
  runDetail: null,
  runDetailError: null,
  runDetailLoading: false,
  formProjectId: null,
  goalCollapsed: false,
  drafts: new Map(),
  expandedTasks: new Set(),
  taskDetails: new Map(),
  runActionPending: false,
  approvalPending: new Set(),
  scrollToRunAfterLoad: false,
  events: [],
  eventIds: new Set(),
  eventScopeKey: '',
  eventFloor: 0,
  eventAutoScroll: true,
  sse: { state: 'connecting', source: null, retryTimer: null, wasOffline: false },
  pollTimer: null,
  refreshTimer: null,
  refreshInFlight: false,
  refreshQueued: false,
  backgroundErrorAt: 0,
  backgroundErrorMsg: '',
  lastToast: { message: '', at: 0 },
  modal: { open: false, type: '', onClose: null, confirmFinish: null, lastFocus: null, approvalsSig: '' },
  drawer: { open: false, path: '', content: '', lastFocus: null },
  booted: false,
  isolation: null,
  isolationError: null,
  insightView: '',
  liveData: null,
  liveError: null,
  liveProjectId: '',
  liveLoading: false,
  liveTimer: null,
  replayData: null,
  replayError: null,
  replayLoading: false,
  replayAct: 0,
  replayMode: 'simple',
  replayTimeline: false,
};

const dom = {};

// ============================================================
// DOM 工具
// ============================================================
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title) node.title = String(options.title);
  if (options.style) {
    for (const [key, value] of Object.entries(options.style)) {
      if (value !== undefined && value !== null) node.style.setProperty(key, String(value));
    }
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === null || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (options.on) {
    for (const [type, handler] of Object.entries(options.on)) node.addEventListener(type, handler);
  }
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function textSpan(className, text, title) {
  return el('span', { className, text, title });
}

function statusDot(tone) {
  return el('span', { className: `status-dot${tone ? ` tone-${tone}` : ''}` });
}

function badge(label, tone) {
  return el('span', { className: `badge tone-${tone || 'gray'}` }, [
    el('span', { className: 'badge-dot' }),
    el('span', { text: label }),
  ]);
}

function runBadge(status) {
  const meta = RUN_STATUS[status] || { label: status || '未知', tone: 'gray' };
  return badge(meta.label, meta.tone);
}

function taskBadge(status) {
  const meta = TASK_STATUS[status] || { label: status || '未知', tone: 'gray' };
  return badge(meta.label, meta.tone);
}

function severityMeta(value) {
  const key = String(value || '').toLowerCase();
  return SEVERITY[key] || { label: key || '提示', tone: 'gray' };
}

function agentLabel(kind) {
  return AGENT_LABELS[kind] || AGENT_LABELS.auto;
}

function auditProviderLabel(provider) {
  const key = String(provider || '').toLowerCase();
  return AUDIT_PROVIDER_LABELS[key] || provider || '—';
}

// ============================================================
// 格式化
// ============================================================
function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtTokens(value) {
  const n = toNumber(value);
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}k`;
  }
  return String(Math.round(n));
}

function fmtCost(value) {
  const n = toNumber(value);
  if (n >= 1000) return `${Math.round((n / 1000) * 10) / 10}k`;
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  if (n > 0) return n.toFixed(3);
  return '0.00';
}

function fmtCostCny(value, maxValue) {
  return `¥${fmtCost(value, maxValue)}`;
}

function fmtPercent(value) {
  const n = toNumber(value);
  const rounded = Math.round(n * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function fmtDurationMs(value) {
  const ms = toNumber(value);
  if (ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m}分${s}秒` : `${m}分钟`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}小时${m}分` : `${h}小时`;
}

function fmtDurationBetween(startIso, endIso) {
  if (!startIso) return '—';
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  return fmtDurationMs(end - start);
}

function fmtSeconds(value) {
  const sec = toNumber(value);
  if (sec < 60) return `${Math.round(sec)}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}小时${m}分` : `${h}小时`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDate(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? new Date(t) : null;
}

function fmtClock(value) {
  const d = value instanceof Date ? value : parseDate(value);
  if (!d) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtDateTime(value) {
  const d = value instanceof Date ? value : parseDate(value);
  if (!d) return '—';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${sameYear ? date : `${d.getFullYear()}-${date}`} ${time}`;
}

function fmtDateTimeFull(value) {
  const d = value instanceof Date ? value : parseDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtRelative(value) {
  const d = value instanceof Date ? value : parseDate(value);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return '刚刚';
  if (diff < 15_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDateTime(d);
}

function shortId(value, length = 10) {
  const s = String(value || '');
  if (!s) return '—';
  return s.length > length ? `${s.slice(0, length)}…` : s;
}

function shortHash(value, length = 8) {
  const s = String(value || '');
  if (!s) return '—';
  return s.slice(0, length);
}

function basename(filePath) {
  const s = String(filePath || '');
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

function artifactKindLabel(kind) {
  return ARTIFACT_KIND_LABELS[kind] || kind || '产物';
}

function fmtBytes(value) {
  const n = toNumber(value);
  if (n <= 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round((n / 1024) * 10) / 10} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

function safeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    return '';
  }
  return '';
}

function parseAcceptanceLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ============================================================
// v2：审批 / 验证状态 / 费用来源 数据工具
// ============================================================
function fmtShortSha(value, length = 8) {
  const sha = String(value || '').trim();
  return sha ? sha.slice(0, length) : '—';
}

function parseTagList(text) {
  return [
    ...new Set(
      String(text || '')
        .split(/[\r\n,，;；、]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function flagOn(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function flagOff(value) {
  return value === false || value === 0 || value === '0' || value === 'false';
}

function normalizeCostSourceKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  if (['vendor', 'vendor-returned', 'reported', 'exact', 'api', 'billing'].includes(key)) return 'vendor';
  if (['estimated', 'estimate', 'calc', 'calculated', 'fallback', 'computed'].includes(key)) return 'estimated';
  return 'unknown';
}

function costSourceMeta(key) {
  return COST_SOURCE[key] || COST_SOURCE.unknown;
}

function collectCostSourceKeys(run) {
  const keys = new Set();
  const push = (value) => {
    const key = normalizeCostSourceKey(value);
    if (key) keys.add(key);
  };
  const pushAttempts = (attempts) => {
    for (const attempt of Array.isArray(attempts) ? attempts : []) {
      if (attempt) push(attempt.costSource ?? attempt.cost_source);
    }
  };
  for (const task of run?.tasks || []) pushAttempts(task.attempts);
  for (const entry of app.taskDetails.values()) pushAttempts(entry?.data?.attempts);
  const events = Array.isArray(run?.events) ? run.events : [];
  for (const event of events) {
    const type = String(event?.type || '');
    if (type !== 'agent_finished' && type !== 'agent_failed') continue;
    const data = event?.data && typeof event.data === 'object' ? event.data : event?.data_json || {};
    if (typeof data.costReported === 'boolean') push(data.costReported ? 'vendor' : 'estimated');
    const message = String(event?.message || '');
    if (message.includes('费用来源：厂商返回')) push('vendor');
    else if (message.includes('费用来源：估算')) push('estimated');
  }
  return keys;
}

function costSourceOfRun(run) {
  const keys = collectCostSourceKeys(run);
  const hasVendor = keys.has('vendor');
  const hasEstimated = keys.has('estimated');
  if (hasVendor && hasEstimated) return COST_SOURCE.mixed;
  if (hasVendor) return COST_SOURCE.vendor;
  if (hasEstimated) return COST_SOURCE.estimated;
  return COST_SOURCE.unknown;
}

function costSourceOfAttempt(attempt) {
  return costSourceMeta(normalizeCostSourceKey(attempt?.costSource) || 'unknown');
}

function fmtRunCost(run) {
  const cost = toNumber(run?.spent_json?.costCny);
  if (cost > 0) return fmtCostCny(cost);
  const tokens = toNumber(run?.spent_json?.tokens);
  return tokens > 0 ? '费用未知' : '—';
}

function buildCostSourceChip(run, options = {}) {
  const source = costSourceOfRun(run);
  return el('span', {
    className: `cost-source-chip tone-${source.tone}${options.block ? ' is-block' : ''}`,
    title: `费用来源：${source.label}\n${source.note}`,
  }, [
    el('span', { className: 'cost-source-chip-label', text: options.prefix === false ? source.label : `费用来源：${source.label}` }),
  ]);
}

function normalizeApproval(raw) {
  const item = raw || {};
  const details =
    item.details_json && typeof item.details_json === 'object'
      ? item.details_json
      : item.details && typeof item.details === 'object'
        ? item.details
        : {};
  return {
    id: item.id || '',
    runId: item.run_id || item.runId || '',
    taskId: item.task_id || item.taskId || '',
    type: String(item.type || ''),
    status: String(item.status || 'pending').toLowerCase(),
    title: String(item.title || ''),
    details,
    createdAt: item.created_at || item.createdAt || '',
    updatedAt: item.updated_at || '',
    decidedAt: item.decided_at || item.decidedAt || '',
    decidedBy: item.decided_by || item.decidedBy || '',
  };
}

function normalizeApprovals(list) {
  return (Array.isArray(list) ? list : []).map(normalizeApproval).filter((item) => item.id);
}

function pendingApprovals() {
  const list = normalizeApprovals(app.state?.approvals);
  return list.filter((approval) => approval.status === 'pending');
}

function approvalTypeLabel(type) {
  return APPROVAL_TYPE_LABELS[type] || type || '审批项';
}

function approvalStatusMeta(status) {
  return APPROVAL_STATUS[status] || { label: status || '未知', tone: 'gray' };
}

function approvalDetailsSummary(approval) {
  const details = approval?.details || {};
  const parts = [];
  const verification = details.verification && typeof details.verification === 'object' ? details.verification : {};
  if (verification.status) parts.push(`验证状态 ${verification.status}`);
  if (verification.note) parts.push(String(verification.note));
  if (details.planHead) parts.push(`commit ${fmtShortSha(details.planHead, 10)}`);
  const blocked = Array.isArray(details.publish?.blocked) ? details.publish.blocked.filter(Boolean) : [];
  if (blocked.length) parts.push(`待授权动作：${blocked.join('；')}`);
  if (details.note) parts.push(String(details.note));
  return parts.length ? parts.join(' · ') : '无额外详情';
}

function verificationStatusOf(run) {
  const detail = run || {};
  const result = detail.result_json && typeof detail.result_json === 'object' ? detail.result_json : {};
  const raw = String(detail.verification_status || result.verificationStatus || result.acceptedVerification || '')
    .trim()
    .toUpperCase();
  if (raw) return raw;
  if (detail.status === 'awaiting_acceptance') return 'AWAITING_ACCEPTANCE';
  if (detail.status === 'accepted') return 'ACCEPTED';
  return '';
}

function verificationMetaOf(status) {
  const code = String(status || '').trim().toUpperCase();
  if (VERIFICATION_STATUS[code]) return VERIFICATION_STATUS[code];
  return {
    code: code || 'UNKNOWN',
    label: code ? `未知验证状态（${code}）` : '验证状态未知',
    tone: 'gray',
    note: '后端未返回可识别的 verification_status',
  };
}

function verifiedShaOf(run) {
  const detail = run || {};
  const result = detail.result_json && typeof detail.result_json === 'object' ? detail.result_json : {};
  return String(detail.verified_sha || result.verifiedSha || result.acceptedSha || result.planHead || '');
}

function ciInfoOf(run) {
  const detail = run || {};
  const result = detail.result_json && typeof detail.result_json === 'object' ? detail.result_json : {};
  const publish = result.publish && typeof result.publish === 'object' ? result.publish : {};
  const ci = result.ci && typeof result.ci === 'object' ? result.ci : publish.ci && typeof publish.ci === 'object' ? publish.ci : null;
  const status = String(detail.ci_status || ci?.status || '').toLowerCase();
  const conclusion = String(ci?.conclusion || '').toLowerCase();
  const url = safeHttpUrl(detail.ci_url || ci?.htmlUrl || ci?.url);
  const phase = conclusion || status;
  const meta =
    CI_LABELS[phase] ||
    (phase === 'done' ? CI_LABELS.success : null) || {
      label: phase ? `CI 状态：${phase}` : 'CI 状态未知',
      tone: 'gray',
    };
  return {
    status,
    conclusion,
    url,
    meta,
    note: ci?.note || '',
    error: ci?.error || '',
    sha: String(ci?.sha || ''),
  };
}

/**
 * 根据运行状态 + 验证状态决定「验收」是否可用、以及是否必须发送 confirmLocalOnly。
 */
function acceptancePlan(run) {
  const project = (app.runDetail && app.runDetail.project) || currentProject() || null;
  const status = verificationStatusOf(run);
  const sha = verifiedShaOf(run);
  const allowLocal = !flagOff(project?.allow_local_acceptance);
  const base = {
    status,
    sha,
    allowLocal,
    mode: 'unknown',
    confirmLocalOnly: false,
    allowed: false,
    reason: '',
  };
  if (run?.status !== 'awaiting_acceptance') {
    return { ...base, allowed: false, reason: '运行不在等待验收状态' };
  }
  if (!sha) {
    return { ...base, allowed: false, reason: '运行没有绑定真实验证 commit（verified_sha），后端不允许验收' };
  }
  if (status === 'CI_PASSED') return { ...base, allowed: true, mode: 'ci' };
  if (status === 'CI_PENDING') {
    return { ...base, allowed: false, reason: 'GitHub CI 尚未完成（CI_PENDING），完成前不能验收；可点击「刷新 CI」后重试。' };
  }
  if (status === 'CI_FAILED') {
    return { ...base, allowed: false, reason: 'GitHub CI 未通过（CI_FAILED），不能验收；请先修复 CI 失败项。' };
  }
  if (status === 'LOCAL_VERIFIED') {
    if (!allowLocal) {
      return { ...base, allowed: false, reason: '项目不允许本地验收（allow_local_acceptance=false），需要等待远端 CI 通过。' };
    }
    return { ...base, allowed: true, mode: 'local', confirmLocalOnly: true };
  }
  if (status === 'ACCEPTED') return { ...base, allowed: false, reason: '运行已验收' };
  // 旧版后端没有 verification_status：仅允许在人工核对后按旧流程验收
  return { ...base, allowed: true, mode: 'legacy' };
}

function verificationSubText(run, info) {
  const meta = info.verification;
  if (run.status === 'accepted') return `已记录人工验收 · ${meta.code}`;
  if (!info.verificationStatus) return '后端未返回验证状态（可能是旧版服务）';
  return meta.note;
}

function verificationGuidance(run, info, plan) {
  const meta = info.verification;
  const sha = info.verifiedSha ? fmtShortSha(info.verifiedSha, 10) : '';
  if (run.status === 'awaiting_acceptance') {
    if (!plan.allowed && plan.reason && meta.code !== 'CI_PENDING' && meta.code !== 'CI_FAILED') {
      return `${plan.reason}${sha ? `（当前验证状态 ${meta.code}，验证 commit ${sha}）` : `（当前验证状态 ${meta.code}）`}`;
    }
    if (plan.mode === 'local') {
      return `仅本地验证（LOCAL_VERIFIED，commit ${sha}）：远端 CI 未通过或项目未要求远端 CI。点击验收会弹出确认并发送 confirmLocalOnly=true，按「本地交付」记录；不会合并主分支、不会部署。`;
    }
    if (meta.code === 'CI_PASSED') {
      return `远端 CI 已通过（CI_PASSED，commit ${sha}）：可以正常验收。验收只记录人工决定，不会自动合并主分支或部署。`;
    }
    if (meta.code === 'CI_PENDING') {
      return `GitHub CI 尚未完成（CI_PENDING）：完成前不能验收。可点击「刷新 CI」重新拉取 Actions 状态，完成后再验收。`;
    }
    if (meta.code === 'CI_FAILED') {
      return `GitHub CI 未通过（CI_FAILED）：不能验收。请打开 CI 详情修复失败项，或取消本次运行。`;
    }
    if (plan.mode === 'legacy') {
      return `当前服务未返回 verification_status（可能是旧版后端）：无法确认远端 CI 结果。验收前请人工核对目标、任务、审计与产物，验收只记录结果，不会合并主分支。`;
    }
    return meta.note;
  }
  if (run.status === 'accepted') {
    return `已验收（${info.verificationStatus || '状态未知'}${sha ? `，commit ${sha}` : ''}；未合并主分支，未部署）。`;
  }
  if (run.status === 'running' || run.status === 'queued') {
    return `运行尚未结束，verification_status 会在完成后更新（LOCAL_VERIFIED / CI_PENDING / CI_PASSED / CI_FAILED）。当前记录：${meta.code}；此时不可验收。`;
  }
  if (run.status === 'paused' || run.status === 'interrupted') {
    return `运行在验证/验收前暂停。恢复运行后会重新计算验证状态；当前验证状态：${meta.code}。`;
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    return `运行已结束，验证状态：${meta.code}。未验收、未合并主分支。`;
  }
  return `验证状态：${meta.code}。远端交付需要 CI_PASSED 并绑定 commit，本地验收需要显式确认。`;
}

function buildAcceptConfirmOptions(run, info, plan) {
  const sha = info.verifiedSha ? fmtShortSha(info.verifiedSha, 10) : '';
  if (plan.mode === 'local') {
    return {
      title: '确认本地验收（不合并）',
      message: `运行 ${shortId(run.id, 16)} 当前验证状态为 LOCAL_VERIFIED（commit ${sha}），未通过远端 CI。`,
      highlight: '确认后将按「本地交付」记录人工验收，并向服务发送 { confirmLocalOnly: true }。',
      warning: '验收不会合并主分支、不会部署、不会自动推送远端；是否合并 PR 仍由你自行决定。',
      confirmText: '确认本地验收',
      tone: 'accept',
    };
  }
  if (plan.mode === 'ci') {
    return {
      title: '记录人工验收（CI_PASSED）',
      message: `远端 CI 已通过（CI_PASSED）并绑定 commit ${sha}。验收只记录人工决定，不改变远端仓库。`,
      highlight: '不会合并主分支、不会部署、不会自动推送。',
      warning: '如需合并 PR，请自行在 GitHub 上操作并复核 CI 与审计证据。',
      confirmText: '确认验收（不合并）',
      tone: 'accept',
    };
  }
  return {
    title: '记录人工验收（验证状态未知）',
    message: `当前服务未返回可识别的验证状态（可能是旧版后端），运行 ${shortId(run.id, 16)} 的验证 commit 为 ${sha || '未知'}。`,
    warning: '无法确认远端 CI 结果；请仅在你已人工核对目标、任务、审计与产物后继续。验收不会合并主分支、不会部署。',
    highlight: '验收只记录人工决定，不会自动合并主分支。',
    confirmText: '确认验收（不合并）',
    tone: 'accept',
  };
}

// ============================================================
// API
// ============================================================
class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.code = code || '';
    this.details = details || null;
  }
}

async function apiRequest(method, requestPath, body) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(requestPath, init);
  } catch {
    throw new ApiError('无法连接工作台服务，请确认本地服务正在运行', 0, 'NETWORK_ERROR');
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const errorPayload = payload && payload.ok === false ? payload.error : null;
    if (!response.ok || errorPayload) {
      const rawMessage = errorPayload?.message || payload?.message || `请求失败（HTTP ${response.status}）`;
      throw new ApiError(
        describeHttpError(response.status, rawMessage),
        response.status,
        errorPayload?.code || '',
        // details 仅用于程序判断，绝不在界面上按 HTML 渲染
        errorPayload?.details || null,
      );
    }
    return payload ? payload.data : undefined;
  }
  const text = await response.text();
  if (!response.ok) throw new ApiError(describeHttpError(response.status, `请求失败（HTTP ${response.status}）`), response.status);
  return text;
}

function describeHttpError(status, rawMessage) {
  const message = String(rawMessage || '').trim();
  if (status === 401) return 'API 认证失败，请刷新页面获取会话 Cookie 后重试';
  if (status === 403) {
    return message && message !== '请求失败（HTTP 403）'
      ? `请求被安全策略拒绝：${message}`
      : '请求被安全策略拒绝：Host / Origin / CSRF / 限流校验未通过，请刷新页面后重试';
  }
  if (!message) return `请求失败（HTTP ${status}）`;
  return message;
}

// ============================================================
// Toast
// ============================================================
const TOAST_ICONS = { success: '✓', error: '!', warn: '!', info: 'i' };

function toast(message, tone = 'info', options = {}) {
  const text = String(message || '').trim();
  if (!text) return;
  const now = Date.now();
  if (!options.force && app.lastToast.message === text && now - app.lastToast.at < 2500) return;
  app.lastToast = { message: text, at: now };

  const root = dom.toastRoot;
  if (!root) return;
  while (root.childElementCount >= 4) root.firstElementChild.remove();

  const duration = toNumber(options.duration, tone === 'error' ? 6000 : 4000);
  const node = el('div', { className: `toast tone-${tone}` }, [
    el('span', { className: 'toast-icon', text: TOAST_ICONS[tone] || 'i' }),
    el('span', { className: 'toast-message', text }),
  ]);
  const close = el('button', {
    className: 'toast-close',
    text: '×',
    attrs: { type: 'button', 'aria-label': '关闭提示' },
  });
  node.append(close);

  let timer = null;
  const remove = () => {
    if (timer) window.clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 200);
  };
  close.addEventListener('click', remove);
  node.addEventListener('mouseenter', () => {
    if (timer) window.clearTimeout(timer);
  });
  node.addEventListener('mouseleave', () => {
    timer = window.setTimeout(remove, 1500);
  });
  root.append(node);
  timer = window.setTimeout(remove, duration);
}

function reportBackgroundError(error, prefix) {
  const now = Date.now();
  const message = String(error?.message || error || '未知错误');
  if (app.backgroundErrorMsg === message && now - app.backgroundErrorAt < 30_000) return;
  app.backgroundErrorMsg = message;
  app.backgroundErrorAt = now;
  toast(`${prefix || '刷新失败'}：${message}`, 'error');
}

// ============================================================
// 模态框 / 确认框
// ============================================================
function setOverlayLock(locked) {
  document.body.classList.toggle('has-overlay', !!locked);
}

function openModal(options) {
  if (app.modal.open) closeModal({ silent: true });
  const opts = options || {};
  app.modal.open = true;
  app.modal.type = opts.type || 'custom';
  app.modal.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  app.modal.confirmFinish = null;
  app.modal.lastFocus = document.activeElement;

  dom.modalTitle.textContent = opts.title || '对话框';
  clearNode(dom.modalBody);
  if (opts.body instanceof Node) dom.modalBody.append(opts.body);
  clearNode(dom.modalFoot);
  for (const item of opts.footer || []) {
    if (item) dom.modalFoot.append(item);
  }
  dom.modalFoot.hidden = (opts.footer || []).length === 0;
  if (dom.modalBox) dom.modalBox.classList.toggle('modal-wide', !!opts.wide);
  dom.modalLayer.hidden = false;
  setOverlayLock(true);

  window.requestAnimationFrame(() => {
    const focusTarget = opts.focusEl || dom.modalBody.querySelector('input, textarea, select, button');
    if (focusTarget && typeof focusTarget.focus === 'function') {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  });
}

function closeModal(options = {}) {
  if (!app.modal.open) return;
  app.modal.open = false;
  app.modal.confirmFinish = null;
  app.modal.onClose = null;
  dom.modalLayer.hidden = true;
  if (dom.drawerLayer.hidden) setOverlayLock(false);
  const lastFocus = app.modal.lastFocus;
  app.modal.lastFocus = null;
  if (!options.silent && lastFocus && typeof lastFocus.focus === 'function' && lastFocus.isConnected) {
    try {
      lastFocus.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

function dismissModal() {
  if (!app.modal.open) return;
  if (typeof app.modal.confirmFinish === 'function') {
    const finish = app.modal.confirmFinish;
    app.modal.confirmFinish = null;
    finish(false);
    return;
  }
  closeModal();
}

function confirmDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      app.modal.confirmFinish = null;
      closeModal();
      resolve(value);
    };
    const body = el('div', { className: 'confirm-body' });
    if (opts.message) body.append(el('p', { className: 'confirm-message', text: opts.message }));
    if (opts.highlight) body.append(el('div', { className: 'confirm-highlight', text: opts.highlight }));
    if (opts.warning) body.append(el('div', { className: 'confirm-warning', text: opts.warning }));

    const cancelButton = el('button', {
      className: 'button button-ghost',
      text: opts.cancelText || '取消',
      attrs: { type: 'button' },
      on: { click: () => finish(false) },
    });
    const confirmBlocked = opts.confirmDisabled === true;
    const confirmButton = el('button', {
      className: `button ${opts.tone === 'danger' ? 'button-danger' : opts.tone === 'warn' ? 'button-warn' : opts.tone === 'accept' ? 'button-accept' : 'button-primary'}`,
      text: opts.confirmText || '确认',
      attrs: { type: 'button', disabled: confirmBlocked ? true : undefined },
      on: { click: () => finish(true) },
    });
    openModal({
      type: 'confirm',
      title: opts.title || '请确认',
      body,
      footer: [cancelButton, confirmButton],
      focusEl: confirmButton,
      onClose: () => finish(false),
    });
    app.modal.confirmFinish = finish;
  });
}

// ============================================================
// 产物抽屉
// ============================================================
function closeDrawer() {
  if (!app.drawer.open) return;
  app.drawer.open = false;
  dom.drawerLayer.hidden = true;
  app.drawer.content = '';
  app.drawer.path = '';
  dom.drawerContent.textContent = '';
  dom.drawerContent.hidden = true;
  if (dom.modalLayer.hidden) setOverlayLock(false);
  const lastFocus = app.drawer.lastFocus;
  app.drawer.lastFocus = null;
  if (lastFocus && typeof lastFocus.focus === 'function' && lastFocus.isConnected) {
    try {
      lastFocus.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

async function openArtifactDrawer(artifact) {
  const item = artifact || {};
  const path = String(item.path || '');
  if (!path) {
    toast('产物路径为空，无法打开', 'error');
    return;
  }
  app.drawer.open = true;
  app.drawer.path = path;
  app.drawer.content = '';
  app.drawer.lastFocus = document.activeElement;
  dom.drawerTitle.textContent = `${artifactKindLabel(item.kind)}预览`;
  dom.drawerPath.textContent = path;
  dom.drawerState.className = 'drawer-state';
  dom.drawerState.textContent = '正在读取产物…';
  dom.drawerState.hidden = false;
  dom.drawerContent.textContent = '';
  dom.drawerContent.hidden = true;
  dom.drawerLayer.hidden = false;
  setOverlayLock(true);
  try {
    dom.drawerCloseBtn.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  try {
    const text = await apiRequest('GET', `/api/artifacts?path=${encodeURIComponent(path)}`);
    if (!app.drawer.open || app.drawer.path !== path) return;
    app.drawer.content = String(text ?? '');
    dom.drawerContent.textContent = app.drawer.content || '（空文件）';
    dom.drawerContent.hidden = false;
    dom.drawerState.hidden = true;
  } catch (error) {
    if (!app.drawer.open || app.drawer.path !== path) return;
    dom.drawerState.className = 'drawer-state is-error';
    dom.drawerState.textContent = `读取失败：${error.message}`;
    toast(error.message, 'error');
  }
}

async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }
  const temp = document.createElement('textarea');
  temp.value = value;
  temp.setAttribute('readonly', '');
  temp.style.position = 'fixed';
  temp.style.left = '-9999px';
  temp.style.opacity = '0';
  document.body.append(temp);
  temp.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  temp.remove();
  return ok;
}

async function copyWithToast(text, label) {
  const ok = await copyText(text);
  if (ok) toast(label || '已复制到剪贴板', 'success', { duration: 1800, force: true });
  else toast('复制失败，请手动选择文本复制', 'warn');
}

// ============================================================
// DOM 缓存与静态事件绑定
// ============================================================
const DOM_IDS = [
  'versionText',
  'isolationPill',
  'isolationDot',
  'isolationLabel',
  'budgetWidget',
  'budgetTokensValue',
  'budgetTokensBar',
  'budgetGlmValue',
  'budgetCostValue',
  'budgetCostBar',
  'auditPill',
  'auditDot',
  'auditLabel',
  'agentPills',
  'githubPill',
  'githubDot',
  'githubLabel',
  'ssePill',
  'sseDot',
  'sseLabel',
  'refreshBtn',
  'approvalsBtn',
  'approvalsCount',
  'helpBtn',
  'projectCount',
  'projectList',
  'addProjectBtn',
  'sidebarHint',
  'miniActiveRuns',
  'miniAgentSlots',
  'miniTaskPassed',
  'miniPolicyNote',
  'welcomeView',
  'welcomeAddProjectBtn',
  'welcomeHelpBtn',
  'statProjects',
  'statRuns',
  'statActive',
  'statAudit',
  'projectView',
  'projectHeader',
  'goalPanel',
  'goalPanelSub',
  'goalToggleBtn',
  'goalForm',
  'goalInput',
  'goalCharCount',
  'acceptanceInput',
  'acceptanceCount',
  'goalError',
  'startRunBtn',
  'runsPanel',
  'runsSub',
  'runList',
  'loopsPanel',
  'loopsSub',
  'loopList',
  'loopsEmpty',
  'loopsRefreshBtn',
  'runDetailView',
  'runHeader',
  'verifyPanel',
  'runApprovalsPanel',
  'tasksSub',
  'taskList',
  'eventsScope',
  'autoScrollToggle',
  'eventLog',
  'eventCount',
  'sseMini',
  'sseMiniDot',
  'sseMiniLabel',
  'clearEventsBtn',
  'statusPanel',
  'insightView',
  'insightContent',
  'insightGuideBtn',
  'insightLiveBtn',
  'insightReplayBtn',
  'toastRoot',
  'modalLayer',
  'modalBackdrop',
  'modalTitle',
  'modalCloseBtn',
  'modalBody',
  'modalFoot',
  'drawerLayer',
  'drawerBackdrop',
  'drawerTitle',
  'drawerPath',
  'drawerCloseBtn',
  'drawerCopyBtn',
  'drawerState',
  'drawerContent',
];

const TONE_CLASSES = ['tone-green', 'tone-amber', 'tone-red', 'tone-cyan', 'tone-blue', 'tone-purple', 'tone-gray', 'tone-accent'];

function cacheDom() {
  for (const id of DOM_IDS) dom[id] = document.getElementById(id);
  dom.modalBox = document.querySelector('.modal');
  dom.eventLog = dom.eventLog || document.getElementById('eventLog');
}

function setToneClass(node, tone, extraClass) {
  if (!node) return;
  for (const cls of TONE_CLASSES) node.classList.remove(cls);
  if (tone) node.classList.add(`tone-${tone}`);
  node.classList.toggle('is-offline', tone === 'gray');
  if (extraClass) node.classList.add(extraClass);
}

function bindStaticEvents() {
  dom.addProjectBtn.addEventListener('click', () => openAddProjectModal());
  dom.insightGuideBtn?.addEventListener('click', () => openInsight('guide'));
  dom.insightLiveBtn?.addEventListener('click', () => openInsight('live'));
  dom.insightReplayBtn?.addEventListener('click', () => openInsight('replay'));
  dom.welcomeAddProjectBtn.addEventListener('click', () => openAddProjectModal());
  dom.helpBtn.addEventListener('click', () => openHelpModal());
  dom.welcomeHelpBtn.addEventListener('click', () => openHelpModal());
  dom.refreshBtn.addEventListener('click', () => refreshAll({ silent: false, reason: 'manual' }));
  if (dom.loopsRefreshBtn) dom.loopsRefreshBtn.addEventListener('click', () => refreshLoopsPanel());
  dom.approvalsBtn.addEventListener('click', () => openApprovalsModal());
  dom.modalBackdrop.addEventListener('click', dismissModal);
  dom.modalCloseBtn.addEventListener('click', dismissModal);
  dom.drawerBackdrop.addEventListener('click', closeDrawer);
  dom.drawerCloseBtn.addEventListener('click', closeDrawer);
  dom.drawerCopyBtn.addEventListener('click', () => {
    if (!app.drawer.content) {
      toast('暂无可复制的内容', 'warn');
      return;
    }
    copyWithToast(app.drawer.content, '产物内容已复制');
  });
  dom.autoScrollToggle.addEventListener('change', () => {
    app.eventAutoScroll = !!dom.autoScrollToggle.checked;
    if (app.eventAutoScroll) scrollEventsToBottom(true);
  });
  dom.clearEventsBtn.addEventListener('click', () => {
    const maxId = app.events.reduce((max, event) => Math.max(max, event.id), 0);
    app.eventFloor = Math.max(app.eventFloor, Number.isFinite(maxId) ? maxId : 0);
    app.events = [];
    app.eventIds.clear();
    renderEventLog();
    toast('本地事件缓存已清空，新事件会继续实时追加', 'info');
  });
  dom.goalToggleBtn.addEventListener('click', () => {
    setGoalCollapsed(!app.goalCollapsed);
  });
  dom.goalForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitStartRun();
  });
  dom.goalInput.addEventListener('input', () => {
    updateEditorCounts();
    saveCurrentDraft();
    hideGoalError();
  });
  dom.acceptanceInput.addEventListener('input', () => {
    updateEditorCounts();
    saveCurrentDraft();
  });
  for (const radio of dom.goalForm.querySelectorAll('input[name="runMode"]')) {
    radio.addEventListener('change', () => {
      updateModeCards();
      saveCurrentDraft();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (app.drawer.open) {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (app.modal.open) {
      event.preventDefault();
      dismissModal();
    }
  });
  window.addEventListener('hashchange', () => {
    if (!app.booted) return;
    const route = parseRoute();
    if (route.insight) { applyRoute(); return; }
    if (app.insightView) { applyRoute(); return; }
    if (route.runId && route.runId === app.selectedRunId) return;
    if (!route.runId && route.projectId && route.projectId === app.selectedProjectId && !app.selectedRunId) return;
    if (!route.runId && !route.projectId && !app.selectedProjectId) return;
    applyRoute();
  });
  window.addEventListener('resize', () => updateTopbarHeight());
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => updateTopbarHeight()).observe(document.getElementById('topbar'));
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll({ silent: true, reason: 'visible' });
  });
}

function updateTopbarHeight() {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;
  const height = Math.round(topbar.getBoundingClientRect().height);
  if (height > 0) document.documentElement.style.setProperty('--topbar-h', `${height}px`);
}

function setGoalCollapsed(collapsed) {
  app.goalCollapsed = !!collapsed;
  dom.goalPanel.classList.toggle('is-collapsed', app.goalCollapsed);
  dom.goalToggleBtn.textContent = app.goalCollapsed ? '展开' : '收起';
  dom.goalToggleBtn.setAttribute('aria-expanded', String(!app.goalCollapsed));
  const project = currentProject();
  if (project) updateGoalPanelSub(project);
}

// ============================================================
// 数据加载
// ============================================================
function currentProject() {
  if (!app.state || !Array.isArray(app.state.projects)) return null;
  return app.state.projects.find((project) => project.id === app.selectedProjectId) || null;
}

function findRun(runId) {
  if (!runId) return null;
  if (app.runDetail && app.runDetail.id === runId) {
    return { run: app.runDetail, projectId: app.runDetail.project_id };
  }
  if (!app.state) return null;
  for (const run of app.state.runs || []) {
    if (run.id === runId) return { run, projectId: run.project_id };
  }
  for (const project of app.state.projects || []) {
    if (project.latestRun && project.latestRun.id === runId) return { run: project.latestRun, projectId: project.id };
    for (const run of project.runs || []) {
      if (run.id === runId) return { run, projectId: project.id };
    }
  }
  return null;
}

function runBelongsToProject(runId, projectId) {
  if (!runId || !projectId || !app.state) return false;
  const project = (app.state.projects || []).find((item) => item.id === projectId);
  if (!project) return false;
  if (project.latestRun && project.latestRun.id === runId) return true;
  return (project.runs || []).some((run) => run.id === runId);
}

async function loadState(options = {}) {
  const silent = !!options.silent;
  try {
    const data = await apiRequest('GET', '/api/state');
    if (!data || typeof data !== 'object') throw new ApiError('工作台返回了无效的状态数据', 0, 'BAD_STATE');
    app.state = data;
    // 研发循环面板优先使用 GET /api/state 的 loops 字段；旧服务未返回时回退到 GET /api/loops。
    if (!Array.isArray(app.state.loops)) app.state.loops = await loadLoopsFallback();
    app.stateError = null;
    app.lastStateAt = Date.now();
    return true;
  } catch (error) {
    app.stateError = error;
    if (silent) reportBackgroundError(error);
    return false;
  }
}

async function loadLoopsFallback() {
  try {
    const data = await apiRequest('GET', '/api/loops');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function normalizeAudit(rawAudit) {
  const audit = rawAudit || {};
  return {
    id: audit.id || '',
    provider: audit.provider || '',
    model: audit.model || '',
    verdict: audit.verdict || '',
    score: toNumber(audit.score),
    criteria: Array.isArray(audit.criteria)
      ? audit.criteria
      : Array.isArray(audit.criteria_json)
        ? audit.criteria_json
        : [],
    findings: Array.isArray(audit.findings)
      ? audit.findings
      : Array.isArray(audit.findings_json)
        ? audit.findings_json
        : [],
    requiredFixes: Array.isArray(audit.requiredFixes)
      ? audit.requiredFixes
      : Array.isArray(audit.required_fixes_json)
        ? audit.required_fixes_json
        : [],
    summary: audit.summary || '',
    createdAt: audit.created_at || '',
  };
}

function normalizeAttempt(rawAttempt) {
  const attempt = rawAttempt || {};
  return {
    id: attempt.id || '',
    attemptNo: toNumber(attempt.attempt_no),
    stage: attempt.stage || '',
    agentKind: attempt.agent_kind || '',
    status: attempt.status || '',
    tokens: toNumber(attempt.tokens, toNumber(attempt.tokens_in) + toNumber(attempt.tokens_out) + toNumber(attempt.tokens_cache)),
    costCny: toNumber(attempt.cost_cny),
    costSource: normalizeCostSourceKey(attempt.cost_source ?? attempt.costSource),
    costReported: flagOn(attempt.cost_reported ?? attempt.costReported),
    durationMs: toNumber(attempt.duration_ms),
    error: attempt.error || '',
    createdAt: attempt.created_at || '',
  };
}

function normalizeArtifact(rawArtifact) {
  const artifact = rawArtifact || {};
  return {
    id: artifact.id || '',
    kind: artifact.kind || '',
    path: artifact.path || '',
    bytes: toNumber(artifact.meta_json?.bytes ?? artifact.meta?.bytes),
    createdAt: artifact.created_at || '',
  };
}

function normalizeTask(rawTask) {
  const task = rawTask || {};
  const audits = (Array.isArray(task.audits) ? task.audits : []).map(normalizeAudit);
  return {
    ...task,
    seq: toNumber(task.seq),
    attempt: toNumber(task.attempt),
    maxAttempts: toNumber(task.max_attempts, 2),
    acceptance: Array.isArray(task.acceptance_json) ? task.acceptance_json : [],
    audits,
    attempts: Array.isArray(task.attempts) ? task.attempts.map(normalizeAttempt) : [],
    artifacts: Array.isArray(task.artifacts) ? task.artifacts.map(normalizeArtifact) : [],
  };
}

function normalizeRunDetail(rawDetail) {
  const detail = rawDetail || {};
  const rawTasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const ownTasks = rawTasks.filter((task) => !task.run_id || task.run_id === detail.id);
  const tasks = (ownTasks.length ? ownTasks : rawTasks)
    .map(normalizeTask)
    .sort((a, b) => a.seq - b.seq);
  return {
    ...detail,
    result_json: detail.result_json || {},
    spent_json: detail.spent_json || {},
    budget_json: detail.budget_json || {},
    project: detail.project && typeof detail.project === 'object' ? detail.project : null,
    approvals: normalizeApprovals(detail.approvals),
    actions: Array.isArray(detail.actions) ? detail.actions : [],
    events: Array.isArray(detail.events) ? detail.events : [],
    tasks,
  };
}

function deriveRunInfo(run) {
  const detail = run || {};
  const result = detail.result_json || {};
  const actions = Array.isArray(detail.actions) ? detail.actions : [];
  const publish = result.publish || {};
  const findAction = (type) => actions.find((action) => action.type === type) || null;
  const pushAction = findAction('github-push');
  const prAction = findAction('github-pr');
  const blockedAction = findAction('github-publish');
  const ciAction = findAction('github-ci');
  const planBranch =
    result.planBranch ||
    publish.planBranch ||
    pushAction?.payload_json?.planBranch ||
    blockedAction?.payload_json?.planBranch ||
    (detail.id ? `wb/plan-${String(detail.id).slice(-6)}` : '');
  const pr = publish.pr || prAction?.result_json?.pr || null;
  const blockedReasons = Array.isArray(publish.blocked) && publish.blocked.length
    ? publish.blocked
    : blockedAction?.result_json?.reason
      ? [blockedAction.result_json.reason]
      : [];
  const ci = ciAction
    ? {
        status: ciAction.status || '',
        conclusion: ciAction.result_json?.conclusion || '',
        runs: Array.isArray(ciAction.result_json?.runs) ? ciAction.result_json.runs : [],
        note: ciAction.result_json?.note || '',
        error: ciAction.result_json?.error || '',
      }
    : null;
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  const verificationStatus = verificationStatusOf(detail);
  const verification = verificationMetaOf(verificationStatus);
  const verifiedSha = verifiedShaOf(detail);
  const verifyCi = ciInfoOf(detail);
  const approvals = normalizeApprovals(detail.approvals);
  const pendingApprovalCount = approvals.filter((item) => item.status === 'pending').length;
  const costSource = costSourceOfRun(detail);
  const spent = {
    tokens: toNumber(detail.spent_json?.tokens),
    costCny: toNumber(detail.spent_json?.costCny),
  };
  return {
    result,
    publish,
    pushAction,
    prAction,
    blockedAction,
    ciAction,
    planBranch,
    pr,
    blockedReasons,
    ci,
    counts,
    acceptedAt: result.acceptedAt || '',
    verificationStatus,
    verification,
    verifiedSha,
    verifyCi,
    approvals,
    pendingApprovalCount,
    costSource,
    spent,
  };
}

function summarizeTaskCounts(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const counts = {};
  for (const task of list) counts[task.status] = (counts[task.status] || 0) + 1;
  const total = list.length;
  const passed = counts.passed || 0;
  const failed = (counts.failed || 0) + (counts.blocked || 0);
  const queued = counts.queued || 0;
  const active = list.filter((task) => !['queued', 'passed', 'failed', 'blocked'].includes(task.status)).length;
  return { counts, total, passed, failed, queued, active };
}

async function loadRunDetail(runId, options = {}) {
  const silent = !!options.silent;
  if (!runId) return false;
  const isSame = !!app.runDetail && app.runDetail.id === runId;
  if (!isSame) {
    app.runDetail = null;
    app.runDetailError = null;
    app.runDetailLoading = true;
    renderRunDetail();
  }
  try {
    const data = await apiRequest('GET', `/api/runs/${encodeURIComponent(runId)}`);
    if (!data || typeof data !== 'object') throw new ApiError('运行详情数据无效', 0, 'BAD_RUN_DETAIL');
    if (app.selectedRunId !== runId) return false;
    const detail = normalizeRunDetail(data);
    app.runDetail = detail;
    app.runDetailError = null;
    if (detail.project_id) app.selectedProjectId = detail.project_id;
    invalidateTaskCaches(detail.tasks);
    syncEventsForRun(detail);
    renderAll();
    if (app.scrollToRunAfterLoad) {
      app.scrollToRunAfterLoad = false;
      window.requestAnimationFrame(() => {
        if (dom.runDetailView && !dom.runDetailView.hidden) {
          dom.runDetailView.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
    return true;
  } catch (error) {
    if (app.selectedRunId !== runId) return false;
    app.runDetailError = error;
    if (!silent) toast(`加载运行详情失败：${error.message}`, 'error');
    app.scrollToRunAfterLoad = false;
    if (error.status === 404 && !currentProject()) {
      app.selectedRunId = null;
      app.runDetail = null;
      selectDefaultProject();
    }
    return false;
  } finally {
    if (app.selectedRunId === runId) {
      app.runDetailLoading = false;
      renderRunDetail();
    }
  }
}

function invalidateTaskCaches(tasks) {
  for (const task of tasks || []) {
    const cached = app.taskDetails.get(task.id);
    if (!cached) continue;
    if (cached.loading) continue;
    if (cached.taskUpdatedAt && cached.taskUpdatedAt !== task.updated_at) {
      app.taskDetails.delete(task.id);
    }
  }
}

function findTaskInDetail(taskId) {
  if (!app.runDetail) return null;
  return (app.runDetail.tasks || []).find((task) => task.id === taskId) || null;
}

async function ensureTaskDetail(taskId, options = {}) {
  const force = !!options.force;
  let entry = app.taskDetails.get(taskId);
  if (entry && entry.loading) return;
  if (entry && entry.data && !force) return;
  entry = entry || { data: null, error: null, loading: false, taskUpdatedAt: '' };
  entry.loading = true;
  entry.error = null;
  app.taskDetails.set(taskId, entry);
  try {
    const data = await apiRequest('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
    entry.data = data || {};
    const task = findTaskInDetail(taskId);
    entry.taskUpdatedAt = task?.updated_at || '';
    entry.error = null;
  } catch (error) {
    entry.error = error;
  } finally {
    entry.loading = false;
    app.taskDetails.set(taskId, entry);
    if (app.expandedTasks.has(taskId) && app.selectedRunId) renderTasks(app.runDetail);
  }
}

async function refreshAll(options = {}) {
  const silent = options.silent !== false;
  if (app.refreshInFlight) {
    app.refreshQueued = true;
    return false;
  }
  app.refreshInFlight = true;
  if (dom.refreshBtn) dom.refreshBtn.classList.add('is-spinning');
  let ok = true;
  try {
    const stateOk = await loadState({ silent });
    if (!stateOk) ok = false;
    const isolationOk = await loadIsolation({ silent });
    if (!isolationOk) ok = false;
    if (app.selectedRunId) {
      const detailOk = await loadRunDetail(app.selectedRunId, { silent });
      if (!detailOk && !app.runDetail) ok = false;
    }
    reconcileSelection();
    renderAll();
    if (!silent) {
      if (ok) toast('数据已刷新', 'success', { duration: 1600, force: true });
      else toast('刷新失败，请检查工作台服务状态', 'error');
    }
  } finally {
    app.refreshInFlight = false;
    if (dom.refreshBtn) dom.refreshBtn.classList.remove('is-spinning');
    if (app.refreshQueued) {
      app.refreshQueued = false;
      window.setTimeout(() => {
        refreshAll({ silent: true, reason: 'queued' });
      }, 120);
    }
  }
  return ok;
}

function scheduleRefresh(reason) {
  if (app.refreshTimer) window.clearTimeout(app.refreshTimer);
  app.refreshTimer = window.setTimeout(() => {
    app.refreshTimer = null;
    refreshAll({ silent: true, reason: reason || 'event' });
  }, REFRESH_DEBOUNCE_MS);
}

function reconcileSelection() {
  if (!app.state) return;
  const projects = app.state.projects || [];
  if (app.selectedProjectId && !projects.some((project) => project.id === app.selectedProjectId)) {
    if (app.selectedRunId) {
      const found = findRun(app.selectedRunId);
      if (found?.projectId) app.selectedProjectId = found.projectId;
      else {
        app.selectedProjectId = null;
        app.selectedRunId = null;
        app.runDetail = null;
      }
    } else {
      app.selectedProjectId = null;
    }
  }
  if (app.selectedProjectId) {
    const found = app.selectedRunId ? findRun(app.selectedRunId) : null;
    if (found?.projectId) app.selectedProjectId = found.projectId;
  }
}

// ============================================================
// SSE 实时流
// ============================================================
function normalizeEvent(rawEvent) {
  const raw = rawEvent || {};
  const idValue = Number(raw.id);
  return {
    id: Number.isFinite(idValue) ? idValue : -Date.now() - Math.random(),
    runId: raw.runId || raw.run_id || '',
    projectId: raw.projectId || raw.project_id || '',
    taskId: raw.taskId || raw.task_id || '',
    type: String(raw.type || 'event'),
    level: ['info', 'warn', 'error', 'debug'].includes(raw.level) ? raw.level : 'info',
    message: String(raw.message || ''),
    createdAt: raw.createdAt || raw.created_at || new Date().toISOString(),
  };
}

function setSseState(stateName) {
  app.sse.state = stateName;
  renderSseStatus();
}

function connectSSE() {
  if (!('EventSource' in window)) {
    setSseState('offline');
    return;
  }
  if (app.sse.source) {
    try {
      app.sse.source.close();
    } catch {
      /* ignore */
    }
    app.sse.source = null;
  }
  if (app.sse.retryTimer) {
    window.clearTimeout(app.sse.retryTimer);
    app.sse.retryTimer = null;
  }
  setSseState('connecting');
  let source;
  try {
    source = new EventSource('/api/stream');
  } catch {
    setSseState('offline');
    scheduleSseReconnect();
    return;
  }
  app.sse.source = source;
  source.addEventListener('hello', () => {
    const wasOffline = app.sse.wasOffline;
    app.sse.wasOffline = false;
    setSseState('online');
    if (wasOffline) {
      toast('实时连接已恢复', 'success', { duration: 2200 });
      scheduleRefresh('sse-reconnect');
    }
  });
  source.onopen = () => {
    const wasOffline = app.sse.wasOffline;
    app.sse.wasOffline = false;
    setSseState('online');
    if (wasOffline) scheduleRefresh('sse-open');
  };
  source.onerror = () => {
    app.sse.wasOffline = true;
    setSseState('offline');
    if (source.readyState === EventSource.CLOSED) scheduleSseReconnect();
  };
  source.onmessage = (message) => {
    if (!message.data) return;
    let raw;
    try {
      raw = JSON.parse(message.data);
    } catch {
      return;
    }
    handleStreamEvent(raw);
  };
}

function scheduleSseReconnect() {
  if (app.sse.retryTimer) return;
  app.sse.retryTimer = window.setTimeout(() => {
    app.sse.retryTimer = null;
    connectSSE();
  }, 5000);
}

function eventMatchesScope(event) {
  if (app.selectedRunId) return event.runId === app.selectedRunId || (!event.runId && !event.projectId);
  if (app.selectedProjectId) {
    if (event.projectId) {
      return event.projectId === app.selectedProjectId || event.projectId === 'pending';
    }
    if (event.runId) return runBelongsToProject(event.runId, app.selectedProjectId);
    return true;
  }
  return true;
}

function handleStreamEvent(rawEvent) {
  const event = normalizeEvent(rawEvent);
  if (event.taskId && app.expandedTasks.has(event.taskId)) {
    const cached = app.taskDetails.get(event.taskId);
    if (cached && !cached.loading) app.taskDetails.delete(event.taskId);
  }
  if (eventMatchesScope(event)) appendEvents([event]);
  scheduleRefresh('sse');
}

// ============================================================
// 事件列表（内存中最近 300 条）
// ============================================================
function eventScopeKey() {
  if (app.selectedRunId) return `run:${app.selectedRunId}`;
  if (app.selectedProjectId) return `project:${app.selectedProjectId}`;
  return 'global';
}

function resetEventScope(hint) {
  app.eventScopeKey = eventScopeKey();
  app.events = [];
  app.eventIds.clear();
  app.eventFloor = 0;
  if (dom.eventLog) {
    clearNode(dom.eventLog);
    if (hint) dom.eventLog.append(buildEventEmpty(hint));
  }
  updateEventFooter();
}

function buildEventEmpty(message) {
  return el('div', { className: 'event-empty' }, [
    el('span', { className: 'event-empty-icon', text: '≋' }),
    el('span', { text: '' }, [el('strong', { text: '等待实时事件' })]),
    el('span', { text: message || '启动自动开发或选择一次运行后，事件会实时滚动在这里。' }),
  ]);
}

function mergeEvents(events) {
  const added = [];
  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    if (app.eventIds.has(event.id)) continue;
    app.eventIds.add(event.id);
    app.events.push(event);
    added.push(event);
  }
  if (added.length) {
    app.events.sort((a, b) => a.id - b.id);
    if (app.events.length > MAX_EVENTS) {
      const removed = app.events.splice(0, app.events.length - MAX_EVENTS);
      for (const event of removed) app.eventIds.delete(event.id);
    }
  }
  return added;
}

function appendEvents(rawEvents) {
  const added = mergeEvents(rawEvents || []);
  if (!added.length) return;
  const empty = dom.eventLog.querySelector('.event-empty');
  if (empty) empty.remove();
  for (const event of added) dom.eventLog.append(buildEventRow(event));
  while (dom.eventLog.childElementCount > MAX_EVENTS) dom.eventLog.firstElementChild.remove();
  updateEventFooter();
  if (app.eventAutoScroll) scrollEventsToBottom(true);
}

function syncEventsForRun(run) {
  const key = `run:${run.id}`;
  const scopeChanged = app.eventScopeKey !== key;
  if (scopeChanged) {
    app.eventScopeKey = key;
    app.events = [];
    app.eventIds.clear();
    app.eventFloor = 0;
    clearNode(dom.eventLog);
  }
  const visibleEvents = (run.events || []).filter((event) => toNumber(event?.id) > app.eventFloor);
  const added = mergeEvents(visibleEvents);
  if (scopeChanged) {
    renderEventLog();
  } else if (added.length) {
    const empty = dom.eventLog.querySelector('.event-empty');
    if (empty) empty.remove();
    for (const event of added) dom.eventLog.append(buildEventRow(event));
    while (dom.eventLog.childElementCount > MAX_EVENTS) dom.eventLog.firstElementChild.remove();
    updateEventFooter();
    if (app.eventAutoScroll) scrollEventsToBottom(true);
  }
  if (!app.events.length) {
    clearNode(dom.eventLog);
    dom.eventLog.append(buildEventEmpty('该运行尚无事件记录，执行开始后会实时追加。'));
  }
  updateEventFooter();
}

function eventTypeMeta(type) {
  const key = String(type || '');
  if (EVENT_TYPE_META[key]) return EVENT_TYPE_META[key];
  if (/(passed|accepted|created|pr_created|branch_pushed)/.test(key)) {
    return { icon: '✓', tone: 'green', rowClass: 'type-passed', label: '通过' };
  }
  if (/(failed|error|blocked|cancelled|violation)/.test(key)) {
    return { icon: '!', tone: 'red', rowClass: 'type-failed', label: '异常' };
  }
  return null;
}

function buildEventRow(event) {
  const meta = eventTypeMeta(event.type);
  const row = el('div', {
    className: `event-row level-${event.level}${meta?.rowClass ? ` ${meta.rowClass}` : ''}`,
  });
  const typeSuffix = event.taskId ? ` · ${shortId(event.taskId, 12)}` : '';
  const marker = meta?.icon
    ? el('span', {
        className: `event-icon tone-${meta.tone || 'gray'}`,
        text: meta.icon,
        title: meta.label ? `${meta.label}（${event.type}）` : event.type,
      })
    : el('span', { className: 'event-dot' });
  row.append(
    el('span', { className: 'event-time', text: fmtClock(event.createdAt), title: fmtDateTimeFull(event.createdAt) }),
    marker,
    el('div', { className: 'event-main' }, [
      el('span', { className: 'event-message', text: event.message || event.type }),
      el('span', { className: 'event-type', text: `${event.type}${typeSuffix}`, title: `${event.type}\n${fmtDateTimeFull(event.createdAt)}` }),
    ]),
  );
  return row;
}

function renderEventLog() {
  if (!dom.eventLog) return;
  clearNode(dom.eventLog);
  if (!app.events.length) {
    let message = '启动自动开发或选择一次运行后，事件会实时滚动在这里。';
    if (app.selectedRunId && app.runDetailLoading) message = '正在加载该运行的历史事件…';
    else if (app.selectedRunId) message = '该运行尚无事件记录，执行开始后会实时追加。';
    else if (app.selectedProjectId) message = '打开最近运行可回看历史事件，新事件会实时追加。';
    dom.eventLog.append(buildEventEmpty(message));
    updateEventFooter();
    return;
  }
  for (const event of app.events) dom.eventLog.append(buildEventRow(event));
  updateEventFooter();
  scrollEventsToBottom(false);
}

function scrollEventsToBottom(force) {
  if (!dom.eventLog) return;
  if (!app.eventAutoScroll && !force) return;
  const apply = () => {
    dom.eventLog.scrollTop = dom.eventLog.scrollHeight;
  };
  apply();
  window.requestAnimationFrame(apply);
}

function updateEventFooter() {
  if (dom.eventCount) {
    dom.eventCount.textContent = `${app.events.length} 条 · 最多保留 ${MAX_EVENTS} 条`;
  }
}

function renderEventsChrome() {
  if (!dom.eventsScope) return;
  if (app.selectedRunId) {
    dom.eventsScope.textContent = `当前运行 · ${shortId(app.selectedRunId, 16)}`;
  } else if (app.selectedProjectId) {
    const project = currentProject();
    dom.eventsScope.textContent = project ? `项目「${project.name}」实时事件` : '项目实时事件';
  } else {
    dom.eventsScope.textContent = '全局实时事件';
  }
  renderSseStatus();
  updateEventFooter();
  updateSseMini();
}

function updateSseMini() {
  if (!dom.sseMini) return;
  const stateName = app.sse.state;
  dom.sseMini.classList.toggle('is-offline', stateName !== 'online');
  dom.sseMiniLabel.textContent = stateName === 'online' ? '实时已连接' : stateName === 'connecting' ? '连接中' : '已断开 · 轮询兜底';
  if (dom.sseMiniDot) {
    dom.sseMiniDot.className = 'status-dot';
    if (stateName === 'online') dom.sseMiniDot.classList.add('tone-green');
    else if (stateName === 'connecting') dom.sseMiniDot.classList.add('tone-amber');
  }
}

function renderSseStatus() {
  if (!dom.ssePill) return;
  const stateName = app.sse.state;
  const meta =
    stateName === 'online'
      ? { label: '实时已连接', tone: 'green', title: 'EventSource 已连接：GET /api/stream' }
      : stateName === 'connecting'
        ? { label: '实时连接中', tone: 'amber', title: '正在连接 GET /api/stream' }
        : { label: '实时已断开', tone: 'gray', title: 'EventSource 已断开，每 5 秒轮询 /api/state 兜底；将自动重连' };
  const label = dom.sseLabel;
  if (label) label.textContent = meta.label;
  setToneClass(dom.ssePill, meta.tone);
  dom.ssePill.classList.toggle('is-offline', stateName !== 'online');
  dom.ssePill.title = meta.title;
  updateSseMini();
}

// ============================================================
// 顶栏渲染
// ============================================================
function renderTopbar() {
  const state = app.state;
  dom.versionText.textContent = state?.version ? `v${state.version}` : 'v—';
  renderBudget(state?.budget);
  renderAuditPill(state?.audit);
  renderAgentPills(state?.agents);
  renderGithubPill(state?.github);
  renderApprovalsButton(state);
  renderSseStatus();
}

function renderApprovalsButton() {
  if (!dom.approvalsBtn) return;
  const count = pendingApprovals().length;
  dom.approvalsBtn.classList.toggle('has-items', count > 0);
  dom.approvalsBtn.setAttribute('aria-label', count ? `打开审批中心，${count} 项待审批` : '打开审批中心');
  dom.approvalsBtn.title = count
    ? `审批中心 · ${count} 项待处理（批准不会自动合并主分支或部署）`
    : '审批中心 · 暂无待审批项（批准不会自动合并主分支或部署）';
  if (!dom.approvalsCount) return;
  dom.approvalsCount.hidden = count <= 0;
  dom.approvalsCount.textContent = count > 99 ? '99+' : String(count);
}

function renderBudget(budget) {
  const data = budget || {};
  if (!app.state) {
    if (dom.budgetTokensValue) dom.budgetTokensValue.textContent = '—';
    if (dom.budgetGlmValue) dom.budgetGlmValue.textContent = '—';
    if (dom.budgetCostValue) dom.budgetCostValue.textContent = '—';
    if (dom.budgetTokensBar) dom.budgetTokensBar.style.width = '0%';
    if (dom.budgetCostBar) dom.budgetCostBar.style.width = '0%';
    if (dom.budgetWidget) {
      dom.budgetWidget.classList.remove('is-warning', 'is-danger');
      dom.budgetWidget.title = '正在加载全局预算…';
    }
    return;
  }
  const maxTokens = toNumber(data.maxTokens);
  const usedTokens = toNumber(data.usedTokens, toNumber(data.breakdown?.tokens));
  const budgetUsed = toNumber(data.usedBudgetTokens, usedTokens);
  const maxCost = toNumber(data.maxCostCny);
  const usedCost = toNumber(data.usedCostCny, toNumber(data.breakdown?.costCny));
  const tokensPercent = Number.isFinite(Number(data.tokensPercent))
    ? Number(data.tokensPercent)
    : maxTokens
      ? (usedTokens / maxTokens) * 100
      : 0;
  const costPercent = Number.isFinite(Number(data.costPercent))
    ? Number(data.costPercent)
    : maxCost
      ? (usedCost / maxCost) * 100
      : 0;

  if (dom.budgetTokensValue) {
    dom.budgetTokensValue.textContent = `${fmtTokens(budgetUsed)} / ${fmtTokens(maxTokens)} · ${fmtPercent(tokensPercent)}`;
    dom.budgetTokensValue.title = `预算折算已用 ${fmtTokens(budgetUsed)} / 上限 ${fmtTokens(maxTokens)} tokens；原始用量 ${fmtTokens(usedTokens)}（缓存读取按 ${data.cacheTokenWeight ?? 0.1} 折算）`;
  }
  if (dom.budgetGlmValue) {
    const glm = data.glm || {};
    dom.budgetGlmValue.textContent = `${fmtTokens(toNumber(glm.tokens))} · ${fmtCostCny(toNumber(glm.costCny), maxCost)}（不受预算）`;
    dom.budgetGlmValue.title = `GLM 真实用量：输入 ${fmtTokens(toNumber(glm.tokensIn))} · 输出 ${fmtTokens(toNumber(glm.tokensOut))} · 缓存 ${fmtTokens(toNumber(glm.tokensCache))}；真实费用 ${fmtCostCny(toNumber(glm.costCny), maxCost)}；不计入工作台 token/费用上限`;
  }
  if (dom.budgetCostValue) {
    dom.budgetCostValue.textContent = `${fmtCostCny(usedCost, maxCost)} / ¥${fmtCost(maxCost)} · ${fmtPercent(costPercent)}`;
    dom.budgetCostValue.title = `估算已用 ${fmtCostCny(usedCost)} / 上限 ¥${fmtCost(maxCost)}`;
  }
  if (dom.budgetTokensBar) dom.budgetTokensBar.style.width = `${Math.max(0, Math.min(100, tokensPercent))}%`;
  if (dom.budgetCostBar) dom.budgetCostBar.style.width = `${Math.max(0, Math.min(100, costPercent))}%`;
  if (dom.budgetWidget) {
    const worst = Math.max(tokensPercent, costPercent);
    dom.budgetWidget.classList.toggle('is-warning', worst >= 80 && worst < 95);
    dom.budgetWidget.classList.toggle('is-danger', worst >= 95);
    const breakdown = data.breakdown || {};
    dom.budgetWidget.title = [
      '全局预算消耗（所有运行累计）',
      `预算折算 tokens：${fmtTokens(budgetUsed)} / ${fmtTokens(maxTokens)}`,
      `原始 tokens：${fmtTokens(usedTokens)}（缓存按 ${data.cacheTokenWeight ?? 0.1} 折算）`,
      `tokens 明细：输入 ${fmtTokens(breakdown.tokensIn)} · 输出 ${fmtTokens(breakdown.tokensOut)} · 缓存 ${fmtTokens(breakdown.tokensCache)}`,
      `成本：${fmtCostCny(usedCost)} / ¥${fmtCost(maxCost)}`,
      `剩余：${fmtTokens(data.remainingTokens)} tokens · ¥${fmtCost(data.remainingCostCny)}`,
      '费用来源：以各运行 attempts 记录为准（厂商返回 / 估算 / UNKNOWN 混合累计）',
    ].join('\n');
  }
}

function renderAuditPill(audit) {
  const data = audit || {};
  let label = '独立审计未配置';
  let tone = 'gray';
  let detail = data.note || '';
  if (data.gptConfigured) {
    label = 'GPT 独立审计';
    tone = 'green';
  } else if (data.glmConfigured) {
    label = 'GLM 独立审计（GPT 待配置）';
    tone = 'cyan';
  } else if (data.deepseekConfigured) {
    label = 'DeepSeek 独立审计（降级）';
    tone = 'amber';
  } else if (app.state) {
    label = '审计模型不可用';
    tone = 'red';
  } else {
    label = '独立审计';
    tone = 'gray';
  }
  if (data.active && data.active.label) {
    detail = [detail, `当前审计提供方：${data.active.label}${data.active.model ? ` / ${data.active.model}` : ''}`]
      .filter(Boolean)
      .join('\n');
  }
  dom.auditLabel.textContent = label;
  dom.auditPill.title = detail || label;
  setToneClass(dom.auditPill, tone);
  dom.auditPill.classList.add('tone-audit');
}

function renderAgentPills(agents) {
  if (!dom.agentPills) return;
  clearNode(dom.agentPills);
  const list = Array.isArray(agents) ? agents : [];
  const defaults = [
    { id: 'dsh', label: 'DeepSeek Harness' },
    { id: 'claude', label: 'Claude Code' },
  ];
  for (const item of defaults) {
    const found = list.find((agent) => agent.id === item.id);
    const ok = !!found?.ok;
    const pill = el(
      'span',
      {
        className: `status-pill ${ok ? 'tone-green' : 'tone-gray'}${ok ? '' : ' is-offline'}`,
        title: found
          ? `${found.label || item.label}：${ok ? '可用' : '不可用'}${found.detail ? `（${found.detail}）` : ''}`
          : `${item.label}：状态未知`,
        attrs: { role: 'status' },
      },
      [el('span', { className: 'status-dot' }), el('span', { className: 'status-label', text: found?.label || item.label })],
    );
    dom.agentPills.append(pill);
  }
}

function renderGithubPill(github) {
  const data = github || {};
  let label = 'GitHub 未连接';
  let tone = 'amber';
  let title = '尚未获取 GitHub 状态';
  if (!app.state) {
    label = 'GitHub';
    tone = 'gray';
  } else if (data.configured) {
    label = 'GitHub 已连接';
    tone = 'green';
    title = `GitHub Token 已配置${data.owner ? ` · 所有者 ${data.owner}` : ''}`;
  } else {
    label = 'GitHub 未连接';
    tone = 'gray';
    title = data.note || '未配置 GITHUB_TOKEN，Push / PR / CI 会记录为待授权';
  }
  dom.githubLabel.textContent = label;
  dom.githubPill.title = title;
  setToneClass(dom.githubPill, tone);
  dom.githubPill.classList.toggle('is-offline', !data.configured);
}

// ============================================================
// 左侧栏渲染
// ============================================================
function renderSidebar() {
  if (!dom.projectList) return;
  const state = app.state;
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  dom.projectCount.textContent = !state ? (app.stateError ? '加载失败' : '加载中…') : `${projects.length} 个项目`;
  clearNode(dom.projectList);

  if (!state && app.stateError) {
    dom.projectList.append(
      buildSidebarError(app.stateError, () => refreshAll({ silent: false, reason: 'retry' })),
    );
  } else if (!projects.length) {
    dom.projectList.append(
      el('div', { className: 'project-empty' }, [
        el('p', { text: state ? '还没有项目，先添加一个开始。' : '正在加载项目列表…' }),
        state
          ? el('button', {
              className: 'button button-primary button-sm',
              text: '+ 添加项目',
              attrs: { type: 'button' },
              on: { click: () => openAddProjectModal() },
            })
          : el('div', { className: 'skeleton skeleton-project' }),
      ]),
    );
  } else {
    for (const project of projects) dom.projectList.append(buildProjectItem(project));
  }

  dom.sidebarHint.textContent = projects.length
    ? '选择项目可发起新的自动开发；运行列表与详情在右侧主区。'
    : '添加项目后，即可输入目标并启动自动开发。';
  renderMiniPanel();
}

function buildSidebarError(error, retry) {
  const authFailed = error && error.status === 401;
  const forbidden = error && error.status === 403;
  const children = [
    el('p', { text: `项目列表加载失败：${error.message}` }),
  ];
  if (authFailed) {
    children.push(el('p', { className: 'project-empty-hint', text: '会话 Cookie 缺失或已失效：刷新页面后服务器会重新写入 HttpOnly Cookie。' }));
  } else if (forbidden) {
    children.push(el('p', { className: 'project-empty-hint', text: '请求被安全策略拒绝（Host / Origin / CSRF / 限流）；请确认通过 http://127.0.0.1:4477 访问。' }));
  }
  children.push(
    el('button', {
      className: 'button button-ghost button-sm',
      text: authFailed || forbidden ? '刷新页面' : '重试',
      attrs: { type: 'button' },
      on: {
        click: authFailed || forbidden ? () => window.location.reload() : retry,
      },
    }),
  );
  return el('div', { className: 'project-empty' }, children);
}

function agentShortLabel(kind) {
  const key = String(kind || 'auto').toLowerCase();
  if (key === 'dsh') return 'DSH';
  if (key === 'claude') return 'Claude';
  if (key === 'custom') return '自定义';
  return '自动';
}

function auditProviderDisplay(provider) {
  const key = String(provider || 'auto').toLowerCase();
  if (key === 'auto') {
    const active = app.state?.audit?.active;
    if (active?.label) return `自动 · ${active.label}${active.model ? ` / ${active.model}` : ''}`;
    return '自动（未配置）';
  }
  return AUDIT_PROVIDER_LABELS[key] || provider || '—';
}

function auditProviderShort(provider) {
  const key = String(provider || 'auto').toLowerCase();
  if (key === 'auto') {
    const active = app.state?.audit?.active;
    return active?.label ? `自动·${active.label}` : '自动';
  }
  return AUDIT_PROVIDER_LABELS[key] || key.toUpperCase();
}

function projectCiRequired(project) {
  return !flagOff(project?.ci_required);
}

function projectRemoteAuthorized(project) {
  return flagOn(project?.remote_push_authorized);
}

function projectAllowLocalAcceptance(project) {
  return !flagOff(project?.allow_local_acceptance);
}

function budgetSummaryOf(project) {
  const budget = project?.budget_json && typeof project.budget_json === 'object' ? project.budget_json : {};
  const tokens = toNumber(budget.max_tokens_per_run);
  const cost = toNumber(budget.max_cost_cny_per_run);
  const attempts = toNumber(budget.max_attempts);
  const wallClock = toNumber(budget.max_wall_clock_ms);
  const parts = [];
  if (tokens > 0) parts.push(`${fmtTokens(tokens)} tokens/次`);
  if (cost > 0) parts.push(`¥${fmtCost(cost)}/次`);
  if (attempts > 0) parts.push(`最多 ${attempts} 次尝试`);
  if (wallClock > 0) parts.push(`时长 ${fmtDurationMs(wallClock)}`);
  if (!parts.length) {
    return { text: '预算跟随全局', title: '项目未设置独立预算：使用全局 tokens / 成本上限与默认尝试次数' };
  }
  return { text: parts.join(' · '), title: `项目预算（单次运行上限）：${parts.join('，')}` };
}

function shortBudgetText(project) {
  const budget = project?.budget_json && typeof project.budget_json === 'object' ? project.budget_json : {};
  const tokens = toNumber(budget.max_tokens_per_run);
  const cost = toNumber(budget.max_cost_cny_per_run);
  if (tokens > 0 && cost > 0) return `预算 ${fmtTokens(tokens)} / ¥${fmtCost(cost)}`;
  if (tokens > 0) return `预算 ${fmtTokens(tokens)} tok`;
  if (cost > 0) return `预算 ¥${fmtCost(cost)}`;
  return '预算跟随全局';
}

function projectTag(label, options = {}) {
  return el('span', {
    className: `project-tag${options.tone ? ` tone-${options.tone}` : ''}`,
    title: options.title || label,
    text: label,
  });
}

function verificationBadge(status, options = {}) {
  const meta = verificationMetaOf(status?.code || status);
  const title = [`验证状态：${meta.code}`, meta.label, meta.note, options.title].filter(Boolean).join('\n');
  return el(
    'span',
    {
      className: `verify-badge tone-${meta.tone}${options.small ? ' is-small' : ''}`,
      title,
    },
    [
      el('span', { className: 'verify-badge-code', text: meta.code }),
      options.showLabel === false ? null : el('span', { className: 'verify-badge-label', text: meta.label }),
    ],
  );
}

function buildProjectItem(project) {
  const selected = project.id === app.selectedProjectId;
  const latestRun = project.latestRun || null;
  const latestNode = latestRun
    ? runBadge(latestRun.status)
    : el('span', { className: 'chip tone-gray', text: '未运行' });
  const verifyStatus = latestRun ? verificationStatusOf(latestRun) : '';
  const verifySha = latestRun ? verifiedShaOf(latestRun) : '';
  const verifyNode = verifyStatus
    ? verificationBadge(verifyStatus, {
        showLabel: false,
        small: true,
        title: [
          verifySha ? `验证 commit ${fmtShortSha(verifySha, 10)}` : '',
          latestRun.status === 'awaiting_acceptance' ? '运行状态：AWAITING_ACCEPTANCE（等待人工验收）' : '',
        ]
          .filter(Boolean)
          .join('\n') || undefined,
      })
    : null;
  const budget = budgetSummaryOf(project);
  const ciRequired = projectCiRequired(project);
  const remoteAuthorized = projectRemoteAuthorized(project);
  const allowLocal = projectAllowLocalAcceptance(project);
  const contractCount = Array.isArray(project.contract_files) ? project.contract_files.length : 0;
  const tags = el('span', { className: 'project-tags' }, [
    verifyNode,
    latestRun && latestRun.status === 'awaiting_acceptance'
      ? projectTag('待验收', { tone: 'cyan', title: '运行状态：awaiting_acceptance（等待人工验收）' })
      : null,
    projectTag(`Agent ${agentShortLabel(project.agent_kind)}`, {
      title: `默认 Agent：${agentLabel(project.agent_kind)}`,
    }),
    projectTag(`审计 ${auditProviderShort(project.audit_provider)}`, {
      title: `独立审计模型：${auditProviderDisplay(project.audit_provider)}`,
    }),
    projectTag(shortBudgetText(project), { tone: 'blue', title: budget.title }),
    projectTag(ciRequired ? 'CI 必需' : 'CI 非必需', {
      tone: ciRequired ? 'blue' : 'gray',
      title: ciRequired
        ? '项目要求远端 CI（ci_required=true）；远端交付需要 CI_PASSED 才能验收'
        : '项目不要求远端 CI（ci_required=false）',
    }),
    projectTag(remoteAuthorized ? '远端已授权' : '远端未授权', {
      tone: remoteAuthorized ? 'cyan' : 'amber',
      title: remoteAuthorized
        ? '项目已授权远端推送（remote_push_authorized=true），运行完成后可推送计划分支并创建 PR'
        : '项目未授权远端推送（remote_push_authorized=false）：运行只在本地保留计划分支，不会推送或创建 PR',
    }),
    allowLocal ? null : projectTag('本地验收禁用', { tone: 'amber', title: '项目不允许本地验收（allow_local_acceptance=false）' }),
    contractCount ? projectTag(`契约 ${contractCount} 文件`, { title: (project.contract_files || []).join('\n') }) : null,
  ]);
  const item = el(
    'button',
    {
      className: `project-item${selected ? ' is-selected' : ''}`,
      attrs: { type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
      title: [
        project.name,
        project.local_path || project.repo_url || '',
        project.test_command || '未配置测试命令',
        `默认 Agent：${agentLabel(project.agent_kind)} · 审计：${auditProviderDisplay(project.audit_provider)}`,
        `项目预算：${budget.text}`,
        ciRequired ? '要求远端 CI' : '不要求远端 CI',
        remoteAuthorized ? '已授权远端推送' : '未授权远端推送（不会推送/创建 PR）',
        allowLocal ? '允许本地验收（需显式确认）' : '不允许本地验收',
        latestRun ? `最近运行验证状态：${verificationMetaOf(verifyStatus).code}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      on: { click: () => selectProject(project.id) },
    },
    [
      el('span', { className: 'project-item-top' }, [
        el('span', { className: 'project-name', text: project.name || '未命名项目' }),
        el('span', { className: 'project-latest' }, [latestNode]),
      ]),
      el('span', { className: 'project-meta-line' }, [
        el('span', { className: 'project-branch', text: project.default_branch || 'main', title: '默认分支' }),
        el('span', {
          className: 'project-test',
          text: project.test_command || '未配置测试命令',
          title: project.test_command || '未配置测试命令',
        }),
        el('span', {
          className: 'project-updated',
          text: latestRun ? fmtRelative(latestRun.created_at || latestRun.updated_at) : fmtRelative(project.created_at),
          title: latestRun ? `最近运行：${fmtDateTime(latestRun.created_at)}` : `创建于 ${fmtDateTimeFull(project.created_at)}`,
        }),
      ]),
      tags,
    ],
  );
  return item;
}

function renderMiniPanel() {
  const state = app.state;
  const activeCount = Array.isArray(state?.activeRunIds) ? state.activeRunIds.length : 0;
  const slots = state?.agentSlots || null;
  const passed = toNumber(state?.taskStatusCounts?.passed);
  dom.miniActiveRuns.textContent = state ? String(activeCount) : '—';
  dom.miniAgentSlots.textContent = slots ? `${slots.active} / ${slots.limit}` : '—';
  dom.miniTaskPassed.textContent = state ? String(passed) : '—';
  if (slots) dom.miniAgentSlots.title = `执行中 ${slots.active} · 排队 ${slots.queued} · 并发上限 ${slots.limit}`;
  const policy = state?.policy;
  if (policy) {
    const parts = [];
    parts.push(policy.neverMerge ? '不自动合并主分支' : '允许合并（策略关闭）');
    parts.push(`单任务最多 ${toNumber(policy.maxAttempts, 2)} 次尝试`);
    if (Array.isArray(policy.protectedPaths) && policy.protectedPaths.length) parts.push('测试与验收目录受保护');
    dom.miniPolicyNote.textContent = `策略：${parts.join(' · ')}。`;
  } else {
    dom.miniPolicyNote.textContent = '工作台只创建 PR 供人工验收，从不合并主分支。';
  }
}

// ============================================================
// 主区渲染
// ============================================================
async function loadIsolation({ silent = true } = {}) {
  try {
    app.isolation = await apiRequest('GET', '/api/isolation');
    app.isolationError = null;
    return true;
  } catch (err) {
    app.isolationError = err;
    if (!silent) toast(`执行隔离状态加载失败：${err?.message || err}`, 'warn');
    return false;
  }
}

function renderIsolation() {
  if (!dom.isolationPill) return;
  const info = app.isolation;
  let tone = 'gray';
  let label = '隔离未知';
  let title = '尚未获取执行隔离状态';
  if (info) {
    const container = info.container || {};
    const kernel = info.kernelIsolation || 'BLOCKED';
    if (container.testExecution) {
      tone = 'green';
      label = container.agentExecution ? '容器隔离就绪' : '容器测试就绪';
      title = `Docker 容器可用；测试=${container.network?.test || 'none'}；Agent=${container.network?.agent || '未启用'}；镜像=${container.image?.name || 'unknown'}`;
    } else if (info.kernelAvailable) {
      tone = 'green';
      label = '沙箱隔离就绪';
      title = `内核级隔离=${kernel}`;
    } else {
      tone = 'amber';
      label = '受限运行环境';
      title = `内核级隔离=${kernel}；${info.note || 'Docker/sandbox 不可用，使用受限运行环境（不冒充强隔离）'}`;
    }
    if (app.isolationError) {
      tone = 'amber';
      label = '隔离状态降级';
      title = `最近一次加载失败：${app.isolationError.message || app.isolationError}`;
    }
  } else if (app.isolationError) {
    tone = 'red';
    label = '隔离状态错误';
    title = app.isolationError.message || String(app.isolationError);
  }
  setToneClass(dom.isolationPill, tone);
  if (dom.isolationLabel) dom.isolationLabel.textContent = label;
  dom.isolationPill.title = title;
}

function renderAll() {
  renderTopbar();
  renderIsolation();
  renderSidebar();
  renderWorkspace();
  renderStatusPanel();
  renderEventsChrome();
  syncApprovalsModal(false);
}

function renderWelcomeStats() {
  const state = app.state;
  dom.statProjects.textContent = state ? String((state.projects || []).length) : '—';
  dom.statRuns.textContent = state ? String((state.runs || []).length) : '—';
  dom.statActive.textContent = state ? String((state.activeRunIds || []).length) : '—';
  dom.statAudit.textContent = state ? state.audit?.active?.label || '未配置' : '—';
}

function renderWorkspace() {
  if (!dom.welcomeView) return;
  if (app.insightView) {
    document.body.classList.add('insight-mode');
    dom.welcomeView.hidden = true;
    dom.projectView.hidden = true;
    dom.insightView.hidden = false;
    renderInsight();
    return;
  }
  stopInsight();
  dom.insightView.hidden = true;
  const project = currentProject();
  const showWelcome = !project;
  dom.welcomeView.hidden = !showWelcome;
  dom.projectView.hidden = showWelcome;
  renderWelcomeStats();
  if (showWelcome) return;
  renderProjectHeader(project);
  syncGoalForm(project);
  renderRuns(project);
  renderLoops();
  if (app.selectedRunId) {
    dom.runDetailView.hidden = false;
    renderRunDetail();
  } else {
    dom.runDetailView.hidden = true;
    hideRunPanels();
  }
}

function projectInitial(name) {
  const text = String(name || '').trim();
  if (!text) return '项';
  return text.slice(0, 1).toUpperCase();
}

function factNode(label, value, options = {}) {
  const children = [el('span', { className: 'fact-dot' })];
  if (label) children.push(el('span', { text: `${label} ` }));
  if (value) children.push(el('span', { className: options.mono ? 'mono' : '', text: value }));
  return el('span', {
    className: `fact${options.tone ? ` tone-${options.tone}` : ''}`,
    title: options.title || `${label || ''}${value || ''}`,
  }, children);
}

function renderProjectHeader(project) {
  clearNode(dom.projectHeader);
  const actions = el('div', { className: 'project-header-actions' });
  const repoUrl = safeHttpUrl(project.repo_url);
  if (repoUrl) {
    actions.append(
      el('a', {
        className: 'button button-ghost button-sm',
        text: '打开仓库 ↗',
        attrs: { href: repoUrl, target: '_blank', rel: 'noopener noreferrer' },
      }),
    );
  }
  actions.append(
    el('button', {
      className: 'button button-ghost button-sm',
      text: '复制路径',
      attrs: { type: 'button' },
      on: { click: () => copyWithToast(project.local_path || '', '项目路径已复制') },
    }),
  );

  const headerTop = el('div', { className: 'project-header-top' }, [
    el('div', { className: 'project-identity' }, [
      el('div', { className: 'project-avatar', text: projectInitial(project.name) }),
      el('div', { className: 'project-titles' }, [
        el('h1', { className: 'project-title', text: project.name || '未命名项目' }),
        el('span', {
          className: 'project-path',
          text: project.local_path || project.repo_url || '未记录本地路径',
          title: project.repo_url ? `仓库：${project.repo_url}` : project.local_path || '',
        }),
      ]),
    ]),
    actions,
  ]);

  const latestRun = project.latestRun || null;
  const verifyStatus = latestRun ? verificationStatusOf(latestRun) : '';
  const budget = budgetSummaryOf(project);
  const ciRequired = projectCiRequired(project);
  const remoteAuthorized = projectRemoteAuthorized(project);
  const allowLocal = projectAllowLocalAcceptance(project);
  const contractFiles = Array.isArray(project.contract_files) ? project.contract_files : [];
  const latestCostSource = latestRun ? costSourceOfRun(latestRun) : null;

  const facts = el('div', { className: 'project-facts' }, [
    factNode('分支', project.default_branch || 'main', { mono: true }),
    factNode('测试命令', project.test_command || '未配置', {
      mono: !!project.test_command,
      tone: project.test_command ? '' : 'amber',
      title: project.test_command ? `测试命令：${project.test_command}` : '未配置测试命令，任务将无法通过测试门禁',
    }),
    factNode('语言', project.language || 'unknown'),
    factNode('默认 Agent', agentLabel(project.agent_kind)),
    factNode('受保护路径', `${(project.protected_paths || []).length} 条规则`, {
      tone: (project.protected_paths || []).length ? 'cyan' : '',
      title: (project.protected_paths || []).join('\n') || '未配置受保护路径',
    }),
    factNode('创建于', fmtRelative(project.created_at), { title: fmtDateTimeFull(project.created_at) }),
  ]);

  const v2Facts = el('div', { className: 'project-facts project-facts-v2' }, [
    factNode('审计模型', auditProviderDisplay(project.audit_provider), {
      tone: 'purple',
      title: '项目级独立审计提供方（auto 表示跟随全局可用模型）',
    }),
    factNode('项目预算', budget.text, { tone: 'blue', title: budget.title }),
    factNode(ciRequired ? 'CI 要求 · 必需' : 'CI 要求 · 非必需', ciRequired ? '远端交付需 CI_PASSED' : '本地验证即可交付', {
      tone: ciRequired ? 'cyan' : 'gray',
      title: ciRequired
        ? 'ci_required=true：远端交付必须 GitHub Actions 通过并绑定 commit'
        : 'ci_required=false：项目不要求远端 CI，可按本地验证交付',
    }),
    factNode(remoteAuthorized ? '远端已授权' : '远端未授权', remoteAuthorized ? '可推送并创建 PR' : '仅本地计划分支', {
      tone: remoteAuthorized ? 'cyan' : 'amber',
      title: remoteAuthorized
        ? 'remote_push_authorized=true：运行完成后可推送计划分支、创建草稿 PR 并轮询 CI'
        : 'remote_push_authorized=false：不会推送远端、不会创建 PR',
    }),
    factNode('本地验收', allowLocal ? '允许（需显式确认）' : '禁止', {
      tone: allowLocal ? '' : 'amber',
      title: allowLocal
        ? 'allow_local_acceptance=true：LOCAL_VERIFIED 时可用 confirmLocalOnly 显式确认本地验收'
        : 'allow_local_acceptance=false：仅允许 CI_PASSED 后验收',
    }),
    verifyStatus
      ? factNode('最新验证', verificationMetaOf(verifyStatus).code, {
          tone: verificationMetaOf(verifyStatus).tone,
          title: [
            `最新运行 ${latestRun.id}`,
            `验证状态：${verifyStatus}`,
            verificationMetaOf(verifyStatus).note,
          ].join('\n'),
        })
      : factNode('最新验证', '未知', { tone: 'gray', title: '最近运行没有 verification_status（旧版后端或尚未完成）' }),
    contractFiles.length
      ? factNode('契约文件', `${contractFiles.length} 个`, { mono: true, tone: 'cyan', title: contractFiles.join('\n') })
      : null,
    latestRun
      ? factNode('最近消耗', `↑${fmtTokens(latestRun.spent_json?.tokens)} · ${fmtRunCost(latestRun)}`, {
          tone: latestCostSource?.tone || '',
          title: `最近运行 ${latestRun.id}\n费用来源：${latestCostSource?.label || 'UNKNOWN'}\n${latestCostSource?.note || ''}`,
        })
      : null,
  ].filter(Boolean));

  dom.projectHeader.append(headerTop, facts, v2Facts);
}

function updateGoalPanelSub(project) {
  if (!dom.goalPanelSub) return;
  if (app.goalCollapsed) {
    dom.goalPanelSub.textContent = '已收起 · 展开后可发起新的自动开发';
    return;
  }
  const parts = [];
  parts.push(project.test_command ? `测试命令：${project.test_command}` : '未配置测试命令');
  parts.push(`默认 Agent：${agentLabel(project.agent_kind)}`);
  if (projectCiRequired(project)) parts.push('远端交付需 CI_PASSED');
  if (!projectRemoteAuthorized(project)) parts.push('远端未授权（仅本地交付）');
  parts.push('验收标准将逐条独立审计');
  dom.goalPanelSub.textContent = parts.join(' · ');
}

function syncGoalForm(project) {
  if (app.formProjectId !== project.id) {
    app.formProjectId = project.id;
    const draft = app.drafts.get(project.id) || { goal: '', acceptance: '', mode: 'single' };
    dom.goalInput.value = draft.goal || '';
    dom.acceptanceInput.value = draft.acceptance || '';
    setSelectedMode(draft.mode === 'plan' ? 'plan' : 'single');
    updateEditorCounts();
    hideGoalError();
  }
  setGoalCollapsed(app.goalCollapsed);
}

function getSelectedMode() {
  const checked = dom.goalForm.querySelector('input[name="runMode"]:checked');
  return checked && checked.value === 'plan' ? 'plan' : 'single';
}

function setSelectedMode(mode) {
  const target = mode === 'plan' ? 'plan' : 'single';
  for (const input of dom.goalForm.querySelectorAll('input[name="runMode"]')) {
    input.checked = input.value === target;
  }
  updateModeCards();
}

function updateModeCards() {
  for (const card of dom.goalForm.querySelectorAll('[data-mode-card]')) {
    const input = card.querySelector('input[name="runMode"]');
    card.classList.toggle('is-checked', !!(input && input.checked));
  }
}

function updateEditorCounts() {
  const goalLength = dom.goalInput.value.trim().length;
  dom.goalCharCount.textContent = `${goalLength} 字`;
  const acceptanceCount = parseAcceptanceLines(dom.acceptanceInput.value).length;
  dom.acceptanceCount.textContent = `${acceptanceCount} 条`;
}

function saveCurrentDraft() {
  if (!app.selectedProjectId) return;
  app.drafts.set(app.selectedProjectId, {
    goal: dom.goalInput.value,
    acceptance: dom.acceptanceInput.value,
    mode: getSelectedMode(),
  });
}

function showGoalError(message) {
  dom.goalError.textContent = message;
  dom.goalError.hidden = false;
}

function hideGoalError() {
  dom.goalError.hidden = true;
  dom.goalError.textContent = '';
}

function renderRuns(project) {
  clearNode(dom.runList);
  const runs = [];
  const seen = new Set();
  for (const run of project.runs || []) {
    if (!run || seen.has(run.id)) continue;
    seen.add(run.id);
    runs.push(run);
  }
  if (project.latestRun && !seen.has(project.latestRun.id)) {
    runs.unshift(project.latestRun);
    seen.add(project.latestRun.id);
  }
  if (app.runDetail && app.runDetail.project_id === project.id && !seen.has(app.runDetail.id)) {
    runs.unshift(app.runDetail);
  }
  dom.runsSub.textContent = runs.length ? `最近 ${runs.length} 次运行 · 点击查看详情` : '尚无运行记录';

  if (!runs.length) {
    dom.runList.append(
      el('div', { className: 'empty-state' }, [
        el('span', { className: 'empty-icon', text: '◎' }),
        el('p', { className: 'empty-title', text: '还没有运行记录' }),
        el('p', {
          className: 'empty-text',
          text: '在上方输入产品目标与验收标准，选择执行模式后点击「启动自动开发」。工作台会自动规划、编码、测试、独立审计，并把结果推到待验收的 PR。',
        }),
        el('div', { className: 'empty-actions' }, [
          el('button', {
            className: 'button button-primary button-sm',
            text: '填写目标并启动',
            attrs: { type: 'button' },
            on: {
              click: () => {
                setGoalCollapsed(false);
                dom.goalInput.focus({ preventScroll: true });
                dom.goalPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
              },
            },
          }),
          el('button', {
            className: 'button button-ghost button-sm',
            text: '查看使用指南',
            attrs: { type: 'button' },
            on: { click: () => openHelpModal() },
          }),
        ]),
      ]),
    );
    return;
  }

  for (const run of runs) {
    const selected = run.id === app.selectedRunId;
    const mode = MODE_LABELS[run.mode] || run.mode || '—';
    const verifyStatus = verificationStatusOf(run);
    const costSource = costSourceOfRun(run);
    const metaChildren = [
      el('span', { text: mode }),
      el('span', { text: `创建 ${fmtRelative(run.created_at)}`, title: fmtDateTimeFull(run.created_at) }),
    ];
    if (verifyStatus) {
      const runSha = verifiedShaOf(run);
      metaChildren.push(
        verificationBadge(verifyStatus, {
          small: true,
          showLabel: false,
          title: runSha ? `验证 commit ${fmtShortSha(runSha, 10)}` : undefined,
        }),
      );
    }
    if (run.stop_reason) {
      metaChildren.push(el('span', { className: 'muted', text: truncateText(run.stop_reason, 46), title: run.stop_reason }));
    }
    const item = el(
      'button',
      {
        className: `run-item${selected ? ' is-selected' : ''}`,
        attrs: { type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
        title: [
          run.goal || '',
          verifyStatus ? `验证状态：${verifyStatus}` : '',
          `费用来源：${costSource.label}（${costSource.note}）`,
        ]
          .filter(Boolean)
          .join('\n'),
        on: { click: () => selectRun(run.id, { scroll: true }) },
      },
      [
        runBadge(run.status),
        el('span', { className: 'run-item-main' }, [
          el('span', { className: 'run-item-title', text: run.goal || '（无目标描述）' }),
          el('span', { className: 'run-item-meta' }, metaChildren),
        ]),
        el('span', { className: 'run-item-side' }, [
          el('span', {
            className: 'run-item-spent',
            text: `↑${fmtTokens(run.spent_json?.tokens)} · ${fmtRunCost(run)}`,
            title: `该运行累计消耗\n费用来源：${costSource.label}\n${costSource.note}`,
          }),
          el('span', { className: 'run-item-time', text: fmtRelative(run.updated_at || run.created_at) }),
        ]),
      ],
    );
    dom.runList.append(item);
  }
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

// ============================================================
// 研发循环面板（数据来自 GET /api/state 的 loops 字段）
// ============================================================
function loopStatusMeta(status) {
  const key = String(status || 'unknown').toLowerCase();
  return LOOP_STATUS[key] || { label: key || '未知', tone: 'gray' };
}

function normalizeLoop(rawLoop) {
  const loop = rawLoop && typeof rawLoop === 'object' ? rawLoop : {};
  const progress = loop.progress && typeof loop.progress === 'object' ? loop.progress : {};
  const project = loop.project && typeof loop.project === 'object' ? loop.project : {};
  const maxRounds = Math.max(0, toNumber(loop.maxRounds ?? loop.max_rounds ?? progress.maxRounds));
  const round = Math.max(0, toNumber(loop.round ?? progress.round));
  const history = Array.isArray(loop.history) ? loop.history : Array.isArray(loop.history_json) ? loop.history_json : [];
  const rawPercent = Number(loop.percent ?? progress.percent);
  const percent = Number.isFinite(rawPercent)
    ? Math.max(0, Math.min(100, rawPercent))
    : maxRounds > 0
      ? Math.max(0, Math.min(100, Math.round((round / maxRounds) * 100)))
      : 0;
  return {
    id: String(loop.id || ''),
    projectId: String(loop.projectId || loop.project_id || project.id || ''),
    projectName: String(project.name || loop.projectName || loop.project_name || ''),
    goal: String(loop.goal || ''),
    mode: String(loop.mode || 'plan'),
    status: String(loop.status || 'unknown').toLowerCase(),
    round,
    maxRounds,
    percent,
    stopReason: String(loop.stopReason ?? loop.stop_reason ?? '').trim(),
    currentRunId: String(loop.currentRunId || loop.current_run_id || ''),
    lastRunId: String(loop.lastRunId || loop.last_run_id || ''),
    updatedAt: loop.updatedAt || loop.updated_at || '',
    history,
  };
}

function normalizeLoopHistoryEntry(rawEntry, index) {
  const item = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
  const task = item.task && typeof item.task === 'object' ? item.task : {};
  return {
    round: toNumber(item.round, index + 1),
    title: String(task.title || item.title || (typeof item.task === 'string' ? item.task : '') || '未记录任务'),
    status: String(item.status || item.verification || '').toLowerCase(),
    commit: String(item.commit || item.sha || ''),
    runId: String(item.runId || item.run_id || ''),
    finishedAt: item.finishedAt || item.finished_at || '',
  };
}

function loopHistoryStatusMeta(status) {
  const raw = String(status || '').trim();
  if (!raw) return { label: '未记录', tone: 'gray' };
  if (VERIFICATION_STATUS[raw.toUpperCase()]) return VERIFICATION_STATUS[raw.toUpperCase()];
  return RUN_STATUS[raw.toLowerCase()] || { label: raw, tone: 'gray' };
}

function buildLoopHistory(loop) {
  const history = Array.isArray(loop.history) ? loop.history : [];
  const recent = history.slice(-LOOP_HISTORY_LIMIT).map(normalizeLoopHistoryEntry).reverse();
  const block = el('div', { className: 'loop-history' }, [
    el('div', { className: 'loop-history-head' }, [
      el('span', { className: 'loop-history-title', text: '最近历史' }),
      el('span', { className: 'loop-history-count', text: history.length ? `${history.length} 条` : '暂无' }),
    ]),
  ]);
  if (!recent.length) {
    block.append(el('p', { className: 'loop-history-empty', text: '暂无历史轮次' }));
    return block;
  }
  const list = el('ol', { className: 'loop-history-list' });
  for (const entry of recent) {
    const meta = loopHistoryStatusMeta(entry.status);
    list.append(
      el('li', { className: 'loop-history-item' }, [
        el('span', { className: 'loop-history-round', text: `第 ${entry.round} 轮` }),
        el('span', { className: 'loop-history-main' }, [
          el('span', { className: 'loop-history-task', text: entry.title, title: entry.title }),
          el('span', { className: 'loop-history-meta' }, [
            badge(meta.label, meta.tone),
            entry.commit ? el('span', { className: 'mono', text: fmtShortSha(entry.commit) }) : null,
            entry.finishedAt ? el('span', { text: fmtRelative(entry.finishedAt), title: fmtDateTimeFull(entry.finishedAt) }) : null,
          ].filter(Boolean)),
        ]),
      ]),
    );
  }
  block.append(list);
  return block;
}

function buildLoopItem(loop) {
  const meta = loopStatusMeta(loop.status);
  const title = [
    loop.id ? `循环 ${loop.id}` : '研发循环',
    `status=${loop.status || 'unknown'}`,
    `round=${loop.round}`,
    `maxRounds=${loop.maxRounds}`,
    `stopReason=${loop.stopReason || '—'}`,
  ].join(' · ');
  const head = el('div', { className: 'loop-item-head' }, [
    badge(meta.label, meta.tone),
    el('div', { className: 'loop-item-titles' }, [
      el('span', { className: 'loop-item-goal', text: loop.goal || '（未记录循环目标）', title: loop.goal || '' }),
      el('span', { className: 'loop-item-meta' }, [
        loop.projectName ? el('span', { text: `项目：${loop.projectName}` }) : null,
        loop.id ? el('span', { className: 'mono', text: shortId(loop.id, 14) }) : null,
        loop.updatedAt ? el('span', { text: `更新 ${fmtRelative(loop.updatedAt)}`, title: fmtDateTimeFull(loop.updatedAt) }) : null,
      ].filter(Boolean)),
    ]),
    el('span', { className: 'loop-item-round', text: `第 ${loop.round} / ${loop.maxRounds || '—'} 轮` }),
  ]);
  const track = el('div', {
    className: 'progress-track loop-progress',
    attrs: {
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': String(loop.maxRounds || 0),
      'aria-valuenow': String(loop.round),
      'aria-label': '研发循环轮次进度',
    },
  }, [el('span', { className: 'progress-fill', style: { width: `${loop.percent}%` } })]);
  const facts = el('div', { className: 'loop-facts' }, [
    el('span', { className: 'loop-fact' }, [
      el('span', { className: 'loop-fact-label', text: '状态' }),
      el('span', { className: 'mono', text: loop.status || 'unknown' }),
    ]),
    el('span', { className: 'loop-fact' }, [
      el('span', { className: 'loop-fact-label', text: '轮次' }),
      el('span', { className: 'mono', text: `${loop.round} / ${loop.maxRounds || '—'}` }),
    ]),
    el('span', { className: 'loop-fact' }, [
      el('span', { className: 'loop-fact-label', text: '停因' }),
      el('span', { className: loop.stopReason ? 'loop-stop' : 'loop-stop is-empty', text: loop.stopReason || '—', title: loop.stopReason || '' }),
    ]),
  ]);
  return el('article', {
    className: 'loop-item',
    title,
    attrs: {
      'data-loop-status': loop.status,
      'data-loop-round': String(loop.round),
      'data-loop-max-rounds': String(loop.maxRounds),
      'data-loop-stop-reason': loop.stopReason,
    },
  }, [head, track, facts, buildLoopHistory(loop)]);
}

function renderLoops() {
  if (!dom.loopList || !dom.loopsEmpty) return;
  const loaded = !!app.state;
  const loops = Array.isArray(app.state?.loops)
    ? app.state.loops.map(normalizeLoop).filter((loop) => loop.id || loop.goal)
    : [];
  if (dom.loopsSub) {
    if (!loaded) dom.loopsSub.textContent = app.stateError ? '状态加载失败' : '加载中…';
    else if (!loops.length) dom.loopsSub.textContent = '暂无研发循环 · 循环启动后可在此查看轮次与历史';
    else dom.loopsSub.textContent = `共 ${loops.length} 个循环 · 展示状态、轮次、停因与最近历史`;
  }
  clearNode(dom.loopList);
  dom.loopsEmpty.hidden = !loaded || loops.length > 0;
  dom.loopList.hidden = !loaded || loops.length === 0;
  for (const loop of loops) dom.loopList.append(buildLoopItem(loop));
}

async function refreshLoopsPanel() {
  const button = dom.loopsRefreshBtn;
  if (!button || button.disabled) return;
  button.disabled = true;
  button.classList.add('is-spinning');
  try {
    // refreshAll 会重新请求 GET /api/state，随后通过 renderAll -> renderLoops 更新面板。
    await refreshAll({ silent: false, reason: 'loops-manual' });
  } finally {
    button.disabled = false;
    button.classList.remove('is-spinning');
  }
}

// ============================================================
// 运行详情：头部
// ============================================================
function buildBanner(tone, icon, text, title) {
  return el('div', { className: `banner${tone ? ` tone-${tone}` : ''}`, title: title || text }, [
    el('span', { className: 'banner-icon', text: icon || 'i' }),
    el('span', { text }),
  ]);
}

function metaItem(label, valueNode) {
  return el('div', { className: 'meta-item' }, [
    el('span', { className: 'meta-label', text: label }),
    el('div', { className: 'meta-value' }, valueNode),
  ]);
}

function ciMeta(ci) {
  const conclusion = String(ci?.conclusion || '').toLowerCase();
  const status = String(ci?.status || '').toLowerCase();
  if (conclusion && CI_LABELS[conclusion]) return CI_LABELS[conclusion];
  if (status && CI_LABELS[status]) return CI_LABELS[status];
  if (status === 'done') return CI_LABELS.success;
  return { label: 'Actions 状态未知', tone: 'gray' };
}

function hideRunPanels() {
  for (const node of [dom.verifyPanel, dom.runApprovalsPanel]) {
    if (!node) continue;
    node.hidden = true;
    clearNode(node);
  }
}

function renderRunSkeleton() {
  clearNode(dom.runHeader);
  clearNode(dom.taskList);
  hideRunPanels();
  dom.tasksSub.textContent = '加载中…';
  dom.runHeader.append(
    el('div', { className: 'skeleton skeleton-line is-half' }),
    el('div', { className: 'skeleton skeleton-line is-wide' }),
    el('div', { className: 'skeleton skeleton-row' }),
  );
  for (let index = 0; index < 2; index += 1) dom.taskList.append(el('div', { className: 'skeleton skeleton-task' }));
}

function renderRunError() {
  clearNode(dom.runHeader);
  clearNode(dom.taskList);
  hideRunPanels();
  dom.tasksSub.textContent = '加载失败';
  const projectId = app.selectedProjectId;
  dom.runHeader.append(
    el('button', {
      className: 'back-link',
      text: '项目概览',
      attrs: { type: 'button' },
      on: { click: () => (projectId ? selectProject(projectId) : selectDefaultProject()) },
    }),
    el('div', { className: 'banner tone-red', title: app.runDetailError?.message || '' }, [
      el('span', { className: 'banner-icon', text: '!' }),
      el('span', { text: `运行详情加载失败：${app.runDetailError?.message || '未知错误'}` }),
    ]),
    el('div', { className: 'empty-actions' }, [
      el('button', {
        className: 'button button-ghost button-sm',
        text: '重新加载',
        attrs: { type: 'button' },
        on: { click: () => loadRunDetail(app.selectedRunId, { silent: false }) },
      }),
    ]),
  );
}

function renderRunDetail() {
  if (!dom.runHeader) return;
  if (!app.selectedRunId) {
    dom.runDetailView.hidden = true;
    clearNode(dom.runHeader);
    clearNode(dom.taskList);
    hideRunPanels();
    return;
  }
  dom.runDetailView.hidden = false;
  const run = app.runDetail && app.runDetail.id === app.selectedRunId ? app.runDetail : null;
  if (!run) {
    if (app.runDetailError) renderRunError();
    else renderRunSkeleton();
    return;
  }
  const info = deriveRunInfo(run);
  renderRunHeader(run, info);
  renderVerificationPanel(run, info);
  renderRunApprovalsPanel(run);
  renderTasks(run);
}

function renderRunHeader(run, info) {
  clearNode(dom.runHeader);
  const statusMeta = RUN_STATUS[run.status] || { label: run.status || '未知', tone: 'gray' };
  dom.runHeader.style.setProperty('--run-accent', TONE_VARS[statusMeta.tone] || TONE_VARS.gray);

  const projectId = run.project_id || app.selectedProjectId;
  const backButton = el('button', {
    className: 'back-link',
    text: '项目概览',
    attrs: { type: 'button' },
    on: { click: () => (projectId ? selectProject(projectId) : selectDefaultProject()) },
  });

  const titleLine = el('div', { className: 'run-title-line' }, [
    el('span', { className: 'run-id-chip', text: run.id, title: `运行 ID：${run.id}` }),
    badge(statusMeta.label, statusMeta.tone),
    badge(MODE_LABELS[run.mode] || run.mode || '—', 'purple'),
    info.verificationStatus ? verificationBadge(info.verificationStatus, { small: true }) : null,
    info.acceptedAt ? badge('人工验收 · 未合并', 'cyan') : null,
  ]);

  const heading = el('div', { className: 'run-heading' }, [
    backButton,
    titleLine,
    el('h2', { className: 'run-goal', text: run.goal || '（无目标描述）' }),
  ]);

  const headerTop = el('div', { className: 'run-header-top' }, [heading, buildRunControls(run, info)]);

  const metaGrid = el('div', { className: 'run-meta-grid' }, [
    buildPlanBranchMeta(info),
    buildPrMeta(info),
    buildCiMeta(info),
    buildRunBudgetMeta(run),
    buildRunDurationMeta(run),
    buildRunTimeMeta(run),
  ]);

  const plan = acceptancePlan(run);
  const banners = el('div', { className: 'run-banners' });
  if (run.status === 'awaiting_acceptance') {
    if (plan.mode === 'local') {
      banners.append(
        buildBanner(
          'cyan',
          '◈',
          `仅本地验证（LOCAL_VERIFIED，commit ${fmtShortSha(info.verifiedSha, 10)}）：验收需显式确认本地交付（confirmLocalOnly=true）；项目未允许本地验收时不可验收。`,
        ),
      );
    } else if (info.verificationStatus === 'CI_PASSED') {
      banners.append(
        buildBanner(
          'green',
          '✓',
          `远端 CI 已通过（CI_PASSED，commit ${fmtShortSha(info.verifiedSha, 10)}），等待人工验收。验收仅记录人工决定，不会合并主分支、不会部署。`,
        ),
      );
    } else if (info.verificationStatus === 'CI_PENDING') {
      banners.append(buildBanner('amber', '◷', 'GitHub CI 尚未完成（CI_PENDING）：完成前不能验收；可点击「刷新 CI」重新拉取状态。'));
    } else if (info.verificationStatus === 'CI_FAILED') {
      banners.append(buildBanner('red', '!', 'GitHub CI 未通过（CI_FAILED）：不能验收；请打开 CI 详情修复失败项或取消运行。'));
    } else {
      banners.append(
        buildBanner(
          'amber',
          '?',
          '当前服务未返回可识别的 verification_status（可能是旧版后端）：无法确认远端 CI 结果，请人工核对交付内容后再验收。',
        ),
      );
    }
  }
  if (run.status === 'accepted' || info.acceptedAt) {
    const acceptedVerification = run.result_json?.acceptedVerification || info.verificationStatus;
    const acceptedSha = run.result_json?.acceptedSha || info.verifiedSha;
    banners.append(
      buildBanner(
        'green',
        '✓',
        `已记录人工验收（${acceptedVerification || '验证状态未知'}${acceptedSha ? `，commit ${fmtShortSha(acceptedSha, 10)}` : ''}；merged=false，未合并主分支、未部署）${info.acceptedAt ? ` · ${fmtDateTime(info.acceptedAt)}` : ''}`,
      ),
    );
  }
  if (run.status === 'paused' || run.status === 'interrupted') {
    const text = run.stop_reason || (run.status === 'paused' ? '运行已暂停。' : '运行已中断。');
    banners.append(
      buildBanner('amber', '!', `${text}${/恢复|重试/.test(text) ? '' : ' 可恢复运行或重试失败任务。'}`),
    );
  }
  if (run.status === 'cancelled') {
    banners.append(buildBanner('', '×', run.stop_reason || '运行已取消。'));
  }
  if (run.status !== 'paused' && run.status !== 'interrupted' && run.status !== 'cancelled' && run.stop_reason) {
    banners.append(buildBanner('amber', '!', run.stop_reason));
  }
  for (const reason of info.blockedReasons) {
    if (run.stop_reason && run.stop_reason.includes(reason)) continue;
    banners.append(buildBanner('amber', '⌁', `GitHub 发布待授权：${reason}`));
  }
  if (info.pendingApprovalCount > 0) {
    banners.append(
      buildBanner('amber', '◈', `存在 ${info.pendingApprovalCount} 个待审批项（如 CI 闸门）。批准只记录人工决定，不会自动合并或部署；处理后仍可能需要恢复/重试运行。`),
    );
  }
  if (info.ci && info.ci.conclusion === 'failure' && info.verificationStatus !== 'CI_FAILED') {
    banners.append(buildBanner('red', '!', 'GitHub Actions 未通过，请打开 PR 检查失败日志后再决定是否验收。'));
  }
  if (info.publish.localOnly === true && !info.blockedReasons.length) {
    banners.append(buildBanner('', '·', '本次运行仅在本地计划分支保留结果，未推送远端。'));
  }

  const counts = summarizeTaskCounts(run.tasks);
  const statsLine = el('div', { className: 'run-stats-line' }, [
    el('span', { text: `任务 ${counts.total}` }),
    el('span', { className: 'sep', text: '·' }),
    el('span', { text: `通过 ${counts.passed}` }),
    el('span', { className: 'sep', text: '·' }),
    el('span', { text: `进行中 ${counts.active}` }),
    el('span', { className: 'sep', text: '·' }),
    el('span', { text: `失败/阻塞 ${counts.failed}` }),
    el('span', { className: 'sep', text: '·' }),
    el('span', { text: `排队 ${counts.queued}` }),
    el('span', { className: 'sep', text: '·' }),
    el('span', { className: 'mono', text: `本次运行 ↑${fmtTokens(info.spent.tokens)} tokens · ${fmtRunCost(run)}` }),
    el('span', { className: 'sep', text: '·' }),
    buildCostSourceChip(run),
  ]);

  dom.runHeader.append(headerTop, metaGrid);
  if (banners.childElementCount) dom.runHeader.append(banners);
  dom.runHeader.append(statsLine);
}

function buildRunControls(run, info = deriveRunInfo(run)) {
  const wrap = el('div', { className: 'run-controls' });
  const busy = app.runActionPending;
  const counts = summarizeTaskCounts(run.tasks);
  const makeButton = (label, action, className, options = {}) =>
    el('button', {
      className: `button ${className || 'button-ghost'}`,
      text: busy ? '处理中…' : label,
      title: options.title || label,
      attrs: { type: 'button', disabled: busy || options.disabled ? true : undefined },
      on: { click: () => performRunAction(action) },
    });

  if (run.status === 'running' || run.status === 'queued') {
    wrap.append(makeButton('暂停', 'pause', 'button-warn', { title: '暂停当前运行，可从断点恢复' }));
    wrap.append(makeButton('取消运行', 'cancel', 'button-danger'));
  } else if (run.status === 'paused' || run.status === 'interrupted') {
    wrap.append(makeButton('恢复运行', 'resume', 'button-primary', { title: '从断点恢复；未完成的任务会重新排队' }));
    if (counts.failed > 0) {
      wrap.append(makeButton('重试失败任务', 'retry', 'button-warn', { title: `将 ${counts.failed} 个失败/阻塞任务重置为排队并重试` }));
    }
    wrap.append(makeButton('取消运行', 'cancel', 'button-danger'));
  } else if (run.status === 'awaiting_acceptance') {
    const plan = acceptancePlan(run);
    const label = plan.mode === 'local' ? '验收（本地确认）' : '验收（仅记录，不合并）';
    wrap.append(
      makeButton(label, 'accept', 'button-accept', {
        disabled: !plan.allowed,
        title: plan.allowed
          ? plan.mode === 'local'
            ? '仅本地验证：确认后将发送 confirmLocalOnly=true，按本地交付记录验收；不会合并主分支或部署。'
            : '仅记录人工验收结果，不会合并主分支、不会部署。'
          : plan.reason,
      }),
    );
    if (info.pendingApprovalCount > 0) {
      wrap.append(
        el('span', { className: 'chip tone-amber', text: `${info.pendingApprovalCount} 项待审批`, title: '打开顶栏「审批」查看待审批项' }),
      );
    }
  } else {
    const label =
      run.status === 'accepted'
        ? '已验收 · 未合并主分支'
        : run.status === 'cancelled'
          ? '运行已取消'
          : run.status === 'failed'
            ? '运行失败'
            : '运行已结束';
    wrap.append(el('span', { className: 'chip tone-gray', text: label }));
  }
  return wrap;
}

function buildPlanBranchMeta(info) {
  const children = [];
  if (info.planBranch) {
    children.push(el('span', { className: 'mono', text: info.planBranch, title: info.planBranch }));
    children.push(
      el('button', {
        className: 'copy-inline',
        text: '复制',
        title: '复制计划分支名',
        attrs: { type: 'button' },
        on: { click: () => copyWithToast(info.planBranch, '计划分支名已复制') },
      }),
    );
  } else {
    children.push(el('span', { className: 'meta-empty', text: '尚未创建计划分支' }));
  }
  return metaItem('计划分支', children);
}

function buildPrMeta(info) {
  if (info.pr) {
    const url = safeHttpUrl(info.pr.url);
    const label = info.pr.number ? `PR #${info.pr.number}` : 'PR 已创建';
    if (url) {
      return metaItem('GitHub PR', [
        el('a', {
          className: 'pr-link',
          text: label,
          attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: info.pr.title || url },
        }),
        info.pr.draft ? badge('Draft', 'gray') : null,
      ]);
    }
    return metaItem('GitHub PR', [el('span', { className: 'mono', text: label })]);
  }
  if (info.blockedReasons.length) {
    return metaItem('GitHub PR', [
      el('span', { className: 'chip tone-amber', text: '发布待授权', title: info.blockedReasons.join('\n') }),
    ]);
  }
  return metaItem('GitHub PR', [el('span', { className: 'meta-empty', text: '未创建 PR' })]);
}

function buildCiMeta(info) {
  const children = [];
  const live = info.verifyCi && (info.verifyCi.status || info.verifyCi.conclusion) ? info.verifyCi : null;
  const legacy = info.ci
    ? {
        status: info.ci.status || '',
        conclusion: info.ci.conclusion || '',
        note: info.ci.note || '',
        error: info.ci.error || '',
        url: '',
        meta: ciMeta(info.ci),
      }
    : null;
  const source = live || legacy;
  if (source) {
    children.push(badge(source.meta.label, source.meta.tone));
    if (live && live.url) {
      children.push(
        el('a', {
          className: 'pr-link ci-link',
          text: 'CI 详情',
          attrs: { href: live.url, target: '_blank', rel: 'noopener noreferrer', title: live.url },
        }),
      );
    }
    if (source.error) children.push(el('span', { className: 'meta-empty', text: '查询失败', title: source.error }));
    else if (source.note) children.push(el('span', { className: 'meta-empty', text: truncateText(source.note, 48), title: source.note }));
    children.push(
      el('button', {
        className: 'button button-ghost button-sm ci-refresh',
        text: app.runActionPending ? '刷新中…' : '刷新 CI',
        title: '重新拉取 GitHub Actions 状态',
        attrs: { type: 'button', disabled: app.runActionPending ? true : undefined },
        on: { click: () => performRunAction('ci-refresh') },
      }),
    );
  } else {
    children.push(el('span', { className: 'meta-empty', text: '未推送或未配置 Actions' }));
  }
  return metaItem('GitHub Actions', children);
}

function buildRunBudgetMeta(run) {
  const spentTokens = toNumber(run.spent_json?.tokens);
  const maxTokens = toNumber(run.budget_json?.maxTokens, toNumber(app.state?.budget?.maxTokens));
  const maxCost = toNumber(run.budget_json?.maxCostCny, toNumber(app.state?.budget?.maxCostCny));
  const percent = maxTokens ? Math.min(100, (spentTokens / maxTokens) * 100) : 0;
  const fill = el('span', { className: 'progress-fill' });
  fill.style.width = `${percent}%`;
  const top = el('div', { className: 'meta-budget-top' }, [
    el('span', { text: `↑${fmtTokens(spentTokens)} / ${fmtTokens(maxTokens)}` }),
    el('span', { text: fmtPercent(percent) }),
  ]);
  const costLine = el('div', { className: 'meta-budget-top' }, [
    el('span', { text: `${fmtRunCost(run)} / ¥${fmtCost(maxCost)}` }),
    el('span', { className: 'meta-empty', text: '成本上限' }),
  ]);
  const sourceLine = el('div', { className: 'meta-budget-top meta-budget-source' }, [
    buildCostSourceChip(run, { block: true }),
  ]);
  return metaItem('运行预算 · 本次消耗', [
    el('div', { className: 'meta-budget' }, [top, el('span', { className: 'progress-track' }, [fill]), costLine, sourceLine]),
  ]);
}

function buildRunDurationMeta(run) {
  return metaItem('运行耗时', [
    el('span', { text: fmtDurationBetween(run.started_at || run.created_at, run.ended_at) }),
    run.started_at ? el('span', { className: 'meta-empty', text: `开始 ${fmtDateTime(run.started_at)}` }) : null,
  ]);
}

function buildRunTimeMeta(run) {
  return metaItem('时间', [
    el('span', { text: `创建 ${fmtDateTime(run.created_at)}` }),
    run.ended_at ? el('span', { className: 'meta-empty', text: `结束 ${fmtDateTime(run.ended_at)}` }) : el('span', { className: 'meta-empty', text: `更新 ${fmtRelative(run.updated_at)}` }),
  ]);
}

// ============================================================
// v2：运行详情 · 验证状态区
// ============================================================
function verifyMetaItem(label, valueNode) {
  return el('div', { className: 'verify-item' }, [
    el('span', { className: 'verify-item-label', text: label }),
    el('div', { className: 'verify-item-value' }, valueNode),
  ]);
}

function renderVerificationPanel(run, info) {
  const panel = dom.verifyPanel;
  if (!panel) return;
  clearNode(panel);
  const meta = info.verification;
  const plan = acceptancePlan(run);
  const sha = info.verifiedSha;
  panel.hidden = false;
  panel.className = `panel verify-panel tone-${meta.tone}`;

  const head = el('div', { className: 'panel-head verify-head' }, [
    el('div', { className: 'panel-heading' }, [
      el('h2', { className: 'panel-title', text: '验证状态' }),
      el('p', { className: 'panel-sub', text: verificationSubText(run, info) }),
    ]),
    el('span', { className: `verify-status-badge tone-${meta.tone}` }, [
      el('span', { className: 'verify-status-code', text: meta.code }),
      el('span', { className: 'verify-status-label', text: meta.label }),
    ]),
  ]);

  const shaChildren = [];
  if (sha) {
    shaChildren.push(el('span', { className: 'mono verify-sha', text: fmtShortSha(sha, 12), title: sha }));
    shaChildren.push(
      el('button', {
        className: 'copy-inline',
        text: '复制',
        title: '复制完整验证 commit SHA',
        attrs: { type: 'button' },
        on: { click: () => copyWithToast(sha, '验证 commit SHA 已复制') },
      }),
    );
  } else {
    shaChildren.push(el('span', { className: 'meta-empty', text: '未绑定验证 commit' }));
  }

  const ciChildren = [];
  if (info.verifyCi && (info.verifyCi.status || info.verifyCi.conclusion)) {
    ciChildren.push(badge(info.verifyCi.meta.label, info.verifyCi.meta.tone));
    if (info.verifyCi.url) {
      ciChildren.push(
        el('a', {
          className: 'pr-link ci-link',
          text: '打开 CI 详情',
          attrs: { href: info.verifyCi.url, target: '_blank', rel: 'noopener noreferrer', title: info.verifyCi.url },
        }),
      );
    }
  } else {
    ciChildren.push(el('span', { className: 'meta-empty', text: '无 CI 记录（未推送或项目未要求远端 CI）' }));
  }

  const project = (app.runDetail && app.runDetail.project) || currentProject() || null;
  const ciRequired = projectCiRequired(project);
  const remoteAuthorized = projectRemoteAuthorized(project);
  const allowLocal = projectAllowLocalAcceptance(project);
  const acceptanceChildren = [];
  if (plan.mode === 'local') {
    acceptanceChildren.push(el('span', { className: 'chip tone-cyan', text: '本地验收（需 confirmLocalOnly）' }));
  } else if (plan.mode === 'ci') {
    acceptanceChildren.push(el('span', { className: 'chip tone-green', text: '远端验收（CI_PASSED）' }));
  } else if (plan.mode === 'legacy') {
    acceptanceChildren.push(el('span', { className: 'chip tone-amber', text: '旧版流程（验证状态未知）' }));
  } else {
    acceptanceChildren.push(el('span', { className: 'meta-empty', text: '当前不可验收' }));
  }
  if (!allowLocal) acceptanceChildren.push(el('span', { className: 'meta-empty', text: '· 项目不允许本地验收' }));

  const grid = el('div', { className: 'verify-grid' }, [
    verifyMetaItem('验证 commit', shaChildren),
    verifyMetaItem('CI 状态', ciChildren),
    verifyMetaItem('验收方式', acceptanceChildren),
    verifyMetaItem('交付要求', [
      el('span', {
        text: ciRequired ? (remoteAuthorized ? '远端 CI 必需（CI_PASSED）' : '项目要求 CI，但远端未授权') : '不要求远端 CI（本地验证即可）',
      }),
    ]),
  ]);

  const guidance = el('p', { className: 'verify-guidance', text: verificationGuidance(run, info, plan) });

  const actions = el('div', { className: 'verify-actions' });
  if (run.status === 'awaiting_acceptance') {
    const acceptButton = el('button', {
      className: 'button button-accept',
      text: plan.allowed
        ? plan.mode === 'local'
          ? '确认本地验收（不合并）'
          : '确认验收（仅记录，不合并）'
        : '验收不可用',
      title: plan.allowed
        ? plan.mode === 'local'
          ? '将弹出确认并发送 { confirmLocalOnly: true }；仅记录本地交付，不合并主分支、不部署。'
          : '验收只记录人工决定，不会合并主分支或部署。'
        : plan.reason,
      attrs: { type: 'button', disabled: plan.allowed && !app.runActionPending ? undefined : true },
      on: { click: () => performRunAction('accept') },
    });
    actions.append(acceptButton);
    actions.append(
      el('button', {
        className: 'button button-ghost button-sm',
        text: app.runActionPending ? '刷新中…' : '刷新 CI 状态',
        title: '重新拉取 GitHub Actions 状态（POST /api/runs/:id/ci-refresh）',
        attrs: { type: 'button', disabled: app.runActionPending ? true : undefined },
        on: { click: () => performRunAction('ci-refresh') },
      }),
    );
    if (!plan.allowed && plan.reason) {
      actions.append(el('span', { className: 'verify-blocked', text: plan.reason }));
    }
  } else if (run.status === 'accepted') {
    actions.append(el('span', { className: 'chip tone-green', text: '已验收 · 未合并主分支 · 未部署' }));
  } else if (info.pendingApprovalCount > 0) {
    actions.append(
      el('button', {
        className: 'button button-ghost button-sm',
        text: `查看 ${info.pendingApprovalCount} 个待审批项`,
        attrs: { type: 'button' },
        on: { click: () => openApprovalsModal() },
      }),
    );
  }

  panel.append(head, el('div', { className: 'verify-body' }, [grid, guidance, actions]));
}

// ============================================================
// v2：审批中心（顶栏弹窗 + 运行详情审批记录）
// ============================================================
function buildApprovalItem(approval, options = {}) {
  const statusMeta = approvalStatusMeta(approval.status);
  const pending = approval.status === 'pending';
  const busy = app.approvalPending.has(approval.id);
  const item = el('div', { className: `approval-item${pending ? ' is-pending' : ''}` });

  item.append(
    el('div', { className: 'approval-head' }, [
      badge(statusMeta.label, statusMeta.tone),
      el('span', { className: 'approval-type', text: approvalTypeLabel(approval.type) }),
      el('span', { className: 'approval-title', text: approval.title || '（未命名审批项）' }),
    ]),
  );

  const metaParts = [];
  if (approval.runId) {
    const found = findRun(approval.runId);
    if (found?.run?.goal) metaParts.push(`运行目标：${truncateText(found.run.goal, 56)}`);
    metaParts.push(`运行 ${shortId(approval.runId, 18)}`);
  }
  metaParts.push(`创建 ${fmtRelative(approval.createdAt)}`);
  if (approval.decidedAt) {
    metaParts.push(`${approval.status === 'approved' ? '批准' : '拒绝'}于 ${fmtDateTime(approval.decidedAt)}${approval.decidedBy ? ` · ${approval.decidedBy}` : ''}`);
  }
  item.append(
    el('div', { className: 'approval-meta', title: fmtDateTimeFull(approval.createdAt) }, [
      el('span', { text: metaParts.join(' · ') }),
    ]),
  );

  const summary = approvalDetailsSummary(approval);
  item.append(el('p', { className: 'approval-details', text: truncateText(summary, 300), title: summary }));

  if (pending && options.showActions !== false) {
    const actionChildren = [];
    if (options.showView !== false && approval.runId) {
      actionChildren.push(
        el('button', {
          className: 'button button-ghost button-sm',
          text: '查看运行',
          title: `打开运行 ${approval.runId}`,
          attrs: { type: 'button', disabled: busy ? true : undefined },
          on: {
            click: () => {
              closeModal({ silent: true });
              selectRun(approval.runId, { scroll: true });
            },
          },
        }),
      );
    }
    actionChildren.push(
      el('button', {
        className: 'button button-accept button-sm',
        text: busy ? '处理中…' : '批准',
        title: '记录批准决定；不会自动合并主分支、不会部署',
        attrs: { type: 'button', disabled: busy ? true : undefined },
        on: { click: () => decideApproval(approval, 'approve') },
      }),
      el('button', {
        className: 'button button-danger button-sm',
        text: busy ? '处理中…' : '拒绝',
        title: '记录拒绝决定；不会自动合并主分支、不会部署',
        attrs: { type: 'button', disabled: busy ? true : undefined },
        on: { click: () => decideApproval(approval, 'reject') },
      }),
    );
    item.append(el('div', { className: 'approval-actions' }, actionChildren));
  }
  return item;
}

async function decideApproval(approval, decision) {
  const id = approval?.id;
  if (!id || app.approvalPending.has(id)) return;
  app.approvalPending.add(id);
  syncApprovalsModal(true);
  if (app.runDetail) renderRunApprovalsPanel(app.runDetail);
  try {
    await apiRequest('POST', `/api/approvals/${encodeURIComponent(id)}/${decision}`, { decidedBy: 'human' });
    toast(
      decision === 'approve' ? '已记录批准决定（不会自动合并主分支，也不会部署）' : '已记录拒绝决定（不会自动合并主分支，也不会部署）',
      decision === 'approve' ? 'success' : 'warn',
      { duration: 5200, force: true },
    );
    await refreshAll({ silent: true, reason: 'approval' });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    app.approvalPending.delete(id);
    syncApprovalsModal(true);
    if (app.runDetail) renderRunApprovalsPanel(app.runDetail);
  }
}

function approvalsSignature() {
  const list = pendingApprovals();
  return `${list.map((item) => `${item.id}:${item.status}`).join('|')}::${[...app.approvalPending].sort().join(',')}`;
}

function buildApprovalsModalBody() {
  const list = pendingApprovals();
  const wrap = el('div', { className: 'approval-modal' });
  wrap.append(
    el('div', { className: 'approval-warning' }, [
      el('span', { className: 'approval-warning-icon', text: '!' }),
      el('div', { className: 'approval-warning-body' }, [
        el('p', { className: 'approval-warning-title', text: '批准仅记录人工决定：不会自动合并主分支，也不会部署。' }),
        el('p', {
          className: 'approval-warning-text',
          text: '审批项通常来自 CI 闸门等安全门禁。批准 / 拒绝后仍需要你自行决定是否合并 PR、是否重新运行或重试失败任务。',
        }),
      ]),
    ]),
  );
  if (!list.length) {
    wrap.append(
      el('div', { className: 'approval-empty' }, [
        el('span', { className: 'approval-empty-icon', text: '✓' }),
        el('p', { className: 'approval-empty-title', text: '当前没有待审批项' }),
        el('p', { className: 'approval-empty-text', text: 'CI 闸门阻塞、远端推送待授权等需要人工决策的事项会出现在这里。' }),
      ]),
    );
    return wrap;
  }
  wrap.append(el('div', { className: 'approval-list' }, list.map((approval) => buildApprovalItem(approval))));
  wrap.append(
    el('p', {
      className: 'approval-note',
      text: `数据来源：GET /api/state 的 approvals · 当前 ${list.length} 项待处理。决定会通过 POST /api/approvals/:id/approve|reject 记录。`,
    }),
  );
  return wrap;
}

function syncApprovalsModal(force) {
  if (!app.modal.open || app.modal.type !== 'approvals') return;
  const signature = approvalsSignature();
  if (!force && signature === app.modal.approvalsSig) return;
  app.modal.approvalsSig = signature;
  const list = pendingApprovals();
  dom.modalTitle.textContent = list.length ? `审批中心 · ${list.length} 项待处理` : '审批中心';
  clearNode(dom.modalBody);
  dom.modalBody.append(buildApprovalsModalBody());
}

function openApprovalsModal() {
  app.modal.approvalsSig = '';
  const refreshButton = el('button', {
    className: 'button button-ghost',
    text: '刷新审批',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        await refreshAll({ silent: false, reason: 'approvals' });
        syncApprovalsModal(true);
      },
    },
  });
  const closeButton = el('button', {
    className: 'button button-primary',
    text: '关闭',
    attrs: { type: 'button' },
    on: { click: () => closeModal() },
  });
  openModal({
    type: 'approvals',
    title: '审批中心',
    body: el('div', { className: 'approval-modal' }),
    footer: [refreshButton, closeButton],
    wide: true,
  });
  syncApprovalsModal(true);
}

function renderRunApprovalsPanel(run) {
  const panel = dom.runApprovalsPanel;
  if (!panel) return;
  const approvals = normalizeApprovals(run?.approvals);
  if (!approvals.length) {
    panel.hidden = true;
    clearNode(panel);
    return;
  }
  const pending = approvals.filter((item) => item.status === 'pending').length;
  clearNode(panel);
  panel.hidden = false;
  panel.append(
    el('div', { className: 'panel-head' }, [
      el('div', { className: 'panel-heading' }, [
        el('h2', { className: 'panel-title', text: '本次运行审批' }),
        el('p', {
          className: 'panel-sub',
          text: pending ? `${pending} 项待处理 · 批准只记录人工决定，不会自动合并或部署` : `全部已处理 · ${approvals.length} 条记录`,
        }),
      ]),
      el('span', { className: 'policy-chip', text: '批准不会自动合并 / 部署' }),
    ]),
    el('div', { className: 'approval-list run-approval-list' }, approvals.map((approval) => buildApprovalItem(approval, { showView: false }))),
    el('p', { className: 'panel-foot-note', text: '审批用于 CI 闸门等安全决策；批准不会自动合并主分支、不会部署、不会自动推送远端。' }),
  );
}

// ============================================================
// 运行详情：任务流水线
// ============================================================
function taskSignature(run) {
  const taskPart = (run?.tasks || [])
    .map((task) => [task.id, task.status, task.attempt, task.updated_at, task.audits.length, task.head_commit].join(':'))
    .join('|');
  const expandedPart = [...app.expandedTasks].join(',');
  const detailPart = [...app.expandedTasks]
    .map((taskId) => {
      const entry = app.taskDetails.get(taskId);
      return `${taskId}:${entry?.data ? 'd' : ''}${entry?.error ? `e${entry.error.message}` : ''}${entry?.loading ? 'l' : ''}`;
    })
    .join(',');
  return `${run.id}::${taskPart}::${expandedPart}::${detailPart}`;
}

function renderTasks(run = app.runDetail) {
  if (!dom.taskList) return;
  if (!run || run.id !== app.selectedRunId) return;
  const tasks = run.tasks || [];
  const counts = summarizeTaskCounts(tasks);
  dom.tasksSub.textContent = tasks.length
    ? `共 ${counts.total} 个任务 · ${counts.passed} 通过 · ${counts.active} 进行中 · ${counts.failed} 失败/阻塞 · ${counts.queued} 排队`
    : '暂无任务';

  const signature = taskSignature(run);
  if (dom.taskList.dataset.sig === signature && dom.taskList.childElementCount > 0) {
    scheduleExpandedTaskDetails();
    return;
  }
  clearNode(dom.taskList);

  if (!tasks.length) {
    dom.taskList.append(
      el('div', { className: 'empty-state' }, [
        el('span', { className: 'empty-icon', text: '∅' }),
        el('p', { className: 'empty-title', text: '暂无任务记录' }),
        el('p', { className: 'empty-text', text: '规划器尚未生成任务，或该运行尚未开始。刷新后可再次查看。' }),
      ]),
    );
    dom.taskList.dataset.sig = signature;
    return;
  }

  for (const task of tasks) dom.taskList.append(buildTaskCard(task));
  dom.taskList.dataset.sig = signature;
  scheduleExpandedTaskDetails();
}

function scheduleExpandedTaskDetails() {
  for (const taskId of app.expandedTasks) {
    const entry = app.taskDetails.get(taskId);
    if (entry && (entry.loading || entry.data || entry.error)) continue;
    window.setTimeout(() => {
      if (app.expandedTasks.has(taskId) && app.selectedRunId) ensureTaskDetail(taskId);
    }, 0);
  }
}

function latestAuditOf(task) {
  const audits = Array.isArray(task.audits) ? task.audits : [];
  return audits.length ? audits[audits.length - 1] : null;
}

function latestAttemptOf(task) {
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].agentKind) return attempts[index];
  }
  return attempts.length ? attempts[attempts.length - 1] : null;
}

function buildTaskCard(task) {
  const statusMeta = TASK_STATUS[task.status] || { label: task.status || '未知', tone: 'gray' };
  const audit = latestAuditOf(task);
  const attempt = latestAttemptOf(task);
  const commit = task.head_commit || task.result_json?.commit || '';
  const expanded = app.expandedTasks.has(task.id);
  const card = el('div', { className: `task-card tone-${statusMeta.tone}${expanded ? ' is-expanded' : ''}` });

  const metaChips = [
    el('span', { className: 'chip', text: `尝试 ${task.attempt || 0}/${task.maxAttempts || '—'}` }),
    el('span', {
      className: 'chip',
      text: `Agent ${agentLabel(task.agent_kind)}${attempt && task.agent_kind === 'auto' ? ` · ${agentLabel(attempt.agentKind)}` : ''}`,
      title: attempt ? `最近尝试 Agent：${agentLabel(attempt.agentKind)}` : '尚未产生 Agent 尝试',
    }),
  ];
  if (audit) {
    const verdict = VERDICT[audit.verdict] || { label: audit.verdict || '审计', tone: 'gray' };
    metaChips.push(
      el('span', {
        className: `chip tone-${verdict.tone}`,
        title: `独立审计：${auditProviderLabel(audit.provider)} / ${audit.model || '—'} · ${verdict.label} · 得分 ${audit.score}`,
      }, [
        el('span', { text: `${auditProviderLabel(audit.provider)} · ${audit.verdict === 'pass' ? '通过' : '未通过'}` }),
        el('span', { className: 'mono', text: String(audit.score) }),
      ]),
    );
  } else {
    metaChips.push(el('span', { className: 'chip tone-gray', text: '待审计' }));
  }
  if (commit) {
    metaChips.push(el('span', { className: 'chip', title: `commit ${commit}` }, [
      el('span', { text: 'commit' }),
      el('span', { className: 'mono', text: shortHash(commit) }),
    ]));
  }

  const header = el(
    'button',
    {
      className: 'task-head',
      attrs: { type: 'button', 'aria-expanded': expanded ? 'true' : 'false' },
      on: { click: () => toggleTask(task.id) },
    },
    [
      el('span', { className: 'task-seq', text: `#${task.seq || '—'}` }),
      el('span', { className: 'task-main' }, [
        el('span', { className: 'task-title', text: task.title || '（未命名任务）' }),
        el('span', { className: 'task-meta' }, metaChips),
      ]),
      el('span', { className: 'task-right' }, [taskBadge(task.status)]),
      el('span', { className: 'task-chevron', attrs: { 'aria-hidden': 'true' } }),
    ],
  );

  card.append(header);
  if (expanded) card.append(buildTaskBody(task));
  return card;
}

function toggleTask(taskId) {
  if (app.expandedTasks.has(taskId)) app.expandedTasks.delete(taskId);
  else app.expandedTasks.add(taskId);
  if (app.runDetail) renderTasks(app.runDetail);
}

function taskSection(title, countLabel) {
  return el('div', { className: 'task-section-head' }, [
    el('span', { className: 'task-section-title', text: title }),
    countLabel ? el('span', { className: 'task-section-count', text: countLabel }) : null,
    el('span', { className: 'section-rule' }),
  ]);
}

function buildTaskBody(task) {
  const entry = app.taskDetails.get(task.id) || null;
  const full = entry?.data || null;
  const audits = (full && Array.isArray(full.audits) ? full.audits.map(normalizeAudit) : task.audits) || [];
  const attempts = (full && Array.isArray(full.attempts) ? full.attempts.map(normalizeAttempt) : task.attempts) || [];
  const artifacts = (full && Array.isArray(full.artifacts) ? full.artifacts.map(normalizeArtifact) : task.artifacts) || [];
  const acceptance = Array.isArray(full?.acceptance_json) ? full.acceptance_json : task.acceptance || [];
  const body = el('div', { className: 'task-body' });

  if (!full && !entry?.error) {
    body.append(el('div', { className: 'detail-loading' }, [el('span', { className: 'spinner' }), el('span', { text: '正在加载任务详情（尝试记录与产物）…' })]));
  }
  if (entry?.error) {
    body.append(
      el('div', { className: 'detail-error' }, [
        el('span', { text: `任务详情加载失败：${entry.error.message}` }),
        el('button', {
          className: 'button button-ghost button-sm',
          text: '重试',
          attrs: { type: 'button' },
          on: { click: () => ensureTaskDetail(task.id, { force: true }) },
        }),
      ]),
    );
  }

  // 验收标准
  const criteriaSection = el('section', { className: 'task-section' });
  const latestAudit = audits.length ? audits[audits.length - 1] : null;
  const criteria = buildCriteriaItems(acceptance, latestAudit);
  const passedCount = criteria.filter((item) => item.status === 'pass').length;
  criteriaSection.append(
    taskSection('验收标准', criteria.length ? `${passedCount}/${criteria.length} 通过` : ''),
    criteria.length
      ? el('div', { className: 'criterion-list' }, criteria.map(buildCriterionRow))
      : el('p', { className: 'detail-empty', text: '任务没有验收标准记录。' }),
  );
  body.append(criteriaSection);

  // 审计
  const auditSection = el('section', { className: 'task-section' });
  auditSection.append(taskSection('独立审计', audits.length ? `${audits.length} 次记录` : ''));
  if (!audits.length) {
    auditSection.append(
      el('p', {
        className: 'detail-empty',
        text: '尚未产生审计记录。任务通过测试后会进入独立模型审计，逐条核对验收标准并给出证据。',
      }),
    );
  } else {
    auditSection.append(buildAuditCard(latestAudit));
    const previous = audits.slice(0, -1).reverse();
    if (previous.length) {
      const history = el('div', { className: 'audit-history' });
      previous.forEach((item, index) => {
        const verdict = VERDICT[item.verdict] || { label: item.verdict || '审计', tone: 'gray' };
        history.append(
          el('div', { className: 'audit-history-row' }, [
            el('span', { text: `历史审计 ${previous.length - index}` }),
            badge(verdict.label, verdict.tone),
            el('span', { className: 'mono', text: `${auditProviderLabel(item.provider)} / ${item.model || '—'}` }),
            el('span', { text: `得分 ${item.score}` }),
            el('span', { className: 'meta-empty', text: fmtDateTime(item.createdAt) }),
          ]),
        );
      });
      auditSection.append(history);
    }
  }
  body.append(auditSection);

  // 失败原因
  const failureReason = task.blocked_reason || task.result_json?.failureReason || latestAttemptOf(task)?.error || '';
  if (failureReason) {
    const failureSection = el('section', { className: 'task-section' });
    failureSection.append(
      taskSection('失败原因', ''),
      el('div', { className: 'failure-reason' }, [
        el('span', { className: 'failure-icon', text: '!' }),
        el('p', { className: 'failure-text', text: failureReason }),
      ]),
    );
    body.append(failureSection);
  }

  // 尝试记录
  const attemptSection = el('section', { className: 'task-section' });
  attemptSection.append(taskSection('尝试记录', attempts.length ? `${attempts.length} 次` : ''));
  if (!attempts.length) {
    attemptSection.append(el('p', { className: 'detail-empty', text: '尚无 Agent 尝试记录（任务可能尚未开始）。' }));
  } else {
    const list = el('div', { className: 'attempt-list' });
    for (const attempt of attempts) {
      const statusMeta = ATTEMPT_STATUS[attempt.status] || { label: attempt.status || '—', tone: 'gray' };
      const costSource = costSourceOfAttempt(attempt);
      const main = el('div', { className: 'attempt-main' }, [
        el('div', { className: 'attempt-title' }, [
          el('span', { text: STAGE_LABELS[attempt.stage] || attempt.stage || '执行' }),
          el('span', { className: 'meta-empty', text: agentLabel(attempt.agentKind) }),
          badge(statusMeta.label, statusMeta.tone),
          el('span', { className: 'meta-empty', text: fmtDateTime(attempt.createdAt) }),
        ]),
      ]);
      if (attempt.error) main.append(el('span', { className: 'attempt-error', text: attempt.error }));
      list.append(
        el('div', { className: 'attempt-row' }, [
          el('span', { className: 'attempt-tag', text: `#${attempt.attemptNo || '—'}` }),
          main,
          el('span', { className: 'attempt-nums', title: `Token / 成本 / 耗时\n费用来源：${costSource.label}\n${costSource.note}` }, [
            el('span', { text: `↑${fmtTokens(attempt.tokens)} · ${attempt.costCny > 0 ? fmtCostCny(attempt.costCny) : '费用未知'}` }),
            el('br'),
            el('span', { text: fmtDurationMs(attempt.durationMs) }),
            el('br'),
            el('span', { className: `attempt-cost-source tone-${costSource.tone}`, text: `来源 ${costSource.label}` }),
          ]),
        ]),
      );
    }
    attemptSection.append(list);
  }
  body.append(attemptSection);

  // 产物
  const artifactSection = el('section', { className: 'task-section' });
  artifactSection.append(taskSection('产物文件', artifacts.length ? `${artifacts.length} 个` : ''));
  if (!artifacts.length) {
    artifactSection.append(
      el('p', { className: 'detail-empty', text: entry?.loading ? '正在加载产物列表…' : '尚未生成产物文件。' }),
    );
  } else {
    const list = el('div', { className: 'artifact-list' });
    for (const artifact of artifacts) {
      const label = artifactKindLabel(artifact.kind);
      list.append(
        el(
          'button',
          {
            className: 'artifact-item',
            attrs: { type: 'button', title: `打开 ${artifact.path}` },
            on: { click: () => openArtifactDrawer(artifact) },
          },
          [
            el('span', { className: 'artifact-kind', text: label }),
            el('span', { className: 'artifact-name', text: basename(artifact.path) }),
            el('span', { className: 'artifact-size', text: fmtBytes(artifact.bytes) }),
            el('span', { className: 'artifact-open', text: '打开 →' }),
          ],
        ),
      );
    }
    artifactSection.append(list);
  }
  body.append(artifactSection);

  // 任务信息
  const infoItems = [];
  if (task.branch) infoItems.push(['分支', task.branch]);
  if (task.base_commit) infoItems.push(['基准 commit', shortHash(task.base_commit, 12)]);
  if (task.head_commit) infoItems.push(['最新 commit', shortHash(task.head_commit, 12)]);
  if (task.test_command) infoItems.push(['测试命令', task.test_command]);
  if (task.worktree_path) infoItems.push(['工作副本', task.worktree_path]);
  infoItems.push(['任务来源 Agent', agentLabel(task.agent_kind)]);
  infoItems.push(['最后更新', fmtDateTime(task.updated_at)]);
  if (infoItems.length) {
    const infoSection = el('section', { className: 'task-section' });
    infoSection.append(taskSection('任务信息', ''));
    const grid = el('div', { className: 'task-info-grid' });
    for (const [label, value] of infoItems) {
      grid.append(el('div', { className: 'info-row' }, [
        el('span', { className: 'info-label', text: label }),
        el('span', { className: 'info-value', text: value, title: value }),
      ]));
    }
    infoSection.append(grid);
    body.append(infoSection);
  }

  return body;
}

function buildCriteriaItems(acceptance, audit) {
  const list = Array.isArray(acceptance) ? acceptance : [];
  const auditCriteria = audit && Array.isArray(audit.criteria) ? audit.criteria : [];
  return list.map((criterion, index) => {
    const hit =
      auditCriteria.find((item) => String(item?.criterion || '').trim() === String(criterion).trim()) ||
      auditCriteria[index] ||
      null;
    const status = audit ? String(hit?.status || 'unproven').toLowerCase() : 'pending';
    const normalized = !audit ? 'pending' : ['pass', 'fail', 'unproven'].includes(status) ? status : 'unproven';
    return {
      criterion: String(criterion || ''),
      status: normalized,
      evidence: String(hit?.evidence || ''),
      hasAudit: !!audit,
    };
  });
}

function buildCriterionRow(item) {
  const meta = CRITERION_STATUS[item.status] || CRITERION_STATUS.pending;
  return el('div', { className: `criterion tone-${meta.tone}` }, [
    el('span', { className: 'criterion-icon', text: meta.icon, title: meta.label }),
    el('div', { className: 'criterion-body' }, [
      el('p', { className: 'criterion-text', text: item.criterion }),
      el('p', {
        className: 'criterion-evidence',
        text: item.hasAudit ? item.evidence || '审计未给出具体证据' : '尚未产生审计记录，等待独立审计逐条核对',
      }),
    ]),
    el('span', { className: `badge tone-${meta.tone}`, style: { 'align-self': 'flex-start' } }, [el('span', { text: meta.label })]),
  ]);
}

function buildAuditCard(audit) {
  const card = el('div', { className: 'audit-card' });
  const verdict = VERDICT[audit.verdict] || { label: audit.verdict || '审计结果', tone: 'gray' };
  card.append(
    el('div', { className: 'audit-head' }, [
      badge(verdict.label, verdict.tone),
      el('span', { className: 'audit-provider', text: auditProviderLabel(audit.provider) }),
      el('span', { className: 'audit-model', text: audit.model || '—' }),
      el('span', { className: 'audit-score', text: `得分 ${audit.score}` }),
    ]),
  );
  if (audit.summary) card.append(el('p', { className: 'audit-summary', text: audit.summary }));
  if (Array.isArray(audit.findings) && audit.findings.length) {
    const findings = el('ul', { className: 'findings-list' });
    for (const finding of audit.findings) {
      const severity = severityMeta(finding?.severity);
      const locationText = [finding?.file || '', finding?.line ? `:${finding.line}` : ''].join('');
      findings.append(
        el('li', { className: 'finding' }, [
          badge(severity.label, severity.tone),
          el('div', { className: 'finding-main' }, [
            el('div', { className: 'finding-head' }, [
              el('span', { text: '发现' }),
              locationText ? el('span', { className: 'mono', text: locationText }) : null,
            ]),
            el('p', { className: 'finding-issue', text: finding?.issue || finding?.title || '未说明的问题' }),
            finding?.required_fix ? el('p', { className: 'finding-fix', text: finding.required_fix }) : null,
          ]),
        ]),
      );
    }
    card.append(findings);
  }
  if (Array.isArray(audit.requiredFixes) && audit.requiredFixes.length) {
    const fixes = el('ul', { className: 'fixes-list' });
    for (const fix of audit.requiredFixes) fixes.append(el('li', { className: 'fix-item', text: String(fix) }));
    card.append(fixes);
  }
  if ((!audit.findings || !audit.findings.length) && (!audit.requiredFixes || !audit.requiredFixes.length) && audit.verdict === 'pass') {
    card.append(el('p', { className: 'audit-summary', text: '逐条验收标准通过，未发现需修复项。' }));
  }
  return card;
}

// ============================================================
// 选择与路由
// ============================================================
function parseRoute() {
  const raw = String(location.hash || '');
  const insightMatch = raw.match(/^#\/(guide|live|replay)$/);
  if (insightMatch) return { insight: insightMatch[1] };
  const match = raw.match(/^#\/([pr])\/([^/?#]+)$/);
  if (!match) return {};
  let id = match[2];
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    id = match[2];
  }
  if (!id) return {};
  return match[1] === 'p' ? { projectId: id } : { runId: id };
}

function setHash(value, replace) {
  if (!value || location.hash === value) return;
  if (replace) {
    try {
      history.replaceState(null, '', value);
    } catch {
      location.hash = value;
    }
  } else {
    location.hash = value;
  }
}

function selectProject(projectId, options = {}) {
  if (!projectId) return false;
  const project = (app.state?.projects || []).find((item) => item.id === projectId);
  if (!project) {
    toast('项目不存在或已被移除', 'warn');
    return false;
  }
  stopInsight();
  app.selectedProjectId = projectId;
  app.selectedRunId = null;
  app.runDetail = null;
  app.scrollToRunAfterLoad = false;
  app.runDetailError = null;
  app.runDetailLoading = false;
  app.expandedTasks.clear();
  app.goalCollapsed = false;
  app.formProjectId = null;
  resetEventScope('打开最近运行可回看历史事件，新事件会实时追加。');
  setGoalCollapsed(false);
  renderAll();
  if (options.scroll !== false) {
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }
  if (options.updateHash !== false) setHash(`#/p/${encodeURIComponent(projectId)}`, !!options.replace);
  return true;
}

function selectRun(runId, options = {}) {
  if (!runId) return false;
  const known = findRun(runId);
  const projectId = known?.projectId || (app.runDetail?.id === runId ? app.runDetail.project_id : app.selectedProjectId);
  stopInsight();
  app.selectedRunId = runId;
  if (projectId) app.selectedProjectId = projectId;
  if (!app.runDetail || app.runDetail.id !== runId) {
    app.runDetail = null;
    app.runDetailError = null;
    app.runDetailLoading = true;
    app.expandedTasks.clear();
  }
  app.goalCollapsed = true;
  if (options.scroll) app.scrollToRunAfterLoad = true;
  if (app.eventScopeKey !== `run:${runId}`) {
    app.eventScopeKey = `run:${runId}`;
    app.events = [];
    app.eventIds.clear();
    app.eventFloor = 0;
    clearNode(dom.eventLog);
    dom.eventLog.append(buildEventEmpty('正在加载该运行的历史事件…'));
  }
  renderAll();
  renderRunDetail();
  if (options.updateHash !== false) setHash(`#/r/${encodeURIComponent(runId)}`, !!options.replace);
  loadRunDetail(runId, { silent: false });
  return true;
}

function selectDefaultProject() {
  const projects = app.state?.projects || [];
  const first = projects[0];
  if (first) {
    selectProject(first.id, { updateHash: true, replace: true });
    return;
  }
  app.selectedProjectId = null;
  app.selectedRunId = null;
  app.runDetail = null;
  app.runDetailError = null;
  app.expandedTasks.clear();
  resetEventScope('启动自动开发或选择一次运行后，事件会实时滚动在这里。');
  renderAll();
  setHash('#/', true);
}

function applyRoute() {
  if (!app.state) return;
  const route = parseRoute();
  if (route.insight) {
    if (app.insightView !== route.insight) openInsight(route.insight, { updateHash: false });
    return;
  }
  if (app.insightView) stopInsight();
  if (route.runId) {
    if (route.runId === app.selectedRunId && app.runDetail) return;
    selectRun(route.runId, { updateHash: false });
    return;
  }
  if (route.projectId) {
    const exists = (app.state.projects || []).some((project) => project.id === route.projectId);
    if (exists) {
      if (route.projectId !== app.selectedProjectId || app.selectedRunId) {
        selectProject(route.projectId, { updateHash: false });
      } else {
        // 从“看见 AI”返回项目页时，selectedProjectId 可能没变；仍必须重绘项目视图。
        renderAll();
      }
      return;
    }
    toast('链接中的项目不存在，已返回项目列表', 'warn');
    selectDefaultProject();
    return;
  }
  if (app.selectedProjectId) {
    if (app.selectedRunId) selectProject(app.selectedProjectId, { updateHash: false });
    else setHash(`#/p/${encodeURIComponent(app.selectedProjectId)}`, true);
    return;
  }
  selectDefaultProject();
}

// ============================================================
// 运行控制
// ============================================================
async function performRunAction(action) {
  const runId = app.selectedRunId;
  if (!runId || app.runActionPending) return;
  if (action === 'ci-refresh') {
    await refreshCi(runId);
    return;
  }

  const run = app.runDetail && app.runDetail.id === runId ? app.runDetail : null;
  let acceptPlan = null;
  let confirmOptions = null;
  if (action === 'accept') {
    if (!run) {
      toast('运行详情尚未加载，请稍后重试', 'warn');
      return;
    }
    const info = deriveRunInfo(run);
    acceptPlan = acceptancePlan(run);
    if (!acceptPlan.allowed) {
      toast(acceptPlan.reason || '当前验证状态不允许验收', 'warn', { duration: 6000, force: true });
      return;
    }
    confirmOptions = buildAcceptConfirmOptions(run, info, acceptPlan);
  } else if (action === 'cancel') {
    confirmOptions = {
      title: '取消运行',
      message: '取消后当前运行会标记为已取消，未完成的任务不会继续执行。已产生的提交、审计记录与产物会保留。',
      warning: '此操作不可撤销；如需继续开发，需要重新发起运行。',
      confirmText: '确认取消',
      tone: 'danger',
    };
  } else if (action === 'retry') {
    confirmOptions = {
      title: '重试失败任务',
      message: '将把所有失败 / 阻塞任务重置为排队状态并重新执行，可能产生额外的 tokens 与成本消耗。',
      warning: '已通过任务的提交与审计记录会保留；失败任务的旧尝试会保留在历史记录中。',
      confirmText: '重试失败任务',
      tone: 'warn',
    };
  }

  if (confirmOptions) {
    const confirmed = await confirmDialog(confirmOptions);
    if (!confirmed) return;
  }

  app.runActionPending = true;
  renderRunDetail();
  try {
    let result = null;
    if (action === 'pause') {
      result = await apiRequest('POST', `/api/runs/${encodeURIComponent(runId)}/pause`, { reason: '人工暂停' });
      toast('运行已暂停，可从断点恢复', 'success');
    } else if (action === 'resume') {
      result = await apiRequest('POST', `/api/runs/${encodeURIComponent(runId)}/resume`, { retryFailed: false });
      toast('运行已恢复，继续执行未完成任务', 'success');
    } else if (action === 'retry') {
      result = await apiRequest('POST', `/api/runs/${encodeURIComponent(runId)}/resume`, { retryFailed: true });
      toast('已重新排队失败任务，运行已恢复', 'success');
    } else if (action === 'cancel') {
      result = await apiRequest('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`);
      toast('运行已取消', 'warn');
    } else if (action === 'accept') {
      const body = acceptPlan?.confirmLocalOnly ? { confirmLocalOnly: true } : {};
      result = await apiRequest('POST', `/api/runs/${encodeURIComponent(runId)}/accept`, body);
      toast(
        acceptPlan?.confirmLocalOnly
          ? '已按本地交付记录验收（confirmLocalOnly=true）；未合并主分支、未部署'
          : '已记录人工验收（未合并主分支、未部署）',
        'success',
        { duration: 5500 },
      );
    } else {
      throw new ApiError(`未知操作：${action}`, 0, 'UNKNOWN_ACTION');
    }
    if (result && result.ok === false) {
      toast(result.message || '操作未完成', 'warn');
    }
    await refreshAll({ silent: true, reason: 'run-action' });
  } catch (error) {
    toast(error.message, 'error');
    if (error.code === 'RUN_NOT_FOUND') {
      app.runDetailError = error;
    }
  } finally {
    app.runActionPending = false;
    renderRunDetail();
  }
}

async function refreshCi(runId) {
  app.runActionPending = true;
  renderRunDetail();
  try {
    const result = await apiRequest('POST', `/api/runs/${encodeURIComponent(runId)}/ci-refresh`);
    if (result && result.ok === false) {
      toast(result.message || '该运行没有 CI 记录', 'warn');
    } else {
      const conclusion = result?.conclusion || '完成';
      const label = CI_LABELS[conclusion]?.label || conclusion;
      toast(`GitHub Actions 状态已刷新：${label}`, conclusion === 'failure' ? 'warn' : 'success');
    }
    await refreshAll({ silent: true, reason: 'ci-refresh' });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    app.runActionPending = false;
    renderRunDetail();
  }
}

// ============================================================
// 启动运行
// ============================================================
function setStartButtonBusy(busy) {
  if (!dom.startRunBtn) return;
  dom.startRunBtn.disabled = !!busy;
  dom.startRunBtn.textContent = busy ? '启动中…' : '启动自动开发';
}

async function submitStartRun() {
  const project = currentProject();
  if (!project) return;
  const goal = dom.goalInput.value.trim();
  const acceptance = parseAcceptanceLines(dom.acceptanceInput.value);
  const mode = getSelectedMode();
  if (!goal) {
    showGoalError('请先填写产品目标');
    dom.goalInput.focus({ preventScroll: true });
    toast('请先填写产品目标', 'warn');
    return;
  }
  hideGoalError();
  setStartButtonBusy(true);
  try {
    const result = await apiRequest('POST', `/api/projects/${encodeURIComponent(project.id)}/runs`, {
      goal,
      acceptance,
      mode,
    });
    const runId = result?.runId;
    if (!runId) throw new ApiError('运行已创建，但服务未返回 runId', 0, 'BAD_RUN_RESPONSE');
    app.drafts.delete(project.id);
    dom.goalInput.value = '';
    dom.acceptanceInput.value = '';
    updateEditorCounts();
    setGoalCollapsed(true);
    toast(mode === 'plan' ? '已启动自动开发：正在规划多任务计划…' : '已启动自动开发', 'success');
    await loadState({ silent: true });
    renderAll();
    selectRun(runId, { scroll: true });
  } catch (error) {
    showGoalError(error.message);
    toast(error.message, 'error');
  } finally {
    setStartButtonBusy(false);
  }
}

// ============================================================
// 添加项目
// ============================================================
function modalFormField(options) {
  const field = el('div', { className: `form-field${options.full ? ' is-full' : ''}` });
  const inputId = options.id || '';
  const children = [];
  if (options.label) children.push(el('label', { text: options.label, attrs: inputId ? { for: inputId } : {} }));
  children.push(options.control);
  if (options.hint) children.push(el('p', { className: 'form-hint', text: options.hint }));
  for (const child of children) field.append(child);
  return field;
}

function buildCheckboxField(options) {
  const input = el('input', {
    attrs: {
      type: 'checkbox',
      id: options.id,
      checked: options.checked ? true : undefined,
    },
  });
  const label = el('label', { className: 'checkbox-field', attrs: { for: options.id } }, [
    input,
    el('span', { className: 'checkbox-body' }, [
      el('span', { className: 'checkbox-title', text: options.title }),
      el('span', { className: 'checkbox-desc', text: options.desc }),
    ]),
  ]);
  return { input, label };
}

function formSectionHead(title, hint) {
  return el('div', { className: 'form-section-head is-full' }, [
    el('span', { className: 'form-section-title', text: title }),
    hint ? el('span', { className: 'form-section-hint', text: hint }) : null,
  ]);
}

function buildNumberInput(options) {
  return el('input', {
    attrs: {
      type: 'number',
      id: options.id,
      min: options.min !== undefined ? String(options.min) : undefined,
      max: options.max !== undefined ? String(options.max) : undefined,
      step: options.step !== undefined ? String(options.step) : undefined,
      placeholder: options.placeholder || '',
      inputmode: 'decimal',
    },
  });
}

function openAddProjectModal() {
  const nameInput = el('input', {
    attrs: {
      type: 'text',
      id: 'newProjectName',
      placeholder: '例如：TaskVault',
      autocomplete: 'off',
      maxlength: '120',
    },
  });
  const repoInput = el('input', {
    attrs: {
      type: 'text',
      id: 'newProjectRepo',
      placeholder: '例如：owner/repo、GitHub 仓库地址或本地绝对路径',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const testInput = el('input', {
    attrs: {
      type: 'text',
      id: 'newProjectTest',
      placeholder: '例如：npm test · python3 -m pytest -q · go test ./...',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const agentSelect = el('select', { attrs: { id: 'newProjectAgent' } }, [
    el('option', { text: 'auto · 自动选择（推荐）', attrs: { value: 'auto' } }),
    el('option', { text: 'dsh · DeepSeek Harness', attrs: { value: 'dsh' } }),
    el('option', { text: 'claude · Claude Code', attrs: { value: 'claude' } }),
  ]);
  const auditSelect = el('select', { attrs: { id: 'newProjectAudit' } }, [
    el('option', { text: 'auto · 跟随全局可用审计模型（推荐）', attrs: { value: 'auto' } }),
    el('option', { text: 'openai · GPT', attrs: { value: 'openai' } }),
    el('option', { text: 'glm · GLM', attrs: { value: 'glm' } }),
    el('option', { text: 'deepseek · DeepSeek', attrs: { value: 'deepseek' } }),
  ]);
  const permissionSelect = el('select', { attrs: { id: 'newProjectPermission' } }, [
    el('option', { text: '自动 · 跟随全局策略（推荐）', attrs: { value: '' } }),
    el('option', { text: 'read-only · 只读', attrs: { value: 'read-only' } }),
    el('option', { text: 'workspace-write · 工作区写入', attrs: { value: 'workspace-write' } }),
    el('option', { text: 'danger-full-access · 完全访问（默认被策略拒绝）', attrs: { value: 'danger-full-access' } }),
  ]);
  const contractInput = el('textarea', {
    attrs: { id: 'newProjectContracts', rows: '2', placeholder: '例如：README.md, docs/API.md（逗号或换行分隔）' },
  });
  const allowedCommandsInput = el('textarea', {
    attrs: { id: 'newProjectAllowedCommands', rows: '2', placeholder: '每行一条；留空则使用上方测试命令作为 allowlist' },
  });
  const testEnvInput = el('input', {
    attrs: {
      type: 'text',
      id: 'newProjectTestEnv',
      placeholder: '例如：NODE_ENV,CI（逗号分隔；测试进程只继承白名单环境变量）',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const maxTokensInput = buildNumberInput({ id: 'newProjectMaxTokens', min: 1, step: 1000, placeholder: '例如 3000000' });
  const maxCostInput = buildNumberInput({ id: 'newProjectMaxCost', min: 0.01, step: 0.01, placeholder: '例如 30' });
  const maxAttemptsInput = buildNumberInput({ id: 'newProjectMaxAttempts', min: 1, max: 10, step: 1, placeholder: '例如 2' });

  const protect = buildCheckboxField({
    id: 'newProjectProtect',
    checked: true,
    title: '保护测试目录',
    desc: '自动加入 tests/**、test/**、**/*.test.js 等受保护路径，防止 Agent 通过修改验收测试来「通过」。',
  });
  const ciRequired = buildCheckboxField({
    id: 'newProjectCiRequired',
    checked: app.state?.verification?.ciRequiredByDefault !== false,
    title: '要求远端 CI（ci_required）',
    desc: '远端交付必须 GitHub Actions 通过（CI_PASSED）并绑定 commit 才能验收；仅在已授权远端推送时生效。',
  });
  const allowLocal = buildCheckboxField({
    id: 'newProjectAllowLocal',
    checked: true,
    title: '允许本地验收（allow_local_acceptance）',
    desc: '仅本地验证（LOCAL_VERIFIED）时，可在界面显式确认本地交付（confirmLocalOnly=true）后验收。',
  });
  const remotePush = buildCheckboxField({
    id: 'newProjectRemotePush',
    checked: false,
    title: '授权远端推送（remote_push_authorized）· 默认关闭',
    desc: '勾选后运行结束会推送计划分支并创建草稿 PR（仍受 GitHub Token 与策略限制）；不勾选则只在本地保留计划分支。',
  });

  const budgetGrid = el('div', { className: 'budget-input-grid' }, [
    el('div', { className: 'budget-sub-field' }, [
      el('span', { className: 'budget-sub-label', text: 'max_tokens_per_run' }),
      maxTokensInput,
    ]),
    el('div', { className: 'budget-sub-field' }, [
      el('span', { className: 'budget-sub-label', text: 'max_cost_cny_per_run' }),
      maxCostInput,
    ]),
    el('div', { className: 'budget-sub-field' }, [
      el('span', { className: 'budget-sub-label', text: 'max_attempts' }),
      maxAttemptsInput,
    ]),
  ]);

  const formError = el('p', { className: 'form-error', attrs: { hidden: true } });
  const form = el(
    'form',
    {
      className: 'modal-form',
      attrs: { id: 'addProjectForm', autocomplete: 'off', novalidate: true },
    },
    [
      el('div', { className: 'form-grid' }, [
        formSectionHead('基础信息', '名称与仓库必填；测试命令留空时自动检测'),
        modalFormField({ label: '项目名称 *', control: nameInput, id: 'newProjectName' }),
        modalFormField({
          label: '默认 Agent',
          control: el('div', { className: 'form-select-wrap' }, [agentSelect]),
          id: 'newProjectAgent',
        }),
        modalFormField({
          label: '仓库地址或本地路径 *',
          control: repoInput,
          id: 'newProjectRepo',
          full: true,
          hint: '支持 GitHub 地址、owner/repo 简写或本机绝对路径。GitHub 地址会先克隆仓库，可能需要几十秒。',
        }),
        modalFormField({
          label: '测试命令',
          control: testInput,
          id: 'newProjectTest',
          full: true,
          hint: '留空则自动检测 npm test / pytest / go test 等；测试命令是任务通过的必要条件。',
        }),
        modalFormField({
          label: '审计模型',
          control: el('div', { className: 'form-select-wrap' }, [auditSelect]),
          id: 'newProjectAudit',
          hint: '独立审计必须与编码模型不同族；auto 跟随全局可用模型。',
        }),
        modalFormField({
          label: 'Agent 权限（可选，DSH）',
          control: el('div', { className: 'form-select-wrap' }, [permissionSelect]),
          id: 'newProjectPermission',
          hint: '留空跟随全局策略；danger-full-access 默认被安全策略拒绝。',
        }),
        formSectionHead('高级配置（可选）', '缺省字段不会发送，服务使用全局默认值'),
        modalFormField({
          label: '契约文件（contractFiles）',
          control: contractInput,
          id: 'newProjectContracts',
          full: true,
          hint: '审计会重点核对的接口/文档文件；逗号或换行分隔，例如 README.md, docs/API.md。',
        }),
        modalFormField({
          label: '允许的测试命令（allowedTestCommands）',
          control: allowedCommandsInput,
          id: 'newProjectAllowedCommands',
          full: true,
          hint: '每行一条，测试命令必须精确命中 allowlist；留空则使用测试命令本身。',
        }),
        modalFormField({
          label: '测试环境变量白名单（testEnvAllowlist）',
          control: testEnvInput,
          id: 'newProjectTestEnv',
          full: true,
          hint: '逗号分隔；测试进程只继承这些环境变量，绝不会继承 API Key。',
        }),
        el('div', { className: 'form-field is-full' }, [
          el('label', { text: '运行预算（单次运行上限，可选）' }),
          budgetGrid,
          el('p', { className: 'form-hint', text: '留空的字段不会发送：max_tokens_per_run / max_cost_cny_per_run / max_attempts。' }),
        ]),
        el('div', { className: 'form-field is-full checkbox-grid' }, [
          protect.label,
          ciRequired.label,
          allowLocal.label,
          remotePush.label,
        ]),
        formError,
      ]),
      el('div', { className: 'confirm-warning' }, [
        '工作台只创建隔离分支与 PR，不会合并主分支，也不会修改受保护的测试目录。远端推送默认关闭；勾选授权后也只推送计划分支并创建草稿 PR，批准/验收都不会自动合并或部署。',
      ]),
    ],
  );

  const cancelButton = el('button', {
    className: 'button button-ghost',
    text: '取消',
    attrs: { type: 'button' },
    on: { click: () => closeModal() },
  });
  const submitButton = el('button', {
    className: 'button button-primary',
    text: '添加项目',
    attrs: { type: 'submit', form: 'addProjectForm' },
  });

  const showFormError = (message, focusNode) => {
    formError.textContent = message;
    formError.hidden = false;
    if (focusNode && typeof focusNode.focus === 'function') focusNode.focus();
  };

  const readBudgetNumber = (input, label, options = {}) => {
    const raw = input.value.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须是大于 0 的数字`);
    if (options.integer && !Number.isInteger(value)) throw new Error(`${label} 必须是整数`);
    if (options.min !== undefined && value < options.min) throw new Error(`${label} 不能小于 ${options.min}`);
    if (options.max !== undefined && value > options.max) throw new Error(`${label} 不能大于 ${options.max}`);
    return value;
  };

  let submitting = false;
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    const name = nameInput.value.trim();
    const repo = repoInput.value.trim();
    if (!name) {
      showFormError('请填写项目名称', nameInput);
      return;
    }
    if (!repo) {
      showFormError('请填写仓库地址或本地路径', repoInput);
      return;
    }

    let payload;
    try {
      payload = {
        name,
        repo,
        protectTests: !!protect.input.checked,
        agentKind: agentSelect.value || 'auto',
        ciRequired: !!ciRequired.input.checked,
        allowLocalAcceptance: !!allowLocal.input.checked,
        remotePushAuthorized: !!remotePush.input.checked,
      };
      const testCommand = testInput.value.trim();
      if (testCommand) payload.testCommand = testCommand;
      const auditProvider = auditSelect.value;
      if (auditProvider && auditProvider !== 'auto') payload.auditProvider = auditProvider;
      const contractFiles = parseTagList(contractInput.value);
      if (contractFiles.length) payload.contractFiles = contractFiles;
      const allowedTestCommands = parseTagList(allowedCommandsInput.value);
      if (allowedTestCommands.length) payload.allowedTestCommands = allowedTestCommands;
      const testEnvAllowlist = parseTagList(testEnvInput.value);
      if (testEnvAllowlist.length) payload.testEnvAllowlist = testEnvAllowlist;
      const agentPermission = permissionSelect.value;
      if (agentPermission) payload.agentPermission = agentPermission;

      const budget = {};
      const maxTokens = readBudgetNumber(maxTokensInput, 'max_tokens_per_run', { integer: true, min: 1 });
      if (maxTokens !== undefined) budget.max_tokens_per_run = Math.round(maxTokens);
      const maxCost = readBudgetNumber(maxCostInput, 'max_cost_cny_per_run', { min: 0.01 });
      if (maxCost !== undefined) budget.max_cost_cny_per_run = Math.round(maxCost * 10000) / 10000;
      const maxAttempts = readBudgetNumber(maxAttemptsInput, 'max_attempts', { integer: true, min: 1, max: 10 });
      if (maxAttempts !== undefined) budget.max_attempts = maxAttempts;
      if (Object.keys(budget).length) payload.budget = budget;
    } catch (error) {
      showFormError(error.message);
      toast(error.message, 'warn');
      return;
    }

    formError.hidden = true;
    submitting = true;
    submitButton.disabled = true;
    cancelButton.disabled = true;
    submitButton.textContent = '正在添加…';
    try {
      const project = await apiRequest('POST', '/api/projects', payload);
      closeModal({ silent: true });
      toast(`项目「${project?.name || name}」已添加`, 'success');
      const ok = await refreshAll({ silent: true, reason: 'project-created' });
      const createdId = project?.id || '';
      if (createdId && (app.state?.projects || []).some((item) => item.id === createdId)) {
        selectProject(createdId, { updateHash: true, replace: true });
      } else if (createdId) {
        app.selectedProjectId = createdId;
        app.selectedRunId = null;
        app.formProjectId = null;
        renderAll();
        setHash(`#/p/${encodeURIComponent(createdId)}`, true);
      } else if (!ok) {
        toast('项目已添加，但列表刷新失败，请点击右上角刷新', 'warn');
      }
    } catch (error) {
      showFormError(error.message);
      toast(error.message, 'error');
    } finally {
      submitting = false;
      submitButton.disabled = false;
      cancelButton.disabled = false;
      submitButton.textContent = '添加项目';
    }
  });

  openModal({
    title: '添加项目',
    body: form,
    footer: [cancelButton, submitButton],
    focusEl: nameInput,
    wide: true,
  });
}

// ============================================================
// 使用指南
// ============================================================
function helpStepList(steps) {
  const list = el('ol', { className: 'help-steps' });
  steps.forEach((step, index) => {
    list.append(
      el('li', { className: 'help-step' }, [
        el('span', { className: 'help-step-num', text: String(index + 1).padStart(2, '0') }),
        el('span', { className: 'help-step-body' }, [
          el('span', { className: 'help-step-title', text: step.title }),
          el('span', { className: 'help-step-desc', text: step.desc }),
        ]),
      ]),
    );
  });
  return list;
}

function helpSection(title, children) {
  return el('section', { className: 'help-section' }, [
    el('h3', { text: title }),
    ...children,
  ]);
}

function openHelpModal() {
  const steps = [
    { title: '打开工作台', desc: '确认右上角「实时已连接」；如果显示断开，页面仍会每 5 秒轮询状态兜底。浏览器通过 HttpOnly Cookie 自动认证，无需手动填 Token。' },
    { title: '添加项目', desc: '点击左侧「+ 添加」：填写名称，关联 GitHub 仓库 / owner/repo / 本地绝对路径，设置测试命令与受保护目录；高级配置可设置契约文件、测试命令 allowlist、环境变量白名单、Agent 权限与运行预算。' },
    { title: '输入目标与验收标准', desc: '在产品目标中描述交付结果；验收标准每行一条。独立审计模型会逐条核对并给出 pass / fail / unproven 与证据。' },
    { title: '启动自动开发', desc: '选择「单任务执行」或「自动多任务规划」后启动。工作台会创建隔离分支、调度 Coding Agent、运行测试与独立审计。' },
    { title: '查看进度与证据', desc: '任务流水线展示状态、尝试次数、Agent、审计得分、commit 与费用来源；点击任务可展开验收证据、findings、失败原因与产物。' },
    { title: '检查验证状态', desc: '运行详情顶部展示 verification_status、verified_sha、CI 状态与链接：LOCAL_VERIFIED 需显式确认本地验收（confirmLocalOnly=true）；CI_PENDING / CI_FAILED 不能验收；CI_PASSED 可正常验收。' },
    { title: '处理审批项', desc: '顶栏「审批」显示待审批数：CI 闸门、远端推送待授权等会出现在审批中心。批准 / 拒绝只记录人工决定，不会自动合并主分支或部署。' },
    { title: '最终验收', desc: '验证通过后由你点击验收记录结果。工作台永不自动合并主分支、不会部署；是否合并 PR 由你自行决定。' },
  ];
  const safetyList = el('ul', { className: 'help-list' }, [
    el('li', {}, [el('strong', { text: '不合并主分支：' }), document.createTextNode('只创建计划分支与草稿 PR，是否合并由你决定。')]),
    el('li', {}, [el('strong', { text: '验证门禁：' }), document.createTextNode('远端交付必须 CI_PASSED 且绑定 commit；本地验收需显式 confirmLocalOnly 且项目允许。')]),
    el('li', {}, [el('strong', { text: '审批边界：' }), document.createTextNode('审批中心只记录人工批准 / 拒绝，不触发合并、部署或自动推送。')]),
    el('li', {}, [el('strong', { text: '测试保护：' }), document.createTextNode('受保护路径由策略层强制校验，Agent 无法通过改测试「通过」。')]),
    el('li', {}, [el('strong', { text: '独立审计：' }), document.createTextNode('审计模型未参与编码，逐条核对验收标准；unproven 不计为通过。')]),
    el('li', {}, [el('strong', { text: '不伪造成功：' }), document.createTextNode('测试失败或审计失败会暂停并记录原因，可人工恢复或重试失败任务。')]),
    el('li', {}, [el('strong', { text: '预算兜底：' }), document.createTextNode('全局 / 项目 tokens 与成本耗尽时自动暂停；费用来源区分厂商返回 / 估算 / UNKNOWN。')]),
  ]);
  const projectList = el('ul', { className: 'help-list' }, [
    el('li', {}, [el('strong', { text: 'GitHub 仓库：' }), document.createTextNode('填写完整地址或 owner/repo，工作台会克隆到本地 projects 目录。')]),
    el('li', {}, [el('strong', { text: '本地项目：' }), document.createTextNode('填写绝对路径；若尚未初始化 git，工作台会建立基线提交。')]),
    el('li', {}, [el('strong', { text: '测试命令：' }), document.createTextNode('留空时自动检测 npm test / pytest / go test / cargo test；测试命令必须命中 allowlist。')]),
    el('li', {}, [el('strong', { text: '高级配置：' }), document.createTextNode('契约文件、allowedTestCommands、testEnvAllowlist、agentPermission、ciRequired、allowLocalAcceptance、remotePushAuthorized 与预算均为可选，缺省不发送。')]),
    el('li', {}, [el('strong', { text: '远端授权：' }), document.createTextNode('remotePushAuthorized 默认不勾选：不勾选时运行只在本地保留计划分支，不会推送或创建 PR。')]),
  ]);
  const verificationList = el('ul', { className: 'help-list' }, [
    el('li', {}, [el('strong', { text: 'LOCAL_VERIFIED：' }), document.createTextNode('仅本地验证。验收会弹确认并发送 { confirmLocalOnly: true }；项目 allow_local_acceptance=false 时不可验收。')]),
    el('li', {}, [el('strong', { text: 'CI_PENDING / CI_FAILED：' }), document.createTextNode('远端 CI 未完成或失败，验收按钮禁用；可点击「刷新 CI 状态」重新拉取。')]),
    el('li', {}, [el('strong', { text: 'CI_PASSED：' }), document.createTextNode('CI 通过且绑定 verified_sha，可正常验收；验收不合并、不部署。')]),
    el('li', {}, [el('strong', { text: '认证与错误：' }), document.createTextNode('401 表示 API 认证失败，刷新页面即可重新获取 Cookie；403 表示被 Host / Origin / CSRF / 限流策略拒绝。')]),
  ]);
  const realtimeList = el('ul', { className: 'help-list' }, [
    el('li', {}, [el('strong', { text: '实时通道：' }), document.createTextNode('EventSource 连接 GET /api/stream，连接断开时自动重连。')]),
    el('li', {}, [el('strong', { text: '轮询兜底：' }), document.createTextNode('每 5 秒请求 GET /api/state；SSE 断开时顶栏状态会变灰。')]),
    el('li', {}, [el('strong', { text: '事件流：' }), document.createTextNode('只保留最近 300 条，可按级别与类型着色（含审计未知 / 审计错误 / CI 闸门 / 审批决定 / 测试命令回退 / 受保护路径违规 / Agent 进度）。')]),
    el('li', {}, [el('strong', { text: '产物查看：' }), document.createTextNode('点击产物文件会在右侧抽屉中加载文本（提示词 / diff / 测试证据 / 审计原文）。')]),
  ]);

  const body = el('div', { className: 'help-body' }, [
    helpSection('推荐使用流程', [helpStepList(steps)]),
    helpSection('安全边界与质量门禁', [safetyList]),
    helpSection('验证、验收与审批', [verificationList]),
    helpSection('项目接入提示', [projectList]),
    helpSection('实时状态与产物', [realtimeList]),
    helpSection('当前环境', [
      el('dl', { className: 'help-kv' }, [
        el('dt', { text: '服务版本' }),
        el('dd', { text: app.state?.version ? `v${app.state.version}` : '—' }),
        el('dt', { text: '独立审计' }),
        el('dd', { text: app.state?.audit?.note || '—' }),
        el('dt', { text: 'GitHub' }),
        el('dd', { text: app.state?.github?.note || (app.state?.github?.configured ? '已连接' : '未连接') }),
        el('dt', { text: '验证策略' }),
        el('dd', {
          text: app.state?.verification?.note
            ? app.state.verification.note
            : '远端验收需要 CI_PASSED 且绑定 commit SHA；本地验收需显式确认',
        }),
        el('dt', { text: '待审批' }),
        el('dd', { text: `${pendingApprovals().length} 项` }),
        el('dt', { text: '策略' }),
        el('dd', {
          text: app.state?.policy
            ? `不自动合并主分支 · 单任务最多 ${toNumber(app.state.policy.maxAttempts, 2)} 次尝试 · 保护路径 ${(app.state.policy.protectedPaths || []).length} 条`
            : '—',
        }),
      ]),
    ]),
  ]);

  const closeButton = el('button', {
    className: 'button button-ghost',
    text: '关闭',
    attrs: { type: 'button' },
    on: { click: () => closeModal() },
  });
  const addButton = el('button', {
    className: 'button button-primary',
    text: '添加项目',
    attrs: { type: 'button' },
    on: {
      click: () => {
        closeModal({ silent: true });
        window.setTimeout(() => openAddProjectModal(), 60);
      },
    },
  });
  openModal({ title: '使用指南', body, footer: [closeButton, addButton], wide: true });
}

// ============================================================
// 工作台状态面板
// ============================================================
function statusRow(label, value, title) {
  return el('div', { className: 'status-row' }, [
    el('span', { text: label }),
    el('span', { className: 'mono', text: value, title: title || value }),
  ]);
}

function renderStatusPanel() {
  if (!dom.statusPanel) return;
  clearNode(dom.statusPanel);
  const state = app.state;
  const subText = state
    ? `每 5 秒轮询 · 更新于 ${fmtClock(new Date(app.lastStateAt).toISOString())}`
    : app.stateError
      ? '状态加载失败'
      : '加载中…';
  dom.statusPanel.append(
    el('div', { className: 'panel-head' }, [
      el('div', { className: 'panel-heading' }, [
        el('h2', { className: 'panel-title', text: '工作台状态' }),
        el('p', { className: 'panel-sub', text: subText }),
      ]),
    ]),
  );

  const body = el('div', { className: 'status-body' });
  dom.statusPanel.append(body);
  if (!state) {
    if (app.stateError) {
      const error = app.stateError;
      const authFailed = error.status === 401;
      const forbidden = error.status === 403;
      body.append(
        el('p', { className: 'status-note', text: `无法连接工作台服务：${error.message}` }),
        authFailed
          ? el('p', {
              className: 'status-note',
              text: '会话 Cookie 缺失或已失效：刷新页面后服务器会重新写入 HttpOnly SameSite=Strict Cookie。',
            })
          : null,
        forbidden
          ? el('p', {
              className: 'status-note',
              text: '请求被安全策略拒绝：请确认通过 http://127.0.0.1:4477 访问，且不是跨站 / 跨域请求。',
            })
          : null,
        el('div', { className: 'empty-actions' }, [
          authFailed || forbidden
            ? el('button', {
                className: 'button button-primary button-sm',
                text: '刷新页面',
                attrs: { type: 'button' },
                on: { click: () => window.location.reload() },
              })
            : null,
          el('button', {
            className: 'button button-ghost button-sm',
            text: '重试',
            attrs: { type: 'button' },
            on: { click: () => refreshAll({ silent: false, reason: 'retry' }) },
          }),
        ]),
      );
    } else {
      body.append(el('div', { className: 'skeleton skeleton-line' }), el('div', { className: 'skeleton skeleton-line is-half' }));
    }
    return;
  }

  const slots = state.agentSlots || {};
  const counts = state.taskStatusCounts || {};
  const totalTasks = Object.values(counts).reduce((sum, value) => sum + toNumber(value), 0);
  body.append(
    statusRow('服务版本', `v${state.version || '—'} · 运行 ${fmtSeconds(state.server?.uptimeSec)}`),
    statusRow('Agent 槽位', `${toNumber(slots.active)} / ${toNumber(slots.limit)}${toNumber(slots.queued) ? ` · 排队 ${toNumber(slots.queued)}` : ''}`),
    statusRow('活跃运行', String((state.activeRunIds || []).length)),
    statusRow('任务总数', String(totalTasks)),
    statusRow('待审批', `${pendingApprovals().length} 项`, '审批中心：批准不会自动合并主分支或部署'),
  );

  const agentsBlock = el('div', { className: 'status-block' }, [el('span', { className: 'status-block-title', text: 'Agent 状态' })]);
  for (const agent of state.agents || []) {
    agentsBlock.append(
      el('div', { className: 'status-row' }, [
        el('span', { className: 'mini-label', text: `${agent.label || agent.id}` }),
        el('span', { className: 'status-row-value' }, [
          statusDot(agent.ok ? 'green' : 'gray'),
          el('span', { text: agent.ok ? '可用' : '不可用', title: agent.detail || '' }),
        ]),
      ]),
    );
  }
  body.append(agentsBlock);

  const taskBlock = el('div', { className: 'status-block' }, [el('span', { className: 'status-block-title', text: '任务状态分布' })]);
  const chips = el('div', { className: 'count-chips' });
  const order = ['queued', 'preparing', 'coding', 'testing', 'auditing', 'repairing', 'committing', 'passed', 'failed', 'blocked'];
  let chipCount = 0;
  for (const key of order) {
    if (!counts[key]) continue;
    chipCount += 1;
    chips.append(
      el('span', { className: `count-chip tone-${TASK_STATUS[key]?.tone || 'gray'}` }, [
        el('span', { text: TASK_STATUS[key]?.label || key }),
        el('span', { className: 'mono', text: String(counts[key]) }),
      ]),
    );
  }
  if (!chipCount) chips.append(el('span', { className: 'count-chip', text: '暂无任务' }));
  taskBlock.append(chips);
  body.append(taskBlock);

  const auditBlock = el('div', { className: 'status-block' }, [
    el('span', { className: 'status-block-title', text: '独立审计' }),
    el('p', {
      className: 'status-note',
      text: state.audit
        ? `${state.audit.active?.label || '未配置'}${state.audit.active?.model ? ` / ${state.audit.active.model}` : ''} · ${state.audit.note || ''}`
        : '—',
    }),
  ]);
  body.append(auditBlock);

  const githubBlock = el('div', { className: 'status-block' }, [
    el('span', { className: 'status-block-title', text: 'GitHub 发布' }),
    el('p', {
      className: 'status-note',
      text: state.github?.configured
        ? `已连接${state.github.owner ? `（${state.github.owner}）` : ''}：运行完成后会推送计划分支、创建草稿 PR 并轮询 Actions。`
        : state.github?.note || '未配置 GITHUB_TOKEN：推送与创建 PR 会记录为待授权，不影响本地开发与验收。',
    }),
  ]);
  body.append(githubBlock);

  const approvals = pendingApprovals();
  const approvalsBlock = el('div', { className: 'status-block' }, [
    el('span', { className: 'status-block-title', text: '审批中心' }),
    approvals.length
      ? el('p', { className: 'status-note', text: `${approvals.length} 项待处理：${approvals.slice(0, 2).map((item) => item.title || approvalTypeLabel(item.type)).join('；')}${approvals.length > 2 ? '…' : ''}` })
      : el('p', { className: 'status-note', text: '暂无待审批项。批准 / 拒绝只记录人工决定，不会自动合并或部署。' }),
    approvals.length
      ? el('button', {
          className: 'button button-ghost button-sm',
          text: '打开审批中心',
          attrs: { type: 'button' },
          on: { click: () => openApprovalsModal() },
        })
      : null,
  ]);
  body.append(approvalsBlock);

  const verificationBlock = el('div', { className: 'status-block' }, [
    el('span', { className: 'status-block-title', text: '验证 / 验收策略' }),
    el('p', {
      className: 'status-note',
      text: state.verification?.note || '远端验收需要 CI_PASSED 且绑定 commit SHA；本地验收需显式确认',
    }),
    el('p', {
      className: 'status-note',
      text: '验收只记录人工决定：不合并主分支、不部署；待审批项需在审批中心处理。',
    }),
  ]);
  body.append(verificationBlock);

  body.append(
    el('p', {
      className: 'status-note',
      text: state.policy?.neverMerge
        ? `策略：工作台永不合并主分支；单任务最多 ${toNumber(state.policy.maxAttempts, 2)} 次尝试；保护路径 ${(state.policy.protectedPaths || []).length} 条。`
        : '策略：当前允许合并主分支，请谨慎使用。',
    }),
  );
}

// ============================================================
// v2.6 看见 AI：解释 / 实况 / 历史回放
// 所有实况与回放数据来自只读 API；缺失数据明确标注，不生成演示数据。
// ============================================================
const INSIGHT_META = {
  guide: { title: '工作台如何工作', subtitle: '用大白话看懂一次自动开发从需求到验收的全过程', hash: '#/guide' },
  live: { title: '研发实况', subtitle: '现在哪个项目、哪个任务、哪个 AI 在工作，以及下一步是什么', hash: '#/live' },
  replay: { title: '历史回放', subtitle: '从真实事件、尝试、审计和 Git 记录重建 Consumption Decision Lab 的开发过程', hash: '#/replay' },
};

const INSIGHT_GUIDE_STEPS = [
  {
    title: '我提出需求',
    simple: '我用普通语言写下想要的产品目标、边界和验收标准。',
    question: '工作台收到什么？',
    input: '项目路径、产品目标、验收标准、测试命令、哪些文件不能改。',
    output: '一条可执行的研发运行请求。',
    known: '工作台先检查预算、审计资源和安全边界，再决定是否开始。',
    fail: '目标或验收标准为空、资源不足时不会开始，会保存检查点并说明原因。',
    tech: 'POST /api/runs 或研发循环；Policy 层执行预算、保护路径、独立审计预检。',
  },
  {
    title: '工作台理解目标',
    simple: '工作台把目标、验收标准、测试命令和项目约束整理成每个任务的上下文。',
    question: '它负责做什么？',
    input: '产品目标、验收标准、项目配置、冻结测试。',
    output: '任务上下文、冻结契约、测试命令、受保护文件清单。',
    known: '上下文写进任务与提示词，并记录到事件和 artifacts。',
    fail: '无法读取项目/测试或契约缺失时，任务会在编码前阻塞。',
    tech: 'LoopManager / Planner / Orchestrator；Policy 校验 protectedPaths、testCommand。',
  },
  {
    title: 'AI 制定开发任务',
    simple: '工作台把目标拆成有顺序的任务；本轮真实历史中，任务队列由研发循环显式下发，不是模型自由发挥。',
    question: '任务从哪里来？',
    input: '目标、验收标准、任务队列或规划器生成的计划。',
    output: '带 seq、验收标准、测试命令和 Agent 的任务列表。',
    known: '任务写入 SQLite，按顺序进入 run；状态从 queued → coding。',
    fail: '计划为空或无法执行时，运行不会假装开始。',
    tech: 'Planner（单任务/计划模式）或显式 queue；tasks 表保存 acceptance_json、test_command、protectedPaths。',
  },
  {
    title: 'Claude Code / GLM 编写代码',
    simple: 'Claude Code 拿着当前任务去改代码。它只能改允许的文件，不能改冻结测试。',
    question: '它负责做什么？',
    input: '任务描述、验收标准、测试命令、冻结契约、当前代码副本。',
    output: '代码修改、Agent 总结、真实工具调用记录（能看到什么就展示什么）。',
    known: 'Agent 进程退出、事件记录完成、工作副本指纹变化；工作台随后自己跑测试。',
    fail: '卡住/超时由看门狗终止；失败分类后换新会话或备选 Agent；不会把超时当成功。',
    tech: 'Claude Code headless CLI（GLM 端点）；acceptEdits + 工具白名单；watchdog 同时看事件与 worktree 指纹。',
  },
  {
    title: '自动测试',
    simple: '工作台运行项目自己的测试命令，例如 npm test。测试是验收的一部分，不是走过场。',
    question: '谁来跑测试？',
    input: '项目测试命令、工作副本、测试超时配置。',
    output: '退出码、stdout/stderr、测试产物、测试指纹。',
    known: '退出码为 0 且测试前后工作树指纹一致，才进入审计。',
    fail: '测试失败 → 把真实输出交回 Claude Code 修复；同一失败重复出现会停止无限重试。',
    tech: 'runner.js；测试命令在隔离/受限环境运行；测试文件受保护，Agent 不能改。',
  },
  {
    title: 'DeepSeek Harness 独立检查',
    simple: '另一个 AI（DSH）只读检查代码，逐条核对验收标准，给出 PASS / FAIL / UNKNOWN 和具体证据。',
    question: '它检查什么？',
    input: '任务、验收标准、代码、diff、commit、测试结果。',
    output: '逐条结论、分数、证据、修复建议；不只是最终一句话。',
    known: '审计模型必须与编码模型族不同；审计结果和 commit 绑定；没有证据不能 PASS。',
    fail: '审计不可用/证据不足/超时 → UNKNOWN 或阻塞，绝不自动改 PASS。',
    tech: 'src/auditors/dsh.js；独立只读审计工作区；finalizeAuditVerdict 校验每条验收标准的证据。',
  },
  {
    title: '发现问题 → 自动修改 → 重新测试、检查',
    simple: '测试或审计不通过时，工作台把具体问题交回 Claude Code；它修完后重新测试、重新审计。',
    question: '谁负责修复？',
    input: '失败测试输出、审计 required_fixes、原任务上下文。',
    output: '新的代码修改、新 commit、新的测试和审计记录。',
    known: '每轮尝试写入 attempts；最多 maxAttempts 次，超过后阻塞并保留检查点。',
    fail: '无法修复/连续失败会暂停，不会伪装通过；人可以查看证据后决定取消、恢复或调整任务。',
    tech: 'attempts、failure_class、maxAttempts、审计 required_fixes；修复仍是 Coding Agent 的工作。',
  },
  {
    title: '检查通过',
    simple: '只有测试通过、审计逐条都有证据且不冲突，工作台才认为这个任务完成。',
    question: '工作台如何判定通过？',
    input: '测试结果 + 审计 criteria + commit 指纹。',
    output: 'task_passed 事件、审计记录、verification_json。',
    known: '状态变为 passed；Git commit 与被测试、被审计的版本一致。',
    fail: '任一条验收标准未证实或审计 UNKNOWN，任务不会标记通过。',
    tech: 'verification_json 绑定 testedHash、commit、auditId；任务状态机 passed 是严格条件。',
  },
  {
    title: '保存代码',
    simple: '通过后，代码被保存成一个真实的 Git commit，并记录对应的审计和测试。',
    question: '代码存在哪里？',
    input: '已验证的工作副本、提交信息、审计结果。',
    output: 'Git commit、计划分支、可回看的 diff。',
    known: 'commit SHA 写入任务与运行；验收时可以精确指回版本。',
    fail: '提交内容与测试/审计版本不一致时拒绝提交。',
    tech: 'git commitAll + tree 指纹校验；独立分支，不自动合并主分支。',
  },
  {
    title: '自动开始下一个任务',
    simple: '一个任务通过后，工作台把下一个任务交给 Claude Code，重复编码→测试→审计。',
    question: '下一步谁决定？',
    input: '研发循环队列、当前 run 状态、剩余任务。',
    output: '下一个任务开始事件；或全部完成后的等待验收状态。',
    known: 'loop_round_completed / loop_completed；每个任务都有独立证据。',
    fail: '队列里没有可执行任务就正常结束；被阻塞/预算不足则暂停，不制造假任务。',
    tech: 'LoopManager 顺序推进；run/loop 状态机；每个任务独立 commit/audit。',
  },
  {
    title: '全部完成，等待用户验收',
    simple: '全部任务完成后，工作台停在这里等你验收；不会自动合并主分支或部署。',
    question: '最后交给我什么？',
    input: '所有任务的测试、审计、commit、成本、失败记录。',
    output: '可验收的运行、独立审计证据、PR（若授权）、真实的成本与限制。',
    known: 'run.status=awaiting_acceptance；验收是人工决定。',
    fail: '仍有阻塞/未解决项时不会显示全部完成；会明确标 UNKNOWN/FAIL/BLOCKED。',
    tech: 'acceptance/CI 闸门；neverMerge；Draft PR；人工验收接口。',
  },
];

function fmtBeijingTime(value, withDate = false) {
  if (!value) return '未记录';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '未记录';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false,
      ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(d);
  } catch { return String(value); }
}

function fmtBeijingFull(value) {
  if (!value) return '未记录';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '未记录';
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  } catch { return String(value); }
}

function fmtDurationCn(ms) {
  const n = Number(ms || 0);
  if (!n) return '0 分钟';
  const mins = Math.floor(n / 60000);
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours > 0) return `${hours} 小时 ${rest} 分钟`;
  return `${mins} 分钟`;
}

function fmtCny(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '未记录';
  return `¥${n.toFixed(n < 1 ? 4 : 2)}`;
}

function insightPill(label, tone) { return el('span', { className: `insight-pill tone-${tone || 'gray'}`, text: label }); }

function insightButton(label, onClick, cls = 'button button-ghost button-sm') {
  return el('button', { className: cls, text: label, attrs: { type: 'button' }, on: { click: onClick } });
}

function insightSection(title, subtitle, children) {
  return el('section', { className: 'insight-section' }, [
    el('div', { className: 'insight-section-title' }, [
      el('h2', { text: title }),
      subtitle ? el('span', { text: subtitle }) : null,
    ]),
    ...children.filter(Boolean),
  ]);
}

function insightHeader(view) {
  const meta = INSIGHT_META[view];
  return el('div', { className: 'insight-head' }, [
    el('div', {}, [
      el('span', { className: 'insight-eyebrow', text: 'SEE THE WORKBENCH' }),
      el('h1', { text: meta.title }),
      el('p', { text: meta.subtitle }),
    ]),
    insightButton('返回项目', () => exitInsight(), 'button button-ghost button-sm insight-back'),
  ]);
}

function renderInsight() {
  if (!dom.insightContent || !app.insightView) return;
  document.body.classList.add('insight-mode');
  document.querySelectorAll('.insight-nav-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.insight === app.insightView));
  // 轮询刷新时保留用户展开的 <details> 与焦点，避免每 5 秒把阅读位置重置。
  const oldDetails = [...dom.insightContent.querySelectorAll('details')];
  const openStates = oldDetails.map((d) => d.open);
  const activeEl = document.activeElement;
  const activeDetail = activeEl && activeEl.closest ? activeEl.closest('#insightContent details') : null;
  const activeDetailIndex = activeDetail ? oldDetails.indexOf(activeDetail) : -1;
  const scrollY = window.scrollY;
  clearNode(dom.insightContent);
  dom.insightContent.append(insightHeader(app.insightView));
  if (app.insightView === 'guide') dom.insightContent.append(buildGuide());
  else if (app.insightView === 'live') {
    if (app.liveError) dom.insightContent.append(el('div', { className: 'insight-error', text: `研发实况读取失败：${app.liveError}${app.liveData ? '（下面保留上一次成功读取的快照，已标注可能过期）' : ''}` }));
    if (app.liveData) dom.insightContent.append(buildLive(app.liveData));
    else if (!app.liveError) dom.insightContent.append(el('div', { className: 'insight-loading', text: '正在读取真实的研发实况…' }));
  } else if (app.insightView === 'replay') {
    if (app.replayError) dom.insightContent.append(el('div', { className: 'insight-error', text: `历史回放读取失败：${app.replayError}` }));
    else if (app.replayData) dom.insightContent.append(buildReplay(app.replayData));
    else dom.insightContent.append(el('div', { className: 'insight-loading', text: '正在从 SQLite / 事件 / 审计 / Git 重建历史…' }));
  }
  const newDetails = [...dom.insightContent.querySelectorAll('details')];
  newDetails.forEach((d, i) => { if (openStates[i]) d.open = true; });
  if (activeDetailIndex >= 0) {
    const target = newDetails[activeDetailIndex]?.querySelector('summary');
    if (target) target.focus({ preventScroll: true });
  }
  if (scrollY > 0) window.scrollTo(0, scrollY);
}

function buildGuide() {
  const flow = el('div', { className: 'guide-flow' });
  const main = [
    INSIGHT_GUIDE_STEPS[0], INSIGHT_GUIDE_STEPS[1], INSIGHT_GUIDE_STEPS[2], INSIGHT_GUIDE_STEPS[3],
    INSIGHT_GUIDE_STEPS[4], INSIGHT_GUIDE_STEPS[5], INSIGHT_GUIDE_STEPS[6], INSIGHT_GUIDE_STEPS[7],
    INSIGHT_GUIDE_STEPS[8], INSIGHT_GUIDE_STEPS[9], INSIGHT_GUIDE_STEPS[10],
  ];
  main.forEach((step, index) => {
    const details = el('details', { className: 'guide-step' });
    if (index === 0) details.setAttribute('open', '');
    details.append(el('summary', {}, [
      el('span', { className: 'guide-step-num', text: String(index + 1).padStart(2, '0') }),
      el('span', { className: 'guide-step-copy' }, [
        el('strong', { text: step.title }),
        el('small', { text: step.simple }),
      ]),
      el('span', { className: 'guide-step-chevron', text: '›' }),
    ]));
    const body = el('div', { className: 'guide-step-body' });
    for (const [label, text] of [
      ['它负责做什么？', step.simple], ['它会接收什么？', step.input], ['它产生什么结果？', step.output],
      ['工作台怎么知道完成了？', step.known], ['失败之后谁负责处理？', step.fail],
    ]) {
      body.append(el('div', { className: 'guide-qa' }, [el('span', { text: label }), el('p', { text })]));
    }
    body.append(el('div', { className: 'guide-qa guide-tech' }, [el('span', { text: '技术细节（可跳过）' }), el('p', { text: step.tech })]));
    details.append(body);
    flow.append(details);
    if (index === 6) flow.append(el('div', { className: 'guide-loop', text: '↻ 失败时回到编码；修复后重新测试、重新审计。这一步最多重复有限次数，不会无限重试或伪造通过。' }));
  });
  return el('div', { className: 'view' }, [
    el('div', { className: 'insight-card insight-card-pad' }, [
      el('p', { className: 'insight-muted', style: { margin: 0, fontSize: '12px', lineHeight: '1.8' }, text: '最简单的理解：工作台像一位项目经理。它把目标拆成任务，让 Claude Code 写代码，自己跑测试，再请另一位 AI 只读检查；任何一步失败都会回到修复，全部有证据后才保存代码、进入下一项。' }),
    ]),
    flow,
    insightSection('两个关键原则', '为什么不能把“测试通过”直接当成功', [
      el('div', { className: 'insight-card insight-card-pad' }, [
        el('p', { className: 'insight-muted', style: { margin: 0, lineHeight: '1.9', fontSize: '12px' }, text: '1）写代码的 AI 和检查代码的 AI 必须是不同模型族，且检查只读；2）检查必须逐条回答冻结验收标准并给出证据，缺证据就是 UNKNOWN，不能自动变成 PASS。测试通过只是产品可工作的证据之一，不等于产品绝对没有缺陷。' }),
      ]),
    ]),
  ]);
}

const LIVE_EVENT_META = {
  project_created: { label: '项目建立', tone: 'blue' }, loop_created: { label: '循环创建', tone: 'blue' },
  loop_round_started: { label: '新一轮开始', tone: 'blue' }, run_created: { label: '运行创建', tone: 'gray' },
  run_started: { label: '运行开始', tone: 'blue' }, task_started: { label: '任务开始', tone: 'blue' },
  pipeline_resource_checked: { label: '资源预检', tone: 'cyan' }, pipeline_resource_blocked: { label: '资源阻塞', tone: 'amber' },
  worktree_ready: { label: '工作副本', tone: 'gray' }, agent_started: { label: 'AI 开始工作', tone: 'blue' },
  agent_progress: { label: 'AI 进度', tone: 'blue' }, agent_finished: { label: 'AI 完成本轮', tone: 'green' },
  agent_failed: { label: 'AI 失败', tone: 'red' }, agent_fallback: { label: '换新会话/备选', tone: 'amber' },
  test_started: { label: '测试开始', tone: 'purple' }, test_passed: { label: '测试通过', tone: 'green' }, test_failed: { label: '测试失败', tone: 'red' },
  audit_started: { label: '审计开始', tone: 'purple' }, audit_passed: { label: '审计通过', tone: 'green' },
  audit_unknown: { label: '审计未证实', tone: 'amber' }, audit_error: { label: '审计错误', tone: 'red' },
  repair_requested: { label: '要求修复', tone: 'amber' }, audit_commit_created: { label: '创建审计 commit', tone: 'gray' },
  task_passed: { label: '任务通过', tone: 'green' }, task_failed: { label: '任务失败', tone: 'red' }, task_error: { label: '任务异常', tone: 'red' },
  run_paused: { label: '运行暂停', tone: 'amber' }, run_resumed: { label: '运行恢复', tone: 'blue' },
  run_interrupted: { label: '运行中断', tone: 'amber' }, run_cancelled: { label: '运行取消', tone: 'gray' },
  loop_completed: { label: '循环完成', tone: 'green' }, loop_round_completed: { label: '一轮完成', tone: 'green' },
  loop_paused: { label: '循环暂停', tone: 'amber' }, loop_cancelled: { label: '循环取消', tone: 'gray' },
  run_awaiting_acceptance: { label: '等待验收', tone: 'cyan' }, publish_blocked: { label: '发布阻塞', tone: 'amber' },
  verification_retry_started: { label: '仅重试验证', tone: 'cyan' }, run_reconciled: { label: '恢复对账', tone: 'cyan' },
};

function liveEventTitle(evt) {
  const meta = LIVE_EVENT_META[evt.type] || { label: evt.type || '事件', tone: EVENT_LEVEL[evt.level]?.tone || 'gray' };
  const msg = String(evt.message || '').split('\n')[0];
  return { meta, text: msg || meta.label };
}

function buildLive(data) {
  const wrap = el('div', { className: 'view' });
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const select = el('select', { className: 'live-project-select', attrs: { 'aria-label': '选择要观察的项目' } });
  for (const p of projects) {
    const opt = el('option', { text: p.name, attrs: { value: p.id } });
    if (data.project?.id === p.id) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => loadLive(select.value, { force: true }));
  wrap.append(el('div', { className: 'live-top' }, [
    el('div', {}, [el('h2', { style: { margin: '0 0 4px', fontSize: '16px' }, text: data.project?.name || '项目' }), el('p', { className: 'insight-note', style: { margin: 0 }, text: `数据快照：${fmtBeijingFull(data.generatedAt)}（北京时间）${data.active ? ' · 实时刷新中' : ' · 当前没有活跃运行'}${app.liveError ? ' · 当前显示的是上一次成功快照' : ''}` })]),
    select,
  ]));
  if (!data.project) {
    wrap.append(el('div', { className: 'live-empty' }, [el('strong', { text: '还没有可观察的项目' }), el('p', { text: data.reason || '添加并启动一个项目后，这里会显示真实的任务、Agent 和事件。' })]));
    return wrap;
  }
  const run = data.run;
  const task = data.task;
  const stageLabel = { coding: '编码中', testing: '测试中', auditing: '独立审计中', repairing: '修复中', committing: '保存代码中', preparing: '准备中', running: '运行中', passed: '已完成', failed: '失败', blocked: '阻塞', queued: '排队中', awaiting_acceptance: '等待验收', paused: '已暂停', interrupted: '已中断', cancelled: '已取消' }[data.stage] || data.stage || '未记录';
  const liveAgentLabel = data.active ? (agentLabelOrKind(data.agent) || data.agent || '未记录') : '没有 AI 正在工作';
  const progress = data.progress || { total: 0, passed: 0 };
  const metrics = [
    ['项目状态', run ? (RUN_STATUS[run.status]?.label || run.status) : '没有运行记录', run?.id ? shortId(run.id, 16) : '未记录'],
    ['已完成任务', `${progress.passed} / ${progress.total}`, progress.total ? '当前运行/最近一轮' : '没有任务记录'],
    ['当前 Agent', liveAgentLabel, data.active ? '机器上的真实执行者' : '如实显示：空闲'],
    ['当前阶段', stageLabel, data.task?.title || '未记录当前任务'],
    ['已运行时间', run ? fmtDurationCn(data.elapsedMs) : '未记录', run?.started_at ? `开始 ${fmtBeijingTime(run.started_at)}` : '无开始时间'],
    ['模型费用', run ? fmtCny(data.costCny) : '未记录', run ? `${fmtTokens(data.tokens)} tokens` : '无费用记录'],
  ];
  wrap.append(el('div', { className: 'live-summary' }, metrics.map(([label, value, sub], i) => el('div', { className: `live-metric${i < 3 ? ' is-current' : ''}` }, [el('span', { text: label }), el('strong', { text: value }), el('small', { text: sub })]))));
  const nowText = data.active
    ? (task ? `${liveAgentLabel} 正在${stageLabel}` : '运行中，等待任务状态更新')
    : (run ? (run.status === 'interrupted' ? '现在没有 AI 在工作：最近一次运行已中断，检查点已保留。' : run.status === 'paused' ? '现在没有 AI 在工作：最近一次运行已暂停，检查点已保留。' : '现在没有 AI 在工作。下面是上一次真实运行的状态。') : '这个项目还没有运行记录。');
  wrap.append(el('div', { className: 'live-now' }, [
    el('div', { className: 'live-now-icon', text: data.active ? '▶' : '—' }),
    el('div', { className: 'live-now-copy' }, [
      el('strong', { text: nowText }),
      el('p', { text: task ? `当前任务：${task.title}` : (run?.goal || '暂无任务记录') }),
      task && task.blocked_reason ? el('p', { style: { color: 'var(--amber)' }, text: `阻塞原因：${task.blocked_reason}` }) : null,
    ]),
  ]));
  wrap.append(el('div', { className: 'live-next', text: `下一步：${data.nextStep || '无可用计划'}` }));
  const timeline = el('ol', { className: 'live-timeline' });
  for (const evt of (data.events || []).slice().reverse()) {
    const { meta, text } = liveEventTitle(evt);
    const details = el('details', { className: 'live-event-body' });
    details.append(el('summary', {}, [el('div', { className: 'live-event-title' }, [el('strong', { text }), insightPill(meta.label, meta.tone)])]));
    const detail = el('div', { className: 'live-event-detail' }, [
      el('div', { text: `类型：${evt.type || '未记录'} · 时间：${fmtBeijingFull(evt.created_at)}（北京时间）` }),
      el('div', { className: 'insight-note', style: { marginTop: '4px' }, text: evt.run_id ? `运行：${evt.run_id}${evt.task_id ? ` · 任务：${evt.task_id}` : ''}` : '项目级事件' }),
    ]);
    if (evt.data && Object.keys(evt.data).length) detail.append(el('pre', { text: JSON.stringify(evt.data, null, 2).slice(0, 5000) }));
    if (evt.run_id) detail.append(insightButton('打开这次运行', () => { exitInsight({ silent: true }); selectRun(evt.run_id, { scroll: true }); }, 'replay-evidence-link'));
    details.append(detail);
    const line = el('span', { className: 'live-event-line' });
    line.append(el('span', { className: `live-event-dot tone-${meta.tone || 'gray'}` }));
    timeline.append(el('li', { className: 'live-event' }, [
      el('span', { className: 'live-event-time', text: fmtBeijingTime(evt.created_at) }),
      line,
      details,
    ]));
  }
  if (!timeline.children.length) {
    timeline.append(el('li', { className: 'live-empty' }, [el('strong', { text: '没有可显示的事件' }), el('p', { text: data.reason || '该项目尚未运行，因此没有真实时间线。' })]));
  }
  wrap.append(insightSection('AI 工作时间线', '按真实事件时间倒序（最新在上；最多最近 60 条）；点击每条可展开原始记录', [el('div', { className: 'insight-card insight-card-pad' }, [timeline])]));
  wrap.append(el('p', { className: 'insight-note', text: '只展示工作台实际记录的事件、工具调用、测试、审计和输出；不展示或编造模型内部思考。没有记录的字段会显示“未记录”。' }));
  return wrap;
}

function agentLabelOrKind(kind) {
  if (!kind) return '';
  const key = String(kind).toLowerCase();
  if (key.includes('claude')) return 'Claude Code / GLM';
  if (key.includes('dsh')) return 'DeepSeek Harness';
  if (key.includes('deepseek')) return 'DeepSeek';
  return kind;
}

function replayStatusPill(status) {
  const toneMap = { passed: 'green', completed: 'green', failed: 'red', blocked: 'amber', cancelled: 'gray', coding: 'blue', testing: 'purple', auditing: 'purple', repairing: 'amber', awaiting_acceptance: 'cyan', paused: 'amber', interrupted: 'amber', queued: 'gray' };
  const labelMap = { passed: '已通过', completed: '已完成', failed: '失败', blocked: '已阻塞', cancelled: '已取消', coding: '编码中', testing: '测试中', auditing: '审计中', repairing: '修复中', awaiting_acceptance: '等待验收', paused: '已暂停', interrupted: '已中断', queued: '排队中' };
  return insightPill(labelMap[status] || status || '未记录', toneMap[status] || 'gray');
}

function renderSimpleMode() { return app.replayMode !== 'tech'; }

function buildReplay(data) {
  const wrap = el('div', { className: 'view' });
  if (!data.available) {
    wrap.append(el('div', { className: 'live-empty' }, [el('strong', { text: data.reason || '没有可回放的真实历史' }), el('p', { text: '历史回放只展示 SQLite、事件、attempts、audits、Git 和证据文件中的真实记录；不会用演示数据填充。' })]));
    return wrap;
  }
  const meta = el('div', { className: 'replay-bar' }, [
    el('div', { className: 'insight-note', text: `回放项目：${data.project.name} · 时间统一为北京时间（${data.timezone}） · 数据生成于 ${fmtBeijingFull(data.generatedAt)}` }),
    el('div', { className: 'replay-toggle', attrs: { role: 'group', 'aria-label': '讲解模式' } }, [
      el('button', { className: app.replayMode !== 'tech' ? 'is-active' : '', text: '简单讲解', attrs: { type: 'button' }, on: { click: () => { app.replayMode = 'simple'; renderInsight(); } } }),
      el('button', { className: app.replayMode === 'tech' ? 'is-active' : '', text: '技术详情', attrs: { type: 'button' }, on: { click: () => { app.replayMode = 'tech'; renderInsight(); } } }),
    ]),
  ]);
  wrap.append(meta);
  const actNames = [
    ['我提出了什么需求', '原始目标与冻结契约'],
    ['工作台制定了什么任务', '计划与实际任务记录'],
    ['Claude Code 实际怎么开发', '编码尝试、失败与恢复'],
    ['DeepSeek Harness 怎么审计', '逐条检查与修复要求'],
    ['最终交付了什么', '产品、测试、commit 与成本'],
  ];
  const acts = el('div', { className: 'replay-acts', attrs: { role: 'tablist', 'aria-label': '回放五幕' } });
  actNames.forEach(([name, sub], i) => {
    const active = (app.replayAct || 0) === i;
    acts.append(el('button', { className: `replay-act-btn${active ? ' is-active' : ''}`, attrs: { type: 'button', role: 'tab', 'aria-selected': String(active) }, on: { click: () => { app.replayAct = i; app.replayTimeline = false; renderInsight(); } } }, [
      el('span', { text: `第${'一二三四五'[i]}幕 · ${name}` }), el('small', { text: sub }),
    ]));
  });
  acts.append(el('button', { className: `replay-act-btn${app.replayTimeline ? ' is-active' : ''}`, attrs: { type: 'button', role: 'tab', 'aria-selected': String(!!app.replayTimeline) }, on: { click: () => { app.replayTimeline = true; renderInsight(); } } }, [el('span', { text: '按时间线看全部事件' }), el('small', { text: '原始事件顺序' })]));
  wrap.append(acts);
  const stage = el('div', { className: 'replay-stage' });
  if (app.replayTimeline) {
    stage.append(buildReplayTimeline(data));
  } else {
    const act = Number(app.replayAct || 0);
    stage.append(...buildReplayAct(data, act));
    const nav = el('div', { className: 'replay-nav', style: { marginTop: '18px' } }, [
      insightButton('← 上一步', () => { app.replayAct = Math.max(0, act - 1); renderInsight(); }, 'button button-ghost button-sm'),
      el('div', { className: 'replay-dots' }, actNames.map((_, i) => el('span', { className: `replay-dot${i === act ? ' is-active' : ''}` }))),
      insightButton('下一步 →', () => { app.replayAct = Math.min(actNames.length - 1, act + 1); renderInsight(); }, 'button button-primary button-sm'),
    ]);
    stage.append(nav);
  }
  wrap.append(stage);
  if (!app.replayTimeline && (app.replayAct || 0) === 4) wrap.append(buildSummary(data));
  return wrap;
}

function buildReplayAct(data, act) {
  if (act === 0) return buildActRequirement(data);
  if (act === 1) return [buildActTasks(data)];
  if (act === 2) return [buildActCoding(data)];
  if (act === 3) return [buildActAudits(data)];
  return [buildActDelivery(data)];
}

function buildActRequirement(data) {
  const origin = data.origin || {};
  const contract = String(origin.contractText || '').split('\n').slice(0, 24).join('\n');
  return [
    el('h2', { text: '第一幕：我提出了什么需求？' }),
    el('p', { className: 'replay-stage-sub', text: '以下是冻结记录中的原始目标、研发循环目标与契约原文。原始聊天消息没有写入数据库，因此不做“凭记忆补录”。' }),
    el('div', { className: 'replay-requirement' }, [
      el('div', { className: 'replay-quote' }, [
        el('div', { text: origin.projectDescription || '项目描述未记录' }),
        ...((origin.loopGoals || []).slice(0, 3).map((g) => el('div', { style: { marginTop: '10px' }, text: `研发目标：${g.goal}` }))),
        el('small', { text: origin.note || '原始聊天记录未入库；以上来自项目与 loop 记录。' }),
      ]),
      el('div', { className: 'replay-source-list' }, [
        el('div', { className: 'replay-source' }, [el('strong', { text: '冻结契约文件' }), el('br'), el('code', { text: origin.contractPath || '未记录' }), el('div', { style: { marginTop: '5px', whiteSpace: 'pre-wrap', maxHeight: '260px', overflow: 'auto' }, text: contract || '未记录契约原文' })]),
        el('div', { className: 'replay-source' }, [el('strong', { text: '项目创建时间' }), el('br'), el('span', { text: fmtBeijingFull(data.project.created_at) })]),
        el('div', { className: 'replay-source' }, [el('strong', { text: '验收物料' }), el('br'), el('span', { text: `冻结测试 9 项、浏览器流程、可追溯证据库；产品契约与测试在开发前冻结。` })]),
      ]),
    ]),
    el('p', { className: 'insight-note', style: { marginTop: '12px' }, text: '说明：源码作者归属为 UNKNOWN（没有逐行人工修改审计）；数据库中的 coding attempts 均记录为 Claude Code/GLM。测试/契约由验收方预先冻结，AI 负责编码和修复。' }),
  ];
}

function replayTaskCard(t) {
  const taskDetails = el('details', { className: 'replay-task', style: { display: 'block', padding: '10px 12px' } });
  taskDetails.append(el('summary', { style: { cursor: 'pointer' } }, [el('div', { className: 'replay-task-main', style: { display: 'inline-block', marginLeft: '6px' } }, [el('strong', { text: `#${t.seq || '?'} ${t.title}` }), el('p', { text: `状态：${t.status} · 运行：${t.run_id || '未记录'}${t.head_commit ? ` · commit ${shortHash(t.head_commit)}` : ' · 没有 commit'}` })])]));
  const body = el('div', { style: { marginTop: '8px', color: 'var(--text-2)', fontSize: '11.5px', lineHeight: '1.7' } }, [
    el('p', { style: { margin: '0 0 4px' }, text: t.description || '描述未记录' }),
    el('p', { style: { margin: '0 0 4px' }, text: `验收：${(t.acceptance || []).join('；') || '未记录'}` }),
    t.blocked_reason ? el('p', { style: { margin: 0, color: 'var(--amber)' }, text: `阻塞原因：${t.blocked_reason}` }) : null,
  ]);
  if (!renderSimpleMode()) body.append(el('pre', { text: JSON.stringify({ id: t.id, run_id: t.run_id, base_commit: t.base_commit, head_commit: t.head_commit, verification: t.verification }, null, 2).slice(0, 5000) }));
  taskDetails.append(body);
  return taskDetails;
}

function buildActTasks(data) {
  const loops = data.loops || [];
  const shownTaskIds = new Set();
  const children = [
    el('h2', { text: '第二幕：工作台制定了什么开发任务？' }),
    el('p', { className: 'replay-stage-sub', text: '任务来自研发循环的显式队列，而不是模型自由编造。任务失败后，工作台会用新的任务重新验证，但保留旧任务和失败记录。' }),
  ];
  for (const loop of loops) {
    const queue = Array.isArray(loop.queue) ? loop.queue : [];
    const loopRunIds = new Set([
      loop.current_run_id, loop.last_run_id,
      ...(Array.isArray(loop.history) ? loop.history.map((h) => h.runId) : []),
    ].filter(Boolean));
    const loopTasks = (data.tasks || []).filter((t) => loopRunIds.has(t.run_id));
    const card = el('details', { className: 'replay-source', style: { marginBottom: '8px' }, attrs: { open: '' } });
    card.append(el('summary', { style: { cursor: 'pointer' } }, [
      el('strong', { text: loop.goal || '目标未记录' }),
      el('div', { className: 'insight-note', style: { marginTop: '3px' }, text: `loop ${loop.id} · ${loop.status} · ${fmtBeijingFull(loop.created_at)} · 实际任务记录 ${loopTasks.length} 条` }),
    ]));
    if (queue.length) {
      card.append(el('div', { style: { marginTop: '8px' }, text: '计划任务：' }));
      for (const q of queue) card.append(el('div', { className: 'replay-source', style: { marginTop: '5px' } }, [el('strong', { text: q.title || '未命名任务' }), el('p', { style: { margin: '3px 0 0' }, text: q.description || '' })]));
    }
    card.append(el('div', { style: { marginTop: '8px' }, text: '实际任务记录：' }));
    for (const t of loopTasks) {
      shownTaskIds.add(t.id);
      card.append(replayTaskCard(t));
    }
    if (!loopTasks.length) card.append(el('p', { className: 'insight-note', text: '该循环没有实际任务记录。' }));
    children.push(card);
  }
  const remainingTasks = (data.tasks || []).filter((t) => !shownTaskIds.has(t.id));
  if (remainingTasks.length) {
    const other = el('details', { className: 'replay-source', style: { marginBottom: '8px' }, attrs: { open: '' } });
    other.append(el('summary', { style: { cursor: 'pointer' } }, [el('strong', { text: '其他真实任务记录（失败 / 阻塞 / 被替换）' }), el('div', { className: 'insight-note', style: { marginTop: '3px' }, text: '这些任务没有关联到带 history 的循环，但 SQLite 中有真实记录，不能省略。' })]));
    for (const t of remainingTasks) other.append(replayTaskCard(t));
    children.push(other);
  }
  children.push(el('p', { className: 'insight-note', text: `平台共留下 ${data.stats?.projectTaskRecords ?? 0} 条任务记录；最终交付运行只包含最后通过的那一项。记录数不是“产品功能数”，中间失败/替换任务都保留。` }));
  return el('div', { className: 'replay-task-list' }, children);
}

function attemptStatusTone(status) {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'interrupted') return 'amber';
  return 'blue';
}

function buildActCoding(data) {
  const attempts = (data.attempts || []).slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const tasks = new Map((data.tasks || []).map((t) => [t.id, t]));
  const children = [
    el('h2', { text: '第三幕：Claude Code 实际怎么开发？' }),
    el('p', { className: 'replay-stage-sub', text: '下面按真实时间列出每一次编码尝试、失败原因、耗时和 token；点击展开可看到当时的任务提示词与日志位置。没有记录的字段显示未记录。' }),
  ];
  if (!attempts.length) children.push(el('p', { className: 'insight-note', text: '没有 attempt 记录，无法重建编码过程。' }));
  const list = el('div', { className: 'replay-attempt-list' });
  for (const a of attempts) {
    const task = tasks.get(a.task_id);
    const det = el('details', { className: 'replay-attempt' });
    det.append(el('summary', {}, [
      el('strong', { text: `${fmtBeijingFull(a.started_at)} · ${task?.title || a.task_id}` }),
      replayStatusPill(a.status),
      insightPill(agentLabelOrKind(a.agent_kind) || 'Agent 未记录', 'blue'),
      a.failure_class ? insightPill(a.failure_class, 'amber') : null,
    ]));
    const body = el('div', { className: 'replay-attempt-body' }, [
      el('div', { text: `尝试 #${a.attempt_no ?? '未记录'} · 状态：${a.status || '未记录'} · 耗时：${a.duration_ms ? fmtDurationCn(a.duration_ms) : '未记录'} · tokens：${fmtTokens((a.tokens_in || 0) + (a.tokens_out || 0))} · 费用：${fmtCny(a.cost_cny)}（${a.cost_source || '来源未记录'}）` }),
      a.error ? el('p', { style: { color: 'var(--red)', margin: '5px 0' }, text: `错误：${a.error}` }) : null,
      task ? el('p', { style: { margin: '5px 0' }, text: `任务目标：${task.description || task.title}` }) : null,
      renderSimpleMode() ? null : el('p', { className: 'insight-note', text: `attempt id: ${a.id} · provider: ${a.provider || '未记录'} · model: ${a.model || '未记录'} · log: ${a.log_path || '未记录'}` }),
    ]);
    const prompt = el('details', { className: 'replay-attempt replay-attempt-prompt', style: { marginTop: '7px' } });
    prompt.append(el('summary', { style: { cursor: 'pointer', padding: '8px 0' }, text: '查看当时给 AI 的任务提示词（原始记录）' }));
    prompt.append(el('pre', { text: a.prompt || '未记录提示词' }));
    body.append(prompt);
    det.append(body);
    list.append(det);
  }
  children.push(list);
  // 成功后代码/commit 文件变化
  const commits = data.commits || [];
  if (commits.length) {
    children.push(el('div', { className: 'insight-section-title', style: { marginTop: '16px' } }, [el('h2', { text: '实际保存的代码变化' }), el('span', { text: '来自 Git commit（只读）' })]));
    const commitList = el('div', { className: 'replay-task-list' });
    for (const c of commits) {
      const d = el('details', { className: 'replay-commit' });
      d.append(el('summary', {}, [el('strong', { text: c.subject || '提交未命名' }), insightPill(c.short || shortHash(c.sha), 'gray')]));
      const body = el('div', { className: 'replay-commit-body' }, [
        el('div', { className: 'replay-commit-code', text: `${fmtBeijingFull(c.date)} · ${c.sha}` }),
        el('div', { className: 'insight-note', style: { marginTop: '5px' }, text: (c.files || []).map((f) => `${f.status || '?'} ${f.path || ''}`).join('\n') || '文件列表未记录' }),
      ]);
      const cbtn = insightButton('读取这个 commit 的 diff', async () => {
        const pre = el('pre', { text: '正在读取真实 Git diff…' });
        body.append(pre); cbtn.disabled = true;
        try { const res = await apiRequest('GET', `/api/replay/consumption/commits/${encodeURIComponent(c.sha)}`); pre.textContent = `${res.stat || ''}\n\n${res.patch || ''}`.slice(0, 80000); }
        catch (err) { pre.textContent = `读取失败：${err.message}`; }
      }, 'replay-evidence-link');
      body.append(cbtn);
      d.append(body);
      commitList.append(d);
    }
    children.push(commitList);
    children.push(el('p', { className: 'insight-note', text: '这些 commit 来自独立 Git 历史，不是根据总结生成的。' }));
  } else {
    children.push(el('p', { className: 'insight-note', text: 'Git commit 记录未找到；无法确认代码变化。' }));
  }
  return el('div', {}, children);
}

function buildActAudits(data) {
  const audits = (data.audits || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const children = [
    el('h2', { text: '第四幕：DeepSeek Harness 是怎么审计的？' }),
    el('p', { className: 'replay-stage-sub', text: 'DSH 只读检查代码，逐条核对冻结验收标准。下面展示所有真实审计，包括 PASS、UNKNOWN 和修复要求；不能只展示最后的 PASS 100。' }),
  ];
  if (!audits.length) children.push(el('p', { className: 'insight-note', text: '没有审计记录，无法确认独立检查发生过。' }));
  const list = el('div', { className: 'replay-audit-list' });
  for (const a of audits) {
    const tone = a.verification_status === 'PASS' ? 'green' : a.verification_status === 'UNKNOWN' ? 'amber' : 'red';
    const det = el('details', { className: 'replay-audit', attrs: { open: '' } });
    det.append(el('summary', {}, [el('strong', { text: `${fmtBeijingFull(a.created_at)} · ${a.provider_source === 'dsh-cli' ? 'DSH 只读审计' : (a.provider || '审计')}` }), insightPill(`${a.verification_status || a.verdict || '未记录'} ${a.score ?? ''}`, tone), insightPill(a.commit ? `commit ${shortHash(a.commit)}` : 'commit 未记录', 'gray')]));
    const body = el('div', { className: 'replay-audit-body' }, [
      el('p', { style: { margin: '0 0 6px' }, text: a.summary || '审计总结未记录' }),
      el('div', { className: 'replay-criteria' }, (a.criteria || []).map((c) => {
        const ctone = c.status === 'pass' ? 'green' : c.status === 'fail' ? 'red' : 'amber';
        return el('div', { className: 'replay-criterion' }, [el('span', { className: 'replay-criterion-icon', style: { color: `var(--${ctone})` }, text: c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '?' }), el('div', {}, [el('p', { text: c.criterion || '未记录标准' }), el('small', { text: `证据：${c.evidence || '未提供'}；结论：${c.status || '未记录'}` })])]);
      })),
    ]);
    if ((a.requiredFixes || []).length) {
      body.append(el('div', { style: { color: 'var(--amber)', marginTop: '8px' }, text: '这次审计要求修复 / 未证实：' }));
      body.append(el('ul', { className: 'replay-fixlist' }, a.requiredFixes.map((f) => el('li', { text: f }))));
    }
    if (!renderSimpleMode()) {
      body.append(el('div', { className: 'insight-note', style: { marginTop: '8px' }, text: `audit id: ${a.id} · run: ${a.run_id} · task: ${a.task_id} · model: ${a.model || '未记录'} · tokens: ${fmtTokens(a.tokens)} · 费用：${fmtCny(a.cost_cny)}` }));
    }
    det.append(body);
    list.append(det);
  }
  children.push(list);
  children.push(el('div', { className: 'live-next', text: '审计结论是依据，不是装饰：PASS 必须绑定具体 commit 和逐条证据；UNKNOWN / FAIL 必须保留，不能改写成 PASS。' }));
  return el('div', {}, children);
}

function buildActDelivery(data) {
  const stats = data.stats || {};
  const final = data.final || {};
  const screenshots = data.media?.screenshots || [];
  const commits = data.commits || [];
  const finalCommit = commits.find((c) => c.sha === final.commit) || commits[commits.length - 1] || (data.tasks || []).find((t) => t.status === 'passed' && t.head_commit);
  const children = [
    el('h2', { text: '第五幕：最终交付了什么？' }),
    el('p', { className: 'replay-stage-sub', text: '产品真实界面来自当时的交付截图；测试、审计、commit 和成本来自原始记录。所有金额单位人民币，费用来源见下。' }),
  ];
  const gallery = el('div', { className: 'replay-gallery' });
  for (const shot of screenshots) gallery.append(el('a', { className: 'replay-shot', attrs: { href: shot.path, target: '_blank', rel: 'noopener noreferrer' } }, [el('img', { attrs: { src: shot.path, alt: shot.label, loading: 'lazy' } }), el('span', { text: shot.label })]));
  children.push(gallery);
  children.push(el('div', { className: 'replay-costgrid' }, [
    el('div', { className: 'live-metric' }, [el('span', { text: '最终代码 commit' }), el('strong', { text: finalCommit?.short || shortHash(final.commit || '') || '未记录' }), el('small', { text: final.commit || finalCommit?.sha || '未记录' })]),
    el('div', { className: 'live-metric' }, [el('span', { text: '产品源码位置' }), el('strong', { style: { fontSize: '11px' }, text: data.project.local_path || '未记录' }), el('small', { text: '独立 Git 仓库；无远端推送授权' })]),
    el('div', { className: 'live-metric' }, [el('span', { text: '测试结果' }), el('strong', { text: final.testPassedAt ? '测试通过事件已记录' : '未记录' }), el('small', { text: final.testEvidence ? `审计证据摘要：${final.testEvidence.slice(0, 100)}` : '无测试证据记录' })]),
    el('div', { className: 'live-metric' }, [el('span', { text: '审计结果' }), el('strong', { text: final.auditStatus ? `${final.auditStatus}${final.auditScore != null ? ` · ${final.auditScore}` : ''}` : '未记录' }), el('small', { text: final.auditCriteriaTotal ? `${final.auditCriteriaPassed}/${final.auditCriteriaTotal} 条验收标准通过（最终审计）` : '无审计证据记录' })]),
    el('div', { className: 'live-metric' }, [el('span', { text: '实际模型成本' }), el('strong', { text: fmtCny(stats.modelCost?.totalCny) }), el('small', { text: `编码 ${fmtCny(stats.modelCost?.codingCny)} + 审计 ${fmtCny(stats.modelCost?.auditCny)}` })]),
    el('div', { className: 'live-metric' }, [el('span', { text: '开发耗时' }), el('strong', { text: fmtDurationCn(stats.durationMs) }), el('small', { text: `${fmtBeijingFull(stats.start)} → ${fmtBeijingFull(stats.end)}` })]),
  ]));
  const commitBox = el('div', { style: { marginTop: '12px' } }, [el('div', { className: 'insight-section-title' }, [el('h2', { text: 'Git 提交链' }), el('span', { text: '点击查看真实 diff' })])]);
  for (const c of commits) {
    const det = el('details', { className: 'replay-commit' });
    det.append(el('summary', {}, [el('strong', { text: c.subject || '未命名' }), insightPill(c.short || shortHash(c.sha), 'gray')]));
    const body = el('div', { className: 'replay-commit-body' }, [el('div', { className: 'replay-commit-code', text: `${fmtBeijingFull(c.date)} · ${c.sha}` }), el('div', { className: 'insight-note', style: { marginTop: '4px' }, text: (c.files || []).map((f) => `${f.status || '?'} ${f.path || ''}`).join('\n') || '文件列表未记录' })]);
    const btn = insightButton('读取这个 commit 的 diff', async () => {
      const pre = el('pre', { text: '正在读取真实 Git diff…' });
      body.append(pre);
      btn.disabled = true;
      try {
        const res = await apiRequest('GET', `/api/replay/consumption/commits/${encodeURIComponent(c.sha)}`);
        pre.textContent = `${res.stat || ''}\n\n${res.patch || ''}`.slice(0, 80000);
      } catch (err) { pre.textContent = `读取失败：${err.message}`; }
    }, 'replay-evidence-link');
    body.append(btn);
    det.append(body);
    commitBox.append(det);
  }
  children.push(commitBox);
  children.push(el('p', { className: 'insight-note', text: '交付口径：通过测试与独立审计说明产品达到冻结验收标准，不等于产品绝对没有缺陷；本回放仍保留失败、重试和 UNKNOWN 记录。' }));
  return el('div', {}, children);
}

function buildReplayTimeline(data) {
  const events = (data.events || []).slice().sort((a, b) => a.id - b.id);
  const wrap = el('div', {});
  wrap.append(el('h2', { text: '按时间顺序看全部真实事件' }));
  wrap.append(el('p', { className: 'replay-stage-sub', text: `共 ${events.length} 条事件；时间已统一为北京时间。点击每条可看原始类型与数据。` }));
  if (!events.length) { wrap.append(el('div', { className: 'replay-empty', text: '没有事件记录，无法按时间线回放。' })); return wrap; }
  const list = el('div', { className: 'replay-timeline' });
  for (const evt of events) {
    const { meta, text } = liveEventTitle(evt);
    const d = el('details', { style: { borderBottom: '1px solid var(--border)' } });
    d.append(el('summary', { style: { cursor: 'pointer', padding: '6px 0', listStyle: 'none' } }, [el('div', { className: 'replay-event', style: { border: 0, padding: 0 } }, [el('time', { text: fmtBeijingTime(evt.created_at) }), el('div', {}, [el('p', {}, [el('strong', { text: `${meta.label}：` }), text]), el('small', { text: `${fmtBeijingFull(evt.created_at)} · ${evt.type || '未记录'} · ${evt.run_id || '项目级'}` })])])]));
    const body = el('div', { style: { padding: '6px 0 10px 62px', color: 'var(--text-2)', fontSize: '11px', lineHeight: '1.7' } }, [el('div', { text: `原始消息：${evt.message || '未记录'}` })]);
    if (evt.data && Object.keys(evt.data).length) body.append(el('pre', { text: JSON.stringify(evt.data, null, 2).slice(0, 4000) }));
    if (evt.run_id) body.append(insightButton('打开运行详情', () => { exitInsight({ silent: true }); selectRun(evt.run_id, { scroll: true }); }, 'replay-evidence-link'));
    d.append(body);
    list.append(d);
  }
  wrap.append(list);
  return wrap;
}

function buildSummary(data) {
  const stats = data.stats || {};
  const fixes = stats.requiredFixes || [];
  const categories = [
    ['AI 自主完成', `${stats.passedTasks || 0} 条任务记录通过；编码 attempts 记录为 Claude Code/GLM，但源码作者归属：${stats.provenanceStatus || 'UNKNOWN'}`, 'green'],
    ['Workbench 自动恢复后完成', `${stats.agentFailedEvents || 0} 次 Agent 失败事件；${stats.stalledAttempts || 0} 次 stalled/timeout/aborted 被看门狗处理；后续任务最终通过`, 'cyan'],
    ['外部人工介入完成', `已知操作记录：测试环境修正（Playwright 完整 Chromium，非产品源码）；产品代码人工修改：${stats.humanProductCodeEdits === 'UNKNOWN' ? 'UNKNOWN（无逐行审计记录）' : stats.humanProductCodeEdits}`, 'amber'],
    ['尚未完成 / 未解决', `${(stats.unresolved || []).length ? stats.unresolved.join('；') : '产品验收标准已通过'}；Workbench 的 Fencing Token、24h 连续验收仍是既有未完成项`, 'gray'],
    ['数据不足无法确认', '原始聊天消息未入库；部分尝试没有 diff/commit；UNKNOWN 审计的 provenance 结论没有被后续证明', 'gray'],
  ];
  const summary = el('div', { className: 'replay-summary' }, [
    el('h3', { text: '这次开发，AI 帮我完成了什么？' }),
    el('p', { text: '任务、尝试、审计、失败、耗时与费用来自 SQLite / 事件 / 审计 / Git 记录；“源码作者归属”没有逐行审计证据，按 UNKNOWN 显示，不把记录推断当确定事实。' }),
    el('div', { className: 'replay-stats' }, [
      ['任务记录', `${stats.projectTaskRecords || 0} 条`, `通过 ${stats.passedTasks ?? 0} / 失败 ${stats.failedTasks ?? 0} / 阻塞 ${stats.blockedTasks ?? 0}`],
      ['Claude Code 调用', `${stats.attemptCalls || 0} 次`, `包含失败/超时/取消的真实尝试`],
      ['DSH 审计', `${stats.auditCalls || 0} 次`, `PASS ${stats.auditPassed || 0}；UNKNOWN/FAIL ${stats.auditUnknown || 0}`],
      ['发现的问题', `${stats.issuesFound || 0} 项`, '审计 findings / 必须修复项；最终 UNKNOWN 仍在下方保留'],
      ['自动修复确认', 'UNKNOWN', '没有对每条审计建议做二次确认；最终审计 4/4 PASS 不等于每条建议都已修复'],
      ['卡死/重试', `${stats.agentFailedEvents || 0} 次`, 'agent_failed 事件；失败分类见下'],
      ['外部人工介入', '已知 1 次（测试环境）', '产品代码人工修改：UNKNOWN（无逐行审计记录），不能证明为零'],
      ['模型成本', fmtCny(stats.modelCost?.totalCny), `编码 ${fmtCny(stats.modelCost?.codingCny)} + 审计 ${fmtCny(stats.modelCost?.auditCny)}`],
      ['从开始到结束', fmtDurationCn(stats.durationMs), `${fmtBeijingFull(stats.start)} → ${fmtBeijingFull(stats.end)}`],
    ].map(([label, value, sub]) => el('div', { className: 'replay-stat' }, [el('span', { text: label }), el('strong', { text: value }), el('small', { className: 'insight-note', text: sub })]))),
    el('div', { style: { marginTop: '12px' } }, categories.map(([label, text, tone]) => el('div', { className: 'replay-source', style: { marginTop: '6px', borderLeft: `2px solid var(--${tone})` } }, [el('strong', { text: label }), el('span', { text: `：${text}` })]))),
    el('p', { className: 'replay-disclaimer', text: `失败分类（来自 attempts.failure_class）：${Object.entries(stats.failureClasses || {}).map(([k, v]) => `${k} ${v} 次`).join('；') || '未记录'}。` }),
    el('p', { className: 'replay-disclaimer', text: `未解决/无法确认：${fixes.filter((f) => /provenance|来源|生成者/.test(f)).length ? '源码作者归属这一条无法由 DSH 内部证明，已记录为 UNKNOWN；' : ''}原始聊天消息、部分修复细节未入库；测试通过不等于产品绝对无缺陷。` }),
  ]);
  return summary;
}

async function loadLive(projectId = '', options = {}) {
  if (!app.insightView || app.insightView !== 'live') return;
  if (app.liveLoading && !options.force) return;
  app.liveLoading = true;
  try {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const data = await apiRequest('GET', `/api/live${qs}`);
    app.liveData = data;
    app.liveError = null;
    app.liveProjectId = data.project?.id || projectId || '';
    renderInsight();
  } catch (error) {
    app.liveError = error.message;
    // 不把读取失败伪装成“没有项目”；保留上次成功数据并显示错误。
    renderInsight();
  } finally { app.liveLoading = false; }
}

async function loadReplay(options = {}) {
  if (!app.insightView || app.insightView !== 'replay') return;
  if (app.replayLoading && !options.force) return;
  app.replayLoading = true;
  app.replayError = null;
  renderInsight();
  try {
    const data = await apiRequest('GET', '/api/replay/consumption');
    app.replayData = data;
  } catch (error) { app.replayError = error.message; }
  finally { app.replayLoading = false; renderInsight(); }
}

function startInsightPolling() {
  if (app.liveTimer) { window.clearInterval(app.liveTimer); app.liveTimer = null; }
  if (app.insightView === 'live') {
    app.liveTimer = window.setInterval(() => { if (!document.hidden && app.insightView === 'live') loadLive(app.liveProjectId, { force: true }); }, 5000);
  }
}

function stopInsight() {
  app.insightView = '';
  app.liveData = null;
  app.replayData = null;
  app.replayError = null;
  app.liveError = null;
  app.liveTimer && window.clearInterval(app.liveTimer);
  app.liveTimer = null;
  document.body.classList.remove('insight-mode');
  document.querySelectorAll('.insight-nav-btn').forEach((btn) => btn.classList.remove('is-active'));
  if (dom.insightView) dom.insightView.hidden = true;
}

function openInsight(view, options = {}) {
  if (!INSIGHT_META[view]) return;
  app.insightView = view;
  if (view === 'replay') { app.replayAct = 0; app.replayMode = app.replayMode || 'simple'; app.replayTimeline = false; }
  if (view === 'live') { app.liveProjectId = app.liveProjectId || ''; app.liveData = null; }
  app.selectedRunId = null;
  app.runDetail = null;
  renderAll();
  if (view === 'live') loadLive(app.liveProjectId);
  else if (view === 'replay') loadReplay();
  startInsightPolling();
  if (options.updateHash !== false) setHash(INSIGHT_META[view].hash);
}

function exitInsight(options = {}) {
  stopInsight();
  const project = currentProject() || (app.state?.projects || [])[0];
  if (options.silent) { renderAll(); return; }
  if (project) selectProject(project.id, { replace: true, scroll: false });
  else { renderAll(); setHash('#/', true); }
}

// ============================================================
// 轮询与启动
// ============================================================
function startPolling() {
  if (app.pollTimer) window.clearInterval(app.pollTimer);
  app.pollTimer = window.setInterval(() => {
    if (!app.booted || document.hidden) return;
    refreshAll({ silent: true, reason: 'poll' });
  }, POLL_INTERVAL_MS);
}

async function bootstrap() {
  cacheDom();
  bindStaticEvents();
  updateTopbarHeight();
  app.booted = true;
  renderAll();
  renderEventLog();
  connectSSE();
  startPolling();

  const stateOk = await loadState({ silent: false });
  await loadIsolation({ silent: false });
  renderAll();
  if (!stateOk) {
    renderAll();
    toast(`无法加载工作台状态：${app.stateError?.message || '未知错误'}`, 'error', { duration: 8000, force: true });
    return;
  }
  applyRoute();
  renderAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bootstrap();
  });
} else {
  bootstrap();
}
