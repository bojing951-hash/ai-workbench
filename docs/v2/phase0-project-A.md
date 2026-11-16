# Phase 0 · 项目 A（global-opportunity-engine）现状矩阵与接入建议

> 分析人：Phase 0 项目 A 接入分析师（只读）；分析时间：2026-11-15 17:30–17:48 HKT。
> 被分析对象：权威本地开发树 `/Users/cast/Downloads/金融系统/global-opportunity-engine`（下称 **A 权威树**）；
> 工作区只读快照 `/Users/cast/Downloads/开发工作台/projects/v2/global-opportunity-engine`（下称 **A 工作区副本**，= GitHub `main` 旧克隆）；
> 参照：B 仓库快照 `/Users/cast/Downloads/开发工作台/projects/v2/investment-agent`（只读）。
> 纪律：全程只读。A 权威树**未写入、未 checkout、未 commit、未 push、未安装依赖、未联网调用数据源**；唯一写入文件 = 本报告。
> 唯一网络访问：对公开仓库 `github.com/bojing951-hash/global-opportunity-engine` 的 Actions 页面做**只读 HTTP 核验**（用于代替被限流的 GitHub API 核对 CI 结论；非数据源、无凭据、无写操作）。
> 只读试跑仅产生 gitignored 的 `__pycache__`/`.pytest_cache` 刷新（已用 `PYTHONDONTWRITEBYTECODE=1 -p no:cacheprovider` 规避），未产生跟踪文件变更。
> 重要提示：分析期内 **A 权威树被另一进程并发修改**（见 §1.4），本报告所有结论绑定 **HEAD `50b60a1` 的干净状态（17:31 现场）**，不绑定 17:39 之后的脏树。

---

## 0. 结论速览

- **接入结论：READ_ONLY / 先冻结再接入**。权威树在分析窗口内从干净变为脏（17:44 已 10 项、17:48 已 **15 项**未提交改动，含未跟踪新模块与状态文件本身），任何 Workbench 运行前必须先冻结或确认写者退出；否则基线漂移。
- **权威真实状态**：分支 `architecture/research-v2`，HEAD `50b60a1`（2026-11-15 17:09 HKT），`git status --porcelain` **T0=空**；HEAD 与 `origin/architecture/research-v2` **完全一致（已推送）**；相对 `origin/main`（`e5da620`，11-13）**领先 106 提交、落后 0**，`origin/main` 是 HEAD 的祖先（可 FF）。GitHub 仓库**公开**，**默认分支 = main**（比开发线落后 106 提交）。
- **测试真实状态**：离线规范命令 **231 passed / 10 deselected / 0 failed，143.78 s（≈2:23）**，与最新 release proof（`audit/test_evidence/20261115T090019Z_360b1614d1.proof.json`，231）一致；另 `-m "not network"` 收集 232（含 1 个 realdata）、退出码 0、墙钟 186.39 s；联网测试 9 个（本次未跑，遵守不联网纪律）。
- **CI 真实状态**：`verify-release.yml` 不是普通 pytest CI，而是「**重放 release proof 并重跑规范离线套件**」的验收闸门；外部核验 Claude 无法用 API（限流），改用 GitHub HTML：**HEAD `50b60a1` 的 run `43697836146` 页面显示 completed successfully（但仓库 `audit/CI_SUCCESS_2026-11-15.md` 未记录此 run）**；`43697258390`@`2488955`、`43685550326`@`b888303` 亦为成功。
- **PIT/前视控制真实存在**：`goe/features.py` 的 as-of 截断 + 发布滞后 + 陈旧剔除、`goe/evidence/external.py` 的 publication/vintage/available_at 硬拒绝、`goe/validation.py::no_lookahead_diff` 泄漏检测；**但 `no_lookahead_diff` 本身 0 测试覆盖**（候选任务 T1）。
- **A→B 交接真实状态**：V1（机会 envelope + `goe handoff`）与 V2（ResearchCandidate + `goe triage --handoff`）两套接口均在；**当前 0 个 eligible 候选**（DB 实测 20 candidates 全为 `intelligence/evidence_gap/a_retained`），V2 真实交接记录为 0；磁盘上存在 1 次真实 V2 交接 artifact（B rc=0、S8=`no_registry_identity` → A 判定 `refused`），可作语义失败证据。
- **3 个候选低风险任务**（§6）：① 补 `no_lookahead_diff` PIT 回归测试；② 修 `exports/research_queue_*.json` 绝对路径不可移植；③ 补 `goe triage --handoff` 零候选退出码 3 的 CLI 级安全测试。均离线、不触网、不改冻结 envelope 契约。
- **硬阻塞**：A 权威树并发写入未停（§1.4）；A 工作区副本陈旧（main @ `e5da620`，仅 106 个离线测试、缺 `.github/contracts/goe/evidence` 等），直接做 `local_path` 会「假绿」；工作区副本无 `.venv`；远端推送与 PR 基线（默认 main）均未授权且会触发 proof 闸门失败。

---

## 1. 权威状态（事实优先，不采信状态文件）

### 1.1 分支 / HEAD / 干净度（T0 = 17:31 HKT，首次勘查）

| 项 | 实测值 |
|---|---|
| 当前分支 | `architecture/research-v2` |
| HEAD | `50b60a1c09b7b0bb7b2e579bd412d1a262470ccb`（2026-11-15 17:09:00 +0800，`docs: final PIT acceptance, CI run 24, QA PIT/research confirmation`） |
| `git status --porcelain` | **空（0 行）** |
| upstream | `origin/architecture/research-v2`，与 HEAD **同一 SHA** → 已推送 |
| 最近 15 提交 | `50b60a1` → `2488955` → `360b161` → `1a32b1f` → `9f7e54e` → `85a8e7a` → `d2096b7` → `0d5d6ac` → `983854f` → `b888303` → `53129f5` → `ff2c868` → `c35c847` → `422f9a5` → `a609999`（全部围绕 PIT/证据/发布闸门） |
| 分支清单 | 本地：`architecture/research-v2`、`fix/autonomous-audit-remediation`（`1f2b341`，tag `v1-frozen-1f2b341`）、`main`（`e5da620`）；远端同名三条 + `origin/HEAD → origin/main` |

### 1.2 与远端的关系（17:38 用 `git ls-remote` 实测，非仅凭陈旧 remote-tracking ref）

| ref | SHA | 与本地 HEAD 关系 |
|---|---|---|
| `refs/heads/architecture/research-v2` | `50b60a1` | = HEAD，**已推送** |
| `refs/heads/main` | `e5da620` | HEAD 领先 106 / 落后 0；`git merge-base --is-ancestor origin/main HEAD` = 真（可 FF） |
| `refs/heads/fix/autonomous-audit-remediation` | `1f2b341` | V1 冻结/旁支，与 Phase 0 无关 |

- **GitHub 默认分支 = `main`**（公开仓库 HTML 元数据 `"defaultBranch":"main"`、`"private":false`，17:43 实测）。因此：**任何人 clone/GitHub 首页看到的是落后 106 提交的旧状态**；最新远端分支是 `architecture/research-v2`（= 本地 HEAD）。
- 结论：**「本地分支领先远端 main」准确；「未推送」不准确（当前分支已推送，只是 main 未合并）**。合并 main / 推送 main 需用户授权，Phase 0 一律禁止。

