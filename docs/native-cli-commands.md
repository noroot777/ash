# 原生目标与斜杠命令

本次对照本机 Codex CLI 0.153.4、Claude Code 2.1.283 的协议和官方命令清单接入。入口只有对话框中的 `/` 补全与直接输入斜杠命令；没有新增“＋ → 目标”、目标按钮或另一套控制面板。原生命令在菜单中单独分组，不作为 skill 交给模型猜测执行。

## 目标

Codex 与 Claude 的普通单任务均可使用：

```text
/goal 让 test/auth 全部通过，且 lint 不报错
/goal
/goal pause
/goal resume
/goal clear
```

Codex 还支持精确 token 预算：

```text
/goal 完成模块迁移并验证 --budget 40000
/goal budget 60000
```

Codex 使用 App Server 的 `thread/goal/set|get|clear`，并保持连接消费自动续轮。Claude 使用其真正的 `/goal` CLI 命令和原生 Stop-hook 评估循环，不是由 ash 拼“继续”模拟。Claude 的 `/goal pause` 停止当前目标进程，`resume` 在原会话中重新设置保留的条件；`clear` 会将清除命令送到原会话。Claude 暂无独立 token-budget 参数，目标条件中可以写明时间或轮数上限。

Claude 正在执行时没有额外 RPC 控制通道，因此 `/goal` 返回明确标注的 ash 快照；实时评估和原生用量仍以 Claude 输出为准，不用虚构的零 token 计数替代。目标启动所需的 ash 完成协议与当轮身份通过权限为 `0600` 的临时上下文文件传入，结束后清理，不把身份 token 放进 argv。

原生目标和 ash 任务完成是两个不同的事实。目标中间轮结束不会结算任务；目标耗尽预算、额度不足、阻塞或停止但尚未收到 `complete_task` 时，ash 保持暂停并留下会话说明。暂停的目标不会被串行队列或批量运行分组自动启动，显式 `/goal resume` 可以继续。只有任务完成确认才允许正常完成结算。

`/goal resume` 在起跑前检查当前执行器及归属人的目标；没有可恢复目标会直接拒绝，不改任务状态或验收事实。目标尚未真正启动就失败时恢复启动前的目标快照，不新增队列暂停标记。`/goal clear` 同时释放目标暂停标记，清除后的任务由既有队列规则处理，不因空目标永久阻塞。运行中清除目标后，持久结算说明提示使用 `/goal 描述` 设置新目标；只有目标仍保留的暂停回合才提示 `/goal resume`。

目标、预算、已用量和暂停标记按「执行器 profile + 发起人」分槽保存。换执行器或换人回复不会覆盖另一份目标；回到原作用域后可 `/goal resume`。存量单槽数据在首次写入时保留并迁移；自动审查、验证、辩论只使用临时实施状态，不改用户保存的目标或计划模式。任一作用域仍有目标暂停标记时，暂停任务仍受队列及批量运行的保护。

Claude 的普通执行回合也能用无参数 `/goal` 查询已保存的目标快照；没有快照时说明尚未设置目标，不会打断普通执行。`/goal pause` 和 `/goal clear` 在忙碌状态下仍只控制实际目标回合。

## Codex 新增命令

| 命令 | ash 中的行为 |
| --- | --- |
| `/plan`、`/plan 问题`、`/plan off` | 原生计划模式，按执行器与发起人分别保存；单任务页列出仍开启的 Codex 作用域，换执行器、换常设智能体或刷新不会隐藏它们，仅对应作用域的普通回复只做计划；`/plan off` 关闭当前作用域，运行、重试、队列推进、分组起跑和工作流唤醒退出所有 Codex 作用域（正文显式 `/plan` 除外） |
| `/compact` | 原生手动上下文压缩 |
| `/review` | 原生当前改动审查；支持 `--base 分支`、`--commit SHA` 或自定义审查要求 |
| `/status` | 会话、模型、计划模式和最近的真实上下文快照；没有数据时显示 null，不编造计数 |
| `/usage` | 原生账号 token 用量与额度；不支持的供应商会明确报错，不启动模型代查 |
| `/mcp` | 当前会话的 MCP 服务与工具清单 |
| `/ps`、`/stop` | 当前原生会话的后台终端清单与清理；`/stop` 不取消 ash 任务 |
| `/debug-config` | 有效配置与配置层；隐藏 key、token、密码、环境变量和请求头等敏感项 |
| `/hooks` | 当前目录的生命周期 hooks 清单；不改信任或全局配置 |
| `/apps` | 分页读取可用连接器 |
| `/plugins` | 当前目录及用户的本地插件清单；不自动安装或改配置 |
| `/personality friendly\|pragmatic\|none` | 当前任务/执行器范围内的表达风格 |
| `/fast [on\|off]` | 当前任务/执行器范围内的速度档；off 可以覆盖 profile 的 fast 默认档 |
| `/fork` | 在同一个 ash 任务中创建原生会话分支，保留原会话记录，不是派生一个 ash 任务；新分支不保留原目标、预算和已用量，使用 `/goal 描述 --budget 上限` 重新设置目标（预算可选），不能用 `/goal resume` 恢复已清除的目标 |
| `/new`、`/clear` | 同任务、同工作区的新原生会话，旧历史不删除 |
| `/rename 名称` | 同步修改原生会话名及 ash 任务标题 |

