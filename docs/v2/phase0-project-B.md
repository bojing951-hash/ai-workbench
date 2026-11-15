# Phase 0 · 项目 B（investment-agent）现状矩阵与接入判断

> 分析人：Phase 0 项目接入分析师（只读）；分析时间：2026-11-15 17:30–17:58 HKT。
> 数据来源：权威研发树 `~/investment-agent-dev`、研发循环状态目录 `~/agent-loop`、工作区克隆 `projects/v2/investment-agent`、同仓关联 worktree `~/investment-agent-reform`（由 `git worktree list` 发现）、本地 Git 对象/日志。
> 纪律：全程只读；本文件是本轮**唯一**写入文件。未改/未提交任何被分析仓库，未触碰 LIVE、launchd、生产数据、`~/AI内容库/.../investment-agent` 历史副本。
> 环境局限：`/bin/ps` 被沙箱拒绝（`Operation not permitted`），进程存在性改用 launchd plist、日志、文件 mtime 与 Git 证据判定；未联网，GitHub 远端与 CI 结论无法实时复核（见 §7 UNKNOWN）。

---

## 0. 结论速览

- **接入结论：READ_ONLY**（对权威研发树 `~/investment-agent-dev`、`~/investment-agent-reform`、`main` 分支/远端、LIVE 面）。唯一允许写入的域是**工作区隔离克隆** `projects/v2/investment-agent` 的独立沙箱分支，且不得 push、不得合并、不得写回权威树；Phase 0 本身零写入。
- **真实进度**：R36「R25 审计余留 NIT 三修（T-R36-1）」已由操作者席完成并**合入本地 `main` + 并轨尖重盖章**（`ee4fbb6`，17:46:57；round=36 @ `6dcc594`）；但 **`origin/main` 仍停在 R35 `0f53463`（17:06），R36 尚未推送**（截至 17:57 观测）。权威树检出 `dev/rd-r35-engine-track` @ `fe38275`（干净，已并入 origin/main）；最新 tag `v0.24.0-alpha`；最终验收矩阵 **9 PASS + AC3 PARTIAL**（AC3 等 2026-12 日历门），整体**未完成**。
- **外部研发循环状态**：无 headless 轮在跑（无锁、无 STOP；上一轮 15:35:49→16:58:21 rc=0）；但操作者席 R36 会话在本分析窗口内完成了「未提交改动 → 提交（`a612097`）→ 合并本地 main（`6dcc594`）→ 盖章（`ee4fbb6`）」全链（17:27→17:46:57，三个 worktree 同时在场），**推送/发布与研发循环记账可能仍在进行**。**当前不可向 B 的任何共享树写入。**
- **CI/测试**：`.github/workflows/offline-tests.yml` = py3.11 + 全量史 + 全离线套件串行（CI 实跑 157 条；R36 后 158 条；跳过 `test_model_live`）+ `thresholds_gate.py` G1–G4 + `rd_state_consistency.py` 七项硬门 + 非阻塞漂移顾问。**本分析在干净 clone 上实跑两轮全库：R35 基线（`0f53463`）157/157 OK/0 FAIL/514 s；R36 本地 main（`ee4fbb6`）158/158 OK/0 FAIL/481 s**；关键门复跑均绿（7/7 一致性门×2、G1–G4×2、R36 新套件 23/0）。外部 R36 会话 17:55 亦自报净树复验 `total=159 red=0`、门 7/7×2。
- **A→B 交接**：A=`global-opportunity-engine` 以 `HANDOFF_SCHEMA v1.0` JSON + `goe handoff` 适配器调用 `ia_cli.py research-run --question … --out-dir …`，B 侧接收面已在（实测 CLI 帮助），但**没有跨仓库自动化回归门**，现有验证=双方单测 + 文档级真实跑记录。
- **3 个候选低风险任务**（仅在沙箱分支可执行）：① `skipped_step` SKIP 语义/台账 `[OK|—]` 修正；② R1 MINOR-6 `since_publish` 两态注记拆分；③ A→B handoff 契约冒烟测试（纯新增测试）。
- **硬阻塞**：merge main/推送（公开发布，用户逐波批准）、LIVE 部署/launchd/生产数据、付费 API/新凭证/真实模型调用、联网采集与真实研究验收、修改冻结验收标准、写 `~/agent-loop`；**当前外部 R36 活跃**是最强的「不可写」理由。

---

## 1. 权威状态与真实进度

### 1.1 现场清单（4 个 Git 工作树 + 1 个禁区副本）

| 位置（相对/`~`） | 角色 | 分支 / HEAD | 工作区状态 | 判定 |
|---|---|---|---|---|
| `~/investment-agent-dev` | 任务指定**权威研发树** | `dev/rd-r35-engine-track` / `fe38275`（2026-11-15 16:56:49 HKT） | `git status --porcelain` **空**（干净） | 只读；HEAD 是 `origin/main` 祖先；本地 `main` 已因 R36 推进 |
| `~/investment-agent-reform` | 同仓库 **linked worktree**（其 `.git` 文件指向 dev 树 `.git/worktrees/investment-agent-reform`） | `dev/rd-r36-attach-nits` / **`a612097`**（17:46:03 提交 R36，基点 `0f53463`） | 17:48 观测：已提交后干净（17:27–17:45 期间有未提交改动） | R36 来源分支（已并入本地 main），**禁止触碰** |
| `/private/tmp/r36-merge` | R36 合并/盖临时 worktree（**本分析期间新建**） | `main` / **`ee4fbb6`**（17:46:57 R36 盖章） | 干净 | 本地 `main` 当前检出点；临时目录，**勿依赖勿写** |
| `projects/v2/investment-agent`（工作区克隆） | 只读对照快照（GitHub 克隆） | `main` / `0f53463`（R35；落后本地 main 3 提交） | 干净 | 唯一可作 Workbench `local_path` 的副本；**需待 R36 推送后刷新** |
| `~/AI内容库/.../investment-agent` | **历史副本 = LIVE 面**（launchd 指向） | 未访问 | 未访问 | 任务禁区，未触碰 |

### 1.2 分支 / HEAD / 最近提交（权威树）

- 权威树当前分支：`dev/rd-r35-engine-track`；HEAD = `fe38275c4ee6216ce9e75c95a8bf80ea415cecaa`（R35 收口扫尾2，16:56:49）。
- **本地 `main` = `ee4fbb67…`（R36 盖章，17:46:57，round=36 @ `6dcc594`）**；**`origin/main` = `0f53463…`（R35 盖章，17:06:38）**；本地 main 领先 origin/main **3 提交且尚未推送**（`rev-list origin/main..main = 3`）。
- `git merge-base --is-ancestor HEAD origin/main` **成立** → 权威树 HEAD 已并入 origin/main（不是未推送的分支头）；但 `HEAD != main`：本地 main 在其上多 5 提交（R36 的 `a612097`→merge `6dcc594`→盖章 `ee4fbb6`，加 R35 的 merge+盖章 2 笔，均属检查门①容忍类）。
- 最近提交（时间倒序，HKT）：
  1. `ee4fbb6` **17:46:57** R36 盖章（检查点块+基线机器行 round 36 @ 6dcc594）— **本地 main，未推送**
  2. `6dcc594` **17:46:21** Merge `dev/rd-r36-attach-nits`（R36 R25 审计余留 NIT 三修）— **本地 main，未推送**
  3. `a612097` **17:46:03** R36 R25 审计余留 NIT 三修（T-R36-1；Ni-3 原子写/Ni-2 attach_history/Ni-4 副指标重复明示拒）— R36 分支
  4. `0f53463` 17:06:38 R35 盖章（并轨尖重盖章）— **= origin/main（GitHub 最后已知尖）**
  5. `cf0a879` 17:06:22 Merge dev/rd-r35-engine-track（R35 利差辖域披露升位+自对算术守卫）
  6. `fe38275` 16:56:49 R35 收口扫尾2（权威树 HEAD）
  7. `5dd583a` 16:54:14 R35 收口扫尾（删快照节占位 baseline 残行 + B2b 措辞 NIT）
  8. `24630b1` 16:50:21 R35 检查点盖章落盘（round=35 commit=dc16ec3；六项门 7/7）
  9. `dc16ec3` 16:16:20 R35 独立审计 MAJOR-1 修（spread consumed 被裁集，套件 18/0）
  10. `b55c8af` 16:03:54 R35 利差辖域披露升位 + 自对算术守卫（RDG-008/009）
