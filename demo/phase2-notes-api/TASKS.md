# 任务拆分与验收标准

本文件是产品需求的权威来源。规划器必须按下列顺序生成 3 个任务，不得新增或合并任务。

## 任务 1：服务骨架与健康检查

- 在 `src/server.js` 中实现 `createServer()` 与 `startServer(port)`（导出名固定）。
- `startServer(0)` 返回 `{ server, port, url, close }`，监听随机空闲端口；`close()` 返回 Promise。
- `GET /health` 返回 200，JSON `{"status":"ok","service":"notes-api"}`。
- 未知路径返回 404，JSON `{"error":"not_found"}`。
- 响应头 `content-type` 必须包含 `application/json`。
- 验收测试：`node --testhealth.test.js`。

## 任务 2：笔记 CRUD（依赖任务 1）

- `POST /notes`：请求体 `{title, body}`。title 必须为非空字符串，否则 400 `{"error":"invalid_title"}`；成功 201，返回 `{id, title, body, createdAt}`，body 缺省为 `""`，id 唯一，createdAt 为合法时间。
- `GET /notes`：200，返回全部笔记数组（按创建顺序）。
- `GET /notes/:id`：存在返回 200 笔记，否则 404 `{"error":"not_found"}`。
- `DELETE /notes/:id`：存在返回 204 空响应并删除，否则 404。
- 数据存储在内存，每个服务实例独立。
- 验收测试：`node --testnotes.test.js`。

## 任务 3：搜索（依赖任务 2）

- `GET /notes?q=<关键字>`：对 title 与 body 做大小写不敏感的子串匹配，按创建顺序返回匹配数组；空 q 返回全部。
- 无匹配返回 `[]`。
- 验收测试：`node --testsearch.test.js`。

## 通用约束

- 不得修改 `tests/`、`TASKS.md`、`README.md` 中的验收约定。
- 不引入第三方依赖。
- 每个任务完成后，其验收测试必须通过。
