// SPDX-License-Identifier: Apache-2.0
/** v2.8 P1-2：依赖/环境缺失导致 exit=127 时，自动执行显式 test_setup_command 并有界重试一次。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

test('v2.8 P1-2：exit=127 自动 setup 后重试，失败仍保留现场', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-setup-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    const project = store.createProject({ id: 'p', name: 'p', localPath: repo, testCommand: 'true', ciRequired: false, config: { test_setup_command: 'node -e "require(\'fs\').writeFileSync(\'SETUP_OK\',\'1\')"' } });
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'claude', runAudit: async () => ({}), checkAgents: async () => [] } });
    const res = await o.runProjectTest({ project, worktree: repo, command: 'node -e "process.exit(require(\'fs\').existsSync(\'SETUP_OK\')?0:127)"', timeoutMs: 10000, logPath: path.join(root, 'test.log') });
    assert.equal(res.setupRetried, true);
    assert.equal(res.setupFailed, undefined);
    assert.equal(res.code, 0);
    assert.ok(fs.existsSync(path.join(repo, 'SETUP_OK')));
  } finally { store.close(); }
});
