# v2.7 验收矩阵

| 验收项 | 状态 | 证据/说明 |
|---|---|---|
| Product Quality Loop 代码 | IMPLEMENTED | `src/quality.js`、`src/loop.js` |
| Requirements Coverage Matrix | IMPLEMENTED + TESTED | `tests/quality.test.js` 4/4；API `/api/projects/:id/quality` |
| 自动生成有证据修复任务 | IMPLEMENTED + TESTED | `repairTasksFromQuality`；无证据只记假设 |
| 质量闭环重评估/停止 | IMPLEMENTED + TESTED | `tests/quality-loop.test.js`：FAIL→repair→PASS→completed |
| 真实新项目 E2E（质量发现/修复） | **PASS** | Reading Queue：Agent 源码；隐藏 R1 自动修复；质量 4/4；DSH PASS；详见 FINAL-ACCEPTANCE |
| Fencing Token 原子获取/单调 | IMPLEMENTED + TESTED | `tests/fencing.test.js` |
| 两个独立进程竞争同一项目 | TESTED（store 层真实进程） | 两进程仅一个获得 fence |
| 两个编排器并发 startRun | TESTED | `tests/fencing-workbench.test.js`，仅一个 run 创建 |
| 旧执行者续租/释放/覆盖 | TESTED | 旧 fence 失败；run lease 不能覆盖 |
| Agent/测试/审计/提交前 fence 校验 | IMPLEMENTED（关键路径） | orchestrator assertProjectLease；未做全部写路径穷尽证明 |
| 两个完整 Workbench HTTP 服务进程竞争 | **UNKNOWN** | 未运行真实双 server E2E；不升格为 E2E |
| Provider-aware 预算/分账 | TESTED（v2.5 回归保留） | token/缓存/费用/项目审计 scope；既有测试 |
| 新项目独立审计 | **PASS（专项 ¥30）** | 专项预算；10 次 DSH；估算 ¥1.3256/30；CDL ¥30 未挪用 |
| 独立中等复杂度项目 | PASS（产品交付） | `projects/v2.7/reading-queue`；隐藏检查外部 |
| 自主发现缺陷率/误报/修复率 | **2 个确认产品缺陷 / 2 个修复** | DSH planner + 隐藏 R1；FINAL-ACCEPTANCE |
| 24 小时墙钟验收 | **NOT_VERIFIED** | 产品提前完成；未制造任务；详见 24H-ACCEPTANCE |
| 通用项目回放 | IMPLEMENTED + TESTED | 去 CDL 硬编码；项目选择器；事件分页 7 测试 |
| 原有 212 测试保留 | PASS | 总 237/237 |
| 产品 CDL 未修改 | PASS | 产品仓库 git status 干净；未重跑 |
| A/B 零干扰 | PASS（操作层面） | 未访问/操作；新接口按名称过滤 |
| 预算未提高/历史未重置 | PASS | 未修改配置/DB 用量 |
| 不合并/不部署 | PASS | Draft PR #9 |
| 外部人工写产品代码 | PASS（0 次） | 新项目编码前阻塞 |
