# E2E 安全控制独立审查

审查者：`v34-reviewer`（只读；未改文件、未重启生产、未发起模型调用）。

## 最终结论

**当前工作树无剩余 P0/P1。** 重点测试 11/11 PASS；全量 317 tests / 313 pass / 4 skipped / 0 fail。

## 审查发现及修复

1. **P0：GLM Coding 完全绕过实验上限**
   - 修复：`!agentIdentity.exempt || codingExperimentId`；实验内 GLM Coding 仍原子预留，按 `glm` scope 计入调用/Token/费用/GLM 分项。
   - 修复后独立验证 `experimentUsage.calls/byScope.glm` 增长。
2. **P0：settle 越线后 contract 不再被解析，停止失效**
   - 修复：`getExperimentForProject/Conversation` 包含 `stop_loss_reached/overspent`；后续 reserve/preflight/isolation 继续拒绝；新增测试。
3. **P0：DOCKER_REQUIRED 要求 `container`，执行器只认 `docker`**
   - 修复：门禁改为 `agent_isolation=docker && test_isolation=docker`；新增 helper 对齐测试；Docker 不可用时仍 fail-closed。
4. **P1：GLM Audit/Product 被强制 global scope，绕过 GLM 子上限**
   - 修复：`experimentScopeForProvider`；GLM audit 用 glm scope，DSH 用 dsh。
5. **P1：隔离门只在 startRun**
   - 修复：Loop Planner 前、resumeRun、retryVerification、recover 经 resume 均有隔离门。
6. **P1：授权可被直接 DB API 伪造**
   - 部分修复：TTY + 终端逐字确认 + `authorization_source=user_cli_tty` + 正数限制/合法 deadline；仍非密码学用户签名，需操作员核对契约。此残余已诚实记录。

## 残余 P2

- 精确剩余为 0 时编码 Agent 的 perTaskTokens=0（Claude 仅在完成后检查，可能先超一次再 settle→stop）；
- 无 contract end API/脚本；
- 多个 active conversation 契约未做唯一约束；
- 授权 TTY 可被本地 PTY 包装伪造（操作员核对为准）。
