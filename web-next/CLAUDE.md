# web-next/CLAUDE.md

改 `web-next/` 下的代码时要知道的约定。跨执行器的通用规则在根 `AGENTS.md`。

> 这个文件是目录级实现说明；必须挡住的约束应优先做进类型、检查脚本或测试。`scripts/check-conventions.mjs` 挂在 `npm -w web-next run build` 前置。
>
> **往这个文件里加规则要先经用户同意**（根 `AGENTS.md`「加规则要先经用户同意」）。想加就先在回复里问，同意了再落盘；删和搬不受限。

## 弹层与提示

- 禁用浏览器原生 `window.confirm / prompt / alert`。确认动作复用 `src/task-detail/ConfirmDialog.tsx`，其它弹层沿用现有应用内组件，反馈走页面的 `notify`。
- 不新增原生 `title` 提示；优先使用可见文本、`aria-label` 或应用内提示组件。检查脚本按现有存量做棘轮约束。
- 可关闭的菜单、浮层统一复用 `src/lib/useDismissable.ts`，确保点外部、Esc 和焦点恢复语义一致。浮层套浮层由它按打开顺序自己处理（点里层不算点外面、Esc 一次只关最上面那层），别在外层另加特判。

## 主工作区

- 新建任务是主工作区内嵌状态，入口统一走 `WorkspaceShell` 的 `openComposer`，不要另造一套弹窗式 composer。提交门禁必须同时落在按钮和实际提交函数里，避免快捷键绕过。
- 随手记按创建时项目归属，转任务后保留历史回链；创建与回链分别失败时要如实提示，不能因回链失败回滚已创建任务。
- 普通任务回复框里的 `/team` / `/duet` 是派生命令，命令文本不得进入当前 agent 会话；配置卡与主 composer 共用执行器选择规则。
- 长会话贴底统一走 `src/lib/useStickToBottom.ts`（由 `ConversationScrollControls` 接入）。用户主动向上阅读后不能被新消息强拽到底，切换任务时必须重置。

## 团队与执行器

- 团队“收工”判据只用 shared 的 `isTeamSettled`；收工与被停止是两件事，分别决定时间轴收口和“恢复全组”入口。
- 执行器候选与可运行判据统一来自 `src/lib/agentAvailability.ts`。已注册 profile、本机探测和 resident 能力是三类独立信息，不能互相代替。
- 换执行器时模型与智能水平重置为“跟随执行器”。创建面走 `src/composer/executorOverrides.ts`，存量任务走对话框底部的 `src/task-detail/ReplyBox.tsx`，预设走 `src/settings/TeamPresetEditor.tsx`；一致性判断复用 shared 的 `sameExecutor`。
- 每一处“选谁干活”都是 `components/RunTargetPicker.tsx` 的**一颗三段胶囊——智能体 · 模型 · 智能水平**（模型撑不起已选档位时由第三段提示，不静默改）。三段可各自打开；顺着配置时，选定前一段默认向右打开后一段（智能体→模型→智能水平）。点回同一个智能体不算改动，不清模型。表面统一经 `composer/ExecutorPickerField.tsx` 接入——新建/派生面板、模式预设、duet、派审、工作流站点（`workflow/StepEditors.tsx`）都用它；工作流的“跟随任务执行器”走 `unsetText`/`onUnset`。对话框底部用同组件的 `variant="chip"`。别另起下拉或给同一份 model/effort 开第二个入口；`TaskInspector` 只读展示 `executorRunSummary` 算出的生效值。
- 用户可见文案里“思考强度”一律叫**智能水平**；内部字段名仍是 `reasoningEffort`/`effort`，不要跟着改。