- 版本面：最新 tag `v0.24.0-alpha` @ `f430c39`（R28 面）；**本地 main 已超前 tag 21 个提交**（`git describe main = v0.24.0-alpha-21-gee4fbb6`；dev HEAD describe = `-16-gfe38275`）；R36 后**本地 main 无新 tag/Release 证据**。提交数：origin/main/克隆 = **611**（与任务描述一致），本地 main（R36）= **614**，权威树 dev HEAD = 609（分支不含 main 上的 merge+盖章 2 笔）。工作区克隆 22 MB。

### 1.3 检查点（RD-CHECKPOINT）与状态门

`docs/autonomous-rd/RESUME.md` 的机器块（勿手写）有**三个视角**，判定时必须区分（本分析窗口内新增了第三个）：

| 面向 | 位置 | round | commit / baseline | 时间 |
|---|---|---|---|---|
| 分支面（R35） | 权威树 `dev/rd-r35-engine-track` 的 RESUME | 35 | `dc16ec35…` / `dc16ec35…` | 16:50 HKT |
| origin/main 尖（R35，GitHub 最后已知） | 工作区克隆 / `origin/main` 的 RESUME | 35 | `cf0a8795…` / `cf0a8795…` | 17:06 HKT（并轨尖重盖章，R32 判例） |
| **本地 main 尖（R36，未推送）** | 本地 `main`/`ee4fbb6` 的 RESUME | **36** | `6dcc59476…` / `6dcc59476…` | **17:46 HKT**（R36 并轨尖重盖章） |

- `goal_sha = 7535a141b2339a13` 与实算 `docs/autonomous-rd/PRODUCT_GOAL.md` 的 sha256[:16] **一致**（目标未漂移；R36 未改目标）。
- 祖先核验：`dc16ec3` 是 dev HEAD 祖先 ✅、是 origin/main 祖先 ✅；`cf0a879` 是 origin/main 祖先 ✅；R36 检查点 `6dcc594` 是本地 main 祖先 ✅（`ee4fbb6` 的父）。
- **一致性门实跑**（只读）：① 工作区克隆 R35 尖（`0f53463`）→ **7/7 PASS，0.78 s**；② 临时 clone 的本地 main R36 尖（`ee4fbb6`）→ **7/7 PASS，0.81 s**（⑦b R36 根因门在场；①容忍 1 提交=盖章自指）。两次都跑了 `scripts/rd_state_consistency.py` 与 `scripts/thresholds_gate.py`（后者均 G1–G4 全绿）。
- 检查点管线纪律（`scripts/rd_checkpoint.py`）：`--finalize` 要求 ITERATION_LOG 已有 R<N> 行、`completed_ids` 非空、next_round≥round+1，机器取值=实际 HEAD；盖章后自动跑六项门，门红禁收口；`--finalize` 会写 RESUME 检查点块与 CURRENT_STATE baseline 行（本分析**未运行** finalize，只跑了只读 `--verify`/一致性检查脚本；R36 的 finalize 由操作者席在 17:46:57 完成）。
- 最终验收（`FINAL_ACCEPTANCE.md`）：**9 行 PASS + AC3 PARTIAL**（AC3=C 型到期预测实判，须等 2026-12 六标签首验窗；A 面 vintage 仍 DEGRADED 近似锚）。整体目标**未完成**，且不得以 CI 绿/文档 PASS 冒充真实验收（项目红线）。

### 1.4 未完成队列 vs 当前在飞

**RESUME 队列（R36 收口后·本地 main 未推送版）**：
1. **R37+ 引擎轨道续行**：T8-R2 非阻断余留七项①–⑦（real-face 0/3 定性、band_label 双报、`_check_score_total` 硬编码维度、era `base_anchor_set` 必填、narrative checker 仅 3 指标、重封留出、变异压力轮）；`round.sh` 资源双上限「硬接线」=LIVE 部署时事项。
2. **操作者席**：R35 波次已于 17:06 合并推送；**R36 已于 17:46 合并本地 main + 盖章，但截至 17:48 尚未推送**；后续波次合并仍需用户**逐次批准**（公开仓推送=公开发布）。
3. **日历门（勿手工提前）**：F 补证轮 2026-12-05 观察钟满；机构观点六标签首验窗 2026-12。
4. **低优先候选**：HK 双通道脆弱面 / china 子源失败落盘 / R13 审计 2 NIT / R25 审计 Ni-2~5（**Ni-2/Ni-3/Ni-4 已由 R36 收口；Ni-5 仍在**）/ OPEN_ISSUES 按需取用。

**当前真实在飞（本分析时段现场证据：R36 操作者紧凑波已完成本地收口）**：
- **时间线**：17:27 起在 reform worktree 编码 → **17:46:03** 提交 `a612097`（6 文件，+441/−40）→ **17:46:21** 合并入本地 `main`（merge `6dcc594`，用临时 worktree `/private/tmp/r36-merge`）→ **17:46:57** 盖章 `ee4fbb6`（round=36 @ `6dcc594`）→ 17:57 观测：本地 main 领先 origin/main **3 提交且未推送**，reform/临时 worktree 全部干净。
- **内容（T-R36-1）**：Ni-3 原子写（`_atomic_write_text` 临时+`os.replace`，三写点；`_write_report` 先渲 md 后落盘）、Ni-2 `attach_history` 追加链（换代不抹旧、≤5 轮、blocked/成功两路径）、Ni-4 副指标重复 SCN-FALS2 契约明示拒。
- **本分析对 `ee4fbb6`（本地 main 尖）的独立只读亲核**：`rd_state_consistency.py` **7/7 PASS**（0.81 s）、`thresholds_gate.py` **G1–G4 全绿**、新套件 `tests/test_rd_r36_attach_nits.py` **23 PASS / 0 FAIL**（0.63 s）；全库复跑见 §3.2。R36 会话自报：受影响面 r23 29/0、r24 43/0、r25 44/0、r33 14/14，全库 159 件=158 OK+1 红（phase6 D3 波中记账面）。
- **未完成/未确认**：R36 的 push/发布（origin/main 仍 `0f53463`）、`~/agent-loop/STATE.md` 与 rounds index 的 R36 记账、下一轮由哪一席接。17:55 外部会话做了**净树复验**（`/tmp/r36_fresh_verify.log`：`SUITE DONE total=159 red=0`、门 7/7×2）并抓取 GitHub Actions 页面（`/tmp/gh_actions.html`），说明其正在做「净树 + CI 核验」收尾，**仍可能在分析结束后 push**。下一引擎轮预计 **19:0x–20:40** 开班（`STATE.md` 记「引擎下轮 ~11:0x UTC 自接」=HKT 19:0x；launchd StartInterval 4h）。
- 注意：R36 未提前登记 `[进行中·R36]` 台账项（R32–R36 操作者席轮次不记引擎轮档案 `~/agent-loop/headless/rounds/index.md`，属既有惯例），故「当前轮」只能由 worktree/git 现场判定，不能由状态档单独判定。
- **规模影响**：R36 把 `tests/` 从 158 件增至 **159 件**（已进本地 main，尚未进 origin/main）；Phase 1 刷新基线后应重跑全库。

---

## 2. 研发循环 / 写锁状态与写入结论

### 2.1 调度器与互斥机制（headless 引擎）

- launchd 用户级句柄 `com.investment.rd-headless`：`StartInterval = 14400`（4 小时）、`RunAtLoad=false`、`ProgramArguments = /bin/bash ~/agent-loop/headless/round.sh`。
- `round.sh` 机制（`~/agent-loop/headless/round.sh`）：
  - **急停**：`~/agent-loop/headless/STOP` 在场则整轮跳过；
  - **互斥锁**：`mkdir ~/agent-loop/headless/lock` 成功才开轮，失败则 `age>6h` 视为陈锁清理、否则跳过；`trap` 退出清锁；
  - 代理自适应（127.0.0.1:7890 探活）→ 发现 claude 二进制 → `claude -p PROMPT.md --permission-mode acceptEdits --max-budget-usd 50`；
  - 硬边界（允许清单）：仓库内读写 + python3 + 本地 git（add/commit/switch/branch/worktree/stash）；**拒绝** `git push`、`git remote`、`ssh/scp`、`curl`、`npm/pip`、`rm -rf`、`switch/checkout main`、LIVE 部署与付费面；
  - 资源上限：`MAX_WALL_SEC=9000`（150 min）、`MAX_BUDGET_USD=50`（用户 2026-11-13 授权“不限制预算”后保留的防跑飞安全界）。
