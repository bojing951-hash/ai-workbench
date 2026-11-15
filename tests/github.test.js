// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/github.js 的 ensureWorkflowFile（本地文件生成，不访问网络）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureWorkflowFile, githubConfigured, remoteUrlFor, GithubError } from '../src/github.js';

describe('github.ensureWorkflowFile：生成 .github/workflows/ai-verify.yml', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-github-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('文件不存在时创建，内容包含测试命令与 Node 版本', () => {
    const projectDir = path.join(tmpDir, 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });
    const res = ensureWorkflowFile(projectDir, { testCommand: 'npm test', nodeVersion: '24' });
    assert.deepEqual(res, { path: path.join('.github', 'workflows', 'ai-verify.yml'), created: true });

    const file = path.join(projectDir, '.github', 'workflows', 'ai-verify.yml');
    assert.ok(fs.existsSync(file));
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('AI Workbench Verify'));
    assert.ok(content.includes('actions/checkout@v4'));
    assert.ok(content.includes('actions/setup-node@v4'));
    assert.ok(content.includes('node-version: "24"'));
    assert.ok(content.includes('run: "npm test"'));
    assert.ok(content.includes('push:'));
    assert.ok(content.includes('pull_request:'));
  });

  it('已存在文件时不覆盖，返回 created=false', () => {
    const projectDir = path.join(tmpDir, 'project-b');
    const workflowDir = path.join(projectDir, '.github', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    const custom = '# 自定义 CI，不允许被覆盖\nname: Custom\n';
    fs.writeFileSync(path.join(workflowDir, 'ai-verify.yml'), custom);

    const res = ensureWorkflowFile(projectDir, { testCommand: 'node --test' });
    assert.equal(res.created, false);
    assert.equal(fs.readFileSync(path.join(workflowDir, 'ai-verify.yml'), 'utf8'), custom);
  });

  it('未提供测试命令时默认 npm test；命令中的引号与换行被安全转义', () => {
    const projectDir = path.join(tmpDir, 'project-c');
    fs.mkdirSync(projectDir, { recursive: true });
    ensureWorkflowFile(projectDir);
    let content = fs.readFileSync(path.join(projectDir, '.github', 'workflows', 'ai-verify.yml'), 'utf8');
    assert.ok(content.includes('run: "npm test"'));

    const projectDir2 = path.join(tmpDir, 'project-d');
    fs.mkdirSync(projectDir2, { recursive: true });
    ensureWorkflowFile(projectDir2, { testCommand: 'node --test "tests/a.test.js"\necho ok' });
    content = fs.readFileSync(path.join(projectDir2, '.github', 'workflows', 'ai-verify.yml'), 'utf8');
    assert.ok(content.includes('run: "node --test \\"tests/a.test.js\\" echo ok"'));
    assert.equal(content.includes('a.test.js"\necho'), false);
  });

  it('githubConfigured / remoteUrlFor 与 GithubError 基础契约', () => {
    assert.equal(githubConfigured({ github: { token: '' } }), false);
    assert.equal(githubConfigured({ github: { token: 't' } }), true);
    assert.equal(remoteUrlFor({}, 'acme', 'demo'), 'https://github.com/acme/demo.git');
    const err = new GithubError('GITHUB_TOKEN_MISSING', '缺少 token');
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'GITHUB_TOKEN_MISSING');
  });
});
