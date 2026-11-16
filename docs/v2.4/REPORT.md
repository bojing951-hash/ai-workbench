# AI Workbench v2.4 — 长时间无人监督自主执行系统报告

- 日期：2026-11-16（Asia/Hong_Kong）
- 范围：**仅 W**。未对 A/B 发起项目级请求、进程操作、文件/分支/推送；未读取其工作区/研发状态。
- 版本：v2.4.0（分支 `v2.4.0`）
- 测试：**206/206**
- Draft PR：#6（见最终交付），未合并/未部署

## 0. 最终状态：`24H_AUTONOMY_NOT_VERIFIED`

> **完整 24 小时无人监督验收未执行**，因此按用户要求标记 `24H_AUTONOMY_NOT_VERIFIED`，不声称未来结果已经产生，也不把加速验收冒充 24h。
>
> 当前真实阻塞：**独立审计 Provider 资源不足**。DeepSeek 非 GLM 预算剩余 **9,869 / 3,000,000**，而任务审计预估（8,000）+ 安全保留（2,000）已超过剩余；v2.4 的 Provider-aware 预检会在**编码前**安全阻塞新任务并保存检查点，而不是无审计直接 PASS。已授权的 GLM 预算豁免仍然有效，但 Coding Agent 用 GLM 时审计不能同族自审。
>
 > 独立 Supervisor 已实现并实际验证：SIGKILL Workbench 后自动拉起、恢复受管 run/loop、继续完成真实任务；健康无响应故障自动重启。24h 验收可在预算授权后由该 Supervisor 持久化执行。
>
> 已创建并尝试启动一个**预冻结的 24h 验收项目**：`proj_mwi146ob721765e6` / `loop_mwi146ofabcdd6a2`（5 个冻结任务，Supervisor 托管）。任务 1 在**编码前**被 Provider-aware 预检阻塞并保存检查点：`独立审计资源预算不足：Provider=deepseek，剩余 9869，审计预估 8000 + 保留 2000`；loop 安全暂停，未执行 24h。这是真实的资源授权阻塞，不是伪造的 24h 结果。

## 1. 独立 Supervisor（第一阶段）

实现：`supervisor/workbench-supervisor.mjs`、launchd plist、systemd unit、`supervisor/README.md`。

- 与 Workbench 主进程独立：启动 Workbench、`/api/health` 健康检查（3 次失败判定无响应）、进程退出检测、指数退避重启（5s→300s）、熔断（10 分钟窗口超过 max-restarts 停止自动重启）、崩溃/重启/恢复状态持久化到 `data/supervisor/state.json`。
- 健康恢复后调用 `POST /api/supervisor/recover`：仅对 `supervisor_managed=true` 的项目做恢复前对账，仅续跑 `interrupted` 的 run/loop；paused/failed/审计资源阻塞不自动续跑。
- 修复了测试中发现的 Supervisor 竞态：健康失败与进程退出同时触发重复重启（日志出现 5 次重复 health-unresponsive）；现使用 `restartScheduled` + `clearInterval` 幂等，单次重启。
- **真实故障验证**：
  - SIGKILL Workbench（16:00:47Z）→ Supervisor 5s 后（16:00:52Z）自动拉起 → 16:00:58Z 调用受管恢复接口，`recoveredRuns.run_mwi0twlq3c6d5986`、`recoveredLoops.loop_mwi0tvo5d7bf6a00` 均 resumed → Agent 完成任务、真实测试通过、DeepSeek 独立审计 PASS 88、Git commit；**无人工重启/resume/改码**。
  - 健康无响应注入（Workbench SIGSTOP，16:05:26Z）→ 3 次健康检查失败 → Supervisor 自动终止并重启 → 16:05:54Z 健康恢复；单次重启，无熔断。
- 证据：`demo/evidence/v2.4-supervisor.json`、`demo/evidence/supervisor-log-v2.4.txt`。

## 2. Durable Orchestrator（第二阶段）

- 新增 SQLite **项目写租约** `projects.write_owner/lease_expires_at` 与 **run 租约** `runs.lease_owner/lease_expires_at`；`acquireProjectLease` 原子获取，过期可清理；启动/推进时续租，终态释放。
- 新增**恢复前对账** `reconcileInterruptedRun`：passed 任务必须有 PASS 审计且 commit 是计划分支祖先；不一致会 `run_reconciliation_failed` 并拒绝盲目续跑。
- Supervisor 恢复接口按 `supervisor_managed` 过滤，先对账再 resume；失败保留检查点。
- 恢复测试：`tests/v24-durability.test.js` 覆盖租约单写/过期、对账拒绝、审计预检、看门狗事件进度。
- 既有 v2.3 的幂等循环完成、重复 commit 防护、中断 attempt 用量 unknown 保留。