任务改用 Claude 等其他常设智能体后，仍显示未关闭的 Codex 计划作用域；临时 `@` 召唤对应 Codex 执行器时仍按该作用域的计划状态执行，Claude 的普通回复不受这些作用域影响。由同一发起人临时召唤对应 Codex 执行器并发送 `/plan off` 可退出该作用域。重新运行或重试即使由 Claude 执行，也会清除该任务全部 Codex 计划标志；切回 Codex 不会恢复旧计划模式。清除计划标志不改其他作用域的目标、预算、用量或暂停标记，旁路审查与验证仍不修改保存的状态。

检查、压缩、设置、计划与原生审查按旁路回合处理，不清掉已完成任务的验收事实，也不冒充新一轮任务实施。忙碌时可即时查询目标、状态、额度、MCP、后台终端、配置、hooks、apps 和插件；需要新 turn 的命令沿用待发消息排队机制。运行中的目标可以即时 pause、clear 或调整 Codex 预算，不能同时换另一个目标。

普通回合正在运行或排队时，`/goal 描述` 进入待发送消息，当前回合结束后自动执行；只有正在执行目标的回合才拒绝替换或恢复，并提示当前目标及 `/goal pause`。对已完成、失败或取消的任务发送目标属于终态续聊：未确认完成、异常退出或手动停止后仍保留原终态，确认完成则变为已完成。目标快照保留，但这类续聊不写队列暂停标记，也不重新占住已让出的串行队列位置；非终态目标执行仍保留原有暂停保护。

Claude 继续保留已接入的 `/compact`，包括其附加参数；Claude 的 `/review` 仍是真 skill，不会被 Codex 的同名原生命令抢占。其他执行器不显示这批专属命令，误发会得到明确的不支持提示。团队调度台与讨论模式不展示不适用的原生命令，Claude 团队既有的 compact 通道保留。

Codex 原生适配依赖 App Server。带 exec 专属参数的 profile 不会偷偷删参数或把原生命令降级为普通聊天，而会说明不兼容原因。CLI 太旧、实验性协议未开放或供应商不支持时，时间线保留真实错误。

## 命令清单的其余项

| 类别 | 审计结果与取舍 |
| --- | --- |
| `/model`、reasoning、`/diff`、`/skills`、`/mention`、`/side`、`/btw`、`/resume`、`/archive`、`/copy` | ash 已有执行器胶囊、Git 检视、skill 补全、文件附件、侧聊、会话续接、归档与复制能力；复用现有入口，避免两套状态 |
| `/agent`、`/subagents` | ash 已展示原生子智能体活动与团队执行者；没有接管 CLI 的交互式线程选择器 |
| `/ide`、`/app`、`/keymap`、`/vim`、`/raw`、`/statusline`、`/title`、`/theme`、`/pets`、`/pet`、`/quit`、`/exit` | 编辑器、桌面应用或终端外壳交互，不是非交互执行器的任务能力，不照搬到网页 |
| `/permissions`、`/approve`、Windows sandbox 命令 | 不改 ash 现有无人值守权限、执行器边界或系统 sandbox 配置；没有绕过权限的新入口 |
| `/logout`、`/feedback`、`/import`、`/delete` | 会改变账号、发送日志、迁移全局配置或删除原生历史；没有因批量接入命令而自动开放这些副作用 |
| `/experimental`、`/memories`、hooks 信任/启停、插件安装 | 涉及 CLI 全局开关或配置持久化，本次只接入任务范围设置和只读清单，不伪装成完整配置管理 |
| `/init` | 生成仓库 `AGENTS.md`，没有稳定的独立 App Server 命令；未用普通提示词冒充原生接口，也未擅自添加仓库规则 |

## 验证

`npm -w server run test:cli-commands` 覆盖解析、预算、执行器差异、RPC、多轮生命周期、提前完成/延迟 verdict、失败恢复、隐私、HTTP 即时控制、持久暂停与结算隔离。

`npm -w server run test:goal-native-live` 使用真实 Codex/Claude 二进制与独立配置目录，但模型端是本机 Responses/Anthropic 测试服务；不消耗用户模型额度。验证 Codex 两轮后原生预算停止，以及 Claude 三轮目标工作和上下文文件清理，另验证 Codex 的检查、设置、压缩、审查、分叉与新会话协议。它还走 ash 的真实续聊链路，覆盖计划状态按执行器隔离、旁路回合不受计划模式污染、持久预算暂停、目标查询和新建/清空后不复用旧上下文。

`npm -w web run test:cli-commands` 在独立测试库中启动真实 ash 服务，验证两种执行器的补全、团队过滤、快照查询不产生假用户气泡、验收状态保留以及刷新后会话说明仍在。另覆盖跨执行器与常设智能体切换后的计划作用域提示、真实 `@` 临时召唤 Codex 及 `/plan off`、Claude 普通回复不受 Codex 计划影响，以及 Codex 运行/Claude 运行与重试清除全部作用域。需要先构建 shared、server 和 web。

本轮浏览器通道先尝试 Chrome 扩展具名后台会话 `🧪 ash 原生目标命令`，扩展报告 `unsupported Codex auth method: apikey`，无法建立连接。随后使用独立临时 profile 的 headless Chromium 验证；没有激活 Chrome、接管普通标签或启动有头浏览器。

参考协议与语义来源：OpenAI 官方 `learn.chatgpt.com/docs/app-server`、`learn.chatgpt.com/docs/developer-commands`；Anthropic 官方 `code.claude.com/docs/en/goal`。实际 RPC 形状另以本机 `codex app-server generate-json-schema --experimental` 生成的版本化 schema 校验。
