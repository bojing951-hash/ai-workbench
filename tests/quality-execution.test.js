// SPDX-License-Identifier: Apache-2.0
/** v2.7 外部审计整改：质量命令隔离、非零退出、超时、无效 JSON、异步不阻塞。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { runQualityCommand } from '../src/quality.js';

function mk(command, extraQuality = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-qexec-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const config = getConfig({ root, paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') }, llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' } });
  const project = { id: 'p1', name: 'q', local_path: repo, config_json: { quality: { quality_command: command, timeout_ms: 2000, sandbox: 'off', requirements: [{ id: 'R1', title: 'R1', priority: 'P0', acceptance: ['ok'] }], ...extraQuality } } };
  return { root, repo, config, project };
}

test('v2.7 P0：质量命令不继承宿主 API Key/任意环境，正常检查仍 PASS', async () => {
  const command = `node -e "console.log(JSON.stringify({requirements:[{id:'R1',status:process.env.LEAK_SECRET?'fail':'pass',evidence:'env isolated; no host secrets'}]}))"`;
  const { config, project } = mk(command);
  process.env.LEAK_SECRET = 'should-not-leak';
  try {
    const res = await runQualityCommand({ config, project });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.requirements[0].status, 'pass');
    assert.equal(res.requirements[0].evidence, 'env isolated; no host secrets');
    assert.ok(!String(res.stdout).includes('should-not-leak'));
  } finally { delete process.env.LEAK_SECRET; }
});

test('v2.7 P1-B：非零退出即使 JSON 合法也必须失败，不能当产品缺陷', async () => {
  const { config, project } = mk(`node -e "console.log(JSON.stringify({requirements:[{id:'R1',status:'pass',evidence:'bad'}]}));process.exit(2)"`);
  const res = await runQualityCommand({ config, project });
  assert.equal(res.ok, false);
  assert.equal(res.commandFailed, true);
  assert.equal(res.issueClass, 'NONZERO_EXIT');
  assert.equal(res.requirements.length, 0);
  assert.equal(res.issues[0].hypothesis, true);
});

test('v2.7 P1-B：无效 JSON 与超时分别分类且不能 PASS', async () => {
  const bad = mk(`node -e "console.log('not-json')"`);
  const r1 = await runQualityCommand({ config: bad.config, project: bad.project });
  assert.equal(r1.ok, false); assert.equal(r1.issueClass, 'INVALID_JSON');
  const slow = mk(`node -e "setTimeout(()=>console.log('{}'),5000)"`, { timeout_ms: 500 });
  const r2 = await runQualityCommand({ config: slow.config, project: slow.project });
  assert.equal(r2.ok, false); assert.equal(r2.issueClass, 'TIMEOUT');
});

test('v2.7 P1-C：质量检查异步执行，不阻塞事件循环', async () => {
  const { config, project } = mk(`node -e "setTimeout(()=>{console.log(JSON.stringify({requirements:[{id:'R1',status:'pass',evidence:'async ok'}]}))},300)"`);
  const pending = runQualityCommand({ config, project });
  let ticked = false;
  const immediate = setImmediate(() => { ticked = true; });
  const res = await pending;
  clearImmediate(immediate);
  assert.equal(res.ok, true);
  assert.equal(ticked, true, '质量命令执行期间事件循环必须继续运行（不能是同步 spawnSync）');
});
