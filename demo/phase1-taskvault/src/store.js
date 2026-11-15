/**
 * TaskVault 任务存储（占位实现）。
 *
 * 约定：
 * - `new TaskStore()` 为内存模式；
 * - `new TaskStore(filePath)` 使用 JSON 文件持久化；
 * - addTask(title) -> { id, title, completed, createdAt }
 * - completeTask(id) -> 更新后的任务
 * - listTasks(options) -> 任务数组
 * - stats() -> 统计对象
 */
export class TaskStore {
  constructor(filePath = null) {
    throw new Error('TaskStore 尚未实现');
  }

  addTask(title) {
    throw new Error('addTask 尚未实现');
  }

  completeTask(id) {
    throw new Error('completeTask 尚未实现');
  }

  listTasks(options = {}) {
    throw new Error('listTasks 尚未实现');
  }

  stats() {
    throw new Error('stats 尚未实现');
  }
}
