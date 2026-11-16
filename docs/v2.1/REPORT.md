# AI Workbench v2.1 工程报告（持续自主研发 + 多项目隔离接入）

- 执行时间：2026-11-15（Asia/Hong_Kong）
- 控制版本：v2.1.0（分支 `v2.1.0`）
- 最终候选 PR：https://github.com/bojing951-hash/ai-workbench/pull/3（draft，未合并，CI success）
- 稳定基线 PR：https://github.com/bojing951-hash/ai-workbench/pull/2（v2.0 draft，CI success）
- 工作台：http://127.0.0.1:4477

## 1. 本轮新增

### 1.1 GLM 预算授权（按用户明确授权）

- GLM（Claude Code 编码 + GLM 审计）**不再受工作台 300 万 token / ¥30 内部上限约束**；缓存不折算规避；DeepSeek/OpenAI 等其他模型仍受原预算。
- 真实用量完整记录并按 provider 分开：`attempts.provider/model` + audits.provider；`GET /api/usage/providers`、`/api/budget`、UI 顶部 GLM 独立展示。
- 当前累计（真实记录，未归零）：
  - GLM：**1,479,128 tokens**（输入 259,678 / 输出 136,122 / 缓存 1,083,328），费用 **¥8.90**，不受预算限制。
  - DeepSeek（受限）：原始 token 18,286,279（缓存主导），按缓存权重折算预算 **2,756,858 / 3,000,000**；费用 **¥5.84**。
  - 全部模型合计真实费用 **¥14.74 / ¥30**。
- 保留超时、重试、异常检测、取消、权限控制；未通过修改统计/归零放宽任何其他模型。

### 1.2 持续自主研发循环（核心）

实现 `src/loop.js` + Planner `planNextTask` + `/api/loops`：
`读取目标/契约/状态 → Planner 识别下一真实缺口 → 单任务 run（编码/测试/独立审计/有界修复）→ 内部验收 → 更新项目累积分支与历史 → 自动下一轮`。
停止条件：达到最大轮次、没有真实任务、任务失败/阻塞、需要人工授权；**不制造任务**。支持 plan/queue 两种模式，状态全量持久化 SQLite，可恢复。

**W 真实 3 轮循环（连续、非重复演示）：**

| 轮 | 真实任务 | Commit | 测试 | 独立审计 |
|---|---|---|---|---|
| 1 | `GET /api/usage/providers` 分离 Provider 用量接口 | `90e9d11b` | npm test 通过 | GLM PASS |
| 2 | Web 研发循环面板（loops 状态/进度/历史） | `6875f8a0` | npm test 通过 | GLM PASS 95 |
| 3 | `bin/workbench.js` 增加 loop 子命令 | `b92a2afc` | npm test 通过 | GLM PASS 85 |

循环状态 `completed 3/3`，三轮回合均由真实 Agent 修改 + 测试 + 独立审计 + 本地 commit，已合入 v2.1.0 分支。

### 1.3 真实中断恢复

- 启动一个真实文档任务循环后，对 Workbench 进程执行 **SIGKILL**（2026-11-15 21:22:01）。
- 重启后：loop 自动标记 `interrupted`（状态/轮次/history 持久化），run 标记 `interrupted`；调用 `POST /api/loops/:id/resume {retryCurrent:true}` 后循环恢复并重试当前运行。
- 证据：`api/loops/loop_mwhv5nmgad1042e7` 事件（loop_interrupted → loop_resumed）与 run 事件。
- 该恢复文档任务的最终审计返回 UNKNOWN（模型未按验收标准返回 criteria），**未伪造 PASS**；恢复机制本身已验证，任务状态如实记录。

### 1.4 Agent 执行隔离

- 新增 `src/isolation.js`：Docker daemon / sandbox-exec **实际探测** + `restricted` 受限运行环境 + `require_kernel|docker` 项目 fail-closed。
- 实测本机：Docker daemon 不可用（socket 不存在），sandbox-exec 在嵌套会话不可用 → **内核级隔离 BLOCKED**；未使用 danger-full-access/bypass 绕过。
- 已实际生效的受限控制：每 run/task 独立 HOME/TMPDIR（仓库外）、最小环境变量、工具白名单、测试命令 allowlist、独立 Git worktree/分支、产物路径/符号链接检查。
- `GET /api/isolation` 对外披露能力与每个项目模式；项目要求强隔离而环境不满足时直接阻塞。详见 [ISOLATION.md](ISOLATION.md)。

### 1.5 可靠性修复

- 审计输入增加“未改动参考文件”上下文，支持核对文档声明与实现，不降低证据标准。
- `retryVerification` 增加并发锁（防两个重试同时审计/提交导致竞态）。
- 新增 `POST /api/runs/:id/reconcile`：仅在 commit + verification.commit + PASS 审计同时存在时恢复竞态任务（B 曾因并发重试出现 PASS 后又被 UNKNOWN 覆盖，已按证据恢复，未伪造）。
- 修复测试 TMPDIR 位于 Git 仓库内导致的项目误判；修复 per-provider 预算统计口径。
- 自动化测试：**186 项全通过**（原 180 + provider/GLM、loop、isolation 新增 6）。

