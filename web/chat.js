/**
 * AI Workbench · chat-first UI (v2.9)
 * 原生 ES module；所有服务端字符串只通过 textContent/属性写入，杜绝 HTML 注入。
 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const state = {
  conversations: [], projects: [], current: null, messages: [], loop: null, run: null,
  projectsView: false, sending: false, polling: null, theme: 'system', selectedProjectId: '',
  conversationRequestKey: '', lastFailed: null,
};
const dom = {};

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') throw new Error('html is forbidden');
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'attrs') for (const [k, v] of Object.entries(value)) { if (v === true) node.setAttribute(k, ''); else if (v !== false && v != null) node.setAttribute(k, String(v)); }
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error?.message || `请求失败（${res.status}）`);
    err.code = data?.error?.code || '';
    err.status = res.status;
    throw err;
  }
  return data.data;
}
function toast(message, kind = 'info') {
  const box = dom.toast;
  box.textContent = message;
  box.className = `toast show ${kind === 'error' ? 'error' : ''}`;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.classList.remove('show'); setTimeout(() => { box.hidden = true; }, 220); }, 3600);
}
function setConnection(ok) {
  dom.livePill.classList.toggle('offline', !ok);
  dom.liveText.textContent = ok ? '本地已连接' : '连接中断';
  dom.offlineBanner.hidden = ok;
}
function applyTheme(choice) {
  state.theme = choice;
  const resolved = choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  localStorage.setItem('wb-chat-theme', choice);
  $$('#themeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
}
function projectFor(conversation) {
  const id = conversation?.project_id;
  return id ? state.projects.find((p) => p.id === id) || null : null;
}
function projectStatus(project) {
  const run = (project?.runs || [])[0];
  return run?.status || 'idle';
}
function statusLabel(status) {
  return ({
    running: '开发中', awaiting_acceptance: '等待验收', paused: '已暂停', blocked: '需要处理',
    failed: '失败', cancelled: '已取消', accepted: '已验收', idle: '未开始',
  })[status] || status;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtCost(run) {
  const c = Number(run?.spent_json?.costCny || 0);
  if (!c) return '—';
  return `¥${c.toFixed(c < 1 ? 3 : 2)}`;
}
function safeText(value) { return String(value ?? '').slice(0, 4000); }

// ---------- navigation/render ----------
function setView(name) {
  $$('.side-link[data-nav]').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === name));
  if (name === 'projects') { state.projectsView = true; showWelcome(); }
  else if (name === 'chat') { state.projectsView = false; if (state.current) showConversation(); else showWelcome(); }
  else if (name === 'recent') { state.projectsView = false; if (state.conversations[0]) openConversation(state.conversations[0].id); else showWelcome(); }
  closeSidebar();
}
function showWelcome() {
  dom.welcome.hidden = false;
  dom.conversation.hidden = true;
  if (dom.quickControls) dom.quickControls.hidden = true;
  dom.crumb.textContent = '新对话';
  renderWelcome();
}
function showConversation() {
  dom.welcome.hidden = true;
  dom.conversation.hidden = false;
  dom.crumb.textContent = state.current?.title || '开发对话';
}
function renderWelcome() {
  if (state.projectsView) {
    dom.welcome.innerHTML = '';
    const wrap = el('div', { class: 'welcome-inner' });
    wrap.append(el('div', { class: 'eyebrow' }, [el('span', { class: 'eyebrow-dot' }), 'MY PROJECTS']));
    wrap.append(el('h1', { text: '我的项目' }));
    wrap.append(el('p', { class: 'lead', text: '选择一个已有项目继续开发，或新建对话从零开始。所有项目历史、审计和 Git 记录都会保留。' }));
    const grid = el('div', { class: 'projects-grid' });
    for (const p of state.projects) {
      const latest = (p.runs || [])[0];
      const card = el('button', { class: 'project-card', type: 'button', onclick: () => { state.selectedProjectId = p.id; state.projectsView = false; showWelcome(); toast(`已选择「${p.name}」，在下方输入开发目标`); } }, [
        el('span', { class: 'project-card-top' }, [el('span', { class: `project-dot ${projectStatus(p)}` }), el('strong', { text: p.name })]),
        el('span', { class: 'project-card-meta', text: `${statusLabel(projectStatus(p))}${latest?.verified_sha ? ` · ${latest.verified_sha.slice(0, 8)}` : ''}` }),
        el('span', { class: 'project-card-desc', text: p.description || '本地项目' }),
      ]);
      grid.append(card);
    }
    if (!state.projects.length) grid.append(el('p', { class: 'muted', text: '还没有项目。直接在对话里描述目标，我会创建。' }));
    wrap.append(grid);
    wrap.append(el('div', { class: 'actions' }, [el('button', { class: 'primary-btn', type: 'button', text: '新建对话', onclick: newChat })]));
    dom.welcome.append(wrap);
    return;
  }
  dom.welcome.innerHTML = '';
  dom.welcome.append(createWelcomeInner());
  bindWelcome();
}
function createWelcomeInner() {
  const inner = el('div', { class: 'welcome-inner' });
  inner.append(el('div', { class: 'eyebrow' }, [el('span', { class: 'eyebrow-dot' }), 'AI SOFTWARE STUDIO']));
  inner.append(el('h1', {}, ['把想法，', el('br'), el('span', { class: 'grad', text: '交给会做软件的人。' })]));
  inner.append(el('p', { class: 'lead', text: '用一句话描述你想开发的产品。Workbench 会整理需求和验收标准，确认后自动完成规划、编码、测试、独立审计与交付。' }));
  const form = el('form', { class: 'composer composer-hero', id: 'welcomeComposer' }, [
    el('label', { class: 'sr-only', for: 'welcomeInput', text: '描述你想开发的产品' }),
    el('textarea', { id: 'welcomeInput', rows: '3', maxlength: '8000', placeholder: '例如：帮我开发一个消费管理网站，可以管理收入、支出、分析消费决策。' }),
    el('div', { class: 'composer-foot' }, [
      el('span', { class: 'hint', id: 'welcomeHint', text: state.selectedProjectId ? `将基于已选项目继续开发。` : '无需填写工程参数。只在必要信息缺失时询问。' }),
      el('button', { class: 'send', id: 'welcomeSend', type: 'submit' }, [el('span', { 'aria-hidden': 'true', text: '↑' }), el('span', { text: '开始' })]),
    ]),
  ]);
  inner.append(form);
  const suggestions = el('div', { class: 'suggestions', 'aria-label': '示例目标' });
  for (const [label, prompt] of [
    ['个人阅读管理工具', '帮我开发一个个人阅读管理工具，支持书籍、阅读计划和本地数据。'],
    ['团队项目看板', '做一个帮助小团队跟踪项目进度的轻量看板，数据保存在本地。'],
    ['消费管理网站', '开发一个消费管理网站，可以管理收入、支出、分析消费决策。'],
  ]) suggestions.append(el('button', { class: 'suggestion', type: 'button', dataset: { prompt }, text: label }));
  inner.append(suggestions);
  inner.append(el('div', { class: 'trust-row' }, ['本地优先', '真实模型对话', '独立审计', '人工验收'].map((t) => el('span', { text: t }))));
  return inner;
}
function bindWelcome() {
  const form = $('#welcomeComposer');
  if (!form) return;
  const input = $('#welcomeInput');
  input?.addEventListener('input', () => autoGrow(input));
  input?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (event) => { event.preventDefault(); const text = input?.value.trim(); if (text) startFromText(text); });
  $$('.suggestion').forEach((b) => b.addEventListener('click', () => { if (input) { input.value = b.dataset.prompt || ''; input.focus(); autoGrow(input); } }));
}
function newChat() {
  state.current = null; state.messages = []; state.loop = null; state.run = null; state.lastFailed = null; state.conversationRequestKey = '';
  localStorage.removeItem('wb-last-failed'); localStorage.removeItem('wb-pending-conversation');
  localStorage.removeItem('wb-current-conversation');
  stopPolling(); showWelcome(); closeSidebar();
  $('#welcomeInput')?.focus();
}

// ---------- sidebar ----------
function renderSidebar() {
  const list = dom.projectList;
  list.innerHTML = '';
  for (const p of state.projects.slice(0, 12)) {
    const status = projectStatus(p);
    list.append(el('button', { class: 'project-item', type: 'button', onclick: () => selectProject(p) }, [
      el('span', { class: `project-dot ${status}` }),
      el('span', { class: 'project-copy' }, [el('strong', { text: p.name }), el('small', { text: statusLabel(status) })]),
    ]));
  }
  if (!state.projects.length) list.append(el('p', { class: 'muted small', text: '还没有项目' }));
  const recent = dom.recentList;
  recent.innerHTML = '';
  for (const c of state.conversations.slice(0, 8)) {
    recent.append(el('button', { class: 'recent-item', type: 'button', title: c.title, text: c.title, onclick: () => openConversation(c.id) }));
  }
  if (!state.conversations.length) recent.append(el('p', { class: 'muted small', text: '还没有对话' }));
}
function selectProject(project) {
  state.selectedProjectId = project.id;
  newChat();
  const hint = $('#welcomeHint');
  if (hint) hint.textContent = `将基于「${project.name}」继续开发。`;
  toast(`已选择项目：${project.name}`);
}
function openSidebar() { dom.sidebar.classList.add('open'); dom.scrim.hidden = false; dom.menuBtn.setAttribute('aria-expanded', 'true'); }
function closeSidebar() { dom.sidebar.classList.remove('open'); dom.scrim.hidden = true; dom.menuBtn?.setAttribute('aria-expanded', 'false'); }

// ---------- conversation ----------
function requestId() {
  return (globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
async function startFromText(text) {
  if (state.sending) return;
  if (!text || !String(text).trim()) return;
  try {
    if (!state.current) {
      state.conversationRequestKey = state.conversationRequestKey || localStorage.getItem('wb-pending-conversation') || requestId();
      localStorage.setItem('wb-pending-conversation', state.conversationRequestKey);
      const created = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: text.slice(0, 80), projectId: state.selectedProjectId || '', clientRequestId: state.conversationRequestKey }) });
      state.current = created.conversation;
      state.messages = created.messages || [];
      state.conversations = state.conversations.filter((c) => c.id !== state.current.id);
      state.conversations.unshift(state.current);
      state.conversationRequestKey = '';
      localStorage.removeItem('wb-pending-conversation');
    }
    localStorage.setItem('wb-current-conversation', state.current.id);
    showConversation();
    renderMessages();
    await sendMessage(text, { clientMessageId: requestId() });
  } catch (err) {
    // 保留 conversationRequestKey：网络恢复后同一请求不会创建第二个对话。
    toast(err.message, 'error');
  }
}
async function openConversation(id) {
  try {
    const data = await api(`/api/conversations/${id}`);
    state.current = data.conversation; state.messages = data.messages || []; state.loop = data.loop || null; state.run = data.run || null;
    try { const pending = JSON.parse(localStorage.getItem('wb-last-failed') || 'null'); if (pending?.conversationId === id) state.lastFailed = pending; } catch { /* ignore */ }
    localStorage.setItem('wb-current-conversation', id);
    state.projectsView = false;
    showConversation(); renderMessages(); renderRunPanel();
    if (state.current.status === 'running' || state.current.status === 'awaiting_acceptance') startPolling();
    closeSidebar();
  } catch (err) { toast(err.message, 'error'); }
}
async function sendMessage(text, opts = {}) {
  if (state.sending || !state.current) return;
  const content = String(text || '').trim();
  if (!content) return;
  const clientMessageId = opts.clientMessageId || state.lastFailed?.clientMessageId || requestId();
  state.sending = true;
  state.lastFailed = null;
  updateComposerState();
  const optimistic = { id: `local-${clientMessageId}`, role: 'user', content, created_at: new Date().toISOString() };
  state.messages.push(optimistic);
  renderMessages();
  const input = $('#chatInput');
  if (input) { input.value = ''; autoGrow(input); }
  try {
    const data = await api(`/api/conversations/${state.current.id}/messages`, { method: 'POST', body: JSON.stringify({ content, projectId: state.selectedProjectId || state.current.project_id || '', clientMessageId }) });
    state.current = data.conversation; state.messages = data.messages || []; state.lastFailed = null; localStorage.removeItem('wb-last-failed');
    state.conversations = state.conversations.filter((c) => c.id !== state.current.id); state.conversations.unshift(state.current);
    renderSidebar(); renderMessages();
    if (state.current.status === 'running') startPolling();
  } catch (err) {
    state.lastFailed = { text: content, clientMessageId, conversationId: state.current.id };
    localStorage.setItem('wb-last-failed', JSON.stringify(state.lastFailed));
    // 重新读取服务端真实状态；若网络已恢复，用户消息和错误回复都已持久化。
    let refreshed = true;
    await refreshConversation().catch(() => { refreshed = false; });
    if (!refreshed) state.messages.push({ id: `err-${Date.now()}`, role: 'assistant', content: '网络中断，消息已保留；请点击重试，不会重复发送。', data: { kind: 'error', retryable: true } });
    state.messages = state.messages.filter((m) => !(m.id === optimistic.id && state.messages.some((x) => x.role === 'user' && x.content === content && x.id !== optimistic.id)));
    renderMessages();
    toast(`${err.message}（可重试，不会重复发送）`, 'error');
  } finally {
    state.sending = false; updateComposerState();
  }
}
async function refreshConversation() {
  if (!state.current) return;
  const data = await api(`/api/conversations/${state.current.id}`);
  state.current = data.conversation; state.messages = data.messages || []; state.loop = data.loop || null; state.run = data.run || null; state.runContext = data.runContext || '';
  renderMessages(); renderRunPanel();
}
function updateComposerState() {
  const button = $('#chatComposer .send');
  if (button) button.disabled = state.sending;
  const hint = $('#chatHint');
  if (hint) hint.textContent = state.current?.status === 'running' ? '开发进行中。你可以继续对话，或展开进度查看细节。' : '对话会保存。确认需求后点击“开始开发”。';
}
function renderMessages() {
  dom.messages.innerHTML = '';
  for (const m of state.messages) {
    const assistant = m.role === 'assistant';
    const body = el('div', { class: 'msg-body' });
    body.append(el('div', { text: safeText(m.content) }));
    if (m.data?.kind === 'brief' && (m.data.goal || m.data.acceptance?.length)) body.append(renderBrief(m.data));
    if (m.data?.kind === 'control' && m.data.control) body.append(renderControl(m.data.control));
    if (m.data?.kind === 'error') {
      body.classList.add('msg-error');
      if (m.data.retryable && state.lastFailed) {
        body.append(el('div', { class: 'brief-actions' }, [el('button', { class: 'ghost-btn', type: 'button', text: '重试这条消息', onclick: () => sendMessage(state.lastFailed.text, { clientMessageId: state.lastFailed.clientMessageId }) })]));
      }
    }
    body.append(el('div', { class: 'msg-meta', text: fmtTime(m.created_at) }));
    dom.messages.append(el('div', { class: `msg ${assistant ? 'assistant' : 'user'}` }, [el('div', { class: 'avatar', text: assistant ? 'AI' : '你' }), body]));
  }
  dom.messages.scrollTop = dom.messages.scrollHeight;
}
function controlButton(label, action) {
  return el('button', { class: 'ghost-btn', type: 'button', text: label, onclick: () => sendControl(action) });
}
function renderControl(control) {
  const card = el('div', { class: 'brief control-card' });
  card.append(el('div', { class: 'brief-head' }, [el('strong', { text: control.title || '开发控制' }), el('span', { class: 'status-chip ready', text: '真实状态' })]));
  if (control.text) card.append(el('p', { text: control.text }));
  const facts = el('div', { class: 'detail-grid' });
  for (const [label, value] of [
    ['运行', control.runStatus || '—'],
    ['当前任务', control.currentTask?.title || '—'],
    ['任务', `${control.tasksPassed || 0}/${control.tasksTotal || 0} 通过`],
    ['质量', control.quality ? `${control.quality.allPass ? 'PASS' : '未通过'} ${control.quality.coverage?.pass || 0}/${control.quality.coverage?.total || 0}` : '未配置'],
  ]) facts.append(detail(label, value));
  card.append(facts);
  const actions = el('div', { class: 'brief-actions' });
  for (const [label, action] of [['进度', 'status'], ['当前任务', 'current_task'], ['失败原因', 'failure'], ['成本', 'cost'], ['测试', 'tests'], ['审计', 'audit'], ['交付', 'delivery']]) actions.append(controlButton(label, action));
  if (control.loopStatus === 'running') actions.prepend(controlButton('暂停', 'pause'));
  if (['paused', 'blocked'].includes(control.loopStatus)) actions.prepend(controlButton('继续', 'resume'));
  card.append(actions);
  return card;
}
async function sendControl(action) {
  if (!state.current || state.sending) return;
  state.sending = true; updateComposerState();
  try {
    const data = await api(`/api/conversations/${state.current.id}/control`, { method: 'POST', body: JSON.stringify({ action, requestKey: `ui:${state.current.id}:${action}:${requestId()}` }) });
    state.current = data.conversation; state.messages = data.messages || [];
    renderMessages(); renderSidebar();
    if (action === 'start') startPolling();
    toast(data.control?.title || '已执行');
  } catch (err) { toast(err.message, 'error'); }
  finally { state.sending = false; updateComposerState(); }
}
function renderBrief(data) {
  const card = el('div', { class: 'brief' });
  const head = el('div', { class: 'brief-head' }, [el('strong', { text: '产品需求草案' }), el('span', { class: `status-chip ${data.ready ? 'ready' : ''}`, text: data.ready ? '可以确认' : '还需澄清' })]);
  card.append(head);
  if (data.productName) card.append(el('p', { text: `产品名称：${data.productName}` }));
  if (data.goal) card.append(el('p', { text: `目标：${data.goal}` }));
  if (data.missing?.length) card.append(el('p', { text: `还需要：${data.missing.join('、')}` }));
  if (data.acceptance?.length) card.append(el('ul', {}, data.acceptance.map((a) => el('li', { text: a }))));
  if (data.questions?.length) card.append(el('p', { text: `想先确认：${data.questions.join(' ')}` }));
  const actions = el('div', { class: 'brief-actions' });
  if (data.ready && !state.current?.loop_id) {
    actions.append(el('button', { class: 'primary-btn', type: 'button', text: '开始开发', onclick: () => startDevelopment(data) }));
  }
  actions.append(el('button', { class: 'ghost-btn', type: 'button', text: '继续讨论', onclick: () => $('#chatInput')?.focus() }));
  card.append(actions);
  return card;
}
async function startDevelopment(data) {
  const button = document.querySelector('.brief-actions .primary-btn');
  if (button) { button.disabled = true; button.textContent = '正在启动…'; }
  try {
    const payload = {
      brief: { productName: data.productName, goal: data.goal, acceptance: data.acceptance || [] },
      projectId: state.selectedProjectId || state.current?.project_id || '',
    };
    const res = await api(`/api/conversations/${state.current.id}/start`, { method: 'POST', body: JSON.stringify(payload) });
    state.current = res.conversation; state.messages = res.messages || []; state.loop = res.loop || null; state.run = res.run || null;
    renderMessages(); renderSidebar(); startPolling();
    toast(res.conversation.status === 'running' ? '已开始开发。我会持续汇报真实进度。' : '已启动');
  } catch (err) {
    toast(`启动失败：${err.message}`, 'error');
    if (button) { button.disabled = false; button.textContent = '开始开发'; }
  }
}