- 无头轮硬纪律（`PROMPT.md`）：一轮只做一轮；工作全在 `dev/` 分支；**不做异步泊靠**（回归必须前台同步跑完）；波次毕只记「待操作者合并发布」，合并/推送/Release/LIVE 归操作者会话。

### 2.2 现场检查（锁 / 轮次 / 活跃进程）

| 检查项 | 实测 | 说明 |
|---|---|---|
| `~/agent-loop/headless/lock` | **不存在** | 无引擎轮持有互斥锁 |
| `~/agent-loop/headless/STOP` | **不存在** | 未急停 |
| 最近 headless 轮 | `round_20261115_153549.log`：15:35:49 开 → **16:58:21 `round done rc=0`** | 无头轮已正常结束 |
| 轮次节奏 | 01:45 / 06:05 / 10:30 / 15:35 开轮（每 4–5h） | 下一轮约 **19:00–20:40** 触发（STATE 记「引擎下轮 ~11:0x UTC 自接」=19:0x HKT；推断，非实测） |
| `~/investment-agent-dev` | 16:56 后无新提交、无未提交、无 `.git/index.lock`、无 `.lock` 文件 | 权威树工作树静默（但共享 refs 被 R36 更新） |
| `~/investment-agent-reform` | **17:27→17:46 持续写入**；17:46:03 提交 `a612097`（6 文件 +441/−40），17:48 观测工作区干净 | R36 来源分支（已并入本地 main） |
| `/private/tmp/r36-merge`（新建临时 worktree） | 17:46:21 合并 + 17:46:57 盖章于本地 `main`（`ee4fbb6`） | R36 合并/盖章操作面；临时目录 |
| **本地 `main` vs `origin/main`** | 本地 main=`ee4fbb6`（17:46:57，R36）；origin/main=`0f53463`（17:06:38，R35） | **R36 有 3 提交未推送**（17:48 观测） |
| `~/agent-loop/STATE.md` | mtime **17:17**（R35 全链闭合记账）；尚无 R36 记账证据 | 研发循环状态面最新写入 |
| `~/agent-loop/PENDING-APPROVALS.md` | 「排队中」为空（无待批）；文件 mtime 2026-11-08（后续审批记在 STATE/RESUME） | 无新增待批事项阻塞 |
| `~/agent-loop/contracts/` | 最新合同 mtime 2026-11-08 | 无当前轮合同/冻结件 |
| R36 批跑/复验日志 | `/tmp/r36_full_suite.log`（17:36/17:43）、`/tmp/r36_one.log`（17:37–17:43）、**`/tmp/r36_fresh_verify.log`（17:55：`SUITE DONE total=159 red=0`、门 7/7×2、`R20-CP OK`）**；另 `/tmp/gh_actions.html` 17:56 | 外部会话在跑测试与净树/CI 核验 |
| 进程表 | `/bin/ps` **被拒**（`Operation not permitted`） | 无法直接列进程，故以上为文件/日志证据；局限如实声明 |

补充：`~/investment-agent-reform` 是 dev 树 `.git` 的 linked worktree（共享对象库、独立工作树/索引），所以**对 dev 树或 reform 树的任何 Git 写操作都可能与 R36 会话的 index/对象/分支操作交叉**。

### 2.3 写入结论：**READ_ONLY**

结论为 **READ_ONLY**（对 B 的权威树、三棵 Git worktree（dev / reform / 临时 merge 面）、`main` ref、GitHub 远端、LIVE 面全部只读）。依据：

1. **活跃外部写面**：操作者席 R36 在 `~/investment-agent-reform` 从 17:27 持续写到 17:46，并进一步**合并本地 main（`6dcc594`）+ 盖章（`ee4fbb6`）**（17:46:21/17:46:57），mtime/日志/commit/ref 连续更新（§2.2）——任何写到该 Git 仓库/shared 对象库的动作都可能造成撞车或状态面污染。**这不是一次性快照：观测窗口内它完成了「未提交改动 → 提交 → 合并 → 盖章」多步演进，说明写入方仍在推进，且本地 main 已不再是 Phase 0 开始时的 `0f53463`。**
2. **无可安全持有的锁**：引擎轮的互斥锁当前不存在（说明引擎空闲而非可占用），但**操作者席会话不经过该锁**，第三方无法用任何「锁文件」获得写安全语义；项目也没有 lease/租约协议可依。
3. **权限与卡点**：`CLAUDE.md` 红线=「一切开发在 `dev/*` 独立分支；未经用户授权不合并 main、不推送公开仓（推送=公开发布）」；用户三保留卡点=①封版合并 main ②新数据源凭证/付费 ③LIVE 部署，均须用户亲自批准（历史审批只对当波有效，后续逐波请批）。**R36 合并/盖章是操作者席权限面内的动作，不代表 Workbench 获得同类权限。**

**唯一允许的写入域**：工作区隔离克隆 `projects/v2/investment-agent`（独立 `.git`，无任何外部进程访问）在 Workbench 专属分支（如 `workbench/<task>`）上做本地实现/测试并产出 patch/diff 供人工审查；**不得 push、不得合并 main、不得写回任何权威树**。R36 虽已在本地收口（`ee4fbb6`），但**尚未推送、外部会话可能仍在收尾**，Phase 0 结论维持 **READ_ONLY**；待主线稳定（推送完成、无活跃会话）且操作者/用户授权，可升级为「沙箱分支 WRITE_SAFE」，但**向真实仓库/远端的写法在 Phase 0 一律 BLOCKED**。

---

## 3. CI 与本地测试（真实可复现）

### 3.1 CI 门禁（`.github/workflows/offline-tests.yml`，唯一 workflow）

- 触发：push / PR 到 `main` + `workflow_dispatch`；`runs-on: ubuntu-latest`；Python 固定 **3.11**。
- checkout：`actions/checkout@v5` + `fetch-depth: 0`（全量历史——R20/R21 状态套件要核检查点提交的祖先链，浅克隆会红）。
- 依赖安装（**真实第三方依赖**，来自 workflow 而非 requirements.txt 全量）：
  `pip install requests openai pandas fredapi feedparser finnhub-python tushare yfinance six xlrd`
- Step「运行全部离线测试套件」：`for t in tests/test_*.py` **逐套件串行**，显式 **跳过 `test_model_live`**（真实模型 API 付费调用，契约禁入 CI）；每套记录 exit code，任一失败 → `::error` annotation + 失败套件日志 artifact，最终 exit 1。
- Step「thresholds 三方对账门 G1–G4」：`python3 scripts/thresholds_gate.py`（任一门红=CI fail；SIGNED v1.0 键集 + 4 个 pending ISM 键显式豁免）。
- Step「研发状态一致性门」：浅克隆先 `git fetch --unshallow`，然后 `python3 scripts/rd_state_consistency.py --repo . --state-dir docs/autonomous-rd`（六/七项任一 FAIL 即红）。
- Step「研发进展漂移顾问」：`python3 scripts/rd_progress_watch.py …` 非阻塞（预警可见性）。
- 语义：CI 绿 = 工程门绿；**≠** 最终验收（项目红线，六层区分）。

### 3.2 本地复现（本次实测，全部只读、`-B` 禁 pycache、未联网）

环境事实：仓库**无 venv**（dev 树/reform/克隆均无 `.venv`）；系统 `/usr/bin/python3 = 3.9.6`，`requirements.txt` 的 17 个包已装齐（实测 import 全 OK，含 akshare/bs4/lxml/numpy/pandas/openai/requests/fredapi/feedparser/finnhub/tushare/yfinance/six/xlrd/dateutil/schedule/tabulate/html5lib）；CI 用 3.11，本地 3.9.6 存在版本差（低风险、如实标注）。

