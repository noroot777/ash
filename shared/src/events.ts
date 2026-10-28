// SSE / 执行器事件协议(§7 gates、§12 streaming)。
//
// 从 index.ts 拆出来的**纯类型**文件:index 只做 `export type { … } from "./events.ts"`
// 再导出,消费者继续 `import type { AgentEvent } from "@ash/shared"`,零改动。
// 之所以只能搬类型:服务端直接跑 shared 的 .ts 源码,Node 的类型擦除不会把
// "./x.js" 说明符映射回 "./x.ts",index 里**转发运行时值**会让进程起不来
// (见 server/CLAUDE.md「执行器与模型」最后一条)。`import type` / `export type`
// 编译期就被抹掉,所以安全 —— 下面对 ./index.js 的反向 type import 同理。
import type { AgentType, DuetConsensusBy, QuestionItem, Task, TaskStage, TaskStatus } from "./index.ts";
import type { SessionRole } from "./session.ts";
import type { ContextUsage, TokenUsage, UsageAccountingMark } from "./usage.ts";
import type { NativeWorkEvent } from "./native-work.ts";
import type { MonitorWakeData } from "./monitor-wake.ts";

// ── HITL gates (§7) ──────────────────────────────────────────────────────────
export type GateName = "G1" | "G2"; // G2 is legacy, retained for historical events
// inject/ask 的 attachments 是**已上传文件的本地绝对路径**(与回复框同一套):服务端
// 把它们拼成 attachmentsPrompt 附在给讨论者的 prompt 末尾,讨论者自己去 Read。
export type GateAction =
  | { kind: "approve"; text?: string; side?: "A" | "B" } // side is retained for older clients
  | { kind: "reject" } // 打回终止
  | { kind: "inject"; text: string; attachments?: string[] } // 注入意见 → 回炉再讨论（始终双方一起回炉）
  | { kind: "ask"; text: string; target?: "A" | "B"; attachments?: string[] }; // 提问 → 答完继续；target 缺省=问双方，指定=只问那一位讨论者

