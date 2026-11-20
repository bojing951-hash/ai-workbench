// SPDX-License-Identifier: Apache-2.0
/**
 * Git 工作流：每任务独立 worktree/branch，任务通过后提交并推进计划分支。
 * 工作台只创建分支与 PR，**永不合并主分支**。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execCapture, git } from './runner.js';

export { git } from './runner.js';
import { ensureDir } from './util.js';

export async function isGitRepo(dir) {
  try {
    await git(dir, ['rev-parse', '--git-dir'], { allowFail: false, timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export async function ensureGitRepo(dir, defaultBranch = 'main') {
  ensureDir(dir);
  if (await isGitRepo(dir)) return dir;
  await git(dir, ['init', '-b', defaultBranch]);
  return dir;
}

export async function currentBranch(repo) {
  const res = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  return res.code === 0 ? res.stdout.trim() : '';
}

export async function currentHead(repo) {
  const res = await git(repo, ['rev-parse', 'HEAD'], { allowFail: true });
  return res.code === 0 ? res.stdout.trim() : '';
}

export async function hasCommits(repo) {
  const res = await git(repo, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  return res.code === 0;
}

export async function resolveDefaultBranch(repo) {
  const candidates = ['main', 'master'];
  for (const b of candidates) {
    const res = await git(repo, ['rev-parse', '--verify', `refs/heads/${b}`], { allowFail: true });
    if (res.code === 0) return b;
  }
  const cur = await currentBranch(repo);
  return cur || candidates[0];
}

export async function remoteUrl(repo) {
  const res = await git(repo, ['remote', 'get-url', 'origin'], { allowFail: true });
  return res.code === 0 ? res.stdout.trim() : '';
}

export async function addRemote(repo, name, url) {
  const existing = await git(repo, ['remote', 'get-url', name], { allowFail: true });
  if (existing.code === 0) await git(repo, ['remote', 'set-url', name, url]);
  else await git(repo, ['remote', 'add', name, url]);
}

function askpassScript(config) {
  const dir = path.join(config.paths.agentsDir, 'git');
  ensureDir(dir);
  const file = path.join(dir, 'askpass.sh');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) printf "%s" "$GITHUB_TOKEN" ;;\nesac\n',
      { mode: 0o700 },
    );
  }
  return file;
}

export function gitAuthEnv(config) {
  const env = {};
  if (config.github?.token) {
    env.GIT_ASKPASS = askpassScript(config);
    env.GITHUB_TOKEN = config.github.token;
    env.GIT_TERMINAL_PROMPT = '0';
  }
  return env;
}

export async function cloneRepo(config, repoUrl, destDir, { logPath = '' } = {}) {
  ensureDir(path.dirname(destDir));
  const url = normalizeGitUrl(repoUrl);
  await git(path.dirname(destDir), ['clone', url, destDir], {
    timeoutMs: 10 * 60 * 1000,
    env: gitAuthEnv(config),
    logPath,
  });
  return destDir;
}

export function normalizeGitUrl(url) {
  const u = String(url || '').trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(u)) return `https://github.com/${u}.git`;
  return u;
}

export async function branchRef(repo, branch) {
  const res = await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true });
  return res.code === 0 ? res.stdout.trim() : '';
}

export async function createWorktree(repo, worktreePath, branch, baseRef) {
  ensureDir(path.dirname(worktreePath));
  // 防呆：路径已存在（上次失败的 worktree）时先清理
  if (fs.existsSync(worktreePath)) {
    await removeWorktree(repo, worktreePath).catch(() => {});
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  const args = ['worktree', 'add', '-b', branch, worktreePath, baseRef];
  await git(repo, args);
  return worktreePath;
}

export async function removeWorktree(repo, worktreePath) {
  await git(repo, ['worktree', 'remove', '--force', worktreePath], { allowFail: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

export async function stageAll(worktree) {
  await git(worktree, ['add', '-A']);
}

export async function statusPorcelain(worktree) {
  const res = await git(worktree, ['status', '--porcelain'], { allowFail: true });
  return res.stdout;
}

export async function stagedDiff(worktree, baseRef, { maxChars = 200_000 } = {}) {
  await stageAll(worktree);
  const res = await git(worktree, ['diff', '--cached', baseRef], { timeoutMs: 120_000 });
  let diff = res.stdout;
  if (diff.length > maxChars) {
    const head = diff.slice(0, Math.floor(maxChars * 0.7));
    const tail = diff.slice(-Math.floor(maxChars * 0.3));
    diff = `${head}\n\n... [diff 已截断，原始长度 ${res.stdout.length} 字符] ...\n\n${tail}`;
  }
  return diff;
}

export async function stagedFiles(worktree, baseRef) {
  const res = await git(worktree, ['diff', '--cached', '--name-status', baseRef], { allowFail: true });
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, file: rest.join('\t') };
    });
}

export async function diffStat(worktree, baseRef) {
  const res = await git(worktree, ['diff', '--cached', '--stat', baseRef], { allowFail: true });
  return res.stdout.trim();
}

export async function restorePaths(worktree, files) {
  if (!files.length) return;
  await git(worktree, ['restore', '--staged', '--worktree', '--', ...files], { allowFail: true });
}

export async function hardReset(worktree, ref) {
  await git(worktree, ['reset', '--hard', ref], { allowFail: true });
  await git(worktree, ['clean', '-fd'], { allowFail: true });
}

export async function commitAll(worktree, message) {
  await stageAll(worktree);
  const staged = await git(worktree, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code === 0) {
    return { commit: await currentHead(worktree), files: [], empty: true };
  }
  await git(worktree, ['commit', '-m', message], { timeoutMs: 120_000 });
  const commit = await currentHead(worktree);
  const filesRes = await git(worktree, ['show', '--name-only', '--pretty=format:', commit], { allowFail: true });
  const files = filesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return { commit, files, empty: false };
}

export async function updateRef(repo, branch, commit, { requireAncestor = true } = {}) {
  if (requireAncestor) {
    const target = await branchRef(repo, branch);
    if (target) {
      const anc = await git(repo, ['merge-base', '--is-ancestor', target, commit], { allowFail: true });
      if (anc.code !== 0) {
        throw new Error(`拒绝推进分支 ${branch}：提交 ${commit} 不是其祖先（防止覆盖历史）`);
      }
    }
  }
  await git(repo, ['branch', '-f', branch, commit]);
  return commit;
}

export async function pushBranch(config, repo, branch, { logPath = '', remote = 'origin' } = {}) {
  if (!config.github?.token) {
    const err = new Error('缺少 GITHUB_TOKEN：无法推送远端分支');
    err.code = 'GITHUB_TOKEN_MISSING';
    throw err;
  }
  await git(repo, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], {
    timeoutMs: 10 * 60 * 1000,
    env: gitAuthEnv(config),
    logPath,
  });
  return true;
}

export async function pushCommitToBranch(config, repo, sha, branch, { logPath = '', remote = 'origin' } = {}) {
  if (!config.github?.token) {
    const err = new Error('缺少 GITHUB_TOKEN：无法推送远端分支');
    err.code = 'GITHUB_TOKEN_MISSING';
    throw err;
  }
  await git(repo, ['push', remote, `${sha}:refs/heads/${branch}`], {
    timeoutMs: 10 * 60 * 1000,
    env: gitAuthEnv(config),
    logPath,
  });
  const ls = await git(repo, ['ls-remote', remote, `refs/heads/${branch}`], { env: gitAuthEnv(config), allowFail: true, timeoutMs: 60_000 });
  const remoteSha = String(ls.stdout || '').trim().split(/\s+/)[0] || '';
  return { ok: ls.code === 0 && remoteSha === sha, remoteSha };
}

export async function listTree(repo, ref = 'HEAD', { max = 400 } = {}) {
  const res = await git(repo, ['ls-tree', '-r', '--name-only', ref], { allowFail: true });
  if (res.code !== 0) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, max);
}

export async function fileAtRef(repo, ref, file) {
  const res = await git(repo, ['show', `${ref}:${file}`], { allowFail: true, timeoutMs: 30_000 });
  return res.code === 0 ? res.stdout : '';
}

export async function fileHash(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return '';
  }
}

export async function protectedFileHashes(worktree, patterns) {
  const files = await listTree(worktree, 'HEAD');
  const out = {};
  for (const file of files) {
    if (!patterns.some((p) => fileMatch(p, file))) continue;
    const p = path.join(worktree, file);
    if (fs.existsSync(p)) out[file] = await fileHash(p);
  }
  return out;
}

function fileMatch(pattern, file) {
  const p = String(pattern).replace(/\\/g, '/');
  const f = String(file).replace(/\\/g, '/');
  const re = new RegExp(
    '^' +
      p
        .split('**')
        .map((part) =>
          part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
        )
        .join('.*') +
      '$',
  );
  return re.test(f);
}
