# 任务拆分

## 任务 1：日志行解析

- 实现并导出 `parseLogLine(line)` 与 `parseLog(text)`。
- `parseLogLine`：解析 `2026-01-02T03:04:05Z INFO 消息内容` 格式（时间戳为 ISO 8601，级别取 debug/info/warn/error，大小写不敏感）。返回 `{timestamp, level, message}`；空行、格式错误、非法时间戳返回 null。level 输出小写。
- `parseLog`：按行解析，过滤 null，保持原顺序返回数组。
- 验收测试：`node --testparse.test.js`。

## 任务 2：统计与过滤

- 实现并导出 `summarizeLogs(entries)` 与 `filterByLevel(entries, level)`。
- `summarizeLogs`：返回 `{total, byLevel:{debug,info,warn,error}, firstTimestamp, lastTimestamp}`；byLevel 四个键必须始终存在；空数组时 firstTimestamp/lastTimestamp 为 null，按数组顺序取首/尾时间。
- `filterByLevel`：level 为 'all' 时返回全部条目副本，否则返回指定级别条目。
- 验收测试：`node --testsummarize.test.js`。

## 通用约束

- 不修改 tests/ 与验收约定；不引入第三方依赖。
