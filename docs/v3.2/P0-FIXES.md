# v3.2 P0 复现与修复

## P0-1 多阶段研发与最终验收冲突

**复现路径**：Loop 第一轮只实现 A，原 finalizeRun 在单 Run 上检查全部冻结 acceptance，直接 blocked/或永远 repar 当前 A。

**修复**：
- Loop 传入 `loopId`，Run result_json 标记 `loopId`；
- `finalizeRun` 对 loop scope 只做任务级验收；
- `LoopManager.productGate()` 在所有计划任务结束（no_task/空队列/max_rounds/completeRound）调用 `Orchestrator.productAcceptanceAudit`；
- 产品级审计：
  - 从历史 base 到最终 planHead 取真实 diff；
  - 独立审计全部冻结 clauses；
  - 证据绑定最终 planHead/evidenceHash；
  - 历史 task audit 只作累积，不替代最终 commit 审计。
- 缺失 -> 产品验收修复任务（`productAcceptanceRepair`），最多 2 次；max_rounds/失败 -> BLOCKED。
- `acceptRun` 对 Loop task-level Run 拒绝；productAcceptance PASS 才允许。
- 测试覆盖：
  - A→B→C 正常完成；
  - 缺失 B 拒绝交付并生成产品修复；
  - 修改 A 后历史 PASS 不成立；
  - 注入 Planner no_task 触发产品验收。
- 真实模型未执行，测试中 fake Planner/Agent/Auditor 已明确标注。

## P0-2 预算预留重试绕过与未知费用

**复现路径**：
- reserve released requestKey 直接重新 update 而不做额度检查；
- unknown/expired 被当 0 释放；
- Provider 聚合可能错误豁免未知调用。

**修复**：
- `reserveModelBudget` 对 reserved/settled 返回既有；released/expired/unknown 同 key 进入完整事务检查后才更新；
- 过期 reserved 转 `unknown`，不再自动释放；
- `reservedBudgetTotals` 统计 reserved+unknown；
- `settleModelReservation` 未知用量保持 `unknown`；
- Chat/Planner/Coding/Audit 失败调用 `markModelReservationUnknown`，不是 release；
- requestKey 唯一，settled 重放不新增；
- DSH project_audit 从全局预留 SQL 排除；
- GLM 逐次 `resolveLlmIdentity`，unknown 不豁免；
- 不修改预算上限。
- 测试：`tests/v3-budget-reservation.test.js` 7 个场景 + 多进程。
