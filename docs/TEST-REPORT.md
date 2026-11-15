# 测试报告（AI 开发工作台 v1.0.0）

> 本报告只记录**真实执行**的结果。所有 Coding Agent 调用、测试命令、独立模型审计、Git / GitHub 操作均为真实执行；
> 未使用 mock 结果宣称验收通过。单元/集成测试为离线回归测试（不调用模型），用于保护编排逻辑。

- 执行环境：macOS（Apple Silicon）/ Node.js v24.13.1 / Git 2.50 / 本机已安装 DSH 与 Claude Code
- Coding Agent：DeepSeek Harness `dsh headless`（真实）、Claude Code（真实，使用本机配置的 GLM-5.3 Anthropic 兼容端点）
- 独立审计：GLM-5.3（真实独立模型；GPT 适配器已实现，等待 `OPENAI_API_KEY`）
- 规划器：DeepSeek（真实，OpenAI 兼容 API）
- 演示项目：`demo/phase1-taskvault`、`demo/phase2-notes-api`、`demo/phase3-log-audit`
  - 三者均带**预置的、已评审的验收测试**；运行期间启用 protected paths，Agent 修改测试会被还原并记录违规，从未修改测试来“通过”。

---

## 一、离线自动化测试

命令：`npm test`（零依赖、无需 API Key、不消耗 token、不访问网络）

```
ℹ tests 84
ℹ suites 16
ℹ pass 84
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 4461
```

| 套件 | 用例数 | 覆盖内容 |
|---|---|---|
| `tests/util.test.js` | 30 | JSON 抽取（纯文本/围栏/夹杂/非法）、glob 与保护路径匹配、dotenv、脱敏、截断、ID/slug |
| `tests/policy.test.js` | 22 | 审计结论硬校验（unproven 不算通过、high finding 直接 fail、不信任模型自述 verdict）、预算超限、保护路径 |
| `tests/db.test.js` | 10 | SQLite CRUD、状态机 CAS、事件游标、usage 累加、actions 结果持久化回归 |
| `tests/pricing.test.js` | 6 | 成本估算、缓存 token、格式化 |
| `tests/github.test.js` | 4 | GitHub Actions 工作流生成与不覆盖语义 |
| `tests/planner.test.js` | 8 | 显式任务模式、单任务模式、非法计划拒绝、无 Key 时不伪造规划 |
| `tests/orchestrator.test.js` | 4 | 注入假 Agent/审计器 + 真实 Git 临时仓库的编排器集成测试 |

编排器集成测试覆盖（全部离线）：
- A. 编码 → 测试 → 审计 fail → 反馈修复 → 审计 pass → 提交 → waiting acceptance；断言 run usage 精确累加、分支/提交、审计 2 条、事件序列、发布动作 blocked；
- B. Agent 篡改受保护测试文件 → 文件被还原、`protected_path_violation` 事件、任务失败；
- C. 暂停（中间态）→ 恢复 → 任务重新排队并最终通过，计划分支保留；
- D. 预算耗尽 → 运行暂停、`stop_reason` 含预算原因、不允许验收。

> 集成测试第一次运行暴露了一个真实缺陷：`updateAction` 只读取 `result_json` 而编排器传入 `result`，导致 GitHub PR/CI 结果丢失。该缺陷已修复（兼容两种写法），并发过程中发现的 `plan_id` 未持久化、`git` 未再导出、Claude 端点回退、token 统计字段名不匹配等缺陷也一并修复，均有回归覆盖。

## 二、阶段一：单项目 + 独立审计 + 失败自动修复（真实）

- 项目：TaskVault（6 个预置验收测试，测试文件受保护）
- 模式：`single`
- 证据：`demo/evidence/phase1-1794730530865.json`

| 指标 | 真实结果 |
|---|---|
| 运行状态 | `awaiting_acceptance`（等待人工验收，未合并） |
| 编码尝试 | **2 次** |
| 第 1 次测试 | `npm test` 通过（6/6） |
| 第 1 次独立审计 | **GLM-5.3 verdict=fail，score=75**；逐条标准 5/6 通过；失败项为隐藏验收（缺 `CHANGELOG.md` 与 README 链接） |
| 自动修复 | 审计 `required_fixes` 反馈给同一 DSH 会话；Agent 新增 `CHANGELOG.md`、修改 README 链接 |
| 第 2 次测试 | `npm test` 通过 |
| 第 2 次独立审计 | **GLM-5.3 verdict=pass，score=96；6/6 验收标准通过（含隐藏项）** |
| 提交 | `d196a834ee76…`（计划分支 `wb/plan-cb4a53`） |
| token 消耗 | 219,045（含缓存读取） |
| 成本 | ¥0.2067 |
| 发布动作 | 当时无 GITHUB_TOKEN → `blocked` 记录（后补 Token 用于阶段三） |

