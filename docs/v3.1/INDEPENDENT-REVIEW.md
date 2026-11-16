# v3.1 独立只读审查记录

审查者：`v31-reviewer`（只读子代理；未修改文件、未重启生产、未触碰业务产品）。

## 首轮确认问题与整改

1. **P0：主要 Chat/Loop 路径的验收 gate 没有读冻结契约**
   - 审查发现：chat 创建的 `test_plan` 缺 acceptance，只写入了 TEST_PLAN.json；gate 只读 config。
   - 整改：`src/chat.js` 写入 `testPlan.acceptance`；`contractAcceptanceStatus`/Loop gate 回退读取 repo `TEST_PLAN.json`；`acceptRun` 再校验。`tests/v3-acceptance.test.js` + chat test 断言。
2. **P1：`retryVerification` 使用未定义变量**
   - 整改：初始化 `auditResourceInfo`、移除未定义 `signal`，真实 worktree 回归 `tests/v31-retry-verification.test.js` PASS。
3. **P1：暂停发生在 audit 时被记产品失败**
   - 整改：audit catch / audit 返回后检查 `signal.aborted`，释放预留并保留 checkpoint；恢复可继续。
4. **P1：主审计没有原子预留**
   - 整改：`runTask` audit 调用前 `assertModelBudget({reserve:true})`，成功 settle/异常 release；DSH 专项审计不占全局预留。
5. **P1：预算暂停无法显式授权**
   - 整改：`/api/runs/:id/resume`、`/api/loops/:id/resume`、`/control` 支持显式 `authorizeBudget`；自然语言“继续”默认 false。
6. **P1：Chat bad-output 泄漏预留**
   - 整改：无 reply 时 release。
7. **P1：Loop 控制写在共享 lease 竞态中被 tick 覆盖**
   - 整改：Loop pause/resume 先获取/释放 control lease；auto-repair/completeRound 异步后再检查 Loop 仍为 running，不把暂停覆盖为 running。

## 复审状态

- 审查者确认首轮 7 项整改可复现；随后指出 R1（测试/DSH audit abort 最终标记失败）、R2（retryVerification 不在 pause fencing）、R3（loop tick 覆盖 pause）。
- 这三个残余已进一步整改：
  - 测试/审计后检查 `signal.aborted`，不进入 failTask；
  - retryVerification 注册 controller/running，pause 可中止并等待；
  - loop tick/auto repair/completeRound 在状态写入前重查 loop status。
- **本轮最终 commit 的复审未返回**；不把开发者自评冒充审计通过。已确认残余：

## 残余 P1/P2/UNKNOWN

- 真实 Agent/DSH 闭环 E2E 未执行（BLOCKED）。
- 真实 pause during test/DSH audit/verification retry 的进程级测试覆盖仍有限（代码已加 abort 检查）。
- 并发 duplicate pause/resume 仍可能产生重复事件（状态最终幂等）。
- 各阶段 SIGKILL（agent/test/audit/commit/finalize）未逐一真实注入，UNKNOWN/PARTIAL。
- 真实 Provider 的 Audit 预留未跑（测试注入审计器）。
- 测试 runner/package 配置的合法更新授权 UI 尚未实现（变更需显式维护者操作）。
- 全部写路径 Fencing 未形式化穷举。
