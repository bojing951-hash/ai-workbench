# AI Workbench v2.7 — 自主产品质量闭环与长期无人监督工程报告

- 版本：**v2.7.0**（基于 v2.6.0）
- 范围：只开发 AI Workbench；**未修改 Consumption Decision Lab**；**未访问/修改/暂停/同步/接管 A/B**；未合并 main、未部署。
- 严格区分状态：IMPLEMENTED / TESTED / E2E_VERIFIED / AUTONOMOUSLY_VERIFIED / 24H_VERIFIED / BLOCKED / UNKNOWN / FAILED。
- 总测试：**221/221**（v2.6 原 212 全保留 + v2.7 新增 9）。
- Draft PR：**#9**（v2.7.0，未合并/未部署）。

## 1. 结论速览

| 能力 | 状态 | 证据 |
|---|---|---|
| Product Quality Loop（需求矩阵 + 有证据问题 + 自动修复任务 + 再评估停止） | **IMPLEMENTED + TESTED** | `src/quality.js`、`src/loop.js` 集成、`tests/quality.test.js`（4）、`tests/quality-loop.test.js`（1） |
| Requirements Coverage Matrix | **IMPLEMENTED + TESTED** | PASS/FAIL/UNKNOWN/BLOCKED；无证据不得 PASS；P2 记录不阻塞；API `/api/projects/:id/quality` |
| Fencing Token / 真实单写 | **IMPLEMENTED + TESTED** | 原子 fence、续租/释放/run 租约守卫；`tests/fencing.test.js` 2 项（含两个独立进程竞争）、`tests/fencing-workbench.test.js`（两个编排器实例竞争） |
| Provider-aware 预算/审计分账 | **IMPLEMENTED（沿用 v2.5）+ TESTED（既有）** | 项目/任务预算、缓存 token、vendor/estimated/unknown；CDL ¥30 未挪用 |
| 独立审计新项目 | **BLOCKED** | 全局 DeepSeek 剩余 9,869 tokens < 审计预估 8,000 + 保留 2,000；无新审计授权；CDL ¥30 禁止挪用 |
| 独立中等复杂度项目 | **FROZEN / E2E BLOCKED** | Reading Queue Planner；冻结契约/可见测试/隐藏质量检查；任务在**编码前**因独立审计资源阻塞，未写产品代码 |
| 自主发现缺陷率/自动修复成功率 | **UNKNOWN** | 因审计 BLOCKED，未运行真实编码→质量闭环 E2E；只在测试夹具中验证质量闭环机制 |
| 24 小时无人监督验收 | **NOT_VERIFIED / BLOCKED** | 未启动 24h 墙钟窗口；项目在审计预检即阻塞；Supervisor 运行中但无可用独立审计资源 |
| 通用项目历史回放 | **IMPLEMENTED + TESTED** | 去 CDL 硬编码（名称/SHA/截图/任务数/费用/耗时）；项目选择器；事件分页；API `/api/replay`；浏览器验证 |
| 外部人工写产品代码 | **0 次** | 本轮没有运行 Coding Agent 写产品代码；新项目被审计预检阻塞 |

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

## 5. 新独立验收项目（Reading Queue Planner）

- 项目：`proj_mwiq4y5u848f07c5`
- Loop：`loop_mwiq4y5x6bb41dfb`
- Run：`run_mwiq4z3fe1c0afce`
- 冻结：`projects/v2.7/reading-queue`（CONTRACT、可见测试、package）；隐藏质量检查 `projects/v2.7/quality-hidden/check.mjs`（不在产品仓库内）。
- 需求：书籍管理、阅读计划边界、本地持久化、CLI 用户流程；4 条 P0/P1 需求；quality 配置 `max_cycles=2`。
- 尝试启动后：**任务在编码前被审计资源预检阻塞**，原因：
  `独立审计资源预算不足：Provider=deepseek，剩余预算折算 9869，审计预估 8000 + 保留 2000；任务在编码前阻塞并保存检查点`
- 因此：
  - **未写产品代码**（Coding Agent 没有被调用）；
  - 未运行隐藏质量检查，缺陷发现率/自动修复成功率 = **UNKNOWN**；
  - 新项目 E2E = **BLOCKED**，不是 PASS/FAIL；
  - CDL 的 ¥30 项目审计预算未挪用，也未提高其他项目预算。

## 6. 24 小时无人监督验收

- 状态：**NOT_VERIFIED / BLOCKED**。
- 未启动 24h 墙钟窗口；新项目在审计预检即阻塞，无法进入编码/测试/审计/修复循环。
- Supervisor：独立 Supervisor 运行中，项目 `supervisor_managed=true`；但无独立审计资源时不会伪造 24h 结果。
- 24h 冻结目标/规则/项目状态见 `docs/v2.7/24H-ACCEPTANCE.md`。
- 若项目提前完成，只能产品 PASS，不能宣称 24H_VERIFIED；本轮两者都未达到。

## 7. 预算与审计

- 全局非 GLM Token 剩余 **9,869**，审计预估 8,000 + 保留 2,000 → 预检阻塞；没有突破授权。
- CDL 项目级 ¥30 审计预算仍只属于 CDL：已用 ¥0.9014/30，未用于本轮。
- 未重置历史用量；未申报虚假成本。
- 无新增模型调用成本用于新项目（编码前阻塞）。
- DeepSeek/OpenAI 原有授权未变；GLM 编码按既有授权。

## 8. 交付

- 代码：分支 `v2.7.0`，Draft PR #9（未合并/未部署）。
- 测试：221/221；新增长期/质量/分页测试。
- 证据：`demo/evidence/v2.7-*.json/txt/png`。
- 下一轮恢复：Resume `loop_mwiq4y5x6bb41dfb` 需要先获得独立审计资源；质量闭环代码已就绪。
