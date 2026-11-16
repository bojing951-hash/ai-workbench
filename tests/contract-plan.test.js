// SPDX-License-Identifier: Apache-2.0
/** v2.8 P1-1：项目创建时从冻结契约自动生成条款级 quality plan。 */
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

test('v2.8 P1-1：createProject 从 CONTRACT.md 生成 clauses，且要求逐条款证据', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-contract-plan-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'CONTRACT.md'), '# 契约\n\n## R1 计算\n- 公式可核对\n- 负现金流不得判可购买\n\n## R2 持久化\n- 刷新后保留\n');
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t'); git('add', '-A'); git('commit', '-qm', 'base');
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const store = openStore(config.paths.dbPath);
  try {
    const o = new Orchestrator({ config, store, bus: new EventBus(), deps: { runAgent: async () => ({}), chooseAgent: async () => 'claude', runAudit: async () => ({}), checkAgents: async () => [] } });
    const project = await o.createProject({ name: 'contract plan', repo, testCommand: 'true', contractFiles: ['CONTRACT.md'], ciRequired: false });
    // 未配置 quality_command：只保存计划，不启用不可执行的 quality gate
    assert.equal(project.config_json.quality, undefined);
    const plan = project.config_json.quality_plan;
    assert.equal(plan.length, 2);
    assert.equal(plan[0].acceptance.length, 2);
    assert.match(plan[0].acceptance[1], /负现金流/);

    const project2 = await o.createProject({ name: 'contract plan q', repo, testCommand: 'true', contractFiles: ['CONTRACT.md'], qualityCommand: 'node quality.mjs', ciRequired: false });
    const q = project2.config_json.quality;
    assert.equal(q.require_clause_evidence, true);
    assert.equal(q.requirements.length, 2);
    assert.equal(q.requirements[0].acceptance.length, 2);
  } finally { store.close(); }
});
