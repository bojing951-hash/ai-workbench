// SPDX-License-Identifier: Apache-2.0
/**
 * 模型身份识别（v2.2）。
 *
 * 预算豁免必须依据**实际模型供应商**，而不是调用入口（Claude Code / DSH 只是客户端）。
 * - 只有明确识别为 GLM 的调用才享受用户授权的预算豁免；
 * - 无法确定供应商时标记 unknown，unknown 永远不豁免；
 * - 识别来源与依据写入 attempts/audits，便于审计。
 */

export const KNOWN_PROVIDERS = ['glm', 'deepseek', 'openai', 'anthropic'];
export const EXEMPT_PROVIDER = 'glm';

export function normalizeProvider(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (['glm', 'zhipu', 'zhipuai', 'bigmodel', 'chatglm'].includes(value)) return 'glm';
  if (['deepseek'].includes(value)) return 'deepseek';
  if (['openai', 'azure-openai', 'azure'].includes(value)) return 'openai';
  if (['anthropic', 'claude'].includes(value)) return 'anthropic';
  return 'unknown';
}

/** 从实际 baseUrl / model 识别供应商；返回 null 表示无法确定。 */
export function classifyProviderFromEndpoint({ baseUrl = '', model = '' } = {}) {
  const url = String(baseUrl || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (/bigmodel\.cn|open\.bigmodel|zhipu|chatglm/.test(url) || /(^|[/:._-])glm[-._]?\d/.test(m) || /^glm-/.test(m)) return 'glm';
  if (/deepseek\.com|api\.deepseek/.test(url) || /deepseek/.test(m)) return 'deepseek';
  if (/api\.openai\.com|openai\.azure\.com|azure\.com\/openai/.test(url) || /^(gpt-|o[1-4][-_]|chatgpt)/.test(m)) return 'openai';
  if (/api\.anthropic\.com|anthropic\.com/.test(url) || /^claude-/.test(m)) return 'anthropic';
  return null;
}

function identity(provider, { known, model = '', source = '', note = '' } = {}) {
  const normalized = provider || 'unknown';
  return {
    provider: normalized,
    model: String(model || ''),
    known: !!known && KNOWN_PROVIDERS.includes(normalized),
    exempt: !!known && normalized === EXEMPT_PROVIDER,
    source: source || '',
    note: note || '',
  };
}

/**
 * 识别 Coding Agent 的实际模型供应商。
 * 注意：agentId=claude 不等于 GLM；agentId=dsh 也不等于 DeepSeek。
 */
export function resolveAgentIdentity({ config, agentId, project = null } = {}) {
  if (agentId === 'claude') {
    const cc = config?.agents?.claude || {};
    const baseUrl = cc.baseUrl || '';
    const model = cc.model || '';
    const endpointProvider = classifyProviderFromEndpoint({ baseUrl, model });
    if (endpointProvider) {
      return identity(endpointProvider, {
        known: true, model: model || endpointProvider,
        source: 'claude.baseUrl+model',
        note: endpointProvider === 'glm' ? 'Claude Code 使用 GLM Anthropic 兼容端点' : '',
      });
    }
    // 端点/model 无法识别时，即使调用的是 Claude Code，也不能默认 GLM 或豁免
    return identity('unknown', {
      known: false, model,
      source: 'claude.unresolved',
      note: baseUrl ? `无法从 baseUrl 识别供应商：${String(baseUrl).slice(0, 120)}` : '未配置 baseUrl/model，模型身份未知',
    });
  }
  if (agentId === 'dsh') {
    const dsh = config?.agents?.dsh || {};
    const declaredProvider = normalizeProvider(dsh.provider || '');
    const declaredModel = dsh.model || '';
    const endpointProvider = classifyProviderFromEndpoint({ baseUrl: dsh.baseUrl || '', model: declaredModel });
    if (endpointProvider) {
      return identity(endpointProvider, { known: true, model: declaredModel || endpointProvider, source: 'dsh.provider+model' });
    }
    if (declaredProvider !== 'unknown') {
      return identity(declaredProvider, { known: true, model: declaredModel || declaredProvider, source: 'dsh.provider' });
    }
    // 仅在明确存在 DeepSeek 凭据时识别为 deepseek；否则 unknown（不豁免）
    if (config?.llm?.deepseek?.apiKey) {
      return identity('deepseek', { known: true, model: declaredModel || config.llm.deepseek.model || 'deepseek', source: 'dsh.default.deepseek-credential' });
    }
    return identity('unknown', { known: false, model: declaredModel, source: 'dsh.unresolved', note: '未配置可识别的模型供应商/凭据' });
  }
  if (agentId === 'custom') {
    const custom = config?.agents?.custom || {};
    const declared = normalizeProvider(custom.provider || '');
    if (declared !== 'unknown') return identity(declared, { known: true, model: custom.model || '', source: 'custom.provider' });
    return identity('unknown', { known: false, model: custom.model || '', source: 'custom.unresolved' });
  }
  return identity('unknown', { known: false, source: 'agent.unresolved' });
}

/** 识别审计/规划 LLM 的实际供应商（显式 provider + 实际端点/model 交叉核对）。 */
export function resolveLlmIdentity({ config, provider, spec = null } = {}) {
  const declared = normalizeProvider(provider);
  const actualSpec = spec || config?.llm?.[declared] || null;
  const baseUrl = actualSpec?.baseUrl || '';
  const model = actualSpec?.model || '';
  const endpointProvider = classifyProviderFromEndpoint({ baseUrl, model });
  if (endpointProvider) {
    return identity(endpointProvider, {
      known: true, model: model || endpointProvider,
      source: 'llm.baseUrl+model',
      note: declared !== 'unknown' && declared !== endpointProvider ? `声明 provider=${declared} 与实际端点=${endpointProvider} 不一致，按实际端点计` : '',
    });
  }
  if (declared !== 'unknown') {
    return identity(declared, { known: true, model: model || declared, source: 'llm.provider-declared', note: '端点无法识别，采用显式声明的 provider' });
  }
  return identity('unknown', { known: false, model, source: 'llm.unresolved' });
}

export function isExemptIdentity(id, config) {
  if (!id || !id.known || id.provider !== EXEMPT_PROVIDER) return false;
  return config?.budget?.glmUnlimited !== false;
}

/** 供统计/预算使用：只有 known 的 GLM 可豁免，unknown 永远不豁免。 */
export function exemptProvidersFromConfig(config) {
  const raw = Array.isArray(config?.budget?.exemptProviders) ? config.budget.exemptProviders : [EXEMPT_PROVIDER];
  return new Set(raw.map((x) => normalizeProvider(x)).filter((x) => x !== 'unknown'));
}
