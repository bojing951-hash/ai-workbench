# AI Workbench v3.3 — 最终预算整改与 E2E 验收准备

基线：v3.2.0 / Draft PR #14。分支：`v3.3.0`。停止功能扩张，只修复预算 P0 与补齐最终验收测试。

## P0-1 GLM 混合身份预算

- 预算以单次调用为最小单位；
- `llm_usage` 按 `provider + provider_known` 分别聚合，不再用 Provider 级 `MAX(provider_known)`；
- `glm`（confirmed）与 `glm@unknown` 是独立身份桶；
- 未知 GLM 不享受豁免；
- 历史按 agentKind 推断的 provider 降级为 `provider_known=0, legacy_inferred`，不自动升级；
- 缓存 Token 以配置权重计入；
- 全局 / 项目 / DSH 专项分别统计；
- 不重置历史费用、不提高授权上限。
- 测试：`tests/v3-budget-reservation.test.js`（混合 confirmed/unknown、缓存、估算成本、历史迁移、并发、合法 GLM 豁免）。

## P0-2 UNKNOWN 历史费用与安全重试

- UNKNOWN 保留历史调用与估算风险额度；
- 新付费重试创建**独立 reservation ID 和 requestKey**，不覆盖旧 UNKNOWN；
- released/expired/unknown/settled 状态迁移明确；
- settled/reserved 同 requestKey 不再发起新付费调用；
- TTL 到期转 UNKNOWN；
- 每次新调用仍执行完整 SQLite `BEGIN IMMEDIATE` 预算检查；
- 结算/未知/预留均可审计，不伪造费用为零。
- 测试：`tests/v3-budget-reservation.test.js`（UNKNOWN 重试占额、独立 ID、SIGKILL 重开、超时 unknown、重复结算、释放重试额度检查）。

## 最终产品验收

`tests/v32-product-gate.test.js` 已补齐：
- A→B→C → Planner no_task → 最终产品审计 PASS → awaiting_acceptance → `acceptRun` accepted；
- 最终审计绑定最终 Git SHA；
- 缺失 B 阻断并生成产品修复；
- 修改 A 后历史 PASS 失效；
- max_rounds 未通过 BLOCKED；
- fake Agent/Planner/Auditor 明确离线模拟，不冒充真实 DSH。

## 验证

- 串行全量：**306 tests / 302 pass / 4 skipped / 0 fail**（Docker/symlink 环境能力不可用；日志 `demo/evidence/v3.3/tests.log`）。
- Playwright：15/15。
- 真实 E2E：**BLOCKED**，资源申请见 `REAL-E2E.md`。
- 24H：**NOT_VERIFIED**。
