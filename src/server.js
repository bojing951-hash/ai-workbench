// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP 服务：REST API + SSE 实时事件流 + 静态可视化界面。
 * 只监听本机回环地址；所有写入操作经由编排器与策略层。
 */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { PolicyError } from './policy.js';
import { detectIsolationCapabilities, isolationModeForProject } from './isolation.js';
import { containerCapabilities } from './container.js';
import { VERSION } from './orchestrator.js';
import { buildLive, buildReplay, readProjectCommit } from './replay.js';
import { latestMatrixFromHistory, qualityConfig } from './quality.js';
import { chatTurn, startDevelopment } from './chat.js';
import { assertSafeWriteRequest, isAllowedHost, redactForResponse, resolveWithin, WriteRateLimiter } from './security.js';

const MAX_BODY = 2 * 1024 * 1024;
const writeLimiter = new WriteRateLimiter({ windowMs: 60_000, max: 120 });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message, details = {}, config = null) {
  sendJson(res, status, { ok: false, error: { code, message: config ? redactForResponse(message, config) : message, details } });
}

async function readBody(req, maxBody = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBody) {
        reject(new PolicyError('BODY_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new PolicyError('BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function mapErrorStatus(err) {
  const code = err?.code || '';
  if (code === 'PROJECT_NOT_FOUND' || code === 'RUN_NOT_FOUND' || code === 'TASK_NOT_FOUND' || code === 'ARTIFACT_MISSING') return 404;
  if (code === 'RUN_NOT_READY' || code === 'RUN_CLOSED' || code === 'BUDGET_TOKENS_EXHAUSTED' || code === 'BUDGET_TOKENS_EXCEEDED' || code === 'BUDGET_COST_EXCEEDED') return 409;
  return 400;
}

export function createApp({ config, store, orchestrator, loops = null }) {
  let isolationCache = null;
  const isolation = () => { if (!isolationCache) isolationCache = detectIsolationCapabilities(); return isolationCache; };
  const webDir = path.join(config.paths.root, 'web');
  const maxBody = Number(config.security?.maxBodyBytes || MAX_BODY);
  // P0-5：API 身份认证。优先使用显式 Token；否则每次启动生成随机 Token，
  // 写入 data/api-token（0600），浏览器通过 SameSite=Strict Cookie 获得，脚本通过文件读取。
  const apiToken = config.security?.apiToken || crypto.randomBytes(24).toString('hex');
  const apiTokenFile = path.join(config.paths.dataDir, 'api-token');
  try {
    fs.writeFileSync(apiTokenFile, apiToken, { mode: 0o600 });
    fs.chmodSync(apiTokenFile, 0o600);
  } catch {
    /* ignore */
  }
  const parseCookieToken = (req) => {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === 'wb_token') return rest.join('=');
    }
    return '';
  };
  const requireApiAuth = (req) => {
    const auth = String(req.headers.authorization || '');
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-workbench-token'] || parseCookieToken(req));
    return provided === apiToken;
  };
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      const status = mapErrorStatus(err);
      sendError(res, status, err?.code || 'INTERNAL_ERROR', err?.message || String(err), err?.details || {}, config);
    }
  });

  const sseClients = new Set();
  const unsubscribe = orchestrator.bus.subscribe((event) => {
    const payload = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(`: ping ${Date.now()}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }, 20_000);
  heartbeat.unref?.();

  async function route(req, res) {
    const host = req.headers.host || '';
    if (!isAllowedHost(host, config)) {
      return sendError(res, 403, 'HOST_FORBIDDEN', `拒绝非本机 Host：${host}`);
    }
    const url = new URL(req.url, `http://${host || '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        assertSafeWriteRequest(req, config);
        writeLimiter.check();
      } catch (err) {
        return sendError(res, 403, err.code || 'WRITE_FORBIDDEN', err.message, {}, config);
      }
    }

    // ---------- SSE ----------
    if (pathname === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, version: VERSION, at: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---------- 静态资源 ----------
    if (!pathname.startsWith('/api/')) {
      return serveStatic(pathname, res);
    }

    // ---------- API ----------
    if (pathname !== '/api/health' && !requireApiAuth(req)) {
      return sendError(res, 401, 'API_AUTH_REQUIRED', '未认证的 API 请求（Token 见 data/api-token 或浏览器 Cookie）');
    }

    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, version: VERSION, at: new Date().toISOString() });
    }

    if (pathname === '/api/state' && method === 'GET') {
      const data = await orchestrator.state();
      data.loops = loops ? loops.list() : [];
      return sendJson(res, 200, { ok: true, data });
    }

    // ---------- v2.9 Chat-first ----------
    if (pathname === '/api/conversations' && method === 'GET') {
      return sendJson(res, 200, { ok: true, data: store.listConversations(60) });
    }
    if (pathname === '/api/conversations' && method === 'POST') {
      const body = await readBody(req, maxBody);
      const conv = store.createConversation({ title: String(body.title || '新对话').slice(0, 120), projectId: String(body.projectId || '') });
      return sendJson(res, 201, { ok: true, data: { conversation: conv, messages: [] } });
    }
    const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|start))?$/);
    if (convMatch) {
      const [, convId, action] = convMatch;
      const conv = store.getConversation(convId);
      if (!conv) return sendError(res, 404, 'CONVERSATION_NOT_FOUND', '对话不存在');
      if (!action && method === 'GET') {
        const project = conv.project_id ? store.getProject(conv.project_id) : null;
        const loop = conv.loop_id ? store.getLoop(conv.loop_id) : (project ? store.listLoops({ projectId: project.id })[0] : null);
        const latestProjectRun = project && !loop?.current_run_id ? (store.listRuns(project.id, 1)[0] || null) : null;
        const runContext = loop?.current_run_id ? 'conversation' : (latestProjectRun ? 'project_latest' : '');
        const runId = loop?.current_run_id || conv.run_id || latestProjectRun?.id || '';
        const run = runId ? store.getRun(runId) : null;
        return sendJson(res, 200, { ok: true, data: { conversation: conv, messages: store.listConversationMessages(convId), project, loop, run, runContext } });
      }
      if (pathname === `/api/conversations/${convId}/start` && method === 'POST') {
        const body = await readBody(req, maxBody).catch(() => ({}));
        const brief = body.brief && typeof body.brief === 'object' ? body.brief : {};
        const acceptance = Array.isArray(brief.acceptance) ? brief.acceptance.map(String) : (conv.brief_json?.acceptance || []);
        const goal = String(brief.goal || conv.goal || '').trim();
        const updatedConv = store.updateConversation(conv.id, {
          title: String(brief.productName || conv.title || '新软件产品').slice(0, 120),
          goal,
          acceptance_json: acceptance,
          brief_json: { ...(conv.brief_json || {}), ...brief, acceptance },
          project_id: body.projectId || conv.project_id || '',
        });
        let started;
        try {
          started = await startDevelopment({ config, store, orchestrator, loops, conversation: updatedConv, projectId: body.projectId || '' });
        } catch (err) {
          // 不把对话卡在 starting；项目/loop 失败保留真实错误，允许用户重试且复用已建项目。
          store.updateConversation(conv.id, { status: 'ready', brief_json: { ...(conv.brief_json || {}), lastError: String(err?.message || err) } });
          throw err;
        }
        const message = store.addConversationMessage({ conversationId: conv.id, role: 'assistant', content: started.existing ? '这个目标已经在开发中，我带你回到当前进度。' : '已开始开发。我会自动完成规划、编码、测试与独立审计；遇到问题时先尝试自动修复，需要你授权时再告诉你。', data: { kind: 'started', projectId: started.project?.id, loopId: started.loop?.id } });
        store.updateConversation(conv.id, { status: 'running', run_id: started.loop?.current_run_id || '', loop_id: started.loop?.id || conv.loop_id });
        return sendJson(res, 200, { ok: true, data: { conversation: store.getConversation(conv.id), messages: store.listConversationMessages(conv.id), project: started.project, loop: started.loop, message } });
      }
      if (pathname === `/api/conversations/${convId}/messages` && method === 'POST') {
        const body = await readBody(req, maxBody);
        const content = String(body.content || '').trim();
        if (!content) throw new PolicyError('CHAT_MESSAGE_EMPTY', '消息不能为空');
        if (content.length > 8000) throw new PolicyError('CHAT_MESSAGE_TOO_LONG', '消息过长');
        let conversation = conv;
        if (body.projectId && !conversation.project_id) conversation = store.updateConversation(conv.id, { project_id: String(body.projectId) });
        const project = conversation.project_id ? store.getProject(conversation.project_id) : null;
        store.addConversationMessage({ conversationId: conversation.id, role: 'user', content });
        let turn;
        try {
          turn = await chatTurn({ config, store, conversation, userMessage: content, project });
        } catch (err) {
          const message = redactForResponse(String(err?.message || err), config);
          store.addConversationMessage({ conversationId: conversation.id, role: 'assistant', content: `暂时无法调用对话模型：${message}`, data: { kind: 'error', error: message } });
          return sendError(res, 503, err?.code || 'CHAT_MODEL_ERROR', message, {}, config);
        }
        const acceptance = turn.acceptance.length ? turn.acceptance : (conversation.brief_json?.acceptance || []);
        const updated = store.updateConversation(conversation.id, {
          title: conversation.status === 'draft' && turn.productName ? turn.productName.slice(0, 120) : conversation.title,
          goal: turn.goal || conversation.goal,
          acceptance_json: acceptance,
          brief_json: { ...(conversation.brief_json || {}), productName: turn.productName, goal: turn.goal, acceptance, ready: turn.ready, missing: turn.missing, provider: turn.provider, model: turn.model, costCny: turn.costCny },
          status: turn.ready ? 'ready' : 'draft',
        });
        const assistant = store.addConversationMessage({ conversationId: conversation.id, role: 'assistant', content: turn.reply, data: { kind: 'brief', ...turn } });
        return sendJson(res, 200, { ok: true, data: { conversation: updated, messages: store.listConversationMessages(conversation.id), assistant } });
      }
    }

    // v2.6 只读观察层：研发实况 / 历史回放 / Git diff（不写入任何研发状态）
    if (pathname === '/api/live' && method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      return sendJson(res, 200, { ok: true, data: buildLive(store, projectId) });
    }

    if (pathname === '/api/replay' && method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      const eventLimit = Number(url.searchParams.get('eventLimit') || 1000);
      const eventBefore = Number(url.searchParams.get('eventBefore') || 0);
      return sendJson(res, 200, { ok: true, data: buildReplay(store, projectId, { eventLimit, eventBefore }) });
    }

    // v2.6 兼容别名：行为与 /api/replay 相同，但不再硬编码消费产品名称。
    if (pathname === '/api/replay/consumption' && method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      const eventLimit = Number(url.searchParams.get('eventLimit') || 1000);
      const eventBefore = Number(url.searchParams.get('eventBefore') || 0);
      return sendJson(res, 200, { ok: true, data: buildReplay(store, projectId, { eventLimit, eventBefore }) });
    }

    const replayCommitMatch = pathname.match(/^\/api\/replay\/(?:consumption\/)?commits\/([0-9a-fA-F]{7,40})$/);
    if (replayCommitMatch && method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      const projects = store.listProjects().filter((p) => p.id !== '');
      let replayProject = projectId ? projects.find((p) => p.id === projectId) : null;
      if (!replayProject) replayProject = projects.find((p) => !/(Global Opportunity Engine|Investment Agent)/i.test(p.name)) || null;
      const commit = replayProject ? readProjectCommit(store, replayProject.id, replayCommitMatch[1]) : null;
      if (!commit) throw new PolicyError('COMMIT_NOT_FOUND', '该 Commit 不在已授权项目仓库历史中');
      return sendJson(res, 200, { ok: true, data: commit });
    }

    if (pathname === '/api/config' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        data: {
          version: VERSION,
          budget: orchestrator.budget(),
          audit: (await import('./auditors/index.js')).auditProviderStatus(config),
          agents: await orchestrator.agentsStatus(),
          github: {
            configured: !!config.github.token,
            owner: config.github.owner,
          },
          policy: {
            neverMerge: config.policy.neverMerge,
            maxAttempts: config.budget.maxAttempts,
            protectedPaths: config.policy.protectedPaths,
          },
        },
      });
    }

    if (pathname === '/api/agents' && method === 'GET') {
      return sendJson(res, 200, { ok: true, data: await orchestrator.agentsStatus() });
    }

    if (pathname === '/api/projects' && method === 'GET') {
      return sendJson(res, 200, { ok: true, data: store.listProjects() });
    }

    if (pathname === '/api/projects' && method === 'POST') {
      const body = await readBody(req, maxBody);
      const project = await orchestrator.createProject(body);
      return sendJson(res, 201, { ok: true, data: project });
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      if (method === 'GET') {
        const project = store.getProject(projectId);
        if (!project) throw new PolicyError('PROJECT_NOT_FOUND', '项目不存在');
        return sendJson(res, 200, { ok: true, data: { ...project, runs: store.listRuns(projectId, 20), plans: store.listPlans(projectId) } });
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readBody(req, maxBody);
        const project = orchestrator.updateProject(projectId, body);
        return sendJson(res, 200, { ok: true, data: project });
      }
    }

    const projectQualityMatch = pathname.match(/^\/api\/projects\/([^/]+)\/quality$/);
    if (projectQualityMatch && method === 'GET') {
      const project = store.getProject(projectQualityMatch[1]);
      if (!project) throw new PolicyError('PROJECT_NOT_FOUND', '项目不存在');
      const loops = store.listLoops({ projectId: project.id });
      let matrix = null;
      for (const loop of loops) {
        const found = latestMatrixFromHistory(loop);
        if (found) { matrix = found; break; }
      }
      return sendJson(res, 200, { ok: true, data: { configured: !!qualityConfig(project), matrix } });
    }

    const projectRunsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
    if (projectRunsMatch) {
      if (method === 'POST') {
        const body = await readBody(req, maxBody);
        const result = await orchestrator.startRun({ ...body, projectId: projectRunsMatch[1] });
        return sendJson(res, 201, { ok: true, data: result });
      }
      if (method === 'GET') {
        return sendJson(res, 200, { ok: true, data: store.listRuns(projectRunsMatch[1], 30) });
      }
    }

    if (pathname === '/api/runs' && method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      return sendJson(res, 200, { ok: true, data: store.listRuns(projectId || null, 50) });
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      const detail = orchestrator.runDetail(runMatch[1]);
      if (!detail) throw new PolicyError('RUN_NOT_FOUND', '运行不存在');
      return sendJson(res, 200, { ok: true, data: detail });
    }

    const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (runEventsMatch && method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      const events = store.listEvents({ runId: runEventsMatch[1], after: Number.isFinite(after) ? after : 0, limit: 500 });
      return sendJson(res, 200, { ok: true, data: events });
    }

    const runActionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/(pause|resume|cancel|accept|ci-refresh)$/);
    if (runActionMatch && method === 'POST') {
      const [, runId, action] = runActionMatch;
      if (action === 'pause') {
        const body = await readBody(req, maxBody).catch(() => ({}));
        return sendJson(res, 200, { ok: true, data: orchestrator.pauseRun(runId, body.reason || '人工暂停', 'manual') });
      }
      if (action === 'resume') {
        const body = await readBody(req, maxBody).catch(() => ({}));
        return sendJson(res, 200, { ok: true, data: await orchestrator.resumeRun(runId, { retryFailed: !!body.retryFailed }) });
      }
      if (action === 'cancel') {
        return sendJson(res, 200, { ok: true, data: orchestrator.cancelRun(runId) });
      }
      if (action === 'accept') {
        const body = await readBody(req, maxBody).catch(() => ({}));
        return sendJson(res, 200, { ok: true, data: orchestrator.acceptRun(runId, { confirmLocalOnly: !!body.confirmLocalOnly }) });
      }
      if (action === 'ci-refresh') {
        return sendJson(res, 200, { ok: true, data: await orchestrator.refreshCi(runId) });
      }
    }

    const reconcileMatch = pathname.match(/^\/api\/runs\/([^/]+)\/reconcile$/);
    if (reconcileMatch && method === 'POST') {
      return sendJson(res, 200, { ok: true, data: orchestrator.reconcileRun(reconcileMatch[1]) });
    }

    const taskRetryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/retry-verification$/);
    if (taskRetryMatch && method === 'POST') {
      return sendJson(res, 200, { ok: true, data: await orchestrator.retryVerification(taskRetryMatch[1]) });
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'GET') {
      const detail = orchestrator.taskDetail(taskMatch[1]);
      if (!detail) throw new PolicyError('TASK_NOT_FOUND', '任务不存在');
      return sendJson(res, 200, { ok: true, data: detail });
    }

    if (pathname === '/api/artifacts' && method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      const content = orchestrator.artifactContent(rel);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(content);
    }

    if (pathname === '/api/approvals' && method === 'GET') {
      const status = url.searchParams.get('status') || 'pending';
      return sendJson(res, 200, { ok: true, data: store.listApprovals({ status: status === 'all' ? '' : status }) });
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
    if (approvalMatch && method === 'POST') {
      const body = await readBody(req, maxBody).catch(() => ({}));
      return sendJson(res, 200, {
        ok: true,
        data: orchestrator.decideApproval(approvalMatch[1], { decision: approvalMatch[2] === 'approve' ? 'approved' : 'rejected', decidedBy: body.decidedBy || 'human' }),
      });
    }

    if (pathname === '/api/supervisor/recover' && method === 'POST') {
      const recoveredRuns = await orchestrator.recoverSupervisedRuns();
      const recoveredLoops = [];
      if (loops) {
        const supervisedProjects = new Set(store.listProjects().filter((p) => p.config_json?.supervisor_managed === true).map((p) => p.id));
        for (const loop of store.listLoops({ status: 'interrupted' })) {
          if (!supervisedProjects.has(loop.project_id)) continue;
          const current = loop.current_run_id ? await orchestrator.reconcileInterruptedRun(loop.current_run_id).catch((err) => ({ ok: false, failures: [err.message] })) : { ok: true };
          if (!current.ok) { recoveredLoops.push({ loopId: loop.id, resumed: false, reason: current.failures?.join('；') }); continue; }
          try {
            await loops.resume(loop.id, { retryCurrent: true });
            recoveredLoops.push({ loopId: loop.id, resumed: true });
          } catch (err) {
            recoveredLoops.push({ loopId: loop.id, resumed: false, reason: err.message });
          }
        }
      }
      return sendJson(res, 200, { ok: true, data: { recoveredRuns, recoveredLoops, at: new Date().toISOString() } });
    }

    if (pathname === '/api/loops' && method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      return sendJson(res, 200, { ok: true, data: loops ? loops.list(projectId) : [] });
    }

    const projectLoopsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/loops$/);
    if (projectLoopsMatch && method === 'POST') {
      if (!loops) throw new PolicyError('LOOP_UNAVAILABLE', '研发循环模块未启用');
      const body = await readBody(req, maxBody);
      return sendJson(res, 201, { ok: true, data: await loops.create({ ...body, projectId: projectLoopsMatch[1] }) });
    }

    const loopMatch = pathname.match(/^\/api\/loops\/([^/]+)(?:\/(pause|resume|cancel))?$/);
    if (loopMatch) {
      if (!loops) throw new PolicyError('LOOP_UNAVAILABLE', '研发循环模块未启用');
      const [, loopId, action] = loopMatch;
      if (!action && method === 'GET') return sendJson(res, 200, { ok: true, data: loops.get(loopId) });
      if (action && method === 'POST') {
        const body = await readBody(req, maxBody).catch(() => ({}));
        if (action === 'pause') return sendJson(res, 200, { ok: true, data: await loops.pause(loopId, body.reason || '人工暂停') });
        if (action === 'resume') return sendJson(res, 200, { ok: true, data: await loops.resume(loopId, { retryCurrent: !!body.retryCurrent }) });
        if (action === 'cancel') return sendJson(res, 200, { ok: true, data: await loops.cancel(loopId, body.reason || '人工取消') });
      }
    }

    if (pathname === '/api/isolation' && method === 'GET') {
      const caps = isolation();
      return sendJson(res, 200, { ok: true, data: { ...caps, container: containerCapabilities(config), projectModes: store.listProjects().map((p) => ({ id: p.id, name: p.name, mode: isolationModeForProject(config, p) })) } });
    }

    // 只读：执行能力接口（v2.2）。复用 /api/isolation 的同一套能力探测
    // （detectIsolationCapabilities 缓存快照 + containerCapabilities），不新增依赖；
    // 响应字段在本路由内显式归一化，形状与 docs/API.md「执行能力（v2.2）」逐字段对应。
    if (pathname === '/api/executor' && method === 'GET') {
      const caps = isolation();
      const container = containerCapabilities(config);
      return sendJson(res, 200, {
        ok: true,
        data: {
          isolation: {
            platform: caps.platform,
            kernelIsolation: caps.kernelIsolation,
            kernelAvailable: caps.kernelAvailable,
            docker: { available: !!caps.docker.available, engine: caps.docker.engine, version: caps.docker.version, reason: caps.docker.reason },
            sandboxExec: { available: !!caps.sandboxExec.available, engine: caps.sandboxExec.engine, reason: caps.sandboxExec.reason },
            restrictedRuntime: caps.restrictedRuntime,
            note: caps.note,
          },
          container: {
            testExecution: !!container.testExecution,
            agentExecution: !!container.agentExecution,
            docker: { available: !!container.docker.available, version: container.docker.version, reason: container.docker.reason },
            image: { name: container.image.name, available: !!container.image.available, id: container.image.id, reason: container.image.reason },
            agentBackends: container.agentBackends,
            network: { test: container.network.test, agent: container.network.agent },
            security: container.security,
            note: container.note,
          },
          fallback: {
            mode: 'restricted',
            available: true,
            note: '容器执行不可用或项目未要求容器时，测试/Agent 在宿主受限独立运行环境执行（独立 HOME/TMPDIR、最小环境变量，无内核级隔离）；项目显式要求 docker 隔离时按 fail-closed 阻塞，不降级提权',
          },
          note: 'GET /api/executor 汇报执行能力：isolation 为宿主隔离能力快照，container.testExecution / container.agentExecution 表示在 Docker 容器内执行测试 / Claude Agent 的可用性（Docker daemon 与运行时镜像齐备）。探测复用 /api/isolation 同源实现，不新增依赖。',
        },
      });
    }

    if (pathname === '/api/budget' && method === 'GET') {
      return sendJson(res, 200, { ok: true, data: orchestrator.budget() });
    }

    // 只读：按 provider 拆分用量。响应体在本路由内显式归一化，
    // 保证 byProvider/glm/nonGlm 的字段形状与 docs/API.md 可逐字段核对。
    if (pathname === '/api/usage/providers' && method === 'GET') {
      const snapshot = orchestrator.budget();
      const num = (value) => Number(value) || 0;
      // byProvider：每个 provider 统一为 {tokensIn,tokensOut,tokensCache,tokens,costCny}；
      // tokens 明确定义为 tokensIn + tokensOut + tokensCache（原始用量，不做预算折算）。
      const byProvider = {};
      for (const [name, agg] of Object.entries(snapshot.byProvider || {})) {
        const tokensIn = num(agg?.tokensIn);
        const tokensOut = num(agg?.tokensOut);
        const tokensCache = num(agg?.tokensCache);
        byProvider[name] = {
          tokensIn,
          tokensOut,
          tokensCache,
          tokens: tokensIn + tokensOut + tokensCache,
          costCny: num(agg?.costCny),
        };
      }
      // glm 单列：无调用时也返回稳定的零值结构，便于前端与审计逐字段核对。
      const glm = byProvider.glm || { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0 };
      // nonGlm：剔除预算豁免 provider（默认仅 glm）后汇总；names 列出被汇总的 provider。
      const exempt = new Set((snapshot.exemptProviders || ['glm']).map((name) => String(name).toLowerCase()));
      const nonGlm = { tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, costCny: 0, names: [] };
      for (const [name, agg] of Object.entries(byProvider)) {
        if (exempt.has(name.toLowerCase())) continue;
        nonGlm.tokensIn += agg.tokensIn;
        nonGlm.tokensOut += agg.tokensOut;
        nonGlm.tokensCache += agg.tokensCache;
        nonGlm.tokens += agg.tokens;
        nonGlm.costCny += agg.costCny;
        nonGlm.names.push(name);
      }
      // budget：约束口径。本路由按 byProvider 与 exemptProviders/cacheTokenWeight 直接汇总，
      // 因此 GLM 排除与缓存折算逻辑可在同一处代码核对；usedTokens/usedCostCny 为约束口径用量。
      const weight = num(snapshot.cacheTokenWeight ?? 0.1);
      let weightedTokens = 0;
      let weightedCost = 0;
      for (const [name, agg] of Object.entries(byProvider)) {
        if (exempt.has(name.toLowerCase())) continue;
        weightedTokens += agg.tokensIn + agg.tokensOut + agg.tokensCache * weight;
        weightedCost += agg.costCny;
      }
      const maxTokens = num(snapshot.maxTokens);
      const maxCostCny = num(snapshot.maxCostCny);
      const budget = {
        maxTokens,
        usedTokens: Math.round(weightedTokens),
        remainingTokens: Math.max(0, maxTokens - weightedTokens),
        maxCostCny,
        usedCostCny: Number(weightedCost.toFixed(4)),
        remainingCostCny: Math.max(0, maxCostCny - weightedCost),
        cacheTokenWeight: weight,
        tokensPercent: maxTokens > 0 ? Math.min(100, Math.round((weightedTokens / maxTokens) * 1000) / 10) : 0,
        costPercent: maxCostCny > 0 ? Math.min(100, Math.round((weightedCost / maxCostCny) * 1000) / 10) : 0,
      };
      return sendJson(res, 200, {
        ok: true,
        data: {
          byProvider,
          glm,
          nonGlm,
          budget,
          note: 'GLM 用量完整记录并在 glm 单列，不受工作台内部 token/费用上限约束；nonGlm 汇总其余非豁免 provider，budget 为其预算约束口径的用量与余量（缓存 token 按 cacheTokenWeight 折算）；byProvider 为各 provider 的原始 tokens/cost 明细。',
        },
      });
    }

    return sendError(res, 404, 'NOT_FOUND', `未知接口：${method} ${pathname}`);
  }

  function serveStatic(pathname, res) {
    let rel = pathname === '/' ? 'index.html' : pathname === '/advanced' ? 'advanced.html' : pathname.replace(/^\/+/, '');
    let abs;
    try {
      abs = resolveWithin(webDir, rel);
    } catch {
      return sendError(res, 403, 'FORBIDDEN', '非法路径');
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      // 单页应用回退
      const index = path.join(webDir, 'index.html');
      if (fs.existsSync(index)) {
        const content = fs.readFileSync(index);
        res.writeHead(200, {
          'Content-Type': MIME['.html'], 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
          'Set-Cookie': `wb_token=${apiToken}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return res.end(content);
      }
      return sendError(res, 404, 'NOT_FOUND', '页面不存在');
    }
    const ext = path.extname(abs).toLowerCase();
    const content = fs.readFileSync(abs);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
    };
    if (ext === '.html') {
      headers['Set-Cookie'] = `wb_token=${apiToken}; HttpOnly; SameSite=Strict; Path=/`;
    }
    res.writeHead(200, headers);
    return res.end(content);
  }

  server.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  });

  return server;
}

export function startServer({ config, store, orchestrator, loops = null, logger = console }) {
  const server = createApp({ config, store, orchestrator, loops });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      const addr = server.address();
      logger.log(`\n   AI 开发工作台已启动：http://${config.server.host}:${addr.port}`);
      logger.log(`   数据目录：${config.paths.dataDir}`);
      logger.log(`   按 Ctrl+C 停止\n`);
      resolve(server);
    });
  });
}