**结论：阶段一真实验收通过。** 审计失败 → 自动反馈 → 修复 → 复审通过闭环为真实发生。

## 三、阶段二：多任务规划 + 自动推进 + 进程崩溃恢复（真实）

- 项目：Notes API（3 个依赖任务，3 组预置验收测试）
- 规划：真实 DeepSeek 调用，读取 README/TASKS.md/文件树，自动生成 3 个任务（测试命令与 TASKS.md 一致）
- 中断：首个任务通过、任务 2 编码中，脚本对工作台进程发送 **SIGKILL**
- 证据：`demo/evidence/phase2-1794731070449.json`

| 指标 | 真实结果 |
|---|---|
| 中断快照 | 任务 1 `passed`（commit 7958c560…）、任务 2 `coding`、任务 3 `queued`；服务进程 PID 30568 被杀 |
| 重启后状态 | `run_interrupted` 事件；运行状态 `interrupted`（原因记录为进程重启） |
| 恢复 | 调用恢复接口后任务 2 重新排队、worktree 重建、计划分支保留任务 1 提交 |
| 最终任务 | 任务 1 attempt 1、审计 pass 96；任务 2 attempts 2、审计 pass 93；任务 3 attempts 2（首次审计 fail 82 “unproven” → 修复 → 审计 pass 92） |
| 运行状态 | `awaiting_acceptance`，3/3 任务通过 |
| 耗时 | 16:17:09 → 16:24:29（7 分 20 秒，含中断重启） |
| token 消耗 | 493,485 |
| 成本 | ¥0.4326 |

**结论：阶段二真实验收通过。** 真实 SIGKILL 进程中断 → 重启 → 断点恢复 → 继续完成全部任务。

## 四、阶段三：多项目并行 + 跨 Agent + GitHub PR / Actions（真实）

- 项目 A：Log Audit（任务 1 → DSH，任务 2 → Claude Code，同计划内跨 Agent）
- 项目 B：Notes API 并行项目（DSH，`publish:false` 仅本地）
- 两个运行在同一秒并发启动（08:36:19.63 与 08:36:19.73）
- 阶段过程中暴露并修复了 Claude Code 端点回退缺陷（`CLAUDE_BASE_URL` 为空时未回退 GLM 端点，导致首轮 Claude 调用 401）；修复后用恢复接口真实继续运行
- 证据：`demo/evidence/phase3-1794732193498.json`

| 指标 | 项目 A（Log Audit） | 项目 B（Notes 并行） |
|---|---|---|
| 任务 | 2（1 个 DSH + 1 个 Claude Code） | 1（DSH） |
| 审计 | GLM-5.3 pass 97 / pass 95 | GLM-5.3 pass 95 |
| 尝试 | 2 / 3（首轮 Claude 端点错误后修复重跑） | 1 |
| 结果 | `awaiting_acceptance` | `awaiting_acceptance` |
| token | 278,589 | 105,520 |
| 成本 | ¥0.9253 | ¥0.1280 |

GitHub 真实结果（API 复核）：

| 项 | 结果 |
|---|---|
| 仓库 | 私有仓库 `（私有演示仓库，已脱敏）`（工作台自动创建） |
| 分支 | 计划分支 `wb/plan-bb665d` 推送成功（commit `25160790…`） |
| PR | **草稿 PR #1**，open、draft=true、merged=false：（私有演示仓库 PR #1，链接已脱敏） |
| GitHub Actions（PR 分支） | **CI success**：（私有演示仓库 Actions 运行，链接已脱敏） |
| GitHub Actions（main 基线） | failure（预期：基线是占位实现，尚未开发；PR 分支通过才是验收信号） |
| 合并 | **未合并任何分支** |

**结论：阶段三真实验收通过。** 多项目并行、任务级跨 Agent、真实 GitHub 分支/草稿 PR/Actions 结果均已验证；工作台无合并代码路径。

## 五、汇总

| 项目 | 数值 |
|---|---|
| 三阶段真实总 token | 1,096,639（含缓存读取；预算 3,000,000） |
| 三阶段真实总成本 | ¥1.6926（预算 ¥30） |
| 真实 Coding Agent 调用 | DSH 多次 + Claude Code 真实调用；均产生真实提交/测试/审计 |
| 审计结论硬校验 | 通过；隐藏项、unproven、high finding 均能阻止提交 |
| 测试文件保护 | 生效，全部演示未修改任何验收测试 |

## 六、未完成项 / 限制（如实披露）

