# AI Workbench v2.5 — Consumption Decision Lab 真实产品交付报告

- 日期：2026-11-16（Asia/Hong_Kong）
- Workbench 版本：**v2.5.0**（分支 `v2.5.0`）
- 产品：**Consumption Decision Lab｜消费决策实验室**
- 产品代码：commit `1ad754d1`，分支 `release/v0.1.0`，tag `v0.1.0`
- 产品测试：**9/9 unit + tsc/build + Playwright desktop/mobile 全通过**
- 最终独立审计：**DSH（DeepSeek Harness）只读审计 PASS 100，4/4 标准逐条证据**
- 工作台测试：**206/206**
- 范围：仅 W + 新建消费产品；**A/B 未访问/修改/暂停/同步/推送**；未合并 Workbench 主分支、未部署

## 1. 产品交付（PASS）

- 独立 Git 仓库：`projects/consumption-decision-lab`；发布分支 `release/v0.1.0`；tag `v0.1.0`。
- 运行：`npm ci && npm run build`，`npm run dev` / `npm run preview`；完整冻结测试 `npm test`（环境需 `PLAYWRIGHT_BROWSERS_PATH`）。
- 最终验收 run：`run_mwi5mngy58722742`；loop `loop_mwi5mmjf556742e6`；任务 `task_mwi5mngy...`。
- 产品能力：画像（全部财务字段可选、本地 localStorage）、消费结构、单笔决策（TCO/单次成本/机会成本/财务压力/四选项/失效条件）、收入职业情景、消费技巧、可追溯证据库（5 条真实来源）。
- 冻结测试/契约未被 Coding Agent 修改；产品源代码全部由 **Claude Code / GLM** 生成；**无外部人工产品代码**。
- 截图：`demo/evidence/cdl-home.png`、`cdl-profile.png`、`cdl-purchase.png`、`cdl-mobile.png`。
- 源码交付包：`demo/evidence/consumption-decision-lab-v0.1.0.bundle`（600K，含全部 Git 历史）。

### 验收结果

| 项 | 结果 | 证据 |
|---|---|---|
| 从干净工作区安装/构建/启动 | PASS | release worktree `npm ci` + `npm run build` + preview |
| TypeScript 类型检查 | PASS | `tsc --noEmit` |
| 单元测试 | PASS | 9/9 |
| 浏览器真实交互 | PASS | Playwright desktop/mobile：3 passed，1 skipped（desktop 上 mobile-only 断言） |
| 桌面/手机布局 | PASS | viewport 1280×900 / 390×844；mobile 无横向溢出断言 + 截图 |
| 输入验证/错误处理 | PASS | 负数字段错误、空画像可用 |
| 本地数据 | PASS | 仅 localStorage；无 fetch/上传 |
| 研究依据 | PASS | `contract/evidence.json` 每条含 claim/source/date/type/conditions/limitations；测试校验 |
| DSH 审计 | PASS 100 | commit 1ad754d1，4/4 逐条 evidence |
| 远端 Draft PR | BLOCKED | 产品仓库无远端授权；未推送/合并/部署 |

## 2. DSH 独立审计适配器（PASS）

实现 `src/auditors/dsh.js`：

- 真实调用安装的 DSH headless CLI：`dsh headless --json --permission-mode read-only --approval-policy never`。
- 独立临时审计工作区：复制被测 worktree（排除 `.git/node_modules`）、目录只读；DSH read-only preset；**不允许 DSH 修改产品代码/冻结测试**。
- 输入包含任务、逐条验收标准、base commit、被测 tree hash、绑定 commit SHA、diff、测试命令与输出、仓库文件。
- 输出 JSON 逐条 `pass/fail/unproven` + evidence + findings/required_fixes；缺失证据由 `finalizeAuditVerdict` 降为 UNKNOWN，不能伪造 PASS。
- 编码完成后先创建**预审计 commit**，DSH 以该 SHA 为审计对象；PASS 后直接使用该 commit，不生成第二个空 commit。
- 中间 UNKNOWN（源码 provenance 元标准）被如实返回 90 分并拒绝 PASS；修正验收口径后最终 4/4 PASS。

### 实际模型与计费核实