### 1.3 状态文件不可盲信（自相矛盾实证）

| 文件:位置 | 声称 | 实测/反证 |
|---|---|---|
| `PROJECT_STATE.md:48` | 「CI workflow exists but GitHub Actions has not executed」 | 同文件 `:85-86` 写 run 19/20/24 **SUCCESS**；GitHub 页面实测成功 |
| `PROJECT_STATE.md:5` | 「HEAD at last state write: 2488955」 | 实际 HEAD `50b60a1`（文档落后 1 提交，可接受但非实时） |
| `PROJECT_STATE.md:33` | 最新 proof `release_671f5faa5f.json` | 实际最新为 `release_360b1614d1.json` |
| `TEST_RESULTS.md:14,80` | 离线 **209** passed /「CI（GitHub Actions）未配置」 | 实际 **231** passed；CI 已运行且成功 |
| `docs/LIMITATIONS.md:66` | 「未接入 CI；测试需本地运行」 | 同上，已过时 |
| `AGENT_TASKS.md:47-48` | T-22/T-23 待做/阻塞（未提交、未推送） | 实际已提交并推送，远端 = HEAD |
| `audit/CI_REPLAY.md` | 「Not yet executed on GitHub Actions / CI cross-OS remains UNVERIFIED」 | 与 `audit/CI_SUCCESS_2026-11-15.md` 及 GitHub 页面冲突（CI_REPLAY.md 为 10:58 旧稿） |

**结论**：状态/验收文档存在**时间切片混杂**（V1 旧稿 + 最新结论并存）。Phase 0 只采信「git 事实 + 可复跑命令 + 外部可核验页面」，文档仅作线索。

### 1.4 ⚠️ 并发写入：权威树在分析窗口内变脏（关键风险）

- T0（17:31）：`git status --porcelain` = **空**。T1（17:44/17:45 复核）：**10 项改动**；T2（17:48 复核）：**15 项改动**（写者仍活跃）。三个阶段 HEAD 均未变（`50b60a1`）。T1 快照：

| 类型 | 路径 | 现场 mtime（HKT） |
|---|---|---|
| M | `goe/cli.py`（+39） | 17:40:33 |
| M | `goe/contracts.py` | 17:39:49 |
| M | `goe/hypotheses.py`（+28） | 17:41:20 |
| M | `goe/research_triage.py` | 17:39:49 |
| M | `tests/test_hypotheses.py` | 17:41:31 |
| ?? | `goe/dossier.py`（9,722 B） | 17:40:12 |
| ?? | `goe/integration/capabilities.py`（B 能力路由） | 17:39:41 |
| ?? | `tests/test_dossier.py`、`tests/test_capabilities.py` | 17:40:12 / 17:39:41 |
| ?? | `research_dossiers/`（生成物目录，**未被 .gitignore 覆盖**） | 17:40 |

- T2（17:48）增量：`PROJECT_STATE.md`、`evaluation/research_candidates_2026-11-13.json`、`evaluation/v2_candidates_20_2026-11-13.json` 被修改；新增未跟踪 `evaluation/RESEARCH_VALUE_EVALUATION_V4.md`、`research/`、`goe/dossier.py`、`goe/integration/capabilities.py`、`research_dossiers/`。写者工作流 =「研究价值评估 v4 + 研究档案（dossier）+ B 能力路由」；**连 `PROJECT_STATE.md` 本身也在被并发改写**，进一步说明状态文件不可作为基线。

- 影响量化：干净树规范离线套件 = **231**；当前脏树 `--collect-only` = **235 collected / 10 deselected**（+4 个未提交测试；`git clean` 会把 `research_dossiers/` 视为脏）。**任何此时开始的 Workbench 任务都会在非冻结基线上工作**，且 `verify-release` 会因 dirty worktree 直接拒绝（`goe/release.py:560-561`）。
- 交叉印证：同项目 B 的 Phase 0 报告记录到外部 **R36 操作者会话在飞**；A 树的 `capabilities.py`（B 能力路由）与 `dossier.py` 属同一「A→B 路由/研究档案」工作流，疑似上层会话正在并行实现。
- **处置建议**：Phase 0 结论冻结在 `50b60a1`；Workbench 接入前置条件 = 「A 权威树 `git status` 干净 + 写者确认退出」（或由用户指定以某新 commit 为基线）。

---

## 2. 架构与测试地图

### 2.1 核心模块（行号对应 `50b60a1`；被并发修改的文件用函数名定位）

| 模块 | 职责 | 关键实现点 |
|---|---|---|
| `goe/pipeline.py` | 端到端编排 | 每阶段幂等；`scan_runs` 记 config/data hash；失败回滚 |
| `goe/ingest.py` + `goe/sources/`（15 个 .py = 4 个基础设施 + 11 个 provider 模块） | 11 个 provider：Yahoo 价格 + Treasury/MOF Japan/ECB/BLS/BIS/Eurostat/CFTC/akshare CN 债/akshare CN 指数/Shiller；DB `sources` 表登记 13 个 source_id（含备用 cboe/coingecko/sp500_pe） | 禁止插值；单源 0 行 → `IngestError`；逐 symbol 失败进 errors |
| `goe/features.py` | 时点特征层 | `RELEASE_LAG_DAYS`(:36)、`STALE_AFTER_DAYS`(:43)、`as_of` 截断(:341-365)、宏观可见性(:504-543) |
| `goe/anomalies.py` | **14 个检测器**（`DETECTORS` :804-809） | 稳健 z/尾随分位；证据 JSON 含公式；家族/实体限流 + 跨日去重 |
| `goe/transmission/evaluator.py` + `config/mechanisms.yaml` | **15 条机制 / 53 项可执行检验** | corr/lead-lag/conditional；`identification: correlation_only`；置信度公式透明 |
| `goe/opportunities.py` + `config/scoring.yaml` | 5 类原型 → 评分 → 去重 → 生命周期 | 硬门槛（证据<2 或数据质量<0.30 → excluded）；八维权重合计 1.0 |
| `goe/contracts.py` | V1/V2 契约校验 | `validate_research_candidate()`；`handoff_eligibility=eligible` 需 `evidence_ok` 且 ≥2 个 discriminating 证据 |
| `goe/research_triage.py` | V2 Research Discovery | 候选生成 + 证据充分性门 + A/B/C/D gate（返回 `intelligence`/`evidence_gap`） |
| `goe/readiness.py` | 数据就绪门 | 陈旧/缺失/区域覆盖阻断扫描 |
| `goe/release.py` + `goe/scan_evidence.py` | 发布闸门 + 扫描证据校验 | proof schema `goe-test-proof/v4`(:43)、`MIN_REQUIRED`(:63)、`verify_test_proof`(:552) |
| `goe/integration/{exporter,ia_adapter,research_handoff}.py` | A→B 导出/调用/语义判定 | `HANDOFF_SCHEMA_VERSION="1.0"`(:24)、`parse_research_artifact`、V2「事实核对」问题生成 |
| `goe/validation.py` | 历史回放 / 无前视检查 | `no_lookahead_diff`(:405-441) |
| `goe/web/app.py` | 只读仪表盘 | 仅 `do_GET`(:243)，无写方法 |

