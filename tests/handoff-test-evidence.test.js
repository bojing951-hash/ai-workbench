import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateTestEvidence } from '../src/contract.js';

const cases = [
  { title: 'three passes meet a minimum of two', skipped: 0, accepted: true },
  { title: 'one pass and two skips fall below a minimum of two', skipped: 2, accepted: false },
  { title: 'three skips cannot satisfy a minimum of two', skipped: 3, accepted: false },
];

for (const { title, skipped, accepted } of cases) {
  test(title, (t) => {
    const worktree = mkdtempSync(join(tmpdir(), 'wb-test-count-'));
    t.after(() => rmSync(worktree, { recursive: true, force: true }));
    mkdirSync(join(worktree, 'tests'));
    writeFileSync(join(worktree, 'app.mjs'), 'export const total = (x, y) => x + y;\n');
    const file = 'tests/app.test.mjs';
    const lines = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { total } from '../app.mjs';",
    ];
    for (let i = 0; i < 3; i++) {
      lines.push(`test('sum ${i}', { skip: ${i < skipped} }, () => {`,
        `  assert.equal(total(${i}, 1), ${i + 1});`, '});');
    }
    writeFileSync(join(worktree, file), lines.join('\n'));
    // A nested Node test runner needs its own reporter and process channel.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
      cwd: worktree, env: childEnv, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^# pass ${3 - skipped}$`, 'm'));
    assert.match(result.stdout, new RegExp(`^# skipped ${skipped}$`, 'm'));
    const evidence = validateTestEvidence({
      project: { config_json: { require_real_tests: true, test_plan: { minTests: 2 } } },
      worktree, command: 'node --test --test-reporter=tap ' + file,
      result: { code: result.status, stdout: result.stdout, stderr: result.stderr },
    });
    assert.equal(evidence.ok, accepted,
      `${3 - skipped} genuinely passing tests, minimum 2, gate returned ${evidence.ok}`);
  });
}
