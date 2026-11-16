# v3.0 可靠性与 Fencing 收口

## 关键写路径 Fencing

- `startRun`：获得项目 lease/fence；规划后、创建 Run/Plan/Tasks 前 `assertProjectLease`。
- 任务执行：agent 完成后、测试前、审计写库前、提交前均校验 lease；verification retry 复用 worktree 时重新获取 lease 并校验。
- processRun 每次续租失败立即停止后续写入并暂停，不覆盖新 owner 状态。
- 既有 fencing tests（`tests/fencing*.test.js`、`control-lease`）全量通过。

## 崩溃恢复

- Run/Plan/Tasks 半创建：
  - queued 无 tasks Run 恢复时 failed，不占项目；
  - pending requestKey 对账绑定已有 Run；无 tasks 的 Run 清为 failed 并把任务回队列；
  - plan 模式恢复任务可消费。
- 自动修复：
  - `prepareAutoRepair` 先保存 Agent 失败产物到修复基线；重试幂等（`task.result_json.autoRepairBaseline`），不重复创建 branch；
  - 失败 Run 在入修复队列前终态化为 failed，避免 `PROJECT_BUSY`；
  - 同一 Run 已有修复任务不重复创建；`auto_repair_max` 有界。
- 质量门：
  - max_rounds、队列空、重复轮次通知三个入口都不能绕过 `qualityGateIncomplete`；
  - quality worktree 创建失败/缺少 planHead 直接 blocked，绝不退回主目录；
  - 质量绑定 `planHead`/testedHash，测试后哈希变化拒绝提交。
- 测试/契约：
  - 契约基线哈希任务前校验，修改即失败并恢复；
  - 测试在首轮真实通过后冻结并加入 protected paths；
  - 无有效测试 => BLOCKED/UNKNOWN，不 completed。

## 故障分类

- 审计 UNKNOWN：有界 verification retry（`auto_verification_retry_max`）。
- 依赖缺失/exit=127：显式 `test_setup_command` 或 require_real_tests 的自动依赖安装；失败 `TEST_SETUP_FAILED`，不生成产品修复任务。
- Agent/审计超时、无输出、基础设施、同签名重复失败均有既有有界停止/切换策略。
- 纯预算/授权策略阻塞不生成产品修复任务，保留 BLOCKED。

## 残余

- 全部 Git/质量写路径的穷举 Fencing 仍为 UNKNOWN（已有主要入口校验，但未做形式化证明）。
- 真实新项目 E2E 未执行（预算/授权），因此真实审计/自动修复闭环未验证。
- 初始产品测试由 Coding Agent 在首轮生成，受“去注释断言 + >=2 断言 + 引用/使用产品符号 + 拒绝 process/console 伪造 + Workbench 独立 runner 直接执行 + 可解析测试数 + 独立审计 + 首轮通过后冻结 tests/package.json/runner config”约束；仍不是对任意业务行为的完备证明，真实 E2E 未验证。
