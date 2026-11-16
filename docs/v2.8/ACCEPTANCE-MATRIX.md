# v2.8 整改验收矩阵

| 编号 | 要求 | 状态 | 证据/说明 |
|---|---|---|---|
| P0-1 | 自动化规划→编码→审计 FAIL→自动修复→复验 | **IMPLEMENTED + TESTED（离线）** | `LoopManager.maybeAutoRepair` + `Orchestrator.prepareAutoRepair`；`tests/auto-repair.test.js`；真实零人工 E2E **BLOCKED**（无新 DSH 预算） |
| P0-1 | plan/queue 均可自动质量修复 | **IMPLEMENTED + TESTED** | queue 真实历史 CDL 已验证；plan 代码级 `tests/quality-plan-mode.test.js`；真实 plan Agent E2E UNKNOWN |
| P0-1 | 修复任务优先、有界、保留原契约/目标/Git | **PASS（代码/测试）** | repair title `[Auto Repair n/max]`；`auto_repair_max`；原 goal/acceptance/audit evidence 写入 |
| P0-1 | 单次 Run 失败不需人工新建 Run | **IMPLEMENTED + TESTED** | paused run → failed 终态 + auto repair queue；真实 `Orchestrator.startRun` 回归创建新 Run；真实 Agent 新 E2E 仍 BLOCKED |
| P0-2 | pending/requestKey 原子认领 | **PASS** | `tests/loop-recovery.test.js`；`src/db.js claimLoopTask` |
| P0-2 | SIGKILL 后不丢任务/不重复 Run | **PASS（子进程注入）** | `tests/crash-injection.test.js` 2 个真实 SIGKILL 场景 |
| P0-2 | 关键写入/Fencing/控制写 | **PARTIAL** | v2.7 控制 API、loop completeRound/auto-repair 租约、dead/live owner；所有 Git/质量写路径未穷举 |
| P0-3 | 质量命令 Docker 隔离/fail-closed | **PASS（Docker 可用）** | `tests/quality-isolation.test.js`：容器内执行、不泄密钥；Docker 不可用 `CONTAINER_UNAVAILABLE`，无宿主回退 |
| P0-3 | 质量异步/超时/取消/临时清理 | **PASS（代码/测试）** | `quality-isolation` 容器超时/TIMEOUT、取消/ABORTED 测试；临时 env 文件清理既有路径 |
| P1-1 | 契约自动生成条款计划 | **IMPLEMENTED + TESTED** | `deriveClausePlan`；`tests/contract-plan.test.js`；createProject 自动生成 |
| P1-1 | 子条款独立 PASS 证据/缺证据 UNKNOWN | **PASS** | `tests/quality.test.js` clause 5/4 场景；matrix `clauses` |
| P1-1 | 条款级检查执行/自动生成额外测试 | **PARTIAL/UNKNOWN** | 质量命令仍由项目提供；未自动生成可执行测试 |
| P1-1 | 每 PASS 绑定命令/Run/Commit/产物 | **PARTIAL** | quality matrix `binding` 有 command/runId/commit/isolation；audits 表仍缺直接 commit 字段 |
| P1-2 | Agent 超时/max turns 自动恢复 | **PASS（已有+自动修复）** | v2.7 fallback；本轮 auto repair |
| P1-2 | 依赖缺失/test exit127 自动恢复 | **IMPLEMENTED + TESTED** | `test_setup_command` 自动一次重试；`tests/test-setup-recovery.test.js` |
| P1-2 | 审计 timeout/UNKNOWN 自动重试 | **IMPLEMENTED + TESTED** | auto verification retry；`tests/auto-repair.test.js` |
| P1-2 | 有界重试/失败现场/BLOCKED | **PASS（代码）** | auto_retry_max、auto_repair_max；达到上限暂停并保留 |
| 真实零人工 E2E | 新隔离项目实际跑通 | **BLOCKED** | 无新的独立 DSH 预算/授权；不能挪用 CDL/Reading Queue；未伪造 |
| 24h | 真实长窗口 | **NOT_VERIFIED** | 未执行，不制造无意义任务 |
