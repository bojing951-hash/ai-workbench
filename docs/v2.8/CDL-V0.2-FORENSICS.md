# CDL v0.2 真实运行复盘（基于 SQLite/Events/Attempts/Audits/Git，不以报告代替记录）

> 用户引用的 `CDL_v0.2_independent_audit_2026-11-16.md` 在当前工作区不存在（`find` 未找到）；本轮不复述不可读取的外部文本，以下结论全部来自实际数据库、原始事件、Attempt/Audit 记录、Git 和测试日志。若需要与该审计文件逐条对齐，需提供文件本体。

## 1. CDL-5 为什么失败？

实际三类失败叠加：

1. **Coding Agent 预算/轮次失败**：`attempt` 记录显示 `agent_timeout`（10min）后自动新会话，随后两次 `error_max_turns`；每个失败会话仍产生高额 GLM 成本（¥13.81、¥13.32、¥10.21）。这不是产品缺陷，而是 Agent 执行边界问题。
2. **执行环境失败**：测试命令最终 `exit=127`，日志为 `sh: vitest: command not found`。Worktree 没有安装 `node_modules`，而项目 test command 配置为 `PLAYWRIGHT... npm test`，未包含依赖准备。Workbench 没有区分“依赖缺失/环境失败”和“产品测试失败”。
3. **独立审计失败**：第一次 DSH 审计 `UNKNOWN`（`DSH 审计超时`），第二次 `FAIL 82`（真实产品质量问题：缺 v0.2 浏览器覆盖、储蓄/稳定性缺失仍可 buy、移动端 badge、清除数据范围）。

失败后 `task_failed` → `run_paused` → `loop_paused`；没有自动修复任务，也没有自动重试验证。

## 2. 为什么需要人工组织 CDL-6/CDL-7？

关键事件：

- `2026-11-16T08:45:08Z task_failed`：任务失败、attempt 耗尽。
- `08:45:12Z loop_paused`：`src/loop.js` 的 paused 分支只把 loop 状态置为 paused，不创建修复任务。
- `09:01:48Z run_cancelled / loop_cancelled`：外部工程师手动取消原 loop。
- `09:02:01Z loop_created`：外部新建 CDL-6 loop，手写完整审计修复任务。
- `09:36:45Z loop_created`：外部再次新建 CDL-7 loop，手写 P2 修复任务。

根因：`LoopManager.tick` 没有“有证据失败 → 自动修复任务”的状态迁移；`Orchestrator.retryVerification` 只有人工 API 调用，任务失败后 loop 直接暂停。外部工程师变成了“新 Loop/新提示词调度器”。

## 3. 为什么 `vitest: command not found`？

- `data/worktrees/.../task-1` 没有 `node_modules`；Workbench 创建 worktree 时只签出 Git 文件，不执行依赖安装。
- 项目的 test command 是 `PLAYWRIGHT_BROWSERS_PATH=... npm test`，没有 `npm ci`；此前项目主路径有 `node_modules`，所以人类手工测试能过，worktree 不能。
- Workbench `runProjectTest` 直接执行 test command，未区分 `exit=127/command not found` 这类基础设施失败，也没有 `test_setup_command` 自动恢复。
- 直到外部把 test command 改为 `npm ci ... && ... npm test` 后，`test_passed`。

## 4. 为什么 DSH UNKNOWN 后不能稳定自主恢复？

- 第一次审计 `aud_...` 的 `verification_status=UNKNOWN`，summary=`DSH 审计超时`，`required_fixes=['DSH 审计无法完成：DSH 审计超时']`；这不是产品缺陷，但 `runTask` 失败路径返回 blocked，任务/运行进入 paused。
- `retryVerification` 存在且能重跑测试+审计，但没有被 Loop 自动调用；外部在 08:46:54、08:54:58 两次手工 `verification_retry_started`，第二次才得到 FAIL 82。
- 审计 timeout 配置当时是 900s，后来外部调大到 1800s；Workbench 没有“审计超时 → 退避重试/预算检查/升级 BLOCKED”的自动策略。

## 5. 为什么质量脚本需要外部准备？

- `src/quality.js qualityConfig` 要求项目配置已有 `quality_command` + requirements；项目创建时不会从冻结契约生成检查计划。
- CDL v0.2 的 `projects/v0.2/cdl-quality/check.mjs`（真实浏览器检查）由外部验收负责人编写；Workbench 只执行，不生成。
- 因此“质量闭环”机制存在，但质量**验证资产**仍依赖外部工程师。

