// ensureSchema 的容错加列清单(从 db/index.ts 拆出,文件 700 行闸;语义原样):
// 每条独立执行、"column already exists" 一律吞掉 —— 顺序只在**同表同列有依赖**时才要紧,
// 列的语义注释全部住在这里,改列先读上下文。真正的一次性数据搬运在 migrations.ts。
export const COLUMN_MIGRATIONS: string[] = [
  "ALTER TABLE tasks ADD COLUMN queue_seat_token TEXT",
  "ALTER TABLE tasks ADD COLUMN wait_ownership TEXT",
  "ALTER TABLE accept_gate_runs ADD COLUMN process_pending INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE accept_gate_runs ADD COLUMN source_fingerprint TEXT",
  "ALTER TABLE accept_gate_runs ADD COLUMN execution_mode TEXT",
  "ALTER TABLE monitors ADD COLUMN kind TEXT NOT NULL DEFAULT 'ash'",
  // 读取层的两份独立状态:可续读位置 probe、永久缺口全集 gaps(JSON 数组)。
  "ALTER TABLE monitor_scan_cursors ADD COLUMN probe INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE monitor_scan_cursors ADD COLUMN gaps TEXT NOT NULL DEFAULT '[]'",
  // 这个文件报的 CLI 身份:来源**全集**的持久依据(第 6 轮审查 N2)。旧行 NULL = 还没读到过,
  // 那时「只有我这一个来源」证明不了,于是不认领无归属的存量行 —— 保守的那一边。
  "ALTER TABLE monitor_scan_cursors ADD COLUMN source TEXT",
  // 这份位置是哪一代消费语义下确认的（第 9/10 轮审查）。旧行 NULL = 第一代,没有当代戳的
  // 一律重放一遍 —— 旧代确认掉的事实（被键挤掉的卡、没合并的终态）只能靠重读补回来。
  "ALTER TABLE monitor_scan_cursors ADD COLUMN semantics INTEGER",
  // 调用发生时那一行报的 CLI 身份。旧行 NULL = 当初没记,那时只能靠 source_run 自证来源
  // (键的重建在 migrations.ts 的 repairPendingCallKey —— SQLite 改不了主键)。
  "ALTER TABLE monitor_pending_calls ADD COLUMN cli_session_id TEXT",
  // 身份还没补全时,把「那一刻 spawn 的」这个时间锚留在债上:哨兵行和身份边条都可能先没了,
  // 而缺了锚,一次查询失败就被永久固化成「这条证不出身份」(第 10 轮审查 F2-B)。
  "ALTER TABLE monitor_reclaim_debts ADD COLUMN spawn_anchor_ms INTEGER",
  "ALTER TABLE monitors ADD COLUMN native_id TEXT",
  "ALTER TABLE monitors ADD COLUMN cli_session_id TEXT",
  // 默认值是 'unknown' 而**不是** 'bounded'：加列那一刻的存量行里，claude 投影的
  // expires_at 是拿 Monitor 入参那个 timeout_ms（请求值）算的，来源侧真钳了就是错的。
  // 填 'bounded' 等于声称「来源确认过这个期限」，把编出来的时刻变成事实。ash 自己起的
  // 哨兵期限确实是自己定的，由紧随其后的那条 UPDATE 刷回 'bounded'（见下）。
  "ALTER TABLE monitors ADD COLUMN source_lifetime TEXT NOT NULL DEFAULT 'unknown'",
  // 期限的**证据**,不是期限本身。新列 ⇒ 旧行必然 NULL,这才是「哪些期限由旧算法推出来」
  // 的可靠版本判据(原来拿 cli_session_id IS NULL 当依据,而那一列更早就有了)。
  "ALTER TABLE monitors ADD COLUMN lifetime_evidence TEXT",
  // 起它的那一代 agent 进程。sessions 那两列每回合被覆盖,不能用来判历史投影的死活。
  "ALTER TABLE monitors ADD COLUMN source_pid INTEGER",
  "ALTER TABLE monitors ADD COLUMN source_pid_started_at TEXT",
  // **起点**的证据,与 lifetime_evidence(时长的证据)分开记:回执能证明配置了多长,不能证明
  // 消息 timestamp 就是计时器起点(计时器在工具返回前就起了,回执要等 PostToolUse hooks)。
  "ALTER TABLE monitors ADD COLUMN start_evidence TEXT",
  // 来源确认的时长。起点不确定时 expires_at 不可信,但时长仍然说得出来。
  "ALTER TABLE monitors ADD COLUMN timeout_ms INTEGER",
  // 起点锚点的误差界。存量行一律 NULL = 无法重验 ⇒ 对外只给时长（见 schema-monitors.ts）。
  "ALTER TABLE monitors ADD COLUMN start_anchor_width_ms INTEGER",
  // 起它的那个 tool_use id。检查点的另一半:位置之前的配对关系靠它从库里重建
  // （见 claude-monitor-commit.ts 的文件头）。存量行 NULL，读到回执时顺手补上。
  "ALTER TABLE monitors ADD COLUMN tool_use_id TEXT",
  // 代次结论与起点下界的持久化依据(见 schema-monitors.ts)。存量行一律 NULL。
  "ALTER TABLE monitors ADD COLUMN source_run TEXT",
  "ALTER TABLE monitors ADD COLUMN start_low_at TEXT",
  // 起它的那条会话的角色。审查是旁路回合,跑在自己那条 reviewer 会话上 —— 少了它,
  // 审查者挂的哨兵醒来时叫的是执行者(见 schema-monitors.ts 的 source_role)。
  "ALTER TABLE monitors ADD COLUMN source_role TEXT",
  // 起它的那次审查(free_review_runs.id)。角色说得出「叫审查者」,说不出「叫哪一次审查
  // 的审查者」——而任务终态清理、事件出口、唤醒配置三处都要后者(见 schema-monitors.ts
  // 的 source_review_run)。存量行 NULL。
  "ALTER TABLE monitors ADD COLUMN source_review_run TEXT",
  // 起它的是那次审查的**第几轮**。run.id 跨轮复用(nextRound 把同一个 run 的
  // current_round 加 1、status 推回 reviewing),所以只有 runId 不是跨轮隔离证明:
  // 第 1 轮遗留的事件会在第 2 轮被重新解释成有效输入。存量行 NULL = 只按 run 判。
  "ALTER TABLE monitors ADD COLUMN source_review_round INTEGER",
  // 这一次创建独有的资源记号:归属与整项退出的唯一凭证(见 schema-monitors.ts)。
  // 存量行一律 NULL ⇒ 孤儿后代只能落「证不出」,记责任、不下刀(第 12 轮审查 F1)。
  "ALTER TABLE monitors ADD COLUMN unit_token TEXT",
  // 「谁让它停的」。status=stopped 有三种来由(主动点停 / 推满事件上限 / 系统回收),
  // 拿 status 代替来源会把后两种说成「本回合撤掉了哨兵」(第 1 轮审查 N1)。存量行 NULL
  // = 来源不详,一律不算主动撤。
  "ALTER TABLE monitors ADD COLUMN ended_by TEXT",
  // 「它还没送到的结果我不要了」这句话本体。**不是 ended_by**(那是「谁让进程结束的」):
  // 已经 exited 的哨兵不是被谁停的,拿 ended_by 当放弃凭证就等于那条出路对它永远无效
  // (第 2 轮审查 R2-3)。存量行 NULL = 没人放弃过。
  "ALTER TABLE monitors ADD COLUMN results_abandoned_at TEXT",
  // 迁移统一认领的标记(见 schema.ts uploads.claimOrigin)。存量行 NULL = 按真私有对待。
  "ALTER TABLE uploads ADD COLUMN claim_origin TEXT",
  "ALTER TABLE monitors ADD COLUMN results_abandoned_reason TEXT",
  // 「结局已写定、结束通知还没入队」那一瞬的责任凭证(时刻 + 原文)。少了它,那条缝里完成闸
  // 看不见任何东西,任务落 done 把唯一的结果通知吃掉(第 1 轮审查 F1)。存量行 NULL = 不在交接中。
  "ALTER TABLE monitors ADD COLUMN result_handoff_at TEXT",
  "ALTER TABLE monitors ADD COLUMN result_handoff_text TEXT",
  // 「这一行现在是第几版证据」。销账/收档拿它当条件,免得删掉的是别人刚落下的那一版
  // (见 schema-sessions.ts 的 version、第 3 轮审查 F2)。存量行一律 0。
  "ALTER TABLE agent_cleanup_debts ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
  // 即时清理点名了、却排除不掉的那几个号(见 schema-sessions.ts 的 open_members、第 8 轮
  // 审查 F1-A)。少了它,清扫侧用另一套设备的「没有」就把这份责任洗掉了。存量行 NULL =
  // 没点名过谁,判据退回原来那几台设备。
  "ALTER TABLE agent_cleanup_debts ADD COLUMN open_members TEXT",
  // 约定的结束条件(哪一行一出现就收工)。命令自己永不退出的那一类必须二选一:给这一列,
  // 或显式声明「就是要盯到到期」—— 否则创建当场 409(见 shared/src/monitor-end-condition.ts)。
  // 存量行 NULL = 没约定过,它们照旧只能等到期,这一列不改写任何既有事实。
  "ALTER TABLE monitors ADD COLUMN stop_when TEXT",
  // **已经确认过的那一行命中**。它跟读取位置是一件事的两半:位置一旦推过那一行,那行就再也
  // 不会被重读,于是「字样到了」这个事实必须跟位置同一次落库 —— 只记在内存里的话,收尾中途
  // 失败一次就把它丢了,重试时两份来源都是空的,结局被写成「它已经不在了」(第 2 轮审查 N1)。
  // 存量行 NULL = 没命中过(或者当初没记),读的那一侧照旧按日志重算。
  "ALTER TABLE monitors ADD COLUMN hit_line TEXT",
  "ALTER TABLE monitor_reclaim_debts ADD COLUMN unit_token TEXT",
  // 「线索追到这里为止」的戳。**不是销账**:整项退出在当前平台证不出,所以行留着只盖戳
  // (见 schema-monitors.ts 的 closed_at、第 13 轮审查 F1-B)。存量行 NULL = 还在追。
  "ALTER TABLE monitor_reclaim_debts ADD COLUMN closed_at TEXT",
  "ALTER TABLE monitor_reclaim_debts ADD COLUMN closed_note TEXT",
  // 「这个号已经被反证过」的戳 —— 反证不许在下一次尝试/另一个消费者/重启后退化成「未知」
  // 再走时间锚那条弱判据(见 schema-monitors.ts 的 identity_disproved_at、第 17 轮审查 F1)。
  // 存量行一律 NULL = 还没有过反证。
  "ALTER TABLE monitor_reclaim_debts ADD COLUMN identity_disproved_at TEXT",
  // 这条消息已经把任务行上那段续跑交代**接走了**,正文里带着它(见 schema.ts 的
  // checkpoint_taken)。持久账本:取走只写在内存里的话,送达之前进程一换,那段交代
  // 就两边都不在了(第 2 轮审查 F4)。存量行 NULL。
  "ALTER TABLE scheduled_messages ADD COLUMN checkpoint_taken TEXT",
  // 这条消息承载的是哪一笔结果交接。身份跟入队同一笔落库,于是「这一笔送过没有」有一个原子
  // 的答案——重投器据此不把同一条结束通知送成两条、把 agent 叫醒两次(第 2 轮审查 N1)。
  // 存量行 NULL = 不是交接。
  "ALTER TABLE scheduled_messages ADD COLUMN handoff_token TEXT",
  // 那段续跑交代的随身凭证:来源 + 取走时的占用代次(见 schema.ts)。存量行 NULL = 老账本,
  // 按「来源未知」处理(退回时不改来源列,照旧只认代次)。
  "ALTER TABLE scheduled_messages ADD COLUMN checkpoint_auto INTEGER",
  "ALTER TABLE scheduled_messages ADD COLUMN checkpoint_generation INTEGER",
  "ALTER TABLE handoff_local_peer_keys ADD COLUMN peer_fp TEXT",
  "ALTER TABLE user_handoff_targets ADD COLUMN peer_key_fp TEXT",
  "ALTER TABLE tasks ADD COLUMN started_at TEXT",
  "ALTER TABLE tasks ADD COLUMN goal_turn INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN cli_state TEXT",
  "ALTER TABLE tasks ADD COLUMN ended_at TEXT",
  "ALTER TABLE sessions ADD COLUMN ended_at TEXT",
  "ALTER TABLE groups ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN archived_at TEXT",
  "ALTER TABLE sessions ADD COLUMN active_ms INTEGER",
  "ALTER TABLE sessions ADD COLUMN turn_started_at TEXT",
  // 回合计数：产物归属据它判断「有没有回合没落账」（见 schema 上的注释）。
  "ALTER TABLE sessions ADD COLUMN turns_started INTEGER",
  "ALTER TABLE sessions ADD COLUMN turns_base INTEGER",
  "ALTER TABLE sessions ADD COLUMN turns_base_approx INTEGER",
  "ALTER TABLE sessions ADD COLUMN turns_lost INTEGER",
  // 每个回合自己的结局。存量行 NULL = 不知道（见 schema.ts 的 sessionTurns.outcome）。
  "ALTER TABLE session_turns ADD COLUMN outcome TEXT",
  "ALTER TABLE tasks ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN worktree_base TEXT",
  "ALTER TABLE tasks ADD COLUMN worktree_start_commit TEXT",
  "ALTER TABLE tasks ADD COLUMN merge_target_branch TEXT",
  "ALTER TABLE tasks ADD COLUMN base_task_id TEXT",
  "ALTER TABLE tasks ADD COLUMN accepted_source_commit TEXT",
  "ALTER TABLE tasks ADD COLUMN base_update_intent TEXT",
  "ALTER TABLE tasks ADD COLUMN origin_task_id TEXT",
  "ALTER TABLE tasks ADD COLUMN creation_origin TEXT",
  "ALTER TABLE projects ADD COLUMN api_keys TEXT",
  "ALTER TABLE tasks ADD COLUMN resume_prompt TEXT",
  // 那段续跑指令是系统自己写的(哨兵闸)还是人/agent 写的 —— 只有前者可以在阻塞物消失后
  // 自动清掉(第 2 轮审查 R2-2)。存量行一律 0 = 当成人写的,不会被自动抹掉。
  "ALTER TABLE tasks ADD COLUMN resume_prompt_auto INTEGER NOT NULL DEFAULT 0",
  // 这一格被占用的第几次。来源列只在「文字还在」时有意义,所以一段在途的退回必须靠代次
  // 判断自己是否已经过期 —— 否则它会继承到别人的来源(第 2 轮审查 F2)。存量行 0。
  "ALTER TABLE tasks ADD COLUMN resume_prompt_generation INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN resume_depends_on TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN speed TEXT",
  "ALTER TABLE agents ADD COLUMN reasoning_effort TEXT",
  "ALTER TABLE tasks ADD COLUMN question TEXT",
  "ALTER TABLE agents ADD COLUMN provider_id TEXT",
  "ALTER TABLE sessions ADD COLUMN relay_env TEXT",
  "ALTER TABLE sessions ADD COLUMN resume_args TEXT",
  // §Team：团队模式（替掉旧的「编排组/协调者」）
  "ALTER TABLE tasks ADD COLUMN team TEXT",
  "ALTER TABLE tasks ADD COLUMN report_back INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE groups ADD COLUMN owner_task_id TEXT",
  // ask_question 的候选答案（json string[]，null=只能自由作答）
  "ALTER TABLE tasks ADD COLUMN question_options TEXT",
  // ask_question 的多问题列表（json {question, options?}[]，null=老式单问题）
  "ALTER TABLE tasks ADD COLUMN question_items TEXT",
  "ALTER TABLE tasks ADD COLUMN question_history TEXT",
  // 任务执行器 profile。非空时按 agents.id 精确解析；空/悬空时按 agent_type 默认执行器降级。
  "ALTER TABLE tasks ADD COLUMN executor_id TEXT",
  // 任务级模型/思考强度覆盖；null 时继续跟随执行器 profile。
  "ALTER TABLE tasks ADD COLUMN model TEXT",
  "ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT",
  // 续聊：终态任务的追加对话回合，记下续聊前的终态（队列按它看待该成员）
  "ALTER TABLE tasks ADD COLUMN follow_up_from TEXT",
  // 完成确认落库（严格 done 协议），确认与结算跨进程也不丢
  "ALTER TABLE tasks ADD COLUMN complete_confirmed_at TEXT",
  "ALTER TABLE tasks ADD COLUMN active_turn_token TEXT",
  "ALTER TABLE tasks ADD COLUMN active_direction_token TEXT",
  "ALTER TABLE tasks ADD COLUMN active_direction_version INTEGER NOT NULL DEFAULT 0",
  // 方向世代：回合起跑和方向轮换各 +1,永不归零 —— 上面那三列离开运行态就被清空,迟到的
  // 回滚于是分不清「我那一轮已结束」和「后来又跑完了另一轮」(第 4 轮审查 F1-B)。存量行 0
  // 而不是 NULL:它要参与 `=` 比较,NULL 谁也不等于谁,那样连正常的回滚也会被判成过期。
  "ALTER TABLE tasks ADD COLUMN direction_epoch INTEGER NOT NULL DEFAULT 0",
  // 正交验收阶段，只用于展示与协作，不进入 TaskStatus 调度/结算
  "ALTER TABLE tasks ADD COLUMN stage TEXT",
  // 正交列表展示字段：null=未置顶，整数毫秒时间戳用于多个置顶任务排序
  "ALTER TABLE tasks ADD COLUMN pinned_at INTEGER",
  // 星标：用户手动软记号（与自动状态正交）；null=未标
  "ALTER TABLE tasks ADD COLUMN starred_at INTEGER",
  // §工作流：项目默认起手式 + 任务创建时拷下的那条线（快照，不是引用）
  "ALTER TABLE projects ADD COLUMN workflow_id TEXT",
  // 「新任务默认开不开 worktree」从 app_settings 搬到项目这一层（2026-09-14）。
  // 老库的那颗全局值由 migrations.ts 的 migrateWorktreeDefaultToProjects 灌进存量
  // 项目 —— 它必须跑在这句 ADD COLUMN 之后，所以别把数据迁移挪到 DDL 前面。
  "ALTER TABLE projects ADD COLUMN use_worktree_default INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE tasks ADD COLUMN workflow TEXT",
  // 独立审查任务与被审目标的关系；review_requested 只在团队 dispatch worker 上置位。
  "ALTER TABLE tasks ADD COLUMN review_of TEXT",
  "ALTER TABLE tasks ADD COLUMN review_round INTEGER",
  "ALTER TABLE tasks ADD COLUMN review_requested INTEGER NOT NULL DEFAULT 0",
  // 就地验证轮：验证不再另起一个审查任务，而是在原任务上多跑一个旁路回合。
  // review_of/review_round 保留，只为让历史那批独立审查任务仍能读出来。
  "ALTER TABLE tasks ADD COLUMN verify_round INTEGER",
  "ALTER TABLE tasks ADD COLUMN verify_rounds INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN verify_completed_steps TEXT NOT NULL DEFAULT '[]'",
  // 就地验证轮没有独立任务行可数，所以「这一站验过几轮」得自己记：换一站就归零，
  // 站号记在同一行的 review_step 上。
  "ALTER TABLE tasks ADD COLUMN verify_station_rounds INTEGER NOT NULL DEFAULT 0",
  // 一条线上可以写不止一站「自动验证」/「等我点头」：游标记住此刻停在哪一站，
  // 审查任务记住自己验的是哪一站（轮数上限按站分开数）。
  "ALTER TABLE tasks ADD COLUMN workflow_at TEXT",
  "ALTER TABLE tasks ADD COLUMN workflow_mode TEXT NOT NULL DEFAULT 'preset'",
  "ALTER TABLE tasks ADD COLUMN review_step TEXT",
  // 解绑重启（executors/detached.ts）：agent 输出走文件而不是匿名管道，于是它
  // 活得过 server 重启。这几列是重启后「找回并接管」所需的全部线索——pid 认
  // 进程、started_at 防 pid 复用、out_path 是原始输出、offset 是已消费到哪个
  // 字节（永远落在换行边界），从那里接着读就不丢不重。
  "ALTER TABLE sessions ADD COLUMN agent_pid INTEGER",
  "ALTER TABLE sessions ADD COLUMN agent_started_at TEXT",
  "ALTER TABLE sessions ADD COLUMN agent_out_path TEXT",
  "ALTER TABLE sessions ADD COLUMN agent_err_path TEXT",
  "ALTER TABLE sessions ADD COLUMN agent_rc_path TEXT",
  "ALTER TABLE sessions ADD COLUMN agent_offset INTEGER",
  // 这一次运行独有的**资源记号**(种进 agent 的环境,见 executors/spawn.ts)。跟上面那几列
  // 一样是「重启后找回」的线索,但它回答的是另一个问题:pid 只认得出根,记号跟着 exec
  // 继承到每一个后代 —— 根死了之后还留在后台的那些仍然自证身份。
  "ALTER TABLE sessions ADD COLUMN agent_unit_token TEXT",
  // OpenAI 兼容供应商：把 Codex 的 Responses API 适配到仅有 Chat Completions 的上游。
  "ALTER TABLE llm_providers ADD COLUMN protocol_conversion_enabled INTEGER NOT NULL DEFAULT 0",
  // 选模型面板的候选来源：api=每次现调 /models；pinned=只用固定下来的这几个。
  "ALTER TABLE llm_providers ADD COLUMN model_list_mode TEXT NOT NULL DEFAULT 'api'",
  "ALTER TABLE llm_providers ADD COLUMN pinned_models TEXT NOT NULL DEFAULT '[]'",
  // Anthropic 供应商中明确以 1M 上下文运行的模型名集合；未选模型继续直连。
  "ALTER TABLE llm_providers ADD COLUMN context_1m_models TEXT NOT NULL DEFAULT '[]'",
  // 定时发送的 @指派：连执行器、模型、思考强度一起记住，到点还是跑用户当时选的那一套。
  "ALTER TABLE scheduled_messages ADD COLUMN executor_id TEXT",
  "ALTER TABLE scheduled_messages ADD COLUMN model TEXT",
  "ALTER TABLE scheduled_messages ADD COLUMN reasoning_effort TEXT",
  // 排队追问：运行中发出的消息不看时间，任务一空闲就投递（timed 是老的定时发送）。
  "ALTER TABLE scheduled_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'timed'",
  // 投递租约：行仍是 pending，只是标着「有人正在送」。**它必须落库**——进程死在
  // 「已认领、还没送到」当口时，内存里的等待/在途标记全没了，只有库里这个标记能让
  // 开机扫描认出「这条得重新投递」（见 docs/incidents.md「排队消息凭空消失」）。
  "ALTER TABLE scheduled_messages ADD COLUMN delivering_since TEXT",
  // 投递时恢复的回合身份（审查者提问期间排队的答复必须以 reviewer 身份送回）。
  "ALTER TABLE scheduled_messages ADD COLUMN session_role TEXT",
  // 这条消息是谁写的。null = 真人；"monitor:<id>" = 某个哨兵推来的事件。两件事靠它：
  // 同一个哨兵还没送出去的事件合并进同一行（一次唤醒看完全部，而不是一行一个回合），
  // 投递时标 byBackend 让它在会话里显示成系统代写而不是用户发言。
  "ALTER TABLE scheduled_messages ADD COLUMN origin TEXT",
  "ALTER TABLE scheduled_messages ADD COLUMN monitor_wake TEXT",
  // 统一验收的结构化合并落账（目标分支 + 合并前后 commit），合并后基线审查靠它。
  "ALTER TABLE tasks ADD COLUMN accepted_target_branch TEXT",
  "ALTER TABLE tasks ADD COLUMN accepted_base_commit TEXT",
  "ALTER TABLE tasks ADD COLUMN accepted_merge_commit TEXT",
  "ALTER TABLE tasks ADD COLUMN accepted_tail_pending INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN accepted_tail_done TEXT NOT NULL DEFAULT '[]'",
  // 「怎么合的」与「不提交那一档留在索引里的内容指纹」：null 的 accepted_merge_commit
  // 有两种含义，UI 不能靠猜（见 schema.ts 上那两段注释）。
  "ALTER TABLE tasks ADD COLUMN accepted_merge_method TEXT",
  "ALTER TABLE tasks ADD COLUMN accepted_pending_tree TEXT",
  // Token 用量:一条会话行按回合累加(口径统一在 shared/src/usage.ts)。全 null
  // = 这条会话建在本功能之前、或那家 CLI 不报账——**不能当 0 展示**。
  "ALTER TABLE sessions ADD COLUMN usage_input INTEGER",
  "ALTER TABLE sessions ADD COLUMN usage_output INTEGER",
  "ALTER TABLE sessions ADD COLUMN usage_cache_read INTEGER",
  "ALTER TABLE sessions ADD COLUMN usage_cache_write INTEGER",
  "ALTER TABLE sessions ADD COLUMN usage_reasoning INTEGER",
  "ALTER TABLE sessions ADD COLUMN usage_cost_usd REAL",
  "ALTER TABLE sessions ADD COLUMN usage_turns INTEGER",
  // 上下文水位:**覆盖**式,跟上面那组累加流水是两个概念(见 shared/src/usage.ts)。
  "ALTER TABLE sessions ADD COLUMN context_used INTEGER",
  "ALTER TABLE sessions ADD COLUMN context_window INTEGER",
  "ALTER TABLE sessions ADD COLUMN context_window_estimated INTEGER",
  // Codex 旧 trace 不完整时没有可信累计基线：下一回合只采基线，宁可少记一轮，也不
  // 把整条线程累计值再次加进 sessions。
  "ALTER TABLE usage_cumulative_snapshots ADD COLUMN baseline_ready INTEGER NOT NULL DEFAULT 1",
  // 覆盖 CLI 自己配置文件里的设置(json,以 env 注入进程)。声明表在
  // shared/src/cli-overrides.ts,那里同时写明每一项盖掉的是谁。
  "ALTER TABLE agents ADD COLUMN config_overrides TEXT NOT NULL DEFAULT '{}'",
  // 这一轮是 CLI 原生命令(`/compact`):结算钩子整段跳过,别把一次本地压缩记成
  // 一轮验证跑完(说明见 db/schema.ts 的 tasks.nativeTurn)。
  "ALTER TABLE tasks ADD COLUMN native_turn INTEGER NOT NULL DEFAULT 0",
  // 回合保真三件套(说明见 db/schema.ts 的 sessions 同名列):这一轮跑在哪个 profile
  // 上、是被停的还是崩的、是不是旁路回合。少一件,「重跑上一回合」就只能靠猜。
  "ALTER TABLE sessions ADD COLUMN executor_id TEXT",
  "ALTER TABLE sessions ADD COLUMN turn_model TEXT",
  "ALTER TABLE sessions ADD COLUMN turn_reasoning_effort TEXT",
  "ALTER TABLE sessions ADD COLUMN stopped_as TEXT",
  "ALTER TABLE sessions ADD COLUMN side_turn INTEGER NOT NULL DEFAULT 0",
  // profile 是可编辑可删除的,光记主键说不清「当时那套执行环境」。这一列存指纹,
  // 重跑前对不上就 409(说明见 db/schema.ts 的 sessions.executor_fingerprint)。
  "ALTER TABLE sessions ADD COLUMN executor_fingerprint TEXT",
  // 任务接力(跨机器 handoff)的持久标记(json TaskHandoff,见 db/schema.ts)。
  "ALTER TABLE tasks ADD COLUMN handoff TEXT",
  "ALTER TABLE tasks ADD COLUMN handoff_audit TEXT",
  // 项目级预览命令。空 = 按各语言惯例自动识别（preview-command.ts）。
  "ALTER TABLE projects ADD COLUMN preview_command TEXT",
  "ALTER TABLE projects ADD COLUMN preview_config TEXT",
  // 常用命令（状态栏启停的常驻服务），JSON 数组。见 shared/src/project-commands.ts。
  "ALTER TABLE projects ADD COLUMN commands_config TEXT",
  // 验收合并完落不落提交（1 = 老行为，落提交）。见 db/schema.ts 同名列。
  "ALTER TABLE projects ADD COLUMN accept_commit INTEGER NOT NULL DEFAULT 1",
  // 验收前置命令（点验收之后、动 git 之前跑，rc=0 才合并）。null = 不设门禁 = 老行为。
  "ALTER TABLE projects ADD COLUMN accept_gate_command TEXT",
  // 那一按**实际**拿什么当凭据放的行（passed / skipped / unset + 真的跑绿的那一次）。
  // 存量行为空 = 没留凭据，回执如实这么说，不拿「最近一次门禁」反推（第 1 轮审查 F1）。
  "ALTER TABLE tasks ADD COLUMN accepted_gate_mode TEXT",
  "ALTER TABLE tasks ADD COLUMN accepted_gate_run_id TEXT",
  // 项目级浏览器登录态授权白名单（JSON 字符串数组）。空/null = 不授权,是默认。
  "ALTER TABLE projects ADD COLUMN browser_cdp_domains TEXT",
  // ── 多人模式(docs/multi-user-plan.md §八)──────────────────────────────
  // 归属列。全部可空:自用模式下恒为 null,转多人时由向导一次性实名化成初始管理员。
  "ALTER TABLE tasks ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE tasks ADD COLUMN executor_snapshot TEXT",
  "ALTER TABLE projects ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE notes ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE agents ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE llm_providers ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE workflows ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE reviewer_profiles ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE team_presets ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE schedules ADD COLUMN owner_user_id TEXT",
  // 定时/排队消息也盖归属戳:它触发的回合要按**排消息的人**跑(§八),
  // 不是按任务归属人 —— 共享项目里给别人的任务排一条回复,烧的是自己的 key。
  "ALTER TABLE scheduled_messages ADD COLUMN owner_user_id TEXT",
  "ALTER TABLE scheduled_messages ADD COLUMN execution INTEGER NOT NULL DEFAULT 0",
  // 这条消息续起来的那一轮审查(run + 轮次)。存量行为空 = 不绑任何一轮,
  // 投递时按显式的「不绑」处理,不退回「查最新那一轮」(本轮审查 F2)。
  "ALTER TABLE scheduled_messages ADD COLUMN review_run TEXT",
  "ALTER TABLE scheduled_messages ADD COLUMN review_round INTEGER",
  // 这一轮实际跑在谁名下(= 注入 CLAUDE_CONFIG_DIR/CODEX_HOME 的那个人)。接力搬会话
  // 文件按它找,不按任务归属人 —— 跨人回合两者不是一回事(见 db/schema.ts 同名列)。
  "ALTER TABLE sessions ADD COLUMN run_owner_user_id TEXT",
  // 这一轮**注进去的那个配置目录**本身。归属人算得出目录,但目录会随实例设置整体
  // 挪位置(「CLI 额度」共用 ⇄ 隔离),所以「这条会话的文件在哪」只能记下来,不能现算
  // (见 db/schema.ts 同名列)。老行为 null,读侧回落到按归属人现算。
  "ALTER TABLE sessions ADD COLUMN cli_config_dir TEXT",
  // 入站接力来源:谁批的 + 对端自报的实例模式(§十一 知情批准)。
  "ALTER TABLE handoff_peers ADD COLUMN approved_by TEXT",
  "ALTER TABLE handoff_peers ADD COLUMN peer_mode TEXT NOT NULL DEFAULT ''",
  // 这次配对申请代表本机的哪个账号(源机带的对端 key 认出来的)。多人模式下认不出
  // 主人就不受理,所以空值只见于单人时期或升级前的存量行(见 handoff-peers.ts
  // peerAudience)。
  "ALTER TABLE handoff_peers ADD COLUMN requested_by_user_id TEXT",
];