| 命令（仓库根执行） | 实测结果 | 耗时 |
|---|---|---|
| `python3 -B scripts/rd_state_consistency.py --repo . --state-dir docs/autonomous-rd` | **7/7 PASS** | 0.78 s |
| `python3 -B scripts/thresholds_gate.py` | **G1_forward/G1_reverse/G2/G3/G4 全 PASS**（pending 4 键显式列出） | 0.16 s |
| `python3 -B tests/test_rd_r35_spread_disclosure.py` | **18 PASS / 0 FAIL**（含变异自证 2/2） | 0.48 s |
| `python3 -B tests/test_rd_r33_seat_runtime.py` | **exit 0** | 0.27 s |
| `python3 -B tests/test_ia_cli.py` | **38 通过 / 0 失败** | 3.59 s |
| `python3 -B tests/test_rd_r20_state_consistency.py` | **exit 0**（含多组临时 git 仓库反例） | **129.46 s（单套最慢）** |
| 全库串行（R35 基线 `0f53463`，157 套件） | **157/157 OK、0 FAIL**（`test_model_live` 跳过）；`test_arch_reform_phase6.py` 29/0 绿 | **514 s ≈ 8.6 min**（串行，Python 3.9.6） |
| 全库串行（R36 本地 main `ee4fbb6`，158 套件） | **158/158 OK、0 FAIL**（`test_model_live` 跳过） | **481 s ≈ 8.0 min**（串行，Python 3.9.6） |
| R36 外部会话净树复验（17:55，`/tmp/r36_fresh_verify.log`） | `SUITE DONE total=159 red=0`；`rd_state_consistency` 7/7 ×2；`R20-CP OK` | 与本分析互证（159 含被跳过的 `test_model_live` 计数口径） |

> 全库批跑说明：两轮都在临时 clone（`/tmp/b-phase0-*` / `/tmp/b-r36-*`）逐套件串行执行 `python3 -B tests/test_*.py`（跳过 `test_model_live`）；跑完 `git status --porcelain` 均为空（测试不污染工作树；`r20` 套件会按设计在对象库造悬空对象，仅这些临时 clone）。**R35 基线（`0f53463`）与 R36 本地 main（`ee4fbb6`）均复现「全绿」**；`test_arch_reform_phase6.py` 在干净 clone 均为绿（29/0），说明 R35/R36 会话在权威树批跑时出现的 phase6 红是 data/ 注入的波中态/环境性红，而非干净面回归。

- **全库规模**：R35 基线（`0f53463`/origin/main）`tests/` 共 **158 个 `test_*.py`**（CI 实跑 **157**，跳过 `test_model_live`）；**R36 本地 main（`ee4fbb6`）增至 159 个（CI 实跑 158）**（新增 `test_rd_r36_attach_nits.py`）。测试代码约 **76,136 行**（R35 面），`tests/` 目录 10 MB；仓库 22 MB。
- **耗时参考**：三类实测——① **R35 基线**干净 clone 全库 157 套件串行 = **514 s ≈ 8.6 min，157 OK/0 FAIL**；② **R36 本地 main** 干净 clone 全库 158 套件串行 = **481 s ≈ 8.0 min**（串行，Python 3.9.6）；③ 权威树带 data/ 注入的 R35 波中批跑 = **1146 s ≈ 19.1 min，157 OK + 1 RED**（`/tmp/r35_batch2.log`，红=`test_arch_reform_phase6.py`，属波中/环境性红）。CI（ubuntu、py3.11）耗时以 GitHub Actions 记录为准（离线不可复核）。
- 逐套件运行方式：每个套件是**独立脚本**（`PASS/FAIL` 计数 + `✅/❌` + `exit 0/1` + section 头），不是 pytest；CI 与本地命令一致：`python3 tests/<suite>.py`。
- 依赖/网络：跑测试**不需要联网**（模型层全程 mock/离线；`test_model_live` 被排除），也不需要新装包（本机已齐）；若在 Workbench 全新环境跑，需 `pip install -r requirements.txt`（**联网**，Phase 1 默认禁止，需预先准备环境）。
- 已知坑（来自项目轮次记录，影响验收口径）：
  1. 本机 `tests/test_*.py` 循环是官方口径；`tests/*.py` 会误跑建造器（`build_v4_fixture.py` 重写 v4 夹具、`t7_parallel_harness.py` 重写结果档）→ **假漂移+连带红**，必须用 `test_*.py` 过滤。
  2. 本机 `data/daily` 注入真实快照会激活 r1/r2/r5/afin 的「本机真实面段」→ 环境性红；CI 无快照段（SKIP）故恒绿。干净 clone 面更接近 CI。
  3. `test_arch_reform_phase6.py` 在多轮批跑里出现过波中/记账面红（R35 记录：盖章后净树复验 29/0 转绿），需按「净树/干净 clone」判断。
  4. 状态套件（`test_rd_r20_state_consistency.py` 等）会 `git commit-tree` 造悬空根对象（**只增对象、不动任何引用**，CI 一次性环境无害；本次在临时 clone 执行，未污染任何仓库）。

---

## 4. A→B 交接：现有接口与验证方式

### 4.1 角色与方向

- **A = `global-opportunity-engine`**（上游机会发现/异常监测/传导候选）。A 工作区快照在本分析时为 `projects/v2/global-opportunity-engine`（HEAD `e5da620`，v0.1.0 文档收口面）；**17:51 后该目录被并行 A 分析师改为 `projects/v2/goe-work`（HEAD `5c055cc`）**，A 侧现状以 `docs/v2/phase0-project-A.md` 为准——本报告的 A/B 接口结论与目录位置无关。
- **B = `investment-agent`**（下游深度研究）。
- 方向：**A → B 单向**；A 只生成标准 JSON + 命令行调用，**不 import B 内部模块、不写 B 仓库**；B 不读 A 的 JSON，只接收**自包含的研究问题文本**并产出报告。

### 4.2 JSON 约定（A 侧，`HANDOFF_SCHEMA v1.0`）

- 导出件：`exports/pipeline_<date>.json`（机会管线全量）、`exports/research_queue_<date>.json`（优先级队列+建议命令）、`exports/research_tasks/RT-<date>-<seq>.json`（单任务自包含）、`exports/HANDOFF_SCHEMA.json`（机器可读 schema）。
- 信封必填：`schema_version`(const "1.0") / `engine`{name, version, scan_id, as_of, generated_at} / `provenance`{config_hash, data_hash, db_path, disclaimer} / `opportunity`{opportunity_id, fingerprint, status, score, score_breakdown, archetype, title, instruments, discovery, mechanism, evidence_for, evidence_against, catalysts, open_questions, invalidation, data_quality, research_question}。
- 任务件额外字段：`task_id / priority / expected_outputs / callback`，其中 `callback.status_map` 约定 `accepted→deep_research`、`deferred→watch`、`rejected→excluded`；`target_system = "investment-agent"`。
- 问题库提案：`--question-patch` 生成 `{schema_version, merge_mode:"append", target_file:"config/research_questions.json", append:[…]}`，**由使用者/对方自行决定是否合并**，A 不直接写 B 仓库。

### 4.3 A 侧适配器（调用方式与降级）

`goe/integration/ia_adapter.py`：
- `check()`：在 `--ia-path` 下找 `ia_cli.py`，跑 `<python> ia_cli.py --help` 并**验证输出含 `research-run`**；失败返回 notes（不伪造成功）。
- `build_command()`：`<python> <ia_path>/ia_cli.py research-run --question "<self-contained question>" --out-dir <dir>`（可选 `--fanout`）。
- `run_task()`：超时/非零退出 → 返回 `status=failed/timeout` 并保存 stdout/stderr 尾部；`--ia-path` 不存在 → `unavailable` + reason。
- 官方实测记录（A 文档）：`investment-agent: … exists=True cli=True python=/usr/bin/python3`；`OPP-0001: ok rc=0 elapsed=7.32 out=…/exports/ia_runs/OPP-0001`。

### 4.4 B 侧接收面（本次实测 `--help`，只读）

