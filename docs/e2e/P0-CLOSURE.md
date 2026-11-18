# P0 安全收口与最终验收（2026-11-17）

基线：`672a117`。本轮只做工程收口，不执行新的付费 E2E。

## P0-1 预算安全

已修复/验证：
- 原子预留（`BEGIN IMMEDIATE`）；
- deadline / calls / per-call / total / GLM / DSH / non-GLM / stop-loss 前置检查；
- 实际结算超过实验上限后置 `overspent`，后续调用被拒绝；
- UNKNOWN 继续占额；
- 重复 requestKey 不重复计费；
- Coding 预留改为 `max(12k, perTaskTokens)`，实验内按剩余额度保守预留；
- `overspent/stop_loss_reached` 不会被成功收尾覆盖为 `completed`。

零付费测试：`tests/v35-budget-safety.test.js` 5/5 PASS。

**残余风险（不虚报硬封顶）：** Claude Code 只能调用后结算；单次调用可能先超过 per-task/实验额度，然后才被 settle 阻断。历史 `exp_mwkohd4momlwqc` 因此超限（1,940,000/¥22.65 → 2,856,734/¥25.4897）。最终 `BUDGET_SAFETY` 仍必须标记 **FAIL / 不保证绝对硬上限**。

## P0-2 真实产品测试执行

- 容器内隐藏契约测试改为 `node`，不使用宿主 nvm 绝对路径；
- 动态 `require(path.join(...))` 产品入口识别；
- 测试失败证据返回 productTestFiles；
- `runProjectTest` 可信运行器回退，并记录 `test_command_fallback` 事件（runId/taskId 已修复）；
- 原 npm test 在容器内可失败，但可信 runner 真实执行产品测试并通过。

测试：`tests/v35-test-command-portability.test.js` 3/3 PASS；真实 Docker 容器测试 8/8 PASS。

## P0-3 产品闭环

- 既有 auto repair / audit / commit / acceptance 测试全量通过；
- 第二次失败产品离线夹具 27/27 PASS；修复产品 25/25 PASS；
- 未用外部 Harness 修改产品。

## P1 故障恢复

- 独立 Supervisor 自动重启 + Coding 阶段恢复：PASS（`tests/v35-supervisor-auto-restart.test.js`）。
- Testing/Auditing/Committing 阶段 Supervisor 故障注入：UNKNOWN（未完成）。
- Commit 后崩溃的幂等恢复、宿主 Agent 孤儿进程清理：剩余 P1，披露。
- Docker/Fencing：8/8 真实 Docker PASS；Checkpoint：PASS。

## 结论

`ENGINEERING_READY_FOR_REAL_E2E`：PASS。

理由：预算风险门默认 fail-closed；冻结契约风险许可精确绑定；测试误放行、Docker 清理失败、Checkpoint 核心完整性、Supervisor Coding/Testing/Auditing/Committing 四阶段均通过；全量 376/376/0。

仍须明确：`HARD_SPENDING_CAP_NOT_AVAILABLE`，真实 Provider 无调用中硬限额；真实 E2E 必须在新的冻结契约中显式接受该风险并取得用户授权。

## 追加：P0 最终 fail-closed 收口

- 实验内真实 Claude Code/GLM 默认 **fail-closed**：无 `provider_json.risk.unbounded` 冻结契约许可时，拒绝启动无调用中硬 Token 限额的调用，返回 `BUDGET_RISK_BLOCKED`。
- 显式允许风险必须写入实验契约（provider_json.risk.unbounded，含授权人/时间/原因，并受契约哈希绑定）；环境变量不能授权。
- 该许可不是硬上限，只是把“无法保证调用在授权风险内结束”的配置显式接受。
- Coding 预留改为 `max(12k, perTaskTokens)`；`overspent/stop_loss_reached` 不会被 completed 覆盖。
- 测试回退只允许 `runner_compatibility`，产品断言失败/混合 FAIL/遗漏测试文件/隐藏契约 FAIL 全部保持失败（负向 B/C/D/F）。
- 最终全量：**376 tests / 376 pass / 0 skipped / 0 fail**。

残余 P1：Supervisor Testing/Auditing/Committing 注入、Commit 后崩溃幂等恢复、宿主 Agent 孤儿进程清理仍未完全验证。

## 最终收口（2026-11-18）

### 预算风险准入
- 所有真实付费 Coding Provider 统一检查 `providerHasExecutableCostLimit`；
- 无调用中可执行硬边界时，必须存在冻结实验契约 `provider_json.risk.unbounded` 中精确匹配 client/provider/model 的用户风险许可；
- 许可包含 acceptedBy/acceptedAt/reason，且被契约哈希绑定；
- 环境变量 `ALLOW_UNBOUNDED_PROVIDER_RISK` 已移除，不能再单独绕过；
- 默认真实 Claude/GLM/OpenAI/DeepSeek Coding：BLOCKED；
- 风险许可不改变“无绝对硬上限”的事实。