// ── Executor streaming events (§12) ──────────────────────────────────────────
export type AgentEvent =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string; nativeWork?: NativeWorkEvent }
  // 一张图,或者**正文里一处引用的保存结果**。三个字段合起来才是完整的一条交代:
  //   · `source` = 这处引用的目的地(`![](…)` 里那一段,规范化后的;见 @ash/shared/markdown-images)
  //   · `ref`    = 这处引用在这条流里的**身份**(单调递增、不去重、不按回合复位)
  //   · `path`   = 它那一刻的拷贝;**缺省 = 这处引用确实没存下副本**,不是「关联丢了」
  //   · `lost`   = 没副本的那一档再分两种:`lost: true` = **字节当时读到了、写盘失败了**
  //                (这一刻的画面丢了,展示端据此显式作废);缺省 = 压根没有字节可存(说那句
  //                话时文件还不存在、格式不认),此时工作目录里那张多半就是它说的那张,
  //                展示端退一档去取是对的(判据见 server/src/agent-attachments.ts)
  // 为什么非得有 `ref`:只按 `source` 配对的话,同一个路径在一轮里被重拍过(红→蓝→红)时,
  // 按字节去重会把第三处引用整条抹掉,展示端队列短一条,正文写着「恢复红色」、画出来是
  // 蓝色(审查第 1 轮 F1)。字节可以内容寻址去重,**引用关联不能**。
  // `source`/`ref` 都缺省 = 不是正文引用来的(工具结果截图之类),那种只铺卡片、不进正文。
  // `pos` = 这处引用在它那份文档全文里的绝对起点 —— 引用的**文档节点身份**。恢复补回的
  // 记录只能排在既有 trace 之后,事件顺序不再天然等于文档顺序;展示端按 pos 把同目的地的
  // 记录排回文档顺序再配对(审查第 8 轮 R1:重启接回后红蓝对调)。缺省 = 老记录,没有补回行。
  | { kind: "attachment"; path?: string; source?: string; ref?: number; pos?: number; lost?: boolean }
  | { kind: "session"; cliSessionId: string }
  // backend 旁注；时间与落盘 sentinel 共用，实时/刷新布局才不会漂。
  // level="notice" = 这条是**结算说明**(这一轮为什么落成这个状态),不是出了什么岔子。
  // 展示端据此上「提示」那身琥珀,而不是让关键词表去猜语气(noteTone)——「没交卷」这类
  // 说明里天然带着「未完成」,猜出来永远是红的,而第一次用 ash 的人读到红字只有一个
  // 结论:它崩了。
  // aside=true = 这条只是**任务时间线的一条记录**(预约审查、验收阶段更新、预览起停…),
  // 由 appendTaskTimeline 写下,agent 从没见过它。它既不开一个回合也不结束一个回合,所以
  // 展示端不能拿它当回合边界用 —— 它落在哪一秒纯属偶然,常常正砸在某一回合说到一半的
  // 地方。不带这个标的 system 行是真的说给 agent 听的(「继续(从中断处)」那类),照旧当
  // 回合起点。
  | { kind: "system"; text: string; at: string; level?: "notice"; aside?: true }
  // 本回合的 token 用量,由执行器从 CLI 的收尾事件(claude 的 result / codex 的
  // turn.completed)解析。每回合至多一条,恒在该回合的 turnEnd/done 之前。拿不到
  // 用量的 CLI 一条都不发 —— 展示端据此判断「这家报不报账」。
  // accounting 记的是这个数字**怎么来的**(见下面 UsageAccountingMark)。读侧和历史
  // 回填都靠这一条逐事件的标记判口径,不靠数值形状去猜 —— 形状会骗人:续聊一轮就能让
  // 整串历史改变含义。
  | { kind: "usage"; usage: TokenUsage; accounting?: UsageAccountingMark }
  // 上下文**水位**(不是流水,区别见 shared/src/usage.ts 的 ContextUsage)。每回合至多
  // 一条,恒在该回合的 turnEnd/done 之前。落库是**覆盖**不是累加。
  | { kind: "context"; context: ContextUsage }
  // level="notice" = 这条不是执行故障,是**执行过程里的一条提示**:上游在重试、还在等
  // 回话、这一轮为什么落成这个状态。分级的理由:提示混在故障里,新用户看到红叉只会读成
  // 「它崩了」,而真出故障时那句提示又会盖住真正的原因(docs/incidents.md「接力到多用户
  // 机器」)。缺省(旧 trace、执行器报的错)仍是故障级,展示端照旧红着。
  //
  // 消费侧对 notice 的口径是统一的:**落 trace、照发,但一概不当失败处理** —— 不写
  // `执行诊断` 红块、不并进会话恢复故障、不置 sawExecutionError、不让 duet 判这一轮失败。
  // 展示端把它排在执行过程里它发生的那个位置(紧跟着上一步),用琥珀色的「提示」行,
  // 不计异常数。判据统一在 server 的 `session-notice.ts#isExecutionNotice`。
  //
  // 为什么是 error 而不是 system:system 行会被写成 `.md` 的回合 sentinel,而那一路是
  // **回合收口之后**才补落盘的,于是整段重试记录糊在会话结尾、离它真正发生的那一步十万
  // 八千里(用户 2026-10-21 反馈)。trace 天生按发生顺序排,是这类过程信号唯一对的位置。
  //
  // affectsTurn=false = 仍按红色异常展示和落 trace，但它只是旁路诊断（例如 Claude 自动
  // 压缩失败），不能据此把已经成功的模型回合判失败。缺省=true，真正的回合/API 错误
  // 不必每个执行器重复标注。
  | { kind: "error"; message: string; scope?: "session"; level?: "notice"; affectsTurn?: false }
  // 常驻会话（team 调度台）专用：一个回合说完了，但进程还活着等下一条消息。
  // 一次性 run() 永远不发这个 —— 它的回合结束就是进程结束(done)。
  | { kind: "turnEnd" }
  | { kind: "done"; exitStatus: number };

// synthesis = 收敛后的合稿轮(共同方案);impl/review are legacy transcript speakers
export type DuetSpeaker = "A" | "B" | "synthesis" | "impl" | "review" | "user";

// 一个讨论者回合里的执行过程(它跑了什么命令、读了什么文件、想了什么)。落进
// transcript.jsonl 的回合行,好让刷新后的时间线仍能展开「执行过程」——实时那份
// 是从 agent.event 流里攒的,不落盘就只在当次连接里存在。
// notice = 过程里的一条提示(上游重试、还在等回话),跟普通任务的执行过程同一套展示。
export type TurnTraceEvent = { kind: "tool" | "thinking" | "notice"; label: string; detail?: string };
/**
 * 讨论区一个回合里「正文第几处引用对上哪份拷贝」(随回合一起落盘)。
 *
 * 字段语义跟 attachment 事件逐字一致 —— 讨论区的回合不走分段模型,但**同一套配对**得在
 * 这儿也兑现得了:少了它,会话流里画的是「说那句话时的快照」,讨论区画的是「现在的文件」
 * (审查第 1 轮 F1 同类路径)。
 */
