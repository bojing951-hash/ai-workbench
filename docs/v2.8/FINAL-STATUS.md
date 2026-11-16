# v2.8 最终状态（12 问）

1. **一次输入后能自主规划？** 是，既有 Planner/Loop；本轮补齐失败后的自动修复状态迁移。真实新 E2E 未跑（BLOCKED）。
2. **质量缺陷自动形成修复任务？** 是；质量闭环已有，本轮补 clause 证据门槛、Docker 隔离、自动审计/测试失败修复任务。
3. **还需要人工 CDL-6/CDL-7？** 新代码的 `maybeAutoRepair` 会在 paused failed Run 上自动生成 `[Auto Repair]` 并继续同一 loop；离线/真实 startRun 回归通过。真实 Agent E2E 因无新 DSH 预算未验证。
4. **Agent 超时/依赖缺失/审计 UNKNOWN 自动恢复？**
   - timeout/max_turns：已有 fallback + 本轮 auto repair；
   - 依赖 exit127：显式 `test_setup_command` 自动一次重试（测试通过）；
   - audit UNKNOWN：优先自动 `retryVerification`，不生成代码修复任务（测试通过）。
5. **崩溃丢任务/重复提交？** pending/requestKey 原子认领 + 唯一索引；真实子进程 SIGKILL 两窗口测试通过；不丢任务、不重复 Run。半创建 Run 清理已加。
6. **全部关键写入 Fencing？** PARTIAL；控制 API、loop 写、auto repair、dead/live owner 覆盖；所有 Git/质量路径穷举 UNKNOWN。
7. **质量检查真正安全隔离？** Docker 默认隔离，Docker/镜像不可用 fail-closed；host 模式必须显式 acknowledgment（仅测试/受信夹具）；容器内真实执行、网络 none、无宿主凭据泄漏；timeout/cancel 测试通过。
8. **每个验收子条款可追溯？** 已实现 clause 级矩阵、契约 Markdown→clause plan、每 clause status/evidence、quality binding command/run/commit；自动生成可执行测试仍 PARTIAL。
9. **真正零人工干预真实产品 E2E？** **BLOCKED**。新隔离项目需要新的独立 DSH 审计预算/授权；不能挪用 CDL/Reading Queue；未伪造。
10. **24 小时连续研发？** **NOT_VERIFIED**。
11. **实际模型调用/时间/费用/失败？** 本轮整改只跑本地测试/Docker，**新模型 API 调用 0、DSH 0、GLM 0**；失败注入：SIGKILL 2、Docker 不可用/质量超时/取消测试、auto repair/auto audit retry 状态机测试。CDL v0.2 历史费用保留而非本轮新增（GLM ¥63.1105，DSH 估算 ¥1.6253）。
12. **还阻碍完全放手的问题？** 新独立 DSH 预算；真实新 E2E；active task 全阶段 SIGKILL；所有写路径 fencing；自动可执行测试生成；audits 直接 commit 绑定；24h。
