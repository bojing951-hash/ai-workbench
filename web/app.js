/**
 * AI 全自动软件开发工作台 — 可视化前端
 * 原生 ES Module，零依赖、无外部资源；所有后端字符串仅通过
 * textContent / createElement / setAttribute 渲染，杜绝 HTML 注入。
 */

// ============================================================
// 常量：状态映射与格式化
// ============================================================
const MAX_EVENTS = 300;
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
  modal: { open: false, type: '', onClose: null, confirmFinish: null, lastFocus: null },
  drawer: { open: false, path: '', content: '', lastFocus: null },
  booted: false,
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
      const message = errorPayload?.message || payload?.message || `请求失败（HTTP ${response.status}）`;
      throw new ApiError(message, response.status, errorPayload?.code || '', errorPayload?.details || null);
    }
    return payload ? payload.data : undefined;
  }
  const text = await response.text();
  if (!response.ok) throw new ApiError(`请求失败（HTTP ${response.status}）`, response.status);
  return text;
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
  'budgetWidget',
  'budgetTokensValue',
  'budgetTokensBar',
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
  'runDetailView',
  'runHeader',
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
  dom.welcomeAddProjectBtn.addEventListener('click', () => openAddProjectModal());
  dom.helpBtn.addEventListener('click', () => openHelpModal());
  dom.welcomeHelpBtn.addEventListener('click', () => openHelpModal());
  dom.refreshBtn.addEventListener('click', () => refreshAll({ silent: false, reason: 'manual' }));
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
    app.stateError = null;
    app.lastStateAt = Date.now();
    return true;
  } catch (error) {
    app.stateError = error;
    if (silent) reportBackgroundError(error);
    return false;
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
  return { result, publish, pushAction, prAction, blockedAction, ciAction, planBranch, pr, blockedReasons, ci, counts, acceptedAt: result.acceptedAt || '' };
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
    level: ['info', 'warn', 'error'].includes(raw.level) ? raw.level : 'info',
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

function buildEventRow(event) {
  const row = el('div', { className: `event-row level-${event.level}` });
  if (/(passed|accepted|created|pr_created|branch_pushed)/.test(event.type)) row.classList.add('type-passed');
  if (/(failed|error|blocked|cancelled|violation)/.test(event.type)) row.classList.add('type-failed');
  const typeSuffix = event.taskId ? ` · ${shortId(event.taskId, 12)}` : '';
  row.append(
    el('span', { className: 'event-time', text: fmtClock(event.createdAt), title: fmtDateTimeFull(event.createdAt) }),
    el('span', { className: 'event-dot' }),
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
  renderSseStatus();
}

function renderBudget(budget) {
  const data = budget || {};
  if (!app.state) {
    if (dom.budgetTokensValue) dom.budgetTokensValue.textContent = '—';
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
    dom.budgetTokensValue.textContent = `${fmtTokens(usedTokens)} / ${fmtTokens(maxTokens)} · ${fmtPercent(tokensPercent)}`;
    dom.budgetTokensValue.title = `已用 ${fmtTokens(usedTokens)} / 上限 ${fmtTokens(maxTokens)} tokens`;
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
      `tokens：${fmtTokens(usedTokens)} / ${fmtTokens(maxTokens)}`,
      `tokens 明细：输入 ${fmtTokens(breakdown.tokensIn)} · 输出 ${fmtTokens(breakdown.tokensOut)} · 缓存 ${fmtTokens(breakdown.tokensCache)}`,
      `成本：${fmtCostCny(usedCost)} / ¥${fmtCost(maxCost)}`,
      `剩余：${fmtTokens(data.remainingTokens)} tokens · ¥${fmtCost(data.remainingCostCny)}`,
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
  return el('div', { className: 'project-empty' }, [
    el('p', { text: `项目列表加载失败：${error.message}` }),
    el('button', {
      className: 'button button-ghost button-sm',
      text: '重试',
      attrs: { type: 'button' },
      on: { click: retry },
    }),
  ]);
}

function buildProjectItem(project) {
  const selected = project.id === app.selectedProjectId;
  const latestRun = project.latestRun || null;
  const latestNode = latestRun
    ? runBadge(latestRun.status)
    : el('span', { className: 'chip tone-gray', text: '未运行' });
  const item = el(
    'button',
    {
      className: `project-item${selected ? ' is-selected' : ''}`,
      attrs: { type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
      title: [project.name, project.local_path || project.repo_url || '', project.test_command || '未配置测试命令'].filter(Boolean).join('\n'),
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
function renderAll() {
  renderTopbar();
  renderSidebar();
  renderWorkspace();
  renderStatusPanel();
  renderEventsChrome();
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
  const project = currentProject();
  const showWelcome = !project;
  dom.welcomeView.hidden = !showWelcome;
  dom.projectView.hidden = showWelcome;
  renderWelcomeStats();
  if (showWelcome) return;
  renderProjectHeader(project);
  syncGoalForm(project);
  renderRuns(project);
  if (app.selectedRunId) {
    dom.runDetailView.hidden = false;
    renderRunDetail();
  } else {
    dom.runDetailView.hidden = true;
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

  dom.projectHeader.append(headerTop, facts);
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
    const metaChildren = [
      el('span', { text: mode }),
      el('span', { text: `创建 ${fmtRelative(run.created_at)}`, title: fmtDateTimeFull(run.created_at) }),
    ];
    if (run.stop_reason) {
      metaChildren.push(el('span', { className: 'muted', text: truncateText(run.stop_reason, 46), title: run.stop_reason }));
    }
    const item = el(
      'button',
      {
        className: `run-item${selected ? ' is-selected' : ''}`,
        attrs: { type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
        title: run.goal || '',
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
            text: `↑${fmtTokens(run.spent_json?.tokens)} · ¥${fmtCost(run.spent_json?.costCny)}`,
            title: '该运行累计消耗',
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

function renderRunSkeleton() {
  clearNode(dom.runHeader);
  clearNode(dom.taskList);
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
    return;
  }
  dom.runDetailView.hidden = false;
  const run = app.runDetail && app.runDetail.id === app.selectedRunId ? app.runDetail : null;
  if (!run) {
    if (app.runDetailError) renderRunError();
    else renderRunSkeleton();
    return;
  }
  renderRunHeader(run);
  renderTasks(run);
}

function renderRunHeader(run) {
  clearNode(dom.runHeader);
  const info = deriveRunInfo(run);
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
    info.acceptedAt ? badge('人工验收 · 未合并', 'cyan') : null,
  ]);

  const heading = el('div', { className: 'run-heading' }, [
    backButton,
    titleLine,
    el('h2', { className: 'run-goal', text: run.goal || '（无目标描述）' }),
  ]);

  const headerTop = el('div', { className: 'run-header-top' }, [heading, buildRunControls(run)]);

  const metaGrid = el('div', { className: 'run-meta-grid' }, [
    buildPlanBranchMeta(info),
    buildPrMeta(info),
    buildCiMeta(info),
    buildRunBudgetMeta(run),
    buildRunDurationMeta(run),
    buildRunTimeMeta(run),
  ]);

  const banners = el('div', { className: 'run-banners' });
  if (run.status === 'awaiting_acceptance') {
    banners.append(
      buildBanner(
        'cyan',
        '◈',
        '全部任务已通过测试与独立审计，等待人工验收。验收仅记录结果，不会合并主分支。',
      ),
    );
  }
  if (run.status === 'accepted' || info.acceptedAt) {
    banners.append(buildBanner('green', '✓', `已记录人工验收（merged=false，未合并主分支）${info.acceptedAt ? ` · ${fmtDateTime(info.acceptedAt)}` : ''}`));
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
  if (info.ci && info.ci.conclusion === 'failure') {
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
    el('span', { className: 'mono', text: `↑${fmtTokens(run.spent_json?.tokens)} tokens · ¥${fmtCost(run.spent_json?.costCny)}` }),
  ]);

  dom.runHeader.append(headerTop, metaGrid);
  if (banners.childElementCount) dom.runHeader.append(banners);
  dom.runHeader.append(statsLine);
}

function buildRunControls(run) {
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
    wrap.append(
      makeButton('验收（仅记录，不合并）', 'accept', 'button-accept', {
        title: '仅记录人工验收结果，不会合并任何分支',
      }),
    );
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
  if (info.ci) {
    const meta = ciMeta(info.ci);
    children.push(badge(meta.label, meta.tone));
    if (info.ci.error) children.push(el('span', { className: 'meta-empty', text: '查询失败', title: info.ci.error }));
    else if (info.ci.note) children.push(el('span', { className: 'meta-empty', text: info.ci.note, title: info.ci.note }));
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
  const spentCost = toNumber(run.spent_json?.costCny);
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
    el('span', { text: `${fmtCostCny(spentCost, maxCost)} / ¥${fmtCost(maxCost)}` }),
    el('span', { className: 'meta-empty', text: '成本上限' }),
  ]);
  return metaItem('运行预算', [el('div', { className: 'meta-budget' }, [top, el('span', { className: 'progress-track' }, [fill]), costLine])]);
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
          el('span', { className: 'attempt-nums', title: 'Token / 成本 / 耗时' }, [
            el('span', { text: `↑${fmtTokens(attempt.tokens)} · ${fmtCostCny(attempt.costCny)}` }),
            el('br'),
            el('span', { text: fmtDurationMs(attempt.durationMs) }),
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

  const confirmOptions =
    action === 'cancel'
      ? {
          title: '取消运行',
          message: '取消后当前运行会标记为已取消，未完成的任务不会继续执行。已产生的提交、审计记录与产物会保留。',
          warning: '此操作不可撤销；如需继续开发，需要重新发起运行。',
          confirmText: '确认取消',
          tone: 'danger',
        }
      : action === 'accept'
        ? {
            title: '记录人工验收',
            message: '将把当前运行标记为「已验收」。验收完成后仍可查看任务、审计与产物。',
            highlight: '仅记录验收结果，不会合并主分支，也不会自动发布或修改远端仓库。你可以随后自行在 GitHub 上决定是否合并 PR。',
            confirmText: '确认验收（不合并）',
            tone: 'accept',
          }
        : action === 'retry'
          ? {
              title: '重试失败任务',
              message: '将把所有失败 / 阻塞任务重置为排队状态并重新执行，可能产生额外的 tokens 与成本消耗。',
              warning: '已通过任务的提交与审计记录会保留；失败任务的旧尝试会保留在历史记录中。',
              confirmText: '重试失败任务',
              tone: 'warn',
            }
          : null;

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
      result = await apiRequest('POST', `/api/runs/${encodeURIComponent(runId)}/accept`);
      toast('已记录人工验收；工作台未合并主分支', 'success', { duration: 5500 });
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
  const agentSelect = el(
    'select',
    { attrs: { id: 'newProjectAgent' } },
    [
      el('option', { text: 'auto · 自动选择（推荐）', attrs: { value: 'auto' } }),
      el('option', { text: 'dsh · DeepSeek Harness', attrs: { value: 'dsh' } }),
      el('option', { text: 'claude · Claude Code', attrs: { value: 'claude' } }),
    ],
  );
  const protectInput = el('input', { attrs: { type: 'checkbox', id: 'newProjectProtect', checked: true } });
  const protectField = el('label', { className: 'checkbox-field', attrs: { for: 'newProjectProtect' } }, [
    protectInput,
    el('span', { className: 'checkbox-body' }, [
      el('span', { className: 'checkbox-title', text: '保护测试目录' }),
      el('span', {
        className: 'checkbox-desc',
        text: '自动加入 tests/**、test/**、**/*.test.js 等受保护路径，防止 Agent 通过修改验收测试来「通过」。',
      }),
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
        el('div', { className: 'form-field is-full' }, [protectField]),
        formError,
      ]),
      el('div', { className: 'confirm-warning' }, [
        '工作台只创建隔离分支与 PR，不会合并主分支，也不会修改受保护的测试目录。',
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
      formError.textContent = '请填写项目名称';
      formError.hidden = false;
      nameInput.focus();
      return;
    }
    if (!repo) {
      formError.textContent = '请填写仓库地址或本地路径';
      formError.hidden = false;
      repoInput.focus();
      return;
    }
    formError.hidden = true;
    submitting = true;
    submitButton.disabled = true;
    cancelButton.disabled = true;
    submitButton.textContent = '正在添加…';
    try {
      const project = await apiRequest('POST', '/api/projects', {
        name,
        repo,
        testCommand: testInput.value.trim() || undefined,
        protectTests: !!protectInput.checked,
        agentKind: agentSelect.value || 'auto',
      });
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
      formError.textContent = error.message;
      formError.hidden = false;
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
    { title: '打开工作台', desc: '确认右上角「实时已连接」；如果显示断开，页面仍会每 5 秒轮询状态兜底。' },
    { title: '添加项目', desc: '点击左侧「+ 添加」：填写名称，关联 GitHub 仓库 / owner/repo / 本地绝对路径，设置测试命令并保护测试目录。' },
    { title: '输入目标与验收标准', desc: '在产品目标中描述交付结果；验收标准每行一条。独立审计模型会逐条核对并给出 pass / fail / unproven 与证据。' },
    { title: '启动自动开发', desc: '选择「单任务执行」或「自动多任务规划」后启动。工作台会创建隔离分支、调度 Coding Agent、运行测试与独立审计。' },
    { title: '查看进度与证据', desc: '任务流水线展示状态、尝试次数、Agent、审计得分与 commit；点击任务可展开验收证据、findings、失败原因与产物。' },
    { title: '最终验收入口', desc: '全部任务通过后状态变为「等待验收」，点击「验收（仅记录，不合并）」记录结果。工作台永不自动合并主分支。' },
  ];
  const safetyList = el('ul', { className: 'help-list' }, [
    el('li', {}, [el('strong', { text: '不合并主分支：' }), document.createTextNode('只创建计划分支与草稿 PR，是否合并由你决定。')]),
    el('li', {}, [el('strong', { text: '测试保护：' }), document.createTextNode('受保护路径由策略层强制校验，Agent 无法通过改测试「通过」。')]),
    el('li', {}, [el('strong', { text: '独立审计：' }), document.createTextNode('审计模型未参与编码，逐条核对验收标准；unproven 不计为通过。')]),
    el('li', {}, [el('strong', { text: '不伪造成功：' }), document.createTextNode('测试失败或审计失败会暂停并记录原因，可人工恢复或重试失败任务。')]),
    el('li', {}, [el('strong', { text: '预算兜底：' }), document.createTextNode('全局 tokens / 成本耗尽时自动暂停，避免超出预算。')]),
  ]);
  const projectList = el('ul', { className: 'help-list' }, [
    el('li', {}, [el('strong', { text: 'GitHub 仓库：' }), document.createTextNode('填写完整地址或 owner/repo，工作台会克隆到本地 projects 目录。')]),
    el('li', {}, [el('strong', { text: '本地项目：' }), document.createTextNode('填写绝对路径；若尚未初始化 git，工作台会建立基线提交。')]),
    el('li', {}, [el('strong', { text: '测试命令：' }), document.createTextNode('留空时自动检测 npm test / pytest / go test / cargo test。')]),
    el('li', {}, [el('strong', { text: 'Agent 选择：' }), document.createTextNode('auto 由调度器决定；也可固定 dsh / claude，便于对照。')]),
  ]);
  const realtimeList = el('ul', { className: 'help-list' }, [
    el('li', {}, [el('strong', { text: '实时通道：' }), document.createTextNode('EventSource 连接 GET /api/stream，连接断开时自动重连。')]),
    el('li', {}, [el('strong', { text: '轮询兜底：' }), document.createTextNode('每 5 秒请求 GET /api/state；SSE 断开时顶栏状态会变灰。')]),
    el('li', {}, [el('strong', { text: '事件流：' }), document.createTextNode('只保留最近 300 条，可按级别着色；关闭「自动滚动」可停留阅读。')]),
    el('li', {}, [el('strong', { text: '产物查看：' }), document.createTextNode('点击产物文件会在右侧抽屉中加载文本（提示词 / diff / 测试证据 / 审计原文）。')]),
  ]);

  const body = el('div', { className: 'help-body' }, [
    helpSection('推荐使用流程', [helpStepList(steps)]),
    helpSection('安全边界与质量门禁', [safetyList]),
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
      body.append(
        el('p', { className: 'status-note', text: `无法连接工作台服务：${app.stateError.message}` }),
        el('div', { className: 'empty-actions' }, [
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
