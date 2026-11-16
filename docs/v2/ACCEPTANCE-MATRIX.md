# v2.0 验收矩阵（PASS / FAIL / UNKNOWN / BLOCKED）

> 生成时以真实执行记录为准；未执行、证据不足或环境不允许的项不标 PASS。
> 证据位置：`demo/evidence/`、SQLite runs/audits、GitHub PR/Actions。

## 1. 工作台 W（自身）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 原有功能无回归 | PASS | v2 离线测试 180/180；v1 84 项全部保留 |
| P0 安全整改 | PASS（深度隔离 BLOCKED） | docs/v2/SECURITY-REMEDIATION.md + tests/security/audit/server |
| 自我升级使用独立候选版本 | PASS | demo/evidence/upgrade-*.json：候选测试+隔离实例冒烟 |
| W 真实任务（Claude Code） | PASS | run_mwhon0oj8e6db611：Claude 编辑 src/server.js+docs/API.md，测试通过，DeepSeek 审计 PASS 88 |
| GitHub 草稿 PR + CI | PASS | PR #1（draft，未合并）+ GitHub Actions CI success（CI_PASSED） |
| 崩溃恢复 | PASS | v1 Phase2 SIGKILL 恢复证据；v2 resume 断点继续证据 |
| 不合并/不部署 | PASS | 工作台无合并代码路径；W PR 保持 draft |

## 2. 项目 A（Global Opportunity Engine）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 成功接入工作台（只读配置） | PASS | proj_mwhnn83x45a46175；Phase 0 报告 |
| 能读取真实研发状态 | PASS | architecture/research-v2 @5c055cc 快照；测试命令实测 |
| Claude Code 执行真实任务 | PASS（本地） | run_mwhq4k6he623c53c：Claude 新增 docs/WORKBENCH_INTEGRATION.md，全量 pytest 通过，DeepSeek 独立审计 PASS 92，commit d5f849a2 |
| Coding Agent 真实任务（DSH） | PASS（本地） | run_mwho4kn5bdd916ca：DSH 生成 tests/test_pit_lookahead.py，全量离线 pytest 通过，GLM 独立审计 PASS 92，commit 8dd43985 |
| 独立审计 | PASS（GLM / DeepSeek 各一） | 审计空返回问题通过提高 max tokens 修复；两次审计均 PASS 并绑定 worktree tree hash |
| 不破坏既有功能 | PASS | 仅新增测试/文档；既有测试文件未修改；全量 pytest 通过 |
| 不破坏既有功能 | PASS | 仅新增测试文件；既有测试文件未修改；全量套件通过 |
| A→B 交接兼容 | PASS（只读核对） | HANDOFF_SCHEMA v1.0 与 B 接收面文档/测试存在；本环境未执行真实联调（会写 output，按 B 纪律禁止） |
| 远端 PR / CI | BLOCKED | A 本地分支领先远端 main 100+ 提交；未授权推送；未推送、未开 PR |

## 3. 项目 B（Investment Agent）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 成功接入（只读） | PASS | proj_mwhnn856d30828ae；隔离克隆 `projects/v2/investment-agent` |
| 保留原有研发检查点 | PASS（只读核对） | Phase 0：R35 0f53463 基线；本地 R36 ee4fbb6 未推送，不追踪不覆盖 |
| 不与现有研发进程冲突 | PASS | READ_ONLY 结论；未触碰权威树/agent-loop/LIVE |
| DeepSeek Harness 在授权工作区推进任务 | PASS（沙箱隔离克隆） | run_mwhpvzw61979a6d2：DSH 新增 tests/test_workbench_handoff_contract.py（36/36 通过），commit 15e0aa4e；状态门 7/7 + thresholds 全绿；GLM 独立审计 PASS 92 |
| 原有测试/研究纪律有效 | PASS（门禁）/ UNKNOWN（全量套件环境） | 状态门 7/7、thresholds G1-G4 全绿；全量 157 套件在 Workbench 隔离 worktree 中执行出现环境相关失败（缺原始数据/环境，非代码回归），如实记录，不冒充通过；干净 clone 基线 157/157 由 Phase 0 独立验证 |
| 远端推送/权威树写入 | BLOCKED | 未推送、未合并、未写权威树 |
| 不触碰 LIVE/公开推送/付费 | PASS | 零写入权威树、零推送、零付费 API |

## 4. 整体系统

| 验收项 | 状态 | 证据 |
|---|---|---|
| 三个项目独立队列/工作区/记录 | PASS | 3 个项目独立 ID/配置/运行记录；SQLite |
| 失败不污染其他项目 | PASS | A 预算/审计失败只暂停自身；W/B 独立 |
| 执行状态可恢复 | PASS | resume/retryVerification；预算中断恢复证据 |
| PASS 有真实可追溯证据 | PASS | 每次审计绑定 evidenceHash/worktree tree hash；PR 绑定 commit SHA |
| 未完成项标 FAIL/UNKNOWN/BLOCKED | PASS | 本矩阵 |
| 可持续推进新任务 | PASS | 工作台 API/UI 可继续 startRun；A/B 只读约束保持 |

## 5. 已知限制
- 本机无内核沙箱：Agent 仅受文件工具/环境/命令 allowlist 约束，深度隔离 BLOCKED。
- A 的远端 PR、B 的权威树写入需用户/操作者授权，当前 BLOCKED。
- 预算指标：原始 token 与缓存折算预算同时展示（cacheTokenWeight=0.1），详细说明见 SECURITY-REMEDIATION / 最终报告。
