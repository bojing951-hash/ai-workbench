# P0 安全收口与最终验收（2026-11-17）

基线：`672a117`。本轮只做工程收口，不执行新的付费 E2E。

## P0-1 预算安全

已修复/验证：
- 原子预留（`BEGIN IMMEDIATE`）；
- deadline / calls / per-call / total / GLM / DSH / non-GLM / stop-loss 前置检查；
- 实际结算超过实验上限后置 `overspent`，后续调用被拒绝；
- UNKNOWN 继续占额；
- 重复 requestKey 不重复计费；
- Coding 预留改为 `max(12k, perTaskTokens)`，实验内按剩余额度保守预留；
- `overspent/stop_loss_reached` 不会被成功收尾覆盖为 `completed`。

零付费测试：`tests/v35-budget-safety.test.js` 5/5 PASS。

**残余风险（不虚报硬封顶）：** Claude Code 只能调用后结算；单次调用可能先超过 per-task/实验额度，然后才被 settle 阻断。历史 `exp_mwkohd4momlwqc` 因此超限（1,940,000/¥22.65 → 2,856,734/¥25.4897）。最终 `BUDGET_SAFETY` 仍必须标记 **FAIL / 不保证绝对硬上限**。

## P0-2 真实产品测试执行

- 容器内隐藏契约测试改为 `node`，不使用宿主 nvm 绝对路径；
- 动态 `require(path.join(...))` 产品入口识别；
- 测试失败证据返回 productTestFiles；
- `runProjectTest` 可信运行器回退，并记录 `test_command_fallback` 事件（runId/taskId 已修复）；
- 原 npm test 在容器内可失败，但可信 runner 真实执行产品测试并通过。

测试：`tests/v35-test-command-portability.test.js` 3/3 PASS；真实 Docker 容器测试 8/8 PASS。

## P0-3 产品闭环

- 既有 auto repair / audit / commit / acceptance 测试全量通过；
- 第二次失败产品离线夹具 27/27 PASS；修复产品 25/25 PASS；
- 未用外部 Harness 修改产品。

## P1 故障恢复

- 独立 Supervisor 自动重启 + Coding 阶段恢复：PASS（`tests/v35-supervisor-auto-restart.test.js`）。
- Testing/Auditing/Committing 阶段 Supervisor 故障注入：UNKNOWN（未完成）。
- Commit 后崩溃的幂等恢复、宿主 Agent 孤儿进程清理：剩余 P1，披露。
- Docker/Fencing：8/8 真实 Docker PASS；Checkpoint：PASS。

## 结论

`ENGINEERING_FREEZE_BLOCKED`：预算无法保证硬上限，且真实 E2E 仍为 FAILED / 历史 OVERSPENT。  
不宣布 `ENGINEERING_READY_FOR_REAL_E2E`。