// ---------- run progress ----------
function startPolling() {
  stopPolling();
  pollRun();
  state.polling = setInterval(pollRun, 4000);
}
function stopPolling() { if (state.polling) clearInterval(state.polling); state.polling = null; }
async function pollRun() {
  if (!state.current) return;
  try {
    const conv = await api(`/api/conversations/${state.current.id}`);
    state.current = conv.conversation; state.loop = conv.loop || null; state.run = conv.run || null; state.runContext = conv.runContext || '';
    if (state.loop?.current_run_id) {
      try { state.run = (await api(`/api/runs/${state.loop.current_run_id}`)); } catch { /* keep */ }
    }
    if (state.loop?.id) {
      try { state.loop = (await api(`/api/loops/${state.loop.id}`)); } catch { /* keep */ }
    }
    setConnection(true);
    renderRunPanel();
    if (['completed', 'failed', 'cancelled', 'paused', 'blocked'].includes(state.loop?.status) || ['awaiting_acceptance', 'failed', 'paused', 'blocked'].includes(state.run?.status)) {
      if (['awaiting_acceptance','paused','failed','blocked'].includes(state.run?.status) || ['completed','paused','blocked','failed','cancelled'].includes(state.loop?.status)) stopPolling();
    }
  } catch (err) {
    setConnection(false);
  }
}
function friendlyPhase(run, loop) {
  if (!run) return { title: '正在规划', sub: 'AI 正在理解需求并建立可验证的开发计划', key: 'planning' };
  const task = (run.tasks || [])[0];
  const status = run.status;
  if (status === 'awaiting_acceptance' || status === 'accepted') return { title: state.runContext === 'project_latest' ? '项目最近一次运行已完成' : '已完成，等待你验收', sub: state.runContext === 'project_latest' ? '这是该项目最近一次真实运行，不是本对话启动的开发' : '测试、独立审计和 Git 结果已准备好', key: 'done' };
  if (status === 'paused' || status === 'blocked' || loop?.status === 'blocked') return { title: '开发暂停，需要你处理', sub: run.stop_reason || loop?.stop_reason || '存在需要授权的阻塞', key: 'blocked' };
  if (status === 'failed' || status === 'cancelled') return { title: '开发未完成', sub: run.stop_reason || '运行已停止', key: 'failed' };
  if (status === 'interrupted') return { title: '开发已中断', sub: 'Workbench 正在尝试恢复', key: 'interrupted' };
  if (task?.status === 'repairing' || task?.status === 'auditing' || task?.status === 'testing') {
    if (task.status === 'testing') return { title: '正在测试', sub: '运行自动化测试，确认真实行为', key: 'testing' };
    if (task.status === 'auditing') return { title: '正在独立检查', sub: '独立模型审计产品实现与证据', key: 'auditing' };
    return { title: '发现问题，正在自动修复', sub: '测试或审计发现真实问题，AI 正在修复并重新验证', key: 'repairing' };
  }
  if (task?.status === 'coding' || task?.status === 'preparing') return { title: '正在编写代码', sub: 'Coding Agent 正在实现产品功能', key: 'coding' };
  if (task?.status === 'committing') return { title: '正在保存 Git 结果', sub: '记录可审计的代码提交', key: 'committing' };
  return { title: '正在推进开发', sub: 'Workbench 正在执行当前任务', key: 'running' };
}
function actualStepRank(run) {
  if (!run) return 0;
  if (run.status === 'awaiting_acceptance' || run.status === 'accepted') return 5;
  const task = (run.tasks || [])[0];
  const status = task?.status;
  if (status === 'coding' || status === 'preparing') return 1;
  if (status === 'testing') return 2;
  if (status === 'auditing' || status === 'repairing') return 3;
  if (status === 'committing') return 4;
  if (status === 'passed') return 5;
  // 失败/暂停：不能把未执行的阶段画成已完成；仅能证明已经进入过“规划/编码”等实际阶段。
  const types = new Set((run.events || []).map((e) => e.type));
  if (types.has('audit_started') || types.has('audit_passed') || types.has('audit_failed')) return 3;
  if (types.has('test_started') || types.has('test_passed') || types.has('test_failed')) return 2;
  if (types.has('agent_started') || types.has('agent_progress')) return 1;
  if (types.has('run_created') || types.has('task_started')) return 1;
  return 0;
}
function stepsFor(run, phase) {
  const order = ['规划', '编码', '测试', '独立审计', '质量检查', '交付'];
  const actual = actualStepRank(run);
  let current = actual;
  if (phase.key === 'done') current = 5;
  else if (phase.key === 'planning') current = 0;
  else if (phase.key === 'coding') current = 1;
  else if (phase.key === 'testing') current = 2;
  else if (phase.key === 'auditing' || phase.key === 'repairing') current = 3;
  else if (phase.key === 'committing' || phase.key === 'delivery') current = 5;
  return order.map((label, i) => {
    let classSuffix = 'pending';
    let mark = '·';
    if (phase.key === 'done' || i < actual) { classSuffix = 'done'; mark = '✓'; }
    else if (i === actual) { classSuffix = phase.key === 'blocked' || phase.key === 'failed' ? 'problem' : 'current'; mark = phase.key === 'blocked' || phase.key === 'failed' ? '!' : '•'; }
    if (phase.key === 'done') { classSuffix = 'done'; mark = '✓'; }
    return el('div', { class: `run-step ${classSuffix}` }, [el('span', { class: 'step-mark', text: mark }), el('span', { text: label })]);
  });
}
function renderRunPanel() {
  const panel = dom.runPanel;
  if (!state.loop && !state.run) {
    panel.hidden = true;
    if (dom.quickControls) dom.quickControls.hidden = true;
    return;
  }
  panel.hidden = false;
  if (dom.quickControls) {
    dom.quickControls.hidden = false;
    dom.quickControls.innerHTML = '';
    for (const [label, action] of [['进度', 'status'], ['当前任务', 'current_task'], ['失败原因', 'failure'], ['成本', 'cost'], ['测试', 'tests'], ['审计', 'audit'], ['交付', 'delivery'], ['暂停', 'pause'], ['继续', 'resume']]) {
      if (action === 'pause' && state.loop?.status !== 'running') continue;
      if (action === 'resume' && !['paused', 'blocked'].includes(state.loop?.status)) continue;
      dom.quickControls.append(el('button', { class: 'ghost-btn', type: 'button', text: label, onclick: () => sendControl(action) }));
    }
  }
  const phase = friendlyPhase(state.run, state.loop);
  panel.innerHTML = '';
  const head = el('div', { class: 'run-head' }, [
    phase.key === 'done' ? el('span', { class: 'final-badge', text: '待验收' }) : (phase.key === 'blocked' || phase.key === 'failed') ? el('span', { class: 'final-badge', text: '需要处理' }) : el('span', { class: 'run-spinner' }),
    el('div', {}, [el('div', { class: 'run-title', text: phase.title }), el('div', { class: 'run-sub', text: phase.sub })]),
  ]);
  if (phase.key !== 'blocked' && phase.key !== 'done') {
    const meter = el('div', { class: 'run-meter', 'aria-hidden': 'true' });
    const count = phase.key === 'planning' ? 1 : phase.key === 'coding' ? 1 : phase.key === 'testing' ? 2 : 3;
    for (let i = 0; i < 5; i += 1) meter.append(el('span', { class: i < count ? 'on' : '' }));
    head.append(meter);
  }
  panel.append(head);
  if (phase.key === 'done') {
    panel.classList.add('final-card');
    const commit = state.run?.verified_sha || state.loop?.history_json?.at(-1)?.commit || '';
    const quality = state.loop?.history_json?.at(-1)?.quality;
    const info = el('div', { class: 'detail-grid' }, [
      detail('产品', state.current?.title || '—'),
      detail('验证', state.run?.verification_status || '—'),
      detail('Git', commit ? commit.slice(0, 12) : '—'),
      detail('质量', quality ? `${quality.coverage?.pass || 0}/${quality.coverage?.total || 0} PASS` : '未配置质量检查'),
      detail('费用', fmtCost(state.run)),
      detail('任务', state.run?.tasks?.length ? `${state.run.tasks.length} 个` : '—'),
    ]);
    panel.append(info);
    panel.append(el('p', { class: 'run-sub', text: '最终验收由你决定：Workbench 不会自动合并 main 或部署。可在“开发详情”中查看完整证据并验收。' }));
    panel.append(el('div', { class: 'brief-actions' }, [el('button', { class: 'primary-btn', type: 'button', text: '打开开发详情', onclick: () => location.assign('/advanced') })]));
  } else {
    panel.append(el('div', { class: 'run-body' }, stepsFor(state.run, phase)));
  }
  panel.append(renderRunDetails());
}
function detail(label, value) { return el('div', { class: 'detail-item' }, [el('span', { text: label }), el('strong', { text: value == null ? '—' : String(value) })]); }
function renderRunDetails() {
  const detailBox = el('details', { class: 'run-detail' });
  detailBox.append(el('summary', { text: '展开真实工程详情' }));
  const grid = el('div', { class: 'detail-grid' });
  const run = state.run;
  const task = run?.tasks?.[0];
  grid.append(detail('运行', run?.id?.slice(0, 16) || '规划中'));
  grid.append(detail('Loop', state.loop?.id?.slice(0, 16) || '—'));
  grid.append(detail('阶段', task?.status || 'planning'));
  grid.append(detail('Attempt', task?.attempts?.length ? String(task.attempts.length) : '0'));
  grid.append(detail('Token', run?.spent_json?.tokens ? String(run.spent_json.tokens) : '—'));
  grid.append(detail('费用', fmtCost(run)));
  detailBox.append(grid);
  if (task?.title) detailBox.append(el('p', { class: 'run-sub', text: `当前任务：${task.title}` }));
  const audit = task?.audits?.at(-1);
  if (audit) detailBox.append(el('p', { class: 'run-sub', text: `独立审计：${audit.provider} · ${audit.verification_status || audit.verdict} · ${audit.score ?? '—'} 分` }));
  const events = (run?.events || []).slice(-8);
  if (events.length) {
    const list = el('ul', { class: 'detail-list' });
    for (const e of events.slice().reverse()) list.append(el('li', { text: `${fmtTime(e.created_at)} · ${e.message || e.type}` }));
    detailBox.append(list);
  }
  if (run?.stop_reason) detailBox.append(el('p', { class: 'run-sub', text: `原因：${run.stop_reason}` }));
  return detailBox;
}

