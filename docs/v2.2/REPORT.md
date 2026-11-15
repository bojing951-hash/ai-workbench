# AI Workbench v2.2 自主研发可靠性收口报告

- 执行日期：2026-11-15（Asia/Hong_Kong）
- 范围：**仅 AI Workbench 自身**；未对 A/B 发起项目级请求、无进程操作、无文件/分支/推送操作；未读取/修改其工作区或研发状态。Web 状态页与 `/api/state` 仅被动包含已有登记信息（未据此操作）。
- 版本：v2.2.0（分支 `v2.2.0`）
- 最终 Draft PR：https://github.com/bojing951-hash/ai-workbench/pull/4（未合并）
- CI：https://github.com/bojing951-hash/ai-workbench/actions/runs/43724113873（success，head `e295c63`）
- 测试：**198/198**（v2.1 的 186 项全部保留，新增 12 项）
- GitHub：v2.2 Draft PR #4（draft，**未合并 main、未部署生产**），CI success `e295c63`

## 1. 任务一：真正的执行环境隔离

### 1.1 实现

- 新增 `src/container.js`：Docker 容器执行适配器。
  - `runTestInContainer()`：在容器内执行项目测试，**默认 `--network none`**。
  - `runAgentInContainer()`：在容器内运行 Claude Code Agent（仅 Claude；DSH 不支持容器时 fail-closed 阻塞，不降级宿主执行）。
  - 安全参数：`--cap-drop ALL`、`--security-opt no-new-privileges:true`、`--read-only`、`/tmp`+`/run` tmpfs、`--pids-limit`、`--memory`、`--cpus`、非 root 宿主 UID、`--rm`、超时强制清理。
  - 最小挂载：仅 worktree → `/workspace:rw`；Agent 额外挂载隔离 Claude 配置 → `/config:rw`；**不挂载宿主根、HOME、Docker socket**；环境变量用 0600 `--env-file`，避免 `docker inspect` 暴露密钥。
  - Docker 不可用/镜像缺失：`CONTAINER_UNAVAILABLE` / `CONTAINER_IMAGE_MISSING`，fail-closed。
- 新增 `docker/runtime.Dockerfile`，构建镜像 `ai-workbench-runtime:2.2`（Node 24 + git + Claude Code 2.1.104），镜像 ID `sha256:41725418634a86cc2d6018793233aa42143ffcdad08bd8e4e4ec4b6229e64e5d`。
- `GET /api/isolation` 增加 `container` 能力报告；`GET /api/executor`（由 W 自身研发循环产出）暴露同一能力；UI 顶部增加执行隔离状态徽章；CLI `workbench isolation` 可查询。

### 1.2 真实验证

| 项 | 结果 | 证据 |
|---|---|---|
| Docker daemon 可用性 | PASS | Docker 29.9.2；`GET /api/isolation` kernelIsolation=docker |
| 容器内测试执行（network none） | **PASS（真实运行）** | v2.2 E2E 运行 `run_mwhwfr2v37fcbdab`：测试在容器内执行，exit=0，isolation.backend=docker/network=none；审计 PASS 100 |
| 容器内 Claude Code Agent | **PASS（真实运行）** | 同一运行由容器内 Claude Code 创建 hello.txt；commit `44995153` |
| 容器最小挂载/宿主隔离 | PASS（自动测试） | `tests/container.test.js`：容器内不可见 `/Users`/`/Applications`，只见 `/workspace` |
| 禁止 privileged/docker.sock/宿主根挂载 | PASS | 参数断言 + 挂载拒绝单测 |
| Docker 不可用时 fail-closed | PASS（单测/参数路径） | `CONTAINER_UNAVAILABLE`/镜像缺失测试；本轮宿主 Docker 可用，未实际制造 daemon 故障 |
| 容器 Agent 网络最小授权 | **UNKNOWN/PARTIAL** | 测试容器 network=none；**Agent 容器需要模型端点，使用 bridge，当前未实现基于域名/IP 的 egress allowlist**（如实标记，不冒充最小网络授权） |
| DSH Agent 容器 | BLOCKED | DSH 为宿主 CLI，镜像内不可用；项目要求容器 Agent 且 Agent=DSH 时直接阻塞，不降级宿主执行（已验证：loop `loop_mwhx6t32acb5f0a9` paused） |

