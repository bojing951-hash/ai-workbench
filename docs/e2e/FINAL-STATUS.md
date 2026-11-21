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

## f5c854a 复审整改（2026-11-19）

- Chat 首发许可在预算预留前原子消费；旧库 chat 预留/chatfail 迁移为已消费许可；显式 retry grant 单次；GLM 豁免同样受控。
- Web 先校验 runId 再清理 pending key（已在前次提交）。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺 Docker 两项。

## e05389d 复审整改（2026-11-19 续）

- backfillChatSendState 按 fc5fbce 真实入账字段 `source='chat', source_id='chatfail:<conversation>:<message>'` 迁移已消费首发许可；旧 GLM 失败消息升级后无许可重投不发送、不新增预留。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺 Docker 两项与 Loop 发布顺序专项。

## 0288a64 复审整改（2026-11-20）

- Loop 发布门控：中间 Run 在 productAcceptance 非 PASS 时只保留本地提交/验证，不推送/建 PR；产品终审 PASS 后由 publishAcceptedRun 发布同一最终 SHA。
- 原版 23/23、补充 7/7、npm test 419/419、宿主两轮产品 E2E PASS（产品 SHA `ed65a56f9f012e7a910c7399674a022b45932940`）。
- 仍缺两项真实 Docker 与 Loop 发布的本地裸 Git/GitHub API 专项证据。

## 676a488 复审整改（2026-11-20）

- 删除 finalizeRun 的旧 OR 发布分支；Loop 中间 Run 只本地提交/验证，产品终审 PASS 后由 publishAcceptedRun 发布同一 SHA。
- 发布已开始后取消：保留取消状态和已发生动作，不覆盖为 awaiting_acceptance。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺 Docker 两项及裸 Git/GitHub 发布专项实测。

## 52e8884 复审整改（2026-11-20）

- productGate 只做产品终审并记录 PASS；实际远端发布移至队列耗尽/轮次上限/Planner no_task/任务完成四个终态的质量门之后，共用 publishLoopFinal。
- 发布使用 productPlanHead/verified_sha 的实际审计 SHA；未授权/未配置时不发布。
- 原版 23/23、补充 7/7、npm test 419/419、宿主两轮产品 PASS（产品 SHA `ff0b824af2cf4a4b74f94a89e0aa05528b67c173`）。
- 仍缺本地裸 Git/GitHub API 发布专项和两项 Docker。

## a58f038 复审整改（2026-11-20）

- `publishLoopFinal` 在终审写入后重新读取 Run，避免旧快照 productAcceptance 未更新导致最终 SHA 不发布；取消/失败 Run 拒绝发布。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺四项 Loop 终态专项与两项 Docker。

## 38a65a5 复审整改（2026-11-20）

- publishLoopFinal 发布前统一核对 live Loop 状态、审计 SHA 与实际 wb/plan ref；不一致零发布。
- 原版 23/23、补充 7/7、npm test 419/419 通过；仍缺四条终态裸 Git/GitHub 专项与两项 Docker。

## 5d6741b 冻结专项接入（2026-11-20）

- 新增真实 Docker 双进程交接专项、真实容器两轮产品 E2E、fc5fbce 旧库 Chat 升级 1/0/1/0、Loop 终态发布门控专项。
- `npm run accept:freeze` 现实际执行四项专项并校验同候选 SHA/时序/Run/bundle/clean-clone；本机退出 0。
- CI 新增 Docker 冻结 Job，构建 runtime 镜像与确定性容器代理 fixture，上传同 SHA 验收证据。

- 2026-11-20: `publishRun` 增加 Draft PR 回执恢复：按 head 查询已存在 PR，校验 repo/base/head.sha=审计 SHA 后认领；SHA 不符拒绝重复创建。

- 2026-11-20: CI run 保留 headSha；`/ci-refresh` 仅在同 SHA 全部完成且成功时写 CI_PASSED，异 SHA 绿拒绝；发布恢复按 head/base/SHA 认领已有 Draft；新增回环 GitHub 发布/CI//accept 恢复专项。

