// SPDX-License-Identifier: Apache-2.0
/** v3.5：真实子进程 SIGKILL 后，supervised Run 自动恢复并保留 Worktree。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

const NODE = process.execPath;
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); }
async function waitFor(fn, ms = 30_000) { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } }

test('v3.5 SIGKILL 后 supervised Run 自动恢复，未提交代码/Worktree 保留', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-sigkill-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# p\n'); git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 't']); git(repo, ['config', 'user.email', 't@t']); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base']);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh'), claudeHome: path.join(dataDir, 'agents/claude') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'g', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }, deepseek: { apiKey: 'd', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } }, github: { token: '', createPr: false, push: false }, budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, minReserveTokens: 0 } });
  const store = openStore(config.paths.dbPath);
  let child;
  try {
    const project = store.createProject({ id: 'p-sigkill', name: 'sigkill', localPath: repo, defaultBranch: 'main', testCommand: `${NODE} -e "process.exit(0)"`, config: { supervisor_managed: true, test_isolation: 'none' } });
    const wt = path.join(dataDir, 'wt-sigkill');
    git(repo, ['worktree', 'add', '-b', 'wb/sigkill', wt, 'HEAD']);
    fs.writeFileSync(path.join(wt, 'partial.js'), 'const partial = true;\n');
    store.createRun({ id: 'r-sigkill', projectId: project.id, planId: 'pl-sigkill', goal: 'g', mode: 'single', status: 'running' });
    store.createPlan({ id: 'pl-sigkill', projectId: project.id, runId: 'r-sigkill', goal: 'g', title: 't', tasks: [] });
    store.createTasks([{ id: 't-sigkill', projectId: project.id, planId: 'pl-sigkill', runId: 'r-sigkill', seq: 1, title: '实现', acceptance: ['A'], testCommand: `${NODE} -e "process.exit(0)"`, status: 'coding' }]);
    store.updateTask('t-sigkill', { worktree_path: wt, branch: 'wb/sigkill', base_commit: 'HEAD', session_id: 'sess-sigkill', verification_json: { checkpoint: { keep_field: 42 } } });
    // 真实子进程持有 DB 状态后 SIGKILL，模拟 Workbench 崩溃。
    const dbUrl = new URL('../src/db.js', import.meta.url).href;
    child = spawn(NODE, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', `import { openStore } from ${JSON.stringify(dbUrl)}; const s=openStore(process.argv[1]); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`, config.paths.dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('child ready timeout')), 10_000); child.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
    child.kill('SIGKILL'); await new Promise((r) => child.on('exit', r)); child = null;

    let calls = 0;
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: {
      checkAgents: async () => [{ id: 'claude', ok: true }], chooseAgent: async () => 'claude',
      runAgent: async (id, ctx) => { calls += 1; assert.ok(fs.existsSync(path.join(ctx.cwd, 'partial.js')), '恢复时必须看到崩溃前未提交文件'); fs.writeFileSync(path.join(ctx.cwd, 'implemented.js'), 'ok\n'); return { ok: true, text: 'done', usage: { input: 1, output: 1 }, durationMs: 10, sessionId: 'sess-sigkill' }; },
      runAudit: async ({ task }) => ({ provider: 'fake', model: 'fake', verdict: 'pass', status: 'PASS', score: 100, criteria: (task.acceptance_json || []).map((c) => ({ criterion: c, status: 'pass', evidence: 'checkpoint + worktree verified' })), findings: [], requiredFixes: [], summary: 'pass', usage: { input: 1, output: 1 }, costCny: 0, independence: { independent: true } }),
    } });
    o.recoverOrphans();
    const recovered = await o.recoverSupervisedRuns();
    assert.ok(recovered.length >= 1, JSON.stringify(recovered));
    const run = await waitFor(() => { const r = store.getRun('r-sigkill'); return r && ['awaiting_acceptance', 'accepted', 'paused', 'failed'].includes(r.status) ? r : null; }, 30_000);
    const tasks = store.listTasks({ runId: 'r-sigkill' });
    assert.equal(calls, 1);
    assert.ok(tasks[0].head_commit, '必须产生最终 Git commit');
    const shown = spawnSync('git', ['show', `${tasks[0].head_commit}:implemented.js`], { cwd: repo, encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.stdout.trim(), 'ok');
    assert.equal(tasks[0].status, 'passed', `${tasks[0].status}: ${tasks[0].blocked_reason}`);
    assert.equal(run.status, 'awaiting_acceptance');
  } finally { if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } } store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
