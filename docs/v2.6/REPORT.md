# AI Workbench v2.6 — 看见 AI：过程可视化与历史回放

- 版本：**v2.6.0**（基于 v2.5.0）
- 范围：只增加 UI 与必要的只读查询接口；不重构编排、不改产品 Consumption Decision Lab、不重跑其任务、不碰 A/B、不改预算、不合并/部署。
- 三入口：左侧「看见 AI」→ 工作台如何工作 / 研发实况 / 历史回放。
- 测试：**212/212**（原 206 全保留 + 新增 6 项只读层测试）
- 浏览器验收：真实 Chromium，桌面 1440×1000 + 手机 390×844；无页面错误、移动端横向溢出 0。
- 独立质量审查：独立只读审查 agent；首轮发现 P0 问题，修复后复审无 P0、P1 文案已修；记录见 `demo/evidence/v2.6-independent-audit.md`。DSH 审计预算未用于本 UI 任务，未声称 DSH 审计。

## 1. 交付页面

### ① 工作台如何工作

11 个可点击步骤，逐步解释需求→目标→任务→Claude Code/GLM 编码→测试→DSH 独立审计→失败修复循环→通过→commit→下一任务→等待验收。每步包含「负责什么/接收什么/产生什么/怎么知道完成/失败谁处理」的大白话，以及可展开的技术细节。

### ② 研发实况

- 顶部六卡：项目状态、已完成/总任务、当前 Agent、当前阶段、已运行时间、模型费用。
- 真实项目下拉（不含 A/B）。
- AI 工作时间线：真实事件按时间倒序；点击展开原始消息、运行/任务 ID、可读 data、跳转原运行详情。
- 没有活跃运行时明确显示「没有 AI 正在工作」，展示最近一次真实运行，不虚构当前任务。

### ③ 历史回放

从真实 SQLite/事件/attempts/audits/Git 重建 Consumption Decision Lab：

- 第一幕：项目/循环目标、冻结契约原文（原始聊天未入库 → 明确标注）。
- 第二幕：7 个研发循环、计划队列、8 条实际任务记录（含失败/阻塞/被替换），不隐藏中间失败。
- 第三幕：17 次 Claude Code attempts（stalled/timeout/aborted 等真实失败分类）、提示词、token、费用、5 个 Git commit 链。
- 第四幕：4 次 DSH 审计，逐条 evidence、修复要求、UNKNOWN（90）和最终 PASS 100/4 条；不只有最终 PASS。
- 第五幕：产品真实截图、测试、commit、源码位置、成本；底部总结。
- 交互：上一步/下一步、五幕切换、全事件时间线、点击任务/审计/commit、简单/技术模式切换、真实 Git diff 读取。

## 2. 只读数据层

新增 `src/replay.js`：

- 只做 SELECT / 文件读取 / Git 只读查询；不写 SQLite、不写 Git、不修改产品代码或研发状态。
- 新接口（均 GET，沿用现有 API Token/Cookie 认证）：
  - `GET /api/live?projectId=...`
  - `GET /api/replay/consumption?projectId=...`
  - `GET /api/replay/consumption/commits/:sha`
- A/B 项目按名称过滤，不进入实况/回放接口；新 UI 也不会向 A/B 发起项目级请求。
- 空数据：实况返回空项目/空状态；回放 available=false；无项目/无事件均有明确空状态。
- 缺失字段显示「未记录/无法确认」；不生成演示事件或伪造历史。

## 3. 真实数据摘要（Consumption Decision Lab）

| 数据 | 数量 |
|---|---|
| 研发循环 | 7 |
| Runs | 8 |
| 任务记录 | 8（passed 2 / failed 3 / blocked 1 / coding 2） |
| Claude Code attempts | 17（含 10 次失败/卡死/超时/取消） |
| DSH 审计 | 4（PASS 3 / UNKNOWN 1） |
| 事件 | 207 条 |
| 真实 Git commit 链 | 5 |
| 产品冻结测试 | 9/9 unit + 浏览器全流程 |
| 真实时间窗口（北京时间） | 2026-11-16 00:37–02:21，约 1 小时 44 分 |
| 编码成本 | ¥16.5882（Claude Code/GLM 真实 usage） |
| 审计成本 | ¥0.9014 / ¥30 项目级审计预算（DSH 使用同一个 DeepSeek API，估算费用） |
| 总计 | ¥17.4896 |

## 4. 测试与浏览器证据

- `npm test`：**212/212**（日志 `demo/evidence/v2.6-tests.log`）。
- 浏览器真实交互（Playwright + 完整 Chromium）：
  - 三入口可点击；
  - Guide 11 步、详情可展开；
  - Live 6 顶卡、19 条真实时间线事件；
  - Replay 8 条任务记录、17 次 attempts、4 次审计（含 UNKNOWN）、5 个 commit、总结存在、真实 diff 可读取；
  - 空数据可显示；
  - 移动端 390×844 横向溢出 0；
  - 页面错误 0。
  - 日志：`demo/evidence/v2.6-browser-test.log`；截图：`demo/evidence/v2.6-*.png`。
- 新增单元/集成测试 `tests/replay.test.js`：空数据、A/B 过滤、真实数据重建、缺失字段、非法 commit。

## 5. 已知限制

- 当前没有正在运行的 AI 任务，所以「研发实况」显示最近一次真实运行的完成状态，并明确「没有 AI 正在工作」；没有伪造实时活动。
- 原始用户聊天记录未写入 SQLite：第一幕使用项目记录、循环目标与冻结契约原文，并明确说明。
- 历史中个别审计因任务失败没有最终 commit（显示 commit 未记录）；部分失败尝试无 diff/日志，显示未记录。
- 页面不是录屏，是从事件数据重建的回放。
- 本 UI 任务没有获得 DSH 独立审计预算，未调用 DSH；独立质量审查由独立只读审查 agent 完成并记录。
- 24h 连续验收/ Fencing Token 仍是工作台既有未完成项，与本 UI 交付无关且没有被声称完成。
