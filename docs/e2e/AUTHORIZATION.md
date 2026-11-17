# E2E 授权记录与检查

## 当前状态

**AUTHORIZATION_REQUIRED / NOT APPROVED**

- 没有 `experiment_contracts` 有效授权记录；
- 没有新增 E2E 付费调用；
- 没有创建验收产品；
- 现有全局预算未重置、未提高。

## 授权必须包含

- 授权人实名；
- 授权时间；
- 新实验 Project ID（或已绑定 Conversation ID，之后 link Project）；
- Provider / 模型；
- Token 上限；
- 费用上限与提前停止线；
- 调用次数；
- 运行时间；
- 隔离方案（Docker required / 其他）；
- 停止条件；
- 契约版本和 SHA-256 hash。

## 授权方式

只能由用户在真实 TTY 执行：

```bash
node scripts/e2e-authorize.mjs --project-id <id> --authorized-by "<name>" \
  --isolation DOCKER_REQUIRED --confirm I_AUTHORIZE_E2E_BUDGET_V1
```

非 TTY / 错误确认语被拒绝；Coding Agent、Supervisor、Harness 不能代替用户。

## 未授权行为

- 不提高额度；
- 不清空历史账本；
- 不创建新付费调用；
- 不复用其他项目专项审计预算；
- 返回 AUTHORIZATION_REQUIRED。

## 授权后仍需

1. 把已批准的新全局上限写入 `.env`（MAX_TOTAL_TOKENS 等）并重启；
2. 确认 Docker 隔离可用；
3. 创建新隔离 Project + Conversation 并绑定契约；
4. 才能启动真实 E2E。
