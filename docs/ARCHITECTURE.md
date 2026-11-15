# 架构设计

## 1. 设计目标与约束

| 目标 | 设计决策 |
|---|---|
| 基于 DSH 但不改 Harness 核心 | 独立工作台进程；通过 `dsh headless --json` 子进程复用 DSH Agent 能力，不安装/修改 DSH 插件或源码 |
| 支持 Claude Code 与预留其他模型 | Agent 适配器接口 + 注册表：`src/agents/{dsh,claude,custom}.js` |
| 确定性工作流 | SQLite 状态机 + CAS 状态迁移 + 每阶段落盘 + 明确重试上限；所有副作用有事件与产物 |
| 权限与预算 | 策略层统一校验预算/保护路径/发布开关；工作台无合并代码路径 |
| 中断恢复 | 状态持久化 + 任务级 worktree/branch + 启动时孤儿恢复 + 计划分支保护 |
| 独立审计 | 独立模型、独立上下文、只读审查；结论由代码硬校验，模型 verdict 不是唯一依据 |
| 自动修复 | 审计失败反馈注入同一 Agent 会话（DSH `--session-id` / Claude `--resume`），省 token 且保留上下文 |
| 可视化 | 零依赖 Web SPA + REST + SSE |

## 2. 进程与组件

```
浏览器
  │ HTTP / SSE
  ▼
src/server.js ──── 静态资源(web/) + REST API + SSE Hub
  │
  ▼
src/orchestrator.js（统一编排器，单进程内调度）
  ├── src/planner.js         规划器（DeepSeek / OpenAI 兼容）
  ├── src/agents/*           编码 Agent 适配器（子进程）
  ├── src/auditors/index.js  独立审计器（GPT / GLM）
  ├── src/runner.js          进程执行（超时、日志、SIGTERM/KILL）
  ├── src/git.js             每任务 worktree / 提交 / 分支 / 推送
  ├── src/github.js          仓库创建 / PR / Actions 状态
  ├── src/policy.js          预算 / 保护路径 / 审计硬校验
  └── src/db.js              SQLite 持久化 + 事件表
```

- 工作台是**独立 Node 进程**，与 DSH Desktop 无耦合；DSH 通过其 CLI 子进程参与。
- 所有 Agent 调用都在**项目工作副本**（`data/worktrees/<project>/<run>/task-<seq>`）中执行，工作台主仓库只用来管理 worktree/branch。
- 所有命令与 Agent 都有超时与进程组清理，避免挂死。

## 3. 任务状态机（持久化 + CAS）

```
                 ┌─────────────┐
                 │   queued    │◀────────────── resume 重置中间态/重试失败
                 └──────┬──────┘
                        ▼
                 ┌─────────────┐   git worktree/branch 创建失败
                 │  preparing  │──────────────▶ blocked
                 └──────┬──────┘
                        ▼
      ┌──────────▶┌─────────────┐◀───────────────────────┐
      │           │   coding    │  Agent 未改文件/违规/失败  │
      │           └──────┬──────┘                         │
      │                  ▼                                │
      │           ┌─────────────┐  测试失败                 │
      │           │   testing   │──────────────────────────┤
      │           └──────┬──────┘                         │
      │                  ▼                                │
      │           ┌─────────────┐  审计 fail（验收标准未过） │
      │           │  auditing   │──────────────────────────┤
      │           └──────┬──────┘                         │
      │                  ▼                                │
      │           ┌─────────────┐                         │
      │           │ committing  │                         │
      │           └──────┬──────┘                         │
      │                  ▼                                │
      │           ┌─────────────┐                         │
      └───────────│   passed    │                         │
         修复反馈  └─────────────┘          超过重试上限     │
                                         ┌─────────────┐  │
                                         │   failed    │◀─┘
                                         └─────────────┘
```

- 迁移通过 `transitionTask(id, from, to)` 的 `status = ?` 条件更新保证 CAS；中断恢复不会把已完成任务倒退。
- 每次编码尝试对应 `attempts` 表一行，包含 Agent、session、token、耗时、退出码、日志路径。
- 每次审计对应 `audits` 表一行，包含 provider/model、逐条 criteria、findings、required_fixes、原始报告产物。
- 每个任务最终通过时提交到 `wb/r<run>/t<seq>` 分支，并 fast-forward 更新 `wb/plan-<run>` 计划分支（用 `merge-base --is-ancestor` 防覆盖历史）。

## 4. 运行状态与恢复

```
queued → running → awaiting_acceptance → accepted
           │  ├→ paused（预算/任务失败/人工）→ resume → running
           │  └→ interrupted（进程重启）→ resume → running
           └→ cancelled
```

**恢复流程**（工作台启动时）：

