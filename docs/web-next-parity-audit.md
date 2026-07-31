# web-next 新旧版功能对齐审计

审计日期：2026-07-31

审计基线：`c3d37d3`（`web/src` 对 `web-next/src`）

修复进度：P1-1、P1-2、P1-3、P1-5、P1-6、P1-7 已于 2026-07-31 修复；下方保留审计时的缺口描述，并在对应条目标记结果。

结论（审计基线）：没有发现 P0，共识别 **25 个旧版能力缺失或退化点**：P1 10 个、P2 11 个、P3 4 个。普通任务回复框的 `/team`、`/debate` 派生命令在审计期间由另一执行者修复并提交，本报告将它记入“已确认对齐”，不重复实施；后续修复进度见上方说明和条目标记。

## 口径与方法

- 从 `web/src` 的顶层组件和子目录逐个映射到 `web-next/src` 的 `task-detail/`、`workspace/`、`overlays/`、`debate/`、`team/`、`composer/`、`settings/`、`review/`。
- 对入口类能力额外比对：斜杠命令、命令面板、菜单、快捷键、拖拽、粘贴附件、任务派生、队列、分组、停止/暂停、辩论接力、审查、归档和设置。
- 不把“新版 API client 里有方法”视为完成；必须存在可达 UI 和正确调用语义。
- 用 `git log -S` 和 web-next 历史判断来源。除特别标注外，下列缺口在 web-next 历史中都没有出现过完整 UI；不是“有证据的有意砍掉”。
- 审计开始时 `/team`、`/debate` 仍在修；审计过程中 `c3d37d3 feat(web-next): add task derivation commands` 已把命令菜单、配置卡和来源上下文接入当前分支，因此不再计入未解决总数。

严重度口径：P0 阻断基本使用；P1 影响主要工作流或正确性；P2 有替代路径但能力不完整；P3 低频效率或可发现性退化。

## P1：主要工作流或正确性缺口（审计识别 10，已修 6）

### 1. 执行器候选缺少“已安装/已注册/可常驻”能力校验（已修）

- 旧版位置：`web/src/useDetectedAgents.ts:13-22,71-99` 只允许本机可用类型或显式注册 Profile；`web/src/teamExecutorDefaults.ts:14-56` 进一步限制团队调度者必须支持 resident session；`web/src/TaskComposer.tsx:285-300` 在真正提交函数里统一拦截不可运行角色。
- 审计时新版现状：**半残**。`web-next/src/composer/ComposerFields.tsx:52-59`、`web-next/src/task-detail/TaskInspector.tsx:174-175` 和 `web-next/src/debate/DebateHandoff.tsx:41-43` 都直接列出全部 `AGENT_TYPES`；`web-next/src/composer/TaskComposerPanel.tsx:217-220` 的 `canSubmit` 只检查正文和 busy。用户可创建本机必然跑失败的任务，或把不支持常驻会话的类型选成团队调度者。
- 历史判断：旧版注释记录这套约束曾被多轮审查抓出真实故障；web-next 的数据层已有 `detectAgents()` 和 `resident` 字段（`web-next/src/lib/api.ts:345-348`），但主 composer、Inspector、辩论接力没有消费。
- 修复入手点：把旧版 detection/pickable/resident 逻辑抽到 shared 或 web-next lib；所有执行器选择器共用同一候选生成和提交门禁，探测失败与“确实一个都没装”必须区分。
- 修复结果：新增 `web-next/src/lib/agentAvailability.ts` 统一缓存探测、生成本机可用类型/显式 Profile/resident 调度者候选，并接入主 Composer、任务 Inspector、派生任务 Composer 和辩论接力。探测中显示进度，探测失败降级为提示但不按“未安装”拦截，确认零 CLI 且零 Profile 时显示空态并统一拦截按钮与提交函数。

### 2. 已有任务/辩论不能新增、修改、清除调度，也不能手动触发 Cron（已修）

