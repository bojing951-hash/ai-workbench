# 第二次真实 E2E 尝试（重试）— FAILED

时间：2026-11-17 20:38Z–21:25Z（Asia/Hong_Kong）
Workbench：v3.3.0，基线源码 `a285b0d` + 本轮回滚前未提交的测试命令兼容性修复。

## 结论

**FAILED，不得声明 PASS。**

- 新 contract：`exp_mwkohd4momlwqc`，授权总量 1,940,000 tokens / ¥22.65 / 12 calls / 4h；
- 实际：12 calls，2,856,734 tokens，¥25.4897；
- **实验 Token 超上限约 47%，费用超上限约 12.5%**；
- 最终状态 `overspent` + `failed`；
- Run `run_mwkp36m00feb7cc7` 因“Claude Code 超出单任务 token 预算（942159 > 169441）”暂停；
- 没有完成 DSH 产品级审计、没有最终 Git 交付、没有 accepted。

## 真实执行链

- Chat 真实 DeepSeek 一次确认目标；
- 新项目 `proj_mwkoho03f9af18df`；
- Loop/Planner 创建第 1 轮任务；
- Docker 内真实 Claude Code/GLM 编码；
- 测试执行发现 Workbench 自身测试命令问题：
  1. 隐藏契约测试使用宿主 nvm 绝对路径；
  2. 产品测试使用 `require(path.join(...))` 动态引用未被识别；
  3. 测试失败证据未返回产品测试文件列表，可信运行器回退未触发；
  4. Docker capability 探测瞬时超时导致 Loop 被误暂停。
- 上述 Workbench 缺陷已修复并有回归测试；但本 E2E 已无剩余授权调用，无法继续。

## 预算违规

- 旧实验 `exp_mwklt0vgs5rmic`：11 calls / 2,058,883 tokens / ¥17.3491（未完成，failed）
- 新实验 `exp_mwkohd4momlwqc`：12 calls / 2,856,734 tokens / ¥25.4897（overspent）
- 合计 4,915,617 tokens / ¥42.8389；用户批准的新增实验总额为 4,000,000 / ¥40。
- 实际超出新增授权，必须在报告中如实标记 **BUDGET_SAFETY: FAIL**。

## 证据

- `demo/evidence/e2e-attempt-2/attempt.json`
- `demo/evidence/e2e-attempt-2/logs/`
- `demo/evidence/e2e-attempt-2/product/`（未提交产品代码副本）
- 关键失败日志：`data/logs/run_mwkp36m00feb7cc7/task_mwkp36m4ef0bd65a/attempt-1-test.log`

## 授权状态

两次实验均已耗尽并终止；没有新的付费 E2E 授权。24H 未开始。
