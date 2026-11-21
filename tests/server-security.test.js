// SPDX-License-Identifier: Apache-2.0
/**
 * 集成测试：src/server.js HTTP 安全边界（真实 server + 真实临时 SQLite + 假 Agent/审计依赖）。
 *
 * 完全离线：
 *  - 仅监听 127.0.0.1 的随机端口（listen(0)），不占用 4477；
 *  - config.paths / DB / web 静态目录全部指向 os.tmpdir() 临时目录，不触碰真实 data/；
 *  - deps.checkAgents 为假实现，runAgent/runAudit 被意外调用时立即失败；
 *  - 测试结束关闭 server 与 store 并删除临时目录。
 *
 * 覆盖（P0-5）：health 免认证、API Token 认证、跨站 Origin/Sec-Fetch-Site 拒绝、Host 校验、
 * 静态路径穿越拒绝、/api/artifacts 路径越界拒绝、静态首页 Set-Cookie(wb_token) 与 CSP。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator, VERSION } from '../src/orchestrator.js';
import { createApp } from '../src/server.js';

let tmpRoot;
let config;
let store;
let server;
let port;
let baseUrl;
let token;

/** 认证头：默认带上从 data/api-token 读到的 Token。 */
const authedHeaders = (extra = {}) => ({ 'x-workbench-token': token, ...extra });

