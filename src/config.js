// SPDX-License-Identifier: Apache-2.0
/**
 * 配置加载：.env + 环境变量 + 默认值。
 * 密钥只来自环境变量/.env，绝不写入数据库、事件流或日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, parseDotenv, parseList, toBool } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKBENCH_ROOT = path.resolve(__dirname, '..');

let cached = null;

function defaultDshBin() {
  const macPath = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  if (fs.existsSync(macPath)) return macPath;
  // Linux / 自定义安装：优先 PATH 中的 dsh（用户可在 .env 中用 DSH_BIN 覆盖）
  return 'dsh';
}

function readDotenv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  return parseDotenv(fs.readFileSync(file, 'utf8'));
}

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

export function buildConfig(overrides = {}) {
  const dotenv = readDotenv(WORKBENCH_ROOT);
  const env = { ...dotenv, ...process.env };
  const root = path.resolve(str(env.WORKBENCH_ROOT, WORKBENCH_ROOT));
  const dataDir = path.resolve(root, str(env.WORKBENCH_DATA_DIR, 'data'));
  const paths = {
    root,
    dataDir,
    dbPath: path.resolve(dataDir, 'workbench.db'),
    projectsDir: path.resolve(root, str(env.WORKBENCH_PROJECTS_DIR, 'projects')),
    worktreesDir: path.resolve(dataDir, 'worktrees'),
    artifactsDir: path.resolve(dataDir, 'artifacts'),
    logsDir: path.resolve(dataDir, 'logs'),
    agentsDir: path.resolve(dataDir, 'agents'),
    dshHome: path.resolve(dataDir, 'agents', 'dsh-home'),
    claudeHome: path.resolve(dataDir, 'agents', 'claude-home'),
  };
  for (const dir of [
    paths.dataDir,
    paths.projectsDir,
    paths.worktreesDir,
    paths.artifactsDir,
    paths.logsDir,
    paths.agentsDir,
  ]) {
    ensureDir(dir);
  }

  const secrets = [env.OPENAI_API_KEY, env.GLM_API_KEY, env.DEEPSEEK_API_KEY, env.GITHUB_TOKEN, env.CLAUDE_API_KEY]
    .filter((v) => typeof v === 'string' && v.trim().length >= 6);

  const config = {
    root,
    paths,
    secrets,
    server: {
      host: str(env.WORKBENCH_HOST, '127.0.0.1'),
      port: int(env.WORKBENCH_PORT, 4477),
    },
    budget: {
      maxTotalTokens: int(env.MAX_TOTAL_TOKENS, 3_000_000),
      maxCostCny: Number(env.MAX_COST_CNY ?? 30),
      maxTokensPerTask: int(env.MAX_TOKENS_PER_TASK, 600_000),
      maxAttempts: int(env.MAX_ATTEMPTS, 2),
      maxAgentConcurrency: int(env.MAX_AGENT_CONCURRENCY, 2),
      minReserveTokens: int(env.MIN_RESERVE_TOKENS, 20_000),
      // 缓存读取 token 按较低权重计入预算（原始用量仍完整展示；权重用于硬上限保护）
      cacheTokenWeight: Number(env.CACHE_TOKEN_WEIGHT ?? 0.1),
      // 用户明确授权：GLM 模型不受工作台内部 token/费用上限约束；但仍完整记录真实用量与费用
      glmUnlimited: true,
      exemptProviders: ['glm'],
      maxTokensPerRun: int(env.MAX_TOKENS_PER_RUN, 900_000),
      maxCostCnyPerRun: Number(env.MAX_COST_CNY_PER_RUN ?? 12),
      runWallClockMs: int(env.RUN_WALL_CLOCK_MS, 6 * 60 * 60 * 1000),
      maxConcurrentTasksPerProject: 1,
    },
    agents: {
      default: str(env.DEFAULT_AGENT, 'auto'),
      dsh: {
        bin: str(env.DSH_BIN, defaultDshBin()),
        home: str(env.DSH_HOME_OVERRIDE, paths.dshHome),
        permissionMode: str(env.DSH_PERMISSION_MODE, 'workspace-write'),
        approvalPolicy: str(env.DSH_APPROVAL_POLICY, 'never'),
        timeoutMs: int(env.DSH_TIMEOUT_MS, 900_000),
        label: 'DeepSeek Harness',
      },
      claude: {
        bin: str(env.CLAUDE_BIN, 'claude'),
        home: str(env.CLAUDE_HOME_OVERRIDE, paths.claudeHome),
        // 未显式配置时，若存在 GLM Key 则复用 GLM 的 Anthropic 兼容端点（本机 Claude Code 常用配置）
        baseUrl: str(env.CLAUDE_BASE_URL, env.GLM_API_KEY ? env.GLM_BASE_URL : ''),
        apiKey: str(env.CLAUDE_API_KEY, env.GLM_API_KEY || ''),
        model: str(env.CLAUDE_MODEL, env.GLM_AUDIT_MODEL || ''),
        timeoutMs: int(env.CLAUDE_TIMEOUT_MS, 600_000),
        // P0-1：默认不再 bypass 权限，只允许读/写/搜索工具，禁用 shell 与网络工具
        permissionMode: str(env.CLAUDE_PERMISSION_MODE, 'acceptEdits'),
        allowedTools: str(env.CLAUDE_ALLOWED_TOOLS, 'Read,Edit,Write,Glob,Grep,LS'),
        disallowedTools: str(env.CLAUDE_DISALLOWED_TOOLS, 'Bash,WebFetch,WebSearch,Task,NotebookEdit'),
        label: 'Claude Code',
      },
      custom: {
        bin: str(env.CUSTOM_AGENT_BIN, ''),
        args: str(env.CUSTOM_AGENT_ARGS, ''),
        label: str(env.CUSTOM_AGENT_LABEL, '自定义 Agent'),
        envAllowlist: str(env.CUSTOM_AGENT_ENV_ALLOWLIST, ''),
      },
    },
    llm: {
      openai: {
        apiKey: str(env.OPENAI_API_KEY, ''),
        baseUrl: str(env.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
        model: str(env.OPENAI_AUDIT_MODEL, 'gpt-4.1'),
      },
      glm: {
        apiKey: str(env.GLM_API_KEY, ''),
        baseUrl: str(env.GLM_BASE_URL, 'https://open.bigmodel.cn/api/anthropic'),
        model: str(env.GLM_AUDIT_MODEL, 'glm-5.3'),
      },
      deepseek: {
        apiKey: str(env.DEEPSEEK_API_KEY, ''),
        baseUrl: str(env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com'),
        model: str(env.PLANNER_MODEL, 'deepseek-chat'),
      },
    },
    audit: {
      // auto: 优先选择与编码模型不同族的审计模型；报告会标注实际 provider
      provider: str(env.AUDIT_PROVIDER, 'auto'),
      timeoutMs: int(env.AUDIT_TIMEOUT_MS, 300_000),
      maxDiffChars: int(env.AUDIT_MAX_DIFF_CHARS, 70_000),
      maxTokens: int(env.AUDIT_MAX_TOKENS, 12_000),
      contextFiles: (env.AUDIT_CONTEXT_FILES || 'src/orchestrator.js,src/policy.js,src/server.js').split(',').map((x) => x.trim()).filter(Boolean),
      requireIndependent: toBool(env.AUDIT_REQUIRE_INDEPENDENT, true),
      allowSameFamily: toBool(env.AUDIT_ALLOW_SAME_FAMILY, false),
      maxChunks: int(env.AUDIT_MAX_CHUNKS, 6),
    },
    planner: {
      // 规划器与审计器分离：默认 DeepSeek，便宜且中文好
      provider: str(env.PLANNER_PROVIDER, 'deepseek'),
      timeoutMs: int(env.PLANNER_TIMEOUT_MS, 180_000),
    },
    github: {
      token: str(env.GITHUB_TOKEN, ''),
      owner: str(env.GITHUB_OWNER, ''),
      repoPrefix: str(env.GITHUB_REPO_PREFIX, 'ai-workbench-'),
      apiBase: str(env.GITHUB_API_BASE, 'https://api.github.com'),
      createPr: toBool(env.GITHUB_CREATE_PR, true),
      push: toBool(env.GITHUB_PUSH, true),
      autoCreateRepo: toBool(env.GITHUB_AUTO_CREATE_REPO, true),
    },
    security: {
      allowUnsafeAgentPermissions: toBool(env.WORKBENCH_ALLOW_UNSAFE_AGENT, false),
      apiToken: str(env.WORKBENCH_API_TOKEN, ''),
      allowedHosts: parseList(env.WORKBENCH_ALLOWED_HOSTS),
      testEnvAllowlist: parseList(env.TEST_ENV_ALLOWLIST),
      maxBodyBytes: int(env.MAX_BODY_BYTES, 2 * 1024 * 1024),
      writeRateLimitPerMinute: int(env.WRITE_RATE_LIMIT_PER_MINUTE, 120),
    },
    isolation: {
      mode: env.ISOLATION_MODE || 'restricted',
      dockerBin: env.DOCKER_BIN || 'docker',
      testImage: env.ISOLATION_TEST_IMAGE || '',
    },
    policy: {
      neverMerge: true,
      allowForcePush: false,
      autoPush: toBool(env.POLICY_AUTO_PUSH, true),
      protectedPaths: ['acceptance/**', '.github/**'],
      testTimeoutMs: int(env.TEST_TIMEOUT_MS, 600_000),
      ciPollAttempts: int(env.CI_POLL_ATTEMPTS, 6),
      ciPollIntervalMs: int(env.CI_POLL_INTERVAL_MS, 10_000),
    },
    recover: {
      autoResumeOnBoot: toBool(env.AUTO_RESUME_ON_BOOT, false),
    },
  };
  return deepFreeze(overrides ? mergeConfig(config, overrides) : config);
}

function mergeConfig(base, overrides) {
  const clone = JSON.parse(JSON.stringify(base));
  return deepMerge(clone, overrides);
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

export function getConfig(overrides) {
  if (overrides) return buildConfig(overrides);
  if (!cached) cached = buildConfig();
  return cached;
}

export function resetConfigCache() {
  cached = null;
}