- `python3 ia_cli.py research-run --question QUESTION [--archive] [--out-dir OUT_DIR] [--fanout]`
  - 默认报告目录 `output/research_runs/<ts>_<slug>/`；**`--out-dir` 是注入缝**（A 用它把产物落到自己 `exports/ia_runs/`，不污染 B 目录）。
  - 产物：`report.json` + `report.md`（双落盘）；stdout 恒单 JSON 信封（`ok/run_ok`、steps、layers_summary、n_evidence_rows 等）；L3/L4 恒 `declared-not-produced`（Agent 层不代写）。
- `python3 ia_cli.py research-attach --report-dir DIR --judgment FILE [--allow-failed-run]`：Agent judgment 纪律机器校验后合并（零生成零改写；不过=produced 保持 False、violations 落档）。
- B 的问题库治理文件：`config/research_questions.json`（schema 1.0，RQ1–RQ10 十问 + 五层归因），A 只能提交 append 提案。

### 4.5 测试证据与缺口

| 侧 | 证据 | 内容 |
|---|---|---|
| A | `tests/test_exporter.py`（4 个测试） | 信封 required 字段齐全；`schema_version` const；研究问题自包含（现象/假设/支持与反对证据/失效条件/请完成）；`export_all` 落 pipeline+queue+tasks+schema；`task.target_system == "investment-agent"` |
| A | `tests/test_pipeline_e2e.py` 等其余 11 个 pytest 文件（合计 12 个测试文件） | 管线/导出/评分等离线测试（本机**无 pytest**、无 `.venv`，Phase 0 未安装依赖，无法本地复跑——如实记录） |
| B | `tests/test_rd_r2_orchestrator.py` | `report.json`+`report.md` 双落盘、`out_dir` 注入缝、`ia_cli` 命令面实解析+真实子进程信封、四层区分、证据索引、S1–S11 语义分记 |
| 真实联调 | A `docs/INTEGRATION_INVESTMENT_AGENT.md` §4.3；A `docs/QA_AUDIT.md` | 2026-11-13 真实 handoff：rc=0、7.32 s、产出 `exports/ia_runs/OPP-0001/…/report.md`；QA 复审记录 gold 任务 handoff（15:14:01）对象一致、rc 未独立复跑（仅核 artifact） |

**缺口（如实）**：
1. **没有跨仓库自动化回归门**：B 的 CI 不跑 A 的导出，A 的测试不调真实 B（`ia_adapter` 无自动化测试）；接口变更靠文档/人工联调发现。
2. 契约是**单向松耦合**：B 只吃 question 文本，不校验 A 的 JSON schema；`HANDOFF_SCHEMA` 版本升级需人工同步。
3. 真实 handoff 证据是**文档记录 + 时间戳 artifact**，不是可重放 CI 门；本次 Phase 0 也未执行真实 handoff（会写 A/B 的 output 目录）。

---

## 5. 三个候选低风险任务（优先已测试覆盖、离线、不触网、不付费、不动冻结验收）

> 共同前提：三个任务都**只能在 Workbench 沙箱克隆**的独立分支执行，产出 patch；当前外部 R36 活跃 + 无写授权 ⇒ **权威树一律不可执行**；任务均离线、零模型/零网络、不触碰冻结验收标准与检查点机器面。

### P-B-1（首选）修复 `skipped_step` 的 SKIP 语义与台账 `[OK|—]` 显示

- 依据：`OPEN_ISSUES.md`「R25 审计余留 NIT·预存观察」——`skipped_step ok=True` 致报告台账渲 `[OK|—]`，`SKIP` 分支实为死码（`main` 同状）。
- 根因（已定位）：`scripts/research_orchestrator.py` 的 `skipped_step()` 返回 `{executed:False, ok:True,…}`；渲染处 `tag = 'OK ' if s.get('ok') else ('SKIP' if not s.get('executed') else 'FAIL')` 先判 `ok`，导致 SKIP 永不可达（`research_orchestrator.py:90`、:679–690 附近）。
- 为什么低风险：纯展示/记账语义修正，不改研究判定、不改 CI 门、不触 `PRODUCT_GOAL/ACCEPTANCE_CRITERIA`；已有强测试覆盖面 `tests/test_rd_r2_orchestrator.py`（十一步管线全部 SKIP/执行形态）。
- 最小验证命令（克隆内）：
  ```
  python3 -B tests/test_rd_r2_orchestrator.py          # 基线须绿
  python3 -B scripts/rd_state_consistency.py --repo . --state-dir docs/autonomous-rd   # 7/7
  ```
  并新增/扩展断言：SKIP 步在 report.md 台账显示 `SKIP`/`—` 而非 `[OK|—]`，`run_ok` 语义不被该显示影响。
- 当前可执行性：**沙箱可执行（推荐）**；权威树不可（R36 在飞、无写授权）。不依赖网络/数据快照（干净 clone 下 SKIP 路径本身可复现）。

### P-B-2 R1 MINOR-6：`since_publish` 两态注记拆分（“无新观测” vs “净变动 0”）

- 依据：`OPEN_ISSUES.md`「R1 审计 MINOR-6」——名义“严格>publish”实际基准=严格早于 publish 的最后观测；`basis==end`（无新观测）与净变动 0 混报同一 note，建议拆两种如实注记。
- 位置：`scripts/view_verifier.py`（`_since_publish_node`，约 :393；mode B 证据面约 :202–:241）与 `scripts/view_plausibility.py`（阶段 B 关系，约 :637/:795），仅注记/口径披露。
- 为什么低风险：只改“注记文案/两态判定”，不动判定阈值、不改评分；已有套件 `tests/test_c9_verifier_modes.py` 覆盖 A/B/legacy 三模式；不触冻结的 `PRODUCT_GOAL`/AC 标准。
- 最小验证命令：
  ```
  python3 -B tests/test_c9_verifier_modes.py           # 基线绿 + 新增两态断言
  python3 -B tests/test_rd_r2_orchestrator.py          # 引用证据面不回归
  python3 -B scripts/rd_state_consistency.py --repo . --state-dir docs/autonomous-rd
  ```
- 当前可执行性：**沙箱可执行**；需按项目纪律配**独立审计（GLM 席）**复核语义（数值/口径类改动开发者不自验）。权威树不可。

### P-B-3 A→B handoff 契约冒烟测试（纯新增测试，不改产品代码）

- 目的：补 §4.5 的缺口 1——为 A→B 接口加一个**离线、可重放**的 B 侧契约测试（新增 `tests/test_handoff_contract.py`），断言 `ia_cli.py research-run --question <自包含问题> --out-dir <tmp>` 在干净态下：产物 `report.json`+`report.md` 双落盘、stdout 单 JSON 信封结构（`ok/steps/layers_summary`）、L3/L4 `produced=False`、数据缺席时步骤如实 SKIP（**不得断言 `run_ok=True`**，干净 clone 无数据快照时 SKIP 是设计行为）。
- 为什么低风险：**只加测试**，零产品代码改动、零网络、零模型；不改 CI workflow（CI 的 `tests/test_*.py` 循环自动纳入新套件，天然成为 CI 门）；不触冻结验收。
- 最小验证命令：
  ```
  python3 -B tests/test_handoff_contract.py            # 新增套件
  python3 -B tests/test_rd_r2_orchestrator.py          # 既有编排面不回归
  python3 ia_cli.py research-run --help                # 接口面存在性（当日实测通过）
  ```
- 当前可执行性：**沙箱可执行（推荐给 Phase 1 首个任务）**；权威树不可；若未来 A 侧要加入真实联调，则需另行授权（会写 A/B 的 output 目录、且依赖 A 环境）。

**明确不建议在 R36 窗口内做的候选**（撞车/阻塞，如实登记）：
- R25 Ni-2/Ni-3/Ni-4：**正是 R36 在飞的三修**（`scripts/agent_judgment.py`、新增 `tests/test_rd_r36_attach_nits.py`、`tests/test_rd_r25_nit_dff.py` 夹具更新；17:46 已提交 `a612097` 但收口/合并未完成）——高撞车风险，等 R36 收口后由其交接；Ni-5（DFF 通道映射）与本波同属报告/审计面，建议也等收口后再评估。
- `round.sh` 双上限硬接线：**LIVE 部署时事项**，涉及 launchd/生产面 → BLOCKED。
- HK 双通道脆弱面 / china 子源失败落盘 / DFF 真实拉取：需真实网络采集与数据面 → 违反「离线、不触网」。
- 日历门（F 补证 2026-12-05、六标签 2026-12）：时间门，**禁手工提前**。

