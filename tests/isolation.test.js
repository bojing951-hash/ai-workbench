// SPDX-License-Identifier: Apache-2.0
/** v2.1：执行隔离能力探测与 fail-closed 策略测试（不依赖真实 Docker）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIsolationCapabilities, assertIsolationForProject, isolationModeForProject } from '../src/isolation.js';

const config = { isolation: { mode: 'restricted' } };

test('Docker 可用时 kernelIsolation=docker，restricted 控件仍列出限制', () => {
  const caps = detectIsolationCapabilities({ dockerProbe: () => ({ available: true, engine: 'docker', version: '29.0', reason: '' }) });
  assert.equal(caps.kernelIsolation, 'docker');
  assert.equal(caps.kernelAvailable, true);
  assert.ok(caps.restrictedRuntime.controls.length >= 3);
  assert.ok(caps.restrictedRuntime.limitations.length >= 2);
});

test('Docker/sandbox 均不可用时 kernelIsolation=BLOCKED，且不自动提权', () => {
  const caps = detectIsolationCapabilities({ dockerProbe: () => ({ available: false, engine: 'docker', version: '', reason: 'no daemon' }) });
  assert.equal(caps.kernelIsolation, 'BLOCKED');
  assert.equal(caps.kernelAvailable, false);
  assert.match(caps.note, /BLOCKED/);
});

test('restricted 项目允许运行但标记无强隔离；require_kernel/docker 项目 fail-closed', () => {
  const caps = detectIsolationCapabilities({ dockerProbe: () => ({ available: false, engine: 'docker', version: '', reason: 'no daemon' }) });
  const restricted = { config_json: {} };
  const iso = assertIsolationForProject(config, restricted, caps);
  assert.equal(iso.mode, 'restricted');
  assert.equal(iso.strong, false);
  assert.match(iso.warning, /受限运行环境/);
  for (const mode of ['docker', 'require_kernel']) {
    const project = { config_json: { isolation_mode: mode } };
    assert.throws(() => assertIsolationForProject(config, project, caps), /ISOLATION_UNAVAILABLE|隔离/);
  }
  assert.equal(isolationModeForProject(config, restricted), 'restricted');
});
