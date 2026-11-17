// SPDX-License-Identifier: Apache-2.0
/**
 * v3.0 冻结验收契约 / 可信测试计划。
 * - 新项目在启动前生成 CONTRACT.md、ACCEPTANCE.md、TEST_PLAN.json 和隐藏契约测试；
 * - 基线 SHA256 写入项目 config，Agent 修改即失败并恢复；
 * - 测试文件在首轮通过后冻结，后续修改必须显式授权，不能由被测 Agent 自改自证。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PolicyError } from './policy.js';

export const CONTRACT_FILES = ['CONTRACT.md', 'ACCEPTANCE.md', 'TEST_PLAN.json'];
export const TRUSTED_CONTRACT_TEST = 'tests/acceptance/workbench-contract.test.mjs';
export const CONTRACT_PROTECTED_PATHS = [...CONTRACT_FILES, 'tests/acceptance/**', '.workbench/**'];

export function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}

export function writeProjectContract(localPath, { title, goal, acceptance = [], productName = '' }) {
  const safeTitle = String(title || productName || '软件产品').trim();
  const safeGoal = String(goal || '').trim();
  const criteria = (Array.isArray(acceptance) ? acceptance : []).map((x) => String(x).trim()).filter(Boolean);
  fs.mkdirSync(path.join(localPath, 'tests', 'acceptance'), { recursive: true });
  fs.mkdirSync(path.join(localPath, '.workbench'), { recursive: true });
  fs.writeFileSync(path.join(localPath, 'CONTRACT.md'), `# 产品验收契约\n\n## 产品\n${safeTitle}\n\n## 目标\n${safeGoal}\n\n## 验收标准\n${criteria.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n## 不可变约束\n- 本文件、ACCEPTANCE.md、TEST_PLAN.json 与隐藏验收测试由 Workbench 冻结，Coding Agent 不得修改。\n- 验收标准不得为了让实现通过而降低。\n- 不新增账户/支付/云端上传敏感数据，除非用户另行明确授权。\n`);
  fs.writeFileSync(path.join(localPath, 'ACCEPTANCE.md'), `# 独立验收清单\n\n${criteria.map((a, i) => `- [ ] A${i + 1}: ${a}`).join('\n')}\n\n> 每条必须有真实测试/运行证据，并由独立审计逐条核对。\n`);
  const plan = {
    version: 1,
    title: safeTitle,
    goal: safeGoal,
    acceptance: criteria,
    minTests: Math.max(2, criteria.length),
    requireActualTests: true,
    forbidTrivialCommand: true,
    trustedContractTest: TRUSTED_CONTRACT_TEST,
    testCommand: 'auto-detect-by-stack',
    notes: [
      'Coding Agent 必须实现产品行为并使用真实测试框架编写测试。',
      'Workbench 只接受实际执行且包含断言的测试；退出码 0 本身不等于合格。',
      'tests/acceptance/** 为可信隐藏契约测试，Coding Agent 不得修改。',
    ],
  };
  fs.writeFileSync(path.join(localPath, 'TEST_PLAN.json'), `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(localPath, TRUSTED_CONTRACT_TEST), `// SPDX-License-Identifier: Apache-2.0
// Workbench trusted acceptance contract test. DO NOT MODIFY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
test('Workbench contract files are present and non-empty', () => {
  for (const file of ['CONTRACT.md', 'ACCEPTANCE.md', 'TEST_PLAN.json']) {
    const abs = path.join(root, file);
    assert.ok(fs.existsSync(abs), file + ' must exist');
    assert.ok(fs.readFileSync(abs, 'utf8').trim().length > 20, file + ' must not be empty');
  }
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'TEST_PLAN.json'), 'utf8'));
  assert.ok(Array.isArray(plan.acceptance) && plan.acceptance.length > 0, 'acceptance contract must not be empty');
  assert.ok(plan.acceptance.every((x) => typeof x === 'string' && x.trim().length >= 4), 'acceptance items must be meaningful');
  const contract = fs.readFileSync(path.join(root, 'CONTRACT.md'), 'utf8');
  const acceptance = fs.readFileSync(path.join(root, 'ACCEPTANCE.md'), 'utf8');
  for (const item of plan.acceptance) assert.ok(contract.includes(item) && acceptance.includes(item), 'acceptance item must be bound to frozen contract: ' + item);
});
test('product has a real test suite separate from the trusted contract test', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p).replaceAll(path.sep, '/');
      if (fs.statSync(p).isDirectory()) { if (!name.startsWith('.') && name !== 'node_modules') walk(p); }
      else if (/(^|\\/)(tests?|__tests__)\\/.*\\.(test|spec)\\.(js|mjs|ts|tsx|jsx)$|(^|\\/).*\\.(test|spec)\\.(js|mjs|ts|tsx|jsx)$/.test(rel)) files.push(rel);
    }
  };
  for (const d of ['tests', 'test', '__tests__']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  const productTests = files.filter((f) => !f.includes('workbench-contract.test'));
  assert.ok(productTests.length > 0, 'at least one product test file is required');
});
`);
  return Object.fromEntries(CONTRACT_FILES.map((f) => [f, sha256File(path.join(localPath, f))]));
}

export function contractBaseline(localPath, extraFiles = []) {
  const files = [...CONTRACT_FILES, TRUSTED_CONTRACT_TEST, ...extraFiles];
  const out = {};
  for (const rel of [...new Set(files)]) {
    const h = sha256File(path.join(localPath, rel));
    if (h) out[rel] = h;
  }
  return out;
}

export function verifyContractBaseline(worktree, baseline = {}) {
  const violations = [];
  for (const [rel, expected] of Object.entries(baseline || {})) {
    const actual = sha256File(path.join(worktree, rel));
    if (!actual || actual !== expected) violations.push(rel);
  }
  return violations;
}

export function findTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(test|spec)\.(js|mjs|cjs|ts|tsx|jsx)$/.test(name) || /^test_.*\.py$/.test(name) || /_test\.go$/.test(name)) out.push(path.relative(root, p).replaceAll(path.sep, '/'));
    }
  };
  walk(root);
  return out;
}

export function assertMeaningfulTestCommand(command, project = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new PolicyError('TEST_COMMAND_EMPTY', '没有可执行的测试命令；真实测试计划未建立，不能通过');
  if (/^(true|:|echo|exit\s+0|sleep|npx\s+true)\b/i.test(cmd) || /passWithNoTests/i.test(cmd)) {
    throw new PolicyError('TEST_COMMAND_TRIVIAL', `拒绝把空命令/无测试命令视为合格：${cmd}`);
  }
  if (/\btrue\s*$/.test(cmd) && !/test|spec|check|lint/i.test(cmd)) throw new PolicyError('TEST_COMMAND_TRIVIAL', `测试命令看起来不执行真实测试：${cmd}`);
  return cmd;
}

export function inspectTestFiles(root) {
  const files = findTestFiles(root);
  const meaningful = [];
  for (const rel of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    // 去除注释后再判断，防止注释里的 assert 计数冒充真实断言。
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const assertions = (code.match(/\b(assert|expect|should|deepEqual|strictEqual|equal|ok)\s*\(/g) || []).length
      + (code.match(/^\s*assert\s+/gm) || []).length;
    // 必须引用产品代码/真实入口，不能只用 node:test/node:assert 自证 1===1。
    const importLines = [...code.matchAll(/import\s+([^;]+?)\s+from\s+['"][^'"]*(?:\.{1,2}\/|(?:src|app|lib|components|server)\/)[^'"]*['"]/g)].map((m) => m[1]);
    const requireLines = [...code.matchAll(/(?:const|let|var)\s+([^=]+?)\s*=\s*require\s*\(\s*['"][^'"]*(?:\.{1,2}\/|(?:src|app|lib|components|server)\/)[^'"]*['"]/g)].map((m) => m[1]);
    const importedNames = [];
    for (const line of [...importLines, ...requireLines]) {
      const braces = line.match(/\{([^}]+)\}/);
      if (braces) importedNames.push(...braces[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
      else importedNames.push(...line.split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x) && x !== 'type'));
    }
    const assignedFromProduct = [...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)]
      .filter((m) => importedNames.includes(m[2])).map((m) => m[1]);
    const referencesProduct = /(?:from|require\s*\()\s*['"](?:\.{1,2}\/)|(?:from|require\s*\()\s*['"][^'"]*\/(?:src|app|lib|components|server)\//.test(code)
      // 允许真实测试通过 path.join(__dirname, '..', 'app.js') 等方式引用产品入口。
      || /require\s*\(\s*path\.(?:join|resolve)\([^)]*['"][^'"]+\.(?:js|mjs|cjs)['"][^)]*\)\s*\)/.test(code)
      || /\b(fetch\s*\(|page\.goto\s*\(|request\.(get|post|put|delete)\s*\()/.test(code);
    const assertionCode = code.replace(/import\s+[^;]+?\s+from\s+['"][^'"]+['"];?/g, '').replace(/(?:const|let|var)\s+[^=]+?=\s*require\s*\(\s*['"][^'"]+['"]\s*\);?/g, '');
    const assertLines = assertionCode.split('\n').filter((line) => /\b(assert|expect|should)\b/.test(line));
    const requireAssigned = [...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/g)].map((m) => m[1]);
    const referencedSymbols = [...new Set([...importedNames, ...assignedFromProduct, ...requireAssigned])].filter(Boolean);
    const symbolAssertion = referencedSymbols.length
      ? assertLines.some((line) => referencedSymbols.some((name) => new RegExp(`\\b${name.replace(/[^A-Za-z0-9_$]/g, '')}\\b`).test(line)))
      : assertLines.some((line) => /\b(fetch|page|request)\b/.test(line));
    const spoofing = /\bprocess\s*\.\s*(exit|stdout|stderr)\b|\bconsole\s*\./.test(code);
    const placeholder = /TODO|not implemented|placeholder/i.test(code.slice(0, 800));
    const meaningfulEntry = assertions >= 2 && text.length > 80 && referencesProduct && symbolAssertion && !placeholder && !spoofing;
    meaningful.push({ file: rel, assertions, referencesProduct, meaningful: meaningfulEntry });
  }
  const meaningfulFiles = meaningful.filter((f) => f.meaningful);
  return { files, meaningful: meaningfulFiles, all: meaningful, product: meaningfulFiles.filter((f) => !f.file.includes('workbench-contract.test')) };
}


/** 区分测试命令/运行器兼容性错误与产品断言失败；回退只允许前者。 */
export function classifyTestFailure(result = {}, command = '') {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const runnerPattern = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find package|command not found|ENOENT|ENOTDIR|not found|exit=127|spawn .* ENOENT|Unsupported|Unsupported engine/i;
  const assertionPattern = /AssertionError|\bnot ok\b|\bfail\s+[1-9]|# fail|\bpass\s+[1-9]|✖\s+/i;
  if (runnerPattern.test(text) && !/\bpass\s+[1-9]/i.test(text)) return 'runner_compatibility';
  if (assertionPattern.test(text)) return 'product_assertion';
  if (runnerPattern.test(text)) return 'runner_compatibility';
  return 'unknown';
}

