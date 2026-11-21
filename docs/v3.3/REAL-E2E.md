# 真实零人工 E2E：BLOCKED / 授权申请

## 现状

- 全局非 GLM 修正后剩余 **0 tokens**（usedBudgetTokens 3,495,479 / max 3,000,000；历史 GLM unknown 1,479,128 tokens 不再豁免）；
- 历史单任务预检约 10,000 tokens；
- 无新项目独立 DSH 审计预算/授权；
- 本轮提示词不授权增加预算。

## 正式授权申请

| 项目 | 申请值 |
|---|---|
| 隔离产品 | 新项目，3–4 个真实功能任务 |
| Provider | 真实 Coding Agent（具体 Provider/模型需用户确认） |
| 全局非 GLM | 需先对账/新增额度：当前已超限 495,479 tokens；新 E2E 另需 ≥120,000 tokens |
| 费用上限 | ¥10–25（按实际计价） |
| 新项目 DSH 专项 | ≥ 2,000,000 tokens / ¥30，或等价专项授权 |
| 调用次数 | 30–50 次 |
| 用途 | 规划、编码、测试、审计、自动修复、最终产品验收 |
| 停止条件 | 产品 audit PASS 并 awaiting_acceptance；或预算/调用上限触达；或不可恢复 BLOCKED |

## 约束

- 不挪用 CDL/Reading Queue/Global Opportunity Engine/Investment Agent 预算；
- 不提高/重置现有全局上限；
- 无明确授权时保持 BLOCKED。
