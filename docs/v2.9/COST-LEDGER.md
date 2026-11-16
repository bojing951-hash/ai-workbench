# v2.9 成本账本

- Chat 对话：真实 DeepSeek 2 轮，约 **¥0.0037**（usage 见 `demo/evidence/v2.9/chat.json`；Provider 返回 usage，费用按定价估算）。
- 一键开发：在 Agent 编码前被预算 preflight 阻塞，**无 GLM 编码调用、无 DSH 审计调用、无新费用**。
- 本轮 UI/可靠性测试、Docker 质量测试：本地无模型费用。
- 未提高/重置任何预算；未挪用 CDL、Reading Queue 或其他项目专项审计预算。
- CDL v0.2 历史成本不再重算、未计入本轮新增。
- 真实 E2E 解除阻塞需要用户明确新的预算/授权。
