// SPDX-License-Identifier: Apache-2.0
/** v2.2：GLM 预算豁免必须依据实际模型供应商（GLM/DeepSeek/OpenAI/未知四类）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentIdentity, resolveLlmIdentity, isExemptIdentity, classifyProviderFromEndpoint } from '../src/model-identity.js';

function config(overrides = {}) {
  return {
    budget: { glmUnlimited: true, exemptProviders: ['glm'] },
    agents: {
      claude: { baseUrl: '', apiKey: '', model: '' },
      dsh: { provider: '', model: '', baseUrl: '' },
      custom: {},
    },
    llm: {
      glm: { apiKey: 'x', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' },
      deepseek: { apiKey: 'x', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
      openai: { apiKey: 'x', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
    },
    ...overrides,
  };
}

const withClaude = (baseUrl, model, apiKey = 'key') => {
  const c = config();
  c.agents.claude = { baseUrl, model, apiKey };
  return c;
};

test('Claude Code 使用 GLM 端点 → provider=glm、豁免', () => {
  const id = resolveAgentIdentity({ config: withClaude('https://open.bigmodel.cn/api/anthropic', 'glm-5.3'), agentId: 'claude' });
  assert.equal(id.provider, 'glm');
  assert.equal(id.known, true);
  assert.equal(id.exempt, true);
  assert.equal(isExemptIdentity(id, config()), true);
});

test('Claude Code 使用 OpenAI/Anthropic 端点 → 不豁免', () => {
  for (const [base, model, expected] of [
    ['https://api.openai.com/v1', 'gpt-4.1', 'openai'],
    ['https://api.anthropic.com', 'claude-sonnet-4', 'anthropic'],
    ['https://api.deepseek.com/anthropic', 'deepseek-chat', 'deepseek'],
  ]) {
    const id = resolveAgentIdentity({ config: withClaude(base, model), agentId: 'claude' });
    assert.equal(id.provider, expected);
    assert.equal(id.exempt, false);
    assert.equal(isExemptIdentity(id, config()), false);
  }
});

test('调用 Claude Code 但无法确定供应商 → unknown，不豁免', () => {
  const id = resolveAgentIdentity({ config: withClaude('', ''), agentId: 'claude' });
  assert.equal(id.provider, 'unknown');
  assert.equal(id.known, false);
  assert.equal(id.exempt, false);
  assert.equal(isExemptIdentity(id, config()), false);
});

test('DSH 明确 GLM 端点 → glm 豁免；DeepSeek 端点 → deepseek 不豁免；无凭据 → unknown', () => {
  const c1 = config();
  c1.agents.dsh = { provider: '', model: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/anthropic' };
  const glm = resolveAgentIdentity({ config: c1, agentId: 'dsh' });
  assert.equal(glm.provider, 'glm');
  assert.equal(glm.exempt, true);

  const c2 = config();
  c2.agents.dsh = { provider: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' };
  const ds = resolveAgentIdentity({ config: c2, agentId: 'dsh' });
  assert.equal(ds.provider, 'deepseek');
  assert.equal(ds.exempt, false);

  const c3 = config();
  c3.agents.dsh = { provider: '', model: '', baseUrl: '' };
  c3.llm.deepseek.apiKey = '';
  const unknown = resolveAgentIdentity({ config: c3, agentId: 'dsh' });
  assert.equal(unknown.provider, 'unknown');
  assert.equal(unknown.exempt, false);
});

test('LLM 审计/规划：实际端点与声明不符时按实际端点；未知不豁免', () => {
  const c = config();
  const mislabeled = resolveLlmIdentity({ config: c, provider: 'glm', spec: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' } });
  assert.equal(mislabeled.provider, 'openai');
  assert.equal(mislabeled.known, true);
  assert.equal(mislabeled.exempt, false);

  const realGlm = resolveLlmIdentity({ config: c, provider: 'glm' });
  assert.equal(realGlm.provider, 'glm');
  assert.equal(realGlm.exempt, true);

  const unknown = resolveLlmIdentity({ config: c, provider: 'unknown', spec: { baseUrl: 'https://example.internal', model: 'mystery-model' } });
  assert.equal(unknown.provider, 'unknown');
  assert.equal(unknown.known, false);
  assert.equal(isExemptIdentity(unknown, c), false);
});

test('端点识别：GLM/DeepSeek/OpenAI/未知', () => {
  assert.equal(classifyProviderFromEndpoint({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3' }), 'glm');
  assert.equal(classifyProviderFromEndpoint({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }), 'deepseek');
  assert.equal(classifyProviderFromEndpoint({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' }), 'openai');
  assert.equal(classifyProviderFromEndpoint({ baseUrl: 'https://internal.example', model: 'mystery' }), null);
});
