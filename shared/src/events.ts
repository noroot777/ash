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
import type { ContextUsage, TokenUsage } from "./usage.ts";

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
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "attachment"; path: string }
  | { kind: "session"; cliSessionId: string }
  | { kind: "system"; text: string } // a backend-initiated 〔系统〕 trace (e.g. 继续) — its own bubble, not agent text
  // 本回合的 token 用量,由执行器从 CLI 的收尾事件(claude 的 result / codex 的
  // turn.completed)解析。每回合至多一条,恒在该回合的 turnEnd/done 之前。拿不到
  // 用量的 CLI 一条都不发 —— 展示端据此判断「这家报不报账」。
  // accounting 缺省只存在于旧 trace：Claude 旧账本来就是单轮值；Codex 旧账是累计
  // 快照，读取侧要先求差。新事件经过服务端归一后恒标 incremental。
  | { kind: "usage"; usage: TokenUsage; accounting?: "incremental" }
  // 上下文**水位**(不是流水,区别见 shared/src/usage.ts 的 ContextUsage)。每回合至多
  // 一条,恒在该回合的 turnEnd/done 之前。落库是**覆盖**不是累加。
  | { kind: "context"; context: ContextUsage }
  | { kind: "error"; message: string }
  // 常驻会话（team 调度台）专用：一个回合说完了，但进程还活着等下一条消息。
  // 一次性 run() 永远不发这个 —— 它的回合结束就是进程结束(done)。
  | { kind: "turnEnd" }
  | { kind: "done"; exitStatus: number };

// synthesis = 收敛后的合稿轮(共同方案);impl/review are legacy transcript speakers
export type DuetSpeaker = "A" | "B" | "synthesis" | "impl" | "review" | "user";

// 一个讨论者回合里的执行过程(它跑了什么命令、读了什么文件、想了什么)。落进
// transcript.jsonl 的回合行,好让刷新后的时间线仍能展开「执行过程」——实时那份
// 是从 agent.event 流里攒的,不落盘就只在当次连接里存在。
export type TurnTraceEvent = { kind: "tool" | "thinking"; label: string; detail?: string };

// SSE envelope pushed to the web client.
export type ServerEvent =
  | { type: "task.created"; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "task.status"; taskId: string; status: TaskStatus; updatedAt: string; startedAt?: string | null; endedAt?: string | null; activeMs?: number | null; liveSince?: string | null }
  | { type: "task.stage"; taskId: string; stage: TaskStage | null; updatedAt: string }
  | { type: "task.review"; taskId: string }
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
    }
  // 待发送消息托盘(排队/定时)有变化：入队、真的发出去了、被取消。托盘的真值只能
  // 来自服务端 —— 从前前端靠「任务从 running 变成别的状态」反推「排着的那条已经
  // 发出去了」，可排队消息一投递任务立刻又回到 running，中间那个空档常常一次都没
  // 被观察到，于是消息明明进了会话、托盘还挂着「排队中」(2026-08-13)。
  | { type: "task.pendingMessages"; taskId: string }
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
