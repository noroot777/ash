import type { ReviewDelivery, ReviewTargetIdentity } from "./schema-regression-evidence.js";
import type { TaskStatus } from "@ash/shared";

export type WaitOrigin = { kind: "ordinary" } | {
  kind: "review" | "unknown";
  directory: string;
  generation: string | null;
};

export type TaskWaitOwnership = {
  acceptedFinalization?: { directory: string; generation: string; token: string };
  repairDelivery?: { messageId: string; generation: string; identity: ReviewTargetIdentity };
  deliveredReview?: { directory: string; generation: string; identity: ReviewTargetIdentity;
    input?: ReviewDelivery; pid?: number; unitToken?: string | null; confirmedAt: string };
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
