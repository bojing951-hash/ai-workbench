# v3.0 条款级验收矩阵

| 条款 | 要求 | 实现/证据 | 状态 |
|---|---|---|---|
| P0-1a | 首页第一次输入进入真实模型流程 | `web/chat.js startFromText` 不再占用 sending；Playwright 首条消息检查 pass | PASS |
| P0-1b | 一条用户消息只发送一次 | `clientMessageId` 唯一索引 + per-conversation 锁；HTTP 并发测试只 1 次上游调用 | PASS |
| P0-1c | 网络失败安全重试 | 同 key 重试删除错误回复、复用用户消息；HTTP 测试 | PASS |
| P0-1d | 刷新不丢消息/状态 | SQLite 持久化；Playwright reload 后消息仍在 | PASS |
| P0-1e | 快速重复点击不重复项目/消息 | start/message 双端串行+幂等；浏览器重复 Enter 测试 | PASS |
| P0-2a | 新项目不预置 `testCommand=true` | `src/chat.js` 设 `testCommand:''`；`tests/chat.test.js` 断言 | PASS |
| P0-2b | 建立真实测试计划/按栈运行 | `TEST_PLAN.json`、detectTestCommand、auto_test_setup；`v3-contract` 集成测试真实 `npm test` | PASS |
| P0-2c | 无有效测试不可 PASS | 必须产品测试文件、>=2 断言、引用产品代码、可解析测试数量；Workbench 用独立 runner 直接执行测试文件，不信 Agent 自报输出；0 tests/无测试文件/trivial/常见伪造输出/无产品引用测试 blocked（启发式） | PASS |
| P0-2d | 退出码 0 不等于合格 | 无测试数量 => `TEST_OUTPUT_NO_COUNT`；单元测试覆盖 | PASS |
| P0-2e | 保留真实测试证据 | test artifact + `res.realTestEvidence`；成功后测试哈希冻结 | PASS |
| P0-2f | Agent 不能自改测试/验收 | frozen `tests/**` + `package.json`/lockfile/test config + protected paths + contract baseline；单元/集成测试 | PASS |
| P0-3a | CONTRACT/验收计划/隐藏测试冻结 | SHA256 baseline 写入 config；任务前校验；修改失败/恢复 | PASS |
| P0-3b | 验收基线哈希绑定 | `contract_baseline` 包含 4 个文件；`tests/v3-contract` | PASS |
| P0-3c | 新增测试需授权/可信验证 | 首轮真实测试通过后冻结 tests/**、package.json/lockfile/runner config；后续修改被保护；隐藏契约测试绑定全部验收项 | PASS（流程），未实现 UI 授权更新按钮 |
| P0-4a | Chat 调用前预检 | `chatTurn` -> `assertModelBudget`；HTTP 超预算 409、上游 0 调用 | PASS |
| P0-4b | 调用后真实 Usage | `llm_usage` chat 行 + provider/model/usage/cost source | PASS |
| P0-4c | Planner/Coding/Audit 同一账本 | Planner 预检；ATTEMPT/AUDIT 触发器入账；迁移回填 | PASS |
| P0-4d | 区分厂商/估算/未知 | `usage_known/cost_source/provider_known`；unknown 不豁免 | PASS |
| P0-4e | GLM 豁免仅实际身份 | `resolveLlmIdentity` + 实际 GLM Key/端点配置；未知 provider 测试 blocked | PASS |
| P0-4f | 不绕过/不重置/不挪用 | 未改预算 env；账本迁移保留历史用量；未使用专项审计预算 | PASS |
| P1-1 | 对话开始开发 | 自然语言 `start` 控制 + 原“开始开发”按钮；复用 Loop/Orchestrator | PASS（离线） |
| P1-2 | 查询进度/当前任务/失败/成本/测试/审计/交付 | controls.js 真实 DB 快照；HTTP 控制测试 | PASS |
| P1-3 | 暂停/继续 | 白名单控制 -> LoopManager.pause/resume；action 持久化 | PASS |
| P1-4 | 明确受限协议、无任意 shell/Git | 固定白名单/正则；模型 intent 不作为命令执行 | PASS |
| P1-5 | 操作仅限对话关联项目 | conversation.project_id/loop 校验；跨项目测试拒绝 | PASS |
| P1-6 | 控制动作持久/可审计/幂等/可恢复 | actions.request_key 唯一 + status/result；测试 | PASS |
| P1-7 | Chat/Loop/Run 状态分离 | conversation.status 不在 pause/resume 时覆盖 loop/run | PASS |
| P1-8 | 保持 Apple 风格 UI | 原 UI + 控制栏/控制卡；Playwright mobile 0 overflow | PASS |
| P1-R1 | 自动修复 Git 基线/终态/入队崩溃恢复 | prepareAutoRepair baseline 幂等（新测试）；失败 Run 终态化 + 队列 | PASS（单元/集成） |
| P1-R2 | Run/Plan/Tasks 半创建对账 | 已有恢复逻辑 + crash/loop-recovery 测试 | PASS |
| P1-R3 | 关键写入 Fencing | 创建 Run/测试/审计/提交/验证重试前 lease 校验；既有 fencing tests | PASS（代码+回归） |
| P1-R4 | 质量绑定实际 Commit SHA | quality worktree 在 planHead，失败 fail-closed；既有测试 | PASS |
| P1-R5 | Requirement 冲突不覆盖 | 冲突 UNKNOWN/P0；既有 quality 测试 | PASS |
| P1-R6 | 质量未 PASS/修复未完成不 completed | 质量门 + duplicate history 修复；新测试 | PASS |
| P1-R7 | 自测自证防护 | 去注释断言、拒绝 process.exit/console/stdout 伪造、断言必须引用产品符号；冻结 tests/package/runner；残余：弱断言/自写测试的“行为真实性”最终仍依赖独立审计 | PARTIAL |
| P1-R8 | 审计 UNKNOWN/依赖/超时有界恢复 | 既有 auto repair/verification retry + 故障分类 | PASS（回归） |
| P1-R9 | 不再要求人工建 CDL-6/7 | 自动修复队列/失败终态/恢复；auto-repair 测试 | PASS（代码），真实 E2E 未验证 |
| E2E | 真实新项目零人工开发 | 全局余额约 8,654 < 10,000 预检；无新 DSH 授权 | **BLOCKED** |
| 24H | 真实 24 小时运行 | 未执行 | **NOT_VERIFIED** |
| 安全 | 未合并 main/未部署/未修改业务产品 | 未执行合并/部署；未触碰 CDL/Reading Queue/A/B | PASS |

## 测试统计

- `npm test`：**280 tests / 278 pass / 2 skipped / 0 fail**（跳过项为平台 symlink 能力检测；不是失败）。
- 新增/扩展：
  - `tests/chat-http.test.js` — 首条消息/并发/重试/自然语言控制/预算。
  - `tests/v3-contract.test.js` — 真实测试门禁/契约哈希/测试冻结。
  - `tests/v3-budget-chat.test.js` — 统一账本/GLM 豁免/超预算。
  - `tests/v3-controls.test.js` — 控制白名单/真实状态/幂等/跨项目拒绝。
  - `tests/loop-quality-gate.test.js` — duplicate history 质量门。
  - `tests/auto-repair.test.js` — baseline 重试幂等。
- 浏览器回归：`demo/evidence/v3.0/ui/playwright-result.json` ok=true。


## 必须保留的残余事实

1. P0-2 的“空测试/伪造输出/未引用产品代码的自证测试”已封堵；但 Workbench 无法对任意产品自动证明测试断言覆盖了每一条业务行为。独立审计仍是行为验收层；真实 E2E 未执行，因此“任意新项目零人工真实交付”未验证。
2. P0-3 的隐藏契约测试验证契约文本与验收项绑定、文件完整性，不自动验证实现行为。
3. 24H、真实 DSH 审计、真实自动修复闭环仍 **NOT_VERIFIED**。
