// SPDX-License-Identifier: Apache-2.0
/** v2.7 真实验收暴露的 Workbench 缺陷回归。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { buildCoverageMatrix, repairTasksFromQuality } from '../src/quality.js';

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v27-reg-'));
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: 'k' }, deepseek: { apiKey: 'k' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  return { root, config, store };
}

test('v2.7 回归：DSH 审计 provider 不再被兼容层降级为 auto', async () => {
  const { root, config, store } = mk();
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'claude', runAudit: async () => ({}), checkAgents: async () => [] } });
    const p = await o.createProject({ name: 'dsh audit project', repo, testCommand: 'true', auditProvider: 'dsh' });
    assert.equal(p.audit_provider, 'dsh');
  } finally { store.close(); }
});

test('v2.7 回归：质量自动修复任务验收标准可由 DSH 审计，不要求执行项目外命令', () => {
  const project = { id: 'p', name: 'q', config_json: { quality: { requirements: [{ id: 'R1', title: '需求', priority: 'P0' }] } } };
  const matrix = buildCoverageMatrix({ project, qualityRun: { requirements: [{ id: 'R1', status: 'fail', evidence: 'hidden test failed at line 10', issues: [{ id: 'I1', title: 'bug', priority: 'P1', evidence: 'hidden test failed at line 10' }] }], issues: [] }, audits: [] });
  const tasks = repairTasksFromQuality(matrix);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].acceptance.every((a) => !/运行项目外质量命令/.test(a) || /不需要审计员运行/.test(a)));
  assert.ok(tasks[0].acceptance.some((a) => /具体代码修改|可见测试/.test(a)));
});
