# v2.8 成本与预算账本

- 本轮 Workbench 整改测试：本地 Node/Playwright/Docker，**无模型 API 调用费用**。
- 独立审查（只读子代理）无 DSH 审计调用；不增加新 DSH 预算。
- 未挪用 CDL、Reading Queue 或其他项目专项预算；未提高预算上限。
- 未运行真实新 Agent E2E，因此无本轮新增 GLM 编码费用或 DSH 审计费用。
- CDL v0.2 历史费用（不属于本轮新增）：GLM 编码 ¥63.1105；DSH 估算 ¥1.6253（项目累计 ¥2.5267/¥30），保留于 `demo/evidence/cdl-v0.2.0/`。
- 全局非 GLM Token 余额、CDL 专项审计余额未因本轮改动而变化（仅测试/容器）。

## 真实 E2E 预算需求（BLOCKED）

需要一个**新隔离项目专属**的独立 DSH 审计预算与显式授权（金额由用户确定；类似此前 ¥30 项目级预算），并允许该项目使用现有 DeepSeek API；不能用 CDL/Reading Queue 预算替代。GLM 编码按当前既有授权和真实用量记录。
