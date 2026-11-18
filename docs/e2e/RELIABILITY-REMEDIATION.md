# 首次真实 E2E 失败后的可靠性整改

基线：v3.3.0 / PR #15。首次真实 E2E 已 FAILED，本轮只修可靠性，不启动新的付费 E2E。

## P0-1 Coding Agent 看门狗

根因：
- 旧进度指纹只看 `git status` 文件数 + `git diff --numstat`；
- 新增 untracked 文件内容变化不会改变这两个值；
- 容器内 Claude Code 没有持续 Git diff/事件，15 分钟无进展阈值误杀。

修复：
- `worktreeProgressSignal` 递归遍历 worktree（跳过 `.git`/`node_modules`/`.workbench`），对每个文件记录路径、size、mtime、内容 SHA-256；新增文件、同大小内容更新都能被发现；
- 保留结构化 Agent 事件心跳（真实事件才更新）；
- 容器 Agent 使用独立、有界的 45 分钟 watchdog（`CONTAINER_AGENT_STALL_TIMEOUT_MS`，可配置），不是无限延长；
- 文件持续写入/事件持续产生不会误杀；
- 真死锁仍会中止；中止后保留 worktree、日志、session、usage 和检查点 artifact。

测试：`tests/v35-watchdog.test.js`（5 tests），包括 untracked 内容更新、持续写新文件、容器长模型响应、真死锁、日志/文件保留。

## P0-2 Docker 生命周期与孤儿恢复

- 每个容器注入 Run/Task/Project/Owner/Fence labels；
- 正常结束 `finally docker rm -f`；
- 启动时 `cleanupOrphanContainers` 扫描 `ai-workbench.container` 标签/名称：
  - owner 进程仍存活且 lease owner+fence 有效 → 保留；
  - 其他 Workbench 容器 → 清理；
  - 无有效执行者/历史无标签容器 → 清理；
- `bin/workbench.js serve` 启动时先清理，再恢复 Run/Loop；
- 与现有 project lease/fence 对账，避免误杀有效执行者。

测试：`tests/v35-container-recovery.test.js`（真实 Docker 孤儿容器回收 + labels）。

残余：容器登记目前使用 Docker labels（含 ID 由 docker 返回）而非独立 SQLite 表；启动清理已验证，但真实 SIGKILL 全阶段未重新跑。

## P0-3 基础设施 vs 产品修复分离

- 失败分类：
  - stalled / timeout / aborted / Docker / network / lease / permission → **基础设施**
  - test/audit/acceptance 失败 → 产品缺陷
- 基础设施失败：
  - 不进入 Auto Repair；
  - 不消耗产品修复次数；
  - 不切到未授权 Agent；
  - 保存 agent-checkpoint artifact、worktree、session/log；
  - task blocked + run paused，等待有效恢复。
- 产品失败：
  - 仍生成产品修复任务、重测、独立审计；
  - 不降低验收标准。
- 恢复保留原授权 Agent（实验绑定守卫）。

测试：`tests/v35-infra-recovery.test.js`。

## P1 真实用量

- Claude Code 容器真实 usage 会 settle 到实验 reservation；实际远超 12k 估算时仍受实验总/GLM 分项上限与 stop 状态约束；
- 未结算预留转 UNKNOWN，不视为免费；
- 不重置历史账本。

## 真实失败产品回归（隔离副本，不是新 E2E）

产品：本地消费记录小站。

- 原始失败：`alerts.test.mjs` 无记录/空范围时仍触发 floor 预警；
- 根因：`evaluateAlerts` 未检查范围内是否有记录；
- 修复：`inRange.length > 0` 才触发结余预警；
- 结果：**25/25 tests PASS**；
- 证据：
  - `demo/evidence/product-regression/product/`（修复副本）
  - `demo/evidence/product-regression/fix.diff`
  - `demo/evidence/product-regression/fixed-tests.log`

这是产品能力回归，**不冒充** Workbench 已完成新一轮真实零人工 E2E。

## 回归

- 本地全量（Docker 可用）：见 `demo/evidence/e2e-safety/tests.log`；目标 373/373/0。
- Docker 容器测试：通过。
- 独立审查：待审。
- 新真实 E2E：**AUTHORIZATION_REQUIRED**（旧实验已 FAILED，不能复用）。
- 24H：**NOT_VERIFIED**。

## 真实 Workbench Server SIGKILL（v3.5）

新增 `tests/v35-workbench-server-sigkill.test.js`：

- 真实启动 `bin/workbench.js serve`；
- 独立 SQLite、真实 Git 仓库、真实 Worktree；
- 零付费 `custom` Coding Agent 写入真实未提交代码；
- 对 Coding 中的 Workbench Server 做真实进程组 SIGKILL；
- 重启 Server，启动清理、`recoverOrphans`、`recoverSupervisedRuns`；
- 自动恢复原 Run/Task/Worktree/Session；
- 原 Agent 继续编码；
- 真实测试、mock 独立审计（零厂商费用）、Git Commit；
- 最终 `awaiting_acceptance`；
- 不人工 Resume、不重复 Run/Task、不重复付费。

结果：**PASS**（1/1）。Testing/Auditing/Committing 阶段故障注入仍为 UNKNOWN。
