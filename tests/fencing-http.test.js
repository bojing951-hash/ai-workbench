// SPDX-License-Identifier: Apache-2.0
/** v2.7 P1-D：两个完整 Workbench HTTP 服务实例竞争同一隔离数据库/项目。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject);
  });
}
async function waitHealth(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function api(port, token, method, pathName, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, { method, headers: { 'x-workbench-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

test('v2.7 P1-D：两个完整 Workbench HTTP 服务进程竞争同一项目，只有一个能创建运行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-http-fence-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); fs.writeFileSync(path.join(repo, 'README.md'), 'x'); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data'); const token = 'test-token-http-fence-0001';
  const ports = [await freePort(), await freePort()];
  const env = {
    ...process.env,
    WORKBENCH_ROOT: process.cwd(),
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'),
    WORKBENCH_API_TOKEN: token,
    WORKBENCH_HOST: '127.0.0.1',
    WORKBENCH_PORT: String(ports[0]),
  };
  const logs = [];
  const spawnServer = (port) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'bin/workbench.js', 'serve', '--port', String(port)], { cwd: process.cwd(), env: { ...env, WORKBENCH_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logs.push(String(d))); child.stderr.on('data', (d) => logs.push(String(d))); return child;
  };
  const servers = [];
  try {
    servers.push(spawnServer(ports[0]));
    assert.equal(await waitHealth(ports[0]), true, logs.join(''));
    servers.push(spawnServer(ports[1]));
    assert.equal(await waitHealth(ports[1]), true, logs.join(''));
    const created = await api(ports[0], token, 'POST', '/api/projects', { name: 'HTTP fence project', repo, defaultBranch: 'main', testCommand: 'true', auditProvider: 'glm', ciRequired: false });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const pid = created.data.data.id;
    const payload = { goal: 'two servers race', mode: 'single', tasks: [{ title: 't1', description: 'd', acceptance: ['a'], agent: 'custom', testCommand: 'true' }] };
    const [a, b] = await Promise.all([
      api(ports[0], token, 'POST', `/api/projects/${pid}/runs`, payload),
      api(ports[1], token, 'POST', `/api/projects/${pid}/runs`, payload),
    ]);
    const successes = [a, b].filter((r) => r.status === 201);
    const failures = [a, b].filter((r) => r.status !== 201);
    assert.equal(successes.length, 1, `只能一个服务创建 run；results=${JSON.stringify([a.status, b.status, a.data, b.data])}`);
    assert.equal(failures.length, 1);
    const code = failures[0].data?.error?.code || '';
    assert.match(code, /PROJECT_LEASE_HELD|PROJECT_BUSY|LEASE/);
    // 两个服务看到同一个 run；不能出现双重创建。
    const stateA = await api(ports[0], token, 'GET', '/api/state');
    const runs = stateA.data.data.runs.filter((r) => r.project_id === pid);
    assert.equal(runs.length, 1, `不得双重创建 run：${JSON.stringify(runs.map((r) => r.id))}`);
  } finally {
    for (const s of servers) s.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    for (const s of servers) s.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
