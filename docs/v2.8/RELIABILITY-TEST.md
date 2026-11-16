# v2.8 可靠性/故障注入测试

## 全量

- `npm test`：**256/256 PASS**（本轮最后代码变更后；最终测试数量以提交前的日志为准）。
- 日志：`demo/evidence/v2.8/tests-full.log`。

## 1. 真实子进程 SIGKILL（P0-2）

`tests/crash-injection.test.js` 启动独立 Node 子进程，子进程写入 loop.pending_task_json：

1. **startRun 前 SIGKILL**：子进程写 pending 后被杀；父进程重开 SQLite，`recoverLoopPending` 把任务放回队列。
2. **startRun 后 SIGKILL**：子进程写 pending + 创建带 requestKey 的 Run 后被杀；父进程恢复按 requestKey 绑定同一 Run，队列工单移除，不重复创建。

日志：`demo/evidence/v2.8/crash-injection.log`（2/2 pass）。

## 2. 质量隔离（P0-3）

`tests/quality-isolation.test.js`：

- Docker daemon 不可用时：`CONTAINER_UNAVAILABLE`，`ok:false`，不执行宿主质量命令；
- Docker 镜像可用时：质量命令在容器内运行，宿主 `DEEPSEEK_API_KEY` 不泄漏，network none/只读 rootfs/cap-drop 由现有容器策略提供；
- 显式 `isolation:host` 但无 `host_isolation_acknowledged`：`HOST_QUALITY_FORBIDDEN` fail-closed。

日志：`demo/evidence/v2.8/quality-isolation.log`（3/3，容器用例在 Docker 可用时执行）。

## 3. 自动修复（P0-1）

`tests/auto-repair.test.js`：

- audit FAIL + failed task + failed worktree + audit requiredFixes → 自动生成 `[Auto Repair n/max]` 任务，保留原 goal/acceptance/失败证据，loop 回到 running、current_run_id 清空；
- audit UNKNOWN → 优先自动 retryVerification，不生成产品代码修复任务；
- 达到 `auto_repair_max` → 返回 false，保留 BLOCKED 现场。

## 4. 工程故障恢复（P1-2）

`tests/test-setup-recovery.test.js`：test command exit=127 → 执行显式 `test_setup_command` 后重试一次，成功；失败时保留 setup 日志/错误。

## 5. 历史 Fencing 回归

v2.7 的 store/双 Orchestrator/双 HTTP 进程、控制 API 所有权、dead/live owner 恢复测试保持通过；本轮 auto repair/loop 质量写增加租约保护。全量套件包含。

## 限制

- 没有在新的真实 Coding Agent + 独立 DSH 审计中做 SIGKILL 注入：新项目无独立审计授权，不能伪造 E2E。
- 没有穷举所有 Git/质量写入路径；只覆盖已列路径。
