import type { Writable } from "node:stream";
import type { AgentType } from "@ash/shared";
import type { ResidentHandle, ResumeFields } from "../executors/types.js";
import type { PendingInbound } from "./inbound-queue.js";

export interface Lead {
  taskId: string;
  sessId: string;
  cliSessionId: string;
  agentType: AgentType;
  /** 这台调度台跑的是谁的活(多人模式)。技能扫描与环境注入按它走。 */
  ownerUserId: string | null;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  cwd: string;
  handle: ResidentHandle;
  out: Writable;
  busy: boolean;
  /** 投递串行链(见 session-consumer.ts 的 sendToLead):保证同一台的 send 按调用顺序落地。 */
  sending?: Promise<void>;
  /**
   * 队首那个身份的起点 —— 执行器此刻在跑的那一轮。由 `lead-turns.ts` 跟着 `held` 一起维护,
   * 别处只读。
   */
  turnStart: string | null;
  /**
   * 这台**此刻持有**的回合身份队列（`started_at`,`Set` 的插入序即投入顺序）。只由
   * `lead-turns.ts` 读写,别处不碰。
   *
   * 为什么是队列而不是上面那个 `turnStart` 字段：投入与结束是交错的。用户插话时 ash 先打断
   * 再投递,新一轮当场开跑,而被打断那一轮还要过一会儿才吐出它的 `turnEnd` —— 同一瞬间手上
   * 有两个未结束的身份。只认一个字段的后果有两层：被覆盖掉的那个起点永远没人注销（读端把它
   * 当成「这条会话一直在写」,待命期间别人做的东西全算进这台的产物,第 8 轮审查必须修 1）,
   * 而旧回合的结束事件又会按覆盖后的值把**新回合**提前收口（新一轮干活那一段落进空洞,那些
   * 图永久漏在清单外,第 1 轮审查 F1）。可选是因为构造点散在生产与多份回归夹具里,队列由所
   * 有权层按需建；判据不靠这个字段在不在,靠 `holdTurn`/`releaseHeldTurn` 成对。
   */
  held?: Set<string>;
  /**
   * 被「作用域结束」那条路放掉的身份（`closeLeadTurns`,队首在前,去重）。只由
   * `lead-turns.ts` 写,`closeLead` 读它来补区间。
   *
   * 为什么要留这一份:放手与异常收尾不在同一时刻——换台那一路在 `attachLead` 当场摘牌,
   * 旧进程的 `close` 还在路上。详见 `closeLeadTurns` 的注释。
   */
  releasedTurns?: string[];
  pending: PendingInbound[];
  notices: { text: string; at: string; level?: "notice" }[];
  pendingCredential: ({ cliSessionId: string } & ResumeFields) | null;
  wantedStatus: "running" | "idle" | null;
  statusTimer: NodeJS.Timeout | null;
  retired: boolean;
  idleTimer: NodeJS.Timeout | null;
  closing: "recycle" | "halt" | "workspace" | null;
  closingSaidRotated?: boolean;
}
