// SPDX-License-Identifier: Apache-2.0
/**
 * 统一 LLM 客户端：OpenAI 兼容（OpenAI / DeepSeek）与 Anthropic 兼容（GLM）。
 * 用于规划器、独立审计器；Coding Agent 不走这里（走 agents/）。
 */
import { estimateCostCny } from './pricing.js';
import { extractJson, sleep, truncate } from './util.js';
import { redactSecrets } from './util.js';
import { beforePaidSend } from './paid-admission.js';

export class LlmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function providerSpec(config, name) {
  const llm = config.llm;
  switch (name) {
    case 'openai':
      return {
        name: 'openai',
        format: 'openai',
        baseUrl: llm.openai.baseUrl,
        apiKey: llm.openai.apiKey,
        defaultModel: llm.openai.model,
        label: 'OpenAI GPT',
      };
    case 'deepseek':
      return {
        name: 'deepseek',
        format: 'openai',
        baseUrl: llm.deepseek.baseUrl,
        apiKey: llm.deepseek.apiKey,
        defaultModel: llm.deepseek.model,
        label: 'DeepSeek',
      };
    case 'glm':
      return {
        name: 'glm',
        format: 'anthropic',
        baseUrl: llm.glm.baseUrl,
        apiKey: llm.glm.apiKey,
        defaultModel: llm.glm.model,
        label: 'GLM',
      };
    default:
      return null;
  }
}

export function availableProviders(config) {
  return ['openai', 'deepseek', 'glm']
    .map((name) => providerSpec(config, name))
    .filter((spec) => spec && spec.apiKey)
    .map((spec) => ({ name: spec.name, label: spec.label, model: spec.defaultModel }));
}

function endpointFor(spec, suffix) {
  const base = String(spec.baseUrl || '').replace(/\/+$/, '');
  if (suffix === '/chat/completions') return `${base}/chat/completions`;
  if (suffix === '/v1/messages') return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  return `${base}${suffix}`;
}

function normalizeUsage(provider, data) {
  if (provider.format === 'anthropic') {
    const u = data.usage || {};
    return {
      input: Number(u.input_tokens || 0),
      output: Number(u.output_tokens || 0),
      cacheRead: Number(u.cache_read_input_tokens || 0),
      cacheWrite: Number(u.cache_creation_input_tokens || 0),
    };
  }
  const u = data.usage || {};
  return {
    input: Number(u.prompt_tokens || 0),
    output: Number(u.completion_tokens || 0),
    cacheRead: Number(u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0),
    cacheWrite: Number(u.cache_creation_input_tokens || 0),
  };
}

async function postJson(url, headers, body, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用 LLM。
 * @returns {Promise<{ok:true, text:string, provider:string, model:string, usage:object, costCny:number, latencyMs:number}>}
 */
export async function complete({
  config,
  provider = 'auto',
  model = '',
  system = '',
  messages = [],
  maxTokens = 2048,
  temperature = 0,
  json = false,
  timeoutMs = 180_000,
  signal = null,
  retries = 2,
}) {
  const spec = providerSpec(config, provider);
  if (!spec) throw new LlmError('LLM_PROVIDER_UNKNOWN', `未知 LLM provider: ${provider}`);
  if (!spec.apiKey) throw new LlmError('LLM_NO_KEY', `${spec.label} 未配置 API Key`);
  const actualModel = model || spec.defaultModel;
  const url = spec.format === 'openai' ? endpointFor(spec, '/chat/completions') : endpointFor(spec, '/v1/messages');
  const headers =
    spec.format === 'openai'
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${spec.apiKey}` }
      : {
          'Content-Type': 'application/json',
          'x-api-key': spec.apiKey,
          'anthropic-version': '2023-06-01',
        };

  let body;
  if (spec.format === 'openai') {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push(...messages);
    body = {
      model: actualModel,
      messages: msgs,
      max_tokens: maxTokens,
      temperature,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };
  } else {
    body = {
      model: actualModel,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages,
    };
  }

  let lastErr = null;
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 每次实际 HTTP 发送前必须通过当前实验预留的发送准入；重试/JSON 重试同样受限。
      await beforePaidSend({ provider: spec.name, model: actualModel });
      const res = await postJson(url, headers, body, timeoutMs, signal);
      if (!res.ok) {
        const safe = redactSecrets(res.text.slice(0, 1200), config.secrets || []);
        lastErr = new LlmError('LLM_HTTP_ERROR', `${spec.label} HTTP ${res.status}: ${safe}`);
        const retriable = res.status === 429 || res.status >= 500;
        if (!retriable || attempt === retries) throw lastErr;
        await sleep(1200 * (attempt + 1));
        continue;
      }
      let data;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new LlmError('LLM_BAD_JSON', `${spec.label} 返回非 JSON HTTP 响应`);
      }
      const text =
        spec.format === 'openai'
          ? String(data.choices?.[0]?.message?.content ?? '').trim()
          : (data.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
              .trim();
      const usage = normalizeUsage(spec, data);
      const rawUsage = data && data.usage && typeof data.usage === 'object' ? data.usage : null;
      const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
      // 只接受供应商明确报告的完整输入+输出计数；null、缺失、只有部分字段都保持 UNKNOWN。
      const usageKnown = !!(rawUsage && (
        (isNum(rawUsage.prompt_tokens) && isNum(rawUsage.completion_tokens))
        || (isNum(rawUsage.input_tokens) && isNum(rawUsage.output_tokens))
      ));
      const costCny = estimateCostCny(spec.name, actualModel, usage);
      if (!text) throw new LlmError('LLM_EMPTY', `${spec.label} 返回空内容`);
      return {
        ok: true,
        text,
        provider: spec.name,
        providerLabel: spec.label,
        model: actualModel,
        usage,
        usageKnown,
        costCny,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastErr = err;
      const aborted = signal?.aborted;
      if (aborted) throw new LlmError('LLM_ABORTED', 'LLM 调用已被取消');
      if (attempt === retries) throw err instanceof LlmError ? err : new LlmError('LLM_NETWORK', String(err?.message || err));
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr || new LlmError('LLM_FAILED', 'LLM 调用失败');
}

/** 要求模型输出 JSON；解析失败自动重试一次（附加更严格的指令）。 */
export async function completeJson(opts) {
  const first = await complete({ ...opts, json: true });
  const parsed = extractJson(first.text);
  if (parsed !== null) return { ...first, json: parsed };
  const retry = await complete({
    ...opts,
    json: true,
    messages: [
      ...opts.messages,
      { role: 'assistant', content: first.text.slice(0, 2000) },
      { role: 'user', content: '上面的输出无法被 JSON 解析。请只输出一个合法 JSON 对象，不要任何解释、Markdown 围栏或额外文字。' },
    ],
  });
  const parsedRetry = extractJson(retry.text);
  if (parsedRetry === null) {
    throw new LlmError('LLM_BAD_JSON_OUTPUT', `模型输出无法解析为 JSON：${truncate(retry.text, 500)}`);
  }
  return {
    ...retry,
    json: parsedRetry,
    usageKnown: first.usageKnown !== false && retry.usageKnown !== false,
    usage: {
      input: first.usage.input + retry.usage.input,
      output: first.usage.output + retry.usage.output,
      cacheRead: first.usage.cacheRead + retry.usage.cacheRead,
      cacheWrite: first.usage.cacheWrite + retry.usage.cacheWrite,
    },
    costCny: first.costCny + retry.costCny,
  };
}
