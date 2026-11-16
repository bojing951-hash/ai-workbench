# Reading Queue Planner — 冻结需求与验收契约（v2.7 独立验收项目）

用户只需提交一次需求：一个本地阅读队列规划器，支持书籍管理、按每天可用分钟数和期限生成阅读计划，并将数据保存在本地 JSON。

## 需求与验收（隐藏检查也覆盖）

- R1 书籍管理：`addBook` 校验 title/author/priority（1-5）/pages>0，书籍 id 唯一；`listBooks`/`searchBooks` 支持标题/作者子串搜索（大小写不敏感）；非法输入抛出可读错误。
- R2 阅读计划：`buildPlan(books, minutesPerDay, days)` 只安排未完成、可用的书；按 priority 高→低、再按 pages 少→多；每天不超过 minutesPerDay；不得重复安排同一本；无法在期限内完成的书写入 `unplanned` 并说明原因。
- R3 本地持久化：`saveLibrary(file, books)` / `loadLibrary(file)` 往返保持数据；文件损坏时抛出明确错误；不得静默丢数据。
- R4 CLI 用户流程：`node src/cli.js plan --minutes 30 --days 7 --file <json>` 输出 JSON `{plan, unplanned, totalMinutes}`；`add`/`list` 命令可用；错误输入 exit=1 且输出可读错误。

## 冻结文件

`tests/**`、`CONTRACT.md`、`package.json` 不得由 Coding Agent 修改。隐藏质量检查位于项目外的验收目录，不告诉 Coding Agent。