- 配置规模（直接解析/DB 实测）：标的 **125**（`config/universe.yaml` + DB `prices` distinct=125，2015-01-01→2026-11-13）、宏观/曲线/仓位序列 **92**（DB `indicators` distinct=92，2014-01-02→2026-11-13）、机制 **15** / 检验 **53**、主题（`themes.yaml` 顶层键）**82**、事件案例 **7**（`config/cases.yaml`）；阈值集中在 `config/thresholds.yaml`（grep 键值行 101，含注释）。
- 运行库状态（`data/goe.db` 109 MB，只读 `mode=ro&immutable=1` 查询）：`prices` 358,310 / `indicators` 159,508 / `anomalies` 1,506 / `transmissions` 5 / `opportunities` 11（excluded 4、low_priority 3、invalidated 2、watch 2、deep_research 0）/ `scan_runs` 6 / `quality_issues` 18；最新 scan `scan-20261115T044634Z-b68802`(as_of 2026-11-13, success)。

### 2.2 测试真实数量与执行（实测，非文档）

- 环境：`.venv` **存在**，Python **3.12.13**（uv 管理），pandas 3.1.1 / numpy 2.5.4 / pytest **9.2.0**；依赖齐备，**未安装任何包**。
- 规范离线命令（与发布闸门/CI 完全一致，`pyproject.toml` 的 `addopts=-q -m 'not network and not realdata'` 由 `-o addopts=` 覆盖）：

```bash
.venv/bin/python -m pytest tests -o addopts= -q -m "not network and not realdata"
```

| 指标 | 实测结果 |
|---|---|
| 结果 | **231 passed, 10 deselected, 777 warnings** |
| 失败/错误/跳过 | 0 / 0 / 0 |
| 耗时 | **143.78 s（2:23）**（另有 `-m "not network"` 口径：232 collected、退出码 0、墙钟 **186.39 s**） |
| 退出码 | 0 |
| 与 release proof 对照 | proof（`..._360b1614d1.proof.json`）记录 `passed=231`、`required.sha256=executed.sha256` → **一致** |

- 测试分层（`docs/TESTING.md` + `pyproject.toml` markers）：offline 默认 231；**network 9**（`@pytest.mark.network`，未跑）；**realdata 1**（`tests/test_contracts.py::test_research_v2_real_scan_contract`，`GOE_SLOW=1` + 需 `data/goe.db`，默认排除）。
- 25 个测试模块的离线用例数（`--collect-only -q -m "not network"` 逐文件合计 232；规范口径扣除 test_contracts 的 realdata 1 项 = 231）：

| 测试文件 | 用例 | 测试文件 | 用例 |
|---|---:|---|---:|
| `test_readiness_handoff.py` | 28 | `test_transmission.py` | 23 |
| `test_release_gate.py` | 22 | `test_sources_indicators.py` | 20 |
| `test_data_integrity.py` | 20 | `test_features.py` | 11 |
| `test_scoring.py` | 11 | `test_research_v2.py` | 10 |
| `test_scan_evidence.py` | 10 | `test_contracts.py` | 9（含 realdata 1） |
| `test_research_identity.py` | 6 | `test_hypotheses.py` | 6 |
| `test_status_lifecycle.py` | 5 | `test_external_evidence.py` | 5 |
| `test_pipeline_e2e.py` | 5 | `test_exporter.py` | 4 |
| `test_archetypes.py` | 4 | `test_anomalies.py` | 7 |
| `test_db.py` | 7 | `test_reports.py` | 3 |
| `test_research_quality.py` | 3 | `test_time_semantics.py` | 3 |
| `test_cross_asset_evidence.py` | 3 | `test_external_fetch.py` | 1 |
| `test_opportunities.py` | 6 | （合计） | **232→231** |

- 覆盖热点（与 A→B/核心主张相关）：交接语义 28、发布闸门 22、数据完整性 20、扫描证据 10、V2 研究 10、研究身份 6、外部证据 PIT 5。

---

## 3. CI 现状（`.github/workflows/verify-release.yml`）

### 3.1 它实际做了什么

1. 触发：push 到 `architecture/research-v2` 与 `main`、任意 PR、`workflow_dispatch`；`permissions: contents: read`；`ubuntu-latest`、Python **3.12**、`timeout-minutes: 30`、`fetch-depth: 0`。
2. 安装：`pip install -e . pytest`（联网安装依赖）。
3. `git clean -fdx`（在 CI 上清掉 ignored 构建产物，避免 editable install 污染脏检查）。
4. 取最新 proof：`PROOF="$(ls -1 audit/test_evidence/*.proof.json | sort | tail -1)"`（按文件名时间戳排序，非 mtime）。
5. 执行 `python -m goe.cli verify-release --proof "$PROOF"`，失败时以 `::error` annotation 暴露。

**关键在于 `verify-release` 不是结构校验，而是重跑**（`--no-rerun` 未传）：

- `goe/release.py:552` `verify_test_proof`：拒绝脏工作树（:560）、校验 proof 的 commit 与当前 HEAD（`_check_commit` :508：proof commit 必须是祖先，且其后只允许 `audit/ docs/ .github/` 与根文档 8 个 md 变化；`goe/ tests/ config/ contracts/ scripts/ pyproject.toml evaluation/` 一旦变化即拒绝）。
- 用可信 launcher（`PYTEST_LAUNCHER` :48，剔除 cwd 的 sys.path 防 shadow）**重跑规范套件**；要求 collected == executed == passed、`skipped==0`、`passed==required`、`required.sha256` 一致、`MIN_REQUIRED["offline"]=201`（:63）。
- 证据路径必须是仓库相对路径、不能逃逸仓库；跨 OS 可重放（proof 存 `{python}/{junit}` 模板）。

### 3.2 外部核验（网络受限下的替代手段）

- `api.github.com` 未认证配额已耗尽（403 rate limit）；改用**公开仓库 HTML 页面**核验（仓库 public，页面无需登录）：
  - **run `43697836146`** = HEAD `50b60a1` 的 `verify-release` 运行 → 页面 `aria-label="completed successfully"` ×4、`octicon-check`，判定 **SUCCESS**；**仓库 `audit/CI_SUCCESS_2026-11-15.md` 表格未记录此 run**（表格只到 @`2488955`，并写「final docs-only commit 会再触发一次，签名前请检查」）。
  - run `43697258390`（= 表中 run 24，@`2488955`）、run `43685550326`（@`b888303`）均成功；对照失败样本 run `43684711136`（@`ff2c868`）页面为 `aria-label="failed"`，说明判定方法有效。
- 结论：**HEAD 上 CI 实际为绿**，但**仓库内 CI 证据表落后 1 个 run**（自证据链缺口，非功能失败）。

### 3.3 能否作为交付闸门

**可以，但有明确边界**：

