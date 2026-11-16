# 独立只读审查记录（v29-reviewer）

审查者：`v29-reviewer`，只读子代理；未修改文件，未重启生产 Workbench，未触碰产品仓库。

## 首轮确认

- 无 P0（无认证绕过/XSS/密钥泄露/数据丢失路径）。
- 5 个 P1：
  1. 曾有手工 seed 的“完成”对话，截图把它当真实模型/真实完成证据；
  2. 旧 `03-conversation` 截图显示伪造进度（步骤全 ✓），与真实 blocked 状态矛盾；
  3. “我的项目”导航不切换主面板，05 截图标注错误；
  4. Chat 启动非崩溃安全：先写 starting/project_id，失败可能留下孤儿项目并重试重复建项目；
  5. plan 模式恢复出的 pending 任务不会被消费。
- P2：聊天项目 testCommand=true/无质量配置但完成卡显示质量✓；paused 对话轮询不停；最新消息重复送模型；canned fallback；run_id 过期；quality-gate duplicate history 分支；文档测试数不一致。

## 整改

1. 删除手工 seed 的完成对话和依赖截图；完成截图改为真实 CDL 项目状态对话 + 真实 DB run/Git/quality。
2. 删除旧伪进度截图；`stepsFor` 改为按真实 task/events rank，blocked 只标实际完成阶段；重新截图。
3. `setView('projects')` 调用 `showWelcome`，主面板隐藏对话；项目页截图重拍。
4. 启动流程：不再先写 starting；`startDevelopment` 在建项目后先持久化 project_id；嵌套独立 `git init`（避免落到 Workbench 父仓库）；新增失效 Loop 后重试复用同项目测试。
5. plan 模式存在队列任务时也消费（含恢复 pending）；补相应条件。
6. 同时修：最新消息不从 history 重复送模型；无有效模型回复时报错而非 canned fallback；paused/blocked 停止轮询；conversation run id 回退到项目最新真实 run。

## 复审

见本轮最终复审结论；如未完成，不将开发者自评当作独立复审。

## 证据状态

- 测试：266/266（本地全量）。
- 截图：真实欢迎/对话/真实项目完成/真实预算阻塞/项目页/设置/移动端/高级。
- **未捕获实时“自动修复中”**：新一键项目在 Coding 前被预算阻断，没有授权的 active repair run；没有伪造截图。

## 复审（第二遍，只读）

**结论：无剩余确认 P0/P1。**

复审确认：
- 手工 seed 对话已从 DB 删除；依赖截图已移除；完成截图现在来自真实 DeepSeek 对话 + 真实 DB run（runContext=project_latest，UI 会标注“项目最近一次运行”，不冒充本对话启动）。
- 伪进度截图已删除；step rank 基于真实 task/events；04-blocked 正确显示规划完成/编码未执行。
- 我的项目导航已切主面板并重新截图。
- Chat 启动嵌套独立 Git，project 关联先持久化，失败重试复用；新增 Loop 创建失败后复用/接管测试。
- plan 模式恢复任务可消费，已加测试。
- paused/failed polling 停止、重复最新消息、canned fallback、run id 回退等已修复。

剩余 P2（未阻塞）：
- 质量完成卡对没有 quality config 的聊天项目仍可能显示质量步骤 ✓；真实新项目 E2E 被预算阻塞，未实现交付。
- chat start 崩溃窗口仍非完全事务化（项目创建与 commit 之间）；
- 自动修复中实时截图缺失（无授权 active run）；
- 全部写路径 fencing、24h、真实新 E2E 仍 UNKNOWN/BLOCKED。
