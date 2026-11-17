# 配置说明

配置加载顺序：进程环境变量 > 工作台根目录 `.env` > 代码默认值。
`.env` 已加入 `.gitignore`，请勿提交。

## 1. 模型与审计

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | 空 | GPT 独立审计 Key；配置后审计优先使用 GPT |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容端点（可接代理） |
| `OPENAI_AUDIT_MODEL` | `gpt-4.1` | GPT 审计模型 |
| `GLM_API_KEY` | 空 | GLM 审计 Key（Anthropic 兼容端点） |
| `GLM_BASE_URL` | `https://open.bigmodel.cn/api/anthropic` | GLM Anthropic 兼容端点 |
| `GLM_AUDIT_MODEL` | `glm-5.3` | GLM 审计模型 |
| `AUDIT_PROVIDER` | `auto` | `auto/openai/glm/deepseek`；auto 优先 GPT，其次 GLM，最后 DeepSeek |
| `AUDIT_TIMEOUT_MS` | `300000` | 单次审计超时 |
| `AUDIT_MAX_DIFF_CHARS` | `70000` | 传给审计的 diff 上限（超出头尾截断） |
| `DEEPSEEK_API_KEY` | 空 | 规划器与 DSH Agent 使用 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek OpenAI 兼容端点 |
| `PLANNER_MODEL` | `deepseek-chat` | 规划模型 |
| `PLANNER_PROVIDER` | `deepseek` | 规划提供方 |

## 2. Coding Agent

### DeepSeek Harness（推荐）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_BIN` | Desktop 安装路径下的 `runtime/cli/bin/dsh` | DSH CLI 可执行文件 |
| `DSH_PERMISSION_MODE` | `workspace-write` | `read-only / workspace-write / danger-full-access`。**注意**：若宿主机沙箱不可用（如嵌套沙箱环境），需使用 `danger-full-access` |
| `DSH_APPROVAL_POLICY` | `never` | headless 审批策略 |
| `DSH_TIMEOUT_MS` | `900000` | 单次编码超时 |
| `DSH_HOME_OVERRIDE` | `data/agents/dsh-home` | DSH 会话与配置目录（隔离，不写入用户 ~/.dsh） |

工作台会向子进程注入 `DEEPSEEK_API_KEY`，DSH 在隔离 `DSH_HOME` 中运行，不影响你的桌面端配置。

### Claude Code

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Claude Code CLI |
| `CLAUDE_BASE_URL` | 空 | 覆盖 Anthropic 兼容端点（如 GLM） |
| `CLAUDE_API_KEY` | 空 | 覆盖 API Key；留空继承本机 Claude Code 配置 |
| `CLAUDE_MODEL` | 空 | 覆盖模型名 |
| `CLAUDE_TIMEOUT_MS` | `600000` | 单次编码超时 |
| `CLAUDE_HOME_OVERRIDE` | `data/agents/claude-home` | 隔离的 `CLAUDE_CONFIG_DIR` |

### 自定义 Agent（预留接口）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CUSTOM_AGENT_BIN` | 空 | 任意 Agent 可执行文件 |
| `CUSTOM_AGENT_ARGS` | 空 | 命令模板，支持 `{prompt_file}` `{cwd}`；prompt 同时通过 stdin 传入 |
| `CUSTOM_AGENT_LABEL` | `自定义 Agent` | 显示名 |

约定：stdout 最后一个 JSON 对象可为
`{"result":"...","session_id":"...","usage":{"input_tokens":0,"output_tokens":0},"cost_cny":0}`，否则按纯文本结果处理（token 计 0）。

## 3. 预算与策略

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAX_TOTAL_TOKENS` | `3000000` | 全局 token 执行前上限；厂商调用后结算可能超一次，不能保证绝对硬封顶 |
| `MAX_COST_CNY` | `30` | 全局估算成本上限（元） |
| `MAX_TOKENS_PER_TASK` | `600000` | 单次 Agent 调用 token 上限 |
| `MAX_ATTEMPTS` | `2` | 每个任务最大编码尝试次数（含测试/审计失败） |
| `MAX_AGENT_CONCURRENCY` | `2` | 全局 Agent 并发数 |
| `MIN_RESERVE_TOKENS` | `20000` | 预算保留，低于此值暂停运行 |
| `TEST_TIMEOUT_MS` | `600000` | 测试命令超时 |
| `POLICY_AUTO_PUSH` | `true` | 是否自动推送计划分支 |
| `CI_POLL_ATTEMPTS` | `6` | PR 后 Actions 轮询次数 |
| `CI_POLL_INTERVAL_MS` | `10000` | Actions 轮询间隔 |

## 4. GitHub

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | 空 | Fine-grained PAT：Contents(读写)、Pull requests(读写)、Actions(读) |
| `GITHUB_OWNER` | 空 | 仓库所属账号；留空则用 Token 对应用户 |
| `GITHUB_REPO_PREFIX` | `ai-workbench-` | 自动创建仓库名前缀 |
| `GITHUB_API_BASE` | `https://api.github.com` | GitHub API 基地址（企业版可改） |
| `GITHUB_CREATE_PR` | `true` | 是否自动创建草稿 PR |
| `GITHUB_PUSH` | `true` | 是否自动推送 |
| `GITHUB_AUTO_CREATE_REPO` | `true` | 本地项目无远端时是否自动创建私有仓库 |

未配置 Token 时，运行仍可完成本地开发；推送/PR/CI 会以 `blocked` 动作记录并提示授权。

## 5. 服务与路径

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKBENCH_HOST` | `127.0.0.1` | 监听地址 |
| `WORKBENCH_PORT` | `4477` | 端口 |
| `WORKBENCH_DATA_DIR` | `data/` | 数据库、worktree、产物、日志、Agent Home |
| `WORKBENCH_PROJECTS_DIR` | `projects/` | 克隆/登记的项目目录 |
| `AUTO_RESUME_ON_BOOT` | `false` | 启动时是否自动恢复中断运行（默认人工确认后恢复） |

## 6. 本机密钥引导（一次性）

工作台不会自动读取其他应用密钥。若你希望复用本机已配置的 DeepSeek / GLM Key，可手动写入 `.env`：

```bash
# 从 DSH 桌面端凭证导出 DeepSeek Key（可选）
grep -E '^  DEEPSEEK_API_KEY:' ~/.dsh/.credentials.yaml
# Claude Code 的 GLM 配置（可选）
node -e "const s=require(process.env.HOME+'/.claude/settings.json').env; console.log(s.ANTHROPIC_API_KEY, s.ANTHROPIC_BASE_URL)"
```

将值填入 `.env` 后重启工作台生效。
