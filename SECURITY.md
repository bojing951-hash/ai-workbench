# 安全策略

## 重要：这是一个会执行命令的自动化工具

AI 开发工作台会调用 Coding Agent（DeepSeek Harness headless / Claude Code / 自定义命令）在你的机器上
读取代码、修改文件、运行测试命令，并可能按你的配置执行 Git 推送与 GitHub API 调用。请把它当作
**能够执行任意命令的本地开发工具**，而不是纯网页应用。

### 运行前必须遵守

1. **只在受信任的仓库和机器上运行**。不要把它指向生产环境、包含生产密钥的目录或你不了解的项目。
2. **优先使用隔离环境**：容器 / 虚拟机 / 专用用户 + 受限目录。工作台默认只监听 `127.0.0.1`，但没有登录鉴权，
   不要把它直接暴露到公网或共享网络。
3. **权限模式尽量收窄**：`DSH_PERMISSION_MODE=workspace-write`（需要宿主机 sandbox 可用）。
   嵌套沙箱或受限环境可能必须使用 `danger-full-access`，此时 Agent 拥有接近当前用户的权限，请务必隔离。
4. **GitHub Token 最小权限**：Classic PAT 仅勾选 `repo` + `workflow`；Fine-grained PAT 仅授予目标仓库
   `Contents`（读写）、`Pull requests`（读写）、`Actions`（读）。工作台**不会合并主分支**，合并需人工完成。
5. **保护验收标准**：把测试/验收文件加入项目的 protected paths，避免 Agent 通过修改测试来“通过”。
6. **预算与模型成本**：设置 `MAX_TOTAL_TOKENS` / `MAX_COST_CNY`，避免误触发大量付费调用。
7. **不要提交密钥**：`.env` 已被 gitignore；`data/`、`projects/` 也已被忽略。提交前运行
   `git grep -nE "sk-|ghp_|github_pat_|Bearer "` 自检。

## 工作台的既有安全边界

- 只监听回环地址；密钥仅存本机 `.env`/环境变量，事件、日志、前端 API 响应均做脱敏。
- 永不调用 GitHub 合并接口；PR 以 draft 创建。
- 审计失败/不可用时任务阻塞，不会伪造通过。
- 预算与尝试次数为硬上限，超限自动暂停。
- Claude Code 使用隔离 `CLAUDE_CONFIG_DIR`，不写入用户全局配置；DSH 使用私有 `DSH_HOME`。
- protected paths 变更会被还原并记录事件。

## 已知风险（使用前理解）

- Coding Agent 在 `danger-full-access` 模式下可执行任意命令、访问网络；工作台无法在进程层面完全约束它。
- 模型可能做出错误或破坏性修改；工作台通过独立审计与人工验收降低风险，但**不能替代代码审查**。
- GitHub Actions 工作流与第三方 Action 的安全由你选择的 Action 版本决定。
- 本工具不提供租户隔离/多用户隔离，未按多租户服务设计。

## 报告安全问题

请**不要**在公开 Issue 中披露可被利用的漏洞细节，使用 GitHub 仓库的
**Security → Report a vulnerability**（Private vulnerability reporting）提交。
维护者会尽快回复并协调修复与披露时间。

请尽量提供：受影响版本、复现步骤、影响范围、是否需要特定配置。