1. `recoverOrphans()` 把 `running/queued` 运行标记为 `interrupted`，把 `running` 的 attempt 标记为 `interrupted`；
2. 用户点击「恢复运行」或执行 `workbench resume <runId>`；
3. `resumeRun()` 把中间态任务重置为 `queued`，移除并重建其 worktree；
4. 计划分支 `wb/plan-*` 保留已通过任务提交，后续任务从最新计划分支继续；
5. 已 passed 的任务不重做。

阶段二真实验收即：SIGKILL 服务进程 → 重启 → `recoverOrphans` → 恢复 → 继续完成剩余任务。

## 5. 独立审计契约

审计器输入：任务描述、**逐条验收标准**、完整任务 diff、测试命令与真实输出、仓库文件树。
审计器输出（强制 JSON）：

```json
{
  "score": 0,
  "criteria": [{"criterion": "...", "status": "pass|fail|unproven", "evidence": "..."}],
  "findings": [{"severity": "high|medium|low", "file": "", "line": 0, "issue": "", "required_fix": ""}],
  "required_fixes": ["..."],
  "summary": "..."
}
```

**代码硬校验**（`finalizeAuditVerdict`）：

- 以任务验收标准为准逐条匹配，缺失或 `unproven` 一律视为不通过；
- 任意 `high` 级 finding 直接判定 fail；
- 模型自述的 verdict 不作为通过依据；
- 解析失败会重试一次，仍失败则审计错误 → 任务阻塞（不降级为通过）。

审计提供方选择：`OPENAI_API_KEY` 存在 → GPT；否则 `GLM_API_KEY` → GLM-5.3；再否则 DeepSeek；都没有 → 阻塞并提示授权。界面与证据文件如实标注 provider。

## 6. 修复循环与 token 控制

1. 测试失败 → 把失败命令、退出码、输出尾部作为 feedback；
2. 审计失败 → 把逐条未通过标准、findings、required_fixes 作为 feedback；
3. 下一次尝试复用同一 Agent 会话（DSH `--session-id`、Claude `--resume`），保留代码上下文，减少 token；
4. 达到 `MAX_ATTEMPTS` 后任务 failed + 运行 paused，记录阻塞原因，等待人工处理，不伪造通过；
5. 全局 token/成本在每次调用前校验；DSH 事件流实时累计 usage，超单任务上限即中止；Claude 使用返回值统计。

## 7. Git / GitHub 流程

- 每个运行创建 `wb/plan-<runShort>` 计划分支（从项目默认分支创建）。
- 每个任务创建 `wb/r<runShort>/t<seq>` 分支与独立 worktree；任务通过后提交并 fast-forward 计划分支。
- 运行全部任务通过后：
  - 有 `GITHUB_TOKEN` 且项目允许发布 → 推送计划分支，创建 **草稿 PR**（base=默认分支），轮询该 commit 的 GitHub Actions 结果并展示；
  - 没有远端 → 可自动创建私有仓库（`GITHUB_AUTO_CREATE_REPO`）；
  - 缺少授权/策略关闭 → 写入 `actions` 表 `blocked` 状态与原因，界面显示"待授权"，不伪造成功。
- **永不调用合并接口**；PR 需人工审核合并。

## 8. 权限与安全

- 绑定 `127.0.0.1`，无鉴权（本机工具）；密钥不进入 API 响应，事件/日志统一脱敏。
- protected paths：默认 `acceptance/**`、`.github/**`，项目可追加 `tests/**`、`package.json` 等；Agent 修改后工作台会还原文件、记录 `protected_path_violation` 事件并使该次尝试失败。
- 测试必须真实执行：无测试命令直接阻塞；测试退出码非 0 不进入审计。
- 预算与重试上限为硬约束；所有外部动作（推送/PR/CI）有策略开关与审计记录。
- Claude Code 使用隔离 `CLAUDE_CONFIG_DIR`，不污染用户配置；DSH 使用工作台私有 `DSH_HOME`。

## 9. 扩展点

- **新增 Coding Agent**：实现 `src/agents/<name>.js` 的 `check(config)` 与 `run(ctx)`，注册到 `src/agents/index.js`；或直接使用 `custom` 适配器（`CUSTOM_AGENT_BIN` + 命令模板），约定输出 JSON。
- **新增 LLM 供应商**：`src/llm.js` 增加 provider 规格（OpenAI 兼容或 Anthropic 兼容），审计/规划配置即可切换。
- **任务级 DAG**：`tasks` 表已有 `seq`/`plan_id`，扩展 `depends_on` 与调度即可；当前同一计划内顺序执行以保证依赖正确。
- **事件外发**：`src/bus.js` 发布订阅可接 Webhook / IM 通知。
