# AI Workbench v2.7 — 自主产品质量闭环与长期无人监督工程报告

- 版本：**v2.7.0**（基于 v2.6.0）
- 范围：只开发 AI Workbench；**未修改 Consumption Decision Lab**；**未访问/修改/暂停/同步/接管 A/B**；未合并 main、未部署。
- 严格区分状态：IMPLEMENTED / TESTED / E2E_VERIFIED / AUTONOMOUSLY_VERIFIED / 24H_VERIFIED / BLOCKED / UNKNOWN / FAILED。
- 总测试：**237/237**（v2.6 原 212 全保留 + v2.7 新增 9）。
- Draft PR：**#9**（v2.7.0，未合并/未部署）。

## 最终 E2E 结果

> 权威结果见 [FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md)：Reading Queue Planner 4/4 需求、隐藏检查 4/4、DSH 最终 PASS；2 个产品缺陷自主发现并修复；编码 ¥26.9630 + 审计估算 ¥1.3256；24H_NOT_VERIFIED（产品提前完成）。

## 1. 结论速览

| 能力 | 状态 | 证据 |
|---|---|---|
| Product Quality Loop（需求矩阵 + 有证据问题 + 自动修复任务 + 再评估停止） | **IMPLEMENTED + TESTED + E2E_VERIFIED** | `src/quality.js`、`src/loop.js` 集成、`tests/quality.test.js`（4）、`tests/quality-loop.test.js`（1） |
| Requirements Coverage Matrix | **IMPLEMENTED + TESTED + 4/4 E2E PASS** | PASS/FAIL/UNKNOWN/BLOCKED；无证据不得 PASS；P2 记录不阻塞；API `/api/projects/:id/quality` |
| Fencing Token / 真实单写 | **IMPLEMENTED + TESTED** | 原子 fence、续租/释放/run 租约守卫；`tests/fencing.test.js` 2 项（含两个独立进程竞争）、`tests/fencing-workbench.test.js`（两个编排器实例竞争） |
| Provider-aware 预算/审计分账 | **IMPLEMENTED（沿用 v2.5）+ TESTED（既有）** | 项目/任务预算、缓存 token、vendor/estimated/unknown；CDL ¥30 未挪用 |
| 独立审计新项目 | **PASS（专项 ¥30）** | 专项预算；10 次 DSH；估算 ¥1.3256/30；CDL ¥30 未挪用 |
| 独立中等复杂度项目 | **PRODUCT_E2E_VERIFIED** | Reading Queue Planner；Agent 源码、隐藏缺陷自动修复、质量 4/4、DSH 最终 PASS |
| 自主发现缺陷率/自动修复成功率 | **2 个真实产品缺陷 / 2 个修复并复审通过** | DSH R2 + 隐藏 R1；详见 FINAL-ACCEPTANCE |
| 24 小时无人监督验收 | **NOT_VERIFIED**（产品提前完成，未制造任务） | 实际 2h08m；产品 PASS 与 24h 分开；详见 24H-ACCEPTANCE |
| 通用项目历史回放 | **IMPLEMENTED + TESTED** | 去 CDL 硬编码（名称/SHA/截图/任务数/费用/耗时）；项目选择器；事件分页；API `/api/replay`；浏览器验证 |
| 外部人工写产品代码 | **0 次** | 产品源码全部由 Claude Code/GLM 生成；外部只修验收命令/Workbench，不是产品源码 |

## 2. Product Quality Loop

新增 `src/quality.js`：