## 2. 项目 A（只读接入最新 committed 状态）

- 最新 committed 基线：`architecture/research-v2` @ `13f2620`（本地工作区另有未提交改动，**未读取/未修改未提交内容**；隔离克隆只含 committed tree）。
- 真实任务：按 A 的 P1-SCAN-2（对抗性扫描证据测试）新增测试，覆盖空/伪造哈希/篡改/as_of/过期/部分 ingest/缺失报告；全量离线 pytest 通过；**GLM 独立审计 PASS 91**；commit `7a40071`。
- Claude Code 在 A 隔离克隆中受限会话无进展（未写文件），已取消并记录 **BLOCKED/UNKNOWN**；改用 DeepSeek Harness 完成同一任务，未触碰 A 权威工作区/远端。
- Claude 任务控制权移交未授权；A 远端推送保持 BLOCKED。补丁：`patches/A-P1-SCAN-2-7a40071.patch`。

## 3. 项目 B（READ_ONLY，最新 R37）

- 最新权威状态：本地 main `12648bd`（R37 盖章，baseline 45d4348）；隔离克隆 `projects/v2.1/ia-latest`，独立分支/worktree。
- 真实任务：新增 `tests/test_workbench_handoff_contract.py`（36/36 通过；单 JSON 信封、report.json/md 双落盘、L3/L4 declared-not-produced、SKIP 契约、临时目录隔离）；状态一致性门 7/7、thresholds G1-G4 全绿；**GLM 独立审计 PASS 94**；commit `986f6d3`。
- 未修改 B 权威工作区/研发检查点/LIVE/推送；补丁：`patches/B-handoff-contract-986f6d3.patch`。
- 全量 157 套件在 Workbench 隔离 worktree 中因缺原始数据/环境失败（Phase 0 干净 clone 基线 157/157），如实标记 **UNKNOWN（环境）**，未通过删测试/跳测试获得成功。

## 4. 多项目状态

| 项目 | 状态 | 隔离 | 远端 | 证据 |
|---|---|---|---|---|
| W 自身 | v2.1.0 分支 + PR #3 draft/CI success | 主工作树 | 已推送 v2.1.0 | PR #3、186 tests、3 轮 loop |
| A v2.1 隔离 | LOCAL_VERIFIED 1 任务 | 独立克隆 @13f2620 | 未推送 BLOCKED | commit 7a40071、审计 PASS 91 |
| B v2.1 隔离 | LOCAL_VERIFIED 1 任务 | 独立克隆 @12648bd | 未推送 BLOCKED | commit 986f6d3、审计 PASS 94 |

A/B 的现有独立研发进程未被接管/暂停/修改；工作台仅操作各自独立克隆，数据目录/配置/分支隔离；控制权移交需用户单独授权。

## 5. FAIL / UNKNOWN / BLOCKED（如实）

| 项 | 状态 | 原因 |
|---|---|---|
| 内核级 Agent 隔离（Docker/sandbox） | BLOCKED | 本机 Docker daemon 不可用、sandbox-exec 不可用；未降级危险权限 |
| A 远端 PR / 推送 | BLOCKED | 未授权；本地分支领先远端 main |
| A Claude Code 真实任务 | BLOCKED/UNKNOWN | 隔离克隆中受限会话无进展；已用 DSH 完成同一任务 |
| B 权威树/远端/LIVE 写入 | BLOCKED | READ_ONLY 红线；无控制权移交授权 |
| B 全量 157 套件（Workbench worktree） | UNKNOWN（环境） | 缺原始数据/环境；干净 clone 基线 157/157，未冒充通过 |
| 中断恢复文档任务最终审计 | UNKNOWN | GLM 未返回验收 criteria；恢复机制本身已验证，任务未伪造 PASS |
| 工作台连续第 3 轮之后自动继续 | 未启用（按 maxRounds=3 正常停止） | 未制造任务；可恢复队列/新 loop 继续 |

## 6. 预算披露

- GLM 按授权不受内部上限；真实用量/费用完整记录并单列。
- DeepSeek 受限预算已用 2,756,858 / 3,000,000（缓存折算）；真实成本 ¥14.74 / ¥30。
- 未通过修改统计、隐藏费用或归零实现放宽；仅 GLM 按用户授权豁免，其他模型未放宽。

## 7. 交付与恢复入口

- 代码：`v2.1.0`（本地/远端），PR #3 draft；PR #2 为 v2.0 基线。
- 测试：`npm test`（186）。
- 循环：`POST /api/projects/:id/loops`、`GET /api/loops`；CLI `node bin/workbench.js loop list/status/pause/resume/cancel`；UI「研发循环」面板。
- 隔离：`GET /api/isolation`；预算：`GET /api/usage/providers`、`GET /api/budget`。
- 下一轮：可恢复 W loop（新目标/队列）、A/B 隔离任务（授权后推送/移交）、Docker 宿主机上启用 `isolation_mode=docker`。
