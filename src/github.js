// SPDX-License-Identifier: Apache-2.0
/**
 * GitHub 集成：仓库创建、分支推送、PR、Actions 状态。
 * 仅使用 REST API；需要 GITHUB_TOKEN（未配置时所有远端动作明确报错，不伪造结果）。
 * 工作台永不调用合并接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, truncate } from './util.js';

export class GithubError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function githubConfigured(config) {
  return !!config.github.token;
}

export function githubOwner(config) {
  return config.github.owner || '';
}

export async function api(config, method, apiPath, body = null) {
  if (!config.github.token) {
    throw new GithubError('GITHUB_TOKEN_MISSING', '未配置 GITHUB_TOKEN，无法调用 GitHub API');
  }
  const url = `${config.github.apiBase.replace(/\/+$/, '')}${apiPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.github.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-dev-workbench',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new GithubError('GITHUB_API_ERROR', `GitHub API ${method} ${apiPath} 失败 (${res.status}): ${truncate(text, 600)}`, {
        status: res.status,
        body: data,
      });
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAuthenticatedUser(config) {
  const data = await api(config, 'GET', '/user');
  return { login: data.login, id: data.id };
}

export async function getRepo(config, owner, repo) {
  try {
    return await api(config, 'GET', `/repos/${owner}/${repo}`);
  } catch (err) {
    if (err.details?.status === 404) return null;
    throw err;
  }
}

export async function ensureRepo(config, { name, private: isPrivate = true, description = '' }) {
  if (!githubConfigured(config)) throw new GithubError('GITHUB_TOKEN_MISSING', '未配置 GITHUB_TOKEN');
  let owner = githubOwner(config);
  if (!owner) {
    const user = await getAuthenticatedUser(config);
    owner = user.login;
  }
  const existing = await getRepo(config, owner, name);
  if (existing) {
    return { owner, repo: name, created: false, htmlUrl: existing.html_url, cloneUrl: existing.clone_url, defaultBranch: existing.default_branch };
  }
  const created = await api(config, 'POST', '/user/repos', {
    name,
    private: isPrivate,
    description: description || 'AI 开发工作台演示仓库',
    auto_init: false,
    has_issues: true,
  });
  return { owner, repo: name, created: true, htmlUrl: created.html_url, cloneUrl: created.clone_url, defaultBranch: created.default_branch || 'main' };
}

export async function createPullRequest(config, { owner, repo, title, head, base, body, draft = true }) {
  // 幂等：同 head 的 open PR 已存在则复用
  const open = await api(config, 'GET', `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(owner + ':' + head)}`);
  if (Array.isArray(open) && open.length > 0) {
    return { number: open[0].number, url: open[0].html_url, reused: true };
  }
  const pr = await api(config, 'POST', `/repos/${owner}/${repo}/pulls`, {
    title,
    head,
    base,
    body,
    draft,
  });
  return { number: pr.number, url: pr.html_url, reused: false };
}

export async function findPullRequestByHead(config, owner, repo, head) {
  const data = await api(config, 'GET', `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open&per_page=20`);
  return Array.isArray(data) ? data : [];
}

export async function getPullRequest(config, owner, repo, number) {
  return api(config, 'GET', `/repos/${owner}/${repo}/pulls/${number}`);
}

export async function listWorkflowRunsForSha(config, owner, repo, sha) {
  const data = await api(
    config,
    'GET',
    `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=10`,
  );
  return (data.workflow_runs || []).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    htmlUrl: r.html_url,
    headBranch: r.head_branch,
    headSha: r.head_sha || '',
    createdAt: r.created_at,
  }));
}

export async function getCombinedStatus(config, owner, repo, ref) {
  const data = await api(config, 'GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`);
  return { state: data.state, statuses: (data.statuses || []).map((s) => ({ context: s.context, state: s.state, description: s.description, targetUrl: s.target_url })) };
}

export function remoteUrlFor(config, owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

/** 生成 GitHub Actions 工作流（Node 项目默认），返回相对路径。 */
export function ensureWorkflowFile(projectDir, { testCommand, nodeVersion = '24' } = {}) {
  const workflowPath = path.join(projectDir, '.github', 'workflows', 'ai-verify.yml');
  if (fs.existsSync(workflowPath)) return { path: path.relative(projectDir, workflowPath), created: false };
  ensureDir(path.dirname(workflowPath));
  const command = String(testCommand || 'npm test').replace(/\n/g, ' ').replace(/"/g, '\\"');
  const content = `# 由 AI 开发工作台生成：自动化验证
name: AI Workbench Verify
on:
  push:
    branches: ["**"]
  pull_request:
    branches: ["**"]
  workflow_dispatch:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "${nodeVersion}"
      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f package.json ]; then npm install --no-audit --no-fund; else echo "no node dependencies"; fi
      - name: Run tests
        run: "${command}"
`;
  fs.writeFileSync(workflowPath, content);
  return { path: path.relative(projectDir, workflowPath), created: true };
}