---

## 6. Workbench 接入配置建议

### 6.1 建议配置（草案）

```yaml
project_id: project-B
name: investment-agent
upstream: https://github.com/bojing951-hash/investment-agent   # public；推送=公开发布
local_path: projects/v2/investment-agent          # 工作区克隆；不指向 ~/investment-agent-dev 或 reform worktree
baseline_commit: 0f53463d9640167dc314d95fb0af0fa1848765f8     # Phase 0 实测基线=origin/main（R35，GitHub 最后已知）；
                                                      # 本地 main 已推进到 R36 ee4fbb6 但未推送 → 推送后再刷新基线并重跑
default_branch: main                               # 只作只读基线；开发一律 workbench/<task-id> 分支
work_branch_prefix: workbench/
remote_push: false                                 # 默认关闭；公开仓推送须用户逐波批准
network: false                                     # 默认离网
paid_apis: false
live_env: false                                    # 不触 launchd/LIVE/生产数据
merge_main: false                                  # 合并 main = 用户保留卡点①
local_acceptance: true                             # 仅限离线测试+状态门；不得自称“真实研究验收”
agent:
  implementer: deepseek-harness                    # 开发席（单写者）
  auditor: glm                                     # 独立审计席（只读裁决，不看实现席上下文）
budget:
  per_round_usd: 5
  hard_cap_usd: 10
  wall_clock_min: 90
  max_attempts_per_task: 3
test_command: |
  python3 -B scripts/rd_state_consistency.py --repo . --state-dir docs/autonomous-rd &&
  python3 -B scripts/thresholds_gate.py &&
  fail=0
  for t in tests/test_*.py; do
    [ "$(basename "$t" .py)" = "test_model_live" ] && continue
    python3 -B "$t" >>/tmp/ia-suite.log 2>&1 || { echo "FAIL $t"; fail=1; }
  done
  exit $fail
fast_gate_command: |
  python3 -B scripts/rd_state_consistency.py --quiet --repo . --state-dir docs/autonomous-rd &&
  python3 -B scripts/thresholds_gate.py
protected_paths:
  - docs/autonomous-rd/PRODUCT_GOAL.md            # 冻结目标（goal_sha=7535a141b2339a13）
  - docs/autonomous-rd/ACCEPTANCE_CRITERIA.md     # 冻结验收纪律
  - docs/autonomous-rd/FINAL_ACCEPTANCE.md        # 验收矩阵（只读）
  - docs/autonomous-rd/RESUME.md                  # RD-CHECKPOINT 机器块勿手改
  - docs/autonomous-rd/CURRENT_STATE.md           # baseline 机器行勿手改
  - docs/autonomous-rd/ITERATION_LOG.md           # append-only
  - docs/autonomous-rd/RDG-REGISTRY.md            # append-only 根因登记
  - config/thresholds.json                        # SIGNED v1.0，G1-G4 门
  - .github/workflows/offline-tests.yml           # CI 门禁定义
  - audit/                                        # 审计归档
  - data/                                         # 数据面（gitignored，真实采集产物）
  - output/                                       # 研究运行产物
  - .env / .env.*                                 # 密钥禁入
```

### 6.2 建议说明

1. **local_path 用工作区副本**：`~/investment-agent-dev` 是 live 研发树（当前挂着 R36 分支 + linked worktree），`~/AI内容库/...` 是 LIVE 历史副本；两者都不是 Workbench 可写目标。工作区克隆是独立 `.git`，可安全做沙箱分支。
2. **default_branch=main 只作基线**：Phase 0 实测基线=`0f53463`（origin/main=R35 盖章尖，GitHub 最后已知）；但**本地 main 已在 17:46 推进到 R36 `ee4fbb6`（未推送）**。Phase 1 开跑前必须做一次显式「基线决策」：① 若 R36 仍未推送 → 用 `0f53463` 作可复现公开基线；② 若 R36 已推送 → 用新 origin/main 尖作基线并重跑全库（r36 后测试数 158→159，CI 实跑 158）。基线刷新=只读核对 + 更新 `baseline_commit`，**不可自动 merge**。
3. **test_command**：逐套件循环是官方 CI 口径（跳过 `test_model_live`）；干净 clone 全库约 **8.6 min**（R35 157 套 / R36 158 套），权威树带 data 注入时约 19 min；日常迭代用 fast_gate（状态门+thresholds，约 1 s）。若要机器可读结果，建议后续任务引入 `scripts/run_offline_suites.py` 小工具（当前不存在，CI 内联循环是唯一权威口径）。
4. **protected_paths 核心是机器块与冻结面**：`RESUME.md` 检查点块 / `CURRENT_STATE.md` baseline 行是 `rd_checkpoint.py --finalize` 的独占写入物，手改会直接触发一致性门①②；`PRODUCT_GOAL.md` 的 goal_sha 被门⑥硬锁；`thresholds.json` 被 G1–G4 门锁。
5. **Agent 用 DeepSeek Harness、审计用 GLM**：符合项目既有纪律「开发者不自验、独立席三态裁决（PASS/FAIL/NOT_VERIFIED）」与 `SEMANTIC-AUDIT-SEAT.md` 的独立 Subagent 模型；审计席应零实现上下文、只读证据。
6. **budget**：项目自身无头轮硬上限 `$50/轮、150 min`（用户已授权“不限制预算”但保留安全界）；Workbench 任务风险更低，建议收紧到 `$5–10/轮、≤90 min`，并禁止付费数据源/真实模型调用（`test_model_live` 永不进 CI/本地默认）。
7. **remote push=false 且禁止自动合并**：公开仓推送=公开发布（`CLAUDE.md` 红线）；合并 main 是用户保留卡点①，历史批准只对当波有效。
8. **允许本地验收（限定语义）**：允许 = 离线测试电池 + 状态一致性门 + thresholds 门 + 独立审计；**不**允许把「CI 绿/本地测试绿」当「真实研究验收」（项目六层区分红线），也不允许真实数据/机构资料/模型叙事层面的 PASS 声明。
9. **同步/刷新纪律**：Workbench 不 fetch/push；基线推进由操作者席在权威树完成并推送后，Workbench 才做一次显式「只读核对 + 重建沙箱分支」。R36 在飞期间禁止任何同步写动作。

---

## 7. BLOCKED / UNKNOWN 清单

### 7.1 BLOCKED（硬阻塞，需用户/操作者解除）

| # | 事项 | 原因/证据 |
|---|---|---|
| B1 | **写权威研发树 `~/investment-agent-dev`、任一 linked worktree（含 `~/investment-agent-reform`）或 `main` ref** | 外部操作者席 R36 正在 reform worktree 写 `scripts/agent_judgment.py` 等 3 件并跑全库批跑（mtime 17:27–17:33、`/tmp/r36_*.log` 17:36–17:37）；无锁可依；`CLAUDE.md` 禁未经批准合 main |
| B2 | **push 公开仓 GitHub** | 公开仓推送=公开发布；用户保留卡点①「封版合并 main」须用户逐波批准（2026-11-11 批准只对当波） |
| B3 | **merge main / 打 tag / 发 Release** | 用户保留卡点①；且需操作者席在权威树完成收口链（prose → finalize → 门 → 合并 → 并轨尖重盖章）。**注意：R36 的「合并本地 main + 盖章」已由操作者席在 17:46 完成，但推送/发布未做，Workbench 不得复做任何一步。** |
| B4 | **LIVE 部署 / launchd / 生产数据 / `~/AI内容库/.../investment-agent`** | 用户保留卡点③；`com.investment.daily/weekly` plist 指向该历史副本；项目纪律「不动生产环境」 |
| B5 | **付费 API / 新数据源凭证 / 真实模型调用（`test_model_live`、MODEL_* 真调用）** | 用户保留卡点②；红线「不产生付费 API 费用」；CI 显式排除 test_model_live |
| B6 | **联网数据采集 / 真实周报与真实研究验收** | 需网络与真实数据源（且属生产语义）；Phase 0/1 默认离网 |
| B7 | **修改冻结验收标准**（`PRODUCT_GOAL.md`、`ACCEPTANCE_CRITERIA.md`、AC 状态、`FINAL_ACCEPTANCE.md`） | 只有用户能改；一致性门⑥以 goal_sha 硬锁；门⑦核验收如实 |
| B8 | **写 `~/agent-loop`**（STATE/PENDING-APPROVALS/contracts/headless/rounds） | 研发循环状态目录；操作者席专属；本轮只读 |
| B9 | **执行 `scripts/rd_checkpoint.py --finalize`** | 会写 RESUME/CURRENT_STATE 机器块，属收口动作，须在本轮研发树内由有权限会话执行；Phase 0 只跑只读检查 |
| B10 | **日历门提前**（F 补证 2026-12-05 / 六标签 2026-12 首验） | RESUME 明示「勿手工提前」；属时间门/观察钟 |