- 旧版位置：`web/src/ScheduleControl.tsx:30-93` 支持无定时、单次、Cron、清除和“立即触发”；`web/src/TaskDetail.tsx:429` 与 `web/src/DebateView.tsx:321` 都接入。
- 新版现状：**半残**。`web-next/src/task-detail/TaskInspector.tsx:219-226` 只读展示调度并跳旧版，辩论页完全没有入口。API wrapper 已存在 `schedule/setSchedule/clearSchedule`（`web-next/src/lib/api.ts:378-385`）和 `fireTask`（`web-next/src/lib/api.ts:272-273`），但 UI 无调用。
- 历史判断：`f363b93 feat(web-next): 单任务详情页` 只迁入读取；没有后续编辑提交。
- 修复入手点：迁移 `ScheduleControl` 为 web-next 组件，在普通任务 Inspector 和辩论配置卡复用；Cron 保留“全新一轮、非续跑”的 `fireTask` 语义。
- 修复结果：新增共享 `web-next/src/components/ScheduleControl.tsx`，支持读取、设置一次性/Cron、清除、重新启用已执行的一次性定时，并接入普通任务 Inspector 与辩论配置卡；Cron 的“立即触发”直接调用 `fireTask`，提示其为不接续旧会话的全新一轮。

### 3. 新建任务时不能选择“一次性/Cron 定时启动”（已修）

- 旧版位置：`web/src/composer/modes.tsx:14-21` 定义四种启动方式；`web/src/composer/ComposerFooter.tsx:38-82` 展示时间/Cron 字段；`web/src/TaskComposer.tsx:358-362` 创建后写入 schedule。
- 新版现状：**缺失**。`web-next/src/composer/TaskComposerPanel.tsx:414-425` 只有“仅创建 / 创建并运行”。
- 历史判断：旧版 `f8b22ac` 已实现；`4feb578` 的 web-next composer 没有迁入，`docs/web-next-gaps.md` 也曾明确列为存量。
- 修复入手点：在 composer footer 引入 launch mode；创建成功后按 `run / once / cron / create` 分流，定时模式不得先调用 `runTask`。
- 修复结果：Composer footer 新增“创建并运行 / 仅创建 / 一次性定时 / 循环 Cron”四档启动方式和对应字段，Cmd/Ctrl+Enter 服从当前选择；创建完成后严格分流，`once`/`cron` 只调用 `setSchedule`，不会先启动任务。

### 4. 手动派独立审查/补派下一轮审查没有 UI

- 旧版位置：`web/src/TaskReviewPanel.tsx:183-216` 检查在途轮次、可用审查执行器，并调用 `api.dispatchTaskReview`。
- 新版现状：**入口未接线**。`web-next/src/team/ReviewEvidence.tsx:75-83` 只能查看已有记录或空态；`web-next/src/task-detail/TaskInspector.tsx:229-236` 也只读摘要。API 已有 `dispatchTaskReview`（`web-next/src/lib/api.ts:301-305`），全树无 UI 调用。
- 历史判断：旧版 `c9f1e55 feat(web): add independent task review UI`；web-next 从未迁入。
- 修复入手点：在单任务详情和 `TaskReviewWorkspace` 的空态/失败态加入审查派发器，复用 composer 的 Profile、模型、思考强度选择，并禁止重复在途轮次。

### 5. 队列中的 failed/canceled 任务不能“重新排队” ✅ 已修

- 旧版位置：`web/src/TaskDetail.tsx:253-268` 提供专用“重新排队”按钮，调用 `requeueTask`，保证被队列越过后移动到队尾。
- 新版现状：**缺失且有语义风险**。`web-next/src/task-detail/TaskHeader.tsx:31-34` 把 failed 映射为立即 retry、canceled 映射为 run；没有回队列等待的动作。API wrapper 已有 `requeueTask`（`web-next/src/lib/api.ts:270-271`），但无 UI 调用。
- 历史判断：旧版 `9ecd78e` 专门修过“串行队列同一时刻至多一个成员在跑”；直接 retry/run 不能替代 requeue。
- 修复入手点：在任务 header/Inspector 和命令面板加入“重新排队”，只对顶层、未归档、在队列中的 failed/canceled 任务显示；成功后使用响应中的最新位置刷新任务。
- 修复结果：任务 Header 与命令面板已增加独立“重新排队”入口，保留原有立即 retry/run；两处均直接使用 `requeueTask` 响应刷新任务。