- **Requirements Coverage Matrix**：需求 → 验收标准 → 质量命令证据 / 独立审计证据 → 状态 PASS/FAIL/UNKNOWN/BLOCKED；只有质量命令 PASS + 具体证据（或独立审计证据）才允许 PASS；任务列表完成不算产品完成。
- **主动问题**：质量命令（隐藏测试/静态检查，验收方预置在项目外）返回问题；每个问题必须有 evidence；无 evidence 标为 hypothesis，不自动修复。
- **自动修复**：只将**有证据的 P0/P1** 问题转成修复任务，追加到研发循环队列；Coding Agent 执行修复；下一轮重新运行质量命令；有修复上限 `max_cycles`，不能无限循环。
- **自主停止**：所有必须需求（required 且非 P2）PASS + 无有证据 P0/P1 问题 + 回归/审计通过，才 completed；否则 blocked 并保留矩阵/检查点，不伪造完成。
- **不让编码 Agent 自评**：质量评估是确定性证据合并器；最终独立审计仍由 DSH 提供（本轮新项目因预算 BLOCKED）。

### 测试

- `tests/quality.test.js`：4 项（无证据不得 PASS、FAIL/P0 生成修复任务、无证据 hypothesis、P2 不阻塞、未配置不伪造）。
- `tests/quality-loop.test.js`：真实 LoopManager + 真实临时 Git 仓库 + 外部质量命令：首轮 FAIL → 自动生成修复任务 → 第二轮 PASS → 循环 completed；修复任务带证据。
- 未完成 E2E：需要独立审计资源；见第 5 节。

## 3. Fencing Token 与并发

- SQLite `projects.lease_fence`、`runs.lease_fence`。
- `acquireProjectLeaseFenced`：`BEGIN IMMEDIATE` 原子获取，旧租约过期后可被接管，fence **单调递增**；其他有效 owner 获取失败。
- `renewProjectLeaseFenced`：owner+fence+未过期三者同时匹配才成功；续租失败即失去写权。
- `releaseProjectLeaseFenced`：旧 fence 不能释放新 owner 的租约。
- `setRunLeaseFenced`：不能覆盖其他有效执行者，不能回退 fence。
- Orchestrator：`startRun` 获取失败直接拒绝、不创建 run；`processRun` 续租失败立即停止；Agent 返回、测试、审计、提交前校验 fence；终态按自身 fence 释放。
- 测试：
  - `tests/fencing.test.js`：真实**两个独立 Node 进程**竞争同一 SQLite 项目，只有一个成功；过期接管 fence 更高；旧进程续租/释放失败。
  - `tests/fencing-workbench.test.js`：两个独立 Orchestrator 实例并发 `startRun`，只有一个成功，且只有一个 run 被创建。
- 边界：完整的两个 Workbench HTTP 服务进程竞争尚未作为 E2E 自动化运行；当前是“独立进程 store 竞争 + 两个编排器实例竞争”，不把 TESTED 升格为 E2E。

## 4. 通用历史回放（v2.7）

- 数据源改为**任意已授权项目**：项目 ID/名称、任务、attempts、audits、事件、任务 head commit；不再硬编码 Consumption Decision Lab、`1ad754d`、`0f6428e`、CDL 截图路径、固定费用/耗时。
- 新增 `GET /api/replay?projectId=&eventLimit=&eventBefore=`；旧 `/api/replay/consumption` 作为兼容别名但不再硬编码产品名。
- 事件分页：API 支持 `eventBefore`/`eventLimit`，UI 有“加载更早事件”；避免长时间运行超过 1000 条后丢失早期历史。
- UI 增加项目选择器；无截图素材的项目显示“未配置”，不混用其他项目截图。
- 测试：`tests/replay.test.js` 7 项，含任意项目回放、无 CDL 素材、事件分页；浏览器验证见 `demo/evidence/v2.7-browser-test.txt`。

## 5. 真实独立验收项目（Reading Queue Planner）

