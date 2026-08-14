# 任务：生成 4 张高保真手机端 App 设计图（PNG）

你是一名顶级移动产品设计美术总监。请**实际生成图片文件**（用你的文生图能力），不要只写描述、不要写代码。
把生成的 PNG 保存到目录：`/Users/fjh/code/harness/mobile/design-mockups/`

## 产品背景
这是一个面向开发者的「AI Agent 任务编排系统」(代号 Harness) 的手机 App。
用户在手机上管理跑在多个 AI agent (codex / claude / antigravity) 上的任务，查看任务状态、
进入任务详情、新建任务、以及参与多 agent 之间的「对话 / 辩论」讨论流。

## 平台与呈现
- Cross-platform premium，偏 iOS 原生质感
- 每张图放进一个**干净的 iPhone 手机框**里，四周留白均匀，阴影柔和；手机框是配角，屏幕内容是主角
- 一张图 = 一个屏幕（不要把 4 屏挤进一张拼贴板）。最终输出 4 个独立 PNG 文件

## 设计系统（4 张图必须严格一致 = design bible）
- 主题：深色优先 (deep dark)
- 背景 `#0F1419`，抬升表面 `#1A1F26`，分割线 `#2A3038`
- 主文字 `#E8EAED`，次文字 `#8A8F96`，浅文字 `#5F646D`
- 状态色：完成=`#10B981`(青绿)，进行中=`#3B82F6`(蓝)，待办=`#F59E0B`(琥珀)，锁定=`#6B7280`(灰)
- 字体：clean grotesk / SF Pro 风格；标题 600 字重，正文 400；字号要够大、易读，绝不要小字
- 圆角：卡片 12px，按钮 10px；间距大气透气 (16/24px)
- 背景加极微弱的 film grain 质感，不能影响可读性
- 图标：自定义感、克制，不要用通用 lucide 默认线性图标那种模板味

## 要生成的 4 个屏幕

### 1) screen-1-task-list.png — 任务列表（首屏）
- 顶部：标题「Tasks」+ 右上角设置图标（安全区下）
- 项目切换条：横向滚动的 pill 标签 `[All] [Frontend] [Backend] [+]`，active 态有清晰高亮
- 按状态分组的任务列表，组头形如「IN PROGRESS · 4」带状态色小圆点
- 任务卡片（约 80px 高，12px 圆角，抬升表面色）：
  左侧彩色状态圆点 + 中间(标题两行内 + 下方 `@codex #auth #security` 浅灰元信息) + 右侧更新时间
  示例任务：「Fix auth middleware」「Design mobile home screen」「Write API docs」「Refactor token store」
- 右下角悬浮 `+` 新建按钮（56px 圆形，品红强调色）
- 首屏要干净、可快速扫读，不要塞满

### 2) screen-2-task-detail.png — 任务详情
- 顶部导航：`< 返回   Task Details   ⋯`
- 大标题区：状态徽章 + 大标题「Fix authentication middleware」，下面 `@codex · updated 2h ago`
- 元数据分组：标签 `#auth #security #backend`；指派的 agent 头像/名
- 描述区：DESCRIPTION 小标题 + 2-3 行说明文字
- 内嵌「对话/活动流」区块（2 条消息气泡，区分 你 vs @codex）
- 底部粘性操作栏：`Edit` / `Start Debate` / `Complete` 三个按钮，Complete 用青绿强调

### 3) screen-3-new-task.png — 新建任务（底部弹出 sheet）
- 表现为从底部升起的 bottom sheet（顶部有抓取条 + 「Create Task」+ ✕）
- 顶部进度「Step 2 of 3」
- 表单分组：
  - Assign To：一组可选 agent（@codex 选中态、@claude、@antigravity）
  - Labels：`auth` / `security` / `backend` 标签编辑
  - Group / Project：下拉选择「Frontend Redesign」
- 底部 `← Back` / `Next →` 按钮
- sheet 后面能隐约看到被压暗的任务列表

### 4) screen-4-debate.png — 对话 / 辩论视图
- 顶部导航：`< 返回   任务标题   ⓘ`，副标题带「🎙 Debate Mode」状态
- 辩手过滤条：`[All Views] [@codex] [@claude]` 快速切换
- 对话气泡流：
  - 你（右对齐或带头像）：「让我们从数据库架构开始讨论」
  - @codex：「同意。我建议采用分片策略…」
  - @claude 的嵌套回复（缩进 + 左侧竖条）：「分片可能过度设计，建议先读写分离」
  - 你 @ 多人：「@claude @codex 能否做个对比表？」
  - 不同 agent 用不同的细微强调色区分
- 底部输入区（粘性，安全区内）：`@ 选择对象` + 输入框 + 发送按钮

## 质量要求
- 4 张图必须像同一个 App（统一配色/字体/卡片/手机框/间距）
- 文字必须清晰可读，不要小字、不要 lorem ipsum
- 不要 website-in-a-phone，不要 box-in-box 层层套卡
- 不要紫蓝渐变、不要玻璃拟态泛滥、不要假图表
- 深色高级感、克制、专业

完成后，请用一句话列出你生成的 4 个 PNG 文件的绝对路径。
