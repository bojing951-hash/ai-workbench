// SPDX-License-Identifier: Apache-2.0
/** v4.0：产品审计必须把完整 diff 交给分块器；长 diff 中段缺陷不得被入口预截断。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

test('v40 产品审计：长 diff 中段缺陷被完整送入审计并最终 FAIL', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v40-middiff-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']);
  fs.writeFileSync(path.join(repo, 'app.txt'), Array.from({ length: 6000 }, (_, i) => `line-${i}-baseline-xxxxxxxx`).join('\n'));
  git(['add', '-A']); git(['commit', '-qm', 'base']); const base = git(['rev-parse', 'HEAD']).stdout.trim();
  const lines = Array.from({ length: 6000 }, (_, i) => i === 3000 ? 'BROKEN_PRODUCT_BEHAVIOR_MIDDLE_DIFF' : `line-${i}-changed-version-two-yyyyyyyyyy`);
  fs.writeFileSync(path.join(repo, 'app.txt'), lines.join('\n')); git(['add', '-A']); git(['commit', '-qm', 'product']);
  const planHead = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.ok(planHead !== base);
  const dataDir = path.join(root, 'data');
  const config = getConfig({ root, paths: { root, dataDir, dbPath: path.join(dataDir, 't.db'), projectsDir: path.join(root, 'p'), worktreesDir: path.join(dataDir, 'w'), artifactsDir: path.join(dataDir, 'a'), logsDir: path.join(dataDir, 'l'), agentsDir: path.join(dataDir, 'ag'), dshHome: path.join(dataDir, 'ag/dsh'), claudeHome: path.join(dataDir, 'ag/claude') }, audit: { provider: 'openai', maxDiffChars: 200000, maxChunks: 2, maxTokens: 1000 } });
  const store = openStore(config.paths.dbPath);
  let captured = '';
  try {
    const fakeAudit = async (args) => {
      captured = String(args.diff || '');
      return {
        status: 'FAIL', verdict: 'fail', score: 0, provider: 'fake', model: 'fake-audit',
        criteria: [{ criterion: '产品行为正确', status: 'fail', evidence: 'app.txt:3000 BROKEN_PRODUCT_BEHAVIOR_MIDDLE_DIFF' }],
        findings: [{ severity: 'high', issue: '中段产品缺陷' }], requiredFixes: ['修复中段产品行为'], usage: { input: 1, output: 1 }, costCny: 0,
      };
    };
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAudit: fakeAudit } });
    const project = { id: 'p-mid', name: 'p', local_path: repo, config_json: {}, test_command: 'node -e "process.exit(0)"' };
    const result = await o.productAcceptanceAudit({ project, expected: ['产品行为正确'], planHead, baseCommit: base, latestRun: null, latestTask: null });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.ok, false);
    assert.ok(captured.includes('BROKEN_PRODUCT_BEHAVIOR_MIDDLE_DIFF'), '中段缺陷必须出现在完整 diff 中');
    assert.ok(captured.length > 80000, `diff 不应被入口预截断，实际 ${captured.length}`);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