## 2. 任务二：GLM 预算与模型身份识别

### 2.1 修复

- 新增 `src/model-identity.js`：**按实际供应商/端点/model 识别**，不再按调用入口推断。
  - Claude Code + GLM Anthropic 兼容端点 → `glm`（豁免）；Claude Code + OpenAI/Anthropic/DeepSeek 端点 → 对应非 GLM（不豁免）。
  - DSH：显式 provider/model/baseUrl 优先；仅存在 DeepSeek 凭据时识别为 deepseek；无法确定 → `unknown`。
  - 审计/规划 LLM：声明 provider 与实际 baseUrl/model 交叉核对；不一致按实际端点；unknown 不豁免。
  - `unknown` 永远不享受豁免；`provider_known`/`provider_source` 写入 attempts/audits。
- 预算：只有 `known && provider=glm` 才从全局/项目/运行/单任务 token 与费用中排除；GLM Agent 的单任务 token 上限设为无限（仍保留墙钟、并发、取消、失败重试、权限限制）；DeepSeek/OpenAI/unknown 继续受原预算。
- 真实 token/cache/调用/费用继续完整记录；历史记录标记 `legacy_inferred` 来源，未修改历史数值。
- 新增 `tests/model-identity.test.js` 与未知 provider 预算测试；四类场景验证：GLM / DeepSeek / OpenAI / unknown。

### 2.2 真实预算记录

| Provider | 真实 tokens（含缓存） | 真实费用 | 预算口径 |
|---|---|---|---|
| GLM | 2,519,937（输入 349,779 / 输出 168,622 / 缓存 2,001,536） | ¥14.35 | **不计入**上限（用户授权） |
| DeepSeek | 18,939,336（缓存主导） | ¥6.20 | 缓存折算后 **2,927,688 / 3,000,000**，剩余 72,312 |
| 全部成本 | — | **¥20.54 / ¥30** | — |

> 未修改历史用量、未隐藏费用、未归零计数器。DeepSeek 预算接近上限是本轮后续 Agent 任务被 token 限制的根因（见 §3.3）。

## 3. 任务三：持续自主研发与中断恢复可靠性

### 3.1 循环 A–H 真实测试

Loop `loop_mwhwhz3z34912b0f`（W 隔离克隆，3 个真实任务，queue 模式）：

| 轮 | 任务 | Commit | 测试 | 独立审计 |
|---|---|---|---|---|
| 1 | `GET /api/executor` 执行能力接口 | `c28b7b2e` | npm test 通过 | DeepSeek PASS 88 |
| 2 | Web 执行隔离状态徽章（SIGKILL 中断后恢复） | `73344291` | npm test 通过 | DeepSeek PASS 92 |
| 3 | CLI `isolation` 子命令 | `8d773765` | npm test 通过 | DeepSeek PASS 90 |

- **A 连续 3 个不同任务**：PASS（3 个真实不同提交）。
- **B 第二个任务执行中强制终止**：PASS — 2026-11-15 **22:04:22** 对 Workbench 进程 `kill -9`。
- **C 重启后恢复未完成任务**：PASS — 重启后 loop=`interrupted`、round=1、history 保留；run=`interrupted`；`POST /api/loops/:id/resume {retryCurrent:true}` 恢复。
- **D 恢复任务实际测试+独立审计**：PASS — 恢复后 round2 测试通过、DeepSeek 审计 PASS 92、commit `73344291`。
- **E 自动进入下一轮**：PASS — 完成后自动进入 round3。
- **F 达到设定轮次停止**：PASS — loop status=`completed 3/3`。
- **G 无有效任务停止**：PASS — `loop_mwhx6pz3d6b1c474` queue 空，completed，无 run 创建。
- **H 阻塞时保存状态并停止**：PASS（能力/权限阻塞）— `loop_mwhx6t32acb5f0a9` 要求容器 Agent 但 Agent=DSH，run 立即 blocked，loop paused 保存原因；**A/B 相关授权阻塞本轮不可测试**（禁止访问 A/B），如实说明。

