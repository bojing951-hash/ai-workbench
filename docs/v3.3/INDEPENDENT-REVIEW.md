# v3.3 独立只读审查

审查者：`v33-reviewer`（只读，未改文件、未重启 4477）。

## 结论

**未确认 P0 代码缺陷。** 两项预算 P0 与最终三阶段验收核心行为通过代码阅读、定向测试、真实 DB 迁移实验和生产账本核对。

- 目标测试 18/18 pass；
- 全量日志与 `demo/evidence/v3.3/tests.log` 一致：306 tests / 302 pass / 4 skipped / 0 fail（最终提交后本地复跑）；
- Playwright 15/15。

## P0-1 确认

- 逐调用 `provider + provider_known` 分组；mixed GLM unknown 不豁免；
- 历史推断不再 known=1；
- 无 `MAX(provider_known)`；
- 全局/项目/DSH 隔离；
- 生产账本 `glm@unknown` 已计入，确认 GLM 合法豁免；
- 未重置历史。

## P0-2 确认

- UNKNOWN 旧行保留，新付费重试独立 ID/new requestKey；
- 完整 BEGIN IMMEDIATE 检查；
- settled/reserved 重复被拒；
- TTL→unknown；
- 真实 SIGKILL 后预留仍占额（v3.3 新增子进程 SIGKILL 测试）；
- 结算不可重复（v3.3 修复 WHERE 条件）；
- 历史迁移有测试（v3.3 新增 legacy_inferred 降级测试）。

## 审查发现并修复

- P1-1 SIGKILL 证据名不副实 → 新增真实子进程 SIGKILL 测试；
- P1-2 历史推断降级无测试 → 新增迁移测试；
- P2 重复结算 → 修复为只允许 reserved/unknown 结算一次；
- 文档/账本：修正预算剩余 0、glm@unknown 说明。

## 残余 P2/UNKNOWN

- API 文档 byProvider 键未更新；
- expired 状态不落库（TTL 直接 unknown）；
- DSH 专项无原子预留，并发可能超；
- 重试 retryOf 仅返回值，未持久化；
- 同 reservationId 重试会 UNIQUE 失败（调用方不会复用）；
- 真实 Provider E2E、24H、真实 unknown 对账未执行。
