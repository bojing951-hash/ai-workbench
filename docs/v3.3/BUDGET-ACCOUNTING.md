# v3.3 模型预算与费用账本

## 身份口径

每条 `llm_usage` 记录：
- provider / model；
- `provider_known`（是否已核实）；
- `provider_source`；
- `budget_scope`（global / project_audit）；
- tokens_in / out / cache / cost_cny；
- source/source_id，关联 attempt/audit/reservation。

预算聚合：
- confirmed GLM：合法豁免；
- unknown GLM：`glm@unknown` 桶，计入预算；
- 其他 unknown：计入预算；
- `project_audit`：独立 DSH 专项，不进入全局分母；
- 不使用 `MAX(provider_known)` 代表 Provider。

## 预留生命周期

| 状态 | 含义 | 预算占额 |
|---|---|---|
| reserved | 调用前已预留 | 是 |
| settled | 已有可信实际用量 | 实际用量（不再估算） |
| unknown | 调用已发起但结果未知/超时/崩溃 | 是（估算继续占位） |
| released | 仅确认未发生调用 | 否 |
| expired | TTL 到期 | 转 unknown，仍占额 |

## 重试规则

- 同 requestKey 且 reserved/settled：不发起新付费调用；
- released/expired/unknown 同键：旧行保留，新调用创建独立 ID + 新 requestKey，完整额度检查；
- 新调用不能因为历史 UNKNOWN 而获得免费额度；
- 结算不可重复；不重置历史。

## 证据

- `tests/v3-budget-reservation.test.js` 14 tests；
- 1,000/900/400 released retry 拒绝；
- 多 Node 进程并发；
- settled 重放；
- expired→unknown；
- SIGKILL 重开；
- DSH 隔离；
- 混合 GLM confirmed/unknown。
