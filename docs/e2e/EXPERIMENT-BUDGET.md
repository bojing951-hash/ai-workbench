# E2E 实验级硬预算契约（v3.3 safety）

## 目的

把申请中的 E2E 预算从文档声明变成 SQLite 持久化、每次模型调用前原子检查的硬限制。

## 契约表 `experiment_contracts`

每条记录冻结：

- project_id / conversation_id；
- authorized_by、authorized_at、authorization_source；
- authorization_text_hash；
- contract_version / contract_hash；
- token_limit / cost_limit_cny / stop_loss_cny / call_limit / deadline_at；
- glm_token_limit / glm_cost_limit_cny；
- dsh_token_limit / dsh_cost_limit_cny；
- provider_json / isolation_mode / stop_conditions_json；
- status（authorized / running / stop_loss_reached / overspent / ended）。

授权命令必须在真实 TTY 中由用户执行：

```bash
node scripts/e2e-authorize.mjs \
  --project-id <project> --authorized-by <user> \
  --isolation DOCKER_REQUIRED \
  --confirm I_AUTHORIZE_E2E_BUDGET_V1
```

非 TTY 或确认语不匹配直接拒绝；命令不触发任何模型调用。

## 每次调用的强制顺序

1. Chat / Planner / Coding / Task Audit / Product Acceptance 进入 `assertModelBudget`；
2. `reserveModelBudget` 在 `BEGIN IMMEDIATE` 中：
   - 读取实验契约；
   - 检查状态、截止时间；
   - 检查调用次数；
   - 检查实验总 Token、总费用；
   - 检查提前停止线、执行前上限；厂商实际调用可能先超一次再结算阻断，不承诺绝对硬封顶；
   - 检查 GLM / DSH 分项上限；
   - 检查全局预算（GLM 豁免和 DSH 专项按 scope 跳过全局）；
   - 插入带 experiment_id / experiment_scope / exempt_global 的预留；
3. 只有预留成功后才调用模型；
4. 调用结束 settle 实际用量；未知/超时/崩溃留 unknown 占额；
5. settle 若实际值越线，实验状态改为 `overspent` / `stop_loss_reached`，后续调用拒绝。

## 硬限制

| 契约字段 | 申请值 | 强制执行 |
|---|---|---|
| token_limit | 3,620,000 | 是 |
| non_glm_cost_limit_cny | 10 | 是（global scope） |
| per_call_max_tokens | 20,000 | 是（预留前） |
| cost_limit_cny | 80 | 是 |
| stop_loss_cny | 72 | 是 |
| call_limit | 50 | 是 |
| deadline_at | 6h | 是 |
| glm_token_limit | 4,000,000 | 是（独立 scope） |
| glm_cost_limit_cny | 40 | 是 |
| dsh_token_limit | 2,000,000 | 是（独立 scope） |
| dsh_cost_limit_cny | 30 | 是 |

**以上仍是拟申请参数；当前没有有效授权契约，所有 E2E 调用仍 BLOCKED。**

## 测试证据

`tests/v34-experiment-budget.test.js` 14 tests：

- 无授权/无效契约阻止预留；
- Token、费用、止损、调用次数上限；
- UNKNOWN 历史占额；
- GLM 独立上限（全局豁免不等于实验豁免）；
- DSH 独立上限；
- 截止时间；
- `assertModelBudget` 在调用前抛错；
- 多进程并发；
- settled 重放/UNKNOWN 重试独立 ID；
- 真实子进程 SIGKILL 后占用不重置；
- 隔离未批准在规划前 BLOCKED 且零模型调用。

完整套件：`demo/evidence/e2e-safety/tests.log`。


## 无界 Provider 风险许可

Claude Code/GLM 等无法在调用中强制 Token 硬上限的 Provider，实验内默认 BLOCKED。只有冻结实验契约包含 `provider_json.risk.unbounded`，且 client/provider/model 精确匹配、含授权人/时间/原因时，才能启动；该许可仍不构成绝对费用硬上限。授权脚本支持 `--risk-client --risk-provider --risk-model --risk-reason --risk-accepted-by`。
