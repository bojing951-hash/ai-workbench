# AI Workbench v3.1 — 最终可靠性收尾与自主研发验收

基线：v3.0.0 / Draft PR #12。分支：`v3.1.0`；Draft PR **#13**。

## 本轮目标与结论

- **P0-1 真正暂停/恢复**：实现 Run 级真实暂停（abort Agent、等待 `running` 集合清空后才落 `paused`）；恢复校验 Run 状态、重置中断任务、保留 passed/commit；预算/超时暂停不允许自动继续。
- **P0-2 验收决定完成**：冻结 `TEST_PLAN` 的每个验收条款必须有真实 PASS 审计证据；缺失时自动生成验收修复任务，超过上限 BLOCKED；Planner no_task / max_rounds / 空队列均不能绕过。
- **P1-1 版本化测试基线**：永久保护原始契约/隐藏测试；允许新增测试，首轮后按任务版本化冻结 existing tests + package/lockfile/runner config；已有测试被修改立即阻断。
- **P1-2 原子预算预留**：`model_reservations` SQLite 事务预留；Chat/Planner/Coding/Audit 预检、结算、释放；多独立 Node 进程并发不能超授权额度；GLM 逐次身份；DSH 专项预算独立。
- **P1-3 控制权限/幂等**：控制动作绑定 conversation/project/loop/run/request key；跨对话重放、跨项目控制、Fencing 失效拒绝；查询真实状态。
- **P1-4 崩溃恢复**：沿用并扩展 Run/Plan/Task、auto-repair baseline、测试/契约冻结恢复；无法安全恢复时保留现场 BLOCKED。

## 验证

- 串行全量：**289 tests / 285 pass / 4 skipped / 0 fail**（最终串行环境 Docker/symlink 能力不可用；Docker 可用时同套件曾 289/289）（`demo/evidence/v3.1/tests.log`）。
- Playwright：15/15 PASS，page errors 0（`demo/evidence/v3.1/ui/`）。
- 真实 Agent 暂停/恢复测试：`tests/v3-pause-resume.test.js`。
- 缺失验收条款测试：`tests/v3-acceptance.test.js`。
- 测试基线演进：`tests/v3-contract.test.js`。
- 多进程预算：`tests/v3-budget-reservation.test.js`。
- 跨对话控制重放：`tests/v3-controls.test.js`。

## 真实 E2E / 24H

- 真实新项目 E2E：**BLOCKED**（剩余约 8,654 tokens < 10,000 单任务预检；无新项目 DSH 专项授权；未提高/重置/挪用预算）。
- 24H：**NOT_VERIFIED**。
- 未合并 main、未部署、未修改 CDL/Reading Queue/Global Opportunity Engine/Investment Agent。