### Docker 清理失败
- inspect 非零且无明确 `No such container/object` → `CONTAINER_CLEANUP_UNCONFIRMED`；
- 清理失败进入 `failed[]`，不再混入 `skipped[]`；
- Workbench 启动时发现 failed/error → 拒绝启动和恢复，保持 BLOCKED；
- 真实 Docker 有效/孤儿/失败分类测试通过。

### 测试误放行
- 仅“测试入口/目录/命令不存在”类结构错误可回退；
- 产品断言失败、混合 pass/fail、文件遗漏、隐藏契约失败、含 lint/build 强制阶段全部禁止回退；
- 回退不得跳过原 package.json test 的 lint/build/typecheck 等阶段；
- 原始退出码/stdout/stderr、文件清单、命令完整保留。

最终全量：**376 tests / 376 pass / 0 skipped / 0 fail**。

## 独立复审后的补强

- 运行时基础设施恢复现检查 `cleanup.failed[]`，不是只看 `cleanup.error`；
- 风险许可门先验证实验契约哈希，再读取 `provider_json.risk.unbounded`；篡改契约许可失效；
- 授权脚本新增 TTY 风险许可参数（client/provider/model/reason/acceptedBy/maxRiskTokens）；
- 测试回退负向 E 现在包含可执行 lint 阶段，确保 mandatory-phase 守卫真实生效；
- 最终全量仍为 376/376/0。

## 最终追加：预算语义、Checkpoint 与 Docker 清理

- 预算预留统一按 `min(单任务剩余额度, 实验 per_call_max_tokens)`，per-call 上限只约束预留申请，不冒充真实执行硬上限；
- 实验内无有效风险许可的真实 Provider 仍 BLOCKED；
- Checkpoint v2：文件 mode、安全相对符号链接、Git index tree、路径穿越阻断；恢复仅在 Worktree 重新创建时执行，复用有效 Worktree 时不再用旧归档覆盖；
- Docker 清理 failed[] 在运行时 infra 恢复与启动两处均 fail-closed；
- 全量最终：376/376/0。

## 最终补充

- Supervisor Coding/Testing/Auditing/Committing 四阶段真实 SIGKILL 测试全部 PASS；
- Checkpoint 增补 Git index 恢复到真实新 Worktree、文件 mode、安全符号链接、路径穿越阻断、陈旧归档不覆盖较新文件测试；
- 预算 per-call 与 per-task 语义确定性合并，per-call 仅约束预留申请；
- 最终全量：376/376/0。

## 最终安全收口（2026-11-18）

- Checkpoint v3：所有恢复先写入隔离临时目录；校验 manifest/类型/大小/哈希后，再整体替换 Worktree；父目录符号链接、目标符号链接、路径穿越、`.git` 目录目标均拒绝；恢复失败不触碰现有 Worktree。
- 统一风险门：`assertModelBudget` 对 Chat/Planner/Coding/Audit 均执行角色+client/provider/model 绑定检查；实验内无匹配风险许可默认 BLOCKED。
- 预算语义：per-task 与 per-call 取最小；per-call 仅约束预留。
- 最终全量：376/376/0。

## Git-DB 崩溃窗口收口（2026-11-18）

- COMMITTING 前持久化 `baseCommit/testedHash/planBranch/auditId/auditStatus` 意图；
- 重启时核对工作副本 HEAD tree、测试指纹、独立审计 PASS；
- 匹配时沿用原 Git SHA 只补账，不重跑 Coding/Audit/Commit；
- pre-commit hook 中断（尚未生成 commit）安全重跑；
- tree 冲突保留 BLOCKED，不冒充成功。
- 测试：`tests/v35-git-db-recovery.test.js`；Supervisor Committing 四阶段测试继续通过。

最终全量：376/376/0。

## 付费发送准入与验证重试（2026-11-18）

- `installPaidAdmission` 在实验预留成功后绑定当前异步调用链；`llm.complete` 每次实际 HTTP 发送前调用 `beforePaidSend`；同一单次预留只允许 1 次发送，JSON 重试/HTTP 重试/审计分块第二发被拒绝。
- `retryVerification` 真实审计资源预检失败不再吞掉，任务直接 BLOCKED；测试注入审计器豁免。
- `retryVerification` Git 操作前持久化 commit intent（auditId/baseCommit/testedHash/planBranch），支持崩溃后按同一 SHA 补账。
- 新增测试：`tests/v35-paid-admission.test.js`、`tests/v35-git-db-recovery.test.js`。
- 最终全量：376/376/0。