- ✅ 适合作为「离线测试 + 测试证据完整性 + 跨 OS 可重放」闸门：231 项全绿、用例集合哈希冻结、防止静默缩减（`MIN_REQUIRED` + collected==executed）、可移植。
- ❌ 覆盖不到的缺口：
  1. **不跑 network（9）与 realdata（1）**；不跑 `goe replay --cases`（7 案例，需 101 MB DB）、不跑 `goe handoff/triage` 实联调。
  2. **不独立校验 scan evidence**：`verify-release` 只验测试；`build_manifest` 才验 scan evidence，而后者依赖 gitignored 的 `data/goe.db` 与 `reports/`、`exports/`。`PROJECT_STATE.md:41-48` 已把「fresh clone 无法重算 scan evidence」「合成 DB 可自洽」「伪造 ingest_runs 可通过」列为**接受残余（P2）**。
  3. **不检查文档真实性**：`TEST_RESULTS.md`/`LIMITATIONS.md`/`AGENT_TASKS.md` 过时内容可长期存在且 CI 仍绿（本次实证）。
  4. **对代码/测试变更不友好**：proof commit 之后任何 `goe/ tests/ config/ contracts/` 变更都会让闸门拒绝 → 任何「加测试/改代码」的任务分支在 CI 上必红，除非同步提交新 proof（见 §6 各任务的验收含「重生成 proof」步骤）。
  5. 未确认分支保护/必选检查（需 GitHub API 或仓库设置页登录，本次 UNKNOWN）；`main` 落后 106 提交，PR 默认基线错误。
  6. Docker/Linux 本机跨 OS 重放曾因 Keychain 失败（`audit/CI_REPLAY.md`），macOS 上的交付证据只能本机复现。

---

## 4. 数据来源 / PIT / 前视偏差的实际实现证据

### 4.1 数据来源与可追溯性（有代码与库内数据双重证据）

| 证据 | 内容 |
|---|---|
| `config/sources.yaml` | 机器可读登记表，分 tier：`official`（Treasury/MOF/ECB/BLS/BIS/Eurostat/CFTC/Shiller）、`exchange`（备用 CBOE）、`aggregator`（Yahoo、akshare）、`proxy`（信用 ETF 代理）；每源记录 latency、license_note、known_gaps |
| `docs/DATA_SOURCES.md` §1-§2 | 12 个可用源 + 每源覆盖/时效/缺口；声明 `date`=观测日、`fetched_at`=UTC 抓取时间 |
| `goe/db.py:52,59` | `prices`/`indicators` 每行强制 `source_id TEXT NOT NULL, fetched_at TEXT NOT NULL, run_id` → 行级溯源 |
| `goe/sources/base.py` + `http.py` | 禁插值；逐 symbol 错误进 errors 不中断；超时/退避/限速/TLS 校验 |
| DB 实测 | `sources` 表 13 行（`akshare_cn_bond/bis/bls/cboe/cftc/coingecko/ecb/eurostat/mof_japan/shiller/sp500_pe/treasury_us/yahoo`）；`series_meta`、`ingest_runs`、`quality_issues`(18) 均在使用 |

### 4.2 时点（PIT）与前视控制——文件 + 关键逻辑

| 控制点 | 文件:行 | 关键逻辑摘要 |
|---|---|---|
| 价格 as-of 截断 | `goe/features.py:341-365` | `load_prices(..., end=self.as_of)`；`as_of > MAX(date)` 时**夹紧**而不是用陈旧数据假装未来 |
| 宏观发布滞后 | `goe/features.py:36, :504-543` | 月度 45 天 / 季度 120 天 / 周 4 天 / 日 0；`available = obs_date + lag`，仅 `available <= as_of` 可见，观测日保留原值 |
| 陈旧数据拒绝（不 forward-fill） | `goe/features.py:43, :513-517` | 超过 `STALE_AFTER_DAYS`（月 110/季 280/周 45/日 20）→ 记 `stale_macro_series`，当前使用被拒；历史仍保留以维持 T>t 一致性 |
| CFTC 发布时滞 | `docs/VALIDATION.md:14`、`config/positioning.yaml` + 数据层 | 周二数据 + 4 天（周五发布）后才可见 |
| 频率感知的「新鲜窗口」 | `goe/timesemantics.py:1-30` | 窗口锚定**可用日（availability）**而非观测日：日/曲线 7d、周 21d、月 75d、季 150d |
| 外部证据（一致预期/曲线）PIT | `goe/evidence/external.py:64-78, :125-130` | 硬条件 `available_at<=cutoff 且 publication_time<=cutoff 且 vintage<=cutoff 且 vintage<=available_at 且 publication_time<=available_at`；actual 的目标期须在过去，forecast 目标可在未来但发布/vintage 不可在未来；超 `max_age_days` 直接不可用（:84-90/:166） |
| 泄漏检测器 | `goe/validation.py:405-441` | `no_lookahead_diff(store,date_a,date_b)`：两次 as-of 构建比较共同历史，`max_abs_diff > 1e-5` → `leakage_detected=True` |
| 端到端测试 | `tests/test_features.py`（11 项含 `test_no_lookahead_for_price_features`、宏观滞后、陈旧剔除）、`tests/test_data_integrity.py`（20 项：CPI 月对齐、拆股 vs 指数毛刺、条件收益发布滞后、周末加密冲击）、`tests/test_time_semantics.py`（3）、`tests/test_external_evidence.py`（5） | 均为离线合成数据，无网络 |
| 回放验证 | `config/cases.yaml`（7 个预注册情景）、`goe/validation.py`、`docs/VALIDATION.md` | 逐 as_of 独立切片；结果 7/7（`audit/VALIDATION_RESULTS.md`）；只衡量检测能力，不衡量收益 |

### 4.3 证据缺口与残余风险（数据层）

1. **`no_lookahead_diff` 本身无测试**：全仓 `grep` 仅 `goe/validation.py` 定义处，无测试引用（→ 候选任务 T1）。
2. `config/evidence_sources.yaml` 中 `consensus`/`ois` 均 `enabled: false`（无授权源）；`docs/EVIDENCE_SOURCES.md` 明确：cross-asset 证据 ACTIVE（衍生）、OIS 仅 policy-path 代理、consensus BLOCKED（仅适配器）。因此 V2 证据门只能得到 **0 research candidates**——这是「诚实结果」而非 bug。
3. `goe/forward_eval.py` 使用未来收益（`_forward_return` 取 `index >= as_of`），属**评估专用**：全仓无任何 import 引用（grep 为空），当前不参与评分/机会生成；若未来接线必须重新做前视审计（UNKNOWN，见 §8）。
4. 证据门依赖本地 101 MB DB 与 gitignored 产物；`PROJECT_STATE.md:41-48` 接受为 P2。
5. 已知数据缺口（`docs/LIMITATIONS.md`）：无 OAS、无实际利率/盈亏平衡、无一致预期、无期权隐含分布、无 ETF 资金流；Shiller CAPE 止于 2023-09、Eurostat 镜像止于 2025-12（均被陈旧规则停用）。

---

## 5. A→B 交接现状（接口 / JSON / CLI / 测试 / 缺口）

### 5.1 两代接口并存