/** 独立于 Agent test script 的可信测试运行器；拒绝未覆盖/未引用产品代码的测试。 */
export function trustedProductTestCommand(root, productFiles, { nodeBin = 'node' } = {}) {
  if (!productFiles.length) throw new PolicyError('TEST_PLAN_NO_PRODUCT_TESTS', '没有产品测试文件');
  const js = productFiles.filter((f) => /\.(test|spec)\.(js|mjs|cjs)$/.test(f));
  const ts = productFiles.filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f));
  const py = productFiles.filter((f) => /(^|\/)test_.*\.py$/.test(f));
  const go = productFiles.some((f) => /_test\.go$/.test(f));
  const rs = productFiles.some((f) => /\.rs$/.test(f));
  if (ts.length && !js.length) throw new PolicyError('TEST_RUNNER_UNSUPPORTED', 'TypeScript 测试缺少可信的独立运行器（请使用可执行构建产物或 JS 测试）');
  if (js.length) return `${JSON.stringify(nodeBin)} --test ${js.map((f) => JSON.stringify(f)).join(' ')}`;
  if (py.length) return `python3 -m pytest -q ${py.map((f) => JSON.stringify(f)).join(' ')}`;
  if (go) return 'go test ./...';
  if (rs) return 'cargo test';
  throw new PolicyError('TEST_RUNNER_UNSUPPORTED', '没有可识别且可独立执行的产品测试文件');
}

