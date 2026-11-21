// SPDX-License-Identifier: Apache-2.0
/**
 * v3.5：真实 Workbench Server + Supervisor 启动流程的 SIGKILL 恢复测试。
 * Coding Agent 使用零付费 custom 脚本；独立审计使用本地 mock LLM，不产生厂商费用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 20_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await sleep(200); } return false; }
async function api(port, token, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
async function waitFor(fn, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error('timeout'); }

test('v3.5 真实 Workbench Server：Coding 中 SIGKILL → 重启自动恢复 → 测试/审计/Commit/awaiting_acceptance', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-server-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  fs.writeFileSync(path.join(repo, 'README.md'), '# product\n'); git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const agent = path.join(root, 'fake-agent.sh');
  fs.writeFileSync(agent, `#!/bin/sh\nset -eu\nif [ ! -f .agent-started ]; then\n  echo started > .agent-started\n  printf 'const partial = true;\\n' > partial.js\n  sleep 30\nfi\nprintf 'const implemented = true;\\n' > implemented.js\nprintf '{"result":"implemented","session_id":"sess-server","usage":{"input_tokens":2,"output_tokens":2},"cost_cny":0}\\n'\n`);
  fs.chmodSync(agent, 0o755);
  const mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += String(d); }); req.on('end', () => {
      const audit = { score: 100, criteria: [{ criterion: 'A 完成', status: 'pass', evidence: 'implemented.js 已写入且测试通过' }], findings: [], required_fixes: [], summary: 'PASS' };
      const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(audit) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;
  const port = await freePort(); const token = 'test-token-server-sigkill-0001';
  const dataDir = path.join(root, 'data');
  const env = {
    ...process.env,
    WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'),
    WORKBENCH_API_TOKEN: token, WORKBENCH_HOST: '127.0.0.1', WORKBENCH_PORT: String(port),
    DEFAULT_AGENT: 'custom', CUSTOM_AGENT_BIN: agent, CUSTOM_AGENT_ARGS: '',
    AUDIT_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-local-key', OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, OPENAI_AUDIT_MODEL: 'fake-audit',
    AUDIT_REQUIRE_INDEPENDENT: 'false',
    GITHUB_TOKEN: '', GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false', GITHUB_AUTO_CREATE_REPO: 'false',
    MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100', MAX_TOKENS_PER_TASK: '600000',
    AGENT_STALL_TIMEOUT_MS: '120000', CONTAINER_AGENT_STALL_TIMEOUT_MS: '2700000',
  };
  const logs = [];
  let server = null;
  const startServer = async () => {
    server = spawn(NODE, ['--no-warnings=ExperimentalWarning', 'bin/workbench.js', 'serve', '--port', String(port)], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    server.stdout.on('data', (d) => logs.push(String(d))); server.stderr.on('data', (d) => logs.push(String(d)));
    assert.equal(await waitHealth(port), true, logs.join('').slice(-4000));
  };
  const killGroup = async () => { if (!server) return; const s = server; server = null; try { process.kill(-s.pid, 'SIGKILL'); } catch { try { s.kill('SIGKILL'); } catch { /* ignore */ } } await new Promise((r) => s.once('exit', r)); };
  try {
    await startServer();
    const created = await api(port, token, 'POST', '/api/projects', { name: 'server-sigkill', repo, defaultBranch: 'main', testCommand: `${NODE} -e "process.exit(0)"`, auditProvider: 'openai', agent: 'custom', ciRequired: false, config: { test_isolation: 'none', container_test: false }, supervisorManaged: true });
    assert.equal(created.status, 201, JSON.stringify(created.data)); const pid = created.data.data.id;
    const started = await api(port, token, 'POST', `/api/projects/${pid}/runs`, { goal: '实现 A', mode: 'single', tasks: [{ title: '实现 A', acceptance: ['A 完成'], testCommand: `${NODE} -e "process.exit(0)"`, agent: 'custom' }] });
    assert.equal(started.status, 201, JSON.stringify(started.data)); const runId = started.data.data.runId;
    const wt = await waitFor(async () => { const d = await api(port, token, 'GET', `/api/runs/${runId}`); const t = d.data?.data?.tasks?.[0]; return t?.status === 'coding' && fs.existsSync(path.join(t.worktree_path, 'partial.js')) ? t.worktree_path : null; }, 30_000);
    assert.ok(fs.existsSync(path.join(wt, 'partial.js')), 'SIGKILL 前必须已有真实未提交代码');
    await killGroup();
    server = null; await sleep(500);
    // Supervisor/Server 重启：自动清理 + recoverOrphans + supervised run 自动续跑。
    await startServer();
    let run;
    try { run = await waitFor(async () => { const d = await api(port, token, 'GET', `/api/runs/${runId}`); return d.data?.data?.status === 'awaiting_acceptance' ? d.data.data : null; }, 45_000); }
    catch (err) { const d = await api(port, token, 'GET', `/api/runs/${runId}`); console.error('SERVER LOGS:\n' + logs.join('').slice(-6000)); console.error('RUN STATE:', JSON.stringify(d.data?.data?.status)); console.error('TASKS:', JSON.stringify(d.data?.data?.tasks)); throw err; }
    assert.equal(run.status, 'awaiting_acceptance', JSON.stringify(run));
    assert.equal(run.tasks.length, 1, '不得重复创建 Task');
    assert.equal(run.tasks[0].status, 'passed');
    assert.ok(run.tasks[0].head_commit, '必须有最终 Git Commit');
    const shown = spawnSync('git', ['show', `${run.tasks[0].head_commit}:implemented.js`], { cwd: repo, encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stderr); assert.equal(shown.stdout.trim(), 'const implemented = true;');
    const state = await api(port, token, 'GET', '/api/state');
    assert.equal(state.data.data.runs.filter((r) => r.project_id === pid).length, 1, '不得重复创建 Run');
    assert.ok(logs.join('').includes('[recover]'), '启动恢复必须执行');
  } finally {
    await killGroup().catch(() => {});
    mock.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
