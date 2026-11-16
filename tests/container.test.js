// SPDX-License-Identifier: Apache-2.0
/** v2.2：Docker 容器执行适配器安全边界 + 真实容器执行测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDockerArgs, dockerAvailable, imageAvailable, runTestInContainer, containerCapabilities } from '../src/container.js';
import { getConfig } from '../src/config.js';

const config = getConfig({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-container-')) });
const docker = dockerAvailable();
const image = imageAvailable({ image: 'ai-workbench-runtime:2.2' });
const dockerReady = docker.available && image.available;

test('容器参数包含安全边界：无特权/无网络/只读 rootfs/最小挂载/非 root', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-wt-'));
  const args = buildDockerArgs({ image: 'ai-workbench-runtime:2.2', worktree, command: 'node -e "console.log(1)"' });
  const joined = args.join(' ');
  assert.match(joined, /--network none/);
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /no-new-privileges:true/);
  assert.match(joined, /--read-only/);
  assert.match(joined, /--user \d+:\d+/);
  assert.match(joined, /-v .*:\/workspace:rw/);
  assert.doesNotMatch(joined, /docker\.sock|--privileged|\/var\/run/);
  assert.equal(args.filter((a) => a === '--network').length, 1);
});

test('拒绝挂载宿主根/ HOME / Docker socket', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-wt-'));
  assert.throws(() => buildDockerArgs({ worktree, command: 'true', mounts: [{ source: '/', target: '/host' }] }), /挂载/);
  assert.throws(() => buildDockerArgs({ worktree, command: 'true', mounts: [{ source: os.homedir(), target: '/config' }] }), /挂载/);
});

test('Docker/镜像不可用或缺失时 fail-closed', async () => {
  if (!docker.available) {
    await assert.rejects(() => runTestInContainer({ config, worktree: process.cwd(), command: 'true' }), /CONTAINER_UNAVAILABLE|Docker/);
    return;
  }
  if (image.available) {
    await assert.rejects(() => runTestInContainer({ config, worktree: process.cwd(), command: 'true', image: 'no-such-image:does-not-exist' }), /CONTAINER_IMAGE_MISSING|镜像/);
  }
});

test('真实 Docker 容器内执行测试命令（network none）', { skip: !dockerReady && 'Docker daemon 或运行时镜像不可用' }, async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-wt-'));
  fs.writeFileSync(path.join(worktree, 'x.txt'), 'hello');
  const res = await runTestInContainer({ config, worktree, command: 'node -e "console.log(40+2)"; test -f x.txt && echo FILE_OK', timeoutMs: 60_000 });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /42/);
  assert.match(res.stdout, /FILE_OK/);
  assert.equal(res.isolation.backend, 'docker');
  assert.equal(res.isolation.network, 'none');
  // 容器内只挂载 /workspace；宿主 HOME/根目录不可见（最小挂载）
  const res2 = await runTestInContainer({ config, worktree, command: 'test ! -e /Users && echo NO_HOST_HOME; test ! -e /Applications && echo NO_HOST_APPS; test -d /workspace && echo WORKSPACE_OK', timeoutMs: 60_000 });
  assert.match(res2.stdout, /NO_HOST_HOME/);
  assert.match(res2.stdout, /NO_HOST_APPS/);
  assert.match(res2.stdout, /WORKSPACE_OK/);
});

test('容器能力报告区分可用性与镜像存在性', () => {
  const caps = containerCapabilities(config);
  assert.equal(typeof caps.docker.available, 'boolean');
  assert.equal(caps.image.name, 'ai-workbench-runtime:2.2');
  assert.equal(caps.testExecution, caps.docker.available && caps.image.available);
  assert.ok(caps.security.some((x) => x.includes('cap-drop')));
});
