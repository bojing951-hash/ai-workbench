# GLM 预算与模型身份（v2.2）

## 规则

只有 **known 且 provider=glm** 的调用获得用户授权的预算豁免；未知供应商永远不豁免。
- Claude Code + `open.bigmodel.cn`/GLM model → glm（豁免）
- Claude Code + OpenAI/Anthropic/DeepSeek 端点 → 对应非 GLM（不豁免）
- DSH 显式 provider/model/端点 → 对应供应商；仅 DeepSeek 凭据→deepseek；否则 unknown
- 审计/规划：声明 provider 与实际端点交叉核对，冲突按实际端点；无法确定→unknown
- 单任务 token cap 对已知 GLM 为无限；仍保留墙钟、并发、取消、重试、权限限制
- 历史记录保留 `legacy_inferred` 来源，不改数值；attempts/audits 保存 provider_known/provider_source

## 验证

`tests/model-identity.test.js` 覆盖 GLM / DeepSeek / OpenAI / unknown 四类；`tests/loop-and-glm.test.js` 覆盖 unknown 不豁免与 provider 分账。

## 真实用量（截至 v2.2 交付）

- GLM：2,519,937 tokens（缓存 2,001,536），¥14.35，不计入上限。
- DeepSeek：18,939,336 tokens（缓存主导），¥6.20，缓存折算预算 2,927,688/3,000,000（剩余 72,312）。
- 全部成本 ¥20.54/¥30。未隐藏/归零/修改历史。
