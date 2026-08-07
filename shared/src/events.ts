// SSE / 执行器事件协议(§7 gates、§12 streaming)。
//
// 从 index.ts 拆出来的**纯类型**文件:index 只做 `export type { … } from "./events.ts"`
// 再导出,消费者继续 `import type { AgentEvent } from "@harness/shared"`,零改动。
// 之所以只能搬类型:服务端直接跑 shared 的 .ts 源码,Node 的类型擦除不会把
// "./x.js" 说明符映射回 "./x.ts",index 里**转发运行时值**会让进程起不来
// (见 server/CLAUDE.md「执行器与模型」最后一条)。`import type` / `export type`
// 编译期就被抹掉,所以安全 —— 下面对 ./index.js 的反向 type import 同理。
import type { AgentType, DebateConsensusBy, QuestionItem, Task, TaskStage, TaskStatus } from "./index.ts";
import type { SessionRole } from "./session.ts";
import type { TokenUsage } from "./usage.ts";

// ── HITL gates (§7) ──────────────────────────────────────────────────────────
export type GateName = "G1" | "G2"; // G2 is legacy, retained for historical events
export type GateAction =
  | { kind: "approve"; text?: string; side?: "A" | "B" } // side is retained for older clients
  | { kind: "reject" } // 打回终止
  | { kind: "inject"; text: string } // 注入意见 → 回炉再辩（始终双方一起回炉）
  | { kind: "ask"; text: string; target?: "A" | "B" }; // 提问 → 答完继续；target 缺省=问双方，指定=只问那一位辩手

// ── Executor streaming events (§12) ──────────────────────────────────────────
export type AgentEvent =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "session"; cliSessionId: string }
  | { kind: "system"; text: string } // a backend-initiated 〔系统〕 trace (e.g. 继续) — its own bubble, not agent text
  // 本回合的 token 用量,由执行器从 CLI 的收尾事件(claude 的 result / codex 的
  // turn.completed)解析。每回合至多一条,恒在该回合的 turnEnd/done 之前。拿不到
  // 用量的 CLI 一条都不发 —— 展示端据此判断「这家报不报账」。
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "error"; message: string }
  // 常驻会话（team 调度台）专用：一个回合说完了，但进程还活着等下一条消息。
  // 一次性 run() 永远不发这个 —— 它的回合结束就是进程结束(done)。
  | { kind: "turnEnd" }
  | { kind: "done"; exitStatus: number };

export type DebateSpeaker = "A" | "B" | "impl" | "review" | "user"; // impl/review are legacy transcript speakers

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
  | {
      type: "agent.event";
      taskId: string;
      sessionId: string;
      role: SessionRole;
      agentType?: AgentType; // which agent produced it (single tasks can host several via @-mention)
      event: AgentEvent;
    }
  | {
      type: "debate.progress";
      taskId: string;
      round: number;
      speaker: DebateSpeaker;
      phase: "start" | "end";
      raisedHand?: boolean;
      at?: string;
      startedAt?: string;
      durationMs?: number;
    }
  | { type: "debate.gate"; taskId: string; gate: GateName; open: boolean; consensus?: boolean; consensusBy?: DebateConsensusBy; conclusionA?: string | null; conclusionB?: string | null }
  // A human intervention in a /debate timeline (gate inject/ask). Carries the time
  // so the timeline can show when the user spoke. Persisted in the transcript too.
  // target: when a 提问 was directed at one debater, which side — so the timeline
  // can show 「你 → 辩手A」 (undefined = addressed to both).
  | { type: "debate.user"; taskId: string; round: number; text: string; at: string; target?: "A" | "B" };
