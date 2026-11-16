# 可靠性测试与故障注入

## 1. 双完整 HTTP Workbench 服务竞争

测试：`tests/fencing-http.test.js`

- 两个真实 `bin/workbench.js serve` 进程，不同端口，同一个隔离 DB / 同一个 Git 项目。
- 并发对同一项目 POST 两个 `startRun`。
- 结果：**恰好一个 201**；另一个 `PROJECT_LEASE_HELD`/`PROJECT_BUSY`；数据库中只有 1 个 run。
- 非 owner 控制写入的确定性验证在 `tests/control-lease.test.js`（pause/cancel/resume 均被 PROJECT_LEASE_HELD 拒绝；失败不泄漏租约）；HTTP 竞争测试本身只验证 run 创建单写，避免依赖 Agent 生命周期。
- 局限：只覆盖 run 创建与控制取消，不是所有 Git/质量写路径。

## 2. 活跃任务中 SIGKILL

隔离实例：`/tmp/wb-fault-*`，独立 Workbench 代码复制 + 独立 DB + 独立 Supervisor + 临时 Git 项目（非 A/B/CDL，非 Reading Queue 产品）。
使用真实模型 Agent（候选实例选择 DSH Agent；不是 Mock Agent），任务实际进入 coding/audit。

### 修复前失败
- `fault-injection-before-fix.log`：
  `recoveredRuns:[{"runId":"run_mwiws35q508a7352","resumed":false,"reason":"项目写租约由其他执行者持有（wb:53050:..., fence=1），拒绝控制写入"}]`
- 根因：旧进程被 SIGKILL 后，30 分钟租约未过期；启动恢复只清过期租约。

### 最小修复
`src/db.js clearLeasesFromDeadProcesses()`：按 `wb:<pid>:` 检查进程存活；只清死亡 pid 的 project/run 租约；活 owner 保留。
`src/orchestrator.js recoverOrphans()` 先调用该清理，再恢复。
`tests/fencing.test.js` 验证 dead owner 清、live owner 不清。

### 修复后
- 重启候选 Supervisor 后日志：
  `"recoveredRuns":[{"runId":"run_mwiws35q508a7352","resumed":true}]`
- run 恢复后继续 coding/test/audit；为避免无授权的新 DSH 费用，在审计进行中人工取消，审计结果为 `audit_error`（LLM 调用已取消），**没有伪造 PASS**。
- 没有重复 run；没有把旧结果覆盖新结果；任务历史保留。
- Supervisor state：crash 1 / restart 1 / new child healthy。
- 局限：取消发生在 audit 阶段；不是完整产品交付恢复；候选 Agent 是 DSH，不是 Claude Code。

## 3. Agent 超时/无响应

历史真实 E2E 中已发生 1 次 Claude 超时：attempt `agent_timeout` → 自动新会话继续并完成任务。证据：`reading-queue-e2e.json` attempts（8 次，1 timeout）。

## 4. 审计异常不能伪造 PASS

候选故障中取消运行后事件：
`audit_error 独立审计无法完成：LLM 调用已被取消` → `task_failed`；audit 表没有 PASS。
历史产品 E2E 中 DSH FAIL/UNKNOWN 多次，最终才 PASS。

## 5. 幂等/重复提交

- 双 HTTP 竞争：数据库只有 1 个 run。
- 活跃 SIGKILL 恢复：同一个 run 继续，不创建第二个 run；任务 attempts 增加但无重复 run/commit。
- 证据一致性测试校验产品 commit 存在于 Git 仓库。