| 维度 | V1（opportunities → B） | V2（Research Discovery → B） |
|---|---|---|
| 对象 | `opportunities` 表 / `OPP-*` / `RT-*` | `research_v2_candidates` / `RC-*` |
| 导出文件 | `exports/pipeline_<date>.json`、`research_tasks/RT-*.json`、`research_queue_<date>.json`、`HANDOFF_SCHEMA.json` | `exports/research_candidates_<as_of>.json`、`exports/research_v2_ia/<RC>/<ts>/report.{md,json}` |
| 问题生成 | `goe/integration/exporter.py:99 build_research_question()`（自包含：现象/机制/证据/反证/失效条件/待答） | `goe/integration/research_handoff.py:26 build_v2_question()`（事实核对，禁投资建议词，`_clean` :19） |
| CLI | `goe handoff --ia-path <B> --limit N [--dry-run] [--question-patch] [--timeout]` | `goe triage --handoff --ia-path <B> [--limit] [--ia-out]` |
| B 侧调用 | `.venv/bin/python -m goe.cli handoff ...` → `python3 ia_cli.py research-run --question "<text>" --out-dir <dir>`（`ia_adapter.py:170 build_command`） | 同左（`research_handoff.py:52 handoff_v2`） |
| 成功判定 | `parse_research_artifact`（`ia_adapter.py:33-115`）：`run_ok=true` 且 S8 `answered` 且 `evidence_index` 非空 且 L1 事实行 > 0 且无语义失败步骤 → `ok_valid`；否则 `refused/rejected/partial/insufficient_data`，**CLI exit 2**，DB 记 `not_completed:<semantic>` | 同上 + `persist_v2_result`（`research_handoff.py:62`）：候选永不删除；失败 → `handoff_failed`；只有真 `ok_valid` → `research_complete` |
| 准入 | status ∈ {deep_research, watch, new} 进队列 | `eligible_for_handoff`（`research_handoff.py:95`）：`handoff_eligibility=="eligible"` 且 tier A/B/C 且 `research_readiness=="evidence_ok"`；否则 `triage` **exit 3**，候选留在 A |

- **JSON 契约（V1 envelope，`exports/HANDOFF_SCHEMA.json` v1.0）**：必需 `schema_version`(=1.0)、`engine{name,version,scan_id,as_of,generated_at}`、`provenance{config_hash,data_hash,db_path,disclaimer}`、`opportunity{opportunity_id,fingerprint,status,score,score_breakdown,archetype,title,market,asset_class,horizon,instruments,discovery,mechanism,evidence_for,evidence_against,catalysts,open_questions,invalidation,data_quality,research_question}`。
- **RT 任务 JSON**（实测 `exports/research_tasks/RT-*.json`）：`task_id,created_at,target_system,priority,opportunity_id,research_question,context,expected_outputs,callback{opportunity_id,fingerprint,store,status_map:{accepted→deep_research,deferred→watch,rejected→excluded}}`。
- **V2 候选字段**（`exports/research_candidates_2026-11-13.json`）：`research_id,as_of,market,asset_class,instruments,observed_phenomenon,competing_hypotheses[{id,label,type,implications,evidence_for,evidence_against,status}],evidence[{class,claim,value,source,available_at,discriminating?}],critical_unknowns,falsification_conditions,required_data,research_cost,decision_impact,priority_tier,research_readiness,handoff_eligibility,data_quality,evidence_gaps,v1_score,v1_status,evaluation_id,method,rationale`。
- **B 侧产物形态**（实测 `exports/research_v2_ia/RC-20261113-12/20261114T154011Z_.../report.json`）：顶层 `schema_version,pipeline_version,run,steps,fanout,layers,evidence_index,notes,run_ok`；A 解析 `steps[].semantic_ok`、`steps[S8_grounded_qa].envelope.data.status`、`layers.L1_事实层.{available,rows}`、`evidence_index`。

### 5.2 测试证据（离线）

| 测试 | 覆盖 |
|---|---|
| `tests/test_readiness_handoff.py`（28） | `parse_research_artifact` 语义矩阵（ok/refused/partial/timeout/L2-only/陈旧报告/rc!=0）、readiness 门、区域中断、陈旧曲线/宏观、as-of 历史不受未来日期阻断 |
| `tests/test_exporter.py`（4） | envelope 必填字段、问题自包含、四类导出文件、中文 UTF-8 |
| `tests/test_research_v2.py`（10） | V2 问题 fact-only、refused 不算完成、timeout 不为 unknown、生命周期保留候选、无孤儿、不触碰 V1 表、legacy RC 迁移、eligible 排除 intelligence |
| `tests/test_research_identity.py`（6） | 稳定内容哈希 ID、不可变身份、theme vs event ID |
| `tests/test_release_gate.py`（22） | proof 篡改/缩减/选择器绕过/伪造 manifest 等红队用例 |

### 5.3 实测交接状态与缺口

- **当前准入 = 0**：DB 实测 `research_v2_candidates` 20 条全为 `status=intelligence / tier=intelligence / readiness=evidence_gap / eligibility=a_retained`；`research_v2_tasks/events/results` **均 0 行** → V2 从未真正发起过交接（与 `PROJECT_STATE.md` 一致）。
- **磁盘上确有 1 次真实 V2 交接尝试**：`exports/research_v2_ia/RC-20261113-12/.../report.json`：`run_ok=true`、`evidence_index` 17 行、`S8_grounded_qa.envelope.ok=false`、`data.status="no_registry_identity"` → 按 A 语义应为 `refused`（B 进程 rc=0 但语义失败）。但**当前 DB 无对应 `research_v2_tasks/results` 行** → **DB 不是完整审计链**（V1 同样：DB `research_tasks` 仅 2 行、`opportunity_events` 无 `ia_research_run`，而磁盘有 `exports/ia_runs/OPP-0001`、`OPP-0002` 两份真实报告）。Workbench 验收不能以 DB 行数为唯一证据。
- **V1 实测**（文档记录 + 磁盘 artifacts）：B 进程 rc=0，但 S8 返回 `out_of_scope/unmapped` → A 记 `refused`/`not_completed:refused`、exit 2（不把 rc=0 当成功）。
- **结构性缺口（按严重度）**：
  1. **B 的能力边界 vs A 的标的**：B 是「全球宏观事实工作台」（`config/metric_registry.json` 110 个指标：US 57/CN 18/GLOBAL 12/EA 11/JP 8/HK 4）；A 的 `JP_EQ_N225` 等资产 ID 无 B 注册身份 → `no_registry_identity`。A 侧并发开发中的 `goe/integration/capabilities.py`（未提交）正在补「B 能力路由」，但 **不在 `50b60a1` 基线内**。
  2. **B 快照不可运行**：工作区 B 副本无 `.venv`、`data/daily` 仅 3 个 JSON、依赖未固定版本（`requirements.txt` 全 `>=`）→ 无法在本工作区离线复现真实 A→B 联调；A 的集成测试全部用 fake CLI/合成 payload。
  3. **研究证据门导致 0 候选**：`consensus`/`ois` 无授权源 → `evidence_gap` 是设计结果；要打通 A→B 必须先解决证据源（BLOCKED，不是代码问题）。
  4. **`research_queue_<date>.json` 写绝对路径**（`exporter.py:251,254`；`research_tasks.export_path` 同样绝对）→ 当前导出文件内是 `/Users/cast/Downloads/金融系统/global-opportunity-engine/...`，跨机器/跨工作区副本不可直接消费（候选任务 T2）。
  5. B 侧无任何关于 A 的集成文档/回归门（B 快照 grep `global-opportunity` 无结果）；A 单向依赖 B 的 CLI 文本契约，B 升级可能静默破坏（A 有 `check()` 探测 `research-run` 是否存在，但不校验字段 schema）。
  6. V2 候选的 `exports/research_v2_ia/` 目录无 DB 对应、无 schema 版本声明（artifact 契约弱于 V1 envelope）。

