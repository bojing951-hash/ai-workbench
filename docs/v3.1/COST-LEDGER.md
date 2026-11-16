# v3.1 预算/成本

- 本轮代码/离线测试/Playwright fake-upstream：**0 真实模型费用**。
- 不修改 MAX_TOTAL_TOKENS/MAX_COST_CNY；不重置历史用量；不挪用专项预算。
- 新增 `model_reservations`：所有预留均带 TTL（默认 10 分钟），未结算预留不重复计费。
- 生产真实预算快照（v3.1 重启后更新）：见 `demo/evidence/v3.1/budget-snapshot.json`。
- 真实 E2E BLOCKED，因此无真实 Coding/DSH 费用。