## 6. 为什么质量矩阵 5/5 PASS 仍有验收条款遗漏？

- 当前 `buildCoverageMatrix` 只按 Requirement ID 合并 `status/evidence`；`requirements[].acceptance` 只是展示字段，没有逐条验证。
- CDL v0.2 品质检查的 R5 evidence 实际只有“390px 移动视口无横向溢出”；`清除后刷新不写回`、`总负债口径` 等子条款未被独立检查覆盖，但 Requirement 仍可 PASS。
- DSH 审计在 PASS 90 时仍发现 `totalDebt`/清除刷新问题，说明质量矩阵的条款覆盖不足。
- 修复：条款级 `criteria` 映射、每个 clause 独立 status/evidence、`require_clause_evidence` 默认开启；缺条款证据的 Requirement 降 UNKNOWN；新增契约 Markdown 自动生成条款计划（`deriveClausePlan`）。

## 7. 为什么部分审计结果没有绑定被测 Commit？

- 实际 PASS 审计事件有 `audit_commit_created`（a81cb6a、1f0c6f52），`task.verification` 也记录 `auditId/auditStatus`；但 `audits` 表本身没有 `commit`/`tree_hash` 字段，审计记录与 commit 只能通过 task/run 间接关联。
- 早期 UNKNOWN/FAIL 审计由 `retryVerification` 触发，事件链中部分缺少显式 `audit_commit_created`（需要以 task head/auditId 反查）。
- 这使审计证据复核需要跨表拼接；本轮在质量矩阵 binding 中补 command/run/commit，但 `audits` 表仍缺直接 commit 字段，作为 UNKNOWN 保留。

## 8. 产品缺陷 vs Workbench 基础设施缺陷

**产品缺陷（CDL）**：
- 储蓄/收入稳定性缺失仍可确定 buy；
- 总负债缺失与 missingInputs 口径矛盾；
- 清除本地数据后刷新写回；
- 移动端职业 badge 破版；
- v0.2 情景对照缺少完整浏览器覆盖。
这些由 DSH/verify 测试和 Agent 修复。

**Workbench 基础设施缺陷**：
- worktree 不装依赖、test command 配置不完整；
- Agent 超时/max turns 后没有跨 Run 的自动修复任务；
- audit timeout/UNKNOWN 没有自动重试；
- quality command/契约计划靠外部编写；
- 质量矩阵只到 Requirement；
- audit 记录未直接绑定 commit；
- loop paused 后需要人工新 Loop/提示词。

## 9. 现有恢复能力盘点

已有：
- Supervisor 独立进程 + 自动重启；
- SQLite 租约/fence、dead/live owner 清理（v2.7）；
- Agent fallback/新会话、attempt 上限；
- `retryVerification`（可复用 worktree 重试测试/审计）；
- Loop queue、质量修复任务、plan/queue 调度；
- run reconciliation（任务/审计/Git 对照）。

缺口/本轮补齐：
- loop pending 认领与 requestKey 幂等；
- paused run 的自动修复任务（P0-1）；
- audit UNKNOWN 自动重试验证（P1-2）；
- quality Docker fail-closed（P0-3）；
- 条款级矩阵与契约计划（P1-1）；
- 测试依赖 setup 自动重试（P1-2）；
- 控制/循环写入租约（v2.7 + 本轮 auto-repair lease）。

## 10. 哪些能力已存在，只需连接/状态迁移？

- **Agent fallback 新会话**：已存在，失败后自动切换；CDL v0.2 实际发生并继续。
- **retryVerification**：已存在，缺 loop 自动调用。
- **quality repair queue**：已存在，缺“从契约自动生成 clauses/check plan”和 Docker 隔离。
- **Supervisor/recovery/reconcile**：已存在，缺 pending 原子认领和 audit 证据显式 commit。
- **audit budget/preflight**：已存在，缺新的独立 E2E 预算授权。

## 原始记录位置

- DB dump：`/tmp/cdl-forensics.json`（本轮生成，源 `data/workbench.db`；原始数据未删除）
- 关键事件：`events` 表 2026-11-16T07:56–09:54Z
- 失败日志：`data/logs/run_mwiyzmqt278011d2/.../attempt-*-test.log`、`attempt-*-claude.log`
- 产品证据：`demo/evidence/cdl-v0.2.0/`（v0.2 验收结果，不冒充本轮 E2E）