### 6. paused 任务的续跑指令只能看，不能编辑或清空 ✅ 已修

- 旧版位置：`web/src/TaskDetail.tsx:344-352` 在 paused 且非提问状态显示 `ResumePromptEditor`，允许修正或清空下次唤醒指令。
- 新版现状：**半残**。`web-next/src/task-detail/TaskInspector.tsx:219-225` 只把 `resumePrompt` 放进只读 `<pre>`。
- 历史判断：web-next `f363b93` 读取了字段，但没迁编辑；旧版检查点功能由 `541478f`/`749db47` 建立。
- 修复入手点：在 Inspector 的“调度与续跑”节加入编辑/保存/清空，调用 `patchTask({ resumePrompt })`；团队执行者继续只读。
- 修复结果：Inspector 已支持添加、编辑、保存和清空续跑指令；仅 paused 且非提问的顶层任务可写，团队执行者保持只读。

### 7. 团队验收台没有完整文件列表和逐行 diff ✅ 已修

- 旧版位置：`web/src/ReviewWorkspace.tsx:582-650` 展示全部文件、截断提示和逐文件文本 diff。
- 新版现状：**半残**。`web-next/src/team/TeamReviewWorkspace.tsx:153-175` 只列前 6 个提交和前 8 个文件，明确提示回旧版；没有逐行 diff。单任务 `TaskReviewWorkspace` 已有完整 diff 组件，说明不是数据层限制。
- 历史判断：`988390b` 迁入团队验收时只做摘要，之后未补齐；旧的 `docs/web-next-gaps.md` 也已记录。
- 修复入手点：复用/抽取 `web-next/src/review/TaskReviewWorkspace.tsx:29-238` 的文件 rail、分段解析和渐进加载，在团队每个 `ReviewRecord` 中展示完整 diff。
- 修复结果：文件 rail、逐行 diff、截断提示与渐进加载已抽为共享组件；团队每条验收记录现在展示全部提交和完整文件清单，可逐文件查看带行号的文本 diff，不再要求回旧版。

### 8. 辩论 → 团队 → 再辩论闭环退化，且不能从同一辩论再开一组

- 旧版位置：`web/src/DebateTeamHandoff.tsx:141-177` 在团队收工后提供“再辩一轮”；`web/src/DebateTeamHandoff.tsx:209-243` 允许已有团队后“再开一组”；`web/src/team/TeamHeader.tsx:130-140` 也从团队页暴露“再辩一轮”。
- 新版现状：**半残**。`web-next/src/debate/DebateHandoff.tsx:95-108` 一旦找到一个关联团队就只显示该团队卡片，不再允许创建第二组；`web-next/src/team/TeamHeader.tsx:128-151` 没有再辩入口。API wrapper 已有 `iterateTeamDebate`（`web-next/src/lib/api.ts:294-295`）但全树无调用。
- 历史判断：旧版 `3bcdb21 feat: close debate team iteration loop`；web-next 从未迁入。
- 修复入手点：DebateHandoffBar 支持“关联团队列表 + 再开一组”；TeamHeader 和关联团队卡按 settled/origin/iteration 条件调用 `iterateTeamDebate`，防重复创建并跳转到已有迭代任务。

### 9. 执行者提问缺少置顶提醒和“让调度者答”

- 旧版位置：`web/src/team/TeamHeader.tsx:389-431` 把等待答复固定在流上方、显示等待时长/数量，并提供“我来答 / 让调度者答”；`web/src/team/TeamView.tsx:183-190` 把问题转交调度台调查后调用 `answer_question`。
- 新版现状：**半残**。`web-next/src/team/TeamFeed.tsx:63-77` 和 `web-next/src/team/WorkerRail.tsx:47-61` 能看到问题并“我来答”，但没有固定 AttentionBar，也没有转交调度者动作。长团队流中提醒可滚走，且用户必须亲自回答本可由调度者调查的问题。
- 历史判断：不是服务端限制；旧版转交只复用 `replyTask`。
- 修复入手点：在 `TeamView` 恢复 waiting 聚合和固定提醒条；新增转交按钮，向 lead 会话发送带 worker taskId 和问题原文的系统化插话。

