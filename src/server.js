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
import { VERSION } from './orchestrator.js';
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

export function createApp({ config, store, orchestrator }) {
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
      return sendJson(res, 200, { ok: true, data: await orchestrator.state() });
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

    if (pathname === '/api/budget' && method === 'GET') {
      return sendJson(res, 200, { ok: true, data: orchestrator.budget() });
    }

    return sendError(res, 404, 'NOT_FOUND', `未知接口：${method} ${pathname}`);
  }

  function serveStatic(pathname, res) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
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
    if (path.basename(abs) === 'index.html' || pathname === '/') {
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

export function startServer({ config, store, orchestrator, logger = console }) {
  const server = createApp({ config, store, orchestrator });
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