---

## 6. 3 个候选真实低风险任务（按优先级）

> 共同前提：只在 **A 工作区副本的 Workbench 沙箱分支** 执行（先完成 §7 的副本刷新）；不触网、不安装依赖、不改 `exports/HANDOFF_SCHEMA.json` v1.0 envelope、不改 `contracts/**`、不碰 `data/goe.db`。
> 共同注意：**任何 `goe/` 或 `tests/` 变更都会使现有 release proof 失效**（`goe/release.py:_check_commit` 只允许 proof 之后变 `audit/ docs/ .github/` 与根文档），因此每个任务的验收都包含「在主克隆重生成 proof」这一步（离线，`goe release --run-tests`，需 `data/goe.db`，不能在裸 worktree 中做）。

### T1（P0，最高优先）为 `no_lookahead_diff` 补 PIT 泄漏回归测试

- **任务描述**：`goe/validation.py:405-441` 的 `no_lookahead_diff` 是「无前视」核心主张的检测器，但**零测试覆盖**。新增 `tests/test_pit_lookahead.py`：
  1) 用 `tests/conftest.py` 的合成 `store` fixture 构建两个 as-of，断言 `n_compared>0` 且 `max_abs_diff≈0`、`leakage_detected=False`、`status!="no_overlap"`；
  2) 用 monkeypatch 替换 `goe.validation.FeatureBuilder` 为「特征值依赖 as_of」的假实现，断言 `leakage_detected=True`（正例，证明检测器真的能抓到泄漏）；
  3) 覆盖 `no_overlap` 与 `entities=` 过滤两个分支。
- **涉及文件**：`tests/test_pit_lookahead.py`（新增，约 110-150 行）；参考 `goe/validation.py:405`、`tests/conftest.py`（`store`/`synthetic_market` fixtures）。**不改产品代码**（若发现真 bug 另立任务）。
- **离线验证命令**：
  ```bash
  # 在 A 工作区副本 worktree 中
  <VENV_PY> -m pytest tests/test_pit_lookahead.py -o addopts= -q
  <VENV_PY> -m pytest tests -o addopts= -q -m "not network and not realdata"   # 期望 234 passed 左右
  ```
- **风险/收益**：风险**极低**（纯新增测试、无网络、无契约变更、fixture 已成熟）；收益**高**（把「无前视」从文档主张变成可回归验证的证据，直接服务 Phase 1 的 PIT 验收）。
- **预计改动量**：新增测试文件 ~150 行、0 产品代码；耗时 ~0.5-1 h；套件总时长 +<1 s（231→约 234）。
- **验收补充**：通过后在主克隆跑 `goe release --run-tests` 生成新 proof（231→234），否则 CI 闸门会拒绝（预期内）。

### T2（P1）修复 A→B 交接队列的绝对路径不可移植性

- **任务描述**：`export_all` 把 `research_queue_<date>.json` 的 `path` 与 DB `research_tasks.export_path` 写成机器绝对路径（`goe/integration/exporter.py:240-262`），当前导出文件指向权威树路径，跨机器/跨 Workbench 副本不可消费。改为**同时**输出 `path_rel`（相对 `base_dir` 或仓库根，规范 `/` 分隔）并保留 `path` 向后兼容；同步在 `docs/INTEGRATION_INVESTMENT_AGENT.md` §3 说明新增字段（文档变更在 proof 允许范围内）。
- **涉及文件**：`goe/integration/exporter.py`（:240-262 队列构造、:212 签名不变）、`tests/test_exporter.py`（新增 2 个断言：`path_rel` 存在且非绝对、不含用户主目录、文件可解析）、`docs/INTEGRATION_INVESTMENT_AGENT.md`（§3 字段表）。
- **离线验证命令**：
  ```bash
  <VENV_PY> -m pytest tests/test_exporter.py -o addopts= -q
  <VENV_PY> -m pytest tests -o addopts= -q -m "not network and not realdata"
  ```
- **风险/收益**：风险**低-中**（触及交接产物格式，但 envelope schema v1.0 未变、字段为新增；需同步文档与 DECISIONS 记录）；收益**中高**（A→B + Workbench 跨副本可复现，消除「导出文件里写死权威树路径」的移植性问题）。
- **预计改动量**：产品代码 ~15-25 行、测试 ~40 行、文档 ~10 行；耗时 ~1-1.5 h。
- **验收补充**：同上需新 proof；若判断为「交接格式变更」，在 `DECISIONS.md` 追加一条（非冻结契约，不得升 envelope `schema_version`）。

### T3（P2）`goe triage --handoff` 零候选安全语义的 CLI 级测试

- **任务描述**：V2 的安全属性是「**绝不强行交接**」：无 eligible 时必须打印原因并 **exit 3**、不得创建 `research_v2_tasks/results`、不得调用 B。当前只有 helper 层测试（`test_research_v2.py::test_handoff_eligibility_excludes_intelligence`），**CLI 接线无测试**。新增 CLI 级测试（建议新文件 `tests/test_cli_triage_handoff.py`）：用合成 `store`（无 eligible 候选）调用 `goe.cli.main(["triage","--handoff","--ia-path","<tmp 假 B>", "--db", ...])`，断言 `SystemExit.code==3`、输出含 "no eligible research candidate"、DB 中 `research_v2_tasks/results` 均为 0、假 B 的 CLI 从未被调用（用 monkeypatch/伪造脚本记录）。
- **涉及文件**：`tests/test_cli_triage_handoff.py`（新增，约 60-90 行）；参考 `goe/cli.py::cmd_triage`（`return 3` / `return 2` 分支）、`goe/integration/research_handoff.py:95 eligible_for_handoff`。产品代码预计**不需改**（若发现 `_store`/导出副作用问题再单独评估）。
- **离线验证命令**：
  ```bash
  <VENV_PY> -m pytest tests/test_cli_triage_handoff.py -o addopts= -q
  <VENV_PY> -m pytest tests -o addopts= -q -m "not network and not realdata"
  ```
- **风险/收益**：风险**低**（纯测试；注意 `cmd_triage` 会写 `exports/research_candidates_<as_of>.json`，测试必须把 `out` 指到 `tmp_path`，不许写仓库 `exports/`）；收益**中**（保护「不把 intelligence 强推给 B」的硬安全语义，同时给 A→B 交接补 CLI 端到端覆盖）。
- **预计改动量**：测试 ~80 行、0 产品代码；耗时 ~1 h；套件 +约 3 项。

> 说明：另有一类「文档真实性同步」（`TEST_RESULTS.md` 209→231、`LIMITATIONS.md` 去掉「未接入 CI」、`AGENT_TASKS.md` T-23、`PROJECT_STATE.md` 矛盾段落）**不需要新 proof**（属 proof 允许变更范围）、CI 可保持绿，但**无测试覆盖**；建议作为 Phase 1 housekeeping 单独立项，不占用本组 3 个工程任务名额。

---

## 7. 接入 Workbench 的建议配置

### 7.1 前置作业（Phase 1，不属 Phase 0 写权限；必须先做，否则接入=假绿）