### 10. LLM 供应商/API Key/协议/base URL/模型探测与 Profile 绑定完全依赖旧版

- 旧版位置：`web/src/Relays.tsx:10-22,64-139,142-223` 管理供应商增删改、Key、协议、地址和模型探测；`web/src/AgentsPanel.tsx:355-365` 把供应商绑定到执行器 Profile。
- 新版现状：**缺失**。`web-next/src/settings/AgentsSettings.tsx:18-90` 只编辑静态模型/强度/速度；`web-next/src/settings/AgentsSettings.tsx:192` 明文声明供应商和 API Key 由旧版承接。相关 API wrapper 在 `web-next/src/lib/api.ts:391-410` 已齐全但无 UI 调用。
- 历史判断：这是明确的“尚未迁移存量”，不是有意砍掉。
- 修复入手点：在 Settings 增加 Providers 分节或 Agents 子节，迁移 Relay CRUD、模型探测和 Profile 的 providerId；模型选择器应按 provider 返回全名模型，而不是只用静态 preset。

## P2：有替代路径，但能力明显不完整（11）

### 11. 回复不能定时发送，也不能查看/取消待发消息

- 旧版位置：`web/src/ReplyBox.tsx:75-79,134-169,205-251` 加载待发消息、选择发送时间、持久化和取消。
- 新版现状：**缺失**。普通任务 `web-next/src/task-detail/ReplyBox.tsx:15-80` 和团队 `web-next/src/team/TeamView.tsx:23-75` 只有立即发送。API wrapper 已有 `scheduledMessages/cancelScheduledMessage`（`web-next/src/lib/api.ts:386-389`），但无 UI 调用。
- 修复入手点：抽成普通/团队回复框共享的 scheduled-message tray；发送时透传 `sendAt`，待发消息按时间排序并可取消。

### 12. 普通任务回复不能 `@` 召唤另一个智能体进入同一任务

- 旧版位置：`web/src/ReplyBox.tsx:65-112,190-203` 探测可用 CLI，提供 `@` 候选，并把选中的 agent 传给 reply API。
- 新版现状：**缺失**。`web-next/src/task-detail/ReplyBox.tsx:13-23,82-103` 的发送协议只接收 text 和 attachments，不传 `agent`。
- 修复入手点：在普通任务 ReplyBox 加 mention token、键盘选择和目标 chip；候选必须复用“已安装类型”检测，不得列出必然失败的类型。团队调度台继续禁用 mention。

### 13. 删除任务后的 Git 清理失败不能二次确认强制清理

- 旧版位置：`web/src/DeleteTaskModal.tsx:70-145` 在任务已删但 worktree/分支残留时展示真实 git stderr，并提供显式 `--force / -D` 第二步。
- 新版现状：**半残**。`web-next/src/task-detail/DeleteTaskDialog.tsx:34-72` 只在首次删除时请求普通清理；失败后 toast，并提示回旧版，没有 `discardTaskWorkspace(force)` 调用。
- 修复入手点：保留对话框进入“任务已删除、Git 残留”第二幕；逐项显示剩余 path/branch 和 stderr，用户再次显式确认后调用 `discardTaskWorkspace(..., force: true)`。

### 14. 来源任务看不到自己派生出去的所有团队/辩论

- 旧版位置：`web/src/DerivedTaskLinks.tsx:15-46` 在来源任务下方列出全部派生团队/辩论及实时状态。
- 新版现状：**缺失一半方向**。`web-next/src/components/TaskOrigin.tsx:18-26,97-115` 只支持派生任务回看来源/所属团队；普通来源任务没有“向外”的派生清单。辩论页也只取最新关联团队。
- 修复入手点：迁移 `DerivedTaskLinks` 到普通任务详情；辩论接力区改成关联团队列表而不是单个 `linkedTeam`。