> **诚实说明**：round2 原 Claude 会话在隔离克隆中无进展；改为 DSH 后 DeepSeek 剩余预算不足，最终由 Supervisor 按同一验收标准完成 Web 徽章代码，再由工作台执行真实测试与独立审计；round3 同样由 Supervisor 完成 CLI 代码。Agent 全自动完成率为 1/3，**不得把三轮都描述为 Coding Agent 自主完成**。

### 3.2 可靠性修复

- 循环完成判定：仅 `task.status=passed` 且 `verification ∈ {LOCAL_VERIFIED, CI_PASSED}` 才推进；UNKNOWN/失败不推进。
- 幂等：同一 run/commit 不重复写入 history；重复恢复通知不会重复轮次。
- Git 状态安全：推进前用 `git rev-parse` 校验计划分支指向任务 commit；`git checkout` 检查退出码；任一失败暂停循环，不继续错误基线。
- 中断恢复：`recoverOrphans` 标记 run/attempt interrupted；无厂商最终用量的中断 attempt 标记 `cost_source=unknown`（不伪造 0）；恢复后新 attempt 正常记录用量，不重复扣减。
- 验证重试并发锁、`/api/runs/:id/reconcile` 保留。
- 任务完成判定涵盖测试、审计、实际 commit、版本指纹、验收契约；CI 要求项目由 finalize 闸门处理。

### 3.3 发现的真实问题（未修复/待下一轮）

- **非 GLM 预算耗尽**：DeepSeek 缓存折算预算仅剩 72,312，后续 DSH 任务被单任务 cap 中止；这是 Agent 自主完成率低的原因。下一轮需用户决定是否增加非 GLM 预算，或默认使用 GLM Agent。
- **Claude Code 在较大仓库任务上偶发无进展**（读取大量文件后不结束）：已记录，未用 bypass/danger-full-access 绕过。
- **容器 Agent 网络最小授权**未实现 egress allowlist（UNKNOWN）。
- **A/B 零干扰**：本轮未对 A/B 发起项目级请求、进程/文件/分支/推送操作；未读取其运行详情或研发状态；candidate 初始副本排除 `projects/`、`data/`、`.env`、`.git`。无法在不访问 A/B 的前提下做更细粒度证明，因此该结论基于操作记录而非读取 A/B 状态。

## 4. 任务四：工作台自主开发自身（候选流程）

- 稳定控制器未替换；候选目录独立、独立数据目录/端口；候选副本**初始**排除 `data/`、`projects/`、`.env`、`.git`，不能访问 A/B。候选运行后自身创建的 `projects/phase1-taskvault` 与 `data/` 是候选实例的 demo 数据，不是从稳定工作台或 A/B 复制。
- 最终候选：`cand_mwhx9uwz_l3gw`；离线测试 PASS（198）；隔离实例冒烟 PASS（version=2.2.0）；真实 E2E 任务 awaiting_acceptance / LOCAL_VERIFIED。
- 证据：`demo/evidence/upgrade-1794752525090.json`、`demo/evidence/v2.2-final-1794752580.json`。
- 未自动合并/部署。

## 5. 交付与恢复

- 分支：`v2.2.0`；PR：Draft（不合并）。
- 测试：`npm test` 198（新增 container 6 + model identity 6；原 186 全保留）。
- 恢复入口：`GET /api/loops`、`POST /api/loops/:id/resume`、`workbench isolation`、`GET /api/executor`。
- 下一轮：① 决定非 GLM 预算或默认 GLM Agent；② 实现容器 Agent egress allowlist；③ 继续 W 真实循环（可从当前 loop 状态恢复）；④ 人工审核 PR，不自动合并。
