import type { ReviewDelivery, ReviewTargetIdentity } from "./schema-regression-evidence.js";
import type { TaskStatus } from "@ash/shared";
import type { InputAcceptance } from "../executors/types.js";

export type WaitOrigin = { kind: "ordinary" } | {
  kind: "review" | "unknown";
  directory: string;
  generation: string | null;
};

export type TaskWaitOwnership = {
  acceptedFinalization?: { directory: string; generation: string; token: string };
  repairDelivery?: { messageId: string; generation: string; identity: ReviewTargetIdentity };
  deliveredReview?: { directory: string; generation: string; identity: ReviewTargetIdentity;
    input?: ReviewDelivery; pid?: number; unitToken?: string | null; confirmedAt: string;
    /** 协议回执(spawn 之后才落定,所以后补;语义与读法见 ../review-input-verdict.ts)。 */
    acceptance?: InputAcceptance;
    /**
     * 这份输入实际进了哪条会话(`sessions.id`)。「继续本轮审查」只续这一条(../free-review-retry-identity.ts);
     * 缺席 = 加这一位之前的老凭据,按「这一轮没有可续的会话」处理,重新交代完整任务书。
     */
    sessionId?: string };
  start?: {
    directory: string;
    generation: string;
    identity: ReviewTargetIdentity;
    priorStatus: TaskStatus;
    repair?: true;
    acceptedRepair?: true;
    delivery?: ReviewDelivery;
    phase?: "prepared" | "launching" | "uncertain";
  };
  turn?: { identity: ReviewTargetIdentity; origin: WaitOrigin };
  question?: {
    occupancy: string;
    origin: WaitOrigin;
    text: string;
    options: string | null;
    items: string | null;
  };
  checkpoint?: {
    generation: number;
    origin: WaitOrigin;
    /**
     * 写下这一格的**那个回合**是谁(turn-lock 的运行时事实:`role` 与它绑定的审查轮次)。
     *
     * 为什么光有 `origin` 不够:`origin` 是**推断**出来的(task-wait-ownership.ts 的
     * `writerOrigin` 去读「这会儿有没有活着的审查范围」),系统代写的那一格常常被推到审查
     * 头上;而「哪个回合写的」是当场就知道的事实。缺省(旧行、或者写入时没有占着回合)=
     * **不知道**,两边都按保守处理:不算审查自己的等待,也不在审查结算时作废它。
     */
    writer?: { role: string; review: { run: string; round: number } | null };
  };
};