### 15. 新建任务不能在创建时设置 labels

- 旧版位置：`web/src/TaskComposer.tsx:73,347-348,614-621` 维护标签并直接写入 create payload。
- 新版现状：**缺失**。`web-next/src/composer/TaskComposerPanel.tsx:86-102,227-233` 只有 priority/group 等 state 和 common payload，没有 labels；创建后只能去 Inspector 补填。
- 修复入手点：在 composer 的任务选项加入与 Inspector 共用的标签编辑器，payload 写 `labels`，连续创建时清空。

### 16. 随手记失去 800ms 自动保存和失焦 Markdown 预览

- 旧版位置：`web/src/NotesModal.tsx:175-188` 变更后 800ms 自动保存并在卸载前 flush；`web/src/NotesModal.tsx:430-475` 失焦后用 Markdown 阅读态展示。
- 新版现状：**行为退化**。`web-next/src/overlays/NotesPanel.tsx:64-95` 只在显式保存、切换或关闭时保存；`web-next/src/overlays/NotesPanel.tsx:170-178` 始终是 textarea。崩溃/刷新前的编辑更容易丢，长笔记阅读性下降。
- 历史判断：`60ab85c` 只补回批量转任务；没有恢复自动保存和预览。
- 修复入手点：迁移串行 flush/save-in-flight 逻辑，避免竞态；保留显式保存按钮作状态反馈，正文失焦时切到 `MarkdownBody`，点击再编辑。

### 17. Markdown 的本地打开、审查报告链接和软换行只迁了一部分

- 旧版位置：`web/src/Markdown.tsx:9-49` 识别审查文件和 `/api/open-local`；`web/src/Markdown.tsx:51-74` 把聊天文本单换行保留下来；`web/src/Markdown.tsx:76-123,146-169` 在站内弹层打开审查 Markdown，并把 open-local 请求重写到当前 origin。
- 新版现状：**半残回归**。`web-next/src/components/MarkdownBody.tsx:9-26` 只有 GFM、图片预览和一律 `target=_blank` 的链接；tailnet 页面上的 localhost open-local 链接、审查 Markdown 弹层和软换行语义均丢失。
- 历史判断：`e71e35a fix(web-next): restore markdown and conversation metadata` 名义上“恢复 Markdown”，但实现没有迁入上述处理器；旧版 open-local 还经过 `d259672` 的 tailnet 修复。
- 修复入手点：把 review-file target、open-local current-origin rewrite 和 soft-break plugin 抽成共享 Markdown policy，供会话、辩论、审查报告、随手记统一使用。

### 18. 全局 `j/k/↑/↓` 导航、`c` 新建、`r` 运行快捷键缺失

- 旧版位置：`web/src/App.tsx:434-464` 在非输入控件/非弹层状态处理任务导航、新建和主动作；命令面板仍由 Cmd/Ctrl+K 独立处理。
- 新版现状：**缺失**。`web-next/src/workspace/WorkspaceShell.tsx:109-115` 只有 Cmd/Ctrl+K；界面仍在空态提示“按 C 新建”的旧习惯，但实际没有全局 C 监听。
- 修复入手点：基于 `orderedTopLevelTasks`/当前可见树建立统一快捷键 hook，尊重输入控件、弹层和 composer；`r` 必须复用页面主动作判据，不能绕过状态限制。快捷键提示按平台显示 Cmd 或 Ctrl。

### 19. 项目切换器缺少直接“新建项目”，快速创建也没有路径健康检查

- 旧版位置：`web/src/ProjectRail.tsx:99-109` 在切换器 footer 直接新建；`web/src/Modal.tsx:155-187` 输入目录时实时显示 `PathHealth`。
- 新版现状：**入口退化**。`web-next/src/workspace/ProjectSwitcher.tsx:67-134` 只有设置、搜索和切换；必须走命令面板。`web-next/src/overlays/CreateEntityDialog.tsx:18-22` 只收 name/path，不调用 `checkPath`。
- 修复入手点：给 ProjectSwitcher 增加 footer action；CreateProjectDialog 复用 `ProjectSettingsPanel` 的 debounced `api.checkPath`，把不存在/非 Git/脏工作区状态在提交前显示清楚。