export type TurnImageRef = { path?: string; source: string; ref?: number; pos?: number; lost?: boolean };

// SSE envelope pushed to the web client.
export type ServerEvent =
  | { type: "task.created"; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "task.status"; taskId: string; status: TaskStatus; updatedAt: string; startedAt?: string | null; endedAt?: string | null; activeMs?: number | null; liveSince?: string | null }
  | { type: "task.stage"; taskId: string; stage: TaskStage | null; updatedAt: string }
  | { type: "task.review"; taskId: string }
  // 验收前置命令起了/跑完了。只发信号不带载荷（同 task.monitors）：界面按它重拉
  // `/tasks/:id/accept-gate` —— 载荷里有日志尾巴，几分钟一条的广播不该驮着它。
  | { type: "task.acceptGate"; taskId: string }
  | { type: "task.title"; taskId: string; title: string; updatedAt: string }
  // 提问态变化（§Team）：agent 调 ask_question 提问、或答复把它清空。task.status
  // 只带状态字段，question 不跟着走 —— 少了这条事件，卡片要等下次全量拉取才出现/
  // 消失（答复完卡片还杵在那，像是没答上）。question=null 即「已答复，撤掉卡片」。
  | {
      type: "task.question";
      taskId: string;
      updatedAt: string;
      question: string | null;
      questionOptions: string[] | null;
      questionItems: QuestionItem[] | null;
      answeredQuestion?: import("./questions.ts").QuestionRecord;
    }
  // 待发送消息托盘(排队/定时)有变化：入队、真的发出去了、被取消。托盘的真值只能
  // 来自服务端 —— 从前前端靠「任务从 running 变成别的状态」反推「排着的那条已经
  // 发出去了」，可排队消息一投递任务立刻又回到 running，中间那个空档常常一次都没
  // 被观察到，于是消息明明进了会话、托盘还挂着「排队中」(2026-08-13)。
  | { type: "task.pendingMessages"; taskId: string }
  // 哨兵列表有变化：起了一个、推了一批事件、结束了。界面按它重拉
  // `/tasks/:id/monitors` —— 只发信号不带载荷，跟托盘那条同一套理由。
  | { type: "task.monitors"; taskId: string }
  | {
      type: "agent.event";
      taskId: string;
      sessionId: string;
      role: SessionRole;
      agentType?: AgentType; // which agent produced it (single tasks can host several via @-mention)
      model?: string | null;
      reasoningEffort?: string | null;
      // 这一回合是「就地验证」的第几轮。就地验证是搭在被验任务自己身上的旁路回合，
      // 常常还复用同一条会话 —— 少了这个数，会话里审查者的发言跟它上面那条「我在做
      // 需求」的发言长得一模一样（同执行器自审时连名字都一样）。跟 model/reasoningEffort
      // 一样按回合随流广播，落盘那份在 trace 的 run 事件里，两条路读出来必须一致。
      verifyRound?: number | null;
      event: AgentEvent;
    }
  // A user-channel turn after it has been persisted to the session transcript.
  // bySystem marks backend-authored handoffs (review repair / merge conflict):
  // they start a real follow-up turn, but the UI must not attribute them to the user.
  | {
      type: "conversation.turn";
      taskId: string;
      sessionId: string;
      role: SessionRole;
      agentType: AgentType;
      text: string;
      at: string;
      bySystem?: true;
      monitorWake?: MonitorWakeData;
    }
  | {
      type: "duet.progress";
      taskId: string;
      round: number;
      speaker: DuetSpeaker;
      phase: "start" | "end";
      raisedHand?: boolean;
      at?: string;
      startedAt?: string;
      durationMs?: number;
    }
  | { type: "duet.gate"; taskId: string; gate: GateName; open: boolean; consensus?: boolean; consensusBy?: DuetConsensusBy; conclusionA?: string | null; conclusionB?: string | null }
  // A human intervention in a /duet timeline (gate inject/ask). Carries the time
  // so the timeline can show when the user spoke. Persisted in the transcript too.
  // target: when a 提问 was directed at one voice, which side — so the timeline
  // can show 「你 → 讨论者A」 (undefined = addressed to both).
  // kind 落盘是为了 retry 能重放这次介入(inject 回炉 / ask 提问的 prompt 不同);旧行没有 kind,读取端按 target 有无推断。
  | { type: "duet.user"; taskId: string; round: number; text: string; at: string; target?: "A" | "B"; kind?: "inject" | "ask" };