/** 用原生 http 发请求（便于精确控制 Host 等 fetch 不允许设置的请求头）。 */
function rawRequest({ method = 'GET', requestPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-server-security-'));
  const dataDir = path.join(tmpRoot, 'data');
  const webDir = path.join(tmpRoot, 'web');
  fs.mkdirSync(webDir, { recursive: true });
  // 最小前端首页：serveStatic 会从 config.paths.root/web 提供静态资源
  fs.writeFileSync(
    path.join(webDir, 'index.html'),
    '<!doctype html>\n<html lang="zh-CN"><body><main id="app">server-security-fixture</main></body></html>\n',
  );

  config = getConfig({
    root: tmpRoot,
    paths: {
      root: tmpRoot,
      dataDir,
      dbPath: path.join(dataDir, 'workbench.db'),
      projectsDir: path.join(tmpRoot, 'projects'),
      worktreesDir: path.join(dataDir, 'worktrees'),
      artifactsDir: path.join(dataDir, 'artifacts'),
      logsDir: path.join(dataDir, 'logs'),
      agentsDir: path.join(dataDir, 'agents'),
      dshHome: path.join(dataDir, 'agents', 'dsh-home'),
      claudeHome: path.join(dataDir, 'agents', 'claude-home'),
    },
    // 清空所有密钥与 GitHub 配置：确保任何路径都不可能发起真实网络请求
    secrets: [],
    llm: {
      openai: { apiKey: '' },
      glm: { apiKey: '' },
      deepseek: { apiKey: '' },
    },
    github: { token: '', owner: '', createPr: false, push: false, autoCreateRepo: false },
    // apiToken 置空：验证 server 启动时自动生成随机 Token 并写入 data/api-token
    security: { apiToken: '', allowedHosts: [], testEnvAllowlist: [] },
    audit: { provider: 'auto', timeoutMs: 30_000 },
    agents: {
      default: 'auto',
      dsh: { bin: '/nonexistent/wb-test-bin/dsh', timeoutMs: 30_000, permissionMode: 'workspace-write' },
      claude: { bin: '/nonexistent/wb-test-bin/claude', timeoutMs: 30_000, permissionMode: 'acceptEdits' },
    },
  });

  store = openStore(config.paths.dbPath);
  const bus = new EventBus();
  const orchestrator = new Orchestrator({
    config,
    store,
    bus,
    deps: {
      checkAgents: async () => [{ id: 'dsh', label: 'fake dsh', ok: false, detail: 'offline test', capabilities: {} }],
      runAgent: async () => {
        throw new Error('runAgent 不应被调用');
      },
      runAudit: async () => {
        throw new Error('runAudit 不应被调用');
      },
      chooseAgent: async () => {
        throw new Error('chooseAgent 不应被调用');
      },
    },
  });

  server = createApp({ config, store, orchestrator });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  token = fs.readFileSync(path.join(config.paths.dataDir, 'api-token'), 'utf8');
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('server 认证：健康检查免 Token，其余 API 强制 Token', () => {
  it('GET /api/health 无需 Token 返回 200', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, VERSION);
    assert.equal(typeof body.at, 'string');
  });

  it('无 Token 的 GET /api/state 返回 401，且响应不泄露 Token', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    assert.equal(res.status, 401);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'API_AUTH_REQUIRED');
    assert.equal(bodyText.includes(token), false, '未认证响应不应回显 API Token');
  });

  it('错误 Token 的 GET /api/state 返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/state`, { headers: { 'x-workbench-token': 'wrong-token-000' } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'API_AUTH_REQUIRED');
  });

  it('data/api-token 为 0600 随机 Token；带 x-workbench-token 访问 /api/state 返回 200', async () => {
    const tokenFile = path.join(config.paths.dataDir, 'api-token');
    assert.ok(fs.existsSync(tokenFile));
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);

    const res = await fetch(`${baseUrl}/api/state`, { headers: authedHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.version, VERSION);
    assert.deepEqual(body.data.projects, []);
    assert.ok(Array.isArray(body.data.agents));
    assert.ok(Array.isArray(body.data.runs));
  });

  it('Authorization: Bearer <token> 同样通过认证', async () => {
    const res = await fetch(`${baseUrl}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

describe('server 写请求防护：跨站 Origin / Sec-Fetch-Site 拒绝', () => {
  it('跨站 Origin 的写请求返回 403 ORIGIN_FORBIDDEN，且不产生副作用', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: authedHeaders({ origin: 'https://evil.example', 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'evil-project' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'ORIGIN_FORBIDDEN');
    // 写请求在路由前被拦截：项目没有被创建
    assert.equal(store.listProjects().length, 0);
  });

  it('Sec-Fetch-Site: cross-site 的写请求返回 403 CSRF_BLOCKED', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: authedHeaders({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'csrf-project' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'CSRF_BLOCKED');
    assert.equal(store.listProjects().length, 0);
  });

  it('Host 非本机回环的请求返回 403 HOST_FORBIDDEN（防 DNS rebinding）', async () => {
    const res = await rawRequest({ requestPath: '/api/health', headers: { host: 'evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error.code, 'HOST_FORBIDDEN');
  });
});

describe('server 路径边界：静态与 artifact 越界均被拒绝', () => {
  it('/api/artifacts 的 path 参数越界返回 400 PATH_OUTSIDE_ROOT', async () => {
    const evilPaths = ['../../etc/passwd', '/etc/passwd', '../../.ssh/id_rsa'];
    for (const evilPath of evilPaths) {
      const res = await fetch(`${baseUrl}/api/artifacts?path=${encodeURIComponent(evilPath)}`, { headers: authedHeaders() });
      assert.equal(res.status, 400, `path=${evilPath} 应被拒绝`);
      const body = await res.json();
      assert.ok(['PATH_OUTSIDE_ROOT', 'ARTIFACT_FORBIDDEN'].includes(body.error.code), `path=${evilPath} 应被拒绝，实际 ${body.error.code}`);
      assert.equal(JSON.stringify(body).includes('root:'), false);
    }
  });

  it('静态资源编码后的 ../ 穿越返回 403 FORBIDDEN', async () => {
    const res = await fetch(`${baseUrl}/..%2f..%2fetc%2fpasswd`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'FORBIDDEN');
    assert.equal(JSON.stringify(body).includes('root:'), false);
  });
});

describe('server 静态首页：下发 Token Cookie 与安全响应头', () => {
  it('GET / 返回 200，包含 Set-Cookie wb_token 与 CSP 等安全头', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('server-security-fixture'));

    const setCookie = res.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes(`wb_token=${token}`), 'Set-Cookie 应携带服务端生成的 Token');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    // Cookie 中的 Token 与 data/api-token 一致（浏览器据此通过后续 API 认证）
    assert.equal(setCookie.includes(token), true);

    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"), 'CSP 应限制 default-src 为 self');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP 应禁止被嵌套');
    assert.ok(csp.includes("connect-src 'self'"));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('静态首页无需 Token 即可访问（仅 API 强制认证）', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: {} });
    assert.equal(res.status, 200);
  });
});
