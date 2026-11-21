# v3.1 条款级验收矩阵

| 条款 | 要求 | 证据 | 状态 |
|---|---|---|---|
| P0-1a | 暂停请求真正停止 Agent | `pauseRun` abort + `waitForRunStop`；fake Agent 延迟 1s 停止，pause 等待后返回 | PASS（离线真实进程语义） |
| P0-1b | Agent 未停止不显示暂停 | 超时抛 `PAUSE_TIMEOUT`，保持 running；Loop 只在 Run paused 后改 Loop | PASS |
| P0-1c | 恢复原 Run/检查点 | `resumeRun` 重置中断 task、保留 passed/commit；`v3-pause-resume` 完成 awaiting | PASS |
| P0-1d | 不丢已完成代码/审计/Git | resume 只 requeue 非终态 task；existing tests + pause test commit 断言 | PASS |
| P0-1e | 不重复已完成任务 | pause test 第二次仅 1 次 Agent；resume 后 task passed/commit | PASS |
| P0-1f | pause/resume 幂等 | pause 对终态返回；resume 对 running/queued/awaiting 返回；Fencing 仍先校验 | PASS |
| P0-1g | 预算/超时暂停不可自动解除 | `RUN_PAUSED_BY_BUDGET`；`v3-budget-reservation` 测试 | PASS |
| P0-2a | 冻结验收契约决定完成 | `contractAcceptanceStatus` + finalize gate | PASS |
| P0-2b | 每条款需真实 PASS 审计证据 | 审计 criteria/evidence 匹配；缺证据自动修复 | PASS（fake audit 验证，真实 DSH 未跑） |
| P0-2c | 无质量检查不显示通过 | 缺失 => acceptance_incomplete paused/BLOCKED | PASS |
| P0-2d | no_task/max_rounds/空队列不完成 | Loop 三入口 contract gate；Planner no_task blocked | PASS（代码/单元） |
| P0-2e | 产品缺陷进入修复队列 | `v3-acceptance` 自动创建 repair task 并调用 Agent | PASS |
| P0-2f | 不能删/改契约/已有测试 | 契约 SHA + 测试基线精确哈希/保护；修改拒绝 | PASS |
| P1-1a | 永久保护原始契约/隐藏测试 | contract baseline + tests/acceptance glob | PASS |
| P1-1b | 允许新增合法测试 | 新测试不匹配旧基线，允许；`freezeTestBaseline` 版本+1 | PASS |
| P1-1c | 已有测试/runner 不可改 | 精确文件保护 + `verifyTestBaseline` + package/lockfile config | PASS |
| P1-1d | 测试基线记录原因/来源/Git SHA/哈希 | history 记录 meta + files/hashes；run/task 来源 | PASS（Git SHA 可在 verification 中补） |
| P1-1e | 依赖/框架更新可审计 | runner config 受保护；变更需显式授权（接口未做 UI） | PARTIAL |
| P1-2a | 所有受限模型调用预留 | Chat/Planner/Coding/Audit 加入预留；DSH 专项独立 | PASS（代码/测试） |
| P1-2b | SQLite 事务+唯一调用 ID | `BEGIN IMMEDIATE` + request_key unique | PASS |
| P1-2c | 成功后实际 Usage 结算 | settle + ledger | PASS |
| P1-2d | 失败/超时/崩溃释放预留 | release on throw/abort；TTL expired；测试 | PASS（crash 预留 TTL 未做真实 SIGKILL） |
| P1-2e | 未知用量不免费 | usage_known=0 / unknown provider 不豁免 | PASS |
| P1-2f | GLM 逐次身份 | `assertModelBudget`/resolveLlmIdentity；unknown blocked | PASS |
| P1-2g | 不修改授权额度 | 未改 env/预算 | PASS |
| P1-3a | 控制动作绑定五元组 | action payload conversation/project/loop/run/requestKey | PARTIAL（runId 对 query 未写入） |
| P1-3b | 幂等结果前重验归属 | action conversation/type/project/loop 校验 | PASS |
| P1-3c | 跨对话/跨项目重放拒绝 | request key 跨对话测试；跨项目 Loop 测试 | PASS |
| P1-3d | 修改前 Fencing | pause/resume ensureControlLease；控制测试 | PASS |
| P1-3e | 模型不执行 shell/Git | 白名单解析 + 现有 Loop API | PASS |
| P1-3f | 查询真实状态 | controls.js 读 DB | PASS |
| P1-4a | Run/Plan/Tasks 创建崩溃 | existing crash-injection + recovery tests | PASS |
| P1-4b | Agent 执行崩溃 | pause/abort 保留 task；SIGKILL agent 阶段未做真实子进程日志 | PARTIAL |
| P1-4c | 测试/审计崩溃 | 现有 recovery + 失败分类 | PARTIAL |
| P1-4d | auto repair Git baseline 崩溃 | prepareAutoRepair 幂等测试 | PASS |
| P1-4e | 修复任务入队/Git 提交崩溃 | 现有恢复 + 质量/验收 gate；未做每阶段 SIGKILL | PARTIAL |
| E2E | 真实零人工产品 E2E | 剩余约 8,654 tokens < 10k；无新 DSH 授权 | **BLOCKED** |
| 24H | 真实 24h | 未执行 | **NOT_VERIFIED** |

## 全量验证

- 串行全量：**289 tests / 285 pass / 4 skipped / 0 fail**（最终串行环境 Docker/symlink 能力不可用；Docker 可用时同套件曾 289/289）（`demo/evidence/v3.1/tests.log`）。
- Playwright：15/15，page errors 0（`demo/evidence/v3.1/ui/playwright-result.json`）。
- 真实 HTTP：`tests/chat-http.test.js`。
- 严格未执行：真实新项目 Coding/DSH Audit/自动修复 E2E、真实 Agent SIGKILL 各阶段、24H。
