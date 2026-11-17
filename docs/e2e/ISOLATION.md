# 隔离执行环境验收

## 当前结果：BLOCKED

检查时间：2026-11-17T00:47Z

- `docker` 命令：**不存在**；
- `podman` / `colima` / `nerdctl` / `lima`：**不存在**；
- Docker Desktop/OrbStack 应用：不完整/不可用；
- `ai-workbench-runtime:2.2` 镜像：不可用；
- 容器测试执行：false；
- 容器 Agent 执行：false。

## 代码侧安全行为

- E2E 实验契约 `isolation_mode=DOCKER_REQUIRED` 时，`startRun` 在规划/模型调用前检查 Docker；不可用直接 `EXPERIMENT_ISOLATION_BLOCKED`；
- `isolation_mode=BLOCKED_UNLESS_APPROVED` 直接拒绝；
- `LOCAL_APPROVED` 也被拒绝：本地测试进程与 Workbench 同用户、同文件系统，不能阻止读取宿主文件，不满足 E2E 安全边界；
- 不静默降级到普通宿主执行；
- 现有普通项目不受影响。

## 结论

真实 E2E 必须在 Docker/容器隔离恢复后才能执行。当前 **BLOCKED**，不得用本地执行替代并宣称 E2E PASS。
