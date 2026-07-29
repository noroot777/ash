# web/CLAUDE.md

改 `web/` 下的代码时要知道的约定。跨执行器的通用规则在根 `AGENTS.md`。

> 注意：这个文件是**懒加载**的——2026-07-29 实测，agent 开场时不会拿到它，第一次接触 `web/` 子树的文件之后才被注入。所以凡是「必须挡住」的规则都在系统层另有兜底（`scripts/check-conventions.mjs` 挂在 build 前置），这里承载的是「改这块代码时要知道」的说明。

## 弹层与提示

- 前端禁用浏览器原生弹窗：确认对话框用 `ConfirmModal`、其它弹层用 `Modal`（均在 `web/src/Modal.tsx`），报错/提示用 `toast`（`web/src/toast.tsx`）。不要用 `window.confirm / prompt / alert`——它们样式不一致、阻塞且无法做成应用风格。**这条有闸**：`scripts/check-conventions.mjs` 在 `npm -w web run build` 前置里硬拦（基线 0）。
- 悬浮提示同理不用原生 `title`，用 `Tip`（`web/src/Tip.tsx`，portal + fixed 定位）。理由：任务列表这类每秒重渲染的界面会不断打断原生 tooltip 的悬停计时器，气泡永远弹不出来（2026-07-28 实测,加 `pointer-events-none` 也救不回）；且原生延迟长、样式不可控、会被 `overflow-hidden` 无关但位置随缘。已有的 `title` 属性改到它时顺手迁移即可，不必专门做一轮——检查脚本按存量基线只拦新增，迁移掉几处之后记得把 `NATIVE_TITLE_BASELINE` 调低锁住成果。
- **下拉菜单（`web/src/Menu.tsx`）的开关一律在 `pointerdown` 定，`click` 只服务「没有 pointerdown 的激活」**（键盘 Enter/Space、辅助技术）。完整判据和根因写在组件自己的注释里（`web/src/Menu.tsx`），改它之前先读那段。

## 主工作区

- **新建任务是内嵌面板不是弹层**：点新建后右侧详情区整个换成 `TaskComposer`（`web/src/TaskComposer.tsx` + `web/src/composer/*`），开关状态单点在 `useComposer`（`web/src/useComposer.ts`）。因此它**不进 `anyModal`**——j/k/c 这些全局键在它开着时照常生效。任何新增的「打开新建」入口都必须走 `openComposerAt`：记下当前选中塞进 `returnTo`、再把选中清空（列表不高亮任何一行），取消时切回去；反过来，任何会切走选中的动作（点列表、j/k、`openTask`）都要先 `closeComposer()`，否则右侧还挂着单子、左侧却高亮了别的任务。已经开着时再调 `openComposer` 只换模式、**绝不冲掉用户填的内容**，除非带来一份新的种子正文（随手记合并建任务），那才 `seq+1` 重新播种。Esc 仍复用 `useEscape` 的栈，所以 preset 对话框、新建分组等真弹层照旧优先关闭。理由：这张单子是主工作区的一个状态，不是打断你的对话框——用弹窗时正文被挤在 640px 里、还得靠「展开/收起」找地方写，而它恰恰是整张单子里最该大的那一块。
- **随手记按创建时的当前项目归属**（`notes.project_id`），正文原样保存、不做 AI 解析也没有独立标题；合并创建任务后不删除，只用 `task_id` 回链所建任务。命令面板的序列快捷键统一声明在 `Command.keys`、匹配单点在 `web/src/CommandPalette.tsx`，不要为 NI/NL 另写特判。
- 普通任务（`mode:"single"`）回复框里的 `/team` / `/debate` 是**派生命令**：大小写不敏感且按词边界识别，**命中即在回复框上方弹出配置卡**（live 预览：不抢焦点，命令后的尾巴文本实时同步进附言/辩题；回车定稿——输入框清空、焦点移进卡片，此后输入不再影响卡片，用卡上的 X 关闭），命令文本绝不进入当前 agent 会话；新任务统一写 `originTaskId=<来源 taskId>`，正文带来源标题/目标/状态、可用时的最新完整会话路径和用户补充。配置卡字段与新建面板同款（`TeamExecutorFields` / `DebateComposerFields`，含任务级模型/思考强度覆盖），不另造第二套选择器。派生任务的 worktree **不显式传 `useWorktree`**，跟随 `createTasks` 单点的全局 `worktreeDefault`；来源任务的 `harness/<id8>` 分支仍存在时以它为 base（默认关闭时 base 由服务端清空，卡片提示会明说不含来源分支改动），确保来源任务的代码改动进入团队执行或辩论上下文。

## 团队视图

- **团队的「结束」只有归档一种**，UI 上的「收工」是另一个正交概念：`isTeamSettled`（`shared/src/team.ts` 单点，web/mobile 共用）= 调度台不忙 **且** 没有执行者处于 running/queued/paused。收工只影响呈现——时间轴右端收到最后一次活动（不再空走到「现在」，右侧标签改成实际收工时刻）、`useTick` 停掉按秒重算、「停止全组」隐藏（没东西可停）。**收工 ≠ 被停止**：被 `haltTeam` 停过的团队（内部组 `paused`）即使也收工了，仍然要显示「恢复全组」；自然干完活的团队没什么可恢复的。两个判据必须各算各的，别用一个布尔糊过去。理由：把「没归档」当成「还在进行中」，会让时间轴一路空走到现在——有内容的色条被挤成一小坨，「谁跟谁在并行」这个时间轴唯一要回答的问题反而看不出来了。

## 跨到 server 的那几条

- **换执行器时，模型/思考强度选择器一律重置为「跟随执行器」**，清空动作放在**组件层**而不是各调用点——web 在 `ExecutorField`（`web/src/composer/ExecutorFields.tsx`，单任务与团队 lead/worker 共用）和 `TaskDetail` 的运行设置里。判定调 shared 的 `sameExecutor`，不要自己写 `next.agentType !== cur.agentType`。规则全貌（创建路径、编辑路径、为什么覆盖不能脱离执行器流动）见 `server/CLAUDE.md`。
- 新增任何「选谁干活」的表面，都必须同时用前端 `ExecutorPicker`、持久化 `executorId` 字段、后端 `resolveExecutorFor`——三样缺一不可，辩论链路曾因此漏过一次。
