# v2.9 关键可靠性整改

## 1. 质量未 PASS/修复队列未清空不得因 max_rounds 标记 completed

- `src/loop.js qualityGateIncomplete`：存在 quality 配置时，检查最新质量矩阵 `allPass` 与队列是否清空。
- tick 达到 max_rounds、队列为空、completeRound 达到上限均先过质量门；不满足则 `blocked` 并保留检查点，不进入 completed。
- 测试：`tests/loop-quality-gate.test.js`（质量未 PASS 不得 completed；质量 PASS + 队列空才 completed）。

## 2. Run/Plan/Tasks 半创建恢复

- `startRun` 在创建 Run 后若 plan/tasks 抛错，Run 置 failed、释放租约；不再永久占住项目。
- 启动恢复识别 queued 且无 tasks 的半创建 Run：置 failed；pending 恢复把任务放回队列，而不是绑定空 Run。
- `claimLoopTask` 队列移除失败会回滚；`recoverLoopPending` 检查 claim 结果。
- 测试：`tests/loop-recovery.test.js`、`tests/crash-injection.test.js`（真实子进程 SIGKILL 两个窗口）。

## 3. 质量检查必须验证实际被测 Commit

- 质量检查在本轮 `run.result_json.planHead` 创建临时 detached worktree；worktree 创建失败或缺 commit 时直接 blocked，**绝不退回项目主目录**。
- quality branch 使用随机后缀避免旧 branch 冲突；完成后移除 worktree。
- 质量结果 binding 记录 command/runId/commit/isolation。

## 4. Requirement ID 冲突不互相覆盖

- `buildCoverageMatrix` 检测质量命令返回的重复 Requirement ID；冲突需求置 UNKNOWN、P0 conflict issue，`allPass=false`；不允许 Map 后者覆盖前者。
- 测试：`tests/quality.test.js` 冲突用例。

## 5. 自动修复基线/任务/状态迁移可恢复且幂等

- 失败 Run 在生成修复任务前终态化 `failed`，避免下一次 startRun 被 `PROJECT_BUSY` 拒绝。
- 失败任务产物保存为 auto-repair branch，更新项目默认分支；原 goal/acceptance/audit evidence 写入修复任务。
- 同 run 已有 auto repair 任务时不再重复创建；`auto_repair_max` 有界。
- 失败分类：环境/依赖、Agent/审计超时、审计失败、测试失败、Agent 不可用、unknown；授权/预算策略阻塞不生成产品修复任务。
- 测试：`tests/auto-repair.test.js`（含真实 `Orchestrator.startRun` 回归）、`tests/test-setup-recovery.test.js`。

## 6. 质量隔离（继承 v2.8）

- 默认 Docker；Docker/镜像不可用 fail-closed；host 模式必须显式 acknowledgment；容器 network none/只读 rootfs/cap-drop；超时/取消分类。
- 测试：`tests/quality-isolation.test.js`。

## 已知残余

- 全部 Git/质量写路径穷举 Fencing 仍 UNKNOWN。
- 某些基础设施失败（Docker 不可用/预算）在 UI 显示 blocked，但不会自动改产品代码。
- 自动修复任务在真实 Agent 上的完整 E2E 因新项目预算/审计授权不足未验证。