1. **GPT 独立审计未真实执行**：本机没有 `OPENAI_API_KEY`。当前使用 GLM-5.3 完成真实独立模型审计；GPT 适配器（`src/llm.js` + `src/auditors/index.js`）已实现，配置 Key 后审计自动切到 GPT。界面、事件与证据均如实标注 provider。
2. **GitHub main 基线 CI 失败为预期**：演示仓库的 main 是未实现的占位基线，push 触发的 CI 必然失败；PR 分支 CI 成功才代表交付通过。真实项目接入时建议只在 PR 上要求该检查。
3. 阶段三在真实运行中先遇到 Claude 端点配置缺陷，修复后通过恢复接口继续完成；证据保留完整失败与恢复轨迹，未删改历史。
4. 本机为嵌套沙箱环境，DSH 的 `workspace-write` 沙箱后端不可用，演示使用 `danger-full-access`；普通宿主机建议使用 `workspace-write`。
5. 同一计划内任务顺序执行（保证依赖正确）；跨项目并行。任务级 DAG 为后续版本。
6. GitHub Token 与模型 Key 仅存本机 `.env`（0600、gitignore、日志脱敏）；演示结束可在 GitHub 撤销 Token。


---

# v2.0.0 追加测试与验收记录（2026-11-15）

## 离线自动化测试

- `npm test`：**180 项全部通过**（原 84 项保持 + 新增 96 项：安全 41、审计硬化 36、升级 7、服务安全 12）。
- 覆盖：最小 Agent/测试环境、危险权限 fail-closed、审计证据/三态/分块、CI 状态与 SHA 绑定、API Token/Cookie/CSRF/Host、路径与 symlink、artifact 白名单、候选升级副本、预算与失败签名。

## 真实运行验收

| 项目 | 任务 | Agent | 测试 | 独立审计 | 验证状态 | Commit |
|---|---|---|---|---|---|---|
| W | /api/health verification + API 文档 | Claude Code（受限） | npm test 180/180 | DeepSeek PASS 88 | **CI_PASSED**，PR #1 + Actions success | a8d4fe61 |
| A | PIT no-lookahead 回归测试 | DeepSeek Harness（workspace-write） | 全量离线 pytest 通过 | GLM PASS 92 | LOCAL_VERIFIED（远端未授权） | 8dd43985 |
| A | 工作台接入文档 | Claude Code（受限） | 全量离线 pytest 通过 | DeepSeek PASS 92 | LOCAL_VERIFIED（远端未授权） | d5f849a2 |
| B | A→B handoff 契约测试 | DeepSeek Harness（沙箱克隆） | 36/36 新测试 + 状态门 7/7 + thresholds 全绿 | GLM PASS 92 | LOCAL_VERIFIED（权威树/远端 BLOCKED） | 15e0aa4e |

## 自我升级候选

- 候选测试 PASS（180）、隔离实例 PASS（v2.0.0）、真实 E2E 任务 awaiting_acceptance / LOCAL_VERIFIED。
- 证据：`demo/evidence/upgrade-1794740416372.json`、`v2-final-1794741064.json`、`v2-w-a-1794740150.json`。

## 预算披露

- 原始 token 8,135,158（其中约 7,4M 为缓存读取），按缓存权重 0.1 折算预算消耗 1,342,102 / 3,000,000；实际成本 ¥9.44 / ¥30。
- 若严格按原始 token 计，已超 3M 授权上限；该口径差异已如实披露，不宣称原始 token 预算通过。详见 `docs/v2/FINAL-REPORT.md` §5。


---

# v2.2.0 测试与验收追加（2026-11-15）

- `npm test`：**198/198 通过**（v2.1 186 + 新增 12：容器执行 6、模型身份 6）。
- 容器真实执行：Docker 29.9.2 + `ai-workbench-runtime:2.2`；容器内 Claude Agent/测试 E2E PASS（run_mwhwfr2v37fcbdab，审计 PASS 100，commit 44995153）。
- GLM 身份/预算：`tests/model-identity.test.js` 覆盖 GLM/DeepSeek/OpenAI/unknown；unknown 不豁免。
- 可靠性循环：3 个真实任务、SIGKILL 恢复、无任务/能力阻塞停止；详见 `docs/v2.2/REPORT.md` 与 `ACCEPTANCE-MATRIX.md`。
- 诚实披露：round2/3 中 Agent 自主完成受限（DeepSeek 预算耗尽、Claude 无进展），由 Supervisor 完成代码后仍经真实测试+独立审计；Agent 全自动完成率 1/3。容器 Agent 网络 egress allowlist 为 UNKNOWN/PARTIAL。