### 7.2 UNKNOWN（无法离线确证，需后续核实）

| # | 事项 | 为何未知 | 解除方式 |
|---|---|---|---|
| U1 | GitHub `main` 在 17:06 之后的真实状态 | 本轮未联网、未 fetch；本地 `origin/main` ref 与工作区克隆均=`0f53463`（17:06:38 推送尖）；**本地 `main` 已推进到 R36 `ee4fbb6`（17:46:57，领先 origin 3 提交、未推送）**——GitHub 是否已收到 R36 未知 | 有网络时只读 `git ls-remote`/网页核对（只读，不 fetch/push 写 refs） |
| U2 | R36 波次是否已推送/发布、是否新增 tag/Release；`~/agent-loop` 的 R36 记账是否已做；下一轮由哪一席接 | R36 的代码/合并/盖章已确认完成（`a612097`→`6dcc594`→`ee4fbb6`，round=36），17:55 外部会话净树复验 `total=159 red=0`；但 17:56 观测 **push 尚未发生**、STATE.md 仍停在 17:17 的 R35 记账、无 R36 rounds 记录 | 等推送后读 `git log origin/main`/CI run；或向操作者确认；下个引擎轮约 19:0x 后读 `~/agent-loop/headless/logs/` |
| U3 | 干净 clone 上全库 157 套件的最终绿/红（区分环境性红） | **已澄清（2026-11-15 17:45）**：临时干净 clone（main 尖 `0f53463`）串行实跑 157/157 OK、0 FAIL、514 s；仍非 CI 等价（Python 3.9 vs 3.11） | 已实测；CI 侧结论仍需网络 |
| U4 | 最近 CI run 结论（origin/main R35 vs 本地 main R36） | R35 收尾 push 的 CI：项目 STATE.md 记载 CI 43698231614 绿，离线无法独立复核；**R36 只到本地 main、未推送 ⇒ CI 尚不可能跑过 R36**（R36 会话自报全库 159 件=158 OK+1 红=phase6 波中记账面，净树待复验） | 联网查 GitHub Actions；或操作者提供 run 链接；R36 推送后以其 CI 为准 |
| U5 | `test_arch_reform_phase6.py` 在干净 clone 的红色是否仍为「波中/记账面期望态」 | **已澄清（同上）**：干净 clone 单套 `PHASE6 判定: 29 PASS / 0 FAIL`（外部工件不在场项=显式 SKIP），全绿；R35 权威树红=data/ 注入的波中/环境性红，非干净面回归 | 已实测；无需解除 |
| U6 | 项目 A（GOE）当前真实进度与是否有活跃循环 | 工作区快照 `e5da620`（v0.1.0 + 文档收口），`PROJECT_STATE.md` 称“GitHub 远程等待授权”“Phase 4 验收中”；本机无 pytest/.venv 无法跑其测试 | 单独 Phase 0 分析 A 或向 A 维护者确认 |
| U7 | 无头引擎下一轮精确触发时刻 | launchd `StartInterval=14400`，但历史开轮时刻受唤醒/睡眠漂移（01:45/06:05/10:30/15:35） | 现场看 `~/agent-loop/headless/logs/` 新文件即可（只读） |
| U8 | 权威树是否还有其他未列出的 worktree/会话 | `git worktree list` 只显示 dev + reform 两棵；`ps` 不可用 | 后续会话前重新 `git worktree list` + 检查 mtime |

### 7.3 只读纪律自证

- 未写 `~/investment-agent-dev`、`~/investment-agent-reform`、`~/agent-loop`、工作区 GOE/IA 克隆的任何文件或 Git 状态；**工作区唯一写入=本文件**（另在 `/tmp` 建了两个临时 clone 与套件日志，均为隔离临时物，不进入任何仓库）。
- 所有测试/脚本均在**临时 clone**（`/tmp/b-phase0-*`、`/tmp/b-r36-*`）或只读检查器上执行；`git status --porcelain` 在克隆与权威树执行前后均干净；`rd_state_consistency.py` / `thresholds_gate.py` 为纯只读检查器。
- 未读取/未输出任何密钥；报告只引用仓库相对路径与 `~` 相对路径；未访问 LIVE 历史副本与生产数据。
- 局限如实：`ps` 被沙箱拒绝；未联网；GOE 侧测试因本机无 pytest 未执行；真实 handoff 未执行（会写产物目录）。

---

## 附录 A：本轮关键证据命令与实测输出（摘）

```text
# 权威树 Git 事实
$ git -C ~/investment-agent-dev branch --show-current        → dev/rd-r35-engine-track
$ git -C ~/investment-agent-dev rev-parse HEAD               → fe38275c4ee6216ce9e75c95a8bf80ea415cecaa
$ git -C ~/investment-agent-dev status --porcelain           → （空，干净）
$ git -C ~/investment-agent-dev rev-parse main origin/main   → 0f53463… 0f53463…
$ git -C ~/investment-agent-dev merge-base --is-ancestor HEAD origin/main → 成立
$ git -C ~/investment-agent-dev worktree list
  → ~/investment-agent-dev    fe38275 [dev/rd-r35-engine-track]
  → /private/tmp/r36-merge    ee4fbb6 [main]          ← 17:46:21 合并 + 17:46:57 盖章
  → ~/investment-agent-reform a612097 [dev/rd-r36-attach-nits]
$ git -C ~/investment-agent-dev log --oneline -10 …          → 见 §1.2
$ git -C ~/investment-agent-dev tag --sort=-creatordate | head → v0.24.0-alpha …
$ git -C ~/investment-agent-dev rev-parse main origin/main  → ee4fbb6 / 0f53463（本地领先 3、未推送）
$ git -C ~/investment-agent-dev rev-list --count origin/main..main → 3
$ git -C ~/investment-agent-dev show ee4fbb6:docs/autonomous-rd/RESUME.md | grep RD-CHECKPOINT
  → round=36 commit=6dcc59476690ee2084383a6c20ec8634245703bd branch=main completed_ids=[T-R36-1] next_round=37

# 工作区克隆（对照）
$ git -C projects/v2/investment-agent rev-parse --is-shallow-repository → false
$ git -C projects/v2/investment-agent log --oneline -1       → 0f53463 R35 盖章…
$ git -C projects/v2/investment-agent rev-list --count HEAD  → 611

# 研发循环现场
$ ls ~/agent-loop/headless/lock ~/agent-loop/headless/STOP  → 均 No such file
$ ls -lat ~/agent-loop/headless/logs | head                 → round_20261115_153549.log（16:58）
$ tail -2 /tmp/r35_batch2.log                                → 进度 158/158 OK=157 FAIL=1 耗时=1146s；RED: test_arch_reform_phase6.py
$ launchctl print gui/$(id -u) / plist 读取                  → com.investment.rd-headless StartInterval=14400；daily/weekly 指向 LIVE 历史副本
$ ls -la ~/investment-agent-reform/scripts/agent_judgment.py → 17:27（+93/−31，后随 a612097 提交）
$ ls -la ~/investment-agent-reform/tests/test_rd_r36_attach_nits.py → 17:32（后随 a612097 提交，323 行）
$ cat /tmp/r36_full_suite.log                                → 仅记 RED: tests/test_arch_reform_phase6.py（波中记账面）
$ git -C ~/investment-agent-reform log --oneline -3          → a612097 / 0f53463 / cf0a879

# 只读门/测试实跑（工作区克隆根）
$ python3 -B scripts/rd_state_consistency.py --repo . --state-dir docs/autonomous-rd
  → ①~⑦ 全 PASS，总结 7/7 PASS（real 0.78s）
$ python3 -B scripts/thresholds_gate.py                      → G1_forward/G1_reverse/G2/G3/G4 全 PASS（0.16s）
$ python3 -B tests/test_rd_r35_spread_disclosure.py          → R35 结果: 18 PASS / 0 FAIL（0.48s）
$ python3 -B tests/test_rd_r33_seat_runtime.py               → exit 0（0.27s）
$ python3 -B tests/test_ia_cli.py                            → 结果: 38通过 / 0失败（3.59s）
$ python3 -B tests/test_rd_r20_state_consistency.py          → exit 0（129.46s）
$ python3 -B ia_cli.py research-run --help                   → 显示 --question/--archive/--out-dir/--fanout
$ python3 -B ia_cli.py research-attach --help                → 显示 --report-dir/--judgment/--allow-failed-run

# R36（本地 main ee4fbb6）独立只读亲核（临时 clone，17:47–17:49）
$ git clone -b main ~/investment-agent-dev /tmp/b-r36-*      → HEAD=ee4fbb6「R36 盖章: round 36 @ 6dcc594」
$ python3 -B scripts/rd_state_consistency.py --repo . --state-dir docs/autonomous-rd
  → ①~⑦ 全 PASS，总结 7/7 PASS（real 0.81s；块 R36 commit=6dcc594、next=R37）
$ python3 -B scripts/thresholds_gate.py                      → G1_forward/G1_reverse/G2/G3/G4 全 PASS
$ python3 -B tests/test_rd_r36_attach_nits.py                → 结果: PASS=23 FAIL=0（real 0.63s）
$ git status --porcelain                                     → （空）
```

