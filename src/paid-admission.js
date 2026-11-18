// SPDX-License-Identifier: Apache-2.0
/** 单次付费预留对应的实际发送准入；同一异步调用链只允许发送一次。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PolicyError } from './policy.js';

const als = new AsyncLocalStorage();

export function installPaidAdmission({ experimentId = '', role = '', maxSends = 1, requestKey = '' } = {}) {
  const admission = { experimentId, role, maxSends: Math.max(1, Number(maxSends || 1)), sends: 0, requestKey };
  als.enterWith(admission);
  return admission;
}

export async function beforePaidSend({ provider = '', model = '' } = {}) {
  const a = als.getStore();
  if (!a || !a.experimentId) return;
  a.sends += 1;
  if (a.sends > a.maxSends) {
    throw new PolicyError('PAID_SEND_LIMIT', `实验 ${a.experimentId} 单次预留只允许 ${a.maxSends} 次实际发送；已拒绝第 ${a.sends} 次（${a.role}/${provider}/${model}）`);
  }
}
