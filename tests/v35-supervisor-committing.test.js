// SPDX-License-Identifier: Apache-2.0
/**
 * v3.5 P1：真正独立 Supervisor 在 Committing 阶段（pre-commit hook 卡住）SIGKILL 后自动恢复。
 * 零付费 custom Agent + 本地 mock 审计；Docker 不参与该用例。
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
const REPO = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await sleep(200); } return false; }
async function api(port, token, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
async function waitFor(fn, ms = 60_000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (err) { last = err; } await sleep(200); } throw new Error('timeout: ' + String(last)); }

test('v3.5 Supervisor 自主重启并恢复 Committing 阶段', { timeout: 180_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-supervisor-'));
  // Supervisor 以 root 为 cwd 启动 bin/workbench.js；用真实代码目录的符号链接，数据目录独立。
  fs.symlinkSync(path.join(REPO, 'bin'), path.join(root, 'bin'));
  fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'));
  const repo = path.join(root, 'product'); fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  fs.writeFileSync(path.join(repo, 'README.md'), '# product\n'); git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['add', '-A']); git(['commit', '-qm', 'base']);
  const agent = path.join(root, 'fake-agent.sh');
  fs.writeFileSync(agent, `#!/bin/sh\nset -eu\nprintf 'const implemented = true;\\n' > implemented.js\nprintf '{\"result\":\"implemented\",\"session_id\":\"sess-sup\",\"usage\":{\"input_tokens\":2,\"output_tokens\":2},\"cost_cny\":0}\\n'\n`);
  fs.chmodSync(agent, 0o755);
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -f .commit-hook-started ]; then touch .commit-hook-started; sleep 30; fi\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  const mock = http.createServer((req, res) => { req.resume(); req.on('end', () => { const audit = { score: 100, criteria: [{ criterion: 'A 完成', status: 'pass', evidence: 'implemented.js 已写入' }], findings: [], required_fixes: [], summary: 'PASS' }; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(audit) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }); });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve)); const mockPort = mock.address().port;
  const port = await freePort(); const token = 'test-token-supervisor-0001';
  const env = {
    ...process.env,
    WORKBENCH_ROOT: root, WORKBENCH_DATA_DIR: path.join(root, 'data'), WORKBENCH_PROJECTS_DIR: path.join(root, 'projects'),
    WORKBENCH_API_TOKEN: token, WORKBENCH_HOST: '127.0.0.1', WORKBENCH_PORT: String(port),
    DEFAULT_AGENT: 'custom', CUSTOM_AGENT_BIN: agent, CUSTOM_AGENT_ARGS: '',
    AUDIT_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-local-key', OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, OPENAI_AUDIT_MODEL: 'fake-audit', AUDIT_REQUIRE_INDEPENDENT: 'false',
    GITHUB_TOKEN: '', GITHUB_PUSH: 'false', GITHUB_CREATE_PR: 'false', GITHUB_AUTO_CREATE_REPO: 'false',
    MAX_TOTAL_TOKENS: '10000000', MAX_COST_CNY: '100', MAX_TOKENS_PER_TASK: '600000', AGENT_STALL_TIMEOUT_MS: '120000',
  };
  const supLog = path.join(root, 'supervisor.out'); const out = fs.openSync(supLog, 'a');
  const supervisor = spawn(NODE, ['--no-warnings=ExperimentalWarning', path.join(REPO, 'supervisor/workbench-supervisor.mjs'), '--root', root, '--port', String(port), '--max-restarts', '3', '--restart-window-ms', '600000'], { cwd: root, env, stdio: ['ignore', out, out] });
  const logText = () => { try { return fs.readFileSync(supLog, 'utf8') + '\n' + (fs.existsSync(path.join(root, 'data/supervisor/supervisor.log')) ? fs.readFileSync(path.join(root, 'data/supervisor/supervisor.log'), 'utf8') : ''); } catch { return ''; } };
  try {
    assert.equal(await waitHealth(port), true, logText().slice(-3000));
    const created = await api(port, token, 'POST', '/api/projects', { name: 'sup-product', repo, defaultBranch: 'main', testCommand: `${NODE} -e "process.exit(0)"`, agent: 'custom', auditProvider: 'openai', ciRequired: false, supervisorManaged: true, config: { test_isolation: 'none', container_test: false, require_real_tests: false } });
    assert.equal(created.status, 201, JSON.stringify(created.data)); const pid = created.data.data.id;
    const started = await api(port, token, 'POST', `/api/projects/${pid}/runs`, { goal: '实现 A', mode: 'single', tasks: [{ title: '实现 A', acceptance: ['A 完成'], testCommand: `${NODE} -e "process.exit(0)"`, agent: 'custom' }] });
    assert.equal(started.status, 201, JSON.stringify(started.data)); const runId = started.data.data.runId;
    const wt = await waitFor(async () => { const d = await api(port, token, 'GET', `/api/runs/${runId}`); const t = d.data?.data?.tasks?.[0]; return t?.worktree_path && fs.existsSync(path.join(t.worktree_path, '.commit-hook-started')) ? t.worktree_path : null; }, 60_000);
    const statePath = path.join(root, 'data/supervisor/state.json');
    const before = JSON.parse(fs.readFileSync(statePath, 'utf8')); assert.ok(before.childPid > 0);
    process.kill(before.childPid, 'SIGKILL'); // 只杀 Workbench，Supervisor 必须自己重启它
    const afterState = await waitFor(() => { try { const s = JSON.parse(fs.readFileSync(statePath, 'utf8')); return s.childPid && s.childPid !== before.childPid && s.restarts?.length >= 1 ? s : null; } catch { return null; } }, 60_000);
    assert.ok(afterState.crashes.length >= 1, '必须记录 Workbench 崩溃');
    assert.equal(await waitHealth(port, 40_000), true, logText().slice(-3000));
    let run;
    try { run = await waitFor(async () => { const d = await api(port, token, 'GET', `/api/runs/${runId}`); return d.data?.data?.status === 'awaiting_acceptance' ? d.data.data : null; }, 60_000); }
    catch (err) { const d = await api(port, token, 'GET', `/api/runs/${runId}`); console.error('COMMIT LOGS:' + logText().slice(-5000)); console.error('RUN:' + JSON.stringify(d.data?.data?.run || d.data?.data)); console.error('TASKS:' + JSON.stringify(d.data?.data?.tasks)); throw err; }
    assert.equal(run.tasks.length, 1, '不得重复创建 Task');
    assert.equal(run.tasks[0].status, 'passed');
    const shown = spawnSync('git', ['show', `${run.tasks[0].head_commit}:implemented.js`], { cwd: repo, encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stderr); assert.equal(shown.stdout.trim(), 'const implemented = true;');
    const recoveredState = await waitFor(() => { try { const s = JSON.parse(fs.readFileSync(statePath, 'utf8')); return s.recoveries?.length >= 1 ? s : null; } catch { return null; } }, 20_000);
    assert.ok(recoveredState.recoveries.length >= 1, 'Supervisor 必须记录恢复调用');
    assert.ok(logText().includes('计划重启'), 'Supervisor 必须记录自动重启');
  } finally {
    try { supervisor.kill('SIGKILL'); } catch { /* ignore */ }
    try { if (fs.existsSync(path.join(root, 'data/supervisor/state.json'))) { const s = JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor/state.json'), 'utf8')); if (s.childPid) process.kill(s.childPid, 'SIGKILL'); } } catch { /* ignore */ }
    mock.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