## 附录 B：必读文档核对清单（均已读，权威树）

| 文档 | 结论/要点 |
|---|---|
| `CLAUDE.md` | 会话启动序；红线（不合并 main/不推送/不付费/不碰生产/不改冻结验收）；检查点纪律（prose→finalize→门）；时间戳带时区 |
| `PRODUCT-GOAL.md`（根） | 2026-11-08 用户重申的产品章程；越位零件（预测池/评级门禁）已下线 |
| `docs/autonomous-rd/PRODUCT_GOAL.md` | 长期总指令（最高目标，12 节 + AC1–AC10）；不得修改/降标 |
| `docs/autonomous-rd/RESUME.md` | 恢复步骤 + RD-CHECKPOINT 块（origin/main=round 35 / 本地 main=round 36）+ 下一步队列 + 存档 |
| `docs/autonomous-rd/CURRENT_STATE.md` | 权威快照（origin/main=R35；本地 main=R36）；baseline 机器行；任务台账（当前 0 行） |
| `docs/autonomous-rd/OPEN_ISSUES.md` | 用户保留卡点现状；待办技术清单（R25 Ni-2~5、R1 MINOR-5~8 等）；环境注意（勿在历史副本开发） |
| `docs/autonomous-rd/ACCEPTANCE_CRITERIA.md` | AC1–AC10 原文；六层区分；独立审计；冻结合同不可改；用户三保留卡点 |
| `docs/autonomous-rd/RD_MECHANISM.md` | 根因决策门（RDG）、优先级五因子公式、能力验收六问、状态语义七项门 |
| `docs/autonomous-rd/RUN_MANDATE.md` | 用户启动指令原文（自主循环/真实验收/检查点/权限边界） |
| `docs/autonomous-rd/FINAL_ACCEPTANCE.md` | 验收矩阵：9 PASS + AC3 PARTIAL；整体未完成 |
| `docs/autonomous-rd/ITERATION_LOG.md` | R36 行（本地 main 最新；origin/main 至 R35）；R1–R36 轮次记录 |
| `docs/autonomous-rd/RDG-REGISTRY.md` | RDG-001…009；R35 新增 008/009（利差辖域披露/自对守卫） |
| `docs/autonomous-rd/CAPABILITY_MATRIX.md` | 能力×差距（八域）；R35 更新“判定链验证完整性” |
| `docs/autonomous-rd/ARCH-REFORM-FINAL-REPORT.md` | 架构整改终报告；§非阻断遗留清单 | 
| `~/agent-loop/STATE.md` | 引擎活状态速览（R35 全链闭合；R36 队列；锁机制） |
| `~/agent-loop/PENDING-APPROVALS.md` | 排队中=空；已批准记录（历史） |
| `~/agent-loop/headless/round.sh` / `PROMPT.md` | 无头轮启动器/提示词（互斥锁、预算/墙钟、允许/拒绝清单、波次纪律） |
| `.github/workflows/offline-tests.yml` | CI 实际门禁（§3.1） |

## 附录 C：R36 现场观测时间线（本分析全程只读观测，HKT）

| 时间 | 观测 | 解读 |
|---|---|---|
| 17:17 | `~/agent-loop/STATE.md` mtime 更新（R35 全链闭合记账） | 操作者席 R35 收尾 |
| 17:27 | `~/investment-agent-reform/scripts/agent_judgment.py` mtime（未提交 `+93/−31`） | R36 编码开始 |
| 17:29 | 出现未跟踪 `tests/test_rd_r36_attach_nits.py`（15,105 B） | R36 新套件编写 |
| 17:32–17:33 | 上述文件 mtime 连续更新；`tests/test_rd_r25_nit_dff.py` 被改 | 迭代中 |
| 17:34–17:36 | `/tmp/r36_full_suite.log`、`/tmp/r36_one.log` 创建/更新 | R36 跑批跑 |
| 17:36 | `git status`：3 件未提交；全库批跑日志 `RED: tests/test_arch_reform_phase6.py` | 与 R35「波中记账面红」同形态 |
| 17:43 | `/tmp/r36_*.log` 再次更新（one.log 2 KB） | 继续跑测试 |
| 17:46:03 | 提交 `a612097`（R36 码波 + docs prose，共 6 文件 +441/−40） | R36 落码+记账 |
| 17:46:21 | 合并入本地 `main` = merge `6dcc594`（用临时 worktree `/private/tmp/r36-merge`） | R36 并轨 |
| 17:46:57 | 盖章 `ee4fbb6`「R36 盖章: 检查点块+基线机器行（round 36 @ 6dcc594）」 | **本地 main 前移到 R36；仍未推送** |
| 17:47–17:49 | 本分析：clone 本地 main → `rd_state_consistency` 7/7、thresholds G1–G4 绿、R36 新套件 23/0；开始全库批跑 | R36 状态可独立复核 |
| 17:48 | `git rev-parse origin/main` 仍 `0f53463`（=R35）；本地 main `ee4fbb6` 领先 3 未推送；无 headless 锁/STOP；`STATE.md` 仍 17:17（无 R36 记账） | **R36 发布链路未闭合**；外部会话仍可能收尾 |
| 17:55 | 外部 R36 会话净树复验：`/tmp/r36_fresh_verify.log` → `SUITE DONE total=159 red=0`、门 7/7×2、`R20-CP OK`；同分钟 `/tmp/gh_actions.html`/`actions21.html` 抓取（GitHub Actions 页面） | R36 在做「净树复验 + CI 核验」收尾动作，**仍可能有后续 push** |
| 17:56 | `origin/main` 仍 `0f53463`；本地 main `ee4fbb6` 领先 3 提交未推送；无 headless 轮日志新增（仍只有 16:58 的 R35 轮） | R36 发布链路仍未闭合；引擎下一轮尚未开班 |
| 同期（17:30–17:58） | `~/investment-agent-dev` 工作树无新提交/无未提交；`main`/worktree 由操作者席更新；本分析在临时 clone 完成两轮全库离线批跑（157/157、158/158） | 权威工作树静默，写活动全在操作者席 R36 会话 |

> 判读：R36 是**操作者席**（非 launchd 无头轮）在引擎下一轮开班前的紧凑波，在本分析窗口内完成了「编码→提交→合并本地 main→盖章」全链，但**推送/发布/状态面记账未完成**；因此它是「本地已收口、发布未闭合」的活动循环。其写入与 `main` 移动是本报告 READ_ONLY 结论的直接依据；复现本报告前请先重新只读核对 `git worktree list`、`git rev-parse main origin/main`、各 worktree `git log -1`、`~/agent-loop/headless/logs/`（无头轮为新文件即表示已开班）。
