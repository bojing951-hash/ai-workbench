# v2.8 自主研发闭环整改工程审计

- 基线：v2.7.0 / PR #9 / commit `7af6d9a`
- 依据：CDL v0.2 实际 SQLite/Events/Attempts/Audits/Git 记录；用户引用的 `CDL_v0.2_independent_audit_2026-11-16.md` 在本机工作区不存在，未伪造其内容
- 范围：只改 Workbench；未改 CDL/A/B/Reading Queue 产品代码
- 当前状态：**部分验收完成**；真实零人工 E2E **BLOCKED**（无新独立 DSH 预算授权）；24h **NOT_VERIFIED**

## 复盘结论（详见 CDL-V0.2-FORENSICS.md）

1. CDL-5 失败由 **Agent timeout/max_turns + worktree 缺依赖 test exit127 + DSH audit UNKNOWN/FAIL** 叠加；不是单一产品缺陷。
2. CDL-6/CDL-7 需要外部创建，因为 `LoopManager.tick` 在 run paused 后只暂停 loop，不生成修复任务；`retryVerification` 只有人工入口。
3. `vitest: command not found` 根因：worktree 没有 `node_modules`，test command 未包含依赖准备，Workbench 未区分环境失败。
4. DSH UNKNOWN 没有自动重试验证；外部手动 retryVerification 后才得到 FAIL/PASS。
5. 质量脚本由外部编写，因为 quality plan 要求预先配置 requirements/quality_command，缺少契约解析/检查计划生成。
6. 质量矩阵只到 Requirement 级，acceptance 子条款未逐条验证，5/5 可掩盖条款缺口。
7. 早期审计记录缺少 audits 表直接 commit 字段；最终 PASS 有 `audit_commit_created`，但复核需跨 task/run 表。

## 本轮整改

| ID | 修复 | 源码 | 测试 |
|---|---|---|---|
| P0-1 | paused run 自动生成有证据修复任务；保存 Agent 产物为 repair baseline；自动更新项目默认分支；修复任务优先；`auto_repair_max` 有界；原 goal/acceptance/audit evidence 保留；plan/queue 都支持 | `src/loop.js maybeAutoRepair/buildRepair`、`src/orchestrator.js prepareAutoRepair`、DB auto_repair_count | `tests/auto-repair.test.js` |
| P0-1 | 单次 Run 失败无需人工新建 Run | 同上；失败任务不再只 `loop_paused` | `tests/auto-repair.test.js`、`tests/quality-plan-mode.test.js` |
| P0-2 | 任务先在 loop.pending_task_json 持久化，startRun 带唯一 requestKey；Run 创建成功后 `claimLoopTask` 原子移除队列/清 pending/绑定 Run；崩溃恢复按 requestKey 绑定已有 Run 或恢复队列 | `src/db.js` request_key 唯一索引、pending/claim/recover；`src/loop.js` tick/recover；`src/orchestrator.js` startRun requestKey | `tests/loop-recovery.test.js`、`tests/crash-injection.test.js`（真实子进程 SIGKILL） |
| P0-3 | 质量命令默认 Docker 隔离；Docker/镜像不可用 CONTAINER_UNAVAILABLE fail-closed，绝不回退宿主 shell；host 模式必须显式 `host_isolation_acknowledged`（仅测试/受信夹具）；异步、超时、取消、临时清理 | `src/quality.js`、`src/container.js` mounts | `tests/quality-isolation.test.js`（Docker 不可用 fail-closed、容器成功、host 未授权拒绝） |
| P1-1 | quality result 的 `criteria` 映射到每个 acceptance clause；每 clause 独立 status/evidence；`require_clause_evidence` 默认 true；缺条款证据 Requirement 降 UNKNOWN；coverage 统计 clauses；quality binding 记录 command/runId/commit/isolation | `src/quality.js buildCoverageMatrix/deriveClausePlan`；`src/orchestrator.js createProject` | `tests/quality.test.js`、`tests/contract-plan.test.js` |
| P1-2 | 审计 UNKNOWN（timeout）自动 `retryVerification` 优先于代码修复；有界 `auto_verification_retry_max`；test exit127 时执行显式 `test_setup_command` 并重试一次；Agent fallback 已有 | `src/loop.js`、`src/orchestrator.js runProjectTest` | `tests/auto-repair.test.js`、`tests/test-setup-recovery.test.js` |
| 可靠性 | auto repair/loop completeRound 写租约；startRun requestKey 唯一索引防跨进程重复；活/死 owner 租约恢复保持 v2.7 行为 | `src/loop.js`、`src/db.js` | 全量 + crash injection |

## 仍然未完成

- **真实零人工产品 E2E：BLOCKED**。新隔离项目需要新的独立 DSH 审计预算/授权；CDL、Reading Queue 的专项预算均不能挪用；当前未获新授权。
- **active task SIGKILL 在真实 Agent 执行中**：本轮只做真实子进程 SIGKILL 的任务认领窗口注入；没有用无预算 Agent/审计伪造 E2E。
- **所有 Git/质量写路径的穷举 Fencing**：控制 API、loop 写入、auto repair 已覆盖；完整穷举仍 UNKNOWN。
- **P1-1 自动生成“可执行测试”**：已支持契约→条款计划；质量命令仍由受信项目配置/外部检查器提供。自动生成可执行测试并运行仍 UNKNOWN。
- **audits 表直接 commit/tree 绑定**：quality binding 有 commit；审计表字段仍缺，UNKNOWN。
- **24h**：NOT_VERIFIED。

## 源码定位

- `src/loop.js`：`tick` paused 分支、`maybeAutoRepair`、`recover`、pending 选择、`claimLoopTask` 调用。
- `src/db.js`：loops `pending_task_json/auto_repair_count/auto_retry_count`、runs `request_key` 唯一索引、`claimLoopTask/recoverLoopPending/increment*`。
- `src/orchestrator.js`：`startRun requestKey`、`prepareAutoRepair`、`runProjectTest test_setup_command`、`createProject deriveClausePlan`。
- `src/quality.js`：Docker fail-closed、host acknowledgment、clause matrix、binding、`deriveClausePlan`。
- `src/container.js`：质量容器 mounts 支持。
