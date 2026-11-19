# 最终状态

- 工程回归：**380 tests / 380 pass / 0 skipped / 0 fail**（Docker 可用环境）
- Docker：PASS（真实容器测试 5/5）
- 真实 E2E：**FAILED**
  - 真实 Claude Code/GLM 容器编码已开始并产出部分产品；
  - 15 分钟 watchdog 中止，auto-repair 耗尽；
  - 部分产品 24/25 tests pass；
  - 无最终产品审计、无最终 Git SHA、无 accepted；
- 24H：**NOT_VERIFIED**
- 用户授权：已批准一次实验；已 failed，新的 E2E 需新授权。
- 预算：max 3,620,000；remaining 121,011.8 tokens；cost remaining ¥24.7544；未重置历史。
- 未合并 main、未部署、未修改其他业务项目。


最终：ENGINEERING_READY_FOR_REAL_E2E = PASS；REAL_E2E = HISTORICAL_FAILED；NEW_E2E_AUTHORIZATION = REQUIRED；24H = NOT_VERIFIED。

## 独审交接包复跑（2026-11-18）

- 包内 8 个测试文件与 `scripts/check-handoff.mjs` 已纳入仓库；
- 基线 23 项 / 10 通过 / 13 失败 → 修复后 **23 项 / 23 通过 / 0 失败 / 0 跳过**；
- 原失败逐项修复：分块审计同条款 fail 聚合、TAP pass 计数、Planner 全局/项目/实验 13 一致、默认模型风险许可、产品 no_task 终态、Checkpoint 缺 index 时 BLOCKED、提交 hook/worktree 冲突不得重派 Coding、Supervisor 503 重试；
- `npm test`（串行）：402/402/0；真实 Docker 10/10；
- `npm run accept:freeze`：第 1-6 组全部 PASS，真实 Docker 可用；唯一未执行项为**连续离线产品 E2E**（缺产品 SHA）；
- 因此工程状态仍为 **ENGINEERING_FREEZE_BLOCKED**。

## 第二轮独立审计整改（2026-11-19）

- 原版交接 23 项：基线 23/23 通过，已保留；
- 新审计补充 `tests/audit-*.test.*`：44 项全部通过；
- `audit-dsh.mjs` 已改为自动判定：主分支 checkout 两次均读取候选 commit 的 ready 快照，prompt 绑定真实 tree 与 commit，退出码 0；
- `npm test`：409/409/0；
- `npm run accept:freeze`：第 1-6 组、DSH 版本绑定、真实 Docker 均 PASS；唯一 UNEXECUTED 为连续离线产品 E2E（无产品 SHA）；
- 结论：ENGINEERING_FREEZE_BLOCKED。

## b506 独审复验整改（2026-11-19）

- 原 23 项：23/23 PASS；补充审计 44 项：44/44 PASS；独立 b506 包：8/8 PASS。
- 产品终审现在必须绑定当前候选 commit/tree、真实命令、退出码、存在的原始测试日志；旧回执/只有 commit 均 BLOCKED。
- 升级旧 dd68 账本不再重复回填 planner legacy；同一 UNKNOWN 逻辑请求无新授权不再创建第二笔预留。
- Checkpoint 发布无法对账时持久化阻断所属 Task/Run，自动/手工恢复均不派发。
- Supervisor 同时处理 recoveredRuns 和 recoveredLoops 的临时失败，成功项不重复。
- 授权 CLI 支持 `--risk-spec` 多组精确 role/client/provider/model 许可。
- 全量：419/419/0；DSH 固定快照 PASS；真实 Docker 可用。
- 仍缺：连续离线产品 E2E（无产品 SHA）、真实 Docker 双进程写入交接；因此 ENGINEERING_FREEZE_BLOCKED。

## ba544 复审整改（2026-11-19）

- 产品终审绑定数值退出码、真实 task/attempt、artifact 哈希/字节、commit/tree；日志被截断时 BLOCKED。
- Chat 显式重试许可持久单次消费；同许可重投不再发送。
- startRun Planner 结果持久化：收到回执后写 Run 失败，重投复用结果，不二次发送。
- 显式任务跳过 Planner 预留/用量；豁免 GLM 与回退路由按实际 provider/model 记 13。
- 历史 mirror 仅在可证明 planner 同源时标记 superseded，独立 coding 13 保留；预留准入使用有效口径。
- Checkpoint 恢复只解除归属 Run，保留 budget/人工暂停；任务回 queued 沿原 attempt/session 派发。
- 复审 18/18 PASS；npm test 419/419；宿主产品两轮 PASS，最终产品 SHA `31faae1b692e3c7a225f07d2f926ad49376a0f1f`。
- 仍缺真实 Docker 双进程交接与容器内产品 E2E；ENGINEERING_FREEZE_BLOCKED。

## df846 复审整改（2026-11-19）

- 子进程 stdin 提前关闭：execCapture 消费 EPIPE，Workbench 不因快速 CLI 退出而崩溃。
- Checkpoint 连续重启：保留原预算/人工暂停；材料补齐后 Run 停在 paused 等普通 resume，Task 回 queued、attempt/session/worktree 保留。
- 历史 mirror：修正 ba544 对独立 coding 的误标；旧 artifact 字节数从 SQLite artifacts 登记回读，截短日志 BLOCKED。
- 18/18 可移植审查、419/419 全量、宿主两轮产品 E2E 通过；产品 SHA `9bded363e1a5bba6927a6faedd49e83c5249a68d`。
- 仍缺真实 Docker 双进程接管与容器内产品 E2E；ENGINEERING_FREEZE_BLOCKED。

## 6dd874e 复审整改（2026-11-19）

- Checkpoint 连续重启：保留原暂停原因，缺材料不派发；补齐后无独立暂停自动 dispatch 一次，manual/budget 保持原暂停。
- Planner：single/显式零传输零预留；回退按实际 provider/model；GLM 豁免仍写真实用量；回执 pending/receipt 持久，写库成功前后重投均不二次发送。
- 历史镜像纠正、旧 artifact meta_json.bytes 校验。
- 原版 23/23、补充 7/7、npm test 419/419、宿主两轮产品 E2E PASS（产品 SHA `de43336a6265252866d297f9cfd70ee6a99e1eb7`）。
- 仍缺真实 Docker 双进程接管与容器内产品 E2E；ENGINEERING_FREEZE_BLOCKED。

## 8fd51ef 复审整改（2026-11-19）

- Web submitStartRun 使用稳定 requestKey；Run 创建失败重投复用计划回执与同一 Run。
- 无可用 Planner 在预留/发送意图前阻断，0 发送/0 用量/0 占用。
- 终审按 listArtifacts 返回的 meta_json.bytes 读取旧登记长度。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺 Docker 双进程/容器产品 E2E。

## 33b91ea 复审整改（2026-11-19）

- 普通 Chat 在 transport 层使用单次 send limit；HTTP/JSON 内部重试计入，首发/无许可/新许可/再投目标 1/0/1/0。
- Web pending start key 持久到 localStorage，页面刷新后可复用；确认 Run 后才清理。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺 Docker 两项实测。

## fc5fbce 复审整改（2026-11-19）

- 普通 Chat 使用持久 `chat_sends` 首发许可；GLM 豁免同样受控；显式 retry grant 单次消费。
- Web pending 请求键在有效 runId 确认后才清理，覆盖不完整 201/缺 runId。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺 Docker 两项。