### 20. 执行器 Profile 不能设置额外 CLI 参数

- 旧版位置：`web/src/AgentsPanel.tsx:383-411` 编辑已有 `extraArgs`；`web/src/AgentsPanel.tsx:418-500` 新增 Profile 时同时设置参数。
- 新版现状：**缺失**。`web-next/src/settings/AgentsSettings.tsx:18-90,94-133` 只支持名称、target、model、reasoning、speed；无法读写 `extraArgs`。
- 修复入手点：加入 shell-like 参数编辑器；至少保证空格分隔行为与旧版一致，更稳妥可提供逐项 token 输入，避免引号被错误拆分。

### 21. 任务树缺少暂停阻塞原因和多项任务元数据

- 旧版位置：`web/src/TaskList.tsx:235-278` 行内显示 priority、worktree、queue position、group、labels、来源；`web/src/ui.tsx:554-613` 对 paused 任务显示“在等谁”，可跳到首个阻塞任务。
- 新版现状：**信息退化**。`web-next/src/workspace/TaskTree.tsx:114-139` 顶层行主要只有状态、置顶、模式和标题；没有暂停依赖、优先级、标签、分组、worktree、队列位置。选中任务后 Inspector 能看一部分，但无法横向扫列表。
- 修复入手点：先恢复高价值且低噪声的 paused blocker 和 queue position；其余元数据做 hover/次行或可配置密度，避免把新版窄树挤爆。

## P3：低频效率与可发现性退化（4）

### 22. Composer 不能“再建一个”，分组选择器也不能就地新建

- 旧版位置：`web/src/composer/ComposerFooter.tsx:50-61` 提供“再建一个”；`web/src/TaskComposer.tsx:363-370` 创建后清空并继续；`web/src/TaskComposer.tsx:614` 的分组下拉含“+ 新建分组”。
- 新版现状：**缺失**。`web-next/src/composer/ComposerFields.tsx:305-314` 只列现有分组；`web-next/src/composer/TaskComposerPanel.tsx:289-300,414-425` 创建后总是离开 composer。
- 修复入手点：footer 加 keep-open toggle；group select 增加 sentinel 或旁边的 plus，创建成功后刷新 groups 并选中新组。

### 23. 当前项目的 branch/dirty/worktree 上下文不再常显

- 旧版位置：`web/src/ui.tsx:291-310` 的 `BranchChip` 显示分支、dirty 点和 linked-worktree 标签；`web/src/TasksWorkspace.tsx:102-104` 常驻顶部。
- 新版现状：**入口退化**。主工作区没有等价组件；只有进入 `web-next/src/settings/ProjectSettingsPanel.tsx:47-52` 才能看到健康状态。
- 修复入手点：在 workspace app bar 或项目切换器 trigger 增加紧凑 Git context，复用项目 health，并在任务运行结算后刷新。

### 24. 任务树宽度不能拖动并持久化

- 旧版位置：`web/src/App.tsx:72-80` 持久化 220–560px 宽度；`web/src/ui.tsx:620-668` 支持拖动与双击重置。
- 新版现状：**缺失**。`web-next/src/styles/workspace.css:11-24` 把侧栏固定为 260px/54px，仅支持整体折叠。
- 修复入手点：给 WorkspaceSidebar 右缘加 separator handle，CSS 变量驱动宽度并写 localStorage；保留现有折叠动画。

### 25. 团队页缺少直接删除入口

- 旧版位置：`web/src/team/TeamHeader.tsx:238-245` 团队 header 直接提供删除。
- 新版现状：**入口半残**。`web-next/src/team/TeamHeader.tsx:141-152` 的更多菜单只有复制、下载、旧版和归档；删除只能从 Cmd+K 当前任务命令进入。
- 修复入手点：TeamHeader 增加危险菜单项，TeamView 复用 `DeleteTaskDialog`，删除成功后走 `onTaskDeleted`。

## 已确认对齐，不列为缺口