## 3. Agent 自主恢复（第三阶段）

- `runAgentWithWatchdog` 同时考虑：
  - worktree 变化（git status/diff）；
  - Agent `onEvent`（工具调用/状态/心跳）计数；
  - 硬性无进展阈值（项目可配 `agent_stall_timeout_ms`）。
  不再仅以工作树无变化判断卡死；测试覆盖“只有事件、没有文件变化”不误判。
- 失败分类：`stalled / agent_timeout / agent_aborted / budget / agent_no_output / infrastructure / agent_error`，持久化 `attempts.failure_class`。
- 有界恢复：主 Agent → 已配置备选（预算不足的非 GLM 备选自动跳过）→ 主 Agent 全新会话；达到 maxAttempts 阻塞，不无限重试。
- v2.3 故障验收：5/5 任务自主完成、2/2 故障恢复、0 人工代码干预；v2.4 Supervisor 崩溃恢复任务再次完成。

## 4. 预算与独立审计（第四阶段）

- 保留 v2.2/v2.3 的 GLM 授权：**仅实际身份为 GLM 的调用豁免**；其他 Provider 受原预算，历史用量不改。
- 新增 `auditResourcePreflight`（Provider-aware）：
  - Coding Agent 与 Audit Provider 独立选择（实际模型族）；
  - 审计 Provider 不可用/不同族冲突/预算不足（预估 audit tokens + minReserve）时，在**写代码前**阻塞任务并保存检查点；
  - 不会因 DeepSeek 预算耗尽而误把无审计任务标记 PASS；也不会用同模型自审。
- 当前真实状态：DeepSeek 剩余 9,869，审计预估 8,000 + 保留 2,000 已超；因此新任务在编码前被安全阻塞。**未擅自提升任何非 GLM 授权**。
- 全局实际费用：**¥30.10**，其中 **GLM 豁免 ¥23.76**（真实记录、不受内部费用上限），**非 GLM 受预算 ¥6.34 / ¥30**（剩余费用额度 ¥23.66）；非 GLM Token 预算剩余 9,869。GLM 真实 tokens 3,615,355 单列。
- 24h 项目/loop：`proj_mwi146ob721765e6` / `loop_mwi146ofabcdd6a2`，已暂停在编码前检查点；恢复条件=用户授权独立审计预算/新增独立 Provider。

## 5. 测试与证据

- `npm test`：**206/206**（v2.1 186 全保留 + v2.2 12 + v2.3 4 + v2.4 4）。
- v2.3 加速无人监督验收：5/5 任务、100% Agent 自主、0 人工干预、2/2 故障恢复、5/5 独立审计 PASS（24m22s，**不是 24h**）。
- v2.4 Supervisor 真实恢复：1 个受管任务在 SIGKILL 后自动完成；健康无响应自动重启；证据见上。
- 24h 验收：**NOT VERIFIED**（预算阻塞 + 未执行完整窗口）。预冻结 24h 项目已启动并在编码前安全暂停于审计资源检查点；未伪造未来结果。

## 6. 未解决阻塞

| 阻塞 | 状态 | 原因 |
|---|---|---|
| 24h 连续无人监督验收 | **NOT VERIFIED / BLOCKED** | 未执行完整 24h；独立审计 DeepSeek 预算剩 9,869，不足以覆盖审计+保留 |
| 独立审计资源 | BLOCKED（预算授权） | 不得提升非 GLM 预算；无 OpenAI 独立 Provider |
| 容器 Agent egress allowlist | UNKNOWN/PARTIAL | 沿用 v2.2 限制；测试容器 network=none |
| A/B 授权/控制权 | 不涉及 | 本轮禁止访问/操作 |
| Supervisor 自身被 SIGKILL | 依赖 launchd/systemd | 需宿主进程管理器；普通后台运行不自动拉起 Supervisor |

## 7. 候选版本验证

- 候选 `cand_mwi14g4s_kg2i`（独立副本/数据/端口，初始排除 data/projects/.env/.git）：离线测试 **PASS 206**、隔离实例冒烟 **PASS v2.4.0**、真实 E2E **awaiting_acceptance / LOCAL_VERIFIED**。
- 证据：`demo/evidence/upgrade-1794758986200.json`。

## 8. 交付

- 源码/分支：`v2.4.0`
- Supervisor：`supervisor/`（launchd/systemd 模板、README、状态/日志）
- 测试：206
- 证据：`demo/evidence/v2.3-autonomy-final.json`、`v2.4-supervisor.json`、`supervisor-log-v2.4.txt`
- Draft PR #6，未合并/未部署
- 下一轮可恢复状态：Supervisor 运行中；受管项目/loop 检查点保留；授权独立审计预算后可启动 24h 验收。
