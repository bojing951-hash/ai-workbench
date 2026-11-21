# 真实零人工 E2E 授权申请

**状态：AUTHORIZATION_REQUIRED / NOT APPROVED**
**本文件只是申请，不代表已获得额度。**
在用户明确批准前，Workbench 不会发起新增付费 E2E 调用。

## 1. 验收对象

- 新建 1 个隔离产品项目（不复用历史 paused 项目/历史成果）；
- 3 个独立功能模块 + 最多 2 次真实缺陷修复；
- 用户只做一次初始确认（产品目标/验收标准/预算），之后不得逐轮人工追加提示词。

## 2. 明确 Provider / 模型

| 用途 | 客户端 | Provider / 模型 | 最大调用 |
|---|---|---|---|
| 首轮对话理解 | Workbench Chat → DeepSeek | deepseek / `deepseek-chat` | 2 |
| 自动规划 | Workbench Planner → DeepSeek | deepseek / `deepseek-chat` | 4 |
| Coding Agent | Claude Code 2.1.104 | GLM-5.3（实际 Provider=GLM） | 8 |
| 独立审计 | DSH 0.2.2-rc.2 headless | DeepSeek `deepseek` | 8 |
| 最终产品审计 | DSH | DeepSeek `deepseek` | 2 |
| OpenAI | 不使用 | — | 0 |

总计硬上限：**50 次模型调用**（含重试/修复，不得超过）。

## 3. 预算申请

### A. 全局非 GLM Token

- 当前上限：3,000,000
- 已计入：3,495,479
- 已超：495,479
- 新 E2E 计划：120,000
- 计算：495,479 + 120,000 = **615,479**
- 申请新上限：**3,620,000 tokens**（新增 620,000，含 4,521 安全余量）

### B. 全局非 GLM 费用

- 当前上限：¥30
- 当前已用：¥15.2375
- 申请 E2E 增量硬上限：**¥10**
- 新全局上限：**¥40**（其中 E2E 非 GLM 部分停损 ¥10）

### C. GLM Coding（现有豁免）

- 现有配置 `glmUnlimited=true`；
- 本次实验单独设硬停损：**4,000,000 GLM tokens / ¥40**；
- 到任一上限即停止，不继续 Coding。

### D. 新项目 DSH 专项

- 独立项目预算：**2,000,000 tokens / ¥30**；
- 仅用于该新项目的 DSH 审计；
- 不得与全局预算、CDL、Reading Queue 或其他项目互相挪用。

### E. 总费用

- 本次实验新增硬上限：**¥80**（全局 ¥10 + GLM ¥40 + DSH ¥30）；
- 安全余量 10%：实际止损线 **¥72**；
- 达到止损线立即停止并保留现场。

## 4. 停止条件（任一触发）

1. 产品级冻结验收 PASS 且 `awaiting_acceptance`（等待用户最终验收）；
2. 总费用达到 ¥72 或硬上限 ¥80；
3. 模型调用达到 50 次；
4. 全局/DSH/GLM 任一预算耗尽或预检失败；
5. 真实 E2E 运行超过 6 小时；
6. 出现不可恢复的 BLOCKED / 安全边界问题；
7. 用户取消。

## 5. 禁止事项

- 不自动合并 main、不部署；
- 不修改冻结验收契约/既有测试；
- 不修改 CDL / Reading Queue / Global Opportunity Engine / Investment Agent；
- 不使用外部 Harness 替 Workbench 编写产品源码；
- 不模拟模型冒充真实 Agent/DSH；
- 不重置历史预算，不把 UNKNOWN 直接认定为 GLM。

## 6. 需要用户明确回复

请明确回复以下授权语句（可修改数值，但不得默认为已批准）：

> 我批准 AI Workbench 在新隔离项目上执行真实零人工 E2E：全局非 GLM 上限 3,620,000 tokens、全局费用上限 ¥40（E2E 增量 ¥10）、GLM Coding 硬停损 4,000,000 tokens/¥40、新项目 DSH 专项 2,000,000 tokens/¥30、最多 50 次模型调用、总费用硬上限 ¥80（止损 ¥72）；不自动合并/部署，不修改其他项目。

未收到明确授权前：**AUTHORIZATION_REQUIRED，真实 E2E 保持 BLOCKED。**