- 项目：`proj_mwiq4y5u848f07c5`；最终 loop：`loop_mwisni5ka9abfb45`（completed, 2 轮）
- 产品代码：分支 `release/v0.1.0`，tag `v0.1.0`；真实代码提交 `6bfdfac`（`b554f4b` 仅修 npm test 脚本）
- 冻结：`projects/v2.7/reading-queue`；隐藏质量检查 `projects/v2.7/quality-hidden/check.mjs`（在产品仓库外）
- 实际结果：
  - 初始开发：Claude Code/GLM 生成 4 个模块；可见测试 5/5。
  - DSH 审计发现 planner R2 边界问题：FAIL 60 → 修复后 PASS 97。
  - 项目外隐藏质量检查发现 R1 重复书籍问题：质量矩阵 3/4 FAIL → 自动生成 `[Quality P1]` 修复任务 → Agent 修复 → 质量矩阵 4/4 PASS。
  - 最终 DSH 审计 PASS 90；需求覆盖 4/4 PASS；可见测试 5/5；隐藏质量 4/4。
  - 产品安装/运行：`npm test` 5/5；CLI add/list/plan 实测输出 JSON。
- 状态：**PRODUCT_E2E_VERIFIED**；`AUTONOMOUS_QUALITY_LOOP_VERIFIED`（发现 1 个隐藏产品缺陷、自动修复、重审通过）。
- 人工介入：产品源码 **0** 次；外部只修复验收 test command/package harness 与 Workbench 工程缺陷，并执行了失败后的 resume/retry；因此 **FULLY_UNATTENDED_END_TO_END = NO**。
- 完整时间线、指标与 12 问回答见 `docs/v2.7/FINAL-ACCEPTANCE.md`、`demo/evidence/reading-queue-e2e.json`。

## 6. 24 小时无人监督验收

- 状态：**24H_NOT_VERIFIED**（不是 BLOCKED；专项审计预算已到位）。
- 产品在约 **2 小时 8 分**内完成；没有为凑 24h 制造新任务。
- 按用户规则：**产品交付 PASS，24h 连续研发 NOT VERIFIED**，两者分开报告。
- 24h 冻结目标/规则与说明见 `docs/v2.7/24H-ACCEPTANCE.md`。

## 7. 预算与审计

- 专项项目审计账本：DSH 10 次，408,961 tokens，估算 **¥1.3256 / ¥30**；实际厂商逐调用账单不可得，费用为估算，不能声称精确硬封顶。
- 编码：Claude Code/GLM 8 attempts，429,829 input+output tokens（缓存另计），**¥26.9630**（厂商 usage 返回值），GLM 按既有授权。
- 产品模型总成本：**¥28.2886**。
- 全局非 GLM Token 剩余 9,869 未变；CDL ¥30 未挪用；未重置历史用量；未提高其他项目预算。

## 8. 独立审查与失败驱动修复

- 独立只读审查（非 DSH）首轮无 P0、6 个 P1；已修复关键项（租约心跳/过期、run 租约接管、非 owner 写入、质量命令故障误修复、占位证据 PASS、cycles、回放 UI 硬编码、质量 API 最新矩阵等）；剩余问题见 `demo/evidence/v2.7-independent-audit.md`。
- 真实 E2E 暴露并修复的 Workbench 缺陷：
  1. DSH audit provider 被兼容层降为 auto，专项预算未生效 → 修复；
  2. `retryVerification` 对干净工作树/被检出分支误报提交指纹不一致 → 支持复用 HEAD、不 force 更新当前分支；
  3. 自动质量修复任务验收标准要求审计员执行项目外命令 → 改为代码/可见测试可审计标准；
  4. 租约过期/heartbeat、质量命令故障等可靠性问题（见审查记录）。
- 仍不声称：完整双 HTTP Workbench 服务进程竞争 E2E、全控制 API fence、24h 无人监督。

## 9. 交付

- Workbench：分支 `v2.7.0`，Draft PR #9（未合并/未部署）。
- 测试：**237/237**。
- 产品：`release/v0.1.0` / tag `v0.1.0`；bundle `demo/evidence/reading-queue-planner-final.bundle`。
- 证据：`docs/v2.7/FINAL-ACCEPTANCE.md`、`demo/evidence/reading-queue-e2e.json`、`reading-queue-quality-final.json`、`reading-queue-cli.txt`、`v2.7-tests.txt`。
