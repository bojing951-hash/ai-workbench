// SPDX-License-Identifier: Apache-2.0
/** v3.0 P0-2/P0-3：真实测试计划、冻结契约、可信测试文件与 Orchestrator 门禁。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { writeProjectContract, contractBaseline, verifyContractBaseline, validateTestEvidence, inspectTestFiles, CONTRACT_PROTECTED_PATHS } from '../src/contract.js';

const NODE = process.execPath;
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); }
function waitFor(check, timeoutMs = 60_000) { return new Promise((resolve, reject) => { const started = Date.now(); const tick = async () => { try { const v = await check(); if (v) return resolve(v); } catch (e) { return reject(e); } if (Date.now() - started > timeoutMs) return reject(new Error('timeout')); setTimeout(tick, 25); }; tick(); }); }

test('v3.0 P0-2/P0-3：契约哈希可检测篡改；空测试/trivial 命令不能 PASS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v3-contract-'));
  const baseline = writeProjectContract(root, { title: '测试产品', goal: '实现功能', acceptance: ['A1 可验证', 'A2 可验证'] });
  assert.ok(Object.keys(baseline).length >= 3);
  assert.deepEqual(verifyContractBaseline(root, baseline), []);
  fs.appendFileSync(path.join(root, 'CONTRACT.md'), '\n被篡改\n');
  assert.deepEqual(verifyContractBaseline(root, baseline), ['CONTRACT.md']);

  const planProject = { config_json: { require_real_tests: true, test_plan: { minTests: 2 } } };
  // 只有隐藏契约测试、没有产品测试 => 必须失败
  let evidence = validateTestEvidence({ project: planProject, worktree: root, command: 'node --test', result: { code: 0, stdout: 'ℹ tests 2', stderr: '' } });
  assert.equal(evidence.ok, false);
  // 仅自证 1===1、没有引用产品代码的“测试”不算产品测试（即使伪造 tests 2 pass 输出）
  fs.writeFileSync(path.join(root, 'tests', 'fake-product.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('t',()=>assert.equal(1,1));\n");
  evidence = validateTestEvidence({ project: planProject, worktree: root, command: 'node --test', result: { code: 0, stdout: 'tests 2 pass', stderr: '' } });
  assert.equal(evidence.ok, false, '未引用产品代码的自证测试不能通过');
  fs.rmSync(path.join(root, 'tests', 'fake-product.test.js'));
  // 产品测试但命令 trivial => 拒绝
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'product.js'), 'export const add = (a,b) => a+b;\n');
  fs.writeFileSync(path.join(root, 'product.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from './src/product.js'; test('add 1+1',()=>assert.equal(add(1,1),2)); test('add 2+2',()=>assert.equal(add(2,2),4));\n");
  assert.throws(() => validateTestEvidence({ project: planProject, worktree: root, command: 'true', result: { code: 0, stdout: 'ℹ tests 2', stderr: '' } }), /空命令|trivial|不执行真实测试/i);
  // 注释里的断言、process.exit/console 伪造输出、未使用 import 的常量断言都必须拒绝
  fs.writeFileSync(path.join(root, 'tests', 'fake2.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/product.js'; // assert.equal(add(1,1),2); // assert.equal(add(2,2),4);\ntest('fake',()=>{ console.log('tests 2 pass'); assert.equal(1,1); assert.equal(2,2); });\n");
  const inspectedFake = inspectTestFiles(root).all.find((f) => f.file.includes('fake2.test.js'));
  assert.equal(inspectedFake.meaningful, false, '注释/常量断言/伪造 stdout 的测试文件不能被当作有效产品测试');
  fs.rmSync(path.join(root, 'tests', 'fake2.test.js'));
  // 导入产品符号但断言常量（未实际调用产品）也必须拒绝
  fs.writeFileSync(path.join(root, 'tests', 'fake3.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/product.js'; test('a',()=>assert.equal(1,1)); test('b',()=>assert.equal(2,2));\n");
  const inspectedFake3 = inspectTestFiles(root).all.find((f) => f.file.includes('fake3.test.js'));
  assert.equal(inspectedFake3.meaningful, false, '未使用导入符号的常量断言不能通过');
  fs.rmSync(path.join(root, 'tests', 'fake3.test.js'));
  // 产品测试 + 真实 node test 输出 => 通过
  evidence = validateTestEvidence({ project: planProject, worktree: root, command: 'node --test', result: { code: 0, stdout: 'ℹ tests 2\nℹ pass 2', stderr: '' } });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.testCount, 2);
  const trusted = spawnSync(process.execPath, ['--test', 'tests/acceptance/workbench-contract.test.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(trusted.status, 0, `受信契约测试必须真实运行通过：${trusted.stderr || trusted.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('v3.0 P0-2：新项目禁止 testCommand=true；Orchestrator 只在真实测试/审计通过后 passing', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v3-orch-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const baseline = writeProjectContract(repo, { title: '计算器', goal: '实现 add', acceptance: ['add(1,2)=3', '真实测试通过'] });
  fs.writeFileSync(path.join(repo, 'README.md'), '# calculator\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Workbench Test']); git(repo, ['config', 'user.email', 'wb@test']);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'chore: contract baseline']);
  const config = getConfig({
    root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') },
    secrets: [], llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } },
    budget: { maxTotalTokens: 1_000_000, maxCostCny: 50, maxTokensPerTask: 600_000, maxAttempts: 1, maxAgentConcurrency: 1, minReserveTokens: 20_000 },
    agents: { default: 'auto', dsh: { bin: '/nonexistent/dsh', timeoutMs: 10_000, permissionMode: 'workspace-write' }, claude: { bin: '/nonexistent/claude', timeoutMs: 10_000, permissionMode: 'acceptEdits' } },
    github: { token: '', createPr: false, push: false, autoCreateRepo: false }, policy: { protectedPaths: ['acceptance/**', '.github/**'], testTimeoutMs: 30_000, ciPollAttempts: 1, ciPollIntervalMs: 10 },
  });
  const store = openStore(config.paths.dbPath);
  const bus = new EventBus();
  let agentCalls = 0;
  const orchestrator = new Orchestrator({ config, store, bus, deps: {
    checkAgents: async () => [{ id: 'dsh', label: 'fake', ok: true, capabilities: {} }],
    chooseAgent: async () => 'dsh',
    runAgent: async (id, ctx) => {
      agentCalls += 1;
      const pkg = { name: 'calculator', private: true, type: 'module', scripts: { test: `${NODE} --test tests/*.test.js` } };
      fs.writeFileSync(path.join(ctx.cwd, 'package.json'), JSON.stringify(pkg, null, 2));
      fs.mkdirSync(path.join(ctx.cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(ctx.cwd, 'src', 'calc.js'), 'export function add(a,b){return Number(a)+Number(b);}\n');
      fs.mkdirSync(path.join(ctx.cwd, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(ctx.cwd, 'tests', 'product.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/calc.js'; test('add 1+2',()=>assert.equal(add(1,2),3)); test('add negative',()=>assert.equal(add(-1,1),0));\n");
      return { ok: true, text: 'implemented', error: '', agentKind: 'dsh', sessionId: 's1', exitCode: 0, usage: { input: 10, output: 5 }, costCny: 0.0001, durationMs: 1, logPath: '' };
    },
    runAudit: async ({ task }) => ({ provider: 'fake', model: 'fake-audit', verdict: 'pass', score: 100, criteria: (task.acceptance_json || []).map((c) => ({ criterion: c, status: 'pass', evidence: 'src/calc.js + tests/product.test.js' })), findings: [], requiredFixes: [], summary: '通过', usage: { input: 10, output: 5 }, costCny: 0.0001 }),
  } });
  try {
    const project = await orchestrator.createProject({
      name: 'calculator', repo, defaultBranch: 'main', testCommand: '', requireRealTests: true,
      testPlan: { minTests: 2 }, contractBaseline: baseline, contractFiles: ['CONTRACT.md', 'ACCEPTANCE.md', 'TEST_PLAN.json'],
      protectedPaths: CONTRACT_PROTECTED_PATHS, ciRequired: false,
    });
    assert.equal(project.test_command, '', '新项目不能预置 true 测试命令');
    const started = await orchestrator.startRun({ projectId: project.id, goal: '实现 add', acceptance: ['add(1,2)=3', '真实测试通过'], mode: 'single' });
    const run = await waitFor(() => { const r = store.getRun(started.runId); return r && ['awaiting_acceptance', 'failed', 'paused', 'blocked'].includes(r.status) ? r : null; });
    assert.equal(run.status, 'awaiting_acceptance', `应通过真实测试+审计，实际：${run.stop_reason}`);
    const updated = store.getProject(project.id);
    assert.equal(updated.test_command, 'npm test'); // 按真实 package.json 技术栈检测
    assert.ok(updated.config_json.tests_frozen_at, '首轮通过后必须冻结测试文件');
    assert.ok(updated.protected_paths.includes('tests/**'), '冻结后测试目录必须受保护');
    assert.ok(updated.protected_paths.includes('package.json'), '冻结后测试脚本/运行器配置必须受保护');
    assert.ok(updated.config_json.trusted_test_hashes['package.json'], '冻结哈希必须包含 package.json 测试脚本');
    assert.equal(agentCalls, 1);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