// ---------- boot/settings ----------
function autoGrow(input) { if (!input) return; input.style.height = 'auto'; input.style.height = `${Math.min(200, input.scrollHeight)}px`; }
function openSettings() { dom.settingsModal.hidden = false; loadBudget(); }
function closeSettings() { dom.settingsModal.hidden = true; }
async function loadBudget() {
  try {
    const b = await api('/api/budget');
    const remaining = Number(b.remainingTokens ?? 0).toLocaleString('zh-CN');
    dom.budgetInfo.textContent = `剩余 ${remaining} tokens · 已用 ${b.usedCostCny != null ? `¥${Number(b.usedCostCny).toFixed(2)}` : '—'}（GLM 用量单列，不受内部预算上限）`;
  } catch { dom.budgetInfo.textContent = '预算信息暂不可用'; }
}
async function boot() {
  dom.sidebar = $('#sidebar'); dom.scrim = $('#scrim'); dom.menuBtn = $('#menuBtn');
  dom.welcome = $('#welcome'); dom.conversation = $('#conversation'); dom.messages = $('#messages');
  dom.runPanel = $('#runPanel'); dom.quickControls = $('#quickControls'); dom.crumb = $('#crumb'); dom.projectList = $('#projectList'); dom.recentList = $('#recentList');
  dom.livePill = $('#livePill'); dom.liveText = $('#liveText'); dom.offlineBanner = $('#offlineBanner');
  dom.toast = $('#toast'); dom.settingsModal = $('#settingsModal'); dom.budgetInfo = $('#budgetInfo');
  applyTheme(localStorage.getItem('wb-chat-theme') || 'system');
  bindEvents();
  try {
    const [stateData, conversations] = await Promise.all([api('/api/state'), api('/api/conversations')]);
    state.projects = stateData.projects || [];
    state.conversations = conversations || [];
    setConnection(true);
    renderSidebar();
    const saved = localStorage.getItem('wb-current-conversation');
    if (saved && state.conversations.some((c) => c.id === saved)) await openConversation(saved);
    else { showWelcome(); }
  } catch (err) {
    setConnection(false);
    toast(`无法连接本地 Workbench：${err.message}`, 'error');
    showWelcome();
  }
}
function bindEvents() {
  $('#newChatBtn').addEventListener('click', newChat);
  $('#brandBtn').addEventListener('click', newChat);
  $('#menuBtn').addEventListener('click', openSidebar);
  $('#sidebarClose').addEventListener('click', closeSidebar);
  dom.scrim.addEventListener('click', closeSidebar);
  $('#refreshProjects').addEventListener('click', async () => { try { const d = await api('/api/state'); state.projects = d.projects || []; renderSidebar(); toast('项目已刷新'); } catch (e) { toast(e.message, 'error'); } });
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  dom.settingsModal.addEventListener('click', (e) => { if (e.target === dom.settingsModal) closeSettings(); });
  $('#settingsAdvanced').addEventListener('click', () => location.assign('/advanced'));
  $('#advancedBtn').addEventListener('click', () => location.assign('/advanced'));
  $('#advancedTopBtn').addEventListener('click', () => location.assign('/advanced'));
  dom.settingsModal.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeChoice)));
  $$('.side-link[data-nav]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.nav)));
  $('#chatComposer').addEventListener('submit', (e) => { e.preventDefault(); const input = $('#chatInput'); const text = input?.value.trim(); if (text) sendMessage(text); });
  $('#chatInput').addEventListener('input', (e) => autoGrow(e.target));
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatComposer').requestSubmit(); } });
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); } });
  window.addEventListener('online', () => { setConnection(true); if (state.current) pollRun(); });
  window.addEventListener('offline', () => setConnection(false));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (state.theme === 'system') applyTheme('system'); });
}
boot();
