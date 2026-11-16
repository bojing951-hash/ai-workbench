# AI Workbench v3.0 — 一键自主开发能力收口

基线：v2.9.0 / Draft PR #11。分支：`v3.0.0`。

## 本轮实际完成

- **P0-1 首页第一条消息**：修复 `startFromText`/`sendMessage` 双锁冲突；加入 conversation/message clientRequestId 幂等、并发 per-conversation 串行、失败重试与真实 HTTP/Playwright 回归。
- **P0-2 禁止空测试假 PASS**：新项目不再预置 `testCommand='true'`；生成冻结 `TEST_PLAN.json`、隐藏契约测试；按真实技术栈检测测试命令；要求真实测试文件、去注释断言、引用/使用产品符号、可解析测试数量；独立 runner 直接执行测试文件，拒绝 process/console 伪造输出；依赖准备有界执行；常见空测试/trivial/伪造输出/无产品引用测试均 BLOCKED（启发式；行为真实性由独立审计）。行为真实性最终仍由独立审计负责，真实 E2E 未验证。
- **P0-3 冻结验收契约**：`CONTRACT.md`、`ACCEPTANCE.md`、`TEST_PLAN.json`、隐藏契约测试基线 SHA256 冻结，受保护路径与任务前完整性校验；测试在首轮真实通过后冻结；Agent 不能自改验收/测试来提拔。
- **P0-4 统一模型预算**：新增 `llm_usage` 统一账本（旧 attempts/audits 回填、后续触发器入账），Chat 预检/记账、Planner 预检、Coding/Audit 原有预算路径统一；GLM 豁免只按实际身份 + 实际配置；不重置/不挪用预算。
- **P1 自然语言控制**：受限白名单 `start/status/current_task/failure/pause/resume/cost/tests/audit/delivery`；模型只解析意图，服务端基于真实 DB/现有 Loop API 执行；动作持久化在 actions、幂等、可恢复；不支持任意 shell/Git/合并/部署/扩预算。
- **P1 可靠性**：关键写路径增加 Fencing 校验；auto repair baseline 重试幂等（崩溃恢复不重复基线）；重复轮次通知不能绕过质量门；测试/契约冻结；半创建 Run/Plan/Task 对账与已有故障分类保持。
- **P1 真实状态**：所有控制/进度查询读取真实 DB；聊天 status 与 Loop/Run status 分开。

## 结论

- 全量离线测试：**280 tests / 278 pass / 2 skipped / 0 fail**（跳过项为平台 symlink 能力检测；最终日志见证据）。
- 真实浏览器回归：**PASS**（首页首条消息、单次调用、重试、刷新、控制卡、移动端无溢出、无 page errors）。
- 真实新项目 E2E：**BLOCKED**。当前全局剩余约 8,654 tokens，低于单任务 10,000 预检；且无新项目 DSH 专项审计预算/授权。未提高上限、未挪用预算、未伪造 Agent/审计/产品交付。
- 24H：**NOT_VERIFIED**。
- 未自动合并 main、未部署；未修改 CDL / Reading Queue / A/B 业务产品。

详见 `ACCEPTANCE-MATRIX.md`、`REAL-E2E.md`、`P0-P1.md`、`BROWSER-EVIDENCE.md`、`COST-LEDGER.md`。
