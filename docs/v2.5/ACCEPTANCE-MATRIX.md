# v2.5 消费产品 + 工作台验收矩阵

| 验收项 | 状态 | 证据 |
|---|---|---|
| 可运行产品（干净工作区安装/构建/启动） | PASS | release worktree npm ci/build/preview；截图 |
| TypeScript 类型检查 | PASS | tsc --noEmit |
| 核心单元测试 | PASS | 9/9 vitest |
| 浏览器真实交互 | PASS | Playwright desktop + iPhone13：3 passed/1 expected skip |
| 桌面和手机布局 | PASS | desktop/mobile 截图 + 无横向溢出断言 |
| 输入验证与错误处理 | PASS | 负数/非法字段错误；空画像可用 |
| 用户数据本地默认 | PASS | localStorage，无上传/后端 |
| 研究依据可追溯/不编造 | PASS | evidence.json 5 条含来源/日期/类型/条件/局限；测试校验 |
| 不承诺确定收益 | PASS | 测试断言无保证/稳赚/确定收益文案 |
| 冻结测试未被 Coding Agent 修改 | PASS | 受保护路径 + 最终执行冻结文件 |
| 所有产品源码 Claude Code/GLM 生成 | PASS | task/commit 历史；无人工产品代码 |
| 任务关联真实 Commit+测试+审计 | PASS | CDL-1 d865a59d/PASS84；CDL-4 1ad754d1/PASS100 |
| 失败不标 PASS | PASS | UI 测试失败/DSH UNKNOWN 均未通过；最终才 PASS |
| Agent 失败有界自动恢复 | PASS（有限） | 看门狗终止/超时/新会话；UI 代码保留后修复；详见 docs/FAILURES |
| DSH 独立审计（只读、独立工作区、逐条证据、绑定 commit） | PASS | DSH adapter + 4 次真实调用；最终 4/4 PASS 100 commit 1ad754d1 |
| DSH 实际模型/计费来源 | PASS（带 UNKNOWN 明细） | 同一 DeepSeek API Key，模型来自 api.deepseek.com；项目级 ¥30 账本，费用 estimated，无厂商账单 |
| 审计预算独立核算、不提高其他项目预算 | PASS | budget_scope=project_audit；¥0.9014/30；其他预算未改 |
| Fencing Token（过期所有者防重写） | **FAIL / NOT_IMPLEMENTED** | 仅租约+对账；未实现 fencing，未声称完成 |
| 单写租约/恢复对账 | PASS（v2.4） | SQLite 租约/过期/对账测试 |
| 独立 Supervisor 托管产品项目 | PASS | 项目 supervisor_managed；Supervisor 运行中；v2.4 SIGKILL/健康恢复证据 |
| 24h 无人监督验收 | **NOT VERIFIED（历史）** | 未执行完整 24h；`24H_AUTONOMY_NOT_VERIFIED` |
| 产品远端 Draft PR | **BLOCKED** | 无远端授权；本地 release branch/tag/bundle |
| Workbench 主分支合并/部署 | PASS（未做） | 未合并/未部署 |
| A/B 零干扰 | PASS（操作层面） | 未访问/修改/暂停/同步/推送 A/B |