- DSH CLI 使用的 `DEEPSEEK_API_KEY` 与 Workbench `.env` 中的 DeepSeek Key **相同**（只做值相等检查，不打印密钥）；DSH 日志显示模型列表来自 `https://api.deepseek.com`。**不是独立订阅服务**。
- 用户为本项目追加独立审计预算 **¥30**；本项目调用写入 `audits.budget_scope='project_audit'`，不计入 Workbench 历史全局非 GLM Token/费用预算，也不提高其他项目预算。
- 4 次 DSH 审计：**235,225 tokens，估算 ¥0.9014 / ¥30**；费用为 token×定价估算（无厂商逐调用账单，标 `estimated`），未伪造厂商回执。GLM 编码按既有授权单列，不计入 ¥30。

## 3. 工作台必要修复（部分完成，明确未完成项）

已完成：

- DSH 只读审计适配器 + 预审计 commit 绑定 + 真实调用/预算隔离。
- 项目级审计预算（¥30 硬上限、Token 额度、接近上限停止调用）。
- Provider-aware 项目成本预算：GLM 豁免部分不再误占非 GLM 费用预算（修复 12.17>10 的误报）。
- 项目级 Claude 工具覆盖（仅本产品项目允许 Bash 诊断），不改变全局默认安全策略。
- 产品测试环境修正：Playwright desktop 使用完整 Chromium（headless-shell actionability 缺陷，产品代码未改、断言未降）。
- v2.4 独立 Supervisor 继续运行并托管本产品项目。

**未完成/未声称完成：**

- 用户要求的 **Fencing Token**（过期所有者重新写入防护）尚未实现；现有 v2.4 实现是项目/run 租约 + 恢复对账，不能宣称已具备 fencing。已在验收矩阵标 `NOT_IMPLEMENTED / FAIL`。
- 24h 无人监督验收仍是历史 `24H_AUTONOMY_NOT_VERIFIED`；本次产品交付不冒充 24h。
- Docker Agent egress allowlist 仍 UNKNOWN/PARTIAL。

## 4. 自主开发与恢复记录

- 产品分阶段任务：CDL-1 领域模型 → DSH PASS 84（commit `d865a59d`）；UI 任务多次 Claude 无进展/超时，被看门狗终止并新会话重试；保留**Agent 生成的 UI rescue commit**（`1018513`），由后续任务修复/验证；CDL-3 审计 UNKNOWN（元标准不可证明）拒绝 PASS；CDL-4 最终验收 PASS 100（commit `1ad754d1`）。
- 失败分类、看门狗、候选/新会话、检查点均真实发生；未把超时/UNKNOWN 标 PASS。
- 产品源码无人工修复；测试/契约冻结；最终测试由 Workbench 执行、DSH 独立审计。

## 5. 成本

| 项 | 值 |
|---|---|
| 产品 DSH 审计 | ¥0.9014 / ¥30（235,225 tokens，4 次） |
| 产品编码 | Claude Code / GLM-5.3：15 次真实调用、1,956,679 tokens、**¥16.5882**（厂商 usage；按既有授权单列，不计入 ¥30 审计预算） |
| 产品模型总成本 | 编码 ¥16.5882 + 审计 ¥0.9014 = **¥17.4896** |
| 规划/测试/构建 | 确定性规划 + 本地测试，无模型 API 费用 |
| 测试/构建 | 本地，无 API 费用 |
| 历史无法精确归属 | UNKNOWN（不编造） |
| 其他项目预算 | 未提高 |

## 6. 交付与阻塞

- 产品源码：`projects/consumption-decision-lab`，发布分支/tag，bundle，截图，docs/ACCEPTANCE/AUDIT/COST/FAILURES。
- Workbench：Draft PR #7（v2.5.0），未合并/未部署；CI 结果见 PR。
- 产品远端 Draft PR：**BLOCKED**（无远端授权，不推送）。
- 验收矩阵：`docs/v2.5/ACCEPTANCE-MATRIX.md`。

## 7. 结论

**产品业务目标达成**：用户只提交一次需求，系统自主完成规划、Claude Code/GLM 编码、冻结测试/构建/真实浏览器验证、DSH 独立审计、失败修复与最终交付；最终产品可运行、可交互、证据可追溯。  
**工程目标未全部达成**：Fencing Token 未实现，24h 连续验收仍为 `24H_AUTONOMY_NOT_VERIFIED`；不把这两项标 PASS。
