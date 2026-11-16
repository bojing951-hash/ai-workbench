# v2.6 验收矩阵

| 验收项 | 状态 | 证据 |
|---|---|---|
| 三个入口可见可点 | PASS | 左侧「看见 AI」；浏览器测试与截图 |
| ① 工作台如何工作原理/可展开/大白话 | PASS | 11 步详情、技术细节可展开；Guide 截图 |
| ② 研发实况五问（项目/任务/Agent/完成/下一步） | PASS | 6 顶卡 + 真实项目下拉 + 当前无活跃运行说明 + 时间线 |
| ③ 历史回放五幕 | PASS | 真实 7 loops/8 tasks/17 attempts/4 audits/207 events/5 commits |
| 真实数据接入 | PASS | SQLite/事件/attempts/audits/Git 只读查询；非演示数据 |
| 正常项目状态 | PASS | 浏览器测试：产品项目，等待验收，1/1 任务，费用 ¥2.91 |
| 空数据状态 | PASS | tests/replay.test.js；浏览器空状态 stubbing UI 测试；截图 |
| 失败与恢复展示 | PASS | attempts 失败分类、UNKNOWN 审计、修复要求、重试事件 |
| 历史事件重建 | PASS | 207 条事件，按时间线可展开；北京时间 |
| 产品开发过程回放 | PASS | 5 幕、任务、代码尝试、审计、交付 |
| 简单讲解/技术详情 | PASS | 切换按钮；技术字段含 ID/token/原始数据 |
| 点击任务/审计/Commit 详情 | PASS | 任务详情、逐条审计证据、真实 Git diff |
| 北京时间 | PASS | 全部格式化为 Asia/Shanghai |
| 桌面浏览器验证 | PASS | Playwright Chromium 1440×1000 |
| 移动端验证 | PASS | 390×844，横向溢出 0；移动截图 |
| 页面错误 | PASS | 浏览器日志 PAGE ERRORS none |
| 原有测试回归 | PASS | 212/212，原 206 保留 |
| 只读/不修改历史 | PASS | replay.js 仅 SELECT/read/git log；测试隔离；未改产品记录 |
| A/B 不进入新接口 | PASS | isExcludedProject + test；未访问/操作 A/B |
| 不重跑产品任务 | PASS | 未创建/恢复产品运行 |
| 不修改产品代码 | PASS | 仅 W 工作台 UI/API/证据；产品源码目录未改 |
| 不修改预算授权 | PASS | 未改 budget 配置 |
| 不合并/不部署 | PASS | 未 merge/deploy |
| 独立质量审查 | PASS（独立只读 agent；首轮 FAIL 项已修复并复审） | `demo/evidence/v2.6-independent-audit.md`；DSH 审计未获本任务预算，未调用 DSH |
| 24h/Fencing 既有未完成项 | NOT VERIFIED / NOT IMPLEMENTED | 不在本 UI 任务范围，未声称完成 |
