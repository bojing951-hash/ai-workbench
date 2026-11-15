// SPDX-License-Identifier: Apache-2.0
/**
 * 成本估算（人民币）。价格集中在此，便于按最新价目调整。
 * 注：Claude Code 会返回官方 total_cost_usd，优先采用；其余按 token 估算。
 */
const USD_CNY = 7.2;

const PRICING = {
  // 每百万 token 美元价
  openai: { input: 2.0, cachedInput: 0.5, output: 8.0 },
  deepseek: { input: 0.28, cachedInput: 0.028, output: 0.42 },
  anthropic: { input: 3.0, cachedInput: 0.3, output: 15.0 },
};

// GLM 走 Anthropic 兼容端点，按人民币估算（每千 token）
const GLM_CNY_PER_K = { input: 0.004, cachedInput: 0.0008, output: 0.016 };

export function estimateCostCny(provider, model, usage = {}) {
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheWrite = Number(usage.cacheWrite || 0);
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();

  if (p.includes('glm') || m.includes('glm')) {
    return (input / 1000) * GLM_CNY_PER_K.input +
      (cacheRead / 1000) * GLM_CNY_PER_K.cachedInput +
      (cacheWrite / 1000) * GLM_CNY_PER_K.input +
      (output / 1000) * GLM_CNY_PER_K.output;
  }
  const table = PRICING[p] || PRICING.openai;
  const usd =
    (input / 1_000_000) * table.input +
    (cacheRead / 1_000_000) * table.cachedInput +
    (cacheWrite / 1_000_000) * table.input +
    (output / 1_000_000) * table.output;
  return usd * USD_CNY;
}

export function usdToCny(usd) {
  return Number(usd || 0) * USD_CNY;
}

export function formatCny(value) {
  const n = Number(value || 0);
  if (n >= 1) return `¥${n.toFixed(2)}`;
  return `¥${n.toFixed(3)}`;
}

export function formatTokens(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}