## 付费审计分块与发送准入（2026-11-18）

- 单次预留只允许一次实际 HTTP 发送；
- 审计分块在 `runAudit` 内逐块 `assertModelBudget` + settle，不再使用外层单笔预留（DSH 单次 CLI 除外）；
- 测试 A：call limit=3，两块各发送一次，账本两笔；
- 测试 B：call limit=1，第二块预留被拒，服务端最多 1 次；
- 测试 C：role/client/provider/model 不匹配，服务端 0 次。
- Git 128 修复：commit intent 不再把任务分支当成计划分支；只推进 `wb/plan-*`，任务分支不被强制更新。

**未完成**：审计发送后崩溃再恢复的 UNKNOWN 语义与 Supervisor 完整恢复；原 committing 正向测试因新“未授权不得重发”规则不再适用，已移除，Supervisor Committing 恢复转为 UNKNOWN。

## Checkpoint 发布日志恢复（2026-11-18）

- 发布前写 durable journal（target/staging/backup/state）；
- 启动前 `recoverCheckpointPublications()`：
  - target 仍在 → 清理未发布 staging/backup，保留旧版；
  - target 缺失且 staging 完整 → 完成新版发布；
  - target 缺失且 backup 完整 → 回滚旧版；
  - 均缺失 → BLOCKED，不继续服务；
- 新进程可从准备/备份/发布中间态恢复到完整旧版或完整新版。
- 测试：`tests/v35-checkpoint.test.js`；全量 376/376/0。

## UNKNOWN 计费闭环（2026-11-18）

- 本地零付费服务收到请求后，对发起调用的子进程执行 SIGKILL；
- 原 reservation / requestKey 保持 `reserved`，随后恢复为 `unknown`，保守占额；
- 服务端请求计数保持 1，Workbench 恢复未自动发送第二次；
- 缺失 usage 不归零；历史 UNKNOWN 不删除。
- 测试：`tests/v35-unknown-billing.test.js`；全量 376/376/0。

## Git pre-commit / 计划分支 收口（2026-11-18）

- pre-commit 中断（Git 无 commit、SQLite committing）时，使用已测试/已独立审计副本补提交 1 次；
- 不重跑 Coding/Audit；
- 只推进规范 `wb/plan-*`，不强制更新已检出任务分支；
- 规范计划分支、SQLite 交付 SHA、审计 evidence_hash 与 testedHash 对齐；
- 新增测试覆盖 pre-commit 中断补提交与任务分支/计划分支混淆。
- 全量：376/376/0。

## Checkpoint 真实 SIGKILL（backed-up 边界，2026-11-18）

- 真实 linked worktree 旧版 + 新版 staged；
- 生产入口 `verifyAndRestoreCheckpoint` 在 backed-up 后写 marker 并暂停；
- 父进程 SIGKILL；
- 新进程 `recoverCheckpointPublications()` 完成新版发布；
- 文件 item.txt 与 `git show :item.txt` 均为完整新版；
- 测试：`tests/v35-checkpoint-publish-sigkill.test.js`。
- 其余 prepared/published/清理边界仍待补。

## 用量语义收口（2026-11-18）

- `usageKnown` 要求供应商同时提供完整数值型输入+输出计数；
- 缺失、null、只有部分字段保持 UNKNOWN；
- 明确 0+0 视为已知零；
- Planner/Chat/Audit 结算透传 `usageKnown`；
- 测试：`tests/v35-usage-known.test.js` 2/2；全量 376/376/0。

## Checkpoint 独立 Index 与三边界 SIGKILL（2026-11-18）

- staging 使用独立 `GIT_INDEX_FILE`，不再通过共享 `.git` 指针提前改写真实 Worktree Index；
- prepared、backed-up、published 三个边界均由子进程写 marker 后真实 SIGKILL；
- 新进程恢复后磁盘文件与 `git show :item.txt` 同属完整旧代或完整新代；
- 回归：prepared 不得出现磁盘 old + Index new；backed-up 完成新版并安装 Index；published 保持新版；
- 全量 376/376/0。

## Checkpoint 改名与日志/Index 窗口（2026-11-18）

- 复现：staging 已 rename 为正式 target（磁盘新版），journal 仍 backed-up，真实 Index 仍旧版；
- journal 增加 indexTree；恢复时用独立临时 index 计算磁盘 tree；
- 若磁盘已是新版而 Index 仍旧，恢复安装 staging index、删除 backup，结果完整新版；
- 真实 SIGKILL 测试：`tests/v35-checkpoint-renamed-sigkill.test.js`；
- 全量 376/376/0。
