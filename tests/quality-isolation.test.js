// SPDX-License-Identifier: Apache-2.0
/** v2.8 P0-3：质量命令默认 Docker 隔离；隔离不可用 fail-closed，禁止宿主 shell 降级。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { runQualityCommand } from '../src/quality.js';
import { dockerAvailable, imageAvailable } from '../src/container.js';

function mk(qualityExtra = {}, configExtra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-qiso-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const config = getConfig({
    root,
    paths: { root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), worktreesDir: path.join(root, 'worktrees'), artifactsDir: path.join(root, 'artifacts'), logsDir: path.join(root, 'logs'), agentsDir: path.join(root, 'agents'), dbPath: path.join(root, 'data', 'test.db'), dshHome: path.join(root, 'agents', 'dsh-home'), claudeHome: path.join(root, 'agents', 'claude-home') },
    llm: { openai: { apiKey: '' }, glm: { apiKey: '' }, deepseek: { apiKey: '' } }, github: { token: '' },
    ...configExtra,
  });
  const project = { id: 'p', name: 'q', local_path: repo, config_json: { quality: {
    quality_command: `node -e "console.log(JSON.stringify({requirements:[{id:'R1',status:'pass',evidence:'container isolated; env=' + (process.env.DEEPSEEK_API_KEY ? 'leak' : 'none')}]}))"`,
    timeout_ms: 30000,
    isolation: 'docker',
    requirements: [{ id: 'R1', title: 'R1', priority: 'P0', acceptance: ['ok'] }],
    ...qualityExtra,
  } } };
  return { config, project, repo, root };
}

test('v2.8 P0-3：Docker 不可用时 fail-closed，质量命令不得回退宿主 shell', async () => {
  const { config, project } = mk();
  const badConfig = { ...config, isolation: { ...config.isolation, container: { ...config.isolation.container, dockerBin: '/nonexistent/docker-v28' } } };
  const res = await runQualityCommand({ config: badConfig, project });
  assert.equal(res.ok, false);
  assert.equal(res.commandFailed, true);
  assert.equal(res.issueClass, 'CONTAINER_UNAVAILABLE');
  assert.equal(res.requirements.length, 0);
});

test('v2.8 P0-3：Docker 可用时质量命令在容器内执行，不泄露宿主凭据', async (t) => {
  const base = getConfig();
  if (!dockerAvailable({ dockerBin: base.isolation.container.dockerBin }).available) return t.skip('Docker daemon 不可用');
  if (!imageAvailable({ dockerBin: base.isolation.container.dockerBin, image: base.isolation.container.image }).available) return t.skip('质量容器镜像不可用');
  const { config, project } = mk();
  process.env.DEEPSEEK_API_KEY = 'must-not-leak';
  try {
    const res = await runQualityCommand({ config, project });
    assert.equal(res.ok, true, res.reason || res.stderr);
    assert.equal(res.isolation?.backend, 'docker');
    assert.ok(!String(JSON.stringify(res)).includes('must-not-leak'));
    assert.equal(res.requirements[0].status, 'pass');
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('v2.8 P0-3：显式 host 模式但未授权 acknowledgment，仍 fail-closed', async () => {
  const { config, project } = mk({ isolation: 'host' });
  const res = await runQualityCommand({ config, project });
  assert.equal(res.ok, false);
  assert.equal(res.issueClass, 'HOST_QUALITY_FORBIDDEN');
});

test('v2.8 P0-3：Docker 质量命令超时被分类并终止', async (t) => {
  const base = getConfig();
  if (!dockerAvailable({ dockerBin: base.isolation.container.dockerBin }).available) return t.skip('Docker daemon 不可用');
  if (!imageAvailable({ dockerBin: base.isolation.container.dockerBin, image: base.isolation.container.image }).available) return t.skip('质量容器镜像不可用');
  const { config, project } = mk({ quality_command: 'node -e "setTimeout(()=>{},10000)"', timeout_ms: 4000 });
  const res = await runQualityCommand({ config, project });
  assert.equal(res.ok, false);
  assert.equal(res.issueClass, 'TIMEOUT');
});

test('v2.8 P0-3：Docker 质量命令取消被分类为 ABORTED', async (t) => {
  const base = getConfig();
  if (!dockerAvailable({ dockerBin: base.isolation.container.dockerBin }).available) return t.skip('Docker daemon 不可用');
  if (!imageAvailable({ dockerBin: base.isolation.container.dockerBin, image: base.isolation.container.image }).available) return t.skip('质量容器镜像不可用');
  const { config, project } = mk({ quality_command: 'node -e "setTimeout(()=>{},10000)"', timeout_ms: 15000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 800);
  const res = await runQualityCommand({ config, project, signal: controller.signal });
  assert.equal(res.ok, false);
  assert.equal(res.issueClass, 'ABORTED');
});
