# v3.0 成本/预算账本

## 本轮新增真实模型调用

- v3.0 代码整改、离线 fake-agent 测试、HTTP fake-upstream 回归：**0 真实模型费用**。
- 浏览器 Playwright：本地假 OpenAI 兼容上游，不产生厂商费用。
- 未调用真实 Coding Agent / DSH 审计 / 真实产品模型。

## 历史账本保留

- 迁移 `llm_usage` 时从历史 attempts/audits 回填，未重置累计用量。
- 迁移后生产预算快照：
  - `remainingTokens ≈ 8,654`
  - `remainingCostCny ≈ ¥23.66`
  - `usedBudgetTokens ≈ 2,991,346`
- 详细机器快照见 `demo/evidence/v3.0/budget-snapshot.json`。
- 未修改 `MAX_TOTAL_TOKENS` / `MAX_COST_CNY`，未增加/重置任何预算。
- 未使用 CDL / Reading Queue / 其他项目专项审计预算。

## 最终账本

- 最终本地预算快照：remaining 8,654.2 tokens / ¥23.66；历史 178 条 legacy 用量（124 attempts + 54 audits）已回填。
- 未产生 v3.0 真实 Coding/DSH 费用。

## 真实 E2E 阻塞

新项目 Coding 预检至少需要约 10,000 tokens，当前剩余 8,654，低于预检；且无新项目 DSH 专项预算/授权。因此真实 E2E 未执行，不产生虚假费用记录。
