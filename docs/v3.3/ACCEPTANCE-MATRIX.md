# v3.3 条款矩阵

## P0-1 GLM

| 条款 | 证据 | 状态 |
|---|---|---|
| 预算以单次调用为单位 | `llm_usage` 逐行，按 provider+known 分组 | PASS |
| 每条记录 Provider/模型/可信度/来源 | usage schema + triggers | PASS |
| 仅确认 GLM 可豁免 | `glm` vs `glm@unknown` 测试 | PASS |
| `provider_known=0` 不因同 Provider 豁免 | 混合测试预算 710 tokens | PASS |
| 不使用 MAX(provider_known) | SQL/代码已移除 | PASS |
| 历史推断不升级 | legacy_inferred 降级 migration | PASS |
| 全局/项目/DSH 独立 | project_audit 排除；项目 usage 独立 | PASS |
| 不重置/扩大预算 | 未改 env 授权 | PASS |

## P0-2 UNKNOWN

| 条款 | 证据 | 状态 |
|---|---|---|
| UNKNOWN 视为可能已产生费用 | unknown 状态 + 估算占额 | PASS |
| 重试不得覆盖/删除 UNKNOWN | 旧行保留，新 ID | PASS |
| UNKNOWN 估算持续保留 | `reservedBudgetTotals` | PASS |
| 新付费重试独立 ID/预留 | `unknown-call-1/2` 测试 | PASS |
| 同 requestKey 不免费 | 新 requestKey + 完整检查 | PASS |
| 状态迁移明确 | reserved/settled/unknown/released/expired | PASS |
| 每次新调用原子检查 | `BEGIN IMMEDIATE` | PASS |
| 不重复结算/漏记/错误释放 | settled duplicate / SIGKILL / TTL 测试 | PASS |
| 无法确认记录 UNKNOWN，不伪造 0 | usage_known=0 | PASS |
| 后续可对账 | reservation actual_tokens/cost 字段 | PASS（无 UI） |

## 最终产品闭环

| 条款 | 证据 | 状态 |
|---|---|---|
| A/B/C 真实测试执行 | v32 product test real Git/Loop/DB | PASS（fake 模型） |
| 最终审计绑定最终 SHA | evidence_hash=verified_sha | PASS |
| 冻结条款全部有证据 | product audit expected 校验 | PASS |
| acceptRun 真正 accepted | 正向测试断言 accepted | PASS |
| 不自动合并/部署 | 测试仓库无远端 | PASS |
| 缺失功能 BLOCKED | missing B / max round 测试 | PASS |
| 历史 PASS 不冒充 | stale A 测试 | PASS |
| fake 审计明确标注 | 测试文件注释 | PASS |

## 回归

- 本地全量：**303 tests / 299 pass / 4 skipped / 0 fail**；4 skip 为 Docker/symlink 环境能力。
- Playwright：15/15。
- 真实 E2E：BLOCKED。
- 24H：NOT_VERIFIED。
