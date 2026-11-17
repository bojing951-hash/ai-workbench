// SPDX-License-Identifier: Apache-2.0
/** v3.5：容器内可信测试命令必须可移植，不能使用宿主 nvm 绝对路径；动态 require 产品入口必须被识别。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectTestFiles, validateTestEvidence, trustedProductTestCommand } from '../src/contract.js';

test('可信测试命令在容器内使用 node，而不是宿主 process.execPath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-portable-'));
  try {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = { ok: true };\n');
    fs.writeFileSync(path.join(root, 'tests', 'app.test.js'), `
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = require(path.join(__dirname, '..', 'app.js'));
test('product', () => { assert.equal(app.ok, true); assert.ok(true); });
`);
    const inspected = inspectTestFiles(root);
    assert.deepEqual(inspected.product.map((x) => x.file), ['tests/app.test.js']);
    const files = inspected.product.map((x) => x.file);
    const hostCmd = trustedProductTestCommand(root, files, { nodeBin: '/Users/x/.nvm/versions/node/v24.13.1/bin/node' });
    assert.match(hostCmd, /\/Users\/x\/\.nvm/);
    const containerCmd = trustedProductTestCommand(root, files, { nodeBin: 'node' });
    assert.match(containerCmd, /^"node" --test /);
    assert.ok(!containerCmd.includes('.nvm'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('测试命令失败时仍返回产品测试文件列表，供可信运行器回退', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-portable2-'));
  try {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'tests', 'app.test.js'), `
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = require(path.join(__dirname, '..', 'app.js'));
test('p', () => { assert.equal(typeof app, 'number'); assert.ok(true); });
`);
    const project = { config_json: { require_real_tests: true, test_plan: { minTests: 1 } } };
    const evidence = validateTestEvidence({ project, worktree: root, command: 'npm test', result: { code: 1, stdout: '', stderr: 'fail' } });
    assert.equal(evidence.code, 'TEST_EXIT_NONZERO');
    assert.deepEqual(evidence.productTestFiles, ['tests/app.test.js']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('真实 runProjectTest：坏 npm test 后使用可信运行器回退并记录事件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-runproject-'));
  try {
    const { getConfig } = await import('../src/config.js');
    const { openStore } = await import('../src/db.js');
    const { EventBus } = await import('../src/bus.js');
    const { Orchestrator } = await import('../src/orchestrator.js');
    fs.mkdirSync(path.join(root, 'tests', 'acceptance'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test tests/' } }));
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = { ok: true };\n');
    fs.writeFileSync(path.join(root, 'tests', 'app.test.js'), `const { test } = require('node:test'); const assert = require('node:assert/strict'); const app = require(path.join(__dirname, '..', 'app.js')); test('p', () => { assert.equal(app.ok, true); assert.ok(true); });`.replace("require(path.join(__dirname, '..', 'app.js'))", "require('../app.js')"));
    fs.writeFileSync(path.join(root, 'tests', 'acceptance', 'workbench-contract.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('c', () => assert.ok(true));\n`);
    const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') } });
    const store = openStore(config.paths.dbPath); const events = []; const bus = new EventBus(); bus.subscribe((e) => events.push(e));
    try {
      const o = new Orchestrator({ config, store, bus, deps: {} });
      const project = { id: 'p', config_json: { require_real_tests: true, auto_test_setup: false, test_isolation: 'none', test_plan: { minTests: 1, trustedContractTest: 'tests/acceptance/workbench-contract.test.mjs' } } };
      const res = await o.runProjectTest({ project, worktree: root, command: 'npm test', timeoutMs: 30_000, logPath: path.join(root, 'test.log'), runId: 'r', taskId: 't' });
      assert.equal(res.code, 0);
      assert.ok(res.testCommandFallback, '必须触发可信运行器回退');
      assert.ok(res.realTestEvidence?.ok);
      const fallbackEvent = events.find((e) => e.type === 'test_command_fallback');
      assert.ok(fallbackEvent);
      assert.equal(fallbackEvent.runId, 'r');
      assert.equal(fallbackEvent.taskId, 't');
    } finally { store.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function buildProject({ scripts = {}, files = {}, hiddenPass = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v35-negative-'));
  const { getConfig } = await import('../src/config.js');
  const { openStore } = await import('../src/db.js');
  const { EventBus } = await import('../src/bus.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  fs.mkdirSync(path.join(root, 'tests', 'acceptance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test tests/' , ...scripts } }));
  for (const [rel, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); }
  fs.writeFileSync(path.join(root, 'tests', 'acceptance', 'workbench-contract.test.mjs'), hiddenPass ? `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('c', () => assert.ok(true));\n` : `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('c', () => assert.ok(false));\n`);
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), dbPath: path.join(root, 'data', 'test.db'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dshHome: path.join(root, 'agents/dsh'), claudeHome: path.join(root, 'agents/claude') } });
  return { root, config, store: openStore(config.paths.dbPath) };
}

test('v35 负向 B：产品断言失败禁止回退放行', async () => {
  const h = await buildProject({ files: { 'app.js': 'module.exports={ok:true};\n', 'tests/app.test.js': `const {test}=require('node:test');const assert=require('node:assert/strict');const app=require('../app.js');test('p',()=>{assert.equal(app.ok,false);assert.ok(true);});\n` } });
  try {
    const { EventBus } = await import('../src/bus.js'); const { Orchestrator } = await import('../src/orchestrator.js'); const events = []; const bus = new EventBus(); bus.subscribe((e) => events.push(e));
    const o = new Orchestrator({ config: h.config, store: h.store, bus, deps: {} });
    const project = { id: 'p', config_json: { require_real_tests: true, auto_test_setup: false, test_isolation: 'none', test_plan: { minTests: 1, trustedContractTest: 'tests/acceptance/workbench-contract.test.mjs' } } };
    await assert.rejects(() => o.runProjectTest({ project, worktree: h.root, command: 'npm test', timeoutMs: 30_000, logPath: path.join(h.root, 't.log'), runId: 'r', taskId: 't' }), /实际测试退出码|测试证据/);
    assert.ok(!events.some((e) => e.type === 'test_command_fallback'));
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 负向 C：一 PASS 一 FAIL 禁止回退放行', async () => {
  const h = await buildProject({ files: {
    'app.js': 'module.exports={ok:true};\n',
    'tests/a.test.js': `const {test}=require('node:test');const assert=require('node:assert/strict');const app=require('../app.js');test('a',()=>{assert.equal(app.ok,true);assert.ok(true);});\n`,
    'tests/b.test.js': `const {test}=require('node:test');const assert=require('node:assert/strict');const app=require('../app.js');test('b',()=>{assert.equal(app.ok,false);assert.ok(true);});\n`,
  } });
  try {
    const { EventBus } = await import('../src/bus.js'); const { Orchestrator } = await import('../src/orchestrator.js'); const events = []; const bus = new EventBus(); bus.subscribe((e) => events.push(e));
    const o = new Orchestrator({ config: h.config, store: h.store, bus, deps: {} });
    const project = { id: 'p', config_json: { require_real_tests: true, auto_test_setup: false, test_isolation: 'none', test_plan: { minTests: 1, trustedContractTest: 'tests/acceptance/workbench-contract.test.mjs' } } };
    await assert.rejects(() => o.runProjectTest({ project, worktree: h.root, command: 'npm test', timeoutMs: 30_000, logPath: path.join(h.root, 't.log'), runId: 'r', taskId: 't' }), /实际测试退出码|测试证据/);
    assert.ok(!events.some((e) => e.type === 'test_command_fallback'));
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 负向 D：测试文件无法被正确识别时禁止回退', async () => {
  const h = await buildProject({ files: { 'app.js': 'module.exports={ok:true};\n', 'tests/empty.test.js': `const {test}=require('node:test');test('noop',()=>{});\n` } });
  try {
    const { EventBus } = await import('../src/bus.js'); const { Orchestrator } = await import('../src/orchestrator.js'); const events = []; const bus = new EventBus(); bus.subscribe((e) => events.push(e));
    const o = new Orchestrator({ config: h.config, store: h.store, bus, deps: {} });
    const project = { id: 'p', config_json: { require_real_tests: true, auto_test_setup: false, test_isolation: 'none', test_plan: { minTests: 1, trustedContractTest: 'tests/acceptance/workbench-contract.test.mjs' } } };
    await assert.rejects(() => o.runProjectTest({ project, worktree: h.root, command: 'npm test', timeoutMs: 30_000, logPath: path.join(h.root, 't.log'), runId: 'r', taskId: 't' }), /没有找到|真实测试/);
    assert.ok(!events.some((e) => e.type === 'test_command_fallback'));
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 负向 F：冻结隐藏验收测试 FAIL 时整体 FAIL', async () => {
  const h = await buildProject({ hiddenPass: false, files: { 'app.js': 'module.exports={ok:true};\n', 'tests/app.test.js': `const {test}=require('node:test');const assert=require('node:assert/strict');const app=require('../app.js');test('p',()=>{assert.equal(app.ok,true);assert.ok(true);});\n` } });
  try {
    const { EventBus } = await import('../src/bus.js'); const { Orchestrator } = await import('../src/orchestrator.js'); const events = []; const bus = new EventBus(); bus.subscribe((e) => events.push(e));
    const o = new Orchestrator({ config: h.config, store: h.store, bus, deps: {} });
    const project = { id: 'p', config_json: { require_real_tests: true, auto_test_setup: false, test_isolation: 'none', test_plan: { minTests: 1, trustedContractTest: 'tests/acceptance/workbench-contract.test.mjs' } } };
    await assert.rejects(() => o.runProjectTest({ project, worktree: h.root, command: 'npm test', timeoutMs: 30_000, logPath: path.join(h.root, 't.log'), runId: 'r', taskId: 't' }), /隐藏契约测试未通过/);
    assert.ok(!events.some((e) => e.type === 'test_command_fallback'));
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('v35 负向 E：原始 test 脚本含 lint/build 强制阶段时禁止回退', async () => {
  const h = await buildProject({ scripts: { lint: 'node -e "process.exit(0)"', test: 'npm run lint && node --test tests/' }, files: { 'app.js': 'module.exports={ok:true};\n', 'tests/app.test.js': `const {test}=require('node:test');const assert=require('node:assert/strict');const app=require('../app.js');test('p',()=>{assert.equal(app.ok,true);assert.ok(true);});\n` } });
  try {
    const { EventBus } = await import('../src/bus.js'); const { Orchestrator } = await import('../src/orchestrator.js'); const events = []; const bus = new EventBus(); bus.subscribe((e) => events.push(e));
    const o = new Orchestrator({ config: h.config, store: h.store, bus, deps: {} });
    const project = { id: 'p', config_json: { require_real_tests: true, auto_test_setup: false, test_isolation: 'none', test_plan: { minTests: 1, trustedContractTest: 'tests/acceptance/workbench-contract.test.mjs' } } };
    await assert.rejects(() => o.runProjectTest({ project, worktree: h.root, command: 'npm test', timeoutMs: 30_000, logPath: path.join(h.root, 't.log'), runId: 'r', taskId: 't' }), /测试/);
    assert.ok(!events.some((e) => e.type === 'test_command_fallback'));
  } finally { h.store.close(); fs.rmSync(h.root, { recursive: true, force: true }); }
});
