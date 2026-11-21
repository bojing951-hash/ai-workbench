# v2.9 Chat-First UI 设计

## 产品定位

普通用户通过自然语言描述产品目标，AI Workbench 组织软件工程；工程细节默认隐藏，但不删除。旧版工程控制台保留在 `/advanced`。

## 信息架构

- **首页**：极简欢迎区 + 单一自然语言输入框 + 三个示例目标；不展示 Project ID/Loop/Fencing/Agent Provider。
- **左侧栏**：新建开发对话、对话、我的项目、最近开发、设置、开发详情。项目只显示自然语言名称与状态；可收起/移动端抽屉。
- **对话**：用户负责目标/边界/验收；AI 用真实模型整理需求草案（名称、目标、可验证验收标准、缺失信息/追问）。确认后“开始开发”。
- **开发进度**：默认只显示用户能懂的状态（规划/编码/测试/独立审计/质量检查/交付）；展开后才显示 Run/Task/Attempt/审计/Token/成本/Git/错误。进度步骤只根据真实 task status/events 标记，不伪造百分比或完成时间。
- **交付**：展示产品名、验证状态、Git commit、质量矩阵、费用；不显示不可用的预览；验收在高级界面完成，不自动合并/部署。
- **高级模式**：`/advanced` 保留全部 Projects/Planner/Runs/Tasks/Agents/Audit/Quality/Supervisor/Git/CI/Fencing/Cost/Budget/Replay/Logs/Pause/Resume/Cancel。

## 视觉

- macOS 系统字体栈，浅/深色 CSS 变量；中性灰 + 低饱和蓝色/薄荷强调。
- 留白、细边框、柔和阴影、克制的磨砂玻璃；无巨型彩色 Dashboard、无满屏统计、无霓虹。
- 输入框 focus ring、轻微卡片上浮、消息淡入；`prefers-reduced-motion` 时关闭动画。
- 响应式断点 1000/760/420px；390px 验证无横向溢出；移动端侧栏抽屉。
- 无障碍：skip link、语义导航、aria-label、role=dialog/status、焦点可见、可键盘操作。

## 真实数据边界

- 对话消息持久化到 SQLite `conversations` / `conversation_messages`。
- 对话模型通过现有 `completeJson`/Provider Key 真实调用；无预置回复冒充 AI。模型不可用显示错误，不伪造。
- 一键启动复用现有 `Orchestrator.createProject` 与 `LoopManager.create`；不新建编排系统。
- 进度来自真实 `/api/conversations/:id`、`/api/loops/:id`、`/api/runs/:id` 数据与事件。
- 旧 UI `/advanced` 作为回退基线保留。
