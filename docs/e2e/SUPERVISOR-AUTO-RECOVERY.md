# 独立 Supervisor 自动重启验收（v3.5）

测试：`tests/v35-supervisor-auto-restart.test.js`
结果：**PASS**

真实执行：

- 真的独立 Supervisor 进程：`supervisor/workbench-supervisor.mjs`；
- Supervisor 启 Workbench、独立 SQLite/Data/Project 目录、真实 Git 仓库、真实 Git Worktree；
- 零付费 custom Coding Agent 在 Worktree 写真实未提交文件；
- 对 **Workbench 子进程**（非 Supervisor）执行 SIGKILL；
- Supervisor 记录 `process-exit`，指数退避后自动重启 Workbench；
- 启动恢复保留 Run/Task/Worktree/Session/Checkpoint；
- 原 Agent 继续编码、真实测试命令执行、mock 独立审计（零厂商费用）、Git Commit；
- 最终 `awaiting_acceptance`；
- Supervisor state 记录 `crashes`、`restarts`、`recoveries`；
- 不重复 Run/Task。

日志证据：
- `demo/evidence/e2e-safety/tests.log`（341/341/0）
- 测试 stdout 包含 Supervisor 启动/崩溃/计划重启/重启完成。

限制：
- 当前自动化覆盖 **Coding 阶段**。
- Testing、Auditing、Committing 阶段的 Supervisor 故障注入仍未单独自动化；标记 UNKNOWN，不冒充 PASS。