- **Command Palette 命令清单**：两版 `/scope`、`/git` 注册表一致；新版覆盖当前任务动作、新建任务/辩论/随手记/分组/项目、设置、项目切换、分组运行、跨项目搜索，并额外展示进行中任务和父任务跳转。对应 `web/src/App.tsx:470-511`、`web-next/src/overlays/CommandPalette.tsx:157-261`。
- **普通任务 `/team`、`/debate` 派生**：审计开始时仍在修；`c3d37d3` 已把命令菜单、实时/定稿配置卡、来源会话上下文、worktree 继承和创建跳转接进 `web-next/src/task-detail/ReplyBox.tsx:57-190`、`web-next/src/task-detail/TaskDetail.tsx:165-203`。
- **队列抽屉拖拽排序/移出队列**：旧版 `QueueModal` 与新版 `QueueDrawer` 都锁定 running/queued 和调度者管理队列，调用 reorder/remove；缺的只有上文“重新排队”。
- **附件**：普通任务、团队插话、composer、随手记都支持文件选择、粘贴上传、预览和移除；新版近期提交 `e700cd2`/`d08ca5d` 还统一了图片预览顺序。
- **团队停止/恢复与 CUA 残留**：新版已持久显示停止状态，恢复内部组和 lead，并只在用户显式确认后强制清理 computer-use；符合根 AGENTS 约束。
- **归档/取回**：任务、团队、辩论和设置中的归档列表均可用；新版 ArchiveSettings 只列顶层任务与旧版 `TaskList.topLevel` 语义一致。
- **辩论核心闸门**：A/B 轮次、G1 放行/打回、注入意见、定向提问、首次接力成团、来源返回和调度均已接通；缺的是上文“多团队/再辩一轮”。
- **多问题答复**：单问题、多问题、建议答案追加、部分答复和 Cmd/Ctrl+Enter 提交语义已对齐。
- **团队预设**：新版本已在 `7b16ba2` 补回团队执行模式 preset 的新建、套用、更新、改名和删除；执行器可用性仍受 P1-1 影响。
- **随手记批量转任务**：`60ab85c` 已补回复选多条、按列表顺序合并正文、合并附件和逐条回链。
- **任务来源返回**：`c488a83` 已补回来源普通任务/辩论和所属团队的显式跳转；缺的是反向派生清单。
- **任务置顶、分组折叠、未读/状态指示、会话上下滚动按钮、会话元数据**：均有对应补回提交，不再列缺口。
- **项目/分组/归档/Profile 基础设置**：项目改名/目录/删除，分组增删改/并串行/运行暂停，Profile 增删/默认/model/reasoning/speed/SSH target 均已对齐；高级 provider 与 extraArgs 见 P1-10、P2-20。

## 历史分类与取舍

- **尚未迁移的存量**：定时回复、@召唤、手动审查、辩论迭代、Providers、extraArgs、全局快捷键、侧栏 resize。
- **迁移了但半残**：Markdown（`e71e35a`）、辩论接力（`6b33716`）、随手记（`60ab85c`）。
- **审计期间修复完成**：普通任务 `/team`、`/debate` 派生命令由并行执行者提交为 `c3d37d3`；本报告没有修改其代码。
- **有意变化但不算缺口**：新版三栏布局、团队时间轴默认折叠、执行者放右 rail；`0eef687` 有意回退的是“新版新增的置顶执行者分区”，旧版本身没有独立的置顶执行者分区，因此不计 parity 缺口。
- 没有找到证据表明本报告 25 项中的任何一项是产品决定永久砍掉；新版设置页对 provider/API Key 的文案反而明确说明是旧版暂时承接。

## 建议修复顺序

1. 先收口正确性：执行器能力校验、重新排队、resumePrompt 编辑、完整团队 diff。
2. 接着补主流程：完成正在修的派生命令、调度管理/创建时调度、手动审查、辩论闭环、执行者问题转交。
3. 再迁设置与回复增强：Providers、extraArgs、定时回复、@召唤。
4. 最后补效率与可见性：快捷键、任务树元数据、项目入口/Git context、连续创建和 resize。
