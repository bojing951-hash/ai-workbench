# 真实零人工 E2E 执行记录

**状态：FAILED（不是 PASS，也不是 BLOCKED）**

用户于 2026-11-17 明确批准全部预算参数，并授权安装 Docker。实际执行了一次真实 E2E：

- Conversation：`conv_mwk6imxy5gfaz`
- Project：`proj_mwk6j7n9bbd7f450`（`projects/chat-本地消费记录小站-mwk6j7is`）
- Loop：`loop_mwk6j7rw263f3c67`
- 产品目标：本地消费记录小站（纯本地 localStorage）
- Coding：真实 Claude Code 2.1.104 + GLM-5.3，在 Docker 容器内
- Docker：29.9.3，镜像 `ai-workbench-runtime:2.2`，构建成功
- Chat/Planner：真实 DeepSeek `deepseek-chat`
- Experiment 1：`exp_mwk6iqcmtdt0me` — **failed**
- Experiment 2（同授权剩余额度重试）：`exp_mwk8big22iji92` — **failed**

## 发生了什么

1. Chat-First 一次输入成功，生成 4 条冻结验收条款；
2. 项目创建并绑定 experiment，Docker/模型绑定正确；
3. 真实 Claude Code 在容器内开始编码，写出了 `index.html`、`js/store.js`、`js/ui.js`、`css/style.css`、4 个测试文件；
4. 15 分钟无进展 watchdog 触发，Claude 容器被中止（Claude 当时已经写出大部分文件，但尚未返回最终结果）；
5. auto-repair 1/2、2/2 启动，均因同一 watchdog 窗口中止；
6. 授权模型守卫拒绝 fallback 到未授权 DSH，Loop 进入 paused；
7. 第二次延长 watchdog 的恢复尝试遇到工作副本/租约/并发容器问题，最终同样失败；
8. 因此没有进入真实产品测试 PASS、DSH 产品审计、Git 最终交付或用户验收。

## 真实产物与费用

- 部分产品源码已保留：
  - `demo/evidence/e2e-attempt/product/`
  - 工作副本路径：`data/worktrees/proj_mwk6j7n9bbd7f450/run_mwk6wr0ye80cf236/task-1`
  - 产品 checkpoint commit：`76cbd8b2ffa694bfd0ec2662370d37c06c257acd`
- 部分产品测试：**25 tests / 24 pass / 1 fail**
  - 失败：`alerts.test.mjs: 无记录或无设置时无任何提示`
- Experiment 用量：
  - Experiment 1：10 calls，1,300,141 tokens，¥8.6764
  - Experiment 2：4 calls，48,000 tokens，¥0.08
- 全局预算（用户批准后）：
  - max tokens 3,620,000；used 3,498,988；remaining 121,011.8
  - max cost ¥40；used ¥15.2456；remaining ¥24.7544
- 所有未结算预留已转 UNKNOWN，未当作免费。
- 没有最终 Git SHA、没有最终 DSH 审计 PASS、没有 accepted 产品。

## 结论

这是**真实 E2E FAILED**。失败原因已定位为 coding watchdog 窗口过短（15 分钟）及恢复期间的租约/容器并发清理问题，不是伪造的 PASS。

**再次真实 E2E 需要新的明确用户授权**（新的 experiment contract；不能复用已 failed 的契约）。

## 失败后整改（2026-11-17）

已针对本次失败完成：
- Agent 活动/内容进度指纹；
- 容器 Agent 有界 45 分钟 watchdog；
- 基础设施失败与产品修复分离；
- Docker 容器 labels、启动孤儿回收、owner/fence 校验；
- 失败产品隔离副本修复（25/25 tests）。

**没有启动新的付费 E2E。** 旧 experiment 仍为 failed；新真实 E2E 需要新的明确授权。