export function parseTestCount(stdout = '', stderr = '') {
  const text = `${stdout}\n${stderr}`;
  const patterns = [
    /(?:^|\s)tests?\s+(\d+)\s*(?:pass|passed|通过)?/im,
    /#\s*tests\s+(\d+)/i,
    /(\d+)\s+passed/i,
    /ok\s+\d+\s+passed/i,
    /Test Files\s+\d+\s+passed/i,
  ];
  for (const re of patterns) { const m = text.match(re); if (m) return Number(m[1]); }
  const nodeTotal = text.match(/(?:pass|fail)\s+\d+/gi);
  return nodeTotal ? nodeTotal.length : 0;
}

export function validateTestEvidence({ project, worktree, command, result }) {
  const cfg = project?.config_json || {};
  if (!cfg.require_real_tests) return { ok: true, ...inspectTestFiles(worktree) };
  assertMeaningfulTestCommand(command, project);
  const inspected = inspectTestFiles(worktree);
  const plan = cfg.test_plan || {};
  const minTests = Math.max(1, Number(plan.minTests || plan.min_tests || 1));
  if (!inspected.product.length) return { ok: false, code: 'TEST_PLAN_NO_PRODUCT_TESTS', reason: '没有找到除隐藏契约测试外的产品测试文件；不能宣布真实测试通过', ...inspected };
  if (result?.code !== 0) return { ok: false, code: 'TEST_EXIT_NONZERO', reason: `实际测试退出码 ${result.code}`, productTestFiles: inspected.product.map((f) => f.file), ...inspected };
  const count = parseTestCount(result.stdout || '', result.stderr || '');
  if (!count) return { ok: false, code: 'TEST_OUTPUT_NO_COUNT', reason: '测试命令退出 0 但没有可解析的实际测试执行数量；不能仅凭 shell 退出码宣布合格', testCount: 0, productTestFiles: inspected.product.map((f) => f.file), ...inspected };
  const effectiveCount = count;
  if (effectiveCount < minTests) return { ok: false, code: 'TEST_COUNT_TOO_LOW', reason: `实际有效测试数 ${effectiveCount} < 最小要求 ${minTests}`, testCount: effectiveCount, productTestFiles: inspected.product.map((f) => f.file), ...inspected };
  return { ok: true, testCount: effectiveCount, productTestFiles: inspected.product.map((f) => f.file), trustedTestFiles: inspected.files.filter((f) => f.includes('workbench-contract.test')), ...inspected };
}

/** 校验已冻结测试/运行器文件；新增文件不在此列，允许通过独立测试后进入下一版基线。 */
export function verifyTestBaseline(worktree, hashes = {}) {
  const violations = [];
  for (const [rel, expected] of Object.entries(hashes || {})) {
    const actual = sha256File(path.join(worktree, rel));
    if (!actual || actual !== expected) violations.push(rel);
  }
  return violations;
}
