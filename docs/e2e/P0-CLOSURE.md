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

## 追加：P0 最终 fail-closed 收口

- 实验内真实 Claude Code/GLM 默认 **fail-closed**：`ALLOW_UNBOUNDED_PROVIDER_RISK` 未显式设置为 true 时，拒绝启动无调用中硬 Token 限额的调用，返回 `BUDGET_RISK_UNBOUNDED`。
- 显式允许风险必须由用户重新授权；这不是硬上限，只是把“无法保证调用在授权风险内结束”的配置标为 BLOCKED。
- Coding 预留改为 `max(12k, perTaskTokens)`；`overspent/stop_loss_reached` 不会被 completed 覆盖。
- 测试回退只允许 `runner_compatibility`，产品断言失败/混合 FAIL/遗漏测试文件/隐藏契约 FAIL 全部保持失败（负向 B/C/D/F）。
- 最终全量：**355 tests / 355 pass / 0 skipped / 0 fail**。

残余 P1：Supervisor Testing/Auditing/Committing 注入、Commit 后崩溃幂等恢复、宿主 Agent 孤儿进程清理仍未完全验证。

## 最终收口（2026-11-18）

### 预算风险准入
- 所有真实付费 Coding Provider 统一检查 `providerHasExecutableCostLimit`；
- 无调用中可执行硬边界时，必须存在冻结实验契约 `provider_json.risk.unbounded` 中精确匹配 client/provider/model 的用户风险许可；
- 许可包含 acceptedBy/acceptedAt/reason，且被契约哈希绑定；
- 环境变量 `ALLOW_UNBOUNDED_PROVIDER_RISK` 已移除，不能再单独绕过；
- 默认真实 Claude/GLM/OpenAI/DeepSeek Coding：BLOCKED；
- 风险许可不改变“无绝对硬上限”的事实。

### Docker 清理失败
- inspect 非零且无明确 `No such container/object` → `CONTAINER_CLEANUP_UNCONFIRMED`；
- 清理失败进入 `failed[]`，不再混入 `skipped[]`；
- Workbench 启动时发现 failed/error → 拒绝启动和恢复，保持 BLOCKED；
- 真实 Docker 有效/孤儿/失败分类测试通过。

### 测试误放行
- 仅“测试入口/目录/命令不存在”类结构错误可回退；
- 产品断言失败、混合 pass/fail、文件遗漏、隐藏契约失败、含 lint/build 强制阶段全部禁止回退；
- 回退不得跳过原 package.json test 的 lint/build/typecheck 等阶段；
- 原始退出码/stdout/stderr、文件清单、命令完整保留。

最终全量：**355 tests / 355 pass / 0 skipped / 0 fail**。