- 2026-11-20: 新增生产路径 Docker 交接专项：A 经正式 REST→Loop→容器适配器持续 writer，杀死 Supervisor+子进程后旧容器仍存活；B 启动走 cleanup/recovery，fence 1→3，旧容器退出早于新 writer 首写；B 清理失败时 BLOCKED 且零第二 writer。

- 2026-11-20: 新增真实 Supervisor/Workbench 重启恢复专项：A 运行中持久化 github-pr running 动作；杀死 A 后 B 启动 `recoverPublishActions` 认领原 Draft（creates=0），同 SHA CI 进入 CI_PASSED，正式 `/accept` 成功。

- 2026-11-20: 新增正式 REST+Supervisor+裸 Git+回环 GitHub 的 Loop 队列耗尽终态专项：产品两轮自动修复后只发布审计 SHA、裸库 ref 命中、单 Draft、同 SHA CI 绿、正式 /accept 成功。

- 2026-11-20: 同 SHA CI 证据统一入 run.result_json.ciEvidence；首次轮询/刷新/重启恢复共用 evaluateCiEvidence；/accept 要求证据 SHA=verified_sha 且无缺检查/异 SHA；发布按审计提交对象推送并复核远端 ref；恢复覆盖分支已推未建 Draft、Draft 丢回执、Draft 已记录 CI 未完成三窗口。

- 2026-11-20: 固定候选干净环境安装验收：HEAD 导出→npm install→启动→首个项目/Draft→CI→/accept，并接入 accept:freeze 与 CI 附件。

- 2026-11-20: Docker 交接脚本改用宿主观察时钟并等待旧 Workbench 子进程消失后再启动 B，消除时序/租约存活误判抖动。

- 2026-11-20: 远端写入前 guard 复验权限/Run/Loop/产品终审/审计 SHA；push 到 Draft POST 间隔再次检查；Draft 创建/认领校验 repo/base/head/immutable SHA/draft，拒绝非 Draft；Draft done 但 CI action 未建的重启窗口经同 SHA 续建 CI；普通 Run 发布结果持久化 ciEvidence。

- 2026-11-20: 真实重启补测“Draft done、CI action 未建立”窗口：重启后经同一 Draft 续建 CI，creates=0、CI_PASSED、/accept 成功；/accept 证据校验含该窗口。

- 2026-11-20: 远端 POST 前紧邻权限/状态 guard；GitHub createPullRequest 返回完整 PR 字段，Draft 初查/复查/创建响应/已存结果均校验 repo/base/head.ref/head.sha/draft；Loop no_task 增加质量门、发布后重读取消状态、重复通知不覆盖 cancelled/blocked。

- 2026-11-20: 慢 GET 后撤权回归：GET 挂起期间 REST/DB 撤权，Draft POST 前 guard 阻断，POST=0；Loop 远端发布被阻断时保留 blocked 而非 completed。

- 2026-11-20: Docker 清理失败证据记录 B 的 Run 状态并允许 BLOCKED/暂停或 B 不健康两种正式阻断形态，不再以 healthB 布尔单一条件误判。

- 2026-11-20: 新增正式 REST Loop 发布中取消（Loop/Run 均 cancelled、Draft POST=0）与质量门缺证终态（Loop blocked、零 Draft、零发布分支）回归，并接入 accept:freeze/CI。

- 2026-11-21: 发布边界收口：源/目标 repo、open、draft、base/head/SHA 严格校验；GITHUB_CREATE_PR=false 零 Draft POST；Loop 发布中取消保持 cancelled；质量门缺证零发布；对应 REST/重启专项接入 take:freeze。

- 2026-11-21: 正式 REST 发布等待中撤权（PATCH project remotePushAuthorized=false，Draft POST=0、Loop 非完成）与正式两轮 Loop 在 Draft done/CI action 未持久化窗口 SIGKILL 后恢复（不重跑编码/审计、同 SHA CI 绿、/accept 成功）专项接入 accept:freeze/CI。
