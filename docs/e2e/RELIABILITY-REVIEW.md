# 可靠性整改独立审查记录

审查者：`v36-reviewer`（只读；未改文件、未重启生产、未发起付费调用）。

## 发现并已修复

1. **P0-A 容器清理误杀活执行者**
   - 原因：清理查询漏了 `ai-workbench.fence` 字段，fence 解析为 0，永远不匹配。
   - 修复：主查询补全 fence，并新增“有效 owner+fence 活容器必须保留”真实 Docker 回归。
2. **P0-B 基础设施 timeout 进入产品 Auto Repair**
   - 原因：Loop 分类将 `基础设施/预算中断（infrastructure_timeout）` 先命中 timeout 正则。
   - 修复：基础设施分类优先；`maybeAutoRepair` 对 infrastructure 直接跳过；真实 LoopManager 回归。
3. P1 replay 旧 stalled 统计未含 `infrastructure_*`：已补充。
4. P1 容器进程 timeout 短于容器 watchdog：已对齐为至少 watchdog+60s。
5. 文档/证据绑定已更新到最终提交；产品修复副本 25/25。

## 最终验证

- 全量：**340 tests / 340 pass / 0 skipped / 0 fail**（Docker 29.9.3，真实容器测试）。
- 新增：watchdog 5、container recovery 3、infra recovery 3、worktree recovery 1。
- 未运行新的真实付费 E2E；旧实验仍 failed，新 E2E 需要新授权。
