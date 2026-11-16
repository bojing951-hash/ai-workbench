# v2.9 Chat-First UI + 一键开发验收矩阵

## A. 新用户创建项目

| 要求 | 状态 | 证据 |
|---|---|---|
| 首页极简欢迎 + 自然语言输入 | PASS | 截图 `01-welcome-light.png`、`02-welcome-dark.png` |
| 真实模型理解需求 | PASS | 真实 DeepSeek 对话：2 轮返回需求草案（goal/acceptance），`demo/evidence/v2.9/chat.json` |
| 不要求用户填 Project/Agent 等技术字段 | PASS | UI 无工程表单；高级参数留在 /advanced |
| 信息不足时追问，不编造确定需求 | PASS | 第一轮 assistant ready=false，questions 返回 |
| 确认验收标准后一键开始 | IMPLEMENTED；E2E BLOCKED | 点击开始已创建项目/loop，但被全局 token 预算阻断（见 REAL-E2E.md） |

## B. 开发执行

| 要求 | 状态 | 证据 |
|---|---|---|
| 用户看懂当前阶段 | PASS | UI 将 run/task 映射为规划/编码/测试/独立审计/质量/交付 |
| 进度来自真实记录 | PASS（代码/状态） | 步骤 rank 依据真实 task status/events；无伪造百分比/完成时间 |
| 可展开工程详情 | PASS | Run/Task/Attempt/审计/Token/费用/Git/原因 |
| 开发中页面截图 | PARTIAL | 真实一键尝试在编码前被预算 blocked，截图 `04-blocked.png`；无伪造 active coding |

## C. 测试失败后自主修复

| 要求 | 状态 | 证据 |
|---|---|---|
| 自动生成修复任务 | PASS（代码/测试） | `tests/auto-repair.test.js`; auto repair queue |
| 修复优先/有界/保留原契约 | PASS（代码/测试） | auto_repair_max、原 goal/acceptance/audit evidence |
| UI 默认显示“发现问题，正在自动修复” | PARTIAL | 映射存在；未获得实时 active repair run 截图（预算/授权阻塞） |
| 无需人工重建 CDL-6/7 | PASS（代码/测试） | failed run → failed 终态 + auto repair；真实 startRun 回归 |

## D. 真实阻塞

| 要求 | 状态 | 证据 |
|---|---|---|
| 预算/权限/Docker 阻塞解释 | PARTIAL/PASS | 一键 start 因全局 token 预算在实际 preflight 阻塞；UI 显示“开发暂停，需要你处理”，截图 `04-blocked.png` |
| 不突破安全限制 | PASS | 未提升预算/权限；未伪造 Agent/审计活动 |
| 可恢复检查点 | PASS（Workbench 状态） | run paused，loop/项目保留；高级模式可恢复 |

## E. 最终交付

| 要求 | 状态 | 证据 |
|---|---|---|
| 产品名/功能/测试/审计/Git/成本 | PASS（真实历史 CDL 记录） | 截图 `05-completed.png`，来自真实 CDL v0.2 run awaiting acceptance；对话由真实模型生成，run/质检/Git 来自 DB |
| 预览入口只在可用时显示 | PASS（保守） | 没有已知可访问预览时不显示入口 |
| 人工验收、不自动合并/部署 | PASS | 交付卡进入高级详情；main 不变 |
| 新项目真实交付 | **BLOCKED** | 全局 token 预算 + 无新 DSH 审计预算；未伪造 |

## 通用质量

| 要求 | 状态 |
|---|---|
| 全量测试 | **268/268 通过** |
| 聊天持久化/刷新恢复 | PASS（真实浏览器 reload；DB） |
| 浅色/深色 | PASS（截图 01/02） |
| 395→390px 移动无横向溢出 | PASS（实测 overflow 0） |
| 高级能力不删除 | PASS（/advanced 旧 UI；API cookie 修复） |
| 无 pre-set 回复冒充 AI | PASS（真实 DeepSeek 两轮） |
| 独立审查 | 进行中/见 INDEPENDENT-REVIEW.md |
| 真实零人工 E2E | **BLOCKED** |
| 24h | **NOT_VERIFIED** |
