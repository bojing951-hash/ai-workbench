// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/pricing.js 成本估算（纯函数，离线）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { estimateCostCny, usdToCny, formatCny, formatTokens } from '../src/pricing.js';

describe('pricing：成本估算（人民币）', () => {
  it('deepseek 有正数成本，并按 token 线性增长', () => {
    const cost = estimateCostCny('deepseek', 'deepseek-chat', { input: 1_000_000, output: 1_000_000 });
    // deepseek: input 0.28 USD/M + output 0.42 USD/M，USD_CNY=7.2
    assert.ok(cost > 0);
    assert.ok(Math.abs(cost - (0.28 + 0.42) * 7.2) < 1e-9);
    const double = estimateCostCny('deepseek', 'deepseek-chat', { input: 2_000_000, output: 2_000_000 });
    assert.ok(Math.abs(double - cost * 2) < 1e-9);
  });

  it('glm 有正数成本（按人民币每千 token 计价）', () => {
    const cost = estimateCostCny('glm', 'glm-5.3', { input: 1000, output: 1000 });
    assert.ok(cost > 0);
    // 0.004 + 0.016 = 0.02 元
    assert.ok(Math.abs(cost - 0.02) < 1e-12);
  });

  it('0 用量成本为 0（deepseek / glm / openai）', () => {
    for (const [provider, model] of [['deepseek', 'deepseek-chat'], ['glm', 'glm-5.3'], ['openai', 'gpt-4.1']]) {
      assert.equal(estimateCostCny(provider, model, {}), 0);
      assert.equal(estimateCostCny(provider, model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
    }
  });

  it('缓存 token 也计入成本，且按更低价计费', () => {
    const full = estimateCostCny('deepseek', 'deepseek-chat', { input: 1_000_000 });
    const cached = estimateCostCny('deepseek', 'deepseek-chat', { cacheRead: 1_000_000 });
    assert.ok(cached > 0);
    assert.ok(cached < full);
    const write = estimateCostCny('deepseek', 'deepseek-chat', { cacheWrite: 1_000_000 });
    assert.ok(Math.abs(write - full) < 1e-9); // 缓存写入按 input 价
  });

  it('provider 缺失时按 openai 价目兜底，未知用量字段按 0', () => {
    assert.equal(estimateCostCny('', '', { input: 0 }), 0);
    assert.ok(estimateCostCny('', '', { input: 1_000_000 }) > 0);
    assert.equal(estimateCostCny('deepseek', 'deepseek-chat', { input: null, output: undefined }), 0);
  });

  it('usdToCny / formatCny / formatTokens 基础格式化', () => {
    assert.equal(usdToCny(1), 7.2);
    assert.equal(usdToCny(0.5), 3.6);
    assert.equal(formatCny(2.345), '¥2.35');
    assert.equal(formatCny(0.0123), '¥0.012');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(2_500_000), '2.50M');
  });
});
