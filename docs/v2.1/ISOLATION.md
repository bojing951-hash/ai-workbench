# 执行隔离验收（v2.1）

## 结论

| 能力 | 状态 | 证据 |
|---|---|---|
| 独立 HOME/TMPDIR（不在 Git 仓库内） | PASS | `src/security.js tmpHomeFor`；测试环境曾因 TMPDIR 位于仓库内误判，已修复 |
| 测试/Agent 最小环境变量 | PASS | `buildTestEnv`/`buildAgentEnv`；41 项安全测试 |
| Agent 工具白名单/权限 fail-closed | PASS | Claude acceptEdits+Read/Write/Edit/Glob/Grep/LS；DSH workspace-write；危险模式需显式开关 |
| 测试命令 allowlist、工作副本/产物边界 | PASS | `assertSafeTestCommand`、realpath/symlink 检查 |
| 每项目/运行独立 worktree、独立分支 | PASS | 每次 run 独立 worktree；多项目独立目录 |
| 真正 Docker 容器隔离 | BLOCKED（本机） | `docker info` 返回 daemon 不可用（socket 不存在）；未拉取/启动容器 |
| macOS `sandbox-exec` | BLOCKED（本机） | 嵌套运行环境中不可用；未使用 danger-full-access 绕过 |
| 内核级文件/网络隔离 | BLOCKED | 无容器/sandbox；受限运行环境只能降低风险，不能宣称强隔离 |

## 策略

- `isolation.mode`：`restricted`（默认）/ `docker` / `require_kernel` / `sandbox-exec`。
- 项目声明 `isolation_mode=docker|require_kernel|sandbox-exec` 而对应能力不可用时，在启动 Agent/测试前 **fail-closed 阻塞**（`ISOLATION_UNAVAILABLE`），不会自动提升权限。
- `GET /api/isolation` 返回 Docker/sandbox 探测结果、内核隔离能力和每个项目的隔离模式。
- 所有验证报告中，`restricted` 运行的结论只能写"受限运行环境"，不得冒充强隔离。

## 后续

在具备 Docker daemon 的宿主机上，可把项目 `isolation_mode` 设为 `docker` 并配置 `ISOLATION_TEST_IMAGE`，工作台会在隔离条件满足后放行；当前环境保持 BLOCKED。
