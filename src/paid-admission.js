// SPDX-License-Identifier: Apache-2.0
/** 单次付费/普通发送预留对应的实际 transport 准入；同一异步调用链只允许许可次数。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PolicyError } from './policy.js';

const als = new AsyncLocalStorage();

export function installPaidAdmission({ experimentId = '', role = '', maxSends = 1, requestKey = '' } = {}) {
  const admission = { experimentId, role, maxSends: Math.max(1, Number(maxSends || 1)), sends: 0, requestKey };
  als.enterWith(admission);
  return admission;
}

export async function runWithSendLimit(maxSends, fn) {
  const admission = { experimentId: '', role: 'transport', maxSends: Math.max(1, Number(maxSends || 1)), sends: 0, requestKey: '' };
  return als.run(admission, fn);
}

export async function beforePaidSend({ provider = '', model = '' } = {}) {
  const a = als.getStore();
  if (!a) return;
  a.sends += 1;
  if (a.sends > a.maxSends) {
    throw new PolicyError('PAID_SEND_LIMIT', `PAID_SEND_LIMIT：${a.experimentId ? `实验 ${a.experimentId} ` : ''}单次预留/操作只允许 ${a.maxSends} 次实际发送；已拒绝第 ${a.sends} 次（${a.role}/${provider}/${model}）`);
  }
}
