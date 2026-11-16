# AI Workbench v2.1 验收矩阵（PASS / FAIL / UNKNOWN / BLOCKED）

> 以真实执行证据为准；未验证项不得标 PASS。证据：SQLite runs/audits、Git commits、GitHub Actions、`demo/evidence/`。

## 1. W（工作台）

| 验收项 | 状态 | 证据 |
|---|---|---|
| GLM 预算已按授权放宽 | PASS | `src/config.js budget.glmUnlimited/exemptProviders`；`tests/loop-and-glm.test.js`；真实 GLM 1,479,128 tokens / ¥8.90 未计入上限 |
| GLM 真实 token/cache/费用完整记录且与其他模型分开 | PASS | `attempts.provider/model`、`audits.provider`、`/api/usage/providers`、`/api/budget`、UI GLM 独立展示 |
| DeepSeek/OpenAI 仍受原预算 | PASS | provider-aware budget；DeepSeek 2,756,858/3,000,000（缓存折算） |
| 安全执行隔离（Docker/sandbox） | BLOCKED（内核级） | Docker daemon 不可用、sandbox-exec 不可用；未降级危险权限 |
| 受限独立运行环境实际生效 | PASS | 独立 HOME/TMPDIR、最小环境、工具白名单、命令 allowlist、独立 worktree；`tests/isolation.test.js`、`tests/security.test.js` |
| 无沙箱时 fail-closed 不自动提权 | PASS | `assertIsolationForProject`；`GET /api/isolation` |
| 独立测试 + CI 闸门 + SHA 绑定 | PASS | 186 tests；W PR/CI：PR #2 CI success、PR #3 CI success；验收要求 CI_PASSED/verified_sha |
| 编码/审计模型分离 | PASS | 三次 loop 任务 DSH(deepseek)→GLM 审计；A Claude/DSH→DeepSeek/GLM 独立 |
| 自我升级候选流程 | PASS（v2.0 证据） | `demo/evidence/upgrade-*.json`：候选测试+隔离实例+真实 E2E |
| 连续 3 个真实研发周期 | PASS | loop `completed 3/3`；commits 90e9d11b / 6875f8a0 / b92a2afc，任务分别为 API/UI/CLI 真实缺口 |
| 计划→开发→验证→修复→交付→下一轮 | PASS | 三轮均由 Planner 生成、Agent 修改、测试、GLM 审计、本地 commit，自动进入下一轮 |
| 中断恢复 | PASS（机制）/ UNKNOWN（被恢复任务审计） | SIGKILL 21:22:01 → loop interrupted → resume → run 重试；恢复文档任务审计 UNKNOWN，未伪造 |
| 不重复已完成任务 | PASS | Planner 对 history 去重；调用历史见 loop history |
| 无任务/阻塞时正确停止 | PASS | queue 空/达到 maxRounds 时 completed；规划失败暂停 |
| 验证重试并发/竞态防护 | PASS | retry lock + `POST /api/runs/:id/reconcile`；B 竞态按证据恢复 |
| 回退/旧功能无回归 | PASS | 原 180 tests 全保留，186 全绿 |

## 2. A（Global Opportunity Engine，只读接入）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 正确读取最新 committed 状态 | PASS | 权威树只读；隔离克隆 `13f2620`（未读取未提交改动） |
| Claude Code 自动完成实际任务 | BLOCKED/UNKNOWN | 受限 Claude 会话在隔离克隆中长时间无进展，已取消；未修改 A 工作区 |
| DSH 完成实际任务 | PASS（本地） | P1-SCAN-2 对抗性扫描证据测试；全量 pytest 通过；commit `7a40071` |
| 独立审计 | PASS | GLM PASS 91 |
| 核心功能/接口无回归 | PASS | 仅新增测试；全量离线 pytest 通过 |
| A→B 交接接口保持兼容 | PASS（只读核对） | 未改 A 交接接口；HANDOFF_SCHEMA v1.0 与 `ia_cli research-run --out-dir` 未变 |
| 持续推进下一任务 | BLOCKED | 需要控制权移交/推送授权；本轮只做一个隔离任务 |
| 远端 PR/CI | BLOCKED | 未授权；未推送、未合并 |
| 未修改权威工作区/既有进程 | PASS | 全部操作在隔离克隆；未接管/暂停 A 研发进程 |

## 3. B（Investment Agent，READ_ONLY 最新 R37）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 最新研发状态准确 | PASS | 本地 main `12648bd`（R37，baseline 45d4348）；隔离克隆同 commit |
| 不与已有研发进程冲突 | PASS | READ_ONLY；未写权威树/检查点/LIVE |
| DSH 在隔离工作区执行真实任务 | PASS（本地） | A→B handoff 契约测试 36/36；commit `986f6d3` |
| 原有验收契约/检查点有效 | PASS | 状态门 7/7、thresholds G1-G4 全绿；检查点/GOAL 未改 |
| 独立审计 | PASS | GLM PASS 94 |
| 完整回归测试 | UNKNOWN（环境） | 全量 157 套件在 Workbench 隔离 worktree 中缺原始数据/环境失败；Phase 0 干净 clone 基线 157/157；未删/跳测试 |
| 可继续推进已授权研发 | BLOCKED | 需用户/操作者控制权移交；当前只输出候选补丁 |
| 未推送/未合并/未碰 LIVE | PASS | 无远端写操作 |

## 4. 整体系统

| 验收项 | 状态 | 证据 |
|---|---|---|
| 三项目独立目标/任务/Agent/Git/状态/测试/审计/预算/权限 | PASS | 3 个独立项目 + 隔离克隆；独立 worktree；独立 loop |
| 同一工作区禁止并发写入 | PASS | 每 run 独立 worktree；项目/运行锁；verification retry lock |
| 一个项目失败不中断其他 | PASS | A/B/W 并行期间互不影响；失败仅自身暂停 |
| 至少 3 个真实研发周期 | PASS | W loop 3 轮 + A 1 轮 + B 1 轮 |
| 至少一次实际中断恢复 | PASS（机制） | SIGKILL→interrupted→resume→run 重试；任务审计 UNKNOWN 如实记录 |
| 所有重要结论有 commit/测试/证据 | PASS | 见 §1/§2/§3；`demo/evidence/v2.1-*` |
| 未合并 main / 未部署 | PASS | PR #2/#3 均 draft/open/未合并 |

## 5. 阻塞/未完成（不冒充）

- 内核级隔离：BLOCKED（环境）。
- A/B 远端推送、control transfer：BLOCKED（未授权）。
- A Claude Code 任务：BLOCKED/UNKNOWN。
- B 全量套件隔离环境：UNKNOWN。
- 中断恢复文档任务最终审计：UNKNOWN（恢复机制本身 PASS）。
