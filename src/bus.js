// SPDX-License-Identifier: Apache-2.0
/** 事件总线：编排器 -> SSE 客户端，进程内发布订阅。 */
export class EventBus {
  constructor() {
    this.subscribers = new Set();
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(event) {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* 单个订阅者失败不影响主流程 */
      }
    }
  }
}

export const bus = new EventBus();
