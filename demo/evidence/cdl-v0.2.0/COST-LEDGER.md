# CDL v0.2.0 成本记录

## 编码（GLM，厂商返回 usage）

- v0.2.0 合计 attempts：**10**；completed 5；failed 4（3 × `error_max_turns`，1 × `agent_timeout`）；interrupted 1。
- 编码费用：**¥63.1105**（GLM 既有授权；真实 token/费用来自 attempts 记录）。
- 说明：多次 max_turns 中断是新会话/任务拆分造成的真实成本，未隐藏、未重算。

## 独立审计（CDL 项目 ¥30 专项账本）

| 项 | 值 |
|---|---|
| v0.2 审计调用 | 4 次 |
| v0.2 审计估算 | **¥1.6253** |
| 项目累计审计（含 v0.1） | **¥2.5267 / ¥30**（8 次调用，581,820 tokens） |
| 最终审计 | PASS 100（4/4） |
| 费用来源 | DeepSeek API tokens × 估算定价；无厂商逐调用账单，标 estimated |
| 是否挪用其他项目 | 否；CDL 专项账本独立；未提高其他项目预算 |

## 汇总

- 产品模型总成本（v0.2 编码 + v0.2 审计估算）：**¥64.7358**。
- 测试/构建/浏览器：本地 npm/vitest/vite/Playwright，无模型 API 费用。
- 历史 v0.1 成本记录仍在 `v0.1.0` tag 的 `docs/COST-REPORT.md`，未重写。
