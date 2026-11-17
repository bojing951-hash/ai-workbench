// SPDX-License-Identifier: Apache-2.0
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
      else if (/(^|\/)(tests?|__tests__)\/.*\.(test|spec)\.(js|mjs|ts|tsx|jsx)$|(^|\/).*\.(test|spec)\.(js|mjs|ts|tsx|jsx)$/.test(rel)) files.push(rel);
    }
  };
  for (const d of ['tests', 'test', '__tests__']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  const productTests = files.filter((f) => !f.includes('workbench-contract.test'));
  assert.ok(productTests.length > 0, 'at least one product test file is required');
});
