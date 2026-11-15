// SPDX-License-Identifier: Apache-2.0
/** 简单异步信号量：限制并行 Agent 调用数量。 */
export class AsyncSemaphore {
  constructor(limit = 2) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  stats() {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}