A 工作区副本当前是 `main @ e5da620` 的旧克隆：**离线测试只有 106 项**（实测 `--collect-only`），目录缺 `.github/`、`contracts/`、`goe/{evidence,readiness,research_*,release,scan_evidence,timesemantics,hypotheses,expectations,evaluation,forward_eval}.py`、`docs/{TESTING,EVIDENCE_SOURCES,AGENT_OPERATING_MODEL}.md`、`exports/research_candidates_*.json` 等。直接把它配成 `local_path` 会让 231 项门的任务「通过」在 106 项旧代码上。

1. 在**工作区副本**内（唯一允许写域）：`git fetch origin` → `git switch -c architecture/research-v2 origin/architecture/research-v2`（远端已有 `50b60a1`，本地当前无同名本地分支）；确认 `git status` 干净、HEAD=`50b60a1`、`--collect-only` = **231**。
2. 在副本内创建 `.venv`（Python 3.12，`requirements.txt` 已 pin；安装需联网 → **需用户授权**），或 Phase 1 临时复用权威树 venv（见 7.3 方案 B）。
3. 再注册项目，`status` 由 `blocked` 转 `active`。

### 7.2 建议配置（字段对齐 Workbench v2 `projects` 表 / `POST /api/projects`）

```yaml
id: project-a-goe
name: global-opportunity-engine
description: >
  全球跨资产投资机会发现引擎（A），位于 investment-agent（B）上游：监测→异常→传导→
  机会管线→ResearchCandidate→A→B 交接。只研究、不交易、不预测收益。
repo_url: https://github.com/bojing951-hash/global-opportunity-engine
local_path: /Users/cast/Downloads/开发工作台/projects/v2/global-opportunity-engine   # 工作区副本，非权威树
default_branch: architecture/research-v2     # 开发线 = 最新远端分支；不要用 main（落后 106 提交）
language: python
test_command: >-
  /Users/cast/Downloads/开发工作台/projects/v2/global-opportunity-engine/.venv/bin/python -m pytest tests -o addopts= -q -m "not network and not realdata"
# 过渡方案 B（副本 venv 尚未建好、仅做只读诊断时可临时用；跨树耦合，不推荐长期）：
# test_command: >-
#   /Users/cast/Downloads/金融系统/global-opportunity-engine/.venv/bin/python -m pytest tests -o addopts= -q -m "not network and not realdata"
agent_kind: claude                # 默认 Coding Agent = Claude Code（走 GLM 端点）
audit_provider: deepseek          # 审计必须与编码模型族独立；Claude 实际模型族=glm → 审计用 DeepSeek
ci_required: false                # 先本地验收；CI proof 闸门对含代码/测试变更的分支默认会红（见 §3.3）
allow_local_acceptance: true
remote_push_authorized: false     # 默认 false：main 落后 106 提交、PR 基线错误、且推送/PR 需用户授权
status: active                    # 前置作业完成后才置 active
contract_files:
  - contracts/ACCEPTANCE_CONTRACT.md
  - contracts/HANDOFF_CONTRACT.md
  - contracts/RESEARCH_CONTRACT.md
  - docs/INTEGRATION_INVESTMENT_AGENT.md
  - AGENTS.md
protected_paths:
  - .github/**                    # CI 闸门自身
  - contracts/**                  # 冻结验收/研究/交接契约
  - audit/test_evidence/**        # release proof 证据（只能由 goe release 生成）
  - audit/releases/**             # release manifest
  - docs/examples/HANDOFF_SCHEMA.json
  - config/evidence_sources.yaml  # PIT/证据源策略（无授权不得改）
  - AGENTS.md                     # Agent 工作纪律
config:
  allowed_test_commands:
    - "/Users/cast/Downloads/开发工作台/projects/v2/global-opportunity-engine/.venv/bin/python -m pytest tests -o addopts= -q -m \"not network and not realdata\""
    - "/Users/cast/Downloads/开发工作台/projects/v2/global-opportunity-engine/.venv/bin/python -m pytest tests/test_exporter.py -o addopts= -q"
    - "/Users/cast/Downloads/开发工作台/projects/v2/global-opportunity-engine/.venv/bin/python -m pytest tests/test_pit_lookahead.py -o addopts= -q"
  test_env_allowlist: []          # 测试不得依赖环境变量；网络测试永不进入默认命令
  expected_offline_tests: 231     # 基线守卫（当前 Workbench 不强制；用于人工核对 collect 数）
budget:
  maxTokens: 300000               # 单轮上限；231 项套件 2:23，改动面小
  maxCostCny: 8
```

### 7.3 关键决策理由（逐项）

1. **local_path 用工作区副本**：权威树是活跃研发树（分析期内被并发写脏，见 §1.4），且不属于 Workbench 可写域；工作区副本独立 `.git`，可安全做沙箱分支。**但必须先按 7.1 刷新到 `50b60a1` 并建本地分支**，否则 `orchestrator.ensurePlanBranch` 只认 `refs/heads/<default_branch>`（`src/git.js:107 branchRef`），找不到 `architecture/research-v2` 时会静默回退到 `currentHead`（= 旧 `main` `e5da620`）→ 106 项旧套件的「假绿」。这是本次接入最大的配置陷阱。
2. **default_branch = architecture/research-v2**：GitHub 默认 main 落后 106 提交；A 的全部 V2/PIT 工作只在 `architecture/research-v2`。不要以 main 为基线。
3. **test_command**：与 CI/发布闸门完全等价的规范离线命令（`-o addopts=` 覆盖 pyproject，显式 `not network and not realdata`）；耗时 143.78 s，远低于 Workbench `TEST_TIMEOUT_MS` 默认 600 s；命令无换行、<800 字符，满足 `security.assertSafeTestCommand` 的精确 allowlist 约束（`src/security.js:93`）。**必须使用绝对 venv python 路径**：Workbench Agent（Claude Code）的 `allowedTools` 已禁用 `Bash`，测试只能由 Workbench 以 `test_command` 执行（`/bin/sh -c`），不依赖 Agent 环境。方案 A（副本自建 venv）需联网装依赖 → Phase 1 授权项；方案 B（权威树 venv）今天即可用，但跨树耦合、不是长期方案。
4. **agent_kind = claude（默认 Agent）**：Workbench Claude 适配器默认 `acceptEdits` + 工具白名单 `Read,Edit,Write,Glob,Grep,LS`（无 Bash/WebFetch/WebSearch），适合「读代码→小步改→让 Workbench 跑测试」的 Python 分析型任务；大文件（`goe/cli.py`、`config/scoring.yaml`）需靠 Glob/Grep 定位。
5. **audit_provider = deepseek（独立审计）**：`agents.claude` 默认复用 GLM 的 Anthropic 兼容端点（`GLM_API_KEY`→`CLAUDE_BASE_URL`/`CLAUDE_MODEL`），而 `orch.coderFamilyFor('claude')` = `modelFamily('glm', …)` = **`glm`**；`auditors.resolveAuditProvider` 要求审计模型族 ≠ `glm` → 候选只剩 `deepseek`（或 openai）。显式设 `deepseek` 可避免 `auto` 在只有 GLM+DeepSeek Key 时的不确定性，成本也低于 GPT。
6. **protected_paths**：保护「机器冻结面」——CI 工作流、四份契约、release proof/manifest、HANDOFF_SCHEMA 示例、PIT 证据源策略、AGENTS 纪律；`data/`、`exports/`、`reports/` 是 gitignored，git diff 看不到，纳入 protected 无实际效果，故不列（改由 sandbox + `.gitignore` 约束）。
7. **budget**：单轮 300k tokens / ¥8 足够覆盖「小步改 + 2 次重试 + 审计」；全局仍受 `MAX_TOTAL_TOKENS=3,000,000`、`MAX_COST_CNY=30` 硬上限约束（`docs/CONFIG.md` §3）。
8. **remote_push_authorized = false**：① 当前分支虽已推送，但 main 未合并且落后 106 提交，任何 PR 默认基线错误；② CI 的 release-proof 闸门会拒绝「proof 后修改 `goe/ tests/`」的分支（§3.3-4），推送即红；③ 推送/合并 main 属用户授权动作。Phase 1 若要远端流水线，需先与用户确认「integration 分支 + proof 重生成策略 + 必选检查」。
9. **ci_required = false + allow_local_acceptance = true**：Phase 0/1 的任务以本地 `test_command` + 独立审计验收；待 §3.3 的 CI 策略问题（proof 失效机制、PR 基线、分支保护）解决后再启用 CI 必选。

