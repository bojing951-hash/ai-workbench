# AI Workbench v3.2 — 最终 P0 整改与正式验收准备

基线：v3.1.0 / Draft PR #13。分支：`v3.2.0`；Draft PR **#14**。

## 本轮 P0

### P0-1 两级验收

- **任务级 Run**：单个 Loop task 通过测试/独立审计/Git commit 后，只完成任务级验收；不再要求单 Run 覆盖全部产品条款。
- **产品级验收**：所有计划任务结束、Planner no_task / 队列空 / max_rounds 时，在**最终 Git SHA** 上重新独立审计全部冻结验收条款；历史 PASS 不能替代最终 Commit。
- 缺失条款自动生成产品验收修复任务（交给后续开发）；达到上限安全 BLOCKED。
- `acceptRun` 对 Loop 任务级 Run 拒绝提前验收；只有 productAcceptance PASS 才可验收。
- 真实 SQLite/Git/Orchestrator/Loop/测试执行；离线 Agent/Planner/Audit 模拟已在测试中明确标注。
- 测试：`tests/v32-product-gate.test.js`（A→B→C 正向、缺失 B、修改 A、Planner no_task）。

### P0-2 预算预留与未知费用

- released/expired/unknown 的相同 requestKey 重试必须重新执行完整预算检查；不再无检查占额。
- settled 同 key 直接返回既有结算，不产生新付费调用。
- 未知用量/超时/进程崩溃：预留转 `unknown`，按估算额度继续占用，不当作免费；到期预留转 unknown。
- 未知 Provider 不豁免；GLM 仅逐调用实际身份。
- DSH `project_audit` 不进入全局预留分母。
- 测试：`tests/v3-budget-reservation.test.js`（含 1000/900/400 released retry 拒绝、多进程并发、settled 重放、过期 unknown、DSH 隔离、混合 unknown）。

## 验证基线

- 串行全量：**299 tests / 295 pass / 4 skipped / 0 fail**（最终环境 Docker/symlink 不可用）。
- Playwright：15/15 PASS，page errors 0。
- 真实 E2E：**BLOCKED**（剩余约 8,654 tokens < 10,000 单任务预检；无新项目 DSH 授权）。
- 24H：**NOT_VERIFIED**。
- 未合并 main、未部署、未修改其他业务项目。
