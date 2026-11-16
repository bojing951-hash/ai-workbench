# v3.2 条款级验收矩阵

## P0-1 两级验收

| 条款 | 要求 | 证据 | 状态 |
|---|---|---|---|
| 1 | 产品证据可跨 Run 累计，但绑定最终代码 | `productAcceptanceAudit` 使用 history base→最终 planHead diff；`v32-product-gate` | PASS（离线） |
| 2 | 历史 PASS 不能自动证明当前 Commit | 最终 commit 重新审计；修改 A 测试失败 | PASS |
| 3 | 任务完成不能因其它计划功能未实现而无限修复当前任务 | Loop Run 标记 loopId，finalize 只任务级；产品 gate 生成后续产品修复任务 | PASS |
| 4 | 只有真正任务缺陷生成任务修复 | 任务 fail → 原 runTask/auto-repair；产品 gate 单独 productAcceptanceRepair | PASS |
| 5 | 产品缺失交给后续开发任务 | productGate 队列 productAcceptanceRepair，由 Loop 下一轮执行 | PASS |
| 6 | Planner no_task 触发产品验收 | 注入 Planner 测试：3 次 task + no_task → product gate PASS | PASS（离线模拟） |
| 7 | max_rounds 未通过安全 BLOCKED | max 分支 productGate 不通过 → blocked | PASS |
| 8 | 质量/审计/验收绑定 Git SHA | 产品 audit evidenceHash=planHead；diff 基于 base→planHead | PASS |
| 9 | 冻结契约不可修改 | contract baseline / protected paths 既有测试 | PASS |
| 10 | 测试数量不能宣告产品完成 | 完成由产品 audit/质量 gate，不是测试数 | PASS |

三阶段测试文件：`tests/v32-product-gate.test.js`
- A→B→C 正向：loop completed，最终 run awaiting_acceptance，productAcceptance PASS。
- 缺失 B：不 completed，product_repair_count≥1，queue 有 Product Acceptance 修复任务。
- 修改 A：最终 productAcceptance 不 PASS，产品修复队列。
- Planner no_task：plannerCalls=4，loop completed。

## P0-2 预算预留

| 条款 | 要求 | 证据 | 状态 |
|---|---|---|---|
| 1 | 新预留/重试均完整原子检查 | reserve released/expired/unknown 同 key 走事务额度检查；400 retry 在余额 100 时拒绝 | PASS |
| 2 | SQLite 事务并发安全 | BEGIN IMMEDIATE；多进程 6k+6k/10k 只 1 成功 | PASS |
| 3 | released/expired 不能无检查重占 | 已测 released retry 拒绝；expired→unknown | PASS |
| 4 | settled 不重复付费 | settled 同 key 返回 existing，无新行 | PASS |
| 5 | 预留与调用 ID 关联 | requestKey/sourceId，listModelReservations | PASS |
| 6 | 未知用量不能当零成本 | unknown 状态、估算额度仍占用 | PASS |
| 7 | 过期不能自动证明没费用 | reserved TTL 到期转 unknown | PASS |
| 8 | GLM 逐调用实际身份 | resolveLlmIdentity + glmConfigured；unknown 不豁免 | PASS |
| 9 | 不按 Provider 聚合推断豁免 | reserve SQL 以 provider/known 判定，非聚合所有 | PASS |
| 10 | DSH 专项不转全局 | reserve SQL 排除 budget_scope=project_audit；测试 | PASS |
| 11 | 不修改授权上限 | 未改 env/预算 | PASS |
| 12 | 预留/结算/释放/异常可审计 | model_reservations + llm_usage + 状态 | PASS |

## 回归

- 串行全量：**296 tests / 292 pass / 4 skipped / 0 fail**
  - skip：最终环境 Docker/symlink 能力不可用；Docker 可用时同套件曾 289/289（v3.1）。
- Playwright：15/15，page errors 0。
- 真实 E2E：**BLOCKED**。
- 24H：**NOT_VERIFIED**。