---

## 8. BLOCKED / UNKNOWN 风险清单

### BLOCKED（当前不可推进，需用户/上游决策）

| ID | 阻塞项 | 证据 | 解除条件 |
|---|---|---|---|
| B-A-1 | **A 权威树并发写入未停**（基线不冻结） | T0 干净 → T1 10 项 → T2 15 项未提交改动（mtime 17:39-17:48）；脏树 collected 231→235 | 写者确认退出且 `git status` 干净，或用户指定新基线 commit |
| B-A-2 | **A 工作区副本陈旧**，不可直接作为 `local_path` | 副本 = `main@e5da620`（11-13），离线测试 106 项、缺 8+ 模块与 `.github/contracts` | 按 §7.1 刷新到 `architecture/research-v2@50b60a1` 并建本地分支 |
| B-A-3 | **工作区副本无 `.venv`/依赖**，test_command 需跨树引用权威 venv | 副本无 `.venv`；权威 venv python 3.12.13 可用 | Phase 1 授权联网建副本 venv（`requirements.txt` 已 pin） |
| B-A-4 | **远端推送/PR 未授权且基线错误** | GitHub 默认分支 main（落后 106）；CI proof 闸门拒绝 code/test 变更 | 用户授权 + 确定 integration 分支/PR 基线 + proof 策略 |
| B-A-5 | **A→B 真实联调不可复现** | B 快照无 venv、`data/daily` 仅 3 文件；A 侧 0 eligible、V2 交接 DB 记录 0 | 提供 B 可运行环境 + 授权证据源（consensus/OIS）或接受「语义失败证据」为终态 |
| B-A-6 | **证据源授权缺失**：`consensus`/`ois` 均 `enabled:false`，V2 只能产出 0 research candidates | `config/evidence_sources.yaml`、`docs/EVIDENCE_SOURCES.md` | 用户提供授权数据文件（或正式接受「A 只做 intelligence」） |
| B-A-7 | **禁止联网数据源**（本次分析纪律）：`goe ingest/handoff/triage --handoff` 实跑、`pytest -m network`、`goe replay --cases` 均不可执行（replay 还会写 `reports/`） | 本报告 §2.2 命令边界 | 明确授权窗口 + 只读/隔离目录 |

### UNKNOWN（证据不足，不可作为验收依据）

| ID | 未知项 | 现状 | 后续验证 |
|---|---|---|---|
| U-A-1 | GitHub Actions 细节（日志、实际 `--proof` 选择、job 步数） | API 限流 403；只能读公开 HTML；已确认 HEAD run 成功但读不到测试计数 | 有 token/登录后查 run 日志或 `gh run view` |
| U-A-2 | 分支保护 / required checks / main 是否受保护 | 未登录，UNKNOWN | 仓库设置页或 API（需 token） |
| U-A-3 | Linux 跨 OS 重放 | Docker 曾因 Keychain 失败；本机只有 macOS 结果 | CI run 日志（当前只知成功），或再试 Docker |
| U-A-4 | scan evidence 的独立可信度 | 依赖本地 101 MB DB + gitignored reports/exports；无外部签名锚；合成 DB 可自洽（已列 P2） | 需外部锚/签名方案（研究项，非 Phase 0） |
| U-A-5 | `goe/forward_eval.py` 未来收益逻辑是否会被接线 | 当前全仓无 import，评估专用；一旦接入评分即构成前视风险 | 代码评审 + 接线前 PIT 回归（T1 可复用） |
| U-A-6 | B 侧与 A 文档所述 `~/investment-agent-dev` 是否同一版本 | B 快照 HEAD `0f53463`（11-15 17:06，另有 R36 在飞）；A 文档未记 B commit | 由 B 侧 Phase 0 报告/B 负责人确认 |
| U-A-7 | 并发写者身份与意图 | 仅见文件 mtime 与新模块（`dossier.py`、`capabilities.py`、`research_dossiers/`）；非本报告写入 | 由 lead/用户确认；期间禁止以该树为基线执行 Workbench 任务 |
| U-A-8 | 文档真实性全面性 | 已发现 6 处过时/矛盾（§1.3），可能还有未抽查段落 | Phase 1 文档同步任务（建议单独立项） |

---

## 附录：本次只读核查证据（可复现命令）

```bash
# 1) Git 事实
cd /Users/cast/Downloads/金融系统/global-opportunity-engine
git branch --show-current; git rev-parse HEAD; git status --porcelain
git log --oneline -15
git rev-list --left-right --count origin/main...HEAD          # → 0  106
git merge-base --is-ancestor origin/main HEAD && echo FF-ok  # → FF-ok
GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=8" git ls-remote --heads origin

# 2) 离线测试（规范口径，实测 231 passed / 143.78s）
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest tests -o addopts= -q \
  -m "not network and not realdata" -p no:cacheprovider
.venv/bin/python -m pytest tests -o addopts= --collect-only -q -m "not network and not realdata"  # 分类计数

# 3) 运行库状态（严格只读：WAL 库在只读目录下普通 mode=ro 需可写 -shm 会失败，改用 immutable=1）
.venv/bin/python - <<'PY'
import sqlite3, pathlib, urllib.parse
p = pathlib.Path("data/goe.db").resolve()
con = sqlite3.connect("file:"+urllib.parse.quote(str(p))+"?mode=ro&immutable=1", uri=True)
cur = con.cursor()
for t in ("prices","indicators","anomalies","transmissions","opportunities",
          "research_v2_candidates","research_v2_tasks","research_v2_results"):
    print(t, cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0])
PY

# 4) CI 外部核验（公开仓库 HTML；API 已限流 403）
curl -sS -L https://github.com/bojing951-hash/global-opportunity-engine/actions/runs/43697836146 | grep -o 'completed successfully' | wc -l
```

- 分析窗口内 A 权威树**唯一**被改动的状态变量是并发写者造成的 working-tree 变更（17:44=10 项，17:48=15 项，HEAD 始终 `50b60a1`）；本报告未对 A 做任何写入。
- 报告落盘时间：2026-11-15 17:48 HKT（收尾复核）；A 权威树参照 commit：`50b60a1`（分支 `architecture/research-v2`），收尾时 working tree 已脏（15 项，非本报告所为）。
