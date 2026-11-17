# 真实零人工 E2E 验收前检查

生成时间：2026-11-17T00:47Z（Asia/Hong_Kong 08:47）
Workbench：v3.3.0
Git：分支 `v3.3.0`，源码提交 `035f997`
Draft PR：https://github.com/bojing951-hash/ai-workbench/pull/15

## 结论

**AUTHORIZATION_REQUIRED**（工程安全控制已实现；Docker 与用户授权未满足）

工程链路基本具备，但预算与 DSH 专项授权不具备；不得开始真实 E2E、不得发生新增付费调用。

## 运行状态

| 项目 | 结果 |
|---|---|
| 服务 | `http://127.0.0.1:4477` health ok，v3.3.0 |
| SQLite | `PRAGMA integrity_check=ok`，0 个 reserved/unknown 预留 |
| Active Loop | 0 |
| Active project lease | 0 |
| Supervisor | circuitOpen=false，43 次历史重启/崩溃，44 次恢复，最近心跳正常 |
| 实验预算契约 | 0 个 active contract；代码已支持硬限制 |
| 硬限制测试 | 15/15 PASS；完整套件 322/318/4/0 |
| 历史 E2E | 存在 1 个 **paused** 旧项目（本地消费管理），未继续、不得复用其成果 |

## Coding / Planner / Audit

| 角色 | 真实客户端 | 实际模型/Provider | 状态 |
|---|---|---|---|
| Chat + Planner | DeepSeek API | `deepseek-chat` / deepseek | 可用（但全局预算 0） |
| Coding Agent | Claude Code 2.1.104 | GLM-5.3 / GLM（Anthropic 兼容端点） | CLI 可用；GLM 既有豁免 |
| 独立审计 | DSH 0.2.2-rc.2 headless | `deepseek` / DeepSeek | CLI 可用；需新项目 DSH 专项授权 |
| OpenAI | — | 无 Key | 不可用 |

注意：DSH Coding 与 DSH Audit 同为 DeepSeek 模型族，若用 DSH 编码必须另选独立审计；本次推荐 **Claude Code/GLM 编码 + DSH/DeepSeek 审计**，编码族与审计族不同。

## 隔离环境

- Node v24.13.1；
- Git 2.50.1；
- Docker **不可用**（`docker ENOENT`），镜像 `ai-workbench-runtime:2.2` 不可用；
- 因此本地测试隔离可用，容器测试/容器 Agent 路径不可用；
- 真实 E2E 若要求 Docker 隔离，则此环境 BLOCKED；若接受本地 sandbox + 独立 Git worktree，可继续。

## 预算现状

- 全局 max tokens：3,000,000；
- 已计入预算：3,495,479（已超 495,479）；
- 剩余：0；
- 全局预算费用：已用 ¥15.2375 / 上限 ¥30，剩余 ¥14.7625；
- reserved：0；
- confirmed GLM：19,917,352 tokens 合法豁免；
- `glm@unknown`：1,479,128 tokens 不再豁免，已计入；
- `deepseek@unknown`：18,287,609 tokens（含缓存权重后计入）；
- 历史 DSH project_audit：990,781 tokens / ¥3.852（旧项目，不得算作新项目额度）。

当前任何 DeepSeek Chat/Planner 付费预检都会 fail-closed；已实际验证返回 `BUDGET_CHAT_TOKENS_EXCEEDED`（剩余 0，保留 2000）。

## 安全/可靠性

- 无遗留 lease，无 running loop；
- Fencing / pause-resume / 自动修复 / 产品验收代码测试通过；
- 但真实 Agent/DSH E2E、SIGKILL 各阶段、24H 未执行；
- 不能把离线 fake 模型结果当成真实 E2E。

## 结论

**BLOCKED → AUTHORIZATION_REQUIRED**

实验契约、硬限制和隔离守卫的代码与测试已完成；没有用户授权，未创建实验，未发起付费调用。Docker 不可用，非隔离本地执行被代码拒绝。
