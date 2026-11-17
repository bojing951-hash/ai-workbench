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
